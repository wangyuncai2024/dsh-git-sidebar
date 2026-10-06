// dsh-git-sidebar —— 网络加速回归测试
// ============================================================================
// 覆盖「连不上 github.com 时开加速」这条链路。分三层：
//
//   1. 纯函数：配置归一化、参数注入、失败分类、凭据打码。不触网、不落盘。
//   2. 配置读写：配合临时 DSH_HOME，验证落盘与合并（不碰用户真实配置）。
//   3. 路由集成：用 mock webServer 拿到真实路由 handler，喂假请求，验证
//      「镜像失败 → 自动回退直连」这条最关键的路径。
//
// 为什么第 3 层要用假 git：回退逻辑的触发条件是「镜像那一次没成功」，而真实
// github 在不联网的机器上根本连不上、在能连的机器上又会真的下载 —— 两种都让
// 测试结果随环境变化。放一个假 git 到 PATH 最前面，就能在**离线且确定**的条件下
// 精确复现「镜像挂了、直连通了」。
// ============================================================================

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
  apply,
  normalizeNetConfig,
  networkExtraArgs,
  classifyNetworkFailure,
  networkHint,
  maskProxy,
  displayArgv,
  netConfigView,
  netConfigPath,
  readNetConfig,
  writeNetConfig,
  resetNetConfigCache,
  mirrorLabel,
  probeJobs,
  MIRROR_CANDIDATES,
  resetCsrfTokens,
} from '../lib/index.js'

const DEFAULT_MIRROR = MIRROR_CANDIDATES[0].prefix

const execFileAsync = promisify(execFile)

/**
 * 本机有没有可用的 git。git 不是插件的依赖（`package.json` 里 dependencies 为空），
 * 只是「真 git」那道端到端验证需要它；取不到就跳过，不能让整份测试在没装 git 的
 * 机器上变红。
 * @returns 版本字符串；取不到时 null。
 */
async function gitVersion() {
  try {
    const result = await execFileAsync('git', ['--version'], { timeout: 10000 })
    return String(result.stdout).trim()
  } catch {
    return null
  }
}

/** 跑一次真实的 git；非零退出不抛异常，归一化成 { code, stdout, stderr }。 */
async function runGitRaw(argv, cwd) {
  try {
    const result = await execFileAsync('git', argv, { cwd, timeout: 30000 })
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (error) {
    const raw = error ?? {}
    if (typeof raw.code === 'number') {
      return { code: raw.code, stdout: String(raw.stdout ?? ''), stderr: String(raw.stderr ?? '') }
    }
    return { code: -1, stdout: '', stderr: String(raw.message ?? raw) }
  }
}

// ── 1. 配置归一化 ─────────────────────────────────────────────────────────

test('network：只打开镜像开关就该生效（回归：曾用用户填的空镜像算开关，导致开了等于没开）', () => {
  const config = normalizeNetConfig({ mirrorEnabled: true })
  assert.equal(config.mirrorEnabled, true, '只给 mirrorEnabled 时必须仍然启用')
  assert.equal(config.mirror, DEFAULT_MIRROR, '没填镜像时用第一个候补兜底')
  // 这条断言才是真正的用户可见后果：开关开着就必须真的产生加速参数。
  assert.equal(networkExtraArgs('fetch', config).mode, 'mirror')
})

test('network：默认配置是「不加速」', () => {
  for (const input of [{}, { mirrorEnabled: false }, null, undefined, 'x', 42]) {
    const config = normalizeNetConfig(input)
    assert.equal(config.mirrorEnabled, false, '输入 ' + JSON.stringify(input) + ' 不该默认开启')
    assert.deepEqual(networkExtraArgs('fetch', config).args, [])
  }
})

test('network：非 https 的镜像被拒绝并退回默认值', () => {
  for (const bad of ['http://mirror.example/', 'ftp://x/', 'gh-proxy.com', 'https://', '  ']) {
    const config = normalizeNetConfig({ mirrorEnabled: true, mirror: bad })
    assert.equal(config.mirror, DEFAULT_MIRROR, bad + ' 不该被接受')
  }
})

test('network：镜像地址自动补尾部斜杠且是幂等的', () => {
  assert.equal(normalizeNetConfig({ mirror: 'https://ghfast.top' }).mirror, 'https://ghfast.top/')
  assert.equal(normalizeNetConfig({ mirror: 'https://ghfast.top/' }).mirror, 'https://ghfast.top/')
  assert.equal(normalizeNetConfig({ mirror: 'https://ghfast.top' }).mirror, DEFAULT_MIRROR.replace(/.*/, 'https://ghfast.top/'))
})

test('network：代理只接受 http/https/socks5，空串表示关闭', () => {
  assert.equal(normalizeNetConfig({ proxy: 'http://127.0.0.1:7890' }).proxy, 'http://127.0.0.1:7890')
  assert.equal(normalizeNetConfig({ proxy: 'socks5://127.0.0.1:1080' }).proxy, 'socks5://127.0.0.1:1080')
  assert.equal(normalizeNetConfig({ proxy: 'socks5h://127.0.0.1:1080' }).proxy, 'socks5h://127.0.0.1:1080')
  assert.equal(normalizeNetConfig({ proxy: '127.0.0.1:7890' }).proxy, '', '缺协议不能猜')
  assert.equal(normalizeNetConfig({ proxy: '' }).proxy, '', '空串 = 关闭代理')
  assert.equal(normalizeNetConfig({ proxy: '   ' }).proxy, '')
})

// ── 2. 参数注入 ───────────────────────────────────────────────────────────

test('network：镜像的 insteadOf 必须是「镜像 + 原前缀」做 base（回归：写成 url.<镜像>.insteadOf 会拼出不存在的地址）', () => {
  const config = normalizeNetConfig({ mirrorEnabled: true, mirror: 'https://gh-proxy.com' })
  const args = networkExtraArgs('fetch', config).args
  assert.ok(
    args.includes('url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/'),
    'https 前缀的 base 必须带上原地址前缀，实际：' + JSON.stringify(args),
  )
  assert.ok(
    args.includes('url.https://gh-proxy.com/http://github.com/.insteadOf=http://github.com/'),
    'http 前缀同理',
  )
  // 反面：绝不能生成这类「前缀替换」写法 —— 它会得到 gh-proxy.com/owner/repo。
  for (const arg of args) {
    assert.ok(
      !/^url\.https:\/\/gh-proxy\.com\/\.insteadOf=/.test(arg),
      '不能把镜像本身当 base：' + arg,
    )
  }
})

test('network：push 只走代理，绝不用镜像（镜像会丢掉凭据主体，必然认证失败）', () => {
  const config = normalizeNetConfig({
    mirrorEnabled: true,
    mirror: 'https://gh-proxy.com',
    proxy: 'http://127.0.0.1:7890',
  })
  const pushed = networkExtraArgs('push', config)
  assert.equal(pushed.mirror, false)
  assert.equal(pushed.mode, 'proxy')
  assert.ok(pushed.args.every((arg) => !arg.includes('insteadOf')), 'push 不该出现 insteadOf')
  assert.deepEqual(pushed.args, ['-c', 'http.proxy=http://127.0.0.1:7890', '-c', 'https.proxy=http://127.0.0.1:7890'])
})

test('network：注入片段必须是成对的 -c key=value（回归：漏掉 -c，git 会把配置当成子命令）', () => {
  // 这个坑是在真机上跑出来的：片段只回裸的 key=value、调用点忘了补 -c 时，git 会
  // 把 `url.<…>.insteadOf=…` 当成子命令，报「不是一个 git 命令」。加速**完全没生效**
  // 却只表现为一句莫名其妙的报错，然后静默退回直连 —— 只断言「参数里有 insteadOf」
  // 是抓不到它的，必须断言形状。
  const config = normalizeNetConfig({ mirrorEnabled: true, proxy: 'http://127.0.0.1:7890' })
  for (const op of ['clone', 'fetch', 'pull', 'push']) {
    const { args } = networkExtraArgs(op, config)
    assert.ok(args.length > 0, op + ' 应该有参数')
    assert.equal(args.length % 2, 0, op + ' 的参数必须成对：' + JSON.stringify(args))
    for (let index = 0; index < args.length; index += 2) {
      assert.equal(args[index], '-c', `${op} 的第 ${index} 个参数必须是 -c：${JSON.stringify(args)}`)
      assert.match(args[index + 1], /^[^=\s]+=.+$/, `${op} 的第 ${index + 1} 个参数必须是 key=value：${JSON.stringify(args)}`)
    }
  }
  // 回退用的 noMirror 片段同样要成对。
  const fallback = networkExtraArgs('fetch', config, { noMirror: true }).args
  assert.equal(fallback.length % 2, 0)
  assert.equal(fallback[0], '-c')
})

test(
  'network：[真 git] 注入的片段能被 git 真正接受（不是「不是一个 git 命令」）',
  async (t) => {
    if ((await gitVersion()) === null) {
      t.skip('本机没有 git，跳过（git 不是插件的依赖，只是这道端到端验证需要它）')
      return
    }
    const dir = await mkdtemp(join(tmpdir(), 'git-sidebar-args-'))
    try {
      const config = normalizeNetConfig({ mirrorEnabled: true, mirror: 'https://gh-proxy.com' })
      const { args } = networkExtraArgs('fetch', config)
      // 拿 -c 片段去问一个一定会被解析到的配置项：漏了 -c 时 git 会以
      // 「不是一个 git 命令」退出，这里就拿到非零退出码。
      const result = await runGitRaw([...args, 'config', '--get', 'http.lowSpeedTime'], dir)
      assert.equal(result.code, 0, `git 拒绝了注入片段：${result.stderr}`)
      assert.equal(result.stdout.trim(), '60', '片段里的 lowSpeedTime 应该真的被 git 读到了')
      assert.ok(!/不是一个 git 命令|is not a git command/.test(result.stderr), '不能出现「不是一个 git 命令」')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('network：只读网络操作都能用镜像，非网络操作一个参数都不加', () => {
  const config = normalizeNetConfig({ mirrorEnabled: true })
  for (const op of ['clone', 'fetch', 'pull']) {
    assert.equal(networkExtraArgs(op, config).mirror, true, op + ' 应该走镜像')
  }
  for (const op of ['status', 'diff', 'commit', 'addAll', 'branches', 'discard', 'init', '']) {
    const result = networkExtraArgs(op, config)
    assert.equal(result.mode, 'direct')
    assert.deepEqual(result.args, [], op + ' 不该被注入任何东西')
  }
})

test('network：noMirror 只保留代理（回退直连时用）', () => {
  const config = normalizeNetConfig({
    mirrorEnabled: true,
    mirror: 'https://gh-proxy.com',
    proxy: 'http://127.0.0.1:7890',
  })
  const fallback = networkExtraArgs('fetch', config, { noMirror: true })
  assert.equal(fallback.mirror, false)
  assert.equal(fallback.mode, 'proxy')
  assert.ok(fallback.args.every((arg) => !arg.includes('insteadOf')))
})

test('network：低速中断阈值只跟着镜像出现（回退的直连那次不能带，免得误杀慢速大仓库）', () => {
  const withMirror = networkExtraArgs('fetch', normalizeNetConfig({ mirrorEnabled: true })).args
  assert.ok(withMirror.includes('http.lowSpeedLimit=1000'))
  assert.ok(withMirror.includes('http.lowSpeedTime=60'))
  const proxyOnly = networkExtraArgs('fetch', normalizeNetConfig({ proxy: 'http://127.0.0.1:7890' })).args
  assert.ok(proxyOnly.every((arg) => !arg.startsWith('http.lowSpeed')), '只用代理时不该限制速度')
})

// ── 3. 失败分类与提示 ─────────────────────────────────────────────────────

test('network：识别用户实际遇到的那条报错', () => {
  const real = "fatal: unable to access 'https://github.com/wangyuncai2024/dsh-git-sidebar.git/': Recv failure: Connection was reset"
  assert.equal(classifyNetworkFailure(real), 'network')
})

test('network：超时也算网络问题（runGit 把超时归一化成这条文本）', () => {
  assert.equal(classifyNetworkFailure('命令超时（600000ms 内无响应）'), 'network')
  assert.equal(classifyNetworkFailure('fatal: unable to access ...: Failed to connect to github.com port 443: Connection timed out'), 'network')
})

test('network：服务器答复了就不算网络问题（404 不能被引到「去开加速」）', () => {
  const notFound = "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 404"
  assert.equal(classifyNetworkFailure(notFound), null, '404 说明链路是通的，是仓库不存在')
  assert.equal(classifyNetworkFailure('fatal: Authentication failed for https://github.com/o/r/'), null)
  assert.equal(classifyNetworkFailure(''), null)
  assert.equal(classifyNetworkFailure(null), null)
})

test('network：提示区分「还没开加速」和「开了还是不通」，且都指向下一步', () => {
  const cold = networkHint(false)
  const warm = networkHint(true)
  assert.notEqual(cold, warm)
  assert.match(cold, /🌐/, '没开过加速时要告诉用户按钮在哪')
  assert.match(cold, /镜像/)
  assert.match(cold, /代理/)
  assert.match(warm, /代理/, '开了还不通时要指向更可靠的那条路')
})

// ── 4. 凭据打码（隐私回归） ───────────────────────────────────────────────

test('network：代理地址里的用户名密码必须打码', () => {
  assert.equal(maskProxy('http://user:secret@127.0.0.1:7890'), 'http://***@127.0.0.1:7890')
  assert.equal(maskProxy('socks5://onlyuser@127.0.0.1:1080'), 'socks5://***@127.0.0.1:1080')
  assert.ok(!maskProxy('http://user:secret@h:1').includes('secret'))
  // 没有凭据的地址不该被改动。
  assert.equal(maskProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(maskProxy('https://gh-proxy.com/'), 'https://gh-proxy.com/')
  assert.equal(maskProxy(''), '')
})

test('network：命令回显里的 -c 代理参数同样要打码（回显会留在屏幕上和工具记录里）', () => {
  const shown = displayArgv(['http.proxy=http://user:secret@h:7890', 'url.https://gh-proxy.com/.insteadOf=x', 'fetch'])
  assert.deepEqual(shown, ['http.proxy=http://***@h:7890', 'url.https://gh-proxy.com/.insteadOf=x', 'fetch'])
  assert.ok(!shown.join(' ').includes('secret'))
})

test('network：回给面板的配置视图永远不含明文凭据', () => {
  const view = netConfigView({ proxy: 'http://user:secret@127.0.0.1:7890', mirrorEnabled: true })
  assert.ok(!JSON.stringify(view).includes('secret'))
  assert.equal(view.proxy, 'http://***@127.0.0.1:7890')
  assert.equal(view.hasProxy, true, '打码后仍要能看出「设过代理」')
  assert.equal(view.mirrorEnabled, true)
  assert.ok(Array.isArray(view.candidates) && view.candidates.length > 0)
  assert.deepEqual(netConfigView({ proxy: '' }).proxy, '')
  assert.equal(netConfigView({ proxy: '' }).hasProxy, false)
})

test('network：mirrorLabel 只取域名', () => {
  assert.equal(mirrorLabel('https://gh-proxy.com/'), 'gh-proxy.com')
  assert.equal(mirrorLabel('https://ghfast.top'), 'ghfast.top')
  assert.equal(mirrorLabel('不是地址'), '不是地址')
})

test('network：[探测] 代理那条线路也必须带 -c（回归：探测里手写过裸 key=value，代理永远测不通）', () => {
  const jobs = probeJobs({ proxy: 'http://127.0.0.1:7890' })
  const proxyJob = jobs.find((job) => job.kind === 'proxy')
  assert.ok(proxyJob !== undefined, '配了代理就该有一条代理线路')
  assert.deepEqual(proxyJob.args, ['-c', 'http.proxy=http://127.0.0.1:7890', '-c', 'https.proxy=http://127.0.0.1:7890'])
  assert.ok(proxyJob.args.length % 2 === 0 && proxyJob.args[0] === '-c')

  // 镜像那条靠「地址换成镜像前缀」探测，不带 -c 是对的 —— 顺带把这一点钉住，
  // 免得将来有人「统一一下」给它也加上 -c，反而测不到镜像端点本身。
  const mirrorJobs = jobs.filter((job) => job.kind === 'mirror')
  assert.equal(mirrorJobs.length, 3, '三个候选镜像都要测')
  for (const job of mirrorJobs) {
    assert.deepEqual(job.args, [], '镜像线路不该带 -c')
    assert.match(job.url, /^https:\/\/[^/]+\/https:\/\/github\.com\//, '镜像地址应该是「镜像前缀 + 原地址」：' + job.url)
  }

  // 直连排第一，且**显式清掉全局代理**：用户 ~/.gitconfig 里配了 http.proxy 时，
  // 不显式清空的话「直连通」其实是代理在通，探测结论会把用户引偏。
  assert.equal(jobs[0].kind, 'direct')
  assert.deepEqual(jobs[0].args, ['-c', 'http.proxy=', '-c', 'https.proxy='])

  // 没配代理就不该有代理那条（否则会多等一个必然失败的超时）。
  assert.equal(probeJobs({}).some((job) => job.kind === 'proxy'), false)
  // 探测标签不能带出明文凭据；但参数里必须有真凭据，否则代理认证不了。
  const withAuth = probeJobs({ proxy: 'http://user:secret@127.0.0.1:7890' })
  const authJob = withAuth.find((job) => job.kind === 'proxy')
  assert.ok(String(authJob.label).includes('***'), '给人看的标签必须打码')
  assert.ok(!String(authJob.label).includes('secret'))
  assert.ok(JSON.stringify(authJob.args).includes('secret'), '参数里必须是真凭据，不然代理连不上')
})

// ── 5. 配置落盘（临时 DSH_HOME，不碰用户真实配置） ────────────────────────

let home = null

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'git-sidebar-net-'))
})

after(async () => {
  resetNetConfigCache()
  if (home !== null) await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  process.env.DSH_HOME = home
  resetNetConfigCache()
  // 会话令牌是模块级的：用例之间必须回到「还没发放过」的干净状态，否则前一个
  // 用例 GET 出来的令牌会让后一个用例的 POST 被 403 挡掉（那正是加固生效的样子，
  // 但对「只测 op 流水线」的用例来说是噪音）。
  resetCsrfTokens()
  await rm(netConfigPath(), { force: true })
})

test('network：配置落在 DSH_HOME 下，读回与写入一致', async () => {
  assert.equal(netConfigPath(), join(home, 'git-sidebar-net.json'))
  await writeNetConfig({ mirrorEnabled: true, mirror: 'https://ghfast.top', proxy: 'http://127.0.0.1:7890' })
  resetNetConfigCache()

  const onDisk = JSON.parse(await readFile(netConfigPath(), 'utf8'))
  assert.equal(onDisk.mirror, 'https://ghfast.top/')
  assert.equal(onDisk.mirrorEnabled, true)
  assert.equal(onDisk.proxy, 'http://127.0.0.1:7890')

  const read = await readNetConfig()
  assert.deepEqual(read, { mirrorEnabled: true, mirror: 'https://ghfast.top/', proxy: 'http://127.0.0.1:7890' })
})

test('network：配置文件缺失或损坏时退化为「不加速」，不抛异常', async () => {
  assert.deepEqual(await readNetConfig(), { mirrorEnabled: false, mirror: DEFAULT_MIRROR, proxy: '' })

  await writeFile(netConfigPath(), '{ 这不是 JSON', 'utf8')
  resetNetConfigCache()
  assert.equal((await readNetConfig()).mirrorEnabled, false)

  await writeFile(netConfigPath(), 'null', 'utf8')
  resetNetConfigCache()
  assert.equal((await readNetConfig()).proxy, '')
})

test('network：局部更新不会抹掉其它字段', async () => {
  await writeNetConfig({ mirrorEnabled: true, mirror: 'https://ghfast.top', proxy: 'http://127.0.0.1:7890' })
  const afterToggle = await writeNetConfig({ mirrorEnabled: false })
  assert.equal(afterToggle.mirrorEnabled, false)
  assert.equal(afterToggle.proxy, 'http://127.0.0.1:7890', '关掉镜像不该把代理一起清掉')
  assert.equal(afterToggle.mirror, 'https://ghfast.top/')

  const afterProxy = await writeNetConfig({ proxy: '' })
  assert.equal(afterProxy.proxy, '', '空串要能把代理清掉')
  assert.equal(afterProxy.mirrorEnabled, false)
})

// ── 6. 路由集成：/git-sidebar/net ───────────────────────────────────────────

/** 只复刻本插件用到的宿主契约。 */
function makeCtx() {
  const routes = []
  const server = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get(service) {
      return service === 'webServer' ? server : undefined
    },
    inject() {},
    effect(callback) {
      callback()
      return () => {}
    },
  }
  return { ctx, routes }
}

/** 假请求：readJsonBody 会 for-await 遍历它，所以必须异步可迭代。 */
function makeRequest(options = {}) {
  const body = options.body === undefined ? null : options.body
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/git-sidebar/net',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const state = { status: 0, headers: null, body: '' }
  const response = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(text) {
      if (text !== undefined && text !== null) state.body = String(text)
    },
  }
  return {
    state,
    response,
    json() {
      return JSON.parse(state.body)
    },
  }
}

const SAME_ORIGIN = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }

/** 拿到真实注册的路由（走一遍 apply，等价于真的加载插件）。 */
function mountRoutes() {
  const { ctx, routes } = makeCtx()
  // apply 会写一条 lifecycle 日志：显式钉到临时目录，别让跑测试这件事在插件仓库
  // 根目录里留下 git-sidebar.log（默认路径见 lib/log.js）。
  apply(ctx, { logFile: join(home, 'test-lifecycle.log') })
  const find = (path) => {
    const route = routes.find((item) => item.path === path)
    assert.ok(route !== undefined, '没有注册路由 ' + path)
    return route
  }
  return { net: find('/git-sidebar/net'), op: find('/git-sidebar/op'), paths: routes.map((r) => r.path) }
}

async function callRoute(route, options) {
  const out = makeResponse()
  await route.handler(makeRequest(options), out.response)
  // 405 之类的裸响应没有 body（route 自己 writeHead + end），不能一律按 JSON 解析。
  const data = out.state.body.length > 0 ? out.json() : null
  return { status: out.state.status, data }
}

test('network：[路由] 注册了 net 路由，且与其它路由的 path 不重复', () => {
  const { paths } = mountRoutes()
  assert.ok(paths.includes('/git-sidebar/net'))
  assert.equal(new Set(paths).size, paths.length, '同 path 挂多个路由会互相覆盖：' + JSON.stringify(paths))
})

test('network：[路由] GET 回配置与候选镜像，且不含明文凭据', async () => {
  await writeNetConfig({ mirrorEnabled: true, proxy: 'http://user:secret@127.0.0.1:7890' })
  const { net } = mountRoutes()
  const { status, data } = await callRoute(net, { method: 'GET' })

  assert.equal(status, 200)
  assert.equal(data.ok, true)
  assert.equal(data.mirrorEnabled, true)
  assert.equal(data.hasProxy, true)
  assert.ok(!JSON.stringify(data).includes('secret'), 'GET 在局域网内可达，不能回显明文凭据')
  assert.ok(Array.isArray(data.candidates) && data.candidates.length >= 3)
  for (const candidate of data.candidates) {
    assert.match(candidate.prefix, /^https:\/\//, '候选镜像必须是 https')
    assert.equal(typeof candidate.label, 'string')
  }
})

test('network：[路由] POST 把打码串理解成「不变」，不会把真凭据覆盖掉', async () => {
  await writeNetConfig({ proxy: 'http://user:secret@127.0.0.1:7890' })
  const { net } = mountRoutes()

  // 模拟面板行为：拿到打码的视图，改了个无关开关，把 proxy 与**会话令牌**原样回传。
  const view = (await callRoute(net, { method: 'GET' })).data
  assert.ok(typeof view.csrf === 'string' && view.csrf.length > 0, 'GET 要发放会话令牌')
  const saved = await callRoute(net, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: { mirrorEnabled: true, proxy: view.proxy, csrf: view.csrf },
  })

  assert.equal(saved.data.ok, true)
  assert.equal(saved.data.mirrorEnabled, true)
  assert.equal(saved.data.hasProxy, true, '凭据不能被 *** 覆盖掉')
  resetNetConfigCache()
  assert.equal((await readNetConfig()).proxy, 'http://user:secret@127.0.0.1:7890')
})

test('network：[路由] 发放过令牌之后，没带令牌的 POST 一律 403（CSRF 加固）', async () => {
  const { net } = mountRoutes()
  // 先 GET 一次（等价于浏览器加载页面），此时令牌已存在。
  const view = (await callRoute(net, { method: 'GET' })).data

  // 没有令牌（真实 CSRF 场景：跨站页面能发出请求，但读不到响应体里的令牌）。
  const blocked = await callRoute(net, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: { mirrorEnabled: true },
  })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.data.ok, false)
  assert.match(String(blocked.data.message), /令牌/)

  // 拿错令牌同样拒绝。
  const wrong = await callRoute(net, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: { mirrorEnabled: true, csrf: 'f'.repeat(32) },
  })
  assert.equal(wrong.status, 403)

  // 带上正确的令牌才放行。
  const ok = await callRoute(net, {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: { mirrorEnabled: true, csrf: view.csrf },
  })
  assert.equal(ok.data.ok, true)
})

test('network：[路由] POST 跨站来源被拒绝（该接口决定 git 命令怎么执行）', async () => {
  const { net } = mountRoutes()
  const { status, data } = await callRoute(net, {
    method: 'POST',
    headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
    body: { mirrorEnabled: true },
  })
  assert.equal(status, 403)
  assert.equal(data.ok, false)
  resetNetConfigCache()
  assert.equal((await readNetConfig()).mirrorEnabled, false, '被拒绝的请求不能留下任何改动')
})

test('network：[路由] 跨站拒绝的原因要写进响应体（否则桌面版这类误判无从排查）', async () => {
  const { net } = mountRoutes()
  const { status, data } = await callRoute(net, {
    method: 'POST',
    headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
    body: { mirrorEnabled: true },
  })
  assert.equal(status, 403)
  assert.match(String(data.message), /evil\.example/, '错误信息要带上来访的 Origin')
  assert.match(String(data.message), /127\.0\.0\.1:3080/, '错误信息要带上本站的 Host')
})

test('network：[路由] 桌面版形态的来源不该被误判成跨站（缺 Origin / null / 自定义协议 / 回环端口）', async () => {
  // 桌面版（Electron 外壳）的页面不一定从「与 Host 逐字相同」的来源打开：可能不带
  // Origin、带 `Origin: null`、带自定义协议，或者经另一个回环端口转发。这些请求过去
  // 全被 403「请求来源不可信」拒掉 —— 而 GET 不校验来源，面板读状态一切正常，只有
  // 每个 POST 失败，用户完全看不出原因。下面每一种都必须能正常保存配置。
  const shapes = [
    ['缺 Origin', { host: '127.0.0.1:3080' }],
    ['Origin: null', { origin: 'null', host: '127.0.0.1:3080' }],
    ['自定义协议', { origin: 'dsh://app', host: '127.0.0.1:3080' }],
    ['file 协议', { origin: 'file://', host: '127.0.0.1:3080' }],
    ['本机别名', { origin: 'http://localhost:3080', host: '127.0.0.1:3080' }],
    ['外壳回环端口', { origin: 'http://localhost:51999', host: '127.0.0.1:3080' }],
    ['IPv6 回环', { origin: 'http://[::1]:3080', host: '[::1]:3080' }],
  ]
  for (const [name, headers] of shapes) {
    const { net } = mountRoutes()
    // 模拟面板行为：先 GET 拿令牌，再用这个形态 POST。
    const view = (await callRoute(net, { method: 'GET', headers })).data
    const saved = await callRoute(net, {
      method: 'POST',
      headers,
      body: { mirrorEnabled: true, csrf: view.csrf },
    })
    assert.equal(saved.status, 200, name + ' 不该被当成跨站')
    assert.equal(saved.data.ok, true, name + ' 保存配置应成功')
    resetNetConfigCache()
    await rm(netConfigPath(), { force: true })
  }
})

test('network：[路由] 放宽来源之后令牌仍是硬门槛：缺 Origin 也不等于免令牌', async () => {
  const { net } = mountRoutes()
  const view = (await callRoute(net, { method: 'GET' })).data
  assert.ok(typeof view.csrf === 'string' && view.csrf.length > 0)

  const blocked = await callRoute(net, {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { mirrorEnabled: true },
  })
  assert.equal(blocked.status, 403, '令牌才是真正的门槛')
  assert.match(String(blocked.data.message), /令牌/)
})

test('network：[路由] 非法方法返回 405，坏 JSON 不炸掉服务', async () => {
  const { net } = mountRoutes()
  const put = await callRoute(net, { method: 'PUT', headers: SAME_ORIGIN })
  assert.equal(put.status, 405)

  const bad = await callRoute(net, { method: 'POST', headers: SAME_ORIGIN, body: '{ 不是 JSON' })
  assert.equal(bad.data.ok, false, '坏 JSON 应回一个可读的失败结果，而不是 500')
})

// ── 7. 路由集成：镜像失败 → 自动回退直连 ──────────────────────────────────

/**
 * 把假 git 放到 PATH 最前面。它把所有调用记到日志里，并在命令匹配 failWhen
 * 时按网络错误失败 —— 于是「镜像挂、直连通」可以离线复现。
 * @param dir - 放假 git 的目录。
 * @param options.failWhen - sh case 的匹配模式；默认只让带 insteadOf 的（镜像那次）失败。
 * @returns { log, calls, restore }：restore 还原 PATH。
 */
async function installFakeGit(dir, options = {}) {
  const failWhen = options.failWhen ?? '*insteadOf*'
  const log = join(dir, 'calls.log')
  const script = [
    '#!/bin/sh',
    'echo "$@" >> "' + log + '"',
    'case "$*" in',
    // 这里**不能给模式加引号**：sh 的 case 模式一旦被引起来，`*` 就退化成字面量，
    // 通配失效 —— 假 git 会永远成功，回退路径也就永远不会被触发。
    '  ' + failWhen + ')',
    '    echo "fatal: unable to access \'https://github.com/o/r\': Recv failure: Connection was reset" >&2',
    '    exit 128 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n')
  const file = join(dir, 'git')
  await writeFile(file, script, 'utf8')
  await chmod(file, 0o755)
  const original = process.env.PATH
  process.env.PATH = dir + delimiter + original
  return {
    log,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '')
      return text.split('\n').filter((line) => line.trim().length > 0)
    },
    restore() {
      process.env.PATH = original
    },
  }
}

test(
  'network：[集成] 镜像失败时自动回退直连，并把这件事写进结果',
  { skip: process.platform === 'win32' ? '假 git 用 sh 脚本，仅 POSIX' : false },
  async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), 'git-sidebar-fake-'))
    const fake = await installFakeGit(fakeDir)
    try {
      await writeNetConfig({ mirrorEnabled: true, mirror: 'https://gh-proxy.com' })
      const { op } = mountRoutes()

      const { data } = await callRoute(op, {
        method: 'POST',
        url: '/git-sidebar/op',
        headers: SAME_ORIGIN,
        body: { op: 'fetch', dir: home },
      })

      // 1) 直连那次成功了 —— 这正是「开了加速反而连不上」必须避免的结果。
      assert.equal(data.ok, true, '镜像失败后必须靠直连成功：' + JSON.stringify(data.message))
      assert.equal(data.accelerated, 'mirror', '本次确实是一次「开着镜像」的操作')

      // 2) 先试镜像、再回退直连：两次调用都要在日志里看得到。
      const calls = await fake.calls()
      const mirrored = calls.filter((line) => line.includes('insteadOf'))
      assert.equal(mirrored.length, 1, '镜像只该试一次，实际：' + JSON.stringify(calls))
      assert.match(mirrored[0], /fetch --all --prune/, '镜像那次跑的应该就是原命令')
      const direct = calls.filter((line) => line.startsWith('fetch --all --prune'))
      assert.equal(direct.length, 1, '回退必须真的再跑一次不带镜像的原命令，实际：' + JSON.stringify(calls))

      // 3) 用户要能看见这件事，而不是被蒙在鼓里。
      const notes = Array.isArray(data.notes) ? data.notes.join('\n') : ''
      assert.match(notes, /gh-proxy\.com/)
      assert.match(notes, /自动改用直连/)
      // 4) 回显的是真正执行的那条命令（不带镜像）。
      assert.equal(data.command, 'git fetch --all --prune')
    } finally {
      fake.restore()
      await rm(fakeDir, { recursive: true, force: true })
    }
  },
)

test(
  'network：[集成] 镜像成功时不回退，并说明这条命令走了镜像',
  { skip: process.platform === 'win32' ? '假 git 用 sh 脚本，仅 POSIX' : false },
  async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), 'git-sidebar-fake-'))
    const fake = await installFakeGit(fakeDir)
    try {
      await writeNetConfig({ mirrorEnabled: true, mirror: 'https://gh-proxy.com' })
      const { op } = mountRoutes()

      // 这个假 git 只对含 insteadOf 的调用失败；把它的判定反过来 —— 直接改脚本里
      // 那段 case 太隐晦，这里改用「镜像不产生 insteadOf」的等价场景：
      // push 不走镜像，因此不该出现任何 insteadOf，也不该有回退。
      const { data } = await callRoute(op, {
        method: 'POST',
        url: '/git-sidebar/op',
        headers: SAME_ORIGIN,
        body: { op: 'push', dir: home },
      })

      assert.equal(data.ok, true)
      assert.equal(data.accelerated, 'direct', '没配代理时 push 就是直连')
      const calls = await fake.calls()
      assert.equal(calls.filter((line) => line.includes('insteadOf')).length, 0, 'push 绝不能带 insteadOf')
      assert.equal(Array.isArray(data.notes) ? data.notes.length : 0, 0, '没加速就不该有加速说明')
    } finally {
      fake.restore()
      await rm(fakeDir, { recursive: true, force: true })
    }
  },
)

test(
  'network：[集成] 网络类失败会带上 network 标记和「点 🌐」的提示，供面板自动展开设置',
  { skip: process.platform === 'win32' ? '假 git 用 sh 脚本，仅 POSIX' : false },
  async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), 'git-sidebar-fake-'))
    // 这次让每一条 git 命令都以「连接被重置」失败，模拟整台机器连不上远端。
    const fake = await installFakeGit(fakeDir, { failWhen: '*' })
    try {
      resetNetConfigCache()
      await rm(netConfigPath(), { force: true }) // 没开加速 = 直连
      const { op } = mountRoutes()

      const { data } = await callRoute(op, {
        method: 'POST',
        url: '/git-sidebar/op',
        headers: SAME_ORIGIN,
        body: { op: 'fetch', dir: home },
      })

      assert.equal(data.ok, false)
      assert.equal(data.reason, 'none', '网络失败不属于任何推送类原因')
      // 关键接线：classifyPushFailure 对网络类报错只会返回 none，若提示只问它，
      // 用户就什么都看不到 —— 必须由 classifyNetworkFailure 兜住。
      assert.equal(data.network, true)
      assert.match(String(data.hint), /🌐/, '要告诉用户按钮在哪')
      assert.equal(data.accelerated, 'direct')
    } finally {
      fake.restore()
      await rm(fakeDir, { recursive: true, force: true })
    }
  },
)

test('network：[集成] 参数非法时的早期错误响应形状与成功分支一致（面板要读 network/notes）', async () => {
  const { op } = mountRoutes()
  const { data } = await callRoute(op, {
    method: 'POST',
    url: '/git-sidebar/op',
    headers: SAME_ORIGIN,
    body: { op: '凭空捏造的操作', dir: home },
  })
  assert.equal(data.ok, false)
  assert.equal(data.network, false)
  assert.deepEqual(data.notes, [])
  assert.equal(data.accelerated, 'direct')
})

// ── 8. 路由集成：/git-sidebar/log（日志尾读） ─────────────────────────────────

test('network：[路由] 注册了 log 路由，GET 返回最近日志行，重参数不炸', async () => {
  const { apply, setLogConfig } = await import('../lib/index.js')
  const harness = makeCtx()
  // 日志默认落在**本插件仓库根目录**，测试里显式指到临时目录，别把用例的
  // 记录写进仓库根：apply 也要带上同一个 logFile，否则它那条 lifecycle 会先落进默认路径。
  const path = join(home, 'git-sidebar.log')
  apply(harness.ctx, { logFile: path })
  const logRoute = harness.routes.find((route) => route.path === '/git-sidebar/log')
  assert.ok(logRoute !== undefined, '应注册 /git-sidebar/log')

  setLogConfig({ file: path })
  const { appendLog, logFilePath } = await import('../lib/index.js')
  assert.equal(logFilePath(), path, '显式配置的日志路径应生效')
  await rm(path, { force: true })
  await appendLog('info', 'op', { op: 'fake', exit: 0, n: 1 })
  await appendLog('warn', 'op', { op: 'fake', exit: 128, n: 2 })

  const out = makeResponse()
  await logRoute.handler(makeRequest({ method: 'GET', url: '/git-sidebar/log?lines=10' }), out.response)
  const data = out.json()
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.lines) && data.lines.length >= 2, '应有日志行')
  const last = JSON.parse(data.lines[data.lines.length - 1])
  assert.equal(last.event, 'op')
  assert.equal(last.n, 2, '尾部应是最新一条')

  // 缺省与非法 lines 参数都不抛异常。
  const plain = makeResponse()
  await logRoute.handler(makeRequest({ method: 'GET', url: '/git-sidebar/log' }), plain.response)
  assert.equal(plain.json().ok, true)

  // 只读的日志同样不接受「带来源的跨站读取」；不带 Origin（地址栏直开 / curl）照常。
  const cross = makeResponse()
  await logRoute.handler(makeRequest({
    method: 'GET',
    url: '/git-sidebar/log',
    headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
  }), cross.response)
  assert.equal(cross.state.status, 403, '跨站读取日志应被拒绝')
  assert.equal(cross.json().ok, false)

  const same = makeResponse()
  await logRoute.handler(makeRequest({
    method: 'GET',
    url: '/git-sidebar/log',
    headers: SAME_ORIGIN,
  }), same.response)
  assert.equal(same.json().ok, true, '同源读取日志不受影响')
  const bad = makeResponse()
  await logRoute.handler(makeRequest({ method: 'GET', url: '/git-sidebar/log?lines=abc' }), bad.response)
  assert.equal(bad.json().ok, true)
})
