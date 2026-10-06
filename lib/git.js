// dsh-git-sidebar —— git 执行与输出解析
// ============================================================================
// 用 child_process.execFile + 参数数组执行 git，**不经过 shell**：路径/提交信息里
// 的引号、空格、分号都不构成注入面。非零退出不抛异常，归一化成
// { code, stdout, stderr }（code === -1 表示进程没能启动）。
// 解析函数都是纯函数，porcelain / branch / remote / rev-list 的格式集中在这里。
//
// 每条命令统一带上三个「输出卫生」开关（见 runGit）：
//   --no-pager             不进分页器（子进程没有 TTY，但旧 git 仍可能试图分页）
//   -c color.ui=false      输出永不带 ANSI 颜色码，解析不依赖用户的 color 配置
//   -c core.quotePath=false 中文/空格路径**原样**输出 —— git 默认会把非 ASCII 路径
//                          C-quote 成八进制（"lib/\346\226\207\346\241\243.js"），
//                          每一个 diff 表面都会把那串转义当文件名渲染给用户。
// ============================================================================

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'
import { appendLog } from './log.js'
import { displayArgv, firstLine, message, normalizeDir } from './util.js'

/**
 * 把 execFile 变成 promise 形态。
 *
 * 注意：这一行在 0.10 的模块拆分里**曾经漏掉**，而当时能覆盖它的用例（真 git、
 * POSIX 假 git）在受限沙箱里全被跳过 —— 于是 `runGit` 每次都以
 * `code: -1 / stderr: 'execFileAsync is not defined'` 返回，面板和工具全部失灵，
 * 而 143 个用例仍然全绿。放开沙箱、真跑一次 git 立刻暴露。
 * 这也是为什么 README 把「换机器先跑一次 npm test」写成第一道回归。
 */
const execFileAsync = promisify(execFile)

/** git 输出缓冲上限（8 MiB）与默认超时。 */
const MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120000

/** 本地（不联网）git 查询的默认超时：状态、分支、远程列表这类都是毫秒级。 */
const GIT_LOCAL_TIMEOUT_MS = 20000

/** 一次状态读取最多回给面板的改动条数（真实总数另由 changesTotal 回传，不静默截断）。 */
const MAX_STATE_CHANGES = 100

/**
 * 远端跟踪引用的前缀。集中成常量：解析「每个远程的默认分支」（parseRemoteHeads）
 * 时要用它切出远程名，而那段切法一旦写错会静默给出**别的远程**的分支名
 * （比 `origin` 切成空、或者把 `upstream/main` 认成远程 `upstream` 的写法）。
 */
const REMOTE_REF_PREFIX = 'refs/remotes/'

/** git 命令缺失（spawn ENOENT 等）时给可读提示，而不是把英文报错原样甩给用户。 */
function gitMissingMessage(result) {
  if (result === null || result === undefined) return null
  if (result.code !== -1) return null
  if (/ENOENT|not found/i.test(String(result.stderr))) {
    return '未检测到 git：请先安装 git（https://git-scm.com）后重试。'
  }
  return null
}

/**
 * spawn 失败时的 stderr 文案。
 *
 * `spawn git ENOENT` 有两个完全不同的原因，而 Node 给的错误对象**一模一样**
 * （实测：code=ENOENT、errno=-4058、syscall='spawn git'、path='git'）：
 * 一是没有 git 可执行文件，二是 `cwd` 这个目录不存在。
 * 后者若照原样交给 gitMissingMessage，用户在面板里敲错一个路径就会被要求
 * 「请先安装 git」—— 实测就是这个误导。所以这里对 cwd 做一次探测，
 * 而且**只在失败路径上**做（正常调用不付任何代价）。
 */
function spawnFailureText(raw, cwd) {
  const detail = message(raw)
  // cwd 不存在时 execFile 报 ENOENT；cwd 是一个**文件**时系统不同给 errno 也不同
  // （Linux 报 ENOTDIR、部分 macOS 报 EISDIR、个别平台仍报 ENOENT）——三种都要
  // 认出来走进下面的 stat 分流，否则「把 cwd 指向文件」会被翻译成一段看不懂的
  // `spawn git ENOTDIR`（实测 WSL 上就是这个）。
  if (!/ENOENT|ENOTDIR|EISDIR|not found/i.test(detail)) return detail
  if (typeof cwd !== 'string' || cwd.length === 0) return detail
  let stats = null
  try {
    stats = statSync(cwd)
  } catch {
    stats = null
  }
  if (stats === null) return '目录不存在或无法进入：' + cwd
  if (!stats.isDirectory()) return '这不是一个目录：' + cwd
  return detail
}

// ── git 执行 ──────────────────────────────────────────────────────────────

/**
 * `child_process` 是否支持 `signal` 选项（Node 15.4.0 起）。
 * 更老的 Node 会把 signal 当成"未知选项"直接让每次 git 调用失败，
 * 所以这里探测一次：不支持就不传 signal（代价只是取消传播失效，功能仍可用）。
 * 注意：DSH 本身要求 Node ^22.19.0 || >=24，这只是换机器时的额外兜底。
 */
const SUPPORTS_EXEC_SIGNAL = (() => {
  const [major = 0, minor = 0] = String(process.versions?.node ?? '0').split('.').map((part) => Number.parseInt(part, 10))
  return Number.isFinite(major) && (major > 15 || (major === 15 && minor >= 4))
})()

/**
 * 每条 git 命令的前置参数：分页 / 颜色 / 路径转义三个输出卫生开关。
 *
 * 为什么放在 runGit 而不是逐个调用点：这三条只影响**输出格式**，不影响任何一条
 * 命令的语义，放调用点必然漏（新增操作时谁也想不起来）。放在最前，所有命令
 * （包括模型工具走的 argv）都自动获得一致的机器可读输出。
 *
 * `core.quotePath=false` 的现场：中文文件名在 git 默认输出里是
 * `"lib/\346\226\207\346\241\243.js"` —— porcelain、diff、log 全都如此。关掉转义后
 * 路径原样出现，解析端**不需要**任何 unquote 逻辑（unquote 要还原八进制、双引号
 * 与 C 风格转义三套规则，漏一种就显示成乱码）。
 */
const OUTPUT_HYGIENE_ARGS = [
  '--no-pager',
  '-c', 'color.ui=false',
  '-c', 'core.quotePath=false',
]

/**
 * 以参数数组方式执行 git。
 * 非零退出与 spawn 失败都被归一化成结果对象，调用方按 code 判断。
 * @param argv - git 子命令与参数（不含开头的 "git"）。
 * @param cwd - 执行目录（git 的 -C 语义由 cwd 提供）。
 * @param options.timeoutMs - 超时毫秒数。
 * @param options.signal - 可选取消信号。
 * @returns { code, stdout, stderr }；code 为 -1 表示进程未能启动。
 */
async function runGit(argv, cwd, options = {}) {
  const startedAt = Date.now()
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  // 卫生参数插在最前（git 的全局选项必须落在子命令之前）；日志记的仍是
  // 调用方传入的 argv —— 那才是「这次跑的是什么 git 命令」的答案。
  const fullArgv = [...OUTPUT_HYGIENE_ARGS, ...argv]
  let result
  try {
    const execResult = await execFileAsync('git', fullArgv, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      ...(SUPPORTS_EXEC_SIGNAL && options.signal !== undefined ? { signal: options.signal } : {}),
    })
    result = { code: 0, stdout: String(execResult.stdout ?? ''), stderr: String(execResult.stderr ?? '') }
  } catch (error) {
    const raw = error ?? {}
    // 超时/被信号杀掉时 execFile 给不出退出码，必须先于下面的 code 判断归一化：
    // 否则「10 分钟没响应」和「git 报错退出」在调用方看来长得一样，网络加速的
    // 自动回退与「检测网络」的耗时提示就无法区分这两种情况。
    if (raw.killed === true || (raw.code === undefined && raw.signal !== undefined && raw.signal !== null)) {
      const detail = firstLine(String(raw.stderr ?? ''))
      result = {
        code: -1,
        stdout: String(raw.stdout ?? ''),
        stderr: '命令超时（' + timeoutMs + 'ms 内无响应）' + (detail.length > 0 ? '：' + detail : ''),
      }
    } else if (typeof raw.code === 'number') {
      result = { code: raw.code, stdout: String(raw.stdout ?? ''), stderr: String(raw.stderr ?? '') }
    } else {
      result = { code: -1, stdout: '', stderr: spawnFailureText(raw, cwd) }
    }
  }
  // 每条 git 命令都留痕（debug 级：面板每次刷新状态就会跑几条，不该占 info 额度）：
  // argv 经 displayArgv 打码，代理凭据不会进日志。
  appendLog('debug', 'git', {
    argv: displayArgv(argv),
    dir: cwd ?? null,
    exit: result.code,
    ms: Date.now() - startedAt,
    timeoutMs,
  })
  return result
}

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * NUL 分帧的形状（每条目两个 token，重命名三个）：
 *   `XY <path>\0`                 —— 普通条目（含 `??` 未跟踪）；
 *   `XY <new>\0<orig>\0`          —— 重命名/复制（X 或 Y 是 R/C）：第二个 token
 *                                    是**原始路径**，只用来配对，不作为显示路径
 *                                    （显示的应是文件现在的名字）。
 *
 * 为什么不用按行切分：porcelain 的路径字段本身允许空格与换行，按 '\n' 切会把
 * 「文件名里有换行」的仓库切出根本不存在的条目。NUL 帧里不可能有歧义。
 *
 * @param stdout - runGit 的 stdout（-z 输出）。
 * @returns [{ code, path, staged }]，与旧的按行解析同形。
 */
function parseStatusZ(stdout) {
  const tokens = String(stdout ?? '').split('\0')
  const entries = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === undefined || token.length < 4) continue
    // `-b` 的分支行（`## master...origin/master [ahead 1]`）也是一帧：它不是改动
    // 条目，交给 parseBranchLine（调用方在逐帧循环里分派），这里跳过。
    if (token.startsWith('## ')) continue
    const code = token.slice(0, 2)
    const path = token.slice(3)
    if (path.length === 0) continue
    // R/C 条目多带一个「原始路径」token：消费掉，防止它被当成下一条目的 XY。
    if ((code.charAt(0) === 'R' || code.charAt(0) === 'C' || code.charAt(1) === 'R' || code.charAt(1) === 'C')
      && index < tokens.length && tokens[index].length > 0) {
      index += 1
    }
    entries.push({
      code,
      path,
      // X = 暂存区、Y = 工作区。'?'（未跟踪）不算已暂存 —— 它还没有任何暂存内容。
      staged: code.charAt(0) !== ' ' && code.charAt(0) !== '?',
    })
  }
  return entries
}

/**
 * 解析 porcelain 的 `## ` 分支行。
 * 例：`## main...origin/main [ahead 1, behind 2]`、`## HEAD (no branch)`。
 * @returns { branch, upstream, ahead, behind }
 */
function parseBranchLine(line) {
  const rest = line.slice(3)
  let body = rest
  let ahead = 0
  let behind = 0
  const bracket = rest.indexOf(' [')
  if (bracket >= 0) {
    body = rest.slice(0, bracket)
    const tracking = rest.slice(bracket)
    const count = (word) => {
      const match = new RegExp(word + ' (\\d+)').exec(tracking)
      return match === null ? 0 : Number(match[1]) || 0
    }
    ahead = count('ahead')
    behind = count('behind')
  }
  if (body.indexOf('...') >= 0) {
    const parts = body.split('...')
    return { branch: parts[0], upstream: parts[1] ?? null, ahead, behind }
  }
  // 尚无提交时 porcelain 给 `## No commits yet on main`，分支名在最后；
  // 游离 HEAD 给 `## HEAD (no branch)`，分支名在最前。
  const words = body.split(' ')
  if (words[0] === 'No') return { branch: words[words.length - 1] ?? null, upstream: null, ahead, behind }
  return { branch: words[0] ?? null, upstream: null, ahead, behind }
}

/** 解析 `git remote -v` 的输出，返回 [{ name, url }]（只取 fetch 行，按名称排序）。 */
function parseRemotes(stdout) {
  const order = []
  const seen = new Set()
  for (const line of String(stdout).split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const columns = text.split(/\s+/)
    if (columns.length < 3) continue
    if (columns[2] !== '(fetch)') continue
    if (seen.has(columns[0])) continue
    seen.add(columns[0])
    order.push({ name: columns[0], url: columns[1] })
  }
  return order.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * 找出「两个远程指向同一个地址」的情况（面板据此给一行提示 + 一键删多余的）。
 *
 * 冗余本身不致命，但它会实打实地制造歧义：`git branch -a` 里同一份东西出现两遍
 * （`origin/main` 与 `main/main`），而**远程名还可能和本地分支名撞在一起** —— 远程
 * 叫 `main` 时，`git log main` / `git branch -D main` 这类命令会开始报
 * `warning: refname 'main' is ambiguous`（本次现场就是如此，最后只能把多余的远程删掉）。
 *
 * 保留 origin（约定俗成、也是 git clone 的默认名），其余算「可删」—— 这个判断只决定
 * 按钮建议删哪个，删不删由用户在确认框里决定。
 *
 * @param remotes - parseRemotes 的结果。
 * @returns [{ url, keep, remove: [名字…] }]；没有重复时返回 []。
 */
function duplicateRemotes(remotes) {
  const list = Array.isArray(remotes) ? remotes : []
  const byUrl = new Map()
  for (const item of list) {
    if (item === null || item === undefined || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (name.length === 0 || url.length === 0) continue
    const bucket = byUrl.get(url)
    if (bucket === undefined) byUrl.set(url, [name])
    else bucket.push(name)
  }
  const groups = []
  for (const [url, names] of byUrl) {
    if (names.length < 2) continue
    const keep = names.includes('origin') ? 'origin' : names[0]
    groups.push({ url, keep, remove: names.filter((name) => name !== keep) })
  }
  return groups
}

/**
 * 配置推送目标的决策：同名远程已存在就改地址，不存在才新增。
 * 面板的 setRemote 与 AI 工具 git_remote action=set 共用，保证两条路径行为一致。
 * @param listedStdout - `git remote` 的输出（每行一个远程名）。
 */
function remoteOpFor(name, url, listedStdout) {
  const exists = String(listedStdout ?? '').split('\n').some((line) => line.trim() === name)
  return exists ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url]
}

/**
 * 由仓库地址推导 git clone 的默认目标目录名（与 git 行为一致：取路径最后一段、去掉 .git）。
 * 支持 https://…、git://… 与 scp 风格 git@host:path/to/repo.git。
 */
function cloneTargetName(url) {
  try {
    const text = String(url ?? '')
    let path = text
    try {
      path = new URL(text).pathname
    } catch {
      // scp 语法（git@host:path/to/repo.git）：冒号后到结尾就是路径。
      const at = text.indexOf(':')
      if (at >= 0 && at < text.length - 1) path = text.slice(at + 1)
      else path = text
    }
    const base = decodeURIComponent(path.split(/[\\/]/).filter(Boolean).pop() ?? '')
    const name = base.replace(/\.git$/, '')
    if (name.length > 0) return name
  } catch {
    /* 非 URL 时 git 自行决定目标名，这里退化为占位名 */
  }
  return 'repository'
}

/**
 * 由远程仓库地址推导「在浏览器里打开仓库主页」的 URL（面板「仓库页 ↗」入口）。
 *
 * 支持 https / http / git / ssh 协议与 scp 风格（git@host:path）地址，统一转成
 * https 页面地址并去掉结尾的 .git；query / hash 不保留。推导不出来（本地路径、
 * file://、空串、主机或路径缺失等）返回 null —— 面板据此决定是否显示入口，
 * 宁可少一个按钮，也不能给出一个打不开的链接。
 */
function repoPageUrl(url) {
  const text = String(url ?? '').trim()
  if (text.length === 0) return null
  let host = null
  let path = ''
  if (text.includes('://')) {
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    const scheme = parsed.protocol.replace(/:$/, '')
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'git' && scheme !== 'ssh') return null
    host = parsed.hostname
    path = parsed.pathname
    if (parsed.port !== '') host = host + ':' + parsed.port
  } else {
    // scp 风格 git@host:path/to/repo.git —— 没有协议头，冒号前是 user@host。
    const colon = text.indexOf(':')
    if (colon <= 0) return null
    const authority = text.slice(0, colon)
    const at = authority.lastIndexOf('@')
    const candidateHost = at >= 0 ? authority.slice(at + 1) : authority
    if (candidateHost.length === 0 || candidateHost.includes('/') || candidateHost.includes('\\')) return null
    path = text.slice(colon + 1)
    // Windows 盘符路径（C:\…）冒号后是反斜杠，不是 scp 路径；别当主机解析。
    if (path.startsWith('/') || path.startsWith('\\')) return null
    host = candidateHost
  }
  if (host === null || host.length === 0 || path.length === 0) return null
  // 去掉结尾的 .git（大小写不敏感，可带尾部斜杠）与多余的尾部斜杠。
  let clean = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  if (clean.length === 0) return null
  // scp 风格的路径没有开头的斜杠（git@host:user/repo），拼 https 地址时要补上。
  if (!clean.startsWith('/')) clean = '/' + clean
  return 'https://' + host + clean
}

/**
 * 解析 `git branch --no-color` 的输出（面板的分支管理器用）。
 *  `* main`      —— 当前分支
 *  `  feature/x` —— 其他本地分支
 *  游离 HEAD 的 `(HEAD detached at …)` 伪条目跳过（不能按名字切换，面板另有展示）。
 *
 * 这里**只**解析本地列表本身。每条分支对应的上游是另一份数据（见
 * parseBranchUpstreams），两者在客户端按名字合并 —— 保持这个函数是纯函数，
 * 不依赖命令执行顺序，单独测试也不会被 for-each-ref 的输出格式牵连。
 * @returns { current, items }；current 为 null 表示游离 HEAD 或还没有分支。
 */
function parseBranchOutput(stdout) {
  const items = []
  let current = null
  for (const line of String(stdout).split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const name = text.replace(/^\*\s+/, '').trim()
    if (name.startsWith('(') && name.endsWith(')')) continue
    const isCurrent = line.startsWith('*')
    items.push({ name, current: isCurrent })
    if (isCurrent) current = name
  }
  return { current, items }
}

/**
 * 解析本地分支的**上游跟踪关系**（面板「本地分支」每行那句「→ origin/master」）。
 *
 * 为什么用 for-each-ref 而不是 `git branch -vv`：`-vv` 的输出是给人看的对齐文本
 * （上游夹在名字和提交标题之间，方括号里还混着领先/落后），列宽随内容变，名字里
 * 出现方括号时无法可靠切分。for-each-ref 用 `%09`（制表符）分隔 —— 分支名里
 * 不可能有制表符，切分是确定的。
 *
 * 为什么 ahead/behind 两种文案都认：`%(upstream:track)` 是**本地化文本**
 * （英文 `[ahead 1, behind 2]`、中文 `[领先 1、落后 2]`），跟着用户的 git locale 走。
 * 认不出来时保持 0（界面只是不显示领先数），绝不猜一个错的数字。
 *
 * @param stdout - for-each-ref 的输出；每行 `名字\t上游\t跟踪摘要`。
 * @returns 普通对象 { 分支名: { upstream, ahead, behind } }（要过 JSON，不能用 Map）。
 */
function parseBranchUpstreams(stdout) {
  const table = {}
  for (const line of String(stdout).split('\n')) {
    if (line.length === 0) continue
    const columns = line.split('\t')
    const name = (columns[0] ?? '').trim()
    if (name.length === 0) continue
    const upstream = (columns[1] ?? '').trim()
    const track = (columns[2] ?? '').trim()
    // 英文 ahead/behind 与中文 领先/落后 都认；两种都匹配不到就都是 0。
    const count = (word, alt) => {
      const match = new RegExp(word + ' (\\d+)').exec(track)
        ?? new RegExp(alt + ' *(\\d+)').exec(track)
      return match === null ? 0 : Number(match[1]) || 0
    }
    table[name] = {
      upstream: upstream.length > 0 ? upstream : null,
      ahead: count('ahead', '领先'),
      behind: count('behind', '落后'),
      // `[gone]`：上游分支在远端被删了（别人删的、或 PR 合并后删的）。这时
      // `%(upstream:short)` 仍然给出名字，但那个远端分支已经不存在 —— 面板必须
      // 说清楚，否则用户看着「→ origin/feature」以为一切正常，一推送才发现
      // `remote ref does not exist`。同理「本地名 ≠ 上游名」也在这里报出来，
      // 但那件事已有专门的判定（见 client.js 的 upstreamShortName），不重复。
      gone: /\[gone\]/.test(track),
    }
  }
  return table
}

/**
 * 解析 `git branch --remotes --no-color` 的输出（面板「管理」里的远端分支分组）。
 *
 * 两种行，必须分开处理：
 *   `origin/HEAD -> origin/main` —— 远程的默认分支指针，**不是一个能拉的分支**；
 *   `origin/main`                —— 真正的远端分支。
 *
 * 为什么要列出来：本地 `git init` 出来的分支叫 master、远端默认分支叫 main 时，
 * 面板原先只看本地分支，用户既看不到 origin/main，也没有任何入口去点它 ——
 * 「远端有 main 而我没有」这件事在界面上完全不存在（见 pullRemoteDefaultBranch）。
 *
 * @returns { items: [{ remote, name, ref, head }], defaultRef }；items 按 ref 排序。
 */
function parseRemoteBranchOutput(stdout) {
  const items = []
  let defaultRef = null
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const arrow = text.indexOf(' -> ')
    if (arrow >= 0) {
      const alias = text.slice(0, arrow).trim()
      if (alias.endsWith('/HEAD')) {
        const target = text.slice(arrow + 4).trim()
        if (target.length > 0) defaultRef = target
      }
      continue
    }
    const slash = text.indexOf('/')
    if (slash <= 0 || slash >= text.length - 1) continue
    const remote = text.slice(0, slash)
    const name = text.slice(slash + 1)
    if (name === 'HEAD') continue
    items.push({ remote: remote, name: name, ref: remote + '/' + name, head: false })
  }
  for (const item of items) {
    if (item.ref === defaultRef) item.head = true
  }
  items.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
  return { items: items, defaultRef: defaultRef }
}

/**
 * 解析 `git for-each-ref --format=%(refname)%09%(symref)` 的输出，得到**每个远程各自的
 * 默认分支**（`{ origin: 'main', fork: 'master' }`）。
 *
 * pattern 见 readState 里的调用：限定到 `refs/remotes/` 下**任意深度**的 `HEAD`
 * （用 `**` 而不是 `*`，因为远程名自己可以含斜杠，详见那里的注释）。这段解析本身
 * 只认「两列、ref 以 /HEAD 结尾、且 symref 指向同一个远程下的分支」的行。
 *
 * 为什么要这份数据：面板要能一眼说清「拉这个远程的哪一条」。多远程下它们常常**不一样**
 * —— 别人的上游（`origin`）默认分支是 `master`，你自己的 fork（`fork`）默认分支也叫
 * `master`，但你的工作分支叫 `local.2`：于是「拿上游更新」这件事必须点名
 * 「origin 的默认分支是谁」，而不能拿某个全局的「默认分支」去套所有远程。
 *
 * 为什么用本地引用而不是再问一次服务器：`refs/remotes/&lt;远程&gt;/HEAD` 这个符号引用就是
 * 上次 fetch 时服务器告诉我们的答案（clone 一定会建立它；`git fetch --all` 也会补）。
 * 读它是一条**纯本地**命令（毫秒级、不碰网络），而 `ls-remote` 每次都要一次网络往返 ——
 * 面板每次读状态都跑它，代价完全不成比例。本地确实没有这个引用时（老版 git 手动加的远程、
 * 镜像源不导出 HEAD）就拿不到，由调用方按「不知道」处理（面板照旧能拉，只是不预选分支）。
 *
 * @returns 普通对象 { 远程名: 分支名 }（要过 JSON，不能用 Map）。读不出来的远程不出现。
 */
function parseRemoteHeads(stdout) {
  const table = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const columns = line.trim().split('\t')
    if (columns.length < 2) continue
    const ref = columns[0].trim()
    const symref = columns[1].trim()
    if (!ref.startsWith(REMOTE_REF_PREFIX) || !ref.endsWith('/HEAD')) continue
    const remote = ref.slice(REMOTE_REF_PREFIX.length, ref.length - '/HEAD'.length)
    if (remote.length === 0) continue
    const head = REMOTE_REF_PREFIX + remote + '/'
    if (!symref.startsWith(head)) continue
    const branch = symref.slice(head.length)
    // `origin/HEAD -> origin/HEAD` 这种自指（异常仓库）不是分支名，跳过。
    if (branch.length === 0 || branch === 'HEAD' || branch.endsWith('/HEAD')) continue
    if (table[remote] === undefined) table[remote] = branch
  }
  return table
}

/**
 * 解析 `git ls-remote --symref <远程> HEAD` 的输出，取「远程自己声明的默认分支」。
 *
 * 期望首行是符号引用行 `ref: refs/heads/master\tHEAD`；服务器不支持 --symref（或
 * 只回 `git ls-remote HEAD` 的裸哈希行 `<sha>\tHEAD`）时解析不出分支名 → null，
 * 调用方照旧显示，绝不因此中断列表。
 * @returns 分支名（如 'master'），解析不出来返回 null。
 */
function parseLsRemoteHead(stdout) {
  const first = String(stdout ?? '').split('\n')[0] ?? ''
  const match = /^ref:\s*refs\/heads\/([^\s]+)\s+HEAD$/.exec(first.trim())
  return match === null ? null : match[1]
}

/**
 * 远端引用能不能安全地当参数交给 git。
 *
 * 面板把远端分支的 ref 原样回传给宿主（compare / adoptRemote），所以这是一道
 * **输入校验**：以 `-` 开头会被 git 当成选项，含 `..` 会把单个引用变成一条区间，
 * 含空白 / `~` / `^` / `:` 的也不是真的分支名。
 */
function isSafeRemoteRef(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text.length > 200) return false
  if (text.startsWith('-')) return false
  if (/[\s~^:?*\\[\]]/.test(text)) return false
  if (text.includes('..') || text.includes('@{')) return false
  if (text.startsWith('/') || text.endsWith('/') || text.endsWith('.lock')) return false
  return true
}

/**
 * `git push` 的**第一个位置参数**（远程名，也可能是仓库地址）能不能安全地交给 git。
 *
 * 为什么不能复用 isSafeRemoteRef（那是给「远端分支引用」用的）：`git push` 的第一个位置
 * 参数在 git 眼里是「仓库」，它本来就接受 URL 与本地路径 —— `https://…`、`git@host:path`、
 * `../other.git`、`D:\repos\x.git`。用分支名的规则去套，这些形状会被一条
 * 「远程名不合法」全部拒掉（它们是**以前能用的**输入形状，属于回归）。
 *
 * 真正要拦的只有两类：
 *   1. 以 `-` 开头 —— 会被 git 当成选项（参数注入）；
 *   2. `proto::` 形态 —— 那是 git 的远程助手语法（`ext::sh -c …` 会让 git 去执行命令），
 *      合法地址用的是 `://` 或单个冒号，不会出现 `::`；
 * 外加空白 / 控制字符（那种东西只可能来自程序拼错，用户手输的远程名与地址里不会有）。
 */
function isSafePushTarget(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text.length > 2048) return false
  if (text.startsWith('-')) return false
  if (text.includes('::')) return false
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return false
  return true
}

/**
 * 解析 `git rev-list --left-right --count HEAD...<ref>` 的输出。
 *
 * 两列：左边 = 「HEAD 有、ref 没有」= 本地领先；右边 = 「ref 有、HEAD 没有」= 本地落后。
 * 解析不出来时都算 0：面板宁可不说，也不能报一个假数字。
 * @returns { ref, ahead, behind }
 */
function parseCompareOutput(stdout, ref) {
  const columns = String(stdout ?? '').trim().split(/\s+/).filter((part) => part.length > 0)
  const ahead = columns.length > 0 ? Number.parseInt(columns[0], 10) : 0
  const behind = columns.length > 1 ? Number.parseInt(columns[1], 10) : 0
  return {
    ref: typeof ref === 'string' ? ref : '',
    ahead: Number.isFinite(ahead) && ahead > 0 ? ahead : 0,
    behind: Number.isFinite(behind) && behind > 0 ? behind : 0,
  }
}

/**
 * 这条 porcelain 状态码是不是「合并冲突」现场。
 *
 * UU（双方都改）、AA（双方都新增）、DD（双方都删除）——还有 AU/UA/DU/UD 这些
 * 一侧动作 + 一侧未合并的组合，凡是 X 或 Y 里出现 U 都该算：它们都是
 * `git status` 里「Unmerged paths」一节的东西。检测它不是为了解决冲突
 * （解决要人来），而是**让面板一打开就说出这句话**：现在状态列表里那几行
 * 只显示 `UU 路径`，不懂 git 的用户完全不知道这意味着「先改好再 add」。
 */
function isConflictCode(code) {
  const text = String(code ?? '')
  return text.includes('U') || (text.charAt(0) === 'A' && text.charAt(1) === 'A')
    || (text.charAt(0) === 'D' && text.charAt(1) === 'D')
}

/**
 * 非仓库（或读取失败）时的状态骨架。
 *
 * **只有这一处**定义「一个状态对象长什么样」：readState 的非仓库分支与
 * 路由的异常分支原先各手写一份 11 个字段的字面量，加一个字段就会漏一处。
 * notice 是给用户看的诊断（未装 git / 读取失败 / 还不是仓库），面板直接渲染它。
 */
function emptyState(notice, dir = null, ok = true) {
  return {
    ok,
    dir,
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    changesTotal: 0,
    // 合并冲突的文件路径列表（来自 porcelain 的 UU/AA/DD 条目）。空 = 没有冲突。
    conflicts: [],
    log: [],
    remotes: [],
    duplicateRemotes: [],
    // 非仓库时没有任何远程，表是空的（形状必须与 readState 一致：客户端读 undefined
    // 只会当成「旧宿主」，那种分支不该被一个空态触发）。
    remoteHeads: {},
    pageUrl: null,
    notice,
  }
}

/**
 * 「这个目录不是工作区」时给用户看的那句话。
 *
 * **客户端会拿 NOT_REPO_NOTICE 去重**（见 client.js 的 EmptyState：它自己已经写了
 * 「还不是 Git 仓库」，不该再叠一遍同样的字），所以宿主必须发**同一个字符串**。
 * 这条耦合原先断了：宿主把 git 的英文原文
 * `fatal: not a git repository (or any of the parent directories): .git` 原样发出去，
 * 客户端的 `notice !== '当前目录还不是 Git 仓库'` 因此永远为真 —— 去重分支是死代码，
 * 用户看到的是中英各一句。现在由 test/standalone.test.mjs 钉住两边一致。
 *
 * 四种情况必须分开，否则用户会被指去修错的东西：
 *   1. git 没装 → 安装提示；
 *   2. 目录不存在 / 不是目录 → 路径问题（见 spawnFailureText）；
 *   3. 目录在但不在任何工作区里 → NOT_REPO_NOTICE；
 *   4. 裸仓库或位于 .git 内部 → rev-parse **成功**却回答 false，
 *      此前与「完全没有仓库」共用一句话（说裸仓库「还不是 Git 仓库」并不准确）。
 */
const NOT_REPO_NOTICE = '当前目录还不是 Git 仓库'
const BARE_REPO_NOTICE = '这里没有工作区（裸仓库或 .git 内部）：请选择工作区目录'
// git 的「不是仓库」报错文案随系统语言走：英文 `not a git repository` / 中文
// `不是 Git 仓库`（实测中文 locale 下 rev-parse 就是这么报的）。只认英文的话，
// 中文环境会漏掉去重分支，用户看到中英各一句（standalone 测试钉住这个契约）。
const NOT_REPO_PATTERN = /not a git repository|not a git repo|not a working (tree|copy)|不是.{0,8}git.{0,2}仓库/i

function notRepoNotice(probe) {
  const missing = gitMissingMessage(probe)
  if (missing !== null) return missing
  // rev-parse 成功但明确回答「不是工作区」= 裸仓库 / .git 内部。
  if (probe.code === 0 && String(probe.stdout).trim() === 'false') return BARE_REPO_NOTICE
  const detail = firstLine(String(probe.stderr ?? ''))
  if (NOT_REPO_PATTERN.test(detail)) return NOT_REPO_NOTICE
  return detail.length > 0 ? detail : NOT_REPO_NOTICE
}

/**
 * 读取一个目录的仓库状态（面板与工具共用）。
 * 永不抛异常：任何失败都折成 notice 字段返回，保证面板总能渲染。
 */
async function readState(dir) {
  const startedAt = Date.now()
  const shown = normalizeDir(dir) ?? null
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const isRepo = probe.code === 0 && probe.stdout.trim() === 'true'
  if (!isRepo) {
    const state = emptyState(notRepoNotice(probe), shown)
    appendLog('debug', 'state', { dir: shown, isRepo: false, ms: Date.now() - startedAt })
    return state
  }

  // 注意：`git status` 不接受 --no-color（与 log/branch/diff 不同）；
  // porcelain 格式本身无色，因此这里不能带该选项，否则命令直接报错、改动列表永远为空。
  //
  // `-z`（NUL 分帧）比按行切分稳：porcelain 的路径字段本身允许换行与空格，按 '\n'
  // 切会把「文件名里有换行」的仓库切出根本不存在的条目。`-z` 下重命名条目（R/C）
  // 的原始路径跟在 NUL 后面 —— 与 better-sidebar 的 parsePorcelainZ 同一套处理。
  const [status, log, remotesResult, headsResult] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-z', '-b', '--', '.'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(['log', '--oneline', '--decorate=short', '--no-color', '-n', '8'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    // 每个远程的默认分支（`origin/HEAD -> origin/main`）。与上面三条**并发**跑，
    // 所以这次状态读取的墙钟时间由最慢的那一条决定，不叠加。它是纯本地查询
    // （读已有的符号引用，不碰网络），面板的「拉取自」要按它列出「从 origin/master 拉」。
    //
    // pattern 用 `**` 而不是 `*`：**远程名自己可以含斜杠**（`git remote add a/b <url>`
    // 是合法的，实测能配上）。`refs/remotes/*/HEAD` 只匹配一层，于是名为 `a/b` 的远程
    // 那个 HEAD 会被**静默漏掉** —— 面板于是拿不到它的默认分支（退回「拉同名那条」，
    // 功能上安全，但那本来是个能答出来的问题）。`**` 匹配任意深度，一层到多层的远程
    // 都能读到；而 **`a/b/HEAD` 这种「远程名 + /HEAD」的形状不会与分支名混淆**：
    // 切出来的 remote 就是去掉前缀与结尾 `/HEAD` 的整段（见 parseRemoteHeads）。
    runGit(
      ['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes/**/HEAD'],
      dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    ),
  ])

  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  // `-b` 的分支行在 -z 输出里是第一帧（`## master...origin/master [...]`）：
  // 先单独扫一遍把它认出来，再交给 parseStatusZ 收改动条目。
  const branchToken = String(status.stdout ?? '').split('\0')
    .find((token) => token.startsWith('## '))
  if (branchToken !== undefined) {
    const parsed = parseBranchLine(branchToken)
    branch = parsed.branch
    upstream = parsed.upstream
    ahead = parsed.ahead
    behind = parsed.behind
  }
  const changes = []
  // changesTotal 是**真实条数**，changes 最多回 MAX_STATE_CHANGES 条：
  // 面板据此显示「还有 N 处未显示」，截断因此不再静默。
  let changesTotal = 0
  for (const entry of parseStatusZ(status.stdout)) {
    changesTotal += 1
    if (changes.length >= MAX_STATE_CHANGES) continue
    changes.push(entry)
  }

  const commits = []
  for (const line of log.stdout.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    // `--decorate=short` 在 `--oneline` 输出里把装饰包在**标题前面的**括号里：
    //   `2c613d8 (HEAD -> master) A`、`2c613d8 (tag: v1) A`。
    // 拆出来单独回传（面板把它渲染成一行小徽章），标题保持干净。
    let refs = ''
    let subject = text
    const firstSpace = text.indexOf(' ')
    if (firstSpace > 0 && text.charAt(firstSpace + 1) === '(') {
      const close = text.indexOf(')', firstSpace + 1)
      if (close > firstSpace + 1) {
        refs = text.slice(firstSpace + 2, close)
        subject = text.slice(0, firstSpace) + text.slice(close + 1)
      }
    }
    const space = subject.indexOf(' ')
    const hash = space < 0 ? subject : subject.slice(0, space)
    commits.push({
      hash,
      subject: space < 0 ? '' : subject.slice(space + 1),
      refs,
    })
    if (commits.length >= 8) break
  }

  const remotes = parseRemotes(remotesResult.stdout)
  // 合并冲突现场：porcelain 里 X/Y 带 U（或 AA/DD）的条目就是要处理的文件。
  // 面板顶部横幅显示它并给出中文指引；stash-pop/merge 的冲突路径（见 ops.js 的
  // conflictedFiles）另有明细，这里只负责「状态一打开就能看见」。
  const conflicts = changes
    .filter((entry) => isConflictCode(entry.code))
    .map((entry) => entry.path)
  const state = {
    ok: true,
    dir: shown,
    isRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    changes,
    changesTotal,
    conflicts,
    log: commits,
    remotes,
    // 两个远程指向同一地址（本次现场：`main` 与 `origin` 同 URL）→ 面板给一行提示 +
    // 一键删多余的那个。判断在宿主侧做，客户端只负责显示。
    duplicateRemotes: duplicateRemotes(remotes),
    // 每个远程的默认分支（{ origin: 'master', fork: 'master' }）。读不到指针的远程不在表里
    // —— 面板据此把「拉取自」下拉里那一项写成「从 origin/master 拉」；**没有它也不能猜**：
    // 猜错就是把另一条线并进当前分支，宁可不预选分支。
    remoteHeads: parseRemoteHeads(headsResult.stdout),
    // 仓库主页入口：用「远程行展示的那一条地址」（按名称排序后的第一个）推导，
    // 面板上的「仓库页 ↗」按钮与这一行显示的是同一个远程，不会对不上号。
    pageUrl: remotes.length > 0 ? repoPageUrl(remotes[0].url) : null,
    notice: null,
  }
  appendLog('debug', 'state', {
    dir: shown,
    isRepo: true,
    branch,
    changes: changes.length,
    changesTotal,
    ms: Date.now() - startedAt,
  })
  return state
}

/**
 * 当前分支名（不知道就返回空串）。
 *
 * 为什么要这么绕：**刚 `git init`、还没有任何提交**的仓库（正是"新建仓库 → 填地址 →
 * 拉取"这条最普通的路）里，`rev-parse --abbrev-ref HEAD` 会直接失败
 * （`fatal: ambiguous argument 'HEAD'`），于是它会被误判成「游离 HEAD」，
 * 该自动做的补救全被跳过。这两个命令在"分支还没出生"时同样能给出名字：
 *   - `git branch --show-current`（git 2.22+）：直接读 HEAD 指向的名字；
 *   - `git symbolic-ref --short HEAD`：更老也有的等价写法。
 * 真正游离 HEAD 时两个都拿不到名字（前者输出空、后者报错），返回空串由调用方处理。
 */
async function currentBranchName(dir, timeoutMs) {
  const attempts = [['branch', '--show-current'], ['symbolic-ref', '--short', 'HEAD']]
  for (const argv of attempts) {
    const result = await runGit(argv, dir, { timeoutMs: timeoutMs })
    if (result.code !== 0) continue
    const name = result.stdout.trim()
    if (name.length > 0 && name !== 'HEAD') return name
  }
  return ''
}

/**
 * 解析 `git stash list` 的输出（面板「stash 备份」用）。
 *
 * 行形如 `stash@{0}: WIP on main: 1234abc 提交说明` —— ref 是可执行操作的编号，
 * 冒号后的整段是给人看的内容。解析不出来的一律跳过：宁可少列一条，
 * 也不能把 `stash@{x}` 编号拼错（拼错就操作到错误的备份上了）。
 * @returns [{ ref, text }]；空输出返回 []。
 */
function parseStashList(stdout) {
  const items = []
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const match = /^(stash@\{\d+\}):\s*(.*)$/.exec(text)
    if (match === null) continue
    items.push({ ref: match[1], text: match[2].trim() })
  }
  return items
}

/**
 * 远端引用 → 本地新分支名：`origin/master` → `origin-master`（/ 不能出现在分支名里）。 */
function localBranchNameFor(remoteRef) {
  const cleaned = String(remoteRef ?? '')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w.\-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'remote-branch'
}

export {
  MAX_BUFFER, DEFAULT_TIMEOUT_MS, GIT_LOCAL_TIMEOUT_MS, MAX_STATE_CHANGES,
  runGit, gitMissingMessage, emptyState,
  NOT_REPO_NOTICE, BARE_REPO_NOTICE, notRepoNotice,
  parseBranchLine, parseStatusZ, parseRemotes, duplicateRemotes, remoteOpFor, cloneTargetName, repoPageUrl,
  parseBranchOutput, parseBranchUpstreams,
  parseRemoteBranchOutput, parseLsRemoteHead, parseRemoteHeads, isSafeRemoteRef, isSafePushTarget,
  parseCompareOutput,
  parseStashList,
  isConflictCode,
  localBranchNameFor, readState, currentBranchName,
}
