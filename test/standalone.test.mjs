// dsh-git-sidebar —— 独立运行（standalone）回归测试
// ============================================================================
// 目标：**不装进 DSH、不依赖任何外部依赖**，只用一个 mock ctx 就把宿主半边完整
// 跑一遍，从而在任何机器 / 任何 DSH 版本上都能先证明「插件本身能加载、能注册」。
//
// 覆盖三件在换机器/换 DSH 版本时最容易坏、又最难发现的事：
//   1. 模块能被 import —— 只用 node: 内置模块，不带任何 npm 依赖。
//   2. apply(ctx) 不抛异常 —— webServer / tools 两种惰性服务都覆盖
//      （立刻可用 / 稍后就绪 / 两者都缺）。
//   3. 每个 git 工具的 parameters 都是 harness 支持的 JSON Schema 子集
//      （type/oneOf/properties/required/additionalProperties/items/enum/const
//      + description/title/default/examples）。**不支持 anyOf / $ref / format /
//      pattern 等**；一旦用了，tools.register 会抛错，13 个工具会静默全丢。
//      mock 注册表在这里复刻 harness 的校验，跑测试就等价于跑一次真注册。
// ============================================================================

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 让**本进程**里所有 git 子进程都用 core.autocrlf=false 跑。
//
// 为什么：Windows 上 `core.autocrlf=true`（git 安装器的默认勾选）会让临时仓库里
// checkout 出来的文件带上 CRLF，而用例断言的是 `'内容\n'` —— 于是 stashPull /
// stashSwitch 这 4 条在干净代码上也永远红着（实测过），真回归反而被埋在噪音里。
// 用 GIT_CONFIG_* 环境变量只影响本进程拉起的 git，**不改用户任何 git 配置**
// （这也正是插件自己的原则：git -c / 环境变量只作用于单次调用）。
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'core.autocrlf'
process.env.GIT_CONFIG_VALUE_0 = 'false'

// 日志默认落在插件仓库根目录；测试期间把它钉到临时目录，别让「跑一次测试」在仓库根
// 留下 git-sidebar.log（默认路径由 lib/log.js 从 import.meta.url 推导，与 cwd 无关）。
let tempHome = null
let tempLog = null
before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'git-sidebar-standalone-'))
  tempLog = join(tempHome, 'git-sidebar.log')
  process.env.DSH_HOME = tempHome
})
after(async () => {
  if (tempHome !== null) await rm(tempHome, { recursive: true, force: true })
})

// ── harness JSON Schema 子集校验（复刻 dsh-tools 的 assertSupportedJsonSchema） ──
// 只复刻判定规则，不引入任何依赖；规则见 packages/core/tools/src/json-schema.ts。

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ALLOWED_FOR = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 返回违规说明数组；空数组 = 该 schema 在 harness 里合法。 */
function schemaViolations(node, path = 'schema') {
  const out = []
  if (!isPlainObject(node)) return [`${path} is not a schema object`]
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) continue
    out.push(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) return [...out, `${path} cannot declare both type and oneOf`]
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    }
    return out
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      return [...out, `${path}.oneOf must be an array of at least two schemas`]
    }
    node.oneOf.forEach((child, index) => out.push(...schemaViolations(child, `${path}.oneOf[${index}]`)))
    return out
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
    return [...out, `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`]
  }
  for (const [key, types] of Object.entries(ALLOWED_FOR)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      out.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    if (!isPlainObject(node.properties)) {
      out.push(`${path}.properties must be an object of schemas`)
    } else {
      for (const [name, child] of Object.entries(node.properties)) {
        out.push(...schemaViolations(child, `${path}.properties.${name}`))
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    out.push(...schemaViolations(node.items, `${path}.items`))
  }
  return out
}

// ── mock ctx：复刻插件用到的全部宿主契约 ────────────────────────────────────

/**
 * 造一个 mock ctx。
 * @param options.withWebServer - 是否在 apply 之前就有 webServer 实例。
 * @param options.withTools - 是否在 apply 之前就有 tools 实例。
 * @param options.deferServices - true 时两者都不在 apply 时提供，只在稍后
 *   通过 ctx.inject 的回调里给（复刻 harness 的惰性服务就绪时机）。
 */
function makeCtx(options = {}) {
  const routes = []
  const tools = []
  const effects = []
  const pendingInject = []
  const server = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const registry = {
    register(definition) {
      assert.equal(typeof definition.name, 'string', 'tool.name 必须是字符串')
      assert.ok(definition.name.length > 0, 'tool.name 不能为空')
      assert.equal(typeof definition.description, 'string', `工具 ${definition.name} 缺少 description`)
      const violations = schemaViolations(definition.parameters)
      assert.deepEqual(violations, [], `工具 ${definition.name} 的 parameters 不是受支持的 JSON Schema：\n  ${violations.join('\n  ')}`)
      assert.equal(typeof definition.output?.render, 'function', `工具 ${definition.name} 缺少 output.render`)
      assert.equal(typeof definition.execute, 'function', `工具 ${definition.name} 缺少 execute`)
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }
  const deferred = options.deferServices === true
  const ctx = {
    get(service) {
      if (deferred) return undefined
      if (service === 'webServer' && options.withWebServer !== false) return server
      if (service === 'tools' && options.withTools !== false) return registry
      return undefined
    },
    inject(services, callback) {
      pendingInject.push({ services: [...services], callback })
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    tools,
    server,
    registry,
    /** 触发所有排队的 ctx.inject 回调（复刻惰性服务就绪）。 */
    flushInject() {
      for (const entry of pendingInject.splice(0)) entry.callback({ webServer: server, tools: registry })
    },
    /** 触发 effect 的清理函数（复刻卸载）。 */
    dispose() {
      for (const factory of effects) {
        const disposer = factory()
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

// ── 1. 模块可独立 import（零 npm 依赖） ─────────────────────────────────────

test('standalone：import 宿主半边不抛异常，且只依赖 node: 内置模块', async () => {
  const module = await import('../lib/index.js')
  assert.equal(typeof module.apply, 'function', '宿主半边必须导出 apply')
  assert.equal(module.name, 'dsh-git-sidebar', '宿主半边必须导出包名 name')
})

// ── 2. apply() 在三种惰性服务时机下都不抛异常 ───────────────────────────────

test('standalone：webServer / tools 就绪时，apply 直接注册成功', () => {
  const harness = makeCtx()
  return import('../lib/index.js').then(({ apply }) => {
    assert.doesNotThrow(() => apply(harness.ctx, { logFile: tempLog }))
    assert.equal(harness.routes.length, 6, '应注册 6 条路由（state/op/net/diag/log/help）')
    assert.equal(harness.tools.length, 13, '应注册 13 个 git 工具')
    const paths = harness.routes.map((route) => route.path).sort()
    assert.deepEqual(paths, ['/git-sidebar/diag', '/git-sidebar/help', '/git-sidebar/log', '/git-sidebar/net', '/git-sidebar/op', '/git-sidebar/state'])
    for (const route of harness.routes) {
      assert.equal(route.kind, 'exact', `路由 ${route.path} 必须是 exact`)
      assert.equal(typeof route.handler, 'function', `路由 ${route.path} 必须有 handler`)
    }
  })
})

test('standalone：webServer / tools 稍后就绪时，apply 不抛异常且不丢注册', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx({ deferServices: true })
  assert.doesNotThrow(() => apply(harness.ctx, { logFile: tempLog }))
  assert.equal(harness.routes.length, 0, '服务未就绪时不应有路由')
  assert.equal(harness.tools.length, 0, '服务未就绪时不应有工具')
  harness.flushInject()
  assert.equal(harness.routes.length, 6, '服务就绪后应补上 6 条路由')
  assert.equal(harness.tools.length, 13, '服务就绪后应补上 13 个工具')
})

test('standalone：webServer / tools 都不存在时，apply 也不抛异常（面板/工具降级）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx({ withWebServer: false, withTools: false })
  assert.doesNotThrow(() => apply(harness.ctx, { logFile: tempLog }))
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.tools.length, 0)
})

test('standalone：ctx 连 get / inject / effect 都没有时（老/裁剪版本）也不抛异常', async () => {
  const { apply } = await import('../lib/index.js')
  assert.doesNotThrow(() => apply({}, { logFile: tempLog }))
  // 这一条必须传 undefined（测的就是「config 缺省」）：apply 会把日志配置重置回默认路径。
  // 它那条 lifecycle 是队列里的异步写，实测在测试进程退出前不会落盘；真落盘也只是插件
  // 仓库根那份 git-sidebar.log（已在 .gitignore 里）。
  assert.doesNotThrow(() => apply({ get: () => undefined }, undefined))
})

test('standalone：卸载会清空路由与工具（可重复 apply / dispose）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, { logFile: tempLog })
  assert.equal(harness.routes.length, 6)
  assert.equal(harness.tools.length, 13)
  harness.dispose()
  assert.equal(harness.routes.length, 0, '卸载后路由应被注销')
  assert.equal(harness.tools.length, 0, '卸载后工具应被注销')
})

// ── 3. 13 个工具的 schema 都必须落在 harness 支持的子集内 ────────────────────

test('standalone：13 个工具名唯一、schema 合法、必填项都声明了', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, { logFile: tempLog })
  const names = harness.tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const tool of harness.tools) {
    assert.equal(tool.parameters.type, 'object', `工具 ${tool.name} 的 parameters 必须是 object 根`)
    assert.ok(tool.parameters.properties !== undefined, `工具 ${tool.name} 必须有 properties`)
    // 公共参数（workdir / timeoutMs）每个工具都要有。
    assert.ok(Object.hasOwn(tool.parameters.properties, 'workdir'), `工具 ${tool.name} 缺少公共参数 workdir`)
    assert.ok(Object.hasOwn(tool.parameters.properties, 'timeoutMs'), `工具 ${tool.name} 缺少公共参数 timeoutMs`)
    // required 若声明，必须指向真实存在的属性，否则模型侧永远校验失败。
    for (const required of tool.parameters.required ?? []) {
      assert.ok(Object.hasOwn(tool.parameters.properties, required), `工具 ${tool.name} 的 required "${required}" 不在 properties 里`)
    }
    // output 声明必须与 harness 契约一致：schema + render。
    assert.equal(typeof tool.output.render, 'function', `工具 ${tool.name} 的 output.render 必须是函数`)
    assert.doesNotThrow(() => schemaViolations(tool.output.schema), `工具 ${tool.name} 的 output.schema 非法`)
    // render 必须对普通字符串值返回非空 content 数组（面板/模型都靠它显示结果）。
    const rendered = tool.output.render({}, 'hello')
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `工具 ${tool.name} 的 render 必须返回非空数组`)
    assert.equal(rendered[0].type, 'text')
  }
})

test('standalone：工具 execute 对缺参/非法参**抛错**（让 harness 标成失败调用）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, { logFile: tempLog })
  const byName = new Map(harness.tools.map((tool) => [tool.name, tool]))
  const exec = { signal: undefined, agent: undefined }
  // 契约变更（原来返回一段普通文本）：execute 抛出的异常会被 harness 记成**失败的调用**，
  // 而返回文本会被模型读成「命令跑完了」——参数写错就变成静默的假成功。
  // 消息里必须带工具名，否则模型不知道该重试哪个工具。
  await assert.rejects(() => byName.get('git_add').execute({}, exec), /git_add/)
  await assert.rejects(() => byName.get('git_run').execute({ subcommand: 'Bad Name' }, exec), /git_run/)
  await assert.rejects(() => byName.get('git_commit').execute({ message: '   ' }, exec), /git_commit/)
  await assert.rejects(() => byName.get('git_clone').execute({}, exec), /git_clone/)
})

// ── 4. 操作注册表：面板与模型工具必须共用同一份 argv 定义 ────────────────────
//
// 现场：面板切分支用 git switch（checkout 在「名字既像分支又像路径」时会误判成
// 还原文件，注释里写了原因），而工具 git_checkout 一直在用 git checkout -b。
// 同一个插件里点按钮和让 AI 做，行为不一样 —— 现在两条路径都指向 ops.js 的构造器。

test('standalone：面板与工具对切换/新建分支生成同一份 argv', async () => {
  const { buildOpArgv, TOOL_SPECS } = await import('../lib/index.js')
  const toolArgvFor = (name, args) => TOOL_SPECS.find((item) => item.name === name).toArgv(args, { dir: '.' })
  assert.deepEqual(await toolArgvFor('git_checkout', { branch: 'main' }), ['switch', 'main'])
  assert.deepEqual(await toolArgvFor('git_checkout', { branch: 'dev', create: true }), ['switch', '-c', 'dev'])
  assert.deepEqual(await buildOpArgv('checkout', { branch: 'main' }), ['switch', 'main'])
  assert.deepEqual(await buildOpArgv('createBranch', { branch: 'dev' }), ['switch', '-c', 'dev'])
  // 删除分支：面板只做安全删除（-d），工具的 force 走 -D —— 同一份构造器。
  assert.deepEqual(await toolArgvFor('git_branch', { name: 'x', delete: true }), ['branch', '-d', 'x'])
  assert.deepEqual(await buildOpArgv('deleteBranch', { branch: 'x' }), ['branch', '-d', 'x'])
})

test('standalone：OPS 的 network 标记与 net.js 的 NETWORK_OPS 完全一致', async () => {
  const { OPS, NETWORK_OPS, AUX_NET_OPS } = await import('../lib/index.js')
  // 两个集合按不同的键索引（面板操作名 vs git 子命令），必须由断言钉住，否则
  // 「加了新操作却忘了让加速生效」会变成静默的直连。
  for (const [op, spec] of Object.entries(OPS)) {
    assert.equal(spec.network === true, NETWORK_OPS.has(op), `OPS.${op} 与 NETWORK_OPS 不一致`)
  }
  for (const op of NETWORK_OPS) {
    // AUX_NET_OPS 是内部补查命令（'ls-remote'：远端默认分支兜底用），不是面板
    // 操作，不能要求它在 OPS 注册表里 —— 但必须是显式声明的例外，防止分叉。
    assert.ok(
      OPS[op] !== undefined || AUX_NET_OPS.has(op),
      `NETWORK_OPS 里的 ${op} 必须在 OPS 注册表（或 AUX_NET_OPS 例外）里`,
    )
  }
})

test('standalone：setRemote 的查重与执行用同一个目录（回归：曾用原始 body.dir 查重）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const repo = await mkdtemp(join(tmpdir(), 'git-sidebar-setremote-'))
  try {
    await run('git', ['init'], { cwd: repo })
  } catch {
    await rm(repo, { recursive: true, force: true })
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await run('git', ['remote', 'add', 'origin', 'https://old/x.git'], { cwd: repo })
    const { buildOpArgv } = await import('../lib/index.js')
    // 请求体里的 dir 是个不存在的地方（模拟 `~/…` 展开前的形态）；真正的目录由路由
    // 归一化后传进来。若查重跑在 body.dir 上，git remote 会失败 → 误判成「远程不存在」
    // → 返回 remote add → 真执行时报 fatal: remote origin already exists。
    const argv = await buildOpArgv(
      'setRemote',
      { url: 'https://new/x.git', dir: '~/definitely-not-a-repo-xyz' },
      repo,
    )
    assert.deepEqual(argv, ['remote', 'set-url', 'origin', 'https://new/x.git'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ── 5. 「不是工作区」的诊断文案：四种情况不能互相冒充 ────────────────────────
//
// 现场（在真实运行中的 dsh 上冒烟时发现）：
//   * 面板里敲错一个目录 → 提示「未检测到 git：请先安装 git」。Node 对「git 不存在」
//     和「cwd 不存在」给的错误对象一模一样（code=ENOENT、path='git'），
//     gitMissingMessage 一律当成前者 → 用户被指去装一个已经装好的 git。
//   * 真实存在的普通目录 → 面板显示 git 的英文原文
//     `fatal: not a git repository (or any of the parent directories): .git`，
//     而客户端 EmptyState 拿 '当前目录还不是 Git 仓库' 去重 → 去重分支永远是死的，
//     用户中英各看一句。

test('standalone：目录不存在 / 不是目录 / 不是仓库 / 裸仓库，四种诊断互不冒充', async () => {
  const { readState, NOT_REPO_NOTICE, BARE_REPO_NOTICE } = await import('../lib/index.js')

  // 1. 目录不存在 —— 绝不能再报「未检测到 git」（用户已经装好了 git）。
  const missing = join(tmpdir(), 'git-sidebar-definitely-missing-' + Date.now())
  const missingNotice = (await readState(missing)).notice
  assert.ok(missingNotice.includes('目录不存在或无法进入'), `应报路径问题，实际：${missingNotice}`)
  assert.ok(!missingNotice.includes('未检测到 git'), `不该把路径写错说成没装 git，实际：${missingNotice}`)

  // 2. 目录存在但不是目录（把文件当目录传进来）。
  const plain = await mkdtemp(join(tmpdir(), 'git-sidebar-plain-'))
  try {
    const file = join(plain, 'a-file.txt')
    await writeFile(file, 'x')
    const fileNotice = (await readState(file)).notice
    assert.ok(fileNotice.includes('不是一个目录'), `应报「不是目录」，实际：${fileNotice}`)

    // 3. 目录在、但不在任何工作区里 → 必须是客户端去重用的那个字符串。
    const notice = (await readState(plain)).notice
    assert.equal(notice, NOT_REPO_NOTICE, `非仓库的 notice 必须是 ${NOT_REPO_NOTICE}，实际：${notice}`)

    // 跨半边耦合：客户端 EmptyState 靠这个字面量去重，改一边不改另一边就会漏出重复文案。
    const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.ok(
      clientSource.includes("'" + NOT_REPO_NOTICE + "'"),
      `client.js 必须原样比较 '${NOT_REPO_NOTICE}'（否则去重分支是死代码）`,
    )
  } finally {
    await rm(plain, { recursive: true, force: true })
  }

  // 4. 裸仓库：rev-parse **成功**却回答 false，此前与「完全没有仓库」共用一句话。
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const bare = await mkdtemp(join(tmpdir(), 'git-sidebar-bare-'))
  try {
    await run('git', ['init', '--bare'], { cwd: bare })
  } catch {
    await rm(bare, { recursive: true, force: true })
    return
  }
  try {
    assert.equal((await readState(bare)).notice, BARE_REPO_NOTICE)
    // .git 内部同理（--is-inside-work-tree 也回答 false）。
    assert.equal((await readState(join(bare, 'objects'))).notice, BARE_REPO_NOTICE)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
})

// ── 6. 远端默认分支兜底：本地没有 origin/HEAD 时也要能标出默认分支 ────────────
//
// 现场：面板靠 `git branch --remotes` 里的 `origin/HEAD -> origin/main` 标默认分支，
// 而这个符号引用只在 clone（或新版 git 的首次 fetch）时建立 —— `git init` + 手动
// 加远程（旧版 git）、或从镜像拉取时它都不存在，列表里于是没有任何默认标记。
// enhanceRemoteBranches 在这些现场用 `git ls-remote --symref` 直接问服务器。

test('standalone：enhanceRemoteBranches 在本地无 origin/HEAD 时补查远程默认分支', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-default-'))
  try {
    await run('git', ['init', '--bare', '-b', 'main'], { cwd: root })
  } catch {
    await rm(root, { recursive: true, force: true })
    context.skip('本机没有可用的 git')
    return
  }
  const bare = join(root, 'origin.git')
  const src = join(root, 'src')
  const work = join(root, 'work')
  // execFile 要求 cwd 先存在（git init 创建的是仓库，不是目录本身）。
  await mkdir(src, { recursive: true })
  await mkdir(work, { recursive: true })
  try {
    // 远端仓库：默认分支 main，有一个提交。
    await run('git', ['init', '-q', '-b', 'main'], { cwd: src })
    await run('git', ['-C', src, 'config', 'user.email', 't@t'])
    await run('git', ['-C', src, 'config', 'user.name', 't'])
    await writeFile(join(src, 'f.txt'), 'x')
    await run('git', ['-C', src, 'add', 'f.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'init'])
    await run('git', ['clone', '-q', '--bare', src, bare])
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare })

    // 工作仓库：**故意不 clone** —— 手动加远程、不 fetch，模拟「本地没有
    // origin/HEAD」的现场（旧版 git 的 init + remote add + fetch 就是这样）。
    await run('git', ['init', '-q'], { cwd: work })
    await run('git', ['-C', work, 'remote', 'add', 'origin', bare])

    const { parseRemoteBranchOutput, enhanceRemoteBranches, remoteDefaultBranches } =
      await import('../lib/index.js')

    // 本地 `git branch --remotes`：什么都没有（连 fetch 都没跑），更没指针。
    const parsed = parseRemoteBranchOutput('')
    assert.equal(parsed.defaultRef, null)

    // 兜底：向远端问 HEAD（只读、走本地路径的 git 协议），能拿到 main。
    const defaults = await remoteDefaultBranches(work)
    assert.deepEqual(defaults, [{ remote: 'origin', branch: 'main' }])

    // 增强后：items 原样保留，defaults 带回服务器答案（分支还没下载所以没有
    // 可标记的行，但「谁是默认」已经知道，客户端据此渲染提示行）。
    const enhanced = await enhanceRemoteBranches(parsed, work)
    assert.deepEqual(enhanced.items, [])
    assert.deepEqual(enhanced.defaults, [{ remote: 'origin', branch: 'main' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：enhanceRemoteBranches 在本地有 origin/HEAD 时不发任何查询', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-clone-'))
  try {
    await run('git', ['init', '--bare', '-b', 'main'], { cwd: root })
  } catch {
    await rm(root, { recursive: true, force: true })
    context.skip('本机没有可用的 git')
    return
  }
  const bare = join(root, 'origin.git')
  const src = join(root, 'src')
  const work = join(root, 'work')
  await mkdir(src, { recursive: true })
  await mkdir(work, { recursive: true })
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: src })
    await run('git', ['-C', src, 'config', 'user.email', 't@t'])
    await run('git', ['-C', src, 'config', 'user.name', 't'])
    await writeFile(join(src, 'f.txt'), 'x')
    await run('git', ['-C', src, 'add', 'f.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'init'])
    await run('git', ['clone', '-q', '--bare', src, bare])
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare })

    // 正常 clone：origin/HEAD 由 clone 建立。
    await run('git', ['clone', '-q', bare, work])

    const { parseRemoteBranchOutput, enhanceRemoteBranches } = await import('../lib/index.js')
    const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n  origin/main\n')
    assert.equal(parsed.defaultRef, 'origin/main')
    assert.equal(parsed.items.find((item) => item.ref === 'origin/main').head, true)

    // 指针在、也对应得上列表里的分支 → 已知，原样返回，defaults 为空数组
    //（没有发起任何 ls-remote —— 这条路径不碰网络）。
    const enhanced = await enhanceRemoteBranches(parsed, work)
    assert.deepEqual(enhanced, { items: parsed.items, defaultRef: 'origin/main', defaults: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 7. 「安全拉取」：有未提交改动时也能拉取，且改动永远不丢 ────────────────
//
// 现场：工作区有未提交改动（尤其是未跟踪文件）时，裸 `git pull` 会被 git 拒绝
// （Your local changes would be overwritten）。stashPull 把这条路做成自动三步：
// git stash push -u → git pull（走与「拉取」按钮相同的加速/补救通道）→ 拉取成功后
// git stash pop；拉取失败则自动 pop 把改动还给用户。下面的用例在真 git 的临时
// 仓库里从头到尾跑一遍，重点断言「改动一件不少」（这也是它唯一不能退化的属性）。
//
// pullRunner 模拟 routes.js 传进来的执行通道：executeWithAcceleration 的返回形状
// （{ argv, args, result, accel, notes }），但直连、无加速参数 —— 本地裸仓库
// 不需要也没有镜像/代理。

/** 造一个「裸远端 + 已克隆工作区」的现场；onOrigin 用来推进远端。 */
async function stashPullFixture(context, onOrigin) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-stashpull-'))
  try {
    await run('git', ['init', '--bare', '-b', 'main'], { cwd: root })
  } catch {
    await rm(root, { recursive: true, force: true })
    context.skip('本机没有可用的 git')
    return null
  }
  const bare = join(root, 'origin.git')
  const src = join(root, 'src')
  const work = join(root, 'work')
  await mkdir(src, { recursive: true })
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: src })
    await run('git', ['-C', src, 'config', 'user.email', 't@t'])
    await run('git', ['-C', src, 'config', 'user.name', 't'])
    await writeFile(join(src, 'f.txt'), '本地第一版\n')
    await run('git', ['-C', src, 'add', 'f.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'A'])
    await run('git', ['clone', '-q', '--bare', src, bare])
    await run('git', ['clone', '-q', bare, work])
    await run('git', ['-C', work, 'config', 'user.email', 't@t'])
    await run('git', ['-C', work, 'config', 'user.name', 't'])
    if (onOrigin !== undefined && onOrigin !== null) {
      await onOrigin(src, bare)
    }
    return { run, root, src, bare, work }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** 直连执行器（形状与 executeWithAcceleration 的返回一致，无加速参数）。 */
function plainPullRunner(work) {
  return async (argv, timeoutMs) => {
    const { runGit } = await import('../lib/index.js')
    const result = await runGit(argv, work, { timeoutMs: timeoutMs })
    return { argv: argv.slice(), args: [], result, accel: { mode: 'direct' }, notes: [] }
  }
}

test('standalone：stashPull —— 有改动（含未跟踪）时藏起→拉取→恢复，一件不少', async (context) => {
  const { stashPull, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context, async (src, bare) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    // 远端推进一个提交 B：加一个新文件 g.txt（不动 f.txt —— 本地改动都在 f.txt 上，
    // 两边的改动互不重叠，stash pop 才能干净弹回；重叠场景由「弹回冲突」那条用例覆盖）。
    await writeFile(join(src, 'g.txt'), '远端新文件\n')
    await run('git', ['-C', src, 'add', 'g.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'B'])
    await run('git', ['-C', src, 'push', '-q', bare, 'main'])
  })
  if (fixture === null) return
  const { run, root, work } = fixture
  try {
    // 工作区制造两处改动：已跟踪文件的修改 + 一个未跟踪文件。
    await writeFile(join(work, 'f.txt'), '本地第一版\n我的本地改动\n')
    await writeFile(join(work, 'u.txt'), '还没加入版本库\n')
    const before = await runGit(['rev-parse', 'HEAD'], work, { timeoutMs: 20000 })

    const payload = await stashPull({}, work, plainPullRunner(work))

    assert.equal(payload.ok, true, '改动保留拉取应该成功：' + JSON.stringify(payload))
    const after = await runGit(['rev-parse', 'HEAD'], work, { timeoutMs: 20000 })
    assert.notEqual(after.stdout.trim(), before.stdout.trim(), 'HEAD 应该推进到远端新提交')
    assert.equal(await readFile(join(work, 'f.txt'), 'utf8'), '本地第一版\n我的本地改动\n',
      '已跟踪文件的改动要原样恢复')
    assert.equal(await readFile(join(work, 'u.txt'), 'utf8'), '还没加入版本库\n', '未跟踪文件要原样恢复')
    assert.equal(await readFile(join(work, 'g.txt'), 'utf8'), '远端新文件\n', '远端新提交的文件要拉下来')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '成功后 stash 应该清空（改动已经弹回，不留备份）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashPull —— 拉取失败时自动把改动还回工作区，stash 不留底', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stashPull, runGit } = await import('../lib/index.js')
  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-stashpull-fail-'))
  const work = join(root, 'work')
  await mkdir(work, { recursive: true })
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: work })
    await run('git', ['-C', work, 'config', 'user.email', 't@t'])
    await run('git', ['-C', work, 'config', 'user.name', 't'])
    await writeFile(join(work, 'f.txt'), 'x\n')
    await run('git', ['-C', work, 'add', 'f.txt'])
    await run('git', ['-C', work, 'commit', '-qm', 'A'])
    // 有改动，但仓库一个远程都没有 → pull 必然失败（no-remote）。
    await writeFile(join(work, 'f.txt'), '我的改动\n')
    await writeFile(join(work, 'u.txt'), '未跟踪\n')

    const payload = await stashPull({}, work, plainPullRunner(work))

    assert.equal(payload.ok, false, '没有远程时拉取必然失败')
    assert.equal(payload.reason, 'no-remote')
    assert.equal(await readFile(join(work, 'f.txt'), 'utf8'), '我的改动\n', '拉取失败后改动要弹回工作区')
    assert.equal(await readFile(join(work, 'u.txt'), 'utf8'), '未跟踪\n', '未跟踪文件也要弹回')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '失败回滚后 stash 应该清空')
    assert.ok(
      payload.notes.some((note) => note.includes('还给了工作区')),
      '失败回滚要明说改动已经还给用户：' + JSON.stringify(payload.notes),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashPull —— 工作区干净时只拉取，不多此一举制造 stash', async (context) => {
  const { stashPull, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context, async (src, bare) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    await writeFile(join(src, 'g.txt'), '新文件\n')
    await run('git', ['-C', src, 'add', 'g.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'B'])
    await run('git', ['-C', src, 'push', '-q', bare, 'main'])
  })
  if (fixture === null) return
  const { root, work } = fixture
  try {
    const payload = await stashPull({}, work, plainPullRunner(work))
    assert.equal(payload.ok, true, '干净工作区的安全拉取应该直接成功：' + JSON.stringify(payload))
    const has = await runGit(['cat-file', '-e', 'HEAD:g.txt'], work, { timeoutMs: 20000 })
    assert.equal(has.code, 0, '远端新提交 g.txt 应该被拉下来')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '干净工作区不应该产生 stash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashPull —— 弹回改动时冲突：拉取完成、stash 备份保留、提示收尾', async (context) => {
  const { stashPull, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context, async (src, bare) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    // 远端把 f.txt 的第一行改成「远端版」。
    await writeFile(join(src, 'f.txt'), '远端版\n')
    await run('git', ['-C', src, 'add', 'f.txt'])
    await run('git', ['-C', src, 'commit', '-qm', 'B'])
    await run('git', ['-C', src, 'push', '-q', bare, 'main'])
  })
  if (fixture === null) return
  const { root, work } = fixture
  try {
    // 本地把同一行的第一行改成「本地版」→ 与远端改动撞同一行。
    await writeFile(join(work, 'f.txt'), '本地版\n')
    const payload = await stashPull({}, work, plainPullRunner(work))

    assert.equal(payload.ok, false, '弹回冲突需要用户处理，不能算成功')
    assert.equal(payload.reason, 'stash-pop-conflict')
    const saved = await readFile(join(work, 'f.txt'), 'utf8')
    assert.ok(saved.includes('<<<<<<<') && saved.includes('本地版') && saved.includes('远端版'),
      '冲突现场应该在文件里（两边的改动都在）：' + saved)
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim().length > 0, true, '弹回冲突时 stash 备份必须保留（改动不能丢）')
    assert.ok(
      payload.notes.some((note) => note.includes('没有丢')),
      '冲突提示要明说改动没有丢：' + JSON.stringify(payload.notes),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 「安全切分支」（stashSwitch）：脏工作区也能切分支 ──────────────────────
//
// 与 stashPull 对称：git 的裸 switch 在脏工作区上会被拒绝（Your local changes
// would be overwritten），这里做成 stash push -u → switch → stash pop。
// 唯一不能退化的属性同样是「改动一件不少」。

test('standalone：stashSwitch —— 有改动时藏起→切换→恢复，一件不少', async (context) => {
  const { stashSwitch, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { run, root, work } = fixture
  try {
    // 先造一条要切换过去的分支（内容与 main 不同，便于确认真的切过去了）。
    await run('git', ['-C', work, 'switch', '-q', '-c', 'feature'])
    await writeFile(join(work, 'feature.txt'), 'feature 分支的内容\n')
    await run('git', ['-C', work, 'add', 'feature.txt'])
    await run('git', ['-C', work, 'commit', '-qm', 'F'])
    await run('git', ['-C', work, 'switch', '-q', 'main'])

    // main 上留两处改动：已跟踪文件 + 未跟踪文件。
    await writeFile(join(work, 'f.txt'), '本地第一版\n我的本地改动\n')
    await writeFile(join(work, 'u.txt'), '还没加入版本库\n')

    const payload = await stashSwitch({ branch: 'feature' }, work)

    assert.equal(payload.ok, true, '有改动的安全切分支应该成功：' + JSON.stringify(payload))
    const head = await runGit(['branch', '--show-current'], work, { timeoutMs: 20000 })
    assert.equal(head.stdout.trim(), 'feature', '应该真的切到 feature 分支上了')
    assert.equal(await readFile(join(work, 'f.txt'), 'utf8'), '本地第一版\n我的本地改动\n',
      '已跟踪文件的改动要原样恢复')
    assert.equal(await readFile(join(work, 'u.txt'), 'utf8'), '还没加入版本库\n', '未跟踪文件要原样恢复')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '成功后 stash 应该清空（改动已经弹回，不留备份）')
    assert.ok(payload.notes.some((note) => note.includes('已切换到 feature')),
      '结果栏要说清切到了哪里：' + JSON.stringify(payload.notes))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashSwitch —— 目标分支不存在时把改动还回工作区，不留底', async (context) => {
  const { stashSwitch, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { root, work } = fixture
  try {
    await writeFile(join(work, 'f.txt'), '本地第一版\n我的本地改动\n')
    await writeFile(join(work, 'u.txt'), '还没加入版本库\n')

    const payload = await stashSwitch({ branch: '不存在的分支' }, work)

    assert.equal(payload.ok, false, '分支不存在时必须失败')
    const head = await runGit(['branch', '--show-current'], work, { timeoutMs: 20000 })
    assert.equal(head.stdout.trim(), 'main', '切换失败时不能把用户带到别的分支上')
    assert.equal(await readFile(join(work, 'f.txt'), 'utf8'), '本地第一版\n我的本地改动\n',
      '切换失败要把改动原样还回工作区')
    assert.equal(await readFile(join(work, 'u.txt'), 'utf8'), '还没加入版本库\n', '未跟踪文件也要还回来')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '改动已经弹回，不该在 stash 里留备份')
    assert.ok(payload.notes.some((note) => note.includes('还给了工作区')),
      '结果栏要说明改动已经回来了：' + JSON.stringify(payload.notes))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashSwitch —— 工作区干净时就是一条普通 switch，不制造 stash', async (context) => {
  const { stashSwitch, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { run, root, work } = fixture
  try {
    await run('git', ['-C', work, 'switch', '-q', '-c', 'feature'])
    await run('git', ['-C', work, 'switch', '-q', 'main'])

    const payload = await stashSwitch({ branch: 'feature' }, work)
    assert.equal(payload.ok, true, '干净工作区应该直接切成功：' + JSON.stringify(payload))
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '干净工作区不应该产生 stash')
    const head = await runGit(['branch', '--show-current'], work, { timeoutMs: 20000 })
    assert.equal(head.stdout.trim(), 'feature')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── stashSwitch 的提交号模式：「切到此提交」（git switch --detach） ─────────
//
// 面板「最近提交」行的「切到此」走的就是这里。要钉住两件事：
//   · 脏工作区同样走 stash 流程，改动一件不少；
//   · 成功提示必须说明「游离 HEAD」与回去的路 —— 这是用户最慌的一步。

test('standalone：stashSwitch —— commit 模式（脏工作区）切到历史提交，改动原样恢复', async (context) => {
  const { stashSwitch, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { run, root, work } = fixture
  try {
    // 造一个「历史提交」：main 上再提交一次（**只新增文件**，不动 f.txt ——
    // 否则 stash 弹回到旧提交时 f.txt 必然冲突，那是 git 的真实行为，不该在这里考），
    // 然后拿第一次提交的短哈希当目标。
    const first = await runGit(['rev-parse', 'HEAD'], work, { timeoutMs: 20000 })
    await writeFile(join(work, 'g.txt'), '第二次提交新增的文件\n')
    await run('git', ['-C', work, 'add', 'g.txt'])
    await run('git', ['-C', work, 'commit', '-qm', 'B'])

    // 工作区留两处改动：已跟踪文件 + 未跟踪文件。
    await writeFile(join(work, 'f.txt'), '本地第一版\n我的本地改动\n')
    await writeFile(join(work, 'u.txt'), '还没加入版本库\n')

    const target = first.stdout.trim().slice(0, 7)
    const payload = await stashSwitch({ commit: target }, work)

    assert.equal(payload.ok, true, '切到历史提交应该成功：' + JSON.stringify(payload))
    const head = await runGit(['rev-parse', '--short', 'HEAD'], work, { timeoutMs: 20000 })
    assert.equal(head.stdout.trim(), target, 'HEAD 应该真的停在目标提交上')
    const branch = await runGit(['branch', '--show-current'], work, { timeoutMs: 20000 })
    assert.equal(branch.stdout.trim(), '', '游离 HEAD 下不该有当前分支')
    assert.equal(await readFile(join(work, 'f.txt'), 'utf8'), '本地第一版\n我的本地改动\n',
      '已跟踪文件的改动要原样恢复')
    assert.equal(await readFile(join(work, 'u.txt'), 'utf8'), '还没加入版本库\n', '未跟踪文件要原样恢复')
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '成功后 stash 应该清空（改动已经弹回，不留备份）')
    assert.ok(payload.notes.some((note) => note.includes('游离 HEAD')),
      '成功提示要说明游离 HEAD 与回去的路：' + JSON.stringify(payload.notes))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashSwitch —— commit 模式（干净工作区）就是一条裸 switch --detach，不制造 stash', async (context) => {
  const { stashSwitch, runGit } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { run, root, work } = fixture
  try {
    const first = await runGit(['rev-parse', 'HEAD'], work, { timeoutMs: 20000 })
    await writeFile(join(work, 'f.txt'), '第二次提交的内容\n')
    await run('git', ['-C', work, 'add', 'f.txt'])
    await run('git', ['-C', work, 'commit', '-qm', 'B'])

    const target = first.stdout.trim().slice(0, 7)
    const payload = await stashSwitch({ commit: target }, work)
    assert.equal(payload.ok, true, '干净工作区应该直接切成功：' + JSON.stringify(payload))
    // --end-of-options 哨兵是提交号模式的一部分：它让提交号永远不可能被解析成选项。
    assert.equal(payload.command, 'git switch --detach --end-of-options ' + target, '命令要如实回显')
    const head = await runGit(['rev-parse', '--short', 'HEAD'], work, { timeoutMs: 20000 })
    assert.equal(head.stdout.trim(), target)
    const stash = await runGit(['stash', 'list'], work, { timeoutMs: 20000 })
    assert.equal(stash.stdout.trim(), '', '干净工作区不应该产生 stash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone：stashSwitch —— 提交号不合法时拒绝执行，工作区一点不动', async (context) => {
  const { stashSwitch } = await import('../lib/index.js')
  const fixture = await stashPullFixture(context)
  if (fixture === null) return
  const { root, work } = fixture
  try {
    for (const bad of ['--amend', 'main..other', '../../etc', ' HEAD~1']) {
      const payload = await stashSwitch({ commit: bad }, work)
      assert.equal(payload.ok, false, '不合法的提交号必须被拦下：' + bad)
      assert.ok(String(payload.message).includes('不合法'), '要说明提交号不合法：' + String(payload.message))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 新增操作走一遍真实的 op 流水线（含 field/parse 接线） ──────────────────
//
// 上面那些是逐段验证；这里把 routes.js 的 runPanelOp 真跑一遍：argv 构造 → 执行
// → 结果解析 → 响应字段。数据型操作的价值全在「解析出来的字段」上，只断言 argv
// 是发现不了「解析函数没挂上、面板永远读不到 show/stash」这类问题的。

test('standalone：show / stashList / 单文件暂存与还原在真 git 里跑通', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-ops-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])

    // 1) show：点最近提交那一行的详情。
    const show = await runPanelOp('show', { ref: 'HEAD' }, root)
    assert.equal(show.payload.ok, true, 'git show 应该成功：' + JSON.stringify(show.payload.message))
    assert.ok(typeof show.payload.show === 'string' && show.payload.show.length > 0, 'show 字段要有内容')
    assert.ok(show.payload.show.includes('第一次提交'), '详情里应包含提交信息：' + show.payload.show.slice(0, 120))
    assert.ok(show.payload.show.includes('f.txt'), '--stat 要列出改动的文件')

    // 2) 单文件暂存 / 取消暂存：要真的改变暂存区。
    await writeFile(join(root, 'f.txt'), '第一版\n第二行\n')
    const staged = await runPanelOp('add', { path: 'f.txt' }, root)
    assert.equal(staged.payload.ok, true, '单文件暂存应该成功')
    const porcelainAfterAdd = await run('git', ['-C', root, 'status', '--porcelain'])
    assert.ok(porcelainAfterAdd.stdout.startsWith('M '), '暂存后应显示为已暂存：' + porcelainAfterAdd.stdout)

    const unstaged = await runPanelOp('unstageFile', { path: 'f.txt' }, root)
    assert.equal(unstaged.payload.ok, true, '取消暂存应该成功')
    const porcelainAfterUnstage = await run('git', ['-C', root, 'status', '--porcelain'])
    // 注意不能 trim：porcelain 的「未暂存」正是开头那个空格（XY 两列里的 X）。
    assert.ok(porcelainAfterUnstage.stdout.startsWith(' M'), '取消暂存后应回到未暂存：' + porcelainAfterUnstage.stdout)

    // 3) stashList：stash 的编号必须被解析出来（面板要靠它恢复/删除）。
    await run('git', ['-C', root, 'stash', 'push', '-u', '-m', '测试备份'])
    const list = await runPanelOp('stashList', {}, root)
    assert.equal(list.payload.ok, true)
    assert.equal(Array.isArray(list.payload.stash), true, 'stash 字段应是数组')
    assert.equal(list.payload.stash.length, 1)
    assert.equal(list.payload.stash[0].ref, 'stash@{0}', '编号必须原样解析（它是要交给 git 的参数）')
    assert.ok(list.payload.stash[0].text.includes('测试备份'), '说明文字要带出来：' + list.payload.stash[0].text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 「本地名 ≠ 上游名」与「未合并删不掉」：对着**真 git** 走一遍 op 流水线 ────
//
// 这两条都是本次真实踩到的现场：点「推送」只回一句
// `fatal: The upstream branch of your current branch does not match …`，
// 点「删除」只回一句 `error: the branch 'main' is not fully merged`。
// 面板的价值全在「换成中文 + 给出几个能点的按钮」上 —— 而那取决于
// 「reason 认对了没有、choices 拼出来了没有」，只能对着真 git 验证。

test('standalone：本地名与上游名不一致时，push 失败要给出三条可点的路', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-mismatch-'))
  // 远端用一个**本地裸仓库**：这条用例不该依赖网络，也不该因为连不上而换一种失败。
  const bare = await mkdtemp(join(tmpdir(), 'git-sidebar-bare-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'origin-main'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['init', '-q', '--bare', join(bare, 'demo.git')])
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])

    // 造出现场：本地分支 origin-main、跟踪 origin/main —— 默认配置 push.default=simple
    // 只在两边同名时才肯裸推，所以这一下必然被 git 拒绝。
    await run('git', ['-C', root, 'remote', 'add', 'origin', join(bare, 'demo.git')])
    await run('git', ['-C', root, 'config', 'branch.origin-main.remote', 'origin'])
    await run('git', ['-C', root, 'config', 'branch.origin-main.merge', 'refs/heads/main'])

    const pushed = await runPanelOp('push', {}, root)
    assert.equal(pushed.payload.ok, false, '名称不一致时裸 push 必须被 git 拒绝（否则用例前提不成立）')
    assert.equal(
      pushed.payload.reason,
      'upstream-name-mismatch',
      'reason 要认成「名称不一致」，而不是笼统的 rejected：' + JSON.stringify(pushed.payload.reason),
    )
    assert.match(String(pushed.payload.stderr), /does not match/i, 'stderr 要原样保留（排查用）')
    assert.match(String(pushed.payload.hint), /同名|一致/, 'hint 要是中文解释：' + pushed.payload.hint)

    const choices = pushed.payload.choices
    assert.ok(Array.isArray(choices) && choices.length === 3, '要给出三条可点的路：' + JSON.stringify(choices))
    assert.deepEqual(
      choices.map((item) => item.op).sort(),
      ['pushSameName', 'pushUpstream', 'renameBranch'],
    )
    const upstream = choices.find((item) => item.op === 'pushUpstream')
    assert.deepEqual(
      upstream.params,
      { remote: 'origin', branch: 'main' },
      '推到上游那条必须显式带上远程与远端分支名（不能猜）',
    )

    // 走一遍第一条路：显式 refspec 推到上游那个分支，本地名一点不动。
    const done = await runPanelOp('pushUpstream', { remote: 'origin', branch: 'main' }, root)
    assert.equal(done.payload.ok, true, '推到上游应该成功：' + JSON.stringify(done.payload.message))
    const branch = await run('git', ['-C', root, 'branch', '--show-current'])
    assert.equal(branch.stdout.trim(), 'origin-main', '本地分支名不该被改')
    const remoteHeads = await run('git', ['-C', join(bare, 'demo.git'), 'branch', '--list'])
    assert.match(remoteHeads.stdout, /main/, '远端应该收到 main 这个分支')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})

test('standalone：未合并的分支删不掉时给中文解释 + 强制删除；建分支撞远端名被宿主拒绝', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-delete-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    // 一条「有未合并提交」的分支：在上面提交后切回来，它就成了 -d 删不掉的那种。
    await run('git', ['-C', root, 'switch', '-qc', 'feature'])
    await writeFile(join(root, 'g.txt'), '只有这条分支有\n')
    await run('git', ['-C', root, 'add', 'g.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '只有 feature 有'])
    await run('git', ['-C', root, 'switch', '-q', 'main'])

    const refused = await runPanelOp('deleteBranch', { branch: 'feature' }, root)
    assert.equal(refused.payload.ok, false, '未合并的分支安全删除必须被拒绝')
    assert.equal(refused.payload.reason, 'unmerged', '要认成「未完全合并」：' + refused.payload.reason)
    assert.match(String(refused.payload.hint), /保护|防误删/, 'hint 要说清这是 git 的保护：' + refused.payload.hint)
    assert.equal(refused.payload.choices.length, 1)
    assert.equal(refused.payload.choices[0].op, 'deleteBranchForce')
    assert.match(refused.payload.choices[0].confirm, /不可逆/)

    // 点了「强制删除」之后真的删掉了（这条路的终点必须真的通）。
    const forced = await runPanelOp('deleteBranchForce', { branch: 'feature' }, root)
    assert.equal(forced.payload.ok, true, '强制删除应该成功：' + JSON.stringify(forced.payload.message))
    const left = await run('git', ['-C', root, 'branch', '--no-color'])
    assert.doesNotMatch(left.stdout, /feature/, '分支应该已经不在了：' + left.stdout)

    // 建分支撞远端名：宿主也要拒（面板那一层只是提前说，不能是唯一的防线）。
    await run('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/demo.git'])
    const guard = await runPanelOp('createBranch', { branch: 'origin/main' }, root)
    assert.equal(guard.payload.ok, false, 'origin/main 这种名字要被宿主拒绝')
    assert.match(String(guard.payload.message), /远端名/, '拒绝理由要说清是撞了远端名：' + guard.payload.message)
    const fine = await runPanelOp('createBranch', { branch: 'feat/x' }, root)
    assert.equal(fine.payload.ok, true, '正常的带斜杠分支名不该被误伤：' + JSON.stringify(fine.payload.message))

    // AI 工具那条路走**同一个** assertSafeNewBranch：两半不可能分叉。
    const { TOOL_SPECS } = await import('../lib/tools.js')
    const branchTool = TOOL_SPECS.find((spec) => spec.name === 'git_branch')
    await assert.rejects(
      () => branchTool.toArgv({ name: 'origin/main' }, { dir: root }),
      /远端名/,
      'git_branch 建同名分支要被拒',
    )
    assert.deepEqual(
      await branchTool.toArgv({ name: 'feat/x' }, { dir: root }),
      ['branch', 'feat/x'],
      '正常名字照常放行',
    )
    assert.deepEqual(
      await branchTool.toArgv({ name: 'origin/main', delete: true, force: true }, { dir: root }),
      ['branch', '-D', 'origin/main'],
      '删除不算新建：清理这种名字反而应该放行',
    )
    const checkoutTool = TOOL_SPECS.find((spec) => spec.name === 'git_checkout')
    await assert.rejects(
      () => checkoutTool.toArgv({ branch: 'origin/main', create: true }, { dir: root }),
      /远端名/,
      'git_checkout --create 是建分支的另一种写法，同样要拦',
    )

    // 两个远程指向同一地址：状态里能看出来（宿主判定），并且能一键删掉多余的。
    await run('git', ['-C', root, 'remote', 'add', 'dup', 'https://example.invalid/demo.git'])
    const { readState } = await import('../lib/index.js')
    assert.deepEqual(
      (await readState(root)).duplicateRemotes,
      [{ url: 'https://example.invalid/demo.git', keep: 'origin', remove: ['dup'] }],
      '同地址的远程要成组，保留 origin',
    )
    const removed = await runPanelOp('removeRemote', { name: 'dup' }, root)
    assert.equal(removed.payload.ok, true, '删远程应该成功：' + JSON.stringify(removed.payload.message))
    assert.deepEqual((await readState(root)).duplicateRemotes, [], '删完就不该再报重复')
    const listed = await run('git', ['-C', root, 'remote'])
    assert.doesNotMatch(listed.stdout, /dup/, '远程配置里也不该再有它：' + listed.stdout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 推到指定的那个远程（本次需求，对着真 git 走完整条流水线） ────────────────
//
// 现场：origin = 别人的仓库（只能读）、fork = 自己的。面板此前只会裸 `git push`，
// 于是「我想推 fork」既表达不出来、补救逻辑还会替用户重推到 origin。
// 这两条用例不联网：远端都是本地裸仓库（权限拒绝那条用一个 pre-receive 钩子复刻
// GitHub 的原话），但在 git 眼里与真远端完全一样。

test('standalone：推到用户选的那个远程 —— 落在 fork，origin 一个提交都不多', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-push-fork-'))
  const upstream = await mkdtemp(join(tmpdir(), 'git-sidebar-upstream-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-mine-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'feature/x'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      await rm(upstream, { recursive: true, force: true })
      await rm(mine, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    const originBare = join(upstream, 'demo.git')
    const forkBare = join(mine, 'demo.git')
    await run('git', ['init', '-q', '--bare', originBare])
    await run('git', ['init', '-q', '--bare', forkBare])
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    await run('git', ['-C', root, 'remote', 'add', 'origin', originBare])
    await run('git', ['-C', root, 'remote', 'add', 'fork', forkBare])
    // 前提：当前分支**没有上游** —— 这正是「新分支第一次推」的现场，也是
    // 补救逻辑原先会替你选 origin 的那种情况。
    const { readState } = await import('../lib/index.js')
    assert.equal((await readState(root)).upstream, null, '前置条件：当前分支没有上游')

    const pushed = await runPanelOp('push', { remote: 'fork' }, root)
    assert.equal(pushed.payload.ok, true, '推到 fork 应该成功：' + JSON.stringify(pushed.payload.message))
    assert.equal(pushed.payload.command, 'git push fork HEAD', '命令要显式带远程与 refspec')
    assert.equal(pushed.payload.retried, false, '选了远程时不该再触发「替你挑远程」的补救')
    assert.ok(
      Array.isArray(pushed.payload.notes) && pushed.payload.notes.some((note) => note.includes('fork')),
      '结果里要说清这次推到了 fork：' + JSON.stringify(pushed.payload.notes),
    )

    // 该到的地方到了：fork 上有 feature/x 与那次提交。
    const forkHeads = await run('git', ['-C', forkBare, 'branch', '--no-color'])
    assert.match(forkHeads.stdout, /feature\/x/, 'fork 上应出现这个分支：' + forkHeads.stdout)
    // 不该到的地方一个都没到：origin 上没有这个分支（旧实现会推到这里）。
    const originHeads = await run('git', ['-C', originBare, 'branch', '--no-color'])
    assert.doesNotMatch(originHeads.stdout, /feature\/x/, 'origin 上不该有这个分支：' + originHeads.stdout)
    // 用户的 git 配置一个字节都不该动：没配上游、push.default 还是默认。
    assert.equal((await readState(root)).upstream, null, '推一次不该悄悄改上游配置')

    // 裸推（跟随上游）仍是老行为：没有上游时补救会替你挑一个远程（这里 origin 排在后
    // 但 fork 在前，parseRemotes 按名字排序取 origin），并**在说明里讲清推到了哪**。
    const bare = await runPanelOp('push', {}, root)
    assert.equal(bare.payload.ok, true, '裸推应通过补救走通：' + JSON.stringify(bare.payload.message))
    assert.equal(bare.payload.retried, true, '裸推在没有上游时应触发补救重试')
    assert.match(String(bare.payload.notes.join('\n')), /origin/, '补救替你选的远程必须说出来')

    // 远程名是直接交给 git 的参数：以 - 开头的形状必须在宿主层被拒（面板与工具同一条路）。
    const bad = await runPanelOp('push', { remote: '-x' }, root)
    assert.equal(bad.payload.ok, false)
    assert.match(String(bad.payload.message), /远程名或地址不合法/, '拒绝理由要说清：' + bad.payload.message)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(upstream, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
  }
})

test('standalone：服务器说「没有写权限」时给出「推送到别的远程」按钮（真 git + 拒绝的钩子）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-denied-'))
  const readOnly = await mkdtemp(join(tmpdir(), 'git-sidebar-readonly-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-mine2-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'local.2'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      await rm(readOnly, { recursive: true, force: true })
      await rm(mine, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    const originBare = join(readOnly, 'demo.git')
    const forkBare = join(mine, 'demo.git')
    await run('git', ['init', '-q', '--bare', originBare])
    await run('git', ['init', '-q', '--bare', forkBare])
    // 用一个 pre-receive 钩子复刻 GitHub 的原话（本机没有网络，但这句 stderr 的形状
    // 与真 GitHub 一致 —— 分类与提示盯的就是它）。git 会自己加上 "remote: " 前缀。
    await writeFile(join(originBare, 'hooks', 'pre-receive'),
      '#!/bin/sh\n'
      + 'echo "Permission to MichengAI/demo.git denied to wangyuncai2024." >&2\n'
      + 'exit 1\n')
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    await run('git', ['-C', root, 'remote', 'add', 'origin', originBare])
    await run('git', ['-C', root, 'remote', 'add', 'fork', forkBare])

    const denied = await runPanelOp('push', { remote: 'origin' }, root)
    assert.equal(denied.payload.ok, false, '被远端拒绝时不能报成功')
    assert.equal(
      denied.payload.reason,
      'no-permission',
      '要认成「没有写权限」，而不是笼统的 rejected / none：' + JSON.stringify(denied.payload.reason),
    )
    assert.match(String(denied.payload.hint), /写权限/, 'hint 要是中文解释：' + denied.payload.hint)
    const choices = denied.payload.choices
    assert.ok(Array.isArray(choices) && choices.length === 1, '要给出「换个远程推」那条路：' + JSON.stringify(choices))
    assert.equal(choices[0].op, 'push')
    assert.deepEqual(choices[0].params, { remote: 'fork' }, '候选里不能有刚失败的那个远程')
    assert.equal(choices[0].confirm, null, '推一次不需要二次确认')

    // 走一遍这条路：真的能推成功（面板上一个按钮就够，用户不必敲命令）。
    const done = await runPanelOp(choices[0].op, choices[0].params, root)
    assert.equal(done.payload.ok, true, '改推 fork 应该成功：' + JSON.stringify(done.payload.message))
    const forkHeads = await run('git', ['-C', forkBare, 'branch', '--no-color'])
    assert.match(forkHeads.stdout, /local\.2/, 'fork 上应收到这个分支：' + forkHeads.stdout)

    // 只有那一个远程（没有别的可试）时不给按钮：此时提示负责把用户引去「添加远程」，
    // 面板会直接打开那个表单（见 client 侧用例）。
    await run('git', ['-C', root, 'remote', 'remove', 'fork'])
    const lonely = await runPanelOp('push', { remote: 'origin' }, root)
    assert.equal(lonely.payload.reason, 'no-permission')
    assert.equal(lonely.payload.choices, null, '没有别的远程时不该硬凑一条路')

    // 裸推那条路（面板默认的「跟随上游」）走的是**上游**那个远程：失败后必须把它从
    // 候选里认出来排掉，否则面板会给出「推送到 origin」这个刚证明推不进去的按钮。
    await run('git', ['-C', root, 'remote', 'add', 'fork', forkBare])
    await run('git', ['-C', root, 'config', 'branch.local.2.remote', 'origin'])
    await run('git', ['-C', root, 'config', 'branch.local.2.merge', 'refs/heads/local.2'])
    const bare = await runPanelOp('push', {}, root)
    assert.equal(bare.payload.reason, 'no-permission', '裸推撞上同一个钩子：' + JSON.stringify(bare.payload.reason))
    assert.equal(bare.payload.command, 'git push', '裸推就是裸 push（命中上游）')
    const bareChoices = bare.payload.choices
    assert.ok(Array.isArray(bareChoices) && bareChoices.length === 1, '应只给 fork：' + JSON.stringify(bareChoices))
    assert.deepEqual(bareChoices[0].params, { remote: 'fork' }, '刚失败的 origin 不能再当候选')

    // **本次现场那条完整的路**：新分支没有上游 → 裸推被 git 拒 → 面板自动补 -u 重推
    // → 服务器说没有写权限。重试这一下的终点也必须带现场，否则面板只剩一句提示、
    // 一个能点的按钮都没有（用户就是卡在这里）。
    await run('git', ['-C', root, 'config', '--unset', 'branch.local.2.remote'])
    await run('git', ['-C', root, 'config', '--unset', 'branch.local.2.merge'])
    const retried = await runPanelOp('push', {}, root)
    assert.equal(retried.payload.ok, false)
    assert.equal(retried.payload.retried, true, '缺上游时应先自动补 -u 重推一次')
    assert.equal(
      retried.payload.reason,
      'no-permission',
      '重试这次的失败原因也要认对：' + JSON.stringify(retried.payload.reason),
    )
    assert.match(String(retried.payload.command), /--set-upstream origin HEAD/, '回执要如实写出补救后的命令')
    const retriedChoices = retried.payload.choices
    assert.ok(
      Array.isArray(retriedChoices) && retriedChoices.length === 1 && retriedChoices[0].params.remote === 'fork',
      '补救重试失败后仍要给出「推送到 fork」这一条：' + JSON.stringify(retriedChoices),
    )

    // 两个远程指向**同一个地址**时，换名字推过去是同一堵墙：候选必须把同地址的也排掉，
    // 否则面板会给出一个「推送到 main」的按钮，点一下再给回「推送到 origin」——
    // 两个名字、一个地址，永远推不进去（本插件专门为「同地址远程」给过警告）。
    // 先只留「origin + 同地址的 dup」：一个候选都不该有。
    await run('git', ['-C', root, 'remote', 'remove', 'fork'])
    await run('git', ['-C', root, 'remote', 'add', 'dup', originBare])
    const dupOnly = await runPanelOp('push', { remote: 'origin' }, root)
    assert.equal(dupOnly.payload.reason, 'no-permission')
    assert.equal(
      dupOnly.payload.choices,
      null,
      '同地址的另一个远程不算出路，实际：' + JSON.stringify(dupOnly.payload.choices),
    )
    // 再把 fork（**不同地址**）加回来：候选只能有 fork，同地址的 dup 仍要被排掉。
    await run('git', ['-C', root, 'remote', 'add', 'fork', forkBare])
    const dupMixed = await runPanelOp('push', { remote: 'origin' }, root)
    assert.deepEqual(
      (dupMixed.payload.choices ?? []).map((item) => item.params.remote),
      ['fork'],
      '同地址的 dup 不能当候选，不同地址的 fork 才是出路：' + JSON.stringify(dupMixed.payload.choices),
    )
    await run('git', ['-C', root, 'remote', 'remove', 'dup'])

    // 远程位置参数可以是一个**本地路径**（git 的合法目标，也是本次放宽校验的原因）：
    // 直接用路径推一次必须成功，不能被「远程名不合法」拦下。
    const byPath = await runPanelOp('push', { remote: forkBare }, root)
    assert.equal(byPath.payload.ok, true, '路径形式的远程应该能用：' + JSON.stringify(byPath.payload.message))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(readOnly, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
  }
})

test('standalone：分支受保护不是「你没有写权限」—— 诊断要分开，出路照给', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-protected-'))
  const upstream = await mkdtemp(join(tmpdir(), 'git-sidebar-protected-up-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-protected-me-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      await rm(upstream, { recursive: true, force: true })
      await rm(mine, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    const originBare = join(upstream, 'demo.git')
    const forkBare = join(mine, 'demo.git')
    await run('git', ['init', '-q', '--bare', originBare])
    await run('git', ['init', '-q', '--bare', forkBare])
    // 复刻 GitHub 受保护分支的原话：账号**有**写权限，只是这条引用不许直接更新。
    await writeFile(join(originBare, 'hooks', 'pre-receive'),
      '#!/bin/sh\n'
      + 'echo "error: GH006: Protected branch update failed for refs/heads/main." >&2\n'
      + 'echo "error: Changes must be made through a pull request." >&2\n'
      + 'exit 1\n')
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    await run('git', ['-C', root, 'remote', 'add', 'origin', originBare])
    await run('git', ['-C', root, 'remote', 'add', 'fork', forkBare])

    const denied = await runPanelOp('push', { remote: 'origin' }, root)
    assert.equal(denied.payload.ok, false)
    assert.equal(
      denied.payload.reason,
      'branch-protected',
      '受保护分支要单独成一类，不能报成「没有写权限」：' + JSON.stringify(denied.payload.reason),
    )
    const hint = String(denied.payload.hint)
    assert.match(hint, /保护/)
    assert.doesNotMatch(hint, /没有写权限/, '账号是有写权限的，这个诊断会把人引错：' + hint)
    // 出路照给：推到你自己的远程（然后开 PR）—— 这是受保护分支的标准流程。
    const choices = denied.payload.choices
    assert.ok(Array.isArray(choices) && choices.length === 1, '要给「推送到 fork」：' + JSON.stringify(choices))
    assert.deepEqual(choices[0].params, { remote: 'fork' })
    assert.doesNotMatch(String(choices[0].detail), /没有写权限|不在你的账号上/, '按钮文案不能替宿主下错诊断')
    const done = await runPanelOp(choices[0].op, choices[0].params, root)
    assert.equal(done.payload.ok, true, '推 fork 应该成功（就能去开 PR 了）：' + JSON.stringify(done.payload.message))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(upstream, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
  }
})

// ── 「这条远端分支我已经有了」：宿主侧的兜底 ────────────────────────────────
//
// 现场（dsh-skills-manager）：本地 `fork-local.2` 已经在跟踪 `fork/local.2`。
// 远端那一行原先只有一个通用的「拿成新分支」，点下去宿主按 `fork/local.2` 自动命名
// `fork-local.2`、发现被占用就**静默顺延**成 `fork-local.2-2` —— 一条名字相近、
// 内容相同的重复分支。面板侧现在不给这个按钮了（交叉引用），宿主侧必须同样拦住：
// 旧版界面、模型工具、以及任何绕过界面的调用都走这条兜底。

test('standalone：远端分支已有本地分支跟踪时，adoptRemote 不再静默造出 -2', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-adopt-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '第一版\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    await run('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/demo.git'])
    // 造出现场（不碰网络）：远端引用已经在本地，并且**已经有一条本地分支在跟踪它**。
    const head = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    await run('git', ['-C', root, 'update-ref', 'refs/remotes/origin/feature', head])
    // 本地分支名刻意等于**自动命名会得到的那个**（origin-feature）——原先正是这种
    // 情况下会静默顺延出 origin-feature-2。
    await run('git', ['-C', root, 'branch', '--track', 'origin-feature', 'origin/feature'])

    const refused = await runPanelOp('adoptRemote', { mode: 'branch', remote: 'origin', branch: 'feature' }, root)
    assert.equal(refused.payload.ok, false, '已经有本地分支在跟踪时不能再建一个')
    assert.equal(refused.payload.reason, 'already-tracked', 'reason 要说清是「已经有本地分支在跟踪」')
    assert.equal(refused.payload.alreadyTrackedBy, 'origin-feature', '要回传是哪条本地分支')
    assert.match(String(refused.payload.message), /origin-feature/, '消息里要指名道姓：' + refused.payload.message)
    assert.match(String(refused.payload.message), /切过去/, '要给出下一步（切过去），而不是只说「不行」')

    const branches = (await run('git', ['-C', root, 'branch', '--no-color'])).stdout
    assert.doesNotMatch(branches, /origin-feature-2/, '绝不能静默顺延出那条重复分支：' + branches)
    assert.equal(
      branches.split('\n').filter((line) => line.trim().length > 0).length,
      2,
      '分支数量不该变：' + branches,
    )
    const upstream = (await run('git', ['-C', root, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/origin-feature'])).stdout
    assert.equal(upstream.trim(), 'origin/feature', '原来那条跟踪关系不能被改动')

    // 调用方**显式点名**时照旧执行：那是明确意图（例如就想另开一份看代码），
    // 不属于「顺手多点一下多出一条重复分支」。
    const explicit = await runPanelOp(
      'adoptRemote',
      { mode: 'branch', remote: 'origin', branch: 'feature', name: 'feature-copy' },
      root,
    )
    assert.equal(explicit.payload.ok, true, '显式给名字时应该照做：' + JSON.stringify(explicit.payload.message))
    const after = (await run('git', ['-C', root, 'branch', '--no-color'])).stdout
    assert.match(after, /feature-copy/, '显式命名的分支要真的建出来：' + after)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 分支改名：真 git 端到端 ──────────────────────────────────────────────────
//
// 现场：桌面版（Electron 外壳）里点「⋯ → 改名」什么都不会发生 —— 它此前借
// `window.prompt()` 拿名字，而 Electron 不支持 prompt。客户端那一半的修法是换成面板
// 自己的输入框（见 test/client.test.mjs 的那三条）；这一条盯**宿主那一半**：命令必须
// 真的改掉「点中的那一条」（`git branch -m <旧> <新>`），而不是「谁在那儿谁挨改」，
// 并且成功/撞名/分支不存在三种收场各给出对得上事实的说明。

test('standalone：改名真的改掉点中的那条分支（含非当前分支），撞名与不存在各给中文下一步', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-rename-'))
  try {
    try {
      await run('git', ['init', '-q', '-b', 'master'], { cwd: root })
    } catch {
      await rm(root, { recursive: true, force: true })
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'f.txt'), '内容\n')
    await run('git', ['-C', root, 'add', 'f.txt'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    // 另一条分支：当前分支**不是**它 —— from 存在的全部理由就是「改它，而不是改当前分支」。
    await run('git', ['-C', root, 'branch', 'side'])

    // ① 点中的是非当前分支：改的是它，当前分支与工作区一点没动。
    const renamed = await runPanelOp('renameBranch', { name: 'sidecar', from: 'side' }, root)
    assert.equal(renamed.payload.ok, true, '改名应该成功：' + JSON.stringify(renamed.payload.message))
    const notes = (renamed.payload.notes ?? []).map(String).join(' ')
    assert.match(notes, /side/, '结果说明要写清改的是哪条（git 成功时一个字都不打印）：' + notes)
    assert.match(notes, /sidecar/, '结果说明要写清新名字：' + notes)
    const listed = (await run('git', ['-C', root, 'branch', '--no-color'])).stdout
    assert.match(listed, /sidecar/, '新名字要真的出现：' + listed)
    assert.doesNotMatch(listed, /^\s*side\s*$/m, '旧名字要真的消失：' + listed)
    assert.equal(
      (await run('git', ['-C', root, 'branch', '--show-current'])).stdout.trim(),
      'master',
      '改名不该把当前分支换掉：' + listed,
    )

    // ② 不给 from：老形状照旧（改当前分支）—— 模型工具与老客户端走的就是这条。
    const currentRename = await runPanelOp('renameBranch', { name: 'trunk' }, root)
    assert.equal(currentRename.payload.ok, true, '不带 from 时照旧改当前分支：' + JSON.stringify(currentRename.payload.message))
    assert.equal(
      (await run('git', ['-C', root, 'branch', '--show-current'])).stdout.trim(),
      'trunk',
      '不带 from 时改的必须是当前分支',
    )
    assert.ok(
      !(currentRename.payload.notes ?? []).map(String).some((note) => note.includes('已把分支')),
      '没给 from 时宿主并不知道改的是哪一条，不能编造说明：' + JSON.stringify(currentRename.payload.notes),
    )

    // ③ 撞名：git 拒，且要归成 exists + 指向「不用改名」的那条路。
    const clash = await runPanelOp('renameBranch', { name: 'sidecar', from: 'trunk' }, root)
    assert.equal(clash.payload.ok, false, '撞名必须被 git 拒绝')
    assert.equal(clash.payload.reason, 'exists', '要归成 exists：' + clash.payload.reason)
    assert.match(String(clash.payload.hint), /同名的分支/, 'hint 要说清是撞名：' + clash.payload.hint)

    // ④ 要改的分支不存在：git 2.55 说的是 `fatal: no branch named 'x'`（不是 not found），
    //    这句漏认就会变成「未知故障 + 一行英文」。
    const gone = await runPanelOp('renameBranch', { name: 'whatever', from: 'no-such-branch' }, root)
    assert.equal(gone.payload.ok, false, '不存在的分支改不了')
    assert.equal(gone.payload.reason, 'missing', '分支不存在要归成 missing：' + gone.payload.reason)
    assert.match(String(gone.payload.hint), /不存在|刷新/, 'hint 要指向刷新列表：' + gone.payload.hint)

    // ⑤ from 也是要交给 git 的位置参数：形状不对在宿主层就拦下（不能只靠界面）。
    const bad = await runPanelOp('renameBranch', { name: 'ok', from: '-x' }, root)
    assert.equal(bad.payload.ok, false, 'from 形状不对要被宿主拒绝')
    assert.match(String(bad.payload.message), /不合法/, '拒绝理由要写清是名字不合法：' + bad.payload.message)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 从指定的那个远程拉（本次需求） ───────────────────────────────────────────
//
// 现场（用户真实仓库 dsh-skills-manager）：当前分支跟踪 fork（自己的）、更新在 origin
// （别人的上游）上。旧面板的「拉取」只跑裸 `git pull`，来源由上游配置决定 —— 想拿上游
// 的更新，只能先把上游改绑到 origin、拉完再改回来，或者去终端敲命令。
//
// 这两条在真 git 上钉住三件事：①「拉取自 upstream」真的把那一份合进来，而
// branch.<名字>.remote/merge **一个字节没动**；②远端没有同名分支时**绝不自动**改拉
// 默认分支，只给一条要点一下的路；③坏形状（只给分支 / `-x` / 带空格）在宿主层被拒。

test('standalone：「拉取自」指定的远程能拿回那份更新，且不动上游配置（真 git）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-pullfrom-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-pullfrom-fork-'))
  const ups = await mkdtemp(join(tmpdir(), 'git-sidebar-pullfrom-up-'))
  try {
    const forkBare = join(mine, 'demo.git')
    const upstreamBare = join(ups, 'demo.git')
    const seed = join(ups, 'seed')
    try {
      await run('git', ['init', '-q', '--bare', '--initial-branch=main', upstreamBare])
      await mkdir(seed, { recursive: true })
      await run('git', ['init', '-q', '-b', 'main'], { cwd: seed })
    } catch {
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', seed, 'config', 'user.email', 'up@t'])
    await run('git', ['-C', seed, 'config', 'user.name', 'up'])
    await writeFile(join(seed, 'a.txt'), '别人的 v1\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v1'])
    await run('git', ['-C', seed, 'remote', 'add', 'origin', upstreamBare])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    // 我的 fork：从上游克隆出来的（内容一致、归我所有）
    await run('git', ['clone', '-q', '--bare', upstreamBare, forkBare])

    // 克隆我的 fork 当工作副本（origin=fork），再把别人的仓库加成 upstream
    await mkdir(join(root, 'work'), { recursive: true })
    const cloned = await runPanelOp('clone', { url: forkBare }, join(root, 'work'))
    const dir = cloned.payload.clonedDir
    await run('git', ['-C', dir, 'config', 'user.email', 'me@t'])
    await run('git', ['-C', dir, 'config', 'user.name', 'me'])
    await writeFile(join(dir, 'mine.txt'), '我的改造\n')
    await runPanelOp('addAll', {}, dir)
    await runPanelOp('commit', { message: '我的改造' }, dir)
    const pushed = await runPanelOp('push', {}, dir)
    assert.equal(pushed.payload.ok, true, '前置：先把自己的改动推到 fork：' + pushed.payload.message)
    await runPanelOp('setRemote', { name: 'upstream', url: upstreamBare }, dir)
    // 前置：当前分支跟踪的是 fork（origin），不是 upstream —— 这正是要解决的现场。
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.main.remote'])).stdout.trim(),
      'origin',
      '前置条件：main 的上游是 origin（我的 fork）',
    )

    // 别人那边来了 v2（改的是另一个文件，不会冲突）
    await writeFile(join(seed, 'b.txt'), '别人的 v2\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v2'])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])

    // ① 裸「拉取」（跟随上游 = 我的 fork）：拿不到 v2 —— 这就是要有「拉取自」的原因。
    const bare = await runPanelOp('pull', {}, dir)
    assert.equal(bare.payload.ok, true, '裸拉取本身是成功的（只是来源是我的 fork）')
    assert.equal(bare.payload.command, 'git pull')
    await assert.rejects(() => run('git', ['-C', dir, 'cat-file', '-e', 'HEAD:b.txt']),
      undefined, '跟随上游（fork）拉不到别人那份的 b.txt')

    // ② 「拉取自 upstream」：显式来源，一条命令把上游那份合进来。
    const fromUpstream = await runPanelOp('pull', { remote: 'upstream' }, dir)
    assert.equal(fromUpstream.payload.ok, true,
      '拉取自 upstream 应该成功：' + JSON.stringify(fromUpstream.payload.message))
    assert.equal(fromUpstream.payload.command, 'git pull upstream main',
      '命令要显式带远程与分支（分支由宿主按当前分支补）')
    assert.equal(fromUpstream.payload.retried, false)
    assert.ok(
      (fromUpstream.payload.notes ?? []).some((note) => note.includes('upstream/main')),
      '结果里要说清这次是从你选的远程拉的：' + JSON.stringify(fromUpstream.payload.notes),
    )
    // 上游的文件到了，我自己的改动也还在。
    assert.equal((await run('git', ['-C', dir, 'ls-files', 'b.txt'])).stdout.trim(), 'b.txt')
    assert.equal((await run('git', ['-C', dir, 'ls-files', 'mine.txt'])).stdout.trim(), 'mine.txt')
    // 上游配置一个字节没动（这条命令只换来源，不改跟踪关系）。
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.main.remote'])).stdout.trim(),
      'origin',
      '拉取自 upstream 不能改 branch.main.remote',
    )
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.main.merge'])).stdout.trim(),
      'refs/heads/main',
      '拉取自 upstream 不能改 branch.main.merge',
    )

    // ③ 我自己的 fork 也同步过去（「推送到」那一边的选择没有被这次拉取影响）。
    const pushFork = await runPanelOp('push', { remote: 'origin' }, dir)
    assert.equal(pushFork.payload.ok, true, '再推回自己的 fork：' + pushFork.payload.message)
    const forkHeads = (await run('git', ['-C', forkBare, 'log', '--oneline', '-n', '1'])).stdout.trim()
    assert.match(forkHeads, /Merge|v2|我的改造/, 'fork 上要有合并后的结果：' + forkHeads)

    // ④ 坏形状：只给分支会被 git 当成仓库地址；`-x` 会被当成选项；空格不是 ref。
    const onlyBranch = await runPanelOp('pull', { branch: 'main' }, dir)
    assert.equal(onlyBranch.payload.ok, false, '只给分支必须被宿主拒绝（不能拼出 git pull main）')
    assert.match(String(onlyBranch.payload.message), /只给分支名会被 git 当成仓库地址/)
    const dash = await runPanelOp('pull', { remote: '-x' }, dir)
    assert.equal(dash.payload.ok, false)
    assert.match(String(dash.payload.message), /远程名或地址不合法/)
    const spaced = await runPanelOp('pull', { remote: 'upstream', branch: 'a b' }, dir)
    assert.equal(spaced.payload.ok, false)
    assert.match(String(spaced.payload.message), /分支名不合法/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
    await rm(ups, { recursive: true, force: true })
  }
})

test('standalone：「拉取自」的远端没有同名分支时，只给一条要点一下的路（真 git）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-pullmiss-'))
  const other = await mkdtemp(join(tmpdir(), 'git-sidebar-pullmiss-bare-'))
  try {
    const bare = join(other, 'demo.git')
    try {
      await run('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
      await run('git', ['init', '-q', '-b', 'main'], { cwd: root })
    } catch {
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', root, 'config', 'user.email', 't@t'])
    await run('git', ['-C', root, 'config', 'user.name', 't'])
    await writeFile(join(root, 'a.txt'), '本地第一版\n')
    await run('git', ['-C', root, 'add', '-A'])
    await run('git', ['-C', root, 'commit', '-qm', '第一次提交'])
    await run('git', ['-C', root, 'remote', 'add', 'origin', bare])
    // 远端有一条**不同名**的分支（master，内容停在第一次提交）。
    await run('git', ['-C', root, 'push', '-q', 'origin', 'main:master'])
    // 本地另开一条远端没有的分支，并且它自己有提交（这样后面那次合并会真的产生合并提交，
    // 而不是快进 —— 用例要验的是「把 origin/master 并进来」这件事真的发生了）。
    await run('git', ['-C', root, 'switch', '-q', '-c', 'local-only'])
    await writeFile(join(root, 'c.txt'), '本地这条分支上的提交\n')
    await run('git', ['-C', root, 'add', '-A'])
    await run('git', ['-C', root, 'commit', '-qm', '本地这条分支的提交'])
    // 让远端那条 master 走到一个**不在** local-only 历史里的提交上（否则这次合并只会快进，
    // 用例就分不清「真的合并了」还是「其实什么都没做」）。
    await run('git', ['-C', root, 'switch', '-q', 'main'])
    await writeFile(join(root, 'd.txt'), '远端那条分支上的提交\n')
    await run('git', ['-C', root, 'add', '-A'])
    await run('git', ['-C', root, 'commit', '-qm', '远端那条分支上的提交'])
    await run('git', ['-C', root, 'push', '-q', 'origin', 'main:master'])
    await run('git', ['-C', root, 'fetch', '-q', 'origin'])
    await run('git', ['-C', root, 'switch', '-q', 'local-only'])
    assert.equal(
      (await run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(),
      'local-only',
      '前置条件：当前分支是 local-only（远端没有同名分支）',
    )

    const missing = await runPanelOp('pull', { remote: 'origin' }, root)
    assert.equal(missing.payload.ok, false, '远端没有同名分支时这次拉取必然失败')
    assert.equal(missing.payload.reason, 'remote-branch-missing', '要归成 remote-branch-missing')
    assert.match(String(missing.payload.message), /origin/, '要把是哪个远端说清楚：' + missing.payload.message)
    // 关键：**不能自动**把 master 那份拉进来（那是把另一条线并进当前分支）。
    assert.equal(
      (await run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(),
      'local-only',
      '失败后不能悄悄切分支',
    )
    const choices = missing.payload.choices ?? []
    assert.equal(choices.length, 1, '要给一条能点的路：' + JSON.stringify(choices))
    assert.equal(choices[0].op, 'pull')
    assert.deepEqual(choices[0].params, { remote: 'origin', branch: 'master' },
      '这条路要指向**远端自己的默认分支**，而不是按当前分支名去猜')
    assert.match(String(missing.payload.hint), /master/, 'hint 要说清它有什么：' + missing.payload.hint)

    // 点了那条路：这一次才把 origin/master 拉进当前分支（显式决定，不是替用户做的）。
    const done = await runPanelOp(choices[0].op, choices[0].params, root)
    assert.equal(done.payload.ok, true, '点了那条路应该拉成功：' + JSON.stringify(done.payload.message))
    assert.equal(done.payload.command, 'git pull origin master')
    const subject = (await run('git', ['-C', root, 'log', '--oneline', '-n', '1', '--format=%s'])).stdout.trim()
    assert.match(subject, /Merge/i, '应该是一次合并（把 origin/master 并进 local-only）：' + subject)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('standalone：「安全拉取」与「拉取」同一个来源（脏工作区时也走选中的那个远程）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-stashpull-src-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-stashpull-mine-'))
  const ups = await mkdtemp(join(tmpdir(), 'git-sidebar-stashpull-up-'))
  try {
    const forkBare = join(mine, 'demo.git')
    const upstreamBare = join(ups, 'demo.git')
    const seed = join(ups, 'seed')
    try {
      await run('git', ['init', '-q', '--bare', '--initial-branch=main', upstreamBare])
      await mkdir(seed, { recursive: true })
      await run('git', ['init', '-q', '-b', 'main'], { cwd: seed })
    } catch {
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', seed, 'config', 'user.email', 'u@t'])
    await run('git', ['-C', seed, 'config', 'user.name', 'u'])
    await writeFile(join(seed, 'a.txt'), 'v1\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v1'])
    await run('git', ['-C', seed, 'remote', 'add', 'origin', upstreamBare])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    await run('git', ['clone', '-q', '--bare', upstreamBare, forkBare])

    await mkdir(join(root, 'work'), { recursive: true })
    const cloned = await runPanelOp('clone', { url: forkBare }, join(root, 'work'))
    const dir = cloned.payload.clonedDir
    await run('git', ['-C', dir, 'config', 'user.email', 'me@t'])
    await run('git', ['-C', dir, 'config', 'user.name', 'me'])
    await runPanelOp('setRemote', { name: 'upstream', url: upstreamBare }, dir)

    // 上游来了一个新文件；工作区则有**未提交改动**（所以该点「安全拉取」）。
    await writeFile(join(seed, 'b.txt'), '上游新增\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v2'])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    await writeFile(join(dir, 'my-wip.txt'), '我还没提交的改动\n')

    const safe = await runPanelOp('stashPull', { remote: 'upstream' }, dir)
    assert.equal(safe.payload.ok, true, '安全拉取应该成功：' + JSON.stringify(safe.payload.message))
    assert.match(String(safe.payload.command), /git pull upstream main/,
      '「安全拉取」必须从选中的远程拉，而不是裸 pull：' + safe.payload.command)
    // 上游的文件到了、我的未提交改动也原样回来了。
    assert.equal((await run('git', ['-C', dir, 'ls-files', 'b.txt'])).stdout.trim(), 'b.txt',
      '上游那份的新文件要拉进来')
    const status = (await run('git', ['-C', dir, 'status', '--porcelain'])).stdout
    assert.match(status, /my-wip\.txt/, '未提交的改动要原样回到工作区：' + status)
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.main.remote'])).stdout.trim(),
      'origin',
      '安全拉取也不能改上游配置',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
    await rm(ups, { recursive: true, force: true })
  }
})

// ── fork 现场的真 git 端到端：一键把上游的默认分支拉到当前分支 ────────────────
//
// 复刻用户的真实仓库（dsh-skills-manager）：
//   当前分支 `local.2` 跟踪 `fork/local.2`（自己的），别人的更新在 `upstream` 上、
//   默认分支叫 `main`。于是「拉当前分支同名那条」在 upstream 上根本不存在 ——
//   面板要能**自己看出**这一点（状态里带回 upstream 的默认分支是谁），并把
//   「把 upstream/main 拉进 local.2」做成一次点击。
//
// 这条在真 git 上钉三件事：
//   ① 宿主的状态里带回了每个远程各自的默认分支（面板靠它点名分支，不是靠猜）；
//   ② 系统真的拿到了「远端默认分支与当前分支不同名」这个事实（local.2 ≠ main）；
//   ③ 点下去那条命令能跑通，且 branch.local.2 的上游配置一个字节没动。

test('standalone：状态带回每个远程的默认分支；从上游默认分支拉进当前分支能跑通（真 git）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { runPanelOp } = await import('../lib/routes.js')
  const { readState } = await import('../lib/index.js')

  const root = await mkdtemp(join(tmpdir(), 'git-sidebar-pullhead-'))
  const mine = await mkdtemp(join(tmpdir(), 'git-sidebar-pullhead-fork-'))
  const ups = await mkdtemp(join(tmpdir(), 'git-sidebar-pullhead-up-'))
  try {
    const forkBare = join(mine, 'demo.git')
    const upstreamBare = join(ups, 'demo.git')
    const seed = join(ups, 'seed')
    try {
      await run('git', ['init', '-q', '--bare', '--initial-branch=main', upstreamBare])
      await mkdir(seed, { recursive: true })
      await run('git', ['init', '-q', '-b', 'main'], { cwd: seed })
    } catch {
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', seed, 'config', 'user.email', 'up@t'])
    await run('git', ['-C', seed, 'config', 'user.name', 'up'])
    await writeFile(join(seed, 'a.txt'), '别人的 v1\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v1'])
    await run('git', ['-C', seed, 'remote', 'add', 'origin', upstreamBare])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    await run('git', ['clone', '-q', '--bare', upstreamBare, forkBare])

    // 我的工作副本：origin = 我的 fork。
    await mkdir(join(root, 'work'), { recursive: true })
    const cloned = await runPanelOp('clone', { url: forkBare }, join(root, 'work'))
    const dir = cloned.payload.clonedDir
    await run('git', ['-C', dir, 'config', 'user.email', 'me@t'])
    await run('git', ['-C', dir, 'config', 'user.name', 'me'])

    // 把工作分支改成 local.2（远端默认分支叫 main —— 差别正是这一版的现场），
    // 推到自己那份，并把上游登记成 fork/local.2。
    //
    // 上游登记用**裸 git**：面板的 pushUpstream 刻意不写 config（那是它一贯的原则 ——
    // 只有「设置上游…」这一个显式入口才改跟踪关系）。这里要的是「现场已经配好跟踪」
    // 这个前置条件，所以由 fixture 自己搭。
    await run('git', ['-C', dir, 'switch', '-q', '-c', 'local.2'])
    await writeFile(join(dir, 'mine.txt'), '我的改造\n')
    await runPanelOp('addAll', {}, dir)
    await runPanelOp('commit', { message: '我的改造' }, dir)
    const pushed = await runPanelOp('push', { remote: 'origin' }, dir)
    assert.equal(pushed.payload.ok, true, '前置：把 local.2 推到自己那份：' + pushed.payload.message)
    await run('git', ['-C', dir, 'branch', '--set-upstream-to=origin/local.2', 'local.2'])

    // 别人的上游加成第二个远程，并获取一次（`refs/remotes/upstream/HEAD` 由 fetch 建立）。
    await runPanelOp('setRemote', { name: 'upstream', url: upstreamBare }, dir)
    await runPanelOp('fetch', {}, dir)
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.local.2.remote'])).stdout.trim(),
      'origin',
      '前置条件：local.2 的上游是我的 fork（origin），不是别人的 upstream',
    )

    // ① 状态里带回**每个远程各自**的默认分支。
    let state = await readState(dir)
    assert.equal(state.branch, 'local.2', '前置：当前分支是 local.2')
    assert.equal(state.remoteHeads.upstream, 'main',
      '要把 upstream 的默认分支读出来：' + JSON.stringify(state.remoteHeads))
    assert.equal(state.remoteHeads.origin, 'main',
      '自己那份的默认分支是 main（fork 是 clone 来的）：' + JSON.stringify(state.remoteHeads))
    // ② 系统的真实事实：远端默认分支（main）与当前分支（local.2）**不同名**。
    assert.notEqual(state.remoteHeads.upstream, state.branch,
      '这条用例的前提就是「要拉的那条与当前分支不同名」——否则根本不需要点名分支')

    // 别人那边来了 v2。
    await writeFile(join(seed, 'b.txt'), '别人的 v2\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'v2'])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    await runPanelOp('fetch', {}, dir)

    // ③ 面板的那一下：`git pull upstream main`（远程 + 它自己的默认分支，都点名）。
    const pulled = await runPanelOp('pull', { remote: 'upstream', branch: 'main' }, dir)
    assert.equal(pulled.payload.ok, true,
      '从上游默认分支拉进当前分支应该成功：' + JSON.stringify(pulled.payload.message))
    assert.equal(pulled.payload.command, 'git pull upstream main',
      '必须是显式「远程 + 它自己的默认分支」，不能按当前分支名去猜 local.2')
    assert.equal((await run('git', ['-C', dir, 'ls-files', 'b.txt'])).stdout.trim(), 'b.txt',
      '上游那份的新文件要真的合进来')
    assert.equal((await run('git', ['-C', dir, 'ls-files', 'mine.txt'])).stdout.trim(), 'mine.txt',
      '我自己的改动不能丢')
    assert.equal(
      (await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(),
      'local.2',
      '当前分支名不变（拉别人的默认分支不等于切过去）',
    )
    // 上游跟踪关系一个字节没动：以后点「推送」推的仍是我自己的 fork。
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.local.2.remote'])).stdout.trim(),
      'origin',
      '从 upstream 拉不能改 branch.local.2.remote',
    )
    assert.equal(
      (await run('git', ['-C', dir, 'config', '--get', 'branch.local.2.merge'])).stdout.trim(),
      'refs/heads/local.2',
      '从 upstream 拉不能改 branch.local.2.merge',
    )

    // ④ 状态读不到 HEAD 指针的远程**不出现在表里**（面板据此退回「拉同名那条」，不猜）。
    await run('git', ['-C', dir, 'update-ref', '-d', 'refs/remotes/upstream/HEAD'])
    state = await readState(dir)
    assert.equal(Object.prototype.hasOwnProperty.call(state.remoteHeads, 'upstream'), false,
      '没有 HEAD 指针的远程不该出现在表里：' + JSON.stringify(state.remoteHeads))
    assert.equal(state.remoteHeads.origin, 'main', '其余远程照旧读得出来')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(mine, { recursive: true, force: true })
    await rm(ups, { recursive: true, force: true })
  }
})

// ── 远端默认分支的两个边界：远程名含斜杠 / 分支名以 /HEAD 结尾（真 git） ────────
//
// 这两条都是**实测出来的**、只看代码不会发现的坑：
//   · `git remote add a/b <url>` 是合法的（斜杠在远程名里没问题，`git pull a/b main`
//     也能拉），而 for-each-ref 的 pattern `refs/remotes/*/HEAD` **只匹配一层** ——
//     名为 `a/b` 的远程那个 HEAD 会被静默漏掉。改 `**` 才读得到（本用例钉住这一点）。
//   · 反过来，**分支**名以 `/HEAD` 结尾（`feat/HEAD`）也会在 refs/remotes/<远程>/feat/HEAD
//     留下一个引用。它没有 symref 那一列，必须被排除 —— 否则会被当成「远程的默认分支」
//     而让面板去拉一条根本不是默认分支的分支。

test('standalone：远程名含斜杠时也读得到它的默认分支；以 /HEAD 结尾的分支不会被误认（真 git）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { readState } = await import('../lib/index.js')

  const base = await mkdtemp(join(tmpdir(), 'git-sidebar-headglob-'))
  try {
    const bare = join(base, 'up.git')
    const seed = join(base, 'seed')
    try {
      await run('git', ['init', '-q', '--bare', bare])
      await mkdir(seed, { recursive: true })
      await run('git', ['init', '-q', '-b', 'main'], { cwd: seed })
    } catch {
      context.skip('本机没有可用的 git')
      return
    }
    await run('git', ['-C', seed, 'config', 'user.email', 't@t'])
    await run('git', ['-C', seed, 'config', 'user.name', 't'])
    await writeFile(join(seed, 'a.txt'), 'one\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'first'])
    await run('git', ['-C', seed, 'remote', 'add', 'origin', bare])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    await run('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'])

    const work = join(base, 'work')
    await run('git', ['clone', '-q', bare, work])
    // 远程名含斜杠（合法）—— 一层 glob 会漏掉它。
    await run('git', ['-C', work, 'remote', 'add', 'a/b', bare])
    // 远端再推一条**名字以 /HEAD 结尾的分支**（它在本地会留下 <远程>/feat/HEAD 引用）。
    await run('git', ['-C', seed, 'branch', 'feat/HEAD'])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'feat/HEAD'])
    await run('git', ['-C', work, 'fetch', '-q', '--all'])

    // 前置：真 git 里确实同时存在这两类引用（否则用例自己就失效了）。
    const refs = (await run('git', ['-C', work, 'for-each-ref', '--format=%(refname)'])).stdout
    assert.match(refs, /refs\/remotes\/a\/b\/HEAD/, '前置：斜杠远程的 HEAD 引用存在')
    assert.match(refs, /refs\/remotes\/origin\/feat\/HEAD/, '前置：feat/HEAD 这条远端分支的引用存在')

    const state = await readState(work)
    assert.equal(state.remoteHeads['a/b'], 'main',
      '远程名含斜杠时也要读出它的默认分支（一层 glob 会漏掉）：' + JSON.stringify(state.remoteHeads))
    assert.equal(state.remoteHeads.origin, 'main', '一层远程照旧读得出来')
    // 关键：`feat/HEAD` 这条**分支**不能被当成默认分支（它没有 symref，必须被排除）。
    assert.notEqual(state.remoteHeads.origin, 'feat/HEAD',
      '以 /HEAD 结尾的分支不是默认分支，绝不能被认成它')
    assert.notEqual(state.remoteHeads['origin/feat'], 'HEAD',
      '也不该被切成一个叫 origin/feat 的「远程」')
    assert.deepEqual(Object.keys(state.remoteHeads).sort(), ['a/b', 'origin'],
      '表里只该有真正配置过的远程：' + JSON.stringify(state.remoteHeads))

    // 点得动：这条远程的默认分支真的能拉（面板「拉 main」跑的就是这条命令）。
    const dir = work
    await run('git', ['-C', dir, 'config', 'user.email', 'me@t'])
    await run('git', ['-C', dir, 'config', 'user.name', 'me'])
    await writeFile(join(seed, 'b.txt'), 'two\n')
    await run('git', ['-C', seed, 'add', '-A'])
    await run('git', ['-C', seed, 'commit', '-qm', 'second'])
    await run('git', ['-C', seed, 'push', '-q', 'origin', 'main'])
    const { runPanelOp } = await import('../lib/routes.js')
    const pulled = await runPanelOp('pull', { remote: 'a/b', branch: 'main' }, dir)
    assert.equal(pulled.payload.ok, true,
      '斜杠远程的默认分支也要拉得动：' + JSON.stringify(pulled.payload.message))
    assert.equal(pulled.payload.command, 'git pull a/b main')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
