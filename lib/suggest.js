// dsh-git-sidebar —— AI 生成提交信息（宿主侧）
// ============================================================================
// 提交输入框右边那颗方框按钮的后半程：
//   读改动 → 组提示词 → 用「当前会话正在用的模型」流式生成一行提交信息 → 回给面板。
//
// 参照实现是 DSH-better-sidebar 的 `git.suggest-message` 路由（同一件事的成熟做法），
// 这里按本插件的形态重写，保留它验证过的关键决策：
//   * 改动优先级 = 已暂存 → 未暂存 → 未跟踪：`git commit` 记下的就是暂存区，
//     生成的措辞必须对准「马上要提交进去的那份改动」；
//   * 模型路由回退链 = 会话正在用的（agents 选项 → 最新 request/header 事件）
//     → 宿主默认（agent-default-model）。本插件没有「固定某个模型」的设置 UI，
//     所以只有这两级 —— 冷会话（还没发过消息）也能用默认模型生成；
//   * 推理档位取模型广告出来的**最低档**：提交信息只是一行字，DeepSeek 适配器
//     默认 high 会把输出预算花在思考上，最后常常一个字都不剩（参照实现实测）；
//   * 模型返回常裹着 ``` 代码栅栏，落进提交框之前必须剥掉（cleanSuggestion）。
//
// 与参照实现的一个刻意差异：**零外部依赖**。这里不 import @deepseek-ai/dsh-llm ——
// link 安装的插件按自己的真实路径解析依赖，装不到 profile 里那份（装了反而在
// 别的机器上解析失败）。llm 服务的 `stream()` 契约是公开协议：入参 GenerateOptions
// 是普通对象，回的是 StreamChunk 判别联合，拼装只需要认 `text-delta` 与 `finish`
// 两种块 —— 手写十行与引 BlockAssembler 等价，且插件依旧是零依赖单包。
// 凭据由 harness 的 llm 服务自己解析，本插件从头到尾碰不到密钥。
// ============================================================================

import { readState, runGit, GIT_LOCAL_TIMEOUT_MS } from './git.js'
import { argvDiff } from './ops.js'

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 喂给模型的差异字符上限。超大改动集（批量重命名 / 生成物）必须截断，
 *  否则一次提交就能把模型上下文灌满；截断处写明标记，模型知道信息不全。 */
const SUGGEST_DIFF_LIMIT = 12000

/** 一次生成的输出预算：够写一行标题 + 一小段正文，多了也不需要。 */
const SUGGEST_MAX_TOKENS = 512

/** 一次生成的硬超时：面板在生成期间一直显示忙碌，供应方卡死不能让按钮永远转圈。 */
const SUGGEST_TIMEOUT_MS = 30000

// ── 提示词与文本处理（纯函数，可单测） ────────────────────────────────────

/**
 * 把不可信的语言值收窄到支持的两档。面板是中文界面，缺省走 en 只是为了
 * 「这个模块单拿出来用」时不至于把未知值原样塞进提示词。
 * @param value - 请求体里的 language。
 * @returns 'zh' 或 'en'。
 */
function normalizeLanguage(value) {
  return value === 'zh' ? 'zh' : 'en'
}

/**
 * 截断一份差异到 {@link SUGGEST_DIFF_LIMIT}，在断处写明标记。
 * @param diff - git diff 的原文。
 * @returns 截断后的差异文本。
 */
function truncateDiff(diff) {
  if (typeof diff !== 'string' || diff.length <= SUGGEST_DIFF_LIMIT) return typeof diff === 'string' ? diff : ''
  return diff.slice(0, SUGGEST_DIFF_LIMIT) + '\n...(diff truncated)'
}

/**
 * Conventional Commits 提示词（系统半 + 用户半），按面板语言分中英两版。
 * @param language - 'zh' | 'en'（先过 normalizeLanguage）。
 * @param files - 这份差异覆盖的改动路径（仓库根相对）。
 * @param diff - 已截断的差异文本。
 * @returns { system, user }。
 */
function buildCommitPrompt(language, files, diff) {
  const list = Array.isArray(files) ? files : []
  const fileList = list.join('\n')
  if (language === 'zh') {
    return {
      system: '你是 git 提交信息生成助手。根据给定的文件清单与差异，生成一行 Conventional Commits 风格的中文提交信息'
        + '（类型前缀：feat/fix/refactor/chore/docs/test/perf/style，必要时可附简短正文）。'
        + '只输出提交信息本身，不要解释。',
      user: '改动的文件：\n' + fileList + '\n\n差异：\n' + diff,
    }
  }
  return {
    system: 'You are a git commit message assistant. Based on the given file list and diff, write a one-line'
      + ' Conventional Commits style commit message in English (type prefix: feat/fix/refactor/chore/docs/test/perf/style,'
      + ' with a short body when needed). Output only the commit message itself, no explanation.',
    user: 'Changed files:\n' + fileList + '\n\nDiff:\n' + diff,
  }
}

/**
 * 剥掉模型的排版外壳：代码栅栏、行尾空白与首尾空行。
 * 模型明知只要一行，也常把提交信息裹进 ``` 里 —— 这段文字会被直接塞进提交框，
 * 任何不是提交信息的东西都会原样进仓库，所以必须先洗。
 * @param text - 模型原始输出。
 * @returns 可直接落进输入框的文本（可能为空串，由调用方判定失败）。
 */
function cleanSuggestion(text) {
  if (typeof text !== 'string') return ''
  const withoutFence = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('```'))
    .join('\n')
  return withoutFence
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

// ── 模型路由的词汇表（同样纯函数） ────────────────────────────────────────

/** 推理档位阶梯，由低到高。档位 id 归适配器所有，所以这只用于**排序**：
 *  不在阶梯里的 id 仍然构成合法路由，只是没法和这几档比高低。 */
const REASONING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 模型广告出来的**最低**推理档（见 {@link REASONING_LEVEL_ORDER}）。
 * 未知 id 永远压不过已知 id；全部未知时取适配器自己列的第一项
 * （它声明的顺序是唯一可得的信号）。模型一档都不广告时返回 undefined ——
 * 给不支持推理的模型传 reasoningEffort 会被 harness 拒（UNSUPPORTED_REASONING_EFFORT）。
 * @param efforts - `modelInfo.reasoning.efforts`（形状不受信）。
 * @returns 要请求的档位 id，或 undefined。
 */
function lowestReasoningEffortOf(efforts) {
  if (!Array.isArray(efforts)) return undefined
  const ids = []
  for (const entry of efforts) {
    const id = entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== ''
      ? entry.id
      : undefined
    if (id !== undefined) ids.push(id)
  }
  if (ids.length === 0) return undefined
  let best
  let bestRank = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const rank = REASONING_LEVEL_ORDER.indexOf(id)
    if (rank < 0) continue
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return best !== undefined ? best : ids[0]
}

/**
 * 宿主默认模型选择（settings 命名空间 `agent-default-model` 的 currentSelection），
 * 宽容读取：它是「新会话将要使用的路由」，所以在会话还没发过第一条消息时也可用。
 * @param selection - currentSelection() 的返回值。
 * @returns { provider, model } 或 undefined。
 */
function defaultRouteOf(selection) {
  if (selection === null || typeof selection !== 'object') return undefined
  if (typeof selection.provider !== 'string' || selection.provider.trim() === '') return undefined
  if (typeof selection.model !== 'string' || selection.model.trim() === '') return undefined
  return { provider: selection.provider.trim(), model: selection.model.trim() }
}

/**
 * 会话日志里**最新一次真实用过的** provider/model 路由：最新的 `request/header`
 * 事件胜出 —— 那是这条会话真正派发过的模型，「当前模型」的字面答案。
 * @param events - 会话日志事件（新在后）。
 * @returns { provider, model } 或 undefined。
 */
function newestModelRouteOf(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'request/header') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
    const header = data !== undefined && data.header !== null && typeof data.header === 'object' ? data.header : undefined
    const config = header !== undefined && header.config !== null && typeof header.config === 'object'
      ? header.config
      : undefined
    if (config === undefined) continue
    if (typeof config.provider !== 'string' || config.provider === '') continue
    if (typeof config.model !== 'string' || config.model === '') continue
    return { provider: config.provider, model: config.model }
  }
  return undefined
}

// ── 改动分类 ──────────────────────────────────────────────────────────────

/**
 * 把 `git status --porcelain` 解析出的条目分成三堆（与 better-sidebar 同判据）：
 * 已暂存 / 未暂存 / 未跟踪。冲突条目（UU 等）两侧都非空，会同时进前两堆 ——
 * 它既是「暂存区里未收尾的东西」，也是「工作区里没收尾的东西」，两边都该看见。
 * @param entries - readState 的 changes（{ code, path }）。
 * @returns { staged, unstaged, untracked }：三组仓库根相对路径。
 */
function classifyChanges(entries) {
  const staged = []
  const unstaged = []
  const untracked = []
  if (!Array.isArray(entries)) return { staged, unstaged, untracked }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const code = typeof entry.code === 'string' ? entry.code : ''
    const path = typeof entry.path === 'string' ? entry.path : ''
    if (path === '' || code === '') continue
    if (code === '??') {
      untracked.push(path)
      continue
    }
    const x = code.charAt(0)
    const y = code.charAt(1)
    if (x !== ' ' && x !== '?') staged.push(path)
    if (y !== ' ' && y !== '?') unstaged.push(path)
  }
  return { staged, unstaged, untracked }
}

// ── 带状态码的失败 ────────────────────────────────────────────────────────

/**
 * 一条给面板看的失败。status 是给日志 / 代理 / 排查看的（400 请求不成立、
 * 503 能力缺席、504 供应方超时），面板本身只读 message —— 但全都写成 500
 * 会让「用户点早了」和「宿主没装 LLM」在日志里长成同一件事。
 * @param status - HTTP 语义状态码。
 * @param text - 给用户看的中文原因。
 * @returns 一个带 .status 的 Error。
 */
function suggestError(status, text) {
  const error = new Error(text)
  error.status = status
  return error
}

// ── 宿主服务的宽容读取 ────────────────────────────────────────────────────

/**
 * 取一个 cordis 服务：先走 ctx.get（运行中的正规通道），再退回 ctx[key]
 * （测试替身与老宿主的直挂形态）。缺席一律 undefined —— 本插件**不注入**任何
 * LLM 相关服务：它们是惰性服务，注入会让插件在没有它们的部署里整行加载失败，
 * 而这个功能缺席时只需要让按钮给出一句清楚的话。
 */
function serviceOf(ctx, key) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const value = typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  return value === undefined || value === null ? undefined : value
}

/**
 * 「这个会话当前在用哪个模型」，两级回退：
 *   1. 活着的 agent 自己的 options（最权威 —— 它就是正在跑的那次会话）；
 *   2. 会话日志里最新的 request/header（agent 还没挂上、但已经发过消息时）。
 * @param ctx - cordis 上下文（或测试替身）。
 * @param sessionId - 面板所属会话 id（拿不到时整级跳过）。
 * @returns { provider, model } 或 undefined。
 */
function conversationRouteOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const agents = serviceOf(ctx, 'agents')
  if (agents !== undefined && typeof agents.get === 'function') {
    const agent = agents.get(sessionId)
    const options = agent !== undefined && agent !== null ? agent.options : undefined
    if (options !== null && typeof options === 'object'
      && typeof options.provider === 'string' && options.provider !== ''
      && typeof options.model === 'string' && options.model !== '') {
      return { provider: options.provider, model: options.model }
    }
  }
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined
  const session = sessions.get(sessionId)
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return undefined
  return newestModelRouteOf(session.snapshotEvents())
}

/**
 * 下一次生成将要使用的路由：会话正在用的 → 宿主默认。两级都空才返回
 * undefined（由调用方给出 503）—— 「冷会话 + 没配默认模型」是唯一走不到的地方。
 */
function resolveRoute(ctx, sessionId) {
  return conversationRouteOf(ctx, sessionId)
    ?? defaultRouteOf(serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.())
}

// ── 流式生成 ──────────────────────────────────────────────────────────────

/**
 * 模型这一趟要请求的推理档：模型广告了档位就取**最低**那档（理由见文件头），
 * 广告里一档都没有、或压根问不出模型信息就整个省略该字段。
 */
async function commitReasoningEffort(llm, route) {
  if (typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined
    return lowestReasoningEffortOf(reasoning !== undefined && reasoning !== null ? reasoning.efforts : undefined)
  } catch {
    // 问不到就不猜：省略字段 = 用适配器自己的默认，总比传一个模型不认的档位强。
    return undefined
  }
}

/**
 * 一次生成：把提示词交给 llm 服务流式跑完，拼出最终文本。
 *
 * 两条失败通道都要认：
 *   * 流**抛异常**（传输层坏掉 / 超时）—— AbortError 翻译成一句超时中文；
 *   * 流**正常收尾但 finish 是 error/aborted** —— dsh-llm 把适配器失败规整成
 *     终止块而不是异常，只 catch 会把「供应方拒绝」误判成「模型没说话」。
 * @returns 清洗后的提交信息（非空，否则抛）。
 */
async function streamMessage(llm, route, prompt) {
  const effort = await commitReasoningEffort(llm, route)
  let text = ''
  let finish
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      // 一次性请求用身份自由的 user 输入（没有 id / source 的形态）：它不落会话
      // 日志，本来也不该为「生成一条草稿」污染这轮对话的历史。
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
      system: prompt.system,
      maxTokens: SUGGEST_MAX_TOKENS,
      signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      throw suggestError(504, '模型在 ' + Math.round(SUGGEST_TIMEOUT_MS / 1000) + ' 秒内没有返回，已取消')
    }
    throw error
  }
  const kind = finish !== null && typeof finish === 'object' && typeof finish.kind === 'string' ? finish.kind : ''
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish.failure !== null && typeof finish.failure === 'object' ? finish.failure : {}
    const detail = (typeof failure.message === 'string' && failure.message !== '')
      ? failure.message
      : (typeof failure.code === 'string' ? failure.code : kind)
    throw suggestError(502, '模型调用失败：' + detail)
  }
  const message = cleanSuggestion(text)
  if (message === '') {
    // finish 分得清「模型没写字」（常是推理模型把预算想光了）和「压根没跑成」，
    // 带上它，面板那句失败才可行动。
    throw suggestError(500, '模型返回了空的提交信息（finish=' + (kind === '' ? 'unknown' : kind) + '）')
  }
  return message
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 读一份 diff 供提示词用。命令失败（典型：仓库还没有任何提交，`git diff --cached`
 * 拿不出 HEAD 基线）不整单失败 —— 退回「只给文件清单」，模型照样能按改动路径
 * 写出提交信息（参照实现对纯未跟踪集就是这么做的）。
 */
async function focusDiff(dir, cached) {
  const result = await runGit(
    argvDiff(cached === true ? { cached: true } : {}),
    dir,
    { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  )
  if (result.code !== 0) return ''
  return String(result.stdout ?? '')
}

/**
 * 生成一条提交信息。
 * @param request - { dir, language, sessionId, getContext }：
 *   getContext 返回 cordis 上下文（惰性服务到点击时才解析）。
 * @returns { message, provider, model }。
 * @throws 带 .status 的 Error（没有改动 400 / 能力缺席 503 / 供应方失败 5xx）。
 */
async function runSuggestion({ dir, language, sessionId, getContext } = {}) {
  const ctx = typeof getContext === 'function' ? getContext() : undefined
  const state = await readState(dir)
  if (state.isRepo !== true) {
    throw suggestError(400, typeof state.notice === 'string' && state.notice !== ''
      ? state.notice
      : '当前目录还不是 Git 仓库')
  }
  const focus = classifyChanges(state.changes)
  if (focus.staged.length === 0 && focus.unstaged.length === 0 && focus.untracked.length === 0) {
    throw suggestError(400, '没有可提交的改动：先暂存或修改一些文件再生成')
  }
  // 暂存的优先 —— 它正是 `git commit` 马上要记下的东西；一无所有才退回工作区，
  // 连工作区都干净（纯未跟踪集）时 diff 天然是空的，只给文件清单。
  const files = focus.staged.length > 0
    ? focus.staged
    : (focus.unstaged.length > 0 ? focus.unstaged : focus.untracked)
  const diff = focus.staged.length > 0
    ? await focusDiff(dir, true)
    : (focus.unstaged.length > 0 ? await focusDiff(dir, false) : '')
  const prompt = buildCommitPrompt(normalizeLanguage(language), files, truncateDiff(diff))

  const route = resolveRoute(ctx, typeof sessionId === 'string' ? sessionId : '')
  if (route === undefined) {
    throw suggestError(503, '当前没有可用的模型：这个会话还没用过任何模型，宿主也没有配置默认模型')
  }
  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw suggestError(503, '宿主没有提供 LLM 服务，无法生成提交信息')
  }
  const message = await streamMessage(llm, route, prompt)
  return { message, provider: route.provider, model: route.model }
}

/**
 * 把生成能力包成 routes.js 认的处理器：路由层只管 HTTP（守卫 / 令牌 / 日志），
 * 这一层只管 git 与模型。getContext 每次调用都重新取上下文 —— 服务是惰性的，
 * 插件 apply 时读一次会让「LLM 还没就绪」变成永久缺席。
 * @param getContext - 返回 cordis 上下文的函数。
 * @returns async ({ dir, language, sessionId }) => { message, provider, model }。
 */
function createSuggestHandler(getContext) {
  const get = typeof getContext === 'function' ? getContext : () => undefined
  return (request) => runSuggestion({
    dir: request !== null && typeof request === 'object' ? request.dir : undefined,
    language: request !== null && typeof request === 'object' ? request.language : undefined,
    sessionId: request !== null && typeof request === 'object' ? request.sessionId : undefined,
    getContext: get,
  })
}

export {
  SUGGEST_DIFF_LIMIT, SUGGEST_MAX_TOKENS, SUGGEST_TIMEOUT_MS, REASONING_LEVEL_ORDER,
  normalizeLanguage, truncateDiff, buildCommitPrompt, cleanSuggestion,
  lowestReasoningEffortOf, defaultRouteOf, newestModelRouteOf, classifyChanges,
  suggestError, conversationRouteOf, resolveRoute, streamMessage,
  runSuggestion, createSuggestHandler,
}
