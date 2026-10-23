// dsh-git-sidebar —— AI 生成提交信息（suggest.js / 提交框方框按钮的宿主半边）
// ============================================================================
// 两层覆盖，各盯一件事：
//   1. **纯函数**（提示词 / 截断 / 清洗 / 改动分类 / 路由回退）—— 不碰 git、
//      不碰 LLM，断言语义本身：模型说的每一句话都要被洗干净才许进提交框，
//      分类与回退链写错会让生成「看起来成功、其实对错了改动 / 用了错的模型」。
//   2. **runSuggestion 全流程**（临时真仓库 + 假 llm 服务）—— 从 `git status`
//      到流式拼装走一遍：暂存优先、身份自由的 user 输入、最低推理档、
//      finish=error 的失败通道，这些只能端到端钉住。
//
// 全程零外部依赖（node: 内置 + 本插件 lib），与其余测试文件同一套约定：
// 本机没有 git 时相关用例 skip，而不是假绿。
// ============================================================================

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SUGGEST_DIFF_LIMIT, buildCommitPrompt, classifyChanges, cleanSuggestion,
  createSuggestHandler, defaultRouteOf, lowestReasoningEffortOf, newestModelRouteOf,
  normalizeLanguage, runSuggestion, setLogConfig, truncateDiff,
} from '../lib/index.js'

const run = promisify(execFile)

// 与 standalone.test.mjs 同一套：只影响本进程拉起的 git，不碰用户配置。
// autocrlf=false 让临时仓库的 diff 不因机器默认值而带上 \r（断言按行内容写）。
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'core.autocrlf'
process.env.GIT_CONFIG_VALUE_0 = 'false'

// ── 日志钉到临时目录（理由同 unit.test.mjs：别让用例往仓库根写日志） ────────
let logHome = null

before(async () => {
  logHome = await mkdtemp(join(tmpdir(), 'git-sidebar-suggest-'))
  setLogConfig({ file: join(logHome, 'git-sidebar.log') })
})

after(async () => {
  setLogConfig({})
  if (logHome !== null) await rm(logHome, { recursive: true, force: true })
})

// ── 1. 纯函数 ─────────────────────────────────────────────────────────────

test('suggest：normalizeLanguage 只认 zh，其余一律按英文提示词', () => {
  assert.equal(normalizeLanguage('zh'), 'zh')
  assert.equal(normalizeLanguage('en'), 'en')
  assert.equal(normalizeLanguage('jp'), 'en')
  assert.equal(normalizeLanguage(undefined), 'en')
  assert.equal(normalizeLanguage({ zh: true }), 'en')
})

test('suggest：truncateDiff 只在超限时截断，且断处写明标记', () => {
  const short = 'diff --git a/x b/x\n'
  assert.equal(truncateDiff(short), short, '没超限就不该动')
  assert.equal(truncateDiff(''), '')
  assert.equal(truncateDiff(undefined), '', '非字符串不该抛')
  const long = 'x'.repeat(SUGGEST_DIFF_LIMIT + 500)
  const cut = truncateDiff(long)
  assert.equal(cut.length, SUGGEST_DIFF_LIMIT + '\n...(diff truncated)'.length)
  assert.ok(cut.endsWith('...(diff truncated)'), '截断必须带标记：模型要知道信息不全')
})

test('suggest：buildCommitPrompt 中英两版都带文件清单、差异与 Conventional Commits 约束', () => {
  const zh = buildCommitPrompt('zh', ['src/a.js', 'README.md'], '+行1\n-行2')
  assert.ok(zh.system.includes('Conventional Commits'), '系统半要给出提交风格')
  assert.ok(zh.system.includes('只输出提交信息本身'), '不许模型解释 —— 这段文字直接进提交框')
  assert.ok(zh.user.includes('改动的文件：\nsrc/a.js\nREADME.md'), '文件清单原样进提示词')
  assert.ok(zh.user.includes('+行1\n-行2'), '差异原样进提示词')

  const en = buildCommitPrompt('en', ['a.txt'], '+x')
  assert.ok(en.system.includes('commit message assistant'))
  assert.ok(en.user.startsWith('Changed files:\na.txt'))
  assert.ok(en.user.includes('Diff:\n+x'))
})

test('suggest：cleanSuggestion 剥掉代码栅栏、行尾空白与首尾空行', () => {
  assert.equal(cleanSuggestion('```\nfeat: 修一处笔误\n```'), 'feat: 修一处笔误')
  assert.equal(cleanSuggestion('  "fix: 编译错误"  \n'), '"fix: 编译错误"')
  assert.equal(cleanSuggestion('feat: a\r\n\r\n'), 'feat: a')
  assert.equal(cleanSuggestion(''), '')
  assert.equal(cleanSuggestion(undefined), '', '非字符串不该抛')
  // 中间行的行尾空白要保留行本身、只削右边：提交信息可能真是多行。
  assert.equal(cleanSuggestion('标题  \n正文'), '标题\n正文')
})

test('suggest：classifyChanges 按 X/Y 分三堆，冲突条目两边都算', () => {
  const { staged, unstaged, untracked } = classifyChanges([
    { code: 'M ', path: 'a.txt' },
    { code: ' M', path: 'b.txt' },
    { code: '??', path: 'c.txt' },
    { code: 'A ', path: 'd.txt' },
    { code: 'MM', path: 'e.txt' },
    { code: 'UU', path: 'conflict.txt' },
    { code: ' D', path: 'gone.txt' },
    null,
    { code: 'M ', path: '' },
  ])
  assert.deepEqual(staged, ['a.txt', 'd.txt', 'e.txt', 'conflict.txt'], 'X 非空即已暂存')
  assert.deepEqual(unstaged, ['b.txt', 'e.txt', 'conflict.txt', 'gone.txt'], 'Y 非空即未暂存；冲突两边都要看见')
  assert.deepEqual(untracked, ['c.txt'])
  assert.deepEqual(classifyChanges(undefined), { staged: [], unstaged: [], untracked: [] })
})

test('suggest：模型路由的三级读取（默认选择 / 会话最新 request/header / 会话历史列表）', () => {
  assert.deepEqual(defaultRouteOf({ provider: 'deepseek', model: 'deepseek-chat' }),
    { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(defaultRouteOf({ provider: '', model: 'm' }), undefined, '空 provider 不是路由')
  assert.equal(defaultRouteOf(null), undefined)
  assert.equal(defaultRouteOf('deepseek/m'), undefined)

  const events = [
    { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } },
    { type: 'other' },
    { type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2' } } } },
  ]
  assert.deepEqual(newestModelRouteOf(events), { provider: 'p2', model: 'm2' }, '最新那次才是「当前模型」')
  assert.equal(newestModelRouteOf([]), undefined)
  assert.equal(newestModelRouteOf(undefined), undefined)
  assert.equal(
    newestModelRouteOf([{ type: 'request/header', data: { header: { config: { provider: '', model: 'm' } } } }]),
    undefined,
    '半截路由（缺 provider/model）不算数',
  )
})

test('suggest：lowestReasoningEffortOf 取已知档位里最低的，全部未知时取首项', () => {
  assert.equal(lowestReasoningEffortOf([{ id: 'high' }, { id: 'low' }, { id: 'xhigh' }]), 'low')
  assert.equal(lowestReasoningEffortOf([{ id: 'medium' }]), 'medium')
  assert.equal(lowestReasoningEffortOf([{ id: 'auto' }, { id: 'turbo' }]), 'auto', '未知 id 压不过已知 id，全未知取首项')
  assert.equal(lowestReasoningEffortOf([]), undefined, '一档都不广告就省略字段（非推理模型会被拒）')
  assert.equal(lowestReasoningEffortOf('high'), undefined)
  assert.equal(lowestReasoningEffortOf(undefined), undefined)
})

// ── 2. runSuggestion 全流程（临时仓库 + 假 llm） ──────────────────────────

/** 捕获流式入参的假 llm 服务：既记录 options，也照真实协议吐块。 */
function fakeLlm(options = {}) {
  const seen = []
  const chunks = options.chunks ?? [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: options.text ?? '```\nfeat: 生成的提交信息\n```' },
    { type: 'finish', reason: options.finish ?? { kind: 'stop' } },
  ]
  return {
    seen,
    async *stream(generateOptions) {
      seen.push(generateOptions)
      for (const chunk of chunks) yield chunk
    },
    async resolveModelInfo() {
      if (options.noModelInfo === true) throw new Error('adapter cannot answer')
      return { reasoning: { efforts: options.efforts ?? [{ id: 'high' }, { id: 'low' }] } }
    },
  }
}

/** 只有 get() 的 cordis 上下文替身（suggest.js 对 ctx 的全部要求）。 */
function fakeCtx(table = {}) {
  return { get: (key) => table[key] }
}

/** 建一个临时仓库；本机没有 git 时返回 null（调用方 skip）。 */
async function makeRepo(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  } catch {
    await rm(dir, { recursive: true, force: true })
    return null
  }
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test',
    'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

test('suggest：暂存优先 —— 提示词带暂存文件、差异与最低推理档，结果剥掉栅栏', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-repo-')
  if (repo === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await writeFile(join(repo, 'staged.txt'), 'one\ntwo\n')
    await run('git', ['add', '--', 'staged.txt'], { cwd: repo })
    // 工作区里再造一条**没暂存**的改动：提示词必须对准马上要提交进去的那份，
    // 未暂存的那条既不该进文件清单，也不该进差异。
    await writeFile(join(repo, 'work.txt'), 'later\n')

    const llm = fakeLlm({ text: '```\nfeat: 新增示例文件\n```' })
    const ctx = fakeCtx({
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    const result = await runSuggestion({
      dir: repo,
      language: 'zh',
      sessionId: 's-none',
      getContext: () => ctx,
    })

    assert.deepEqual(result, {
      message: 'feat: 新增示例文件',
      provider: 'deepseek',
      model: 'deepseek-chat',
    }, '栅栏剥掉后的文本 + 实际使用的路由')

    assert.equal(llm.seen.length, 1)
    const options = llm.seen[0]
    assert.equal(options.provider, 'deepseek')
    assert.equal(options.model, 'deepseek-chat')
    assert.ok(options.system.includes('Conventional Commits'))
    assert.equal(options.maxTokens, 512, '一行提交信息用不着更大的输出预算')
    assert.equal(options.reasoningEffort, 'low', '取模型广告的最低档：默认 high 会把预算想光')
    assert.ok(options.signal instanceof AbortSignal, '必须带超时信号：供应方卡死不能让按钮永远转圈')
    assert.equal(options.messages.length, 1)
    assert.equal(options.messages[0].role, 'user')
    assert.equal(options.messages[0].content[0].type, 'text')

    const userText = options.messages[0].content[0].text
    assert.ok(userText.includes('staged.txt'), '暂存的文件要进提示词')
    assert.ok(!userText.includes('work.txt'), '暂存优先：没暂存的改动不进这份提交的文件清单')
    assert.ok(/\+two/.test(userText), '暂存差异要进提示词')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('suggest：会话正在用的模型压过默认模型（agents.options 优先）', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-route-')
  if (repo === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await writeFile(join(repo, 'a.txt'), 'x\n')
    const llm = fakeLlm({ text: 'chore: 动一下' })
    const ctx = fakeCtx({
      llm,
      agents: { get: (id) => (id === 's1' ? { options: { provider: 'pinned', model: 'pinned-model' } } : undefined) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default-model' }) },
    })
    const result = await runSuggestion({
      dir: repo,
      language: 'zh',
      sessionId: 's1',
      getContext: () => ctx,
    })
    assert.equal(result.provider, 'pinned', '活 agent 的 options 是「当前模型」的最权威答案')
    assert.equal(result.model, 'pinned-model')
    assert.equal(llm.seen[0].provider, 'pinned')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('suggest：agent 不在时退回会话日志里最新的 request/header', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-events-')
  if (repo === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await writeFile(join(repo, 'a.txt'), 'x\n')
    const llm = fakeLlm({ text: 'docs: 补一段' })
    const ctx = fakeCtx({
      llm,
      agents: { get: () => undefined },
      sessions: {
        get: (id) => (id === 's1'
          ? {
              snapshotEvents: () => [
                { type: 'request/header', data: { header: { config: { provider: 'from-log', model: 'log-model' } } } },
              ],
            }
          : undefined),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default-model' }) },
    })
    const result = await runSuggestion({ dir: repo, language: 'zh', sessionId: 's1', getContext: () => ctx })
    assert.equal(result.provider, 'from-log')
    assert.equal(result.model, 'log-model')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('suggest：纯未跟踪集也成立（没有 diff 就只给文件清单）', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-untracked-')
  if (repo === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await writeFile(join(repo, 'brand-new.txt'), 'hello\n')
    const llm = fakeLlm({ text: 'feat: 新增 brand-new.txt' })
    const ctx = fakeCtx({
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    const result = await runSuggestion({ dir: repo, language: 'zh', getContext: () => ctx })
    assert.equal(result.message, 'feat: 新增 brand-new.txt')
    const userText = llm.seen[0].messages[0].content[0].text
    assert.ok(userText.includes('brand-new.txt'))
    assert.ok(userText.endsWith('差异：\n'), '没有 diff 时差异段留空，但文件清单仍然成立')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('suggest：失败通道各有各的状态码与中文原因', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-fail-')
  const clean = await makeRepo('git-sidebar-suggest-clean-')
  if (repo === null || clean === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    const defaultCtx = () => fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    // ① 干净仓库：400 —— 用户点早了，不是宿主坏了。
    const noChanges = await runSuggestion({ dir: clean, getContext: defaultCtx }).catch((error) => error)
    assert.equal(noChanges.status, 400)
    assert.match(noChanges.message, /没有可提交的改动/)

    // ② 还不是仓库（一个存在的普通目录）：400 + 宿主的诊断原文。
    const plain = await mkdtemp(join(tmpdir(), 'git-sidebar-notrepo-'))
    try {
      const notRepo = await runSuggestion({ dir: plain, getContext: defaultCtx }).catch((error) => error)
      assert.equal(notRepo.status, 400)
      assert.match(notRepo.message, /Git 仓库|读取失败/)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }

    // ③ 没有 LLM 服务：503 —— 能力缺席，与「用户点早了」必须分得开。
    await writeFile(join(repo, 'a.txt'), 'x\n')
    const noLlm = await runSuggestion({ dir: repo, getContext: defaultCtx }).catch((error) => error)
    assert.equal(noLlm.status, 503)
    assert.match(noLlm.message, /LLM 服务/)

    // ④ 路由三级全空：503 —— 冷会话 + 没配默认模型是唯一走不到的地方。
    const noRoute = await runSuggestion({ dir: repo, getContext: () => fakeCtx({ llm: fakeLlm() }) })
      .catch((error) => error)
    assert.equal(noRoute.status, 503)
    assert.match(noRoute.message, /没有可用的模型/)

    // ⑤ 适配器失败被规整成 finish=error（不抛异常）：必须仍是一条失败。
    const broken = await runSuggestion({
      dir: repo,
      getContext: () => fakeCtx({
        llm: fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: '401 invalid key' } } }] }),
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      }),
    }).catch((error) => error)
    assert.equal(broken.status, 502)
    assert.match(broken.message, /401 invalid key/)

    // ⑥ 模型一个字没吐（推理模型把预算想光）：500 + finish 原因，方便对症。
    const empty = await runSuggestion({
      dir: repo,
      getContext: () => fakeCtx({
        llm: fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] }),
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      }),
    }).catch((error) => error)
    assert.equal(empty.status, 500)
    assert.match(empty.message, /空的提交信息.*max-tokens/)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(clean, { recursive: true, force: true })
  }
})

test('suggest：createSuggestHandler 按 routes.js 的入参形状转发', async (context) => {
  const repo = await makeRepo('git-sidebar-suggest-handler-')
  if (repo === null) {
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await writeFile(join(repo, 'a.txt'), 'x\n')
    let seenRequest = null
    const handler = createSuggestHandler(() => fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: fakeLlm({ text: 'chore: 转发成功' }),
    }))
    // 路由层（routes.js）按这个入参形状调用：断言 dir / language / sessionId 原样到达，
    // 且成功时 { message, provider, model } 原样回到路由。
    const wrapped = async (request) => {
      seenRequest = request
      return handler(request)
    }
    const result = await wrapped({ dir: repo, language: 'zh', sessionId: 's1' })
    assert.deepEqual(seenRequest, { dir: repo, language: 'zh', sessionId: 's1' })
    assert.equal(result.message, 'chore: 转发成功')
    assert.equal(result.provider, 'p')
    assert.equal(result.model, 'm')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
