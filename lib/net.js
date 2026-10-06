// dsh-git-sidebar —— 网络加速（镜像 / 代理）
// ============================================================================
// 两级加速**都只作用于单条 git 命令**（通过 git -c 注入），不写用户的 ~/.gitconfig，
// 也不写仓库的 .git/config。镜像默认关闭：请求会经过第三方，这个取舍必须由用户做。
// 配置落在 $DSH_HOME/git-sidebar-net.json（面板的 🌐 按钮读写），不走 cordis 行配置。
// ============================================================================

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runGit } from './git.js'
import { appendLog } from './log.js'
import { firstLine, maskProxy, message } from './util.js'

// ── 网络加速 ──────────────────────────────────────────────────────────────
//
// 背景：国内直连 github.com 经常连不上（典型报错 `Recv failure: Connection was
// reset`，或者干脆一直挂着直到超时）。这里提供两级加速，**都只作用于单条 git
// 命令**（通过 `git -c …` 注入），不写用户的 ~/.gitconfig，也不写仓库的
// .git/config —— 终端里的 git 行为完全不变，关掉开关就等于什么都没发生过。
//
//   1. 镜像（只读操作）：`url.<镜像>.insteadOf=https://github.com/` 让
//      clone / fetch / pull 改走第三方镜像。**实测 git 只重写传输时用的地址，
//      克隆完成后 origin 里存的仍然是原始 github URL**，因此不会污染仓库配置。
//   2. 代理（全部联网操作，含 push）：`http.proxy` / `https.proxy`。
//
// 镜像默认**关闭**，这是有意的安全取舍：请求会经过第三方，私有仓库的内容（以及
// 需要认证时携带的凭据）对它都是可见的。必须由用户显式打开，不能替他默认决定。
// ──────────────────────────────────────────────────────────────────────────

/** 网络加速配置的落盘位置。写成函数而非常量：测试可以改 DSH_HOME 后再读。 */
function netConfigPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-sidebar-net.json')
}

/**
 * 内存缓存：避免每条 git 命令都去读一次盘。
 * stamp 是配置文件的 (size, mtimeMs) 指纹 —— **另一个 dsh 进程改了这份文件时，
 * 本进程必须能看见**。原先的缓存永不失效，于是面板显示的开关和实际生效的线路
 * 会长期对不上（改了没反应 / 关了还在走镜像，两种都极难排查）。
 */
let netConfigCache = null
let netConfigStamp = null

/**
 * 候选镜像。这里**不写死「哪个能用」的结论** —— 镜像的可用性随时间和地区变化，
 * 面板上的「检测网络」按钮会在这台机器上现场实测（见 probeNetwork）。
 */
const MIRROR_CANDIDATES = [
  { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

/**
 * 会走网络的操作 —— 只有这些才可能被加速（其余操作注入参数纯属噪音）。
 *
 * `ls-remote` 是「远端默认分支兜底」的内部补查命令（见 ops.js 的 enhanceRemoteBranches），
 * 不在面板 OPS 注册表里 —— standalone 测试通过 AUX_NET_OPS 显式放行这个例外，
 * 防止那条「OPS 与 NETWORK_OPS 完全一致」的断言把内部查询误判成分叉。
 *
 * `pushUpstream` / `pushSameName` 是「本地名 ≠ 上游名」时的两条替代推送路（见 ops.js）：
 * 它们同样是联网的 push，必须和裸 push 走同一条加速/回退线路，否则开了代理的用户
 * 在失败补救里点这两条按钮反而连不上。
 */
const NETWORK_OPS = new Set(['clone', 'fetch', 'pull', 'push', 'pushUpstream', 'pushSameName', 'ls-remote'])
/**
 * 其中只读的那几个：镜像只能给它们用。push 走镜像会丢掉 origin 的凭据主体，必然认证失败。
 * ls-remote 只读 HEAD 一个引用，读的是公开元数据，镜像（或代理）同样适用。
 */
const READONLY_NET_OPS = new Set(['clone', 'fetch', 'pull', 'ls-remote'])
/** NETWORK_OPS 里不属于面板 OPS 注册表的内部命令（见上面的注释）。 */
const AUX_NET_OPS = new Set(['ls-remote'])
/**
 * 镜像只重写 GitHub 的 HTTP(S) 地址。SSH 形态（`git@github.com:…`）**故意不碰**：
 * 把它改写成 HTTPS 会同时改掉认证方式，私有仓库会因此失败 —— 这个决定不该替他做。
 */
const GITHUB_PREFIXES = ['https://github.com/', 'http://github.com/']

/** 镜像前缀 → 给人看的短名字（面板显示域名，不显示整条 URL）。 */
function mirrorLabel(prefix) {
  const text = String(prefix ?? '')
  try {
    return new URL(text).host
  } catch {
    return text
  }
}

/** 镜像地址归一化：只接受 https（镜像看得见你的仓库内容，明文 http 不能接受）。 */
function normalizeMirror(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) return ''
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

/** 代理地址归一化：只接受带协议的 http/https/socks5。 */
function normalizeProxy(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (!/^(?:https?|socks5h?):\/\/[^\s]+$/i.test(trimmed)) return ''
  return trimmed
}

/** 把任意输入压成一份合法配置：非法字段退化为默认值，而不是抛异常中断 git 功能。 */
function normalizeNetConfig(input) {
  const value = input !== null && typeof input === 'object' ? input : {}
  const mirror = normalizeMirror(value.mirror)
  // 用户没填 / 填了非法值时用第一个候选兜底。**判断开关必须用兜底后的值**：
  // 早先这里用用户填的那个空串去算，于是「只把开关打开」会被归一化成关闭 ——
  // 表现是开了加速却仍然直连，然后卡死在 github.com 上超时，极难排查。
  const effective = mirror.length > 0 ? mirror : MIRROR_CANDIDATES[0].prefix
  return {
    mirrorEnabled: value.mirrorEnabled === true,
    mirror: effective,
    proxy: normalizeProxy(value.proxy),
  }
}

/** 配置文件的 (大小, 修改时间) 指纹；文件不存在时为 null（也是一种合法状态）。 */
async function configStamp(path) {
  try {
    const info = await stat(path)
    return String(info.size) + ':' + String(info.mtimeMs)
  } catch {
    return null
  }
}

/** 读配置（带缓存 + 失效检查）。任何读取/解析失败都退化成「不加速」，绝不让 git 功能跟着挂掉。 */
async function readNetConfig() {
  const path = netConfigPath()
  const stamp = await configStamp(path)
  if (netConfigCache !== null && stamp === netConfigStamp) return netConfigCache
  try {
    netConfigCache = normalizeNetConfig(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    netConfigCache = normalizeNetConfig({})
  }
  netConfigStamp = stamp
  return netConfigCache
}

/** 写配置：先与现有配置合并，落盘，再更新缓存。落盘失败不阻断本次设置。 */
async function writeNetConfig(input) {
  const current = await readNetConfig()
  const patch = input !== null && typeof input === 'object' ? input : {}
  // proxy 为空串时 normalizeProxy 会退化成空 —— 这正是「关闭代理」的表达方式。
  const merged = normalizeNetConfig({
    mirrorEnabled: patch.mirrorEnabled === undefined ? current.mirrorEnabled : patch.mirrorEnabled,
    mirror: patch.mirror === undefined ? current.mirror : patch.mirror,
    proxy: patch.proxy === undefined ? current.proxy : patch.proxy,
  })
  netConfigCache = merged
  try {
    const path = netConfigPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    netConfigStamp = await configStamp(path)
  } catch (error) {
    // 写不进去也要让本进程内生效（用户点的那一下不能白点），只在宿主日志里说一声。
    // 注意此时 stamp 保持原样：下次读取会重新落盘确认，不会把「没写成功」当成已落盘。
    const detail = message(error)
    console.error('[git-sidebar] 网络加速配置写入失败：' + detail)
    await appendLog('error', 'net-save', { ok: false, error: detail })
  }
  return merged
}

/** 仅供测试：丢掉内存缓存，下次读取重新落盘解析。 */
function resetNetConfigCache() {
  netConfigCache = null
  netConfigStamp = null
}

/** 回给面板的配置视图：代理凭据打码，只回「有没有设」。 */
function netConfigView(config) {
  const cfg = normalizeNetConfig(config)
  return {
    mirrorEnabled: cfg.mirrorEnabled,
    mirror: cfg.mirror,
    proxy: maskProxy(cfg.proxy),
    hasProxy: cfg.proxy.length > 0,
    candidates: MIRROR_CANDIDATES.map((item) => ({ id: item.id, label: item.label, prefix: item.prefix })),
  }
}

/**
 * 计算一条 git 命令要插入的加速参数，**已经带好 `-c`**，调用方直接展开在
 * `git` 与子命令之间即可（`git <…args> <cmd>`）。
 *
 * 为什么把 `-c` 收进来：早先这里只回裸的 `key=value`，指望各调用点自己补 `-c`，
 * 结果每处都忘了补 —— git 把 `url.<…>.insteadOf=…` 当成了**子命令**，报
 * 「不是一个 git 命令」。后果极其隐蔽：加速完全没生效、全部悄悄退回直连，
 * 而面板只显示 git 那句莫名其妙的报错。把 `-c` 收在这里，调用方就没有拼错的机会。
 *
 * @param op - git 子命令名（'clone' / 'fetch' / …）。
 * @param config - 网络加速配置。
 * @param options.noMirror - 为 true 时只用代理、不用镜像（镜像失败后的回退重试用）。
 * @returns { args, mode, mirror }：mode ∈ direct | proxy | mirror | mirror+proxy。
 */
function networkExtraArgs(op, config, options = {}) {
  const command = String(op ?? '')
  if (!NETWORK_OPS.has(command)) return { args: [], mode: 'direct', mirror: false }

  const cfg = config !== null && config !== undefined ? config : {}
  const args = []
  const modes = []
  /** 追加一条 `-c key=value`。 */
  const setConfig = (key, value) => {
    args.push('-c', key + '=' + value)
  }

  const proxy = normalizeProxy(cfg.proxy)
  if (proxy.length > 0) {
    setConfig('http.proxy', proxy)
    setConfig('https.proxy', proxy)
    modes.push('proxy')
  }

  const mirror = normalizeMirror(cfg.mirror)
  const useMirror = cfg.mirrorEnabled === true && mirror.length > 0
    && READONLY_NET_OPS.has(command) && options.noMirror !== true
  if (useMirror) {
    for (const original of GITHUB_PREFIXES) {
      // 注意 base 必须是「镜像 + 原前缀」：insteadOf 做的是**前缀替换**，写成
      // `url.<镜像>.insteadOf=<原前缀>` 会得到 `https://gh-proxy.com/owner/repo`，
      // 而这类镜像要的是 `https://gh-proxy.com/https://github.com/owner/repo`。
      // 拼错的后果不是报错，而是静默地连到一个不存在的地址然后挂到超时。
      setConfig('url.' + mirror + original + '.insteadOf', original)
    }
    // 镜像不是官方线路，随时可能不通。卡住时不该让用户干等满 10 分钟：60 秒内
    // 几乎没有数据就主动中断，外层会立刻回退直连。**只给镜像这一次尝试加**，
    // 回退的直连那次不加 —— 免得误杀一个只是慢、但确实在下载的大仓库。
    setConfig('http.lowSpeedLimit', '1000')
    setConfig('http.lowSpeedTime', '60')
    modes.push('mirror')
  }

  return { args, mode: modes.length > 0 ? modes.join('+') : 'direct', mirror: useMirror }
}

/** 「检测网络」用的公开小仓库，只做 ls-remote，不下载任何内容。 */
const PROBE_URL = 'https://github.com/octocat/Hello-World'
/** 单条线路的探测上限：够慢网络握手，又不至于让按钮转太久。 */
const PROBE_TIMEOUT_MS = 8000

/**
 * 构造探测任务清单（纯函数，不触网 —— 所以「代理那条带没带 `-c`」可以直接断言）。
 *
 * 两条线路的测法不同，是有意的：
 *   - 镜像：直接把地址换成 `镜像 + 原地址` 去连，测的是**这个镜像端点通不通**。
 *   - 代理：原地址不变，靠 `-c http.proxy=…` 走代理。
 *
 * 代理那份参数**复用 `networkExtraArgs`**，绝不在这里手写 `-c key=value`：
 * 手写过一次，就漏了 `-c`，于是 git 把 `http.proxy=…` 当成子命令，
 * 「检测网络」里代理那条永远显示成一个看不懂的失败。
 */
function probeJobs(config) {
  const cfg = normalizeNetConfig(config)
  // 「直连」那条必须**真的是直连**：`~/.gitconfig` 里如果配了 http.proxy（或全局
  // insteadOf），不显式清掉的话，测出来的「直连 github.com 通」其实是代理在通 ——
  // 用户于是关掉面板的加速、回到终端却依然连不上，而探测结果说一切正常。
  // 空值即「这条命令不用代理」，与 networkExtraArgs 一样只作用于本次调用。
  const directArgs = ['-c', 'http.proxy=', '-c', 'https.proxy=']
  const jobs = [{ kind: 'direct', label: '直连 github.com', url: PROBE_URL, args: directArgs }]
  for (const mirror of MIRROR_CANDIDATES) {
    jobs.push({ kind: 'mirror', label: mirror.label, url: mirror.prefix + PROBE_URL, args: [] })
  }
  // 只传 proxy：镜像那条已经单独测过了，这里再叠一层反而说不清是哪一段起作用。
  const proxyArgs = networkExtraArgs('fetch', { proxy: cfg.proxy }).args
  if (proxyArgs.length > 0) {
    jobs.push({ kind: 'proxy', label: '代理 ' + maskProxy(cfg.proxy), url: PROBE_URL, args: proxyArgs })
  }
  return jobs
}

/**
 * 现场实测每条线路，让用户知道「这台机器上哪条路通」。
 * 几条线路并发跑，所以「耗时」是参考值而不是精确延迟 —— 用来排序足够了。
 */
async function probeNetwork(config) {
  // 在临时目录里跑：宿主的 cwd 有可能已经被删掉（换工作时清理过目录），而在某个
  // 仓库里跑又会受那个仓库的本地 git 配置影响 —— 探测要测的是「这台机器通不通」，
  // 不该被这两件事干扰。
  const cwd = tmpdir()

  return Promise.all(probeJobs(config).map(async (job) => {
    const started = Date.now()
    const result = await runGit([...job.args, 'ls-remote', job.url, 'HEAD'], cwd, { timeoutMs: PROBE_TIMEOUT_MS })
    const ms = Date.now() - started
    const ok = result.code === 0 && result.stdout.trim().length > 0
    return {
      kind: job.kind,
      label: job.label,
      ok,
      ms,
      error: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    }
  }))
}

export {
  netConfigPath, MIRROR_CANDIDATES, NETWORK_OPS, READONLY_NET_OPS, AUX_NET_OPS, GITHUB_PREFIXES,
  mirrorLabel, normalizeMirror, normalizeProxy, normalizeNetConfig,
  readNetConfig, writeNetConfig, resetNetConfigCache, netConfigView, networkExtraArgs,
  PROBE_URL, PROBE_TIMEOUT_MS, probeJobs, probeNetwork,
}
