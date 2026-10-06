// dsh-git-sidebar —— HTTP 路由（面板与宿主之间的唯一通道）
// ============================================================================
// 六条路由：state（读状态）/ op（执行操作）/ net（网络加速配置）/ diag（客户端
// 注册诊断）/ log（日志尾读）/ help（帮助文档）。
//
// op 路由刻意写成一条**流水线**而不是一个两百行的函数：
//   解析请求 → 查注册表拿 argv → 带加速执行（含镜像回退）→ 补救 → 收集结果
//   → 组装提示与选择 → 回状态 → 记日志
// 每一步都是一个命名函数，出问题时能一眼看出是哪一段。
// ============================================================================

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

import { classifyNetworkFailure, classifyPushFailure, networkHint, pushHint } from './failure.js'
import {
  GIT_LOCAL_TIMEOUT_MS, cloneTargetName, emptyState, gitMissingMessage, readState, runGit,
} from './git.js'
import { renderHelpHtml } from './help.js'
import { appendLog, readLogTail } from './log.js'
import {
  netConfigView, probeNetwork, readNetConfig, writeNetConfig,
} from './net.js'
import {
  OPS, abortMerge, adoptRemote, buildOpArgv, conflictedFiles, executeWithAcceleration,
  forceDeleteChoice, mismatchPushChoices, opResponse, opTimeoutMs,
  otherRemoteChoices, pullChoices, stashPull, stashSwitch,
} from './ops.js'
import { MASK_TOKEN, displayArgv, firstLine, hasText, message, normalizeDir } from './util.js'

// ── 请求 / 响应小工具 ─────────────────────────────────────────────────────

/** 请求 URL（所有路由原先各抄一份 new URL(...)，这里收成一个）。 */
function requestUrl(request) {
  return new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')
}

/** 以 JSON 回复（面板一律用 JSON，便于前端统一处理）。 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * 统一的失败响应。状态码如实反映错误种类：
 * 内部错误 500 / 参数或请求错误 400 / 跨站 403。客户端只读 body 里的 ok，
 * 但状态码是给日志、代理和排查的人看的，不能全都写成 200。
 */
function fail(response, status, error, extra = {}) {
  sendJson(response, status, { ok: false, message: message(error), state: null, ...extra })
}

/** 请求头取值：只认字符串（数组取首个；缺失一律当空串）。 */
function headerText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/**
 * Host 头拆成 { name, port }。IPv6 是 `[::1]:3080` 形态，端口分隔符在 `]` 之后，
 * 不能直接用 indexOf(':') 切 —— 那样会把地址里的冒号当成分隔符。
 */
function splitHost(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return { name: text, port: '' }
    return { name: text.slice(1, end), port: text.slice(end + 1).replace(/^:/, '') }
  }
  const at = text.indexOf(':')
  if (at < 0) return { name: text, port: '' }
  return { name: text.slice(0, at), port: text.slice(at + 1) }
}

/** 本机别名：`localhost`、`127.0.0.1`、IPv6 回环指的是同一台机器。 */
function isLoopbackName(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0:0:0:0:0:0:0:1'
}

/**
 * 两个 Host 是否指向同一个站点。
 *
 * 同名主机要求端口也一致；本机别名之间**不要求端口一致** —— 桌面版外壳可能用另一个
 * 回环端口做转发，这时 Origin 与 Host 的端口天然对不上，但那不是「另一个网站」。
 */
function sameHost(left, right) {
  const a = splitHost(left)
  const b = splitHost(right)
  if (a.name.length === 0 || b.name.length === 0) return false
  if (a.name !== b.name) return isLoopbackName(a.name) && isLoopbackName(b.name)
  return a.port === b.port
}

/**
 * POST / GET 的跨站守卫：**只拒绝「明确来自另一个网站」的 http(s) 来源**。
 *
 * 早先这里要求 `Origin` 与 `Host` 逐字同源，于是部署形态稍有不同就整片被拒。最典型
 * 的是**桌面版**：Electron 外壳里的页面不一定从 `http://<同一个 Host>` 打开 ——
 * 外壳可能不带 `Origin`、带 `Origin: null`（file:// 或沙箱 iframe）、带 `file://` /
 * 自定义协议，或者经另一个回环端口转发（此时 `Host` 是宿主端口、`Origin` 是外壳端口）。
 * 又因为 GET 不校验来源，面板读状态一切正常，**只有每个 POST 被拒**：点「获取远程」
 * 只会得到一句「拒绝执行：请求来源不可信」——既看不出原因，也指向不了任何操作。
 *
 * 现在的规则只有一条：Origin 缺失 / `null` / 解析不了 / 非 http(s) → 不可判定，放行；
 * 与 Host 同主机（含本机别名与回环端口）→ 放行；其余 http(s) 来源 → 拒绝。
 *
 * 真正的门槛是**会话令牌**：跨站页面发得出请求，却读不到响应体里的令牌，因此带不上。
 * Origin 只是纵深防御，不该比宿主自己的信任层（Host + 令牌）更严。
 *
 * @returns null 表示放行；否则返回一句给日志与 403 响应体用的原因文本。
 */
function foreignOrigin(request) {
  const origin = headerText(request.headers.origin).trim()
  const host = headerText(request.headers.host).trim()
  // 浏览器之外的客户端（curl / 脚本）与桌面外壳都可能不带 Origin；`Origin: null`
  // 来自 file:// 与沙箱 iframe —— 这两种都无从比对，交给令牌把关。
  if (origin.length === 0 || origin === 'null') return null
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    // 畸形值或自定义协议：解析不了就不当成「另一个网站」。
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (host.length === 0) return '来源 ' + origin + ' 无法比对（请求缺少 Host）'
  if (sameHost(parsed.host, host)) return null
  return '来源 ' + origin + ' 与本站 ' + host + ' 不同源'
}

/** 请求是否同源（在可判定的前提下）。跨站守卫请直接用 foreignOrigin 拿原因。 */
function sameOrigin(request) {
  return foreignOrigin(request) === null
}

/**
 * 只读接口的跨站守卫：**不可判定的来源一律放行**（浏览器地址栏直开、curl、桌面外壳
 * 都不一定带得出可比的 Origin），能判定且跨站的才拒绝。
 *
 * 这一层不是鉴权，只是不想让别的站点用脚本把本机的工作痕迹（日志）拉走：HTTP 的
 * 跨站简单请求确实可以不带 Origin，所以它挡不住一切，代价为零。
 */
function crossOriginAllowed(request) {
  return foreignOrigin(request) === null
}

/**
 * POST 路由的公共守卫：方法不对 → 405，来源不对 → 403。
 * 返回 true 表示**已经回复过**，调用方直接 return。
 * 三个 POST 路由原先各抄一份，改一处忘一处就是一个安全缺口。
 *
 * 被拒时把 Origin / Host / UA 一并写进日志、也放进响应体：这条守卫一旦误判
 * （比如某种桌面外壳的部署形态），用户手里只有一句「来源不可信」，从外部完全看不出
 * 来访者到底带的是什么头 —— 那就成了一条没法排查的报错。跨站页面读不到响应体
 * （没有 CORS 头），所以把这些值写出来不构成泄露。
 */
function guardPost(request, response, allow = 'POST') {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow })
    response.end()
    return true
  }
  const foreign = foreignOrigin(request)
  if (foreign !== null) {
    const origin = headerText(request.headers.origin)
    const host = headerText(request.headers.host)
    // 日志是观测工具，失败不能成为新故障点：appendLog 内部已吞掉所有异常。
    void appendLog('warn', 'guard', {
      route: 'post',
      origin: origin.length > 0 ? origin : null,
      host: host.length > 0 ? host : null,
      userAgent: firstLine(headerText(request.headers['user-agent'])) || null,
      reason: foreign,
    })
    sendJson(response, 403, {
      ok: false,
      message: '拒绝执行：请求来源不可信（' + foreign + '）',
      state: null,
    })
    return true
  }
  return false
}

/** 读取 POST 的 JSON 请求体（上限 1 MiB）。 */
async function readJsonBody(request, maxBytes = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

// ── /git-sidebar/op 的流水线 ────────────────────────────────────────────────

/**
 * 不属于「一条 git 命令」的面板操作：多步、带前置检查、可能不可逆。
 * 它们在 ops.js 里各自实现（见 adoptRemote / abortMerge / stashPull 的注释），
 * 这里只登记「怎么调用」。
 *
 * stashPull 的第三个参数是「拉取这一步的执行通道」：多步流程里的 `git pull`
 * 必须和「拉取」按钮走同一条路（网络加速 + 镜像回退），否则开了镜像/代理的用户
 * 点「安全拉取」反而连不上。通道由 executeWithAcceleration 提供，见 runPanelOp。
 */
const SPECIAL_OPS = {
  adoptRemote: (body, dir) => adoptRemote(body, dir),
  abortMerge: (body, dir) => abortMerge(dir),
  stashPull: (body, dir, pullRunner) => stashPull(body, dir, pullRunner),
  // 安全切分支：与安全拉取同一套 stash 流程，但第二步是 git switch。
  stashSwitch: (body, dir) => stashSwitch(body, dir),
}

// ── 会话令牌（CSRF 加固） ─────────────────────────────────────────────────
//
// `sameOrigin` 校验的是 Origin 与 Host 是否一致，而这两个头都是客户端自己写的 ——
// 能访问到这个端口、又会伪造请求头的进程照样能过（README 的「安全边界」写了这件事）。
// 所以再加一层只有同源页面才拿得到的**一次性令牌**：
//   · GET /git-sidebar/state 与 GET /git-sidebar/net 发放令牌（跨站页面发了也读不到响应体）；
//   · POST /op 与 POST /net 必须带上其中一枚，否则拒绝。
// 令牌用「最近若干枚都有效」的集合而不是单值：面板可能同时开着几个标签页，
// 各标签页的 GET 会互相覆盖单值令牌 —— 那会让另一个标签页的保存突然失败。
//
// **没有发放过任何令牌时不校验**：这让「直接 curl 端口」的自动化脚本与既有测试
// 保持可用，同时挡住真正的 CSRF 面（浏览器发起的跨站请求一定经过 GET，令牌已经存在）。
const CSRF_TOKENS_MAX = 64
const csrfTokens = []

/** 发放一枚令牌（保留最近 CSRF_TOKENS_MAX 枚；面板总是持有最新那枚）。 */
function issueCsrf() {
  const token = randomBytes(16).toString('hex')
  csrfTokens.push(token)
  if (csrfTokens.length > CSRF_TOKENS_MAX) csrfTokens.shift()
  return token
}

/** 请求体里的令牌是否有效（未发放过令牌时视为「不需要」）。 */
function csrfAcceptable(body) {
  if (csrfTokens.length === 0) return true
  const token = body !== null && typeof body === 'object' && typeof body.csrf === 'string' ? body.csrf : ''
  return token.length > 0 && csrfTokens.includes(token)
}

/** 仅供测试：清空已发放的令牌，回到「不校验」的初始状态。 */
function resetCsrfTokens() {
  csrfTokens.length = 0
}

// ── 状态短缓存与目录锁 ────────────────────────────────────────────────────

/**
 * 状态短缓存：一次 readState 要跑 4 条 git 进程，而面板「操作完立刻看结果」的场景
 * 会在极短时间内读懂同一目录两次（操作响应已带状态，刷新/自动刷新还会再问一次）。
 * 800ms 的窗口内直接复用，既不改变「刚操作完看到的就是最新」的语义，又省掉重复进程。
 * 注意操作路径**不读缓存**：op 执行完必须回一份真实状态，并把结果写回缓存。
 */
const STATE_CACHE_TTL_MS = 800
const STATE_CACHE_MAX = 32
const stateCache = new Map()

async function readStateCached(dir) {
  const hit = stateCache.get(dir)
  if (hit !== undefined && Date.now() - hit.at < STATE_CACHE_TTL_MS) return hit.state
  const state = await readState(dir)
  primeStateCache(dir, state)
  return state
}

function primeStateCache(dir, state) {
  if (stateCache.size >= STATE_CACHE_MAX) {
    // 简单的容量控制：删掉最早写入的那个目录（Map 保持插入顺序）。
    const oldest = stateCache.keys().next()
    if (oldest.done !== true) stateCache.delete(oldest.value)
  }
  stateCache.set(dir, { at: Date.now(), state })
}

/**
 * 按目录串行化写操作。
 *
 * 面板侧有 busy 锁，但 AI 工具和面板可以**同时**操作同一个仓库（两条路径都直接
 * 调 git）。git 自己会锁 index，于是并发写会出现「一条成功、另一条报 index.lock 已存在」
 * 这类互相打断的现场。这里用一个 promise 链把同一目录的操作排成队，
 * 不同目录互不影响；长操作（pull/push 十分钟）排队是有意的 —— 那正是要避免交错。
 */
const dirLocks = new Map()

function withDirLock(dir, fn) {
  const previous = dirLocks.get(dir) ?? Promise.resolve()
  // 前一个操作失败也要继续跑下一个：排队不代表「一错全停」。
  const run = previous.then(() => fn(), () => fn())
  const tail = run.then(() => undefined, () => undefined)
  dirLocks.set(dir, tail)
  if (dirLocks.size > 64) {
    for (const key of dirLocks.keys()) {
      if (dirLocks.size <= 64) break
      if (dirLocks.get(key) === tail) continue
      dirLocks.delete(key)
    }
  }
  return run
}

/**
 * 失败后的自动补救（push 补 -u、pull 改按「远程 + 分支」）。
 * 注册表里没声明 recover 的操作只做失败分类 —— 但分类结果仍要回传，
 * 面板的「推送失败 → 自动展开地址输入框」就靠它。
 */
async function recoverOp(op, spec, attempt, body, dir, timeoutMs) {
  const ctx = {
    op, body, argv: attempt.argv, result: attempt.result, dir, timeoutMs, extraArgs: attempt.args,
  }
  if (spec.recover !== undefined) return spec.recover(ctx)
  return {
    argv: attempt.argv,
    result: attempt.result,
    // 注册表可以给自己配一个分类器：commit 的失败（身份没配置）和 checkout 的失败
    // （脏工作区）都不属于 push 那几类，拿 classifyPushFailure 问只会得到 none，
    // 用户看到的就是一句 git 英文原文。
    reason: attempt.result.code === 0
      ? 'none'
      : (spec.classify !== undefined ? spec.classify(attempt.result) : classifyPushFailure(attempt.result.stderr)),
    retried: false,
  }
}

/**
 * 收集「数据型操作」的结果：注册表声明了 field/parse 的操作把 stdout 解析成
 * 结构化字段（面板不读原始 stdout），`also` 再补几份（分支管理器要的远端列表、
 * 以及每条本地分支的上游跟踪关系）。
 *
 * `also` 可以是单个对象或对象数组：分支管理器需要**两条**附加查询（远端分支 +
 * 本地分支上游），而每次都多跑一条 git 是本插件一直在压的成本（见 ops.js 里
 * 「一次 HTTP 往返拿两份」的注释）。数组里任何一条失败都只丢它自己那份字段，
 * 不影响主结果与其余附加结果。
 *
 * `enhance` 钩子在对应 parse 之后跑：分支列表的「默认分支兜底」用它补查远程 HEAD
 * （本地 origin/HEAD 缺失时），失败的兜底绝不能拖垮列表本身。
 */
async function collectOpData(spec, input, dir, result) {
  const fields = {}
  const notes = []
  if (result.code !== 0) return { fields, notes }
  if (spec.field !== undefined && spec.parse !== undefined) {
    fields[spec.field] = spec.parse(result.stdout, input)
  }
  const extras = spec.also === undefined
    ? []
    : (Array.isArray(spec.also) ? spec.also : [spec.also])
  for (const entry of extras) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const extra = await runGit(entry.argv(input), dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (extra.code !== 0) continue
    const parsed = entry.parse === undefined ? extra.stdout : entry.parse(extra.stdout, input)
    fields[entry.field] = entry.enhance === undefined ? parsed : await entry.enhance(parsed, dir)
  }
  if (spec.note !== undefined) {
    const text = spec.note(fields, input)
    if (hasText(text)) notes.push(text)
  }
  return { fields, notes }
}

/**
 * 「需要用户做个决定」的按钮组（面板渲染成一排按钮，点了就由面板代跑，不必敲命令）：
 *   · push 撞上「本地名 ≠ 上游名」→ 三条路（推到上游 / 另建同名分支 / 改本地名）；
 *   · push 撞上「这个远程推不进去」（没有写权限 / 分支受保护）→ 一排「推送到 <别的远程>」
 *     按钮（多远程时的出路）；
 *   · 分支未完全合并删不掉 → 一条「强制删除」（带二次确认）；
 *   · pull 撞上互不相关历史 → 两条路；冲突 / 合并没收尾 → 一条退路。
 * @param body - 原始请求体：删分支那条路需要知道删的是哪个分支名。
 */
function opChoices(op, recovery, body) {
  if (op === 'push' && recovery.reason === 'upstream-name-mismatch') {
    return mismatchPushChoices(recovery.mismatch)
  }
  if (op === 'push' && (recovery.reason === 'no-permission' || recovery.reason === 'branch-protected')) {
    return otherRemoteChoices(recovery.remoteChoices)
  }
  if (op === 'deleteBranch' && recovery.reason === 'unmerged') {
    return forceDeleteChoice(body !== null && typeof body === 'object' ? body.branch : null)
  }
  if (op !== 'pull') return null
  // pull 的选择只有一处定义（ops.js 的 pullChoices）：安全拉取也走同一个函数，
  // 「面板有按钮、安全拉取没有」这种分叉因此不可能再出现。
  return pullChoices(recovery)
}

/** 失败时回给面板的 message：补救过程写的中文结论优先于 git 的英文原文。 */
function opMessage(recovery) {
  if (recovery.result.code === 0) return null
  if (hasText(recovery.message)) return recovery.message
  return gitMissingMessage(recovery.result)
    ?? (recovery.result.stderr.trim() || 'git 退出码 ' + recovery.result.code)
}

/**
 * 「还没执行就失败」的响应（未知操作、参数不合法）。
 *
 * **形状必须与成功分支完全一致**：面板要读 network / notes / accelerated 来判断
 * 「是不是网络问题、要不要展开加速设置」，缺字段它就读到 undefined。
 * 这条约束原先只写在注释里，现在由 network.test.mjs 的一条断言钉住。
 */
function shapedFailure(text) {
  return {
    payload: { ...opResponse(), message: text },
    meta: { argv: null, exit: null, retried: false },
  }
}

/**
 * 执行一个面板操作，返回 { payload, meta }。
 * meta 只用于写日志（真正的 argv / 退出码），不进响应体。
 */
async function runPanelOp(op, body, dir) {
  const special = SPECIAL_OPS[op]
  if (special !== undefined) {
    // stashPull 里的 `git pull` 走 executeWithAcceleration：与「拉取」按钮同一条
    // 加速/回退线路（多步操作里混入的 pull 绝不能被排除在加速之外）。
    // 第二个参数对 adoptRemote / abortMerge 无意义，它们忽略即可。
    const pullRunner = (argv, timeoutMs) => executeWithAcceleration('pull', argv, dir, timeoutMs)
    const payload = await special(body, dir, pullRunner)
    return { payload, meta: { argv: null, exit: payload.exitCode ?? null, retried: payload.retried === true } }
  }

  const spec = OPS[op]
  if (spec === undefined) return shapedFailure('未知操作：' + op)

  let argv
  try {
    argv = await buildOpArgv(op, body, dir)
  } catch (error) {
    return shapedFailure(message(error))
  }

  const timeoutMs = opTimeoutMs(spec)
  const attempt = await executeWithAcceleration(op, argv, dir, timeoutMs)
  const recovery = await recoverOp(op, spec, attempt, body, dir, timeoutMs)

  const notes = [...attempt.notes]
  if (hasText(recovery.note)) notes.push(recovery.note)
  const collected = await collectOpData(spec, body, dir, recovery.result)
  notes.push(...collected.notes)

  // 冲突现场要能说清「是哪些文件」：面板给了「撤销这次合并」的按钮，却没列文件时，
  // 用户只知道「有冲突」，还得自己去终端 git status 才知道要处理什么。
  if (recovery.result.code !== 0
    && (recovery.reason === 'conflict' || recovery.reason === 'merge-unfinished')) {
    const conflicts = await conflictedFiles(dir)
    if (conflicts.length > 0) notes.push('要处理的冲突文件：' + conflicts.join('、'))
  }

  // 失败原因分流：网络不通要给出「去开加速」的提示，其余交给各自的提示表。
  // 顺序不能反 —— classifyPushFailure 对网络类报错返回 none，先问它会得到空提示。
  const failure = recovery.result.code === 0 ? null : recovery.result
  const networkFailure = failure === null ? null : classifyNetworkFailure(failure.stderr)
  const hintFor = spec.hint ?? pushHint
  // 补救函数可以带一句**针对本次现场**的下一步（recovery.hint）：例如「拉取自 X、但 X 上
  // 没有这条分支」时的提示与通用版 pullHint 说的不是同一件事。没带就照旧按 reason 查表。
  const hint = failure === null
    ? null
    : (networkFailure !== null
        ? networkHint(attempt.accel.mode !== 'direct')
        : (hasText(recovery.hint) ? recovery.hint : hintFor(recovery.reason)))

  // 克隆成功后告诉面板新仓库落在哪，让面板可以自动切进去（默认目标名与 git 一致）。
  let clonedDir = null
  if (op === 'clone' && recovery.result.code === 0) {
    const target = normalizeDir(body.target)
    // resolve 而不是 join：join('/a', '/abs') 会拼出 '/a/abs'，克隆完会把面板带到一个
    // 并不存在的目录（工具侧 git_clone 允许显式给绝对目标目录）。
    clonedDir = target !== undefined ? resolve(dir, target) : resolve(dir, cloneTargetName(body.url))
  }

  const payload = {
    ok: recovery.result.code === 0,
    command: 'git ' + displayArgv(recovery.argv).join(' '),
    exitCode: recovery.result.code,
    stdout: recovery.result.stdout,
    stderr: recovery.result.stderr,
    message: opMessage(recovery),
    reason: recovery.reason,
    hint,
    retried: recovery.retried === true,
    // 本次实际用了哪条线路，以及给面板看的说明（走镜像意味着请求经过了第三方，
    // 用户必须能看见这件事，不能在后台默默发生）。
    accelerated: attempt.accel.mode,
    network: networkFailure !== null,
    notes,
    clonedDir,
    choices: opChoices(op, recovery, body),
    ...collected.fields,
  }
  return {
    payload,
    meta: { argv: recovery.argv, exit: recovery.result.code, retried: recovery.retried === true },
  }
}

/** 面板操作的日志字段（argv 打码后才落盘；每次操作都留痕，含补救动作）。 */
function opLogFields(op, dir, startedAt, payload, meta) {
  return {
    op,
    dir,
    argv: meta.argv === null ? null : displayArgv(meta.argv),
    exit: meta.exit,
    ms: Date.now() - startedAt,
    retried: meta.retried === true,
    accelerated: payload.accelerated,
    network: payload.network === true,
    reason: payload.reason,
    message: payload.ok === true ? null : (firstLine(String(payload.message ?? '')) || null),
  }
}

// ── 路由表 ────────────────────────────────────────────────────────────────

/**
 * 构造面板使用的 HTTP 路由：状态 / 操作 / 网络加速 / 诊断 / 日志 / 帮助文档。
 * @param getDefaultDir - 返回缺省执行目录（未传 dir 时使用）。
 */
function createRoutes(getDefaultDir) {
  /** GET /git-sidebar/state?dir=<绝对路径> —— 读取仓库状态（同时发放一枚会话令牌）。 */
  const stateRoute = {
    kind: 'exact',
    path: '/git-sidebar/state',
    handler: async (request, response) => {
      const csrf = issueCsrf()
      try {
        const dir = normalizeDir(requestUrl(request).searchParams.get('dir')) ?? getDefaultDir()
        sendJson(response, 200, { ...(await readStateCached(dir)), csrf })
      } catch (error) {
        // 形状必须与 readState 完全一致（见 git.js 的 emptyState）——否则面板读到的
        // 字段会缺一块，只能靠 undefined 兜底。
        sendJson(response, 200, { ...emptyState('读取失败：' + message(error), null, false), csrf })
      }
    },
  }

  /** POST /git-sidebar/op —— 执行一个白名单 git 操作，并回带最新状态。 */
  const opRoute = {
    kind: 'exact',
    path: '/git-sidebar/op',
    handler: async (request, response) => {
      const startedAt = Date.now()
      if (guardPost(request, response)) return
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        // 请求本身不合法（非法 JSON / 过大）→ 400，与「服务内部出错」区分开。
        await appendLog('warn', 'op', { op: null, error: message(error), ms: Date.now() - startedAt })
        fail(response, 400, error)
        return
      }
      if (!csrfAcceptable(body)) {
        await appendLog('warn', 'op', { op: typeof body.op === 'string' ? body.op : null, error: 'csrf', ms: Date.now() - startedAt })
        fail(response, 403, new Error('拒绝执行：缺少有效的会话令牌（刷新页面后重试）'))
        return
      }
      const dir = normalizeDir(body.dir) ?? getDefaultDir()
      const op = typeof body.op === 'string' ? body.op : ''
      try {
        // 同一目录的写操作串行执行：面板与 AI 工具可能同时操作同一个仓库。
        const { payload, meta } = await withDirLock(dir, () => runPanelOp(op, body, dir))
        // noState：数据型操作（列分支、查 diff）不需要仓库状态，跳过这 4 条 git 进程。
        const state = body.noState === true ? null : await readState(dir)
        // 刚读到的状态写回短缓存：紧接着的刷新/自动刷新可以直接复用。
        if (state !== null) primeStateCache(dir, state)
        sendJson(response, 200, { ...payload, state })
        await appendLog(payload.ok === true ? 'info' : 'warn', 'op', opLogFields(op, dir, startedAt, payload, meta))
      } catch (error) {
        await appendLog('error', 'op', { op, error: message(error), ms: Date.now() - startedAt })
        fail(response, 500, error)
      }
    },
  }

  /**
   * /git-sidebar/net —— 网络加速配置。
   *   GET             读配置（代理凭据一律打码，不回显明文）
   *   GET  ?probe=1   现场实测每条线路，返回各条通不通、耗时多少
   *   POST            保存配置
   *
   * POST 必须同源校验：这个接口决定 git 命令**怎么执行**（注入代理/镜像），
   * 能被跨站改写就等于把用户的仓库流量导向别处。
   * 三条方法合并在一个 handler 里：路由注册是按 path 索引的，同 path 挂多个会互相覆盖。
   */
  const netRoute = {
    kind: 'exact',
    path: '/git-sidebar/net',
    handler: async (request, response) => {
      const startedAt = Date.now()
      try {
        const url = requestUrl(request)
        if (request.method === 'GET') {
          const config = await readNetConfig()
          if (url.searchParams.get('probe') === '1') {
            const results = await probeNetwork(config)
            await appendLog('info', 'net', {
              action: 'probe',
              results: results.map((item) => ({ kind: item.kind, ok: item.ok, ms: item.ms })),
              ms: Date.now() - startedAt,
            })
            sendJson(response, 200, { ok: true, results })
            return
          }
          // 读配置的同时发放会话令牌（与 state 同一个集合）：面板启动就会读它，
          // 于是「保存代理」这个 POST 在同源页面里从一开始就带着令牌。
          sendJson(response, 200, { ok: true, ...netConfigView(config), csrf: issueCsrf() })
          return
        }
        if (guardPost(request, response, 'GET, POST')) return
        const body = await readJsonBody(request)
        if (!csrfAcceptable(body)) {
          fail(response, 403, new Error('拒绝执行：缺少有效的会话令牌（刷新页面后重试）'))
          return
        }
        const saved = await writeNetConfig(netPatch(body))
        // 网络加速配置决定 git 命令**怎么执行**，改动必须留痕（凭据打码，只记有没有）。
        await appendLog('info', 'net', {
          action: 'save',
          mirrorEnabled: saved.mirrorEnabled,
          mirror: saved.mirror,
          hasProxy: saved.proxy.length > 0,
          ms: Date.now() - startedAt,
        })
        sendJson(response, 200, { ok: true, ...netConfigView(saved) })
      } catch (error) {
        fail(response, 500, error)
      }
    },
  }

  /**
   * POST /git-sidebar/diag —— 客户端把界面注册过程回报到宿主日志。
   * 只写本地文件、不回显敏感信息；用于排查「面板出现但设置开关没出现」这类
   * 客户端注册问题（浏览器控制台对用户不可见时，这是唯一的观测通道）。
   */
  const diagRoute = {
    kind: 'exact',
    path: '/git-sidebar/diag',
    handler: async (request, response) => {
      if (guardPost(request, response)) return
      try {
        const body = await readJsonBody(request)
        await appendLog('info', 'diag', {
          stage: typeof body.stage === 'string' ? body.stage : 'unknown',
          detail: body.detail === undefined || body.detail === null ? null : String(body.detail),
        })
        sendJson(response, 200, { ok: true })
      } catch (error) {
        fail(response, 400, error)
      }
    },
  }

  /**
   * GET /git-sidebar/log?lines=N —— 读取日志尾部（最近 N 行原文，上限 2000）。
   * 供维护排查用：面板出问题后在这里核对操作经过；也可以配合工具直接读。
   *
   * **带 Origin 的跨站请求一律拒绝**（浏览器地址栏直开、curl 都不带 Origin，
   * 照常可用）：日志里是操作目录、仓库名与提交信息这类本机工作痕迹，
   * 不该被别的站点用脚本拉着读。它与 POST 的令牌校验不是一回事 ——
   * 这里只挡住「带来源的跨站读取」，不假装成鉴权。
   */
  const logRoute = {
    kind: 'exact',
    path: '/git-sidebar/log',
    handler: async (request, response) => {
      const foreign = foreignOrigin(request)
      if (foreign !== null) {
        void appendLog('warn', 'guard', {
          route: 'log',
          origin: headerText(request.headers.origin) || null,
          host: headerText(request.headers.host) || null,
          reason: foreign,
        })
        sendJson(response, 403, {
          ok: false,
          message: '拒绝读取：请求来源不可信（' + foreign + '）',
          state: null,
        })
        return
      }
      try {
        const parsed = Number.parseInt(requestUrl(request).searchParams.get('lines') ?? '', 10)
        const lines = await readLogTail(Number.isFinite(parsed) && parsed > 0 ? parsed : 200)
        sendJson(response, 200, { ok: true, lines })
      } catch (error) {
        fail(response, 500, error)
      }
    },
  }

  /**
   * GET /git-sidebar/help —— 帮助文档（独立 HTML 页面，面板的「?」在新标签页打开）。
   * 纯静态内容：不读仓库、不执行 git，因此不涉及目录参数与权限。
   */
  const helpRoute = {
    kind: 'exact',
    path: '/git-sidebar/help',
    handler: (request, response) => {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(renderHelpHtml())
    },
  }

  return [stateRoute, opRoute, netRoute, diagRoute, logRoute, helpRoute]
}

/**
 * 面板回传的配置 → 落盘 patch。
 * 面板拿到的代理地址是**打码后**的（`***@`），原样存回去会把真凭据覆盖掉；
 * 见到打码串一律理解为「不变」。清空代理请传空串。
 */
function netPatch(body) {
  const patch = {}
  if (typeof body.mirrorEnabled === 'boolean') patch.mirrorEnabled = body.mirrorEnabled
  if (typeof body.mirror === 'string') patch.mirror = body.mirror
  if (typeof body.proxy === 'string' && !body.proxy.includes(MASK_TOKEN)) patch.proxy = body.proxy
  return patch
}

export {
  createRoutes, runPanelOp, requestUrl, sendJson, fail, guardPost, sameOrigin, crossOriginAllowed,
  readJsonBody, netPatch, opLogFields,
  // 测试钩子：令牌是模块级的，用例之间要能回到「还没发放过」的干净状态。
  issueCsrf, resetCsrfTokens, csrfAcceptable, readStateCached, withDirLock,
}
