// dsh-git-sidebar —— 操作注册表（面板与模型工具的唯一事实来源）
// ============================================================================
// 每个 git 操作的 argv 形状只在这里定义一次：面板的 OPS 与模型工具的 toArgv
// 都指向下面这组 argv* 构造器，两条路径不可能再分叉。
//
// 操作元数据（是否联网、超时、结果怎么解析、失败给什么提示）也收在同一张表里，
// 路由因此不再散落 if (op === …) 分支。
// ============================================================================

import {
  GIT_LOCAL_TIMEOUT_MS, currentBranchName, gitMissingMessage, isSafePushTarget, isSafeRemoteRef,
  localBranchNameFor, parseBranchOutput, parseBranchUpstreams, parseLsRemoteHead, parseRemoteBranchOutput,
  parseCompareOutput, parseRemotes, parseStashList, remoteOpFor, runGit,
} from './git.js'
import { mirrorLabel, networkExtraArgs, readNetConfig } from './net.js'
import {
  classifyCheckoutFailure, classifyCommitFailure, classifyDeleteBranchFailure,
  classifyNetworkFailure, classifyPullFailure, classifyPushFailure, classifyRenameFailure,
  classifySetUpstreamFailure,
  checkoutHint, commitHint, deleteBranchHint, mirrorFallbackWorthwhile, networkHint,
  pullFailureText, pullHint, pushHint, renameHint, setUpstreamHint,
} from './failure.js'
import {
  displayArgv, firstLine, hasText, maskProxy, message, normalizeDir, trimmedOrNull, truncateText,
} from './util.js'

// ── 共享 argv 构造器：面板与模型工具的唯一事实来源 ──────────────────────────
//
// 这些函数只回答一件事：「这个操作对应哪几个 git 参数」。校验消息写成中性的
// （不带工具名），工具侧由 toolArgv() 统一加上 `git_xxx: ` 前缀 —— 于是
// 「面板的 switch」与「工具的 checkout」不可能再各写一套。它们**曾经就是两套**，
// 而且行为已经分叉：面板切分支用 git switch（注释里写了为什么），工具用 checkout。

/** git_status */
function argvStatus(input = {}) {
  return input.porcelain === true ? ['status', '--porcelain=v1', '--branch'] : ['status']
}

/** git_add：paths 列表，或 all=true。 */
function argvAdd(input = {}) {
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  if (input.all === true) return paths.length > 0 ? ['add', '-A', ...paths] : ['add', '-A']
  if (paths.length === 0) throw new Error('需要提供 paths 或设置 all=true')
  return ['add', '--', ...paths]
}

/** git_commit */
function argvCommit(input = {}) {
  const text = typeof input.message === 'string' ? input.message : ''
  if (text.trim().length === 0) throw new Error('提交信息不能为空')
  const argv = ['commit']
  if (input.all === true) argv.push('-a')
  if (input.amend === true) argv.push('--amend')
  argv.push('-m', text)
  return argv
}

/** git_log */
function argvLog(input = {}) {
  const argv = ['log', '--oneline', '--no-color']
  if (input.graph === true) argv.push('--graph')
  if (input.all === true) argv.push('--all')
  let count = typeof input.count === 'number' ? Math.floor(input.count) : 10
  if (!(count >= 1)) count = 10
  if (count > 200) count = 200
  argv.push('-n', String(count))
  return argv
}

/** git_diff（面板看单个改动的 diff 也走这里） */
function argvDiff(input = {}) {
  const argv = ['diff']
  if (input.cached === true) argv.push('--cached')
  if (input.stat === true) argv.push('--stat')
  const path = trimmedOrNull(input.path)
  if (path !== null) argv.push('--', path)
  return argv
}

/** git_branch：列表（--no-color / -a）、新建（不切换）、删除（-d / -D）。 */
function argvBranch(input = {}) {
  const name = trimmedOrNull(input.name)
  if (name !== null) {
    if (input.delete === true) return ['branch', input.force === true ? '-D' : '-d', name]
    return ['branch', name]
  }
  if (input.delete === true) throw new Error('删除分支需要提供 name')
  return input.all === true ? ['branch', '-a', '--no-color'] : ['branch', '--no-color']
}

/**
 * 切换 / 新建并切换。**一律用 git switch，不用 checkout**：switch 只做分支语义，
 * 不会在「名字既像分支又像路径」时把切换误判成还原文件。
 */
function argvCheckout(input = {}) {
  const branch = trimmedOrNull(input.branch)
  if (branch === null) throw new Error('需要提供分支名')
  return input.create === true ? ['switch', '-c', branch] : ['switch', branch]
}

/**
 * git_branch --set-upstream-to：把本地分支 <local> 的上游指到 <remote>/<branch>。
 *
 * 为什么不用 `git branch -u` 的短选项：长选项在日志与结果栏里读起来是完整一句话，
 * 而这条命令**会写进 .git/config**（branch.<local>.remote / merge）—— 面板一贯
 * 坚持「不改用户的 git 配置」，这里是唯一的例外，所以命令本身必须写得让人看得懂。
 * 它改的正是「上游跟踪关系」这一个字段，也正是这条操作存在的全部理由。
 */
function argvSetUpstream(local, remote, branch) {
  return ['branch', '--set-upstream-to=' + remote + '/' + branch, local]
}

/**
 * git_pull。四种形状，都走这一个构造器（面板的「拉取自」下拉、面板的「安全拉取」、
 * 模型工具的 `git_pull` 因此不可能各写一套）：
 *
 *   1. **什么都没给** → 裸 `git pull`：按当前分支的上游拉，由 git 自己决定（老行为）。
 *   2. **只勾了变基** → `git pull --rebase`（老行为）。
 *   3. **给了远程** → 显式 `git pull <远程> [<分支>]`。这是面板「拉取自 X」的形状：
 *      **不要求当前分支的上游就是它**，也不动上游配置 —— 于是「我的分支跟踪 fork、
 *      但要拿 origin（别人的上游）的更新」不必来回改跟踪关系（见 recoverPull）。
 *   4. **只给了分支** → **拒绝**：单独一个位置参数会被 git 当成**仓库地址或路径**
 *      （`git pull main` 会去找名叫 main 的远程/目录，报一句和意图完全无关的错）。
 *      这个形状此前会被静默拼出来，现在在入口就拦下并说明原因。
 *
 * 两个位置参数各按各的白名单校验（与 argvPush 同一套判断，理由也一样）：
 *   · 远程那个按 isSafePushTarget —— git 眼里它是「仓库」，URL / 本地路径 / scp
 *     形式都合法，只拦 `-` 开头与 `proto::` 远程助手语法；
 *   · 分支那个按 isSafeRemoteRef —— 它是一个 ref，`:`/空格/`..` 都不该出现。
 *
 * 只给了远程、没给分支时**故意不在这里补**当前分支名：补名字要读仓库（一条 git），
 * 而 argv 构造器在测试里也被当成纯函数用。补名字那一步在 OPS.pull.argv 里（它有 dir）。
 */
function argvPull(input = {}) {
  const argv = ['pull']
  if (input.rebase === true) argv.push('--rebase')
  const remote = trimmedOrNull(input.remote)
  const branch = trimmedOrNull(input.branch)
  if (remote === null && branch !== null) {
    throw new Error('拉取要指定远程：只给分支名会被 git 当成仓库地址（git pull ' + branch + '）')
  }
  if (remote !== null && !isSafePushTarget(remote)) throw new Error('远程名或地址不合法：' + remote)
  if (branch !== null && !isSafeRemoteRef(branch)) throw new Error('分支名不合法：' + branch)
  if (remote !== null) {
    argv.push(remote)
    if (branch !== null) argv.push(branch)
  }
  return argv
}

/**
 * git_push。
 *
 * 三种形态，都走这一个构造器（面板的「推送到」下拉、远程行的「推送到此」、
 * 模型工具的 git_push 因此不可能各写一套）：
 *   1. **没给远程** → 裸 `git push`：推给当前分支跟踪的上游（git 自己决定）。
 *   2. **给了远程** → 显式 refspec `git push <远程> [<分支>|HEAD]`。
 *      为什么一定要带 refspec：默认配置 `push.default=simple` 只在「本地名 == 上游名」
 *      时才肯裸推，而 `git push <远程> HEAD` 是**显式**的，不受该配置约束 ——
 *      「本地名和上游名对不上」的现场因此也能一次推成功（见 mismatchPushChoices）。
 *      没给分支名时用 `HEAD`（= 当前分支，推到同名远端分支），这样调用方不必先知道
 *      自己在哪个分支上。
 *   3. **只给了分支**（老形状，模型工具的 `git_push {branch}`）→ `git push <分支>`。
 *
 * `--set-upstream` 只要调用方要了就带上（老行为不变）：面板不擅自替你设上游，而模型工具的
 * `git_push {setUpstream:true}` 与历史的 `mode:'upstream'` 照旧生效。
 *
 * 远程名与分支名的校验规则**不同**（两者交给 git 的角色不同）：
 *   · 远程那个位置参数按 isSafePushTarget 校验 —— git 眼里它是「仓库」，本来就接受
 *     URL 与本地路径（`https://…`、`git@host:path`、`../other.git`、`D:\x.git`），
 *     只拦「会被当成选项」的 `-` 开头与 `proto::` 远程助手语法；
 *   · 分支那个位置参数按 isSafeRemoteRef 校验 —— 它是一个 ref，`:`/空格/`..` 都不该出现。
 * 校验消息写成中性的，工具侧由 toolArgv 统一加前缀。
 */
function argvPush(input = {}) {
  const argv = ['push']
  // 兼容历史的 `mode: 'upstream'`（等价 --set-upstream，当时远程写死 origin）：
  // 现在它也接受显式 remote，没给时才退回 origin。
  const legacyUpstream = input.mode === 'upstream'
  const remote = trimmedOrNull(input.remote) ?? (legacyUpstream ? 'origin' : null)
  const branch = trimmedOrNull(input.branch)
  if (remote !== null && !isSafePushTarget(remote)) throw new Error('远程名或地址不合法：' + remote)
  if (branch !== null && !isSafeRemoteRef(branch)) throw new Error('分支名不合法：' + branch)
  if (input.force === true) argv.push('--force')
  if (input.setUpstream === true || legacyUpstream) argv.push('--set-upstream')
  if (remote !== null) {
    argv.push(remote)
    argv.push(branch === null ? 'HEAD' : branch)
    return argv
  }
  if (branch !== null) argv.push(branch)
  return argv
}

/**
 * 「这次推到了哪个远程」——只在**选了远程**时给一句说明。
 *
 * 为什么要说：补救动作与加速说明都会出现在结果里（「已自动改用 …」「走了代理 …」），
 * 而「推到了 fork 而不是 origin」正是多远程下最该被复述的一件事 —— 它决定了
 * 刚才那一下把代码交到了谁手里。裸 push（跟随上游）不加这句：那时目标由 git 的
 * 配置决定，面板不替它说。
 */
function pushTargetNote(input) {
  const body = input === null || input === undefined ? {} : input
  const remote = trimmedOrNull(body.remote)
  if (remote === null) return null
  const branch = trimmedOrNull(body.branch)
  const target = branch === null ? 'HEAD' : branch
  return '这次推送的目标是你选的远程 ' + remote + '（git push ' + remote + ' ' + target
    + '，显式 refspec，不受 push.default 配置限制）；只换这一次的远程，不动你的任何 git 配置'
    + (body.setUpstream === true ? '；同时把当前分支的上游指向 ' + remote : '')
}

/**
 * 新建分支名是否撞上「远端名」的命名空间（`origin/main` 这种）。
 *
 * 为什么要在入口拦掉：本地分支 `origin/main` 会和 `refs/remotes/origin/main` 变成两个
 * 同名引用 —— `git branch -a`、`git log origin/main` 乃至别的脚本从此开始有歧义
 * （git 自己会打 `warning: refname 'main' is ambiguous`），而且这个分支第一次推送还会
 * 在远端造出一个同样叫 `origin/main` 的分支。这不是 git 禁止的事，但它只会带来混乱，
 * 所以在建之前就拦住，并给出安全的建议名。
 *
 * @returns 撞上的远端名；不冲突返回 null。
 */
function branchNameRemoteConflict(name, remoteNames) {
  const branch = trimmedOrNull(name)
  if (branch === null) return null
  const list = Array.isArray(remoteNames) ? remoteNames : []
  for (const remote of list) {
    if (typeof remote !== 'string' || remote.length === 0) continue
    if (branch.startsWith(remote + '/')) return remote
  }
  return null
}

/** `origin/main` → `main`（上游短名）。远端名里含 `/` 时按**第一个**斜杠切 —— 与 upstreamRef 一致。 */
function upstreamBranchName(upstream) {
  const text = trimmedOrNull(upstream)
  if (text === null) return null
  const at = text.indexOf('/')
  return at > 0 && at < text.length - 1 ? text.slice(at + 1) : null
}

/**
 * 建分支前的命名检查：撞上远端名就拒绝（面板的「新建」与模型工具的 git_branch /
 * git_checkout --create 都走这一个函数 —— 同一道防线，不可能只对一边生效）。
 *
 * 需要 dir：远端名只能从仓库里读出来（`git remote -v`）。建分支是低频操作，
 * 多这一条本地 git 值得（对比「本地分支和 refs/remotes 同名之后 git 处处 ambiguous」）。
 *
 * @throws 撞名时抛带中文理由的错误（面板直接显示，工具侧由 toolArgv 加前缀）。
 */
async function assertSafeNewBranch(name, dir) {
  const branch = trimmedOrNull(name)
  if (branch === null) return
  const remotes = parseRemotes(
    (await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout,
  )
  const conflict = branchNameRemoteConflict(branch, remotes.map((item) => item.name))
  if (conflict === null) return
  const safeName = branch.slice(conflict.length + 1)
  throw new Error('分支名 ' + branch + ' 和远端名撞了：' + conflict + ' 是配置好的远程，'
    + conflict + '/' + safeName + ' 已经是它的远端跟踪引用。'
    + '本地再建一个同名分支会让这两个引用开始有歧义，换个本地名（例如 ' + safeName + '）即可。')
}

/** git_clone：面板叫 target、工具叫 dir —— 同一个东西的两个名字，在这里归一。 */function argvClone(input = {}) {
  const url = trimmedOrNull(input.url)
  if (url === null) throw new Error('需要提供仓库地址')
  const argv = ['clone']
  if (typeof input.depth === 'number' && input.depth >= 1) argv.push('--depth', String(Math.floor(input.depth)))
  argv.push(url)
  const target = trimmedOrNull(input.target) ?? trimmedOrNull(input.dir)
  if (target !== null) argv.push(target)
  return argv
}

/**
 * git_pull 的**完整** argv：argvPull 之外，只多一件「只给了远程时补当前分支名」的事。
 *
 * 为什么要单独一个函数：面板的「拉取自」与模型工具的 `git_pull {remote}` 都会给
 * 「远程但不给分支」这个形状，而它有个必须处理的坑 —— `git pull <远程>` 不带分支时
 * 只用「当前分支配置给这个远程的 merge ref」，可「拉取自 X」的前提恰恰是当前分支的
 * 上游**不是** X，那一步不成立，命令会报一句和意图无关的错。补当前分支名是这里
 * 唯一的推断，且只用确定的信息（当前分支真名）；拿不到（游离 HEAD）就拒绝。
 *
 * @param dir - 仓库目录；**必须**是已经归一化的。tools.js 传 helpers.dir，面板传 ctx.dir。
 */
async function pullArgvForDir(input = {}, dir) {
  const remote = trimmedOrNull(input.remote)
  let branch = trimmedOrNull(input.branch)
  if (remote !== null && branch === null) {
    const cwd = normalizeDir(dir)
    branch = cwd === undefined ? null : trimmedOrNull(await currentBranchName(cwd, GIT_LOCAL_TIMEOUT_MS))
    if (branch === null) {
      throw new Error('拉取要指定分支：当前处于游离 HEAD（没有分支名）。先切到一个分支上，'
        + '或显式给出 branch。')
    }
  }
  return argvPull({ rebase: input.rebase === true, remote: remote, branch: branch })
}

/** git_init */
function argvInit(input = {}) {
  const branch = trimmedOrNull(input.branch)
  return branch === null ? ['init'] : ['init', '-b', branch]
}

/**
 * git_remote：list / add / set / remove。
 *
 * set 的语义是「同名远程已存在就改地址，否则新增」，因此**必须先查一次 git remote**；
 * 而查重与真正执行必须在**同一个目录**里。ctx.dir 由调用方（buildOpArgv）归一化后
 * 传入 —— 早先这里读的是原始请求体里的 dir，于是配置了 defaultDir 或传了 `~/…`
 * 时会误判成「远程不存在」，接着 `remote add` 撞上 `fatal: remote origin already exists`。
 */
async function argvRemote(input = {}, ctx = {}) {
  const action = input.action === 'add' || input.action === 'set' || input.action === 'remove'
    ? input.action
    : 'list'
  const named = trimmedOrNull(input.name)
  const remote = named ?? 'origin'
  const url = trimmedOrNull(input.url)
  if (action === 'list') return ['remote', '-v']
  if (action === 'add') {
    if (named === null || url === null) throw new Error('add 需要提供 name 和 url')
    return ['remote', 'add', remote, url]
  }
  if (action === 'set') {
    if (url === null) throw new Error('需要提供仓库地址')
    const listed = await runGit(['remote'], ctx.dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    return remoteOpFor(remote, url, listed.stdout)
  }
  if (named === null) throw new Error('remove 需要提供 name')
  return ['remote', 'remove', remote]
}

/** git_run：任意子命令（子命令名会成为 argv[0]，所以必须先校验形状）。 */
function argvRun(input = {}) {
  const sub = typeof input.subcommand === 'string' ? input.subcommand : ''
  if (!/^[a-z][a-z0-9-]*$/.test(sub)) throw new Error('subcommand 必须是小写字母开头的合法子命令名')
  const rest = Array.isArray(input.args) ? input.args.filter((item) => typeof item === 'string') : []
  return [sub, ...rest]
}

/**
 * 工具侧包装：给共享构造器的中性消息加上工具名前缀，并统一在**这里抛错**。
 *
 * 为什么必须抛：`execute` 抛出的异常会被 harness 标成一次失败的调用；而返回一段
 * 普通文本会被模型读成「命令跑完了」。参数错误（缺 paths、非法子命令）属于前者。
 */
async function toolArgv(toolName, build) {
  try {
    return await build()
  } catch (error) {
    throw new Error(toolName + ': ' + message(error))
  }
}

// ── 面板操作注册表 ────────────────────────────────────────────────────────
//
// 每个面板操作只在这里声明一次：argv 形状、超时、结果怎么解析、失败给什么提示、
// 要不要做补救。路由因此不再散落 if (op === …) 分支，新增操作也只改这一处。
//
// network 标记与 net.js 的 NETWORK_OPS 是**两个不同的索引**（那边按 git 子命令，
// 这里按面板操作名），unit.test.mjs 有一条断言钉住两者一致，防止悄悄分叉。

/** 本地查询 / 普通操作 / 联网操作的三档超时。 */
const LOCAL_OP_TIMEOUT_MS = GIT_LOCAL_TIMEOUT_MS
const OP_TIMEOUT_MS = 120000
const NETWORK_OP_TIMEOUT_MS = 600000

/**
 * 「远端默认分支」兜底查询的超时：一条 ls-remote 只读 HEAD 一个引用，正常几秒内
 * 返回；卡住的网络不值得让「打开分支管理器」干等，超时就当查不到，列表照常显示。
 */
const REMOTE_HEAD_TIMEOUT_MS = 30000

/** diff 回给面板的字符上限（客户端还要逐行着色，太长的 diff 会拖慢渲染）。 */
const DIFF_MAX_CHARS = 40000

/** 取一个必填的字符串参数；缺失时抛出面板可直接展示的中文提示。 */
function requiredText(input, key, errorText) {
  const value = trimmedOrNull(input === null || input === undefined ? undefined : input[key])
  if (value === null) throw new Error(errorText)
  return value
}

/** stash 操作的编号必须长这样：它是会交给 git 当参数的。 */
function stashRef(input) {
  const ref = requiredText(input, 'ref', '请选择要操作的 stash')
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('stash 编号不合法：' + ref)
  return ref
}

const OPS = {
  init: { argv: () => argvInit({}) },
  addAll: { argv: () => argvAdd({ all: true }) },
  // 单文件暂存 / 取消暂存 / 还原：改动清单每一行的小按钮。
  add: { argv: (input) => argvAdd({ paths: [requiredText(input, 'path', '缺少文件路径')] }) },
  unstageFile: { argv: (input) => ['restore', '--staged', '--', requiredText(input, 'path', '缺少文件路径')] },
  restoreFile: { argv: (input) => ['restore', '--', requiredText(input, 'path', '缺少文件路径')] },
  // 撤销暂存：把暂存区重置回 HEAD，不动工作区（git reset 不支持 --no-color，无需加）。
  unstage: { argv: () => ['reset'] },
  // 丢弃改动：用暂存区内容覆盖工作区（不影响未跟踪文件）。用 git restore 而不是
  // 早已过时的 `checkout --`：帮助文档给用户的就是 restore，两边必须是同一条命令。
  discard: { argv: () => ['restore', '--', '.'] },
  branches: {
    argv: () => argvBranch({}),
    field: 'branches',
    parse: parseBranchOutput,
    local: true,
    // 分支管理器要同时看本地和远端，还要知道**每条本地分支跟踪谁** —— 一次 HTTP
    // 往返拿三份。原先客户端连发两次 op，而每次 op 宿主都要额外回读一次仓库状态
    // （4 条 git）：展开一次就是 10 条进程。
    // 注意远端那份用 `--remotes`（只列远端），不是 `-a`（本地 + 远端）：
    // 面板的远端分组只要远端，混进本地分支会多出一堆点不动的行。
    also: [
      {
        field: 'remoteBranches',
        argv: () => ['branch', '--remotes', '--no-color'],
        parse: parseRemoteBranchOutput,
        // 本地没有 origin/HEAD 指针（旧版 git 的 init+remote、镜像远端）时，
        // 靠 enhance 补查一次远程 HEAD，默认分支照样能标出来。
        enhance: enhanceRemoteBranches,
      },
      {
        // 每条本地分支的上游（`→ origin/master`）。用 for-each-ref 而不是
        // `branch -vv`：后者是给人看的对齐文本，分支名里带方括号时切不出字段。
        // 这是**纯本地**查询，不发网络请求。
        field: 'branchUpstreams',
        argv: () => ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'],
        parse: parseBranchUpstreams,
      },
    ],
  },
  remoteBranches: {
    argv: () => ['branch', '--remotes', '--no-color'],
    field: 'remoteBranches',
    parse: parseRemoteBranchOutput,
    local: true,
    enhance: enhanceRemoteBranches,
  },
  compare: {
    argv: (input) => {
      const ref = requiredText(input, 'ref', '请选择一个远端分支再比较')
      if (!isSafeRemoteRef(ref)) throw new Error('远端分支名不合法，请重新选择')
      return ['rev-list', '--left-right', '--count', 'HEAD...' + ref]
    },
    field: 'compare',
    parse: (stdout, input) => parseCompareOutput(stdout, requiredText(input, 'ref', '请选择一个远端分支再比较')),
    local: true,
    // 原始输出只是两列数字（`0\t3`），直接甩到结果栏没人看得懂。
    note: (fields) => compareNote(fields.compare),
  },
  checkout: {
    argv: (input) => argvCheckout({ branch: requiredText(input, 'branch', '请选择要切换的分支') }),
    // 普通切换的失败分类（脏工作区 / 分支不存在）。面板在脏工作区下会优先走
    // 「安全切分支」（stashSwitch），这个分类器服务模型工具与剩余路径。
    classify: (result) => classifyCheckoutFailure(result.stderr),
    hint: checkoutHint,
  },
  createBranch: {
    // async：要在**同一个目录**里看一眼有哪些远端，才能拦住 `origin/main` 这种与远端
    // 跟踪引用同名的本地分支（见 assertSafeNewBranch，面板与模型工具共用它）。
    argv: async (input, ctx) => {
      const branch = requiredText(input, 'branch', '请填写新分支名')
      await assertSafeNewBranch(branch, ctx !== null && ctx !== undefined ? ctx.dir : undefined)
      return argvCheckout({ branch: branch, create: true })
    },
  },
  deleteBranch: {
    argv: (input) => argvBranch({ name: requiredText(input, 'branch', '请选择要删除的分支'), delete: true }),
    // 未合并被拒是 git 的保护，不是故障：中文解释 + 「强制删除」按钮（见 forceDeleteChoice）。
    classify: (result) => classifyDeleteBranchFailure(result.stderr),
    hint: deleteBranchHint,
  },
  /**
   * 强制删除（-D）。**不做成常驻按钮**：它的默认答案永远是「不要删」，只在用户看过
   * 「未完全合并」的中文解释之后、从那里点进来（见 forceDeleteChoice 的确认文案）。
   */
  deleteBranchForce: {
    argv: (input) => argvBranch({
      name: requiredText(input, 'branch', '请选择要删除的分支'), delete: true, force: true,
    }),
    classify: (result) => classifyDeleteBranchFailure(result.stderr),
    hint: deleteBranchHint,
  },
  renameBranch: {
    argv: (input) => {
      const name = requiredText(input, 'name', '请填写新分支名')
      if (!isSafeRemoteRef(name)) throw new Error('分支名不合法：' + name)
      /**
       * `from`（可选）= 要改的是哪条分支。
       *
       * 不给时沿用老形状 `git branch -m <新名>`（改的是**当前分支**，模型工具与老
       * 客户端的行为一字不变）；给了就显式写全 `git branch -m <旧> <新>` —— 面板的
       * 编辑器标题写的就是「把分支 X 改名」，命令必须真的改 X，而不是「谁在那儿谁挨改」。
       * 两个位置都过同一道白名单（它们都会被当参数交给 git）。
       */
      const from = trimmedOrNull(input.from)
      if (from === null) return ['branch', '-m', name]
      if (!isSafeRemoteRef(from)) throw new Error('要改名的分支不合法：' + from)
      return ['branch', '-m', from, name]
    },
    // 撞名（本地已有同名分支）时说清楚，并指向「推到上游跟踪的那条分支」——那条路不用改名。
    classify: (result) => classifyRenameFailure(result.stderr),
    hint: renameHint,
    // `git branch -m` 成功时 stdout 一个字都没有（结果栏只会显示「完成」），
    // 而「改了没有」正是用户此刻唯一想确认的事：由宿主把旧名与新名写成一句中文。
    // 没给 from（老调用方 / 模型工具）时不编造 —— 宿主并不知道改的是哪一条。
    note: (fields, input) => {
      const body = input === null || input === undefined ? {} : input
      const to = trimmedOrNull(body.name)
      const from = trimmedOrNull(body.from)
      if (to === null || from === null) return null
      return '已把分支 ' + from + ' 改名为 ' + to
        + '：提交历史一个没动，上游跟踪关系跟着这条分支保留（以后推送 / 拉取照旧对着它）'
    },
  },
  /**
   * 把某个本地分支的上游绑到某条远端分支（`git branch --set-upstream-to=<remote>/<branch> <local>`）。
   *
   * 为什么需要它：本地名和远端名不一致（`fork-local.2` ↔ `fork/local.2`）时，面板原先
   * 只能把这件事**讲**清楚（推送失败后给三条补路：推到上游那个分支 / 在远端另建同名分支 /
   * 把本地名改成与上游一致），却没有任何地方能**改**它。这条操作补上最直接的那条路：
   * 就地绑定，本地名不用动、也不用到远端另建分支。
   *
   * 三个参数都来自界面上的选择，仍然全过 isSafeRemoteRef 白名单（它们会被当参数交给 git）。
   * 纯本地操作（local: true 走 20 秒档），不发网络请求。
   */
  setUpstream: {
    argv: (input) => {
      const remote = requiredText(input, 'remote', '请选择要跟踪的远程')
      const branch = requiredText(input, 'branch', '请选择要跟踪的远端分支')
      const local = requiredText(input, 'local', '请选择要设置上游的本地分支')
      if (!isSafeRemoteRef(remote) || !isSafeRemoteRef(branch) || !isSafeRemoteRef(local)) {
        throw new Error('远程名或分支名不合法：' + remote + '/' + branch + ' → ' + local)
      }
      return argvSetUpstream(local, remote, branch)
    },
    local: true,
    classify: (result) => classifySetUpstreamFailure(result.stderr),
    hint: setUpstreamHint,
    // 这条命令 stdout 只有一句 `branch 'x' set up to track 'y'`（英文），
    // 面板的结果栏要用中文说清「改了哪个字段、以后推送拉取对着谁」。
    note: (fields, input) => {
      const body = input === null || input === undefined ? {} : input
      const local = trimmedOrNull(body.local)
      const remote = trimmedOrNull(body.remote)
      const branch = trimmedOrNull(body.branch)
      if (local === null || remote === null || branch === null) return null
      return '已把本地分支 ' + local + ' 的上游设为 ' + remote + '/' + branch
        + '：以后在这个分支上「推送」「拉取」都对着它（只改了这一个跟踪关系，其它 git 配置没动）'
    },
  },
  /**
   * 把当前分支推给它**跟踪的那个远端分支**（显式 refspec，`HEAD:<远端分支名>`）。
   * 「本地名 ≠ 上游名」时用它：不依赖用户的 push.default 配置，也不改任何 git 配置。
   */
  pushUpstream: {
    argv: (input) => {
      const remote = requiredText(input, 'remote', '缺少远程名')
      const branch = requiredText(input, 'branch', '缺少远端分支名')
      if (!isSafeRemoteRef(remote) || !isSafeRemoteRef(branch)) throw new Error('远程或分支名不合法')
      return ['push', remote, 'HEAD:' + branch]
    },
    network: true,
    hint: pushHint,
  },
  /**
   * 在远端另建一个**与本地同名**的分支并登记成上游（git 自己提示的那条 `push origin HEAD`）。
   * 适合「远端那个 main 不是我要的，我想把自己这份单独放上去」。
   */
  pushSameName: {
    argv: (input) => {
      const remote = requiredText(input, 'remote', '缺少远程名')
      if (!isSafeRemoteRef(remote)) throw new Error('远程名不合法')
      return ['push', '--set-upstream', remote, 'HEAD']
    },
    network: true,
    hint: pushHint,
  },
  diff: {
    argv: (input) => argvDiff({ path: input.path, cached: input.cached }),
    field: 'diff',
    parse: (stdout) => truncateText(stdout, DIFF_MAX_CHARS),
    local: true,
  },
  // 提交详情（最近提交行点开看）：git show --stat + 完整作者信息。
  show: {
    argv: (input) => ['show', '--no-color', '--stat', '--format=fuller', requiredText(input, 'ref', '缺少提交号')],
    field: 'show',
    parse: (stdout) => truncateText(stdout, DIFF_MAX_CHARS),
    local: true,
  },
  commit: { argv: (input) => argvCommit({ message: input.message, amend: input.amend === true }), classify: (result) => classifyCommitFailure(result.stderr), hint: commitHint },
  /**
   * pull：跟随上游（不带参数）或**从用户选的那个远程拉**（remote）。
   *
   * 与 push 完全对称（见下一条）：面板的「拉取自」下拉把 remote 传到这里，于是
   * 「我的分支跟踪 fork、但要拿 origin（别人的上游）的更新」不必来回改上游配置。
   *
   * 只给了 remote 时要补一个分支名，理由写在 argvPull 的第 3/4 条：`git pull <远程>`
   * 不带分支时只用「该分支配置给这个远程的 merge ref」，而这里的前提恰恰是**当前分支
   * 的上游不是它**，所以那一步不成立，必须显式给出分支。用当前分支名（同名分支是最
   * 常见也最不意外的目标）；真拿不到（游离 HEAD）就明确拒绝，不替用户猜一个分支出来。
   */
  pull: {
    argv: (input, ctx) => pullArgvForDir(input, ctx === null || ctx === undefined ? undefined : ctx.dir),
    network: true,
    recover: recoverPull,
    hint: pullHint,
  },
  /**
   * push：跟随上游（不带参数）或推到**用户选的那个远程**（remote）。
   *
   * 这里必须把 remote / branch / setUpstream / force 一并转给 argvPush。此前面板的
   * push 只转 `mode`，于是「多远程下我想推 fork」在面板上根本表达不出来 —— 面板只能
   * 裸推、由 git 按上游挑一个远程，而那个远程可能恰恰是你没有写权限的那个。
   */
  push: {
    argv: (input) => argvPush({
      mode: input.mode,
      remote: input.remote,
      branch: input.branch,
      setUpstream: input.setUpstream === true,
      force: input.force === true,
    }),
    network: true,
    recover: recoverPush,
    hint: pushHint,
    note: (fields, input) => pushTargetNote(input),
  },
  setRemote: { argv: (input, ctx) => argvRemote({ action: 'set', name: input.name, url: input.url }, ctx) },
  /**
   * 删掉一个远程（面板「远程」区那行「两个远程指向同一地址」的提示里给的一键入口）。
   *
   * 只动**本地**配置：服务器上的仓库与你的提交都不受影响；但它会一并删掉
   * `refs/remotes/<名字>/*` 这些远端跟踪引用，所以面板必须二次确认、并写清后果。
   * 想加回来就是一句 git remote add。
   */
  removeRemote: {
    argv: (input) => argvRemote({
      action: 'remove',
      name: requiredText(input, 'name', '请选择要删除的远程名'),
    }),
  },
  // fetch / clone 的失败分类与 push 同一套（remote-not-found / auth-failed 都要给下一步），
  // 其余操作的 classifyPushFailure 只会返回 none → pushHint 给 null，行为与原先一致。
  fetch: { argv: () => ['fetch', '--all', '--prune'], network: true, hint: pushHint },
  clone: { argv: (input) => argvClone({ url: input.url, target: input.target, depth: input.depth }), network: true, hint: pushHint },
  // stash 备份：列表（数据型）+ 应用 + 删除（「安全拉取」「安全切分支」的备份在这里收尾）。
  stashList: { argv: () => ['stash', 'list'], field: 'stash', parse: parseStashList, local: true },
  stashApply: { argv: (input) => ['stash', 'apply', stashRef(input)] },
  stashDrop: { argv: (input) => ['stash', 'drop', stashRef(input)] },
}

/** 把 `rev-list --left-right --count` 的两列数字翻成人话。 */
function compareNote(compare) {
  if (compare === null || compare === undefined) return null
  if (compare.ahead === 0 && compare.behind === 0) {
    return '本地和 ' + compare.ref + ' 完全一致：没有多出来的、也没有还没拉下来的提交'
  }
  return '相对 ' + compare.ref + '：本地领先 ' + compare.ahead + ' 个提交、落后 '
    + compare.behind + ' 个提交'
    + (compare.behind > 0 ? '（落后的就是远端有、你还没有的）' : '')
}

/**
 * 该操作的时间预算：
 *   - 联网操作给足 10 分钟（克隆大仓库、镜像卡住后回退都要时间）；
 *   - 数据型/本地操作（diff / branches / compare / show / stashList）走 20 秒的
 *     本地档 —— 它们正常是毫秒级，真出问题时不该让面板干等满两分钟才有提示。
 * @param spec - OPS 注册表条目。
 */
function opTimeoutMs(spec) {
  if (spec.network === true) return NETWORK_OP_TIMEOUT_MS
  if (spec.local === true) return GIT_LOCAL_TIMEOUT_MS
  return OP_TIMEOUT_MS
}

/**
 * 执行一条命令，并把网络加速参数插在 `git` 与子命令之间（只影响这一次调用）。
 *
 * 镜像不是官方线路，随时可能失效。**开了加速反而连不上**是最糟的体验，所以镜像
 * 一旦因为线路问题失败就自动回退直连（代理参数保留 —— 那是用户自己的线路）。
 * 但「命令失败」不等于「镜像的错」：没有上游、无关历史这类**本地**错误同样会让
 * 命令失败，早先一律回退并写下「镜像没走通」，用户于是被引去折腾网络加速 ——
 * 所以先用 mirrorFallbackWorthwhile 把失败类型分清楚。
 *
 * 面板（routes.js 的 op 流水线）与模型工具（tools.js）共用这一条执行通道：
 * 镜像回退与失败补救因此不可能只对一边生效。
 *
 * @returns { argv, args, result, accel, notes }；args 是**这次真正用的**加速参数，
 *   补救重试必须带同一套，否则会退化成直连。
 * @param options.signal - 可选的取消信号（模型工具把 exec.signal 传进来）。
 */
async function executeWithAcceleration(op, argv, dir, timeoutMs, options = {}) {
  const netConfig = await readNetConfig()
  const accel = networkExtraArgs(op, netConfig)
  const notes = []
  const signal = options !== null && typeof options === 'object' ? options.signal : undefined
  if (accel.mode.includes('proxy')) {
    // 措辞要是**事实**而不是结论：这条命令确实会走代理，但它成不成功还不知道。
    notes.push('本次命令走代理 ' + maskProxy(netConfig.proxy) + '（只作用于本次命令）')
  }
  // 克隆大仓库要给足预算；fetch/pull 通常很快，配合 http.lowSpeedTime 把上限压短，
  // 卡住时能尽快回退，而不是干等 10 分钟。
  const mirrorTimeoutMs = op === 'clone' ? timeoutMs : Math.min(timeoutMs, 120000)
  let args = accel.args
  let fullArgv = [...args, ...argv]
  let result = await runGit(fullArgv, dir, {
    timeoutMs: accel.mirror ? mirrorTimeoutMs : timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  })

  if (accel.mirror === true) {
    if (result.code === 0) {
      notes.push('已通过镜像 ' + mirrorLabel(netConfig.mirror) + ' 加速（只作用于本次命令，不改你的 git 配置）')
    } else if (mirrorFallbackWorthwhile(result.stderr)) {
      args = networkExtraArgs(op, netConfig, { noMirror: true }).args
      fullArgv = [...args, ...argv]
      const retry = await runGit(fullArgv, dir, {
        timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      })
      // 直连也没成功时要照实说，否则「已改用直连」会让用户以为问题出在镜像上。
      notes.push('镜像 ' + mirrorLabel(netConfig.mirror) + ' 没走通（'
        + (firstLine(result.stderr) || 'git 退出码 ' + result.code)
        + '），已自动改用直连' + (retry.code === 0 ? '' : '，直连也没成功'))
      result = retry
    } else {
      // 与网络无关：既不回退（白跑一次），也不写「镜像没走通」（会把用户引偏）。
      notes.push('这次失败与网络无关，没有按镜像故障回退直连：问题不在加速设置上')
    }
  }
  return { argv: fullArgv, args, result, accel, notes }
}

/**
 * 冲突文件清单（`git diff --name-only --diff-filter=U`，纯本地只读）。
 * 面板给「撤销这次合并」按钮的同时，把要处理的文件列出来 ——
 * 否则用户只知道「有冲突」，还得自己去终端里 git status 才知道是哪些文件。
 * 任何失败都返回空列表：清单是提示，不是依赖。
 */
async function conflictedFiles(dir) {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (result.code !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * 把面板操作翻译成 git 参数数组。只接受注册表里的操作；任何用户字符串都作为
 * 独立参数传递，不参与命令拼接。
 *
 * @param dir - **已经归一化**的执行目录（路由传 getDefaultDir() 的结果）。
 *   setRemote 要用它做「同名远程在不在」的查重，必须与真正执行命令的目录一致。
 * @throws 参数不合法时抛带中文提示的错误（面板直接展示）。
 */
async function buildOpArgv(op, input = {}, dir) {
  const spec = OPS[op]
  if (spec === undefined) throw new Error('未知操作：' + String(op))
  const body = input === null || input === undefined ? {} : input
  const cwd = normalizeDir(dir) ?? normalizeDir(body.dir)
  return spec.argv(body, { dir: cwd })
}

/** 模型工具与面板共用的结果文本（命令回显 + stdout + stderr + 退出码）。 */
function formatGitResult(argv, result) {
  const lines = ['$ git ' + argv.join(' ')]
  if (result.stdout.length > 0) lines.push(result.stdout.replace(/\s+$/, ''))
  if (result.stderr.length > 0) lines.push('[stderr] ' + result.stderr.replace(/\s+$/, ''))
  if (result.code !== 0) lines.push('[exit code: ' + result.code + ']')
  return lines.join('\n')
}


// ── 推送补救 ──────────────────────────────────────────────────────────────

/**
 * 推送失败后的自动补救。一次「点了推送没反应」是最常见的卡点，所以这里按
 * git 的原始反馈再替用户做一步，而不是把 stderr 原样甩回面板：
 *
 *   - 没有上游分支（最常见：本地新分支第一次推）→ 自动补 `-u <远程> HEAD` 重推，
 *     等价于 git 自己提示的那条命令。**远程优先用用户选的那个**（body.remote），
 *     origin 只是「用户没选、也没配上游」时的兜底 —— 多远程下替用户挑一个远程
 *     是会推错地方的（现场：origin 是别人的仓库、根本没有写权限）。
 *   - 没有远程 / 认证失败 / 非快进 → 不做自动动作，只回传 reason 让面板给提示。
 *     这三类要么缺用户输入（地址），要么会改动历史，自动做只会更糟。
 *   - **没有写权限**（no-permission）→ 同样不重试（换参数也推不进去），但把现场
 *     带回去：这个仓库还有哪些远程可以试。面板据此给出「推送到 fork」按钮 ——
 *     这正是「官方仓库只读 + 自己的 fork 可写」这个最常见形态的出路。
 *
 * @returns { argv, result, reason, retried }：面板展示用（retried 表示命令被替换过）。
 * @param ctx.extraArgs - 网络加速参数。重试也必须带上：否则「开着代理重推一次」会退化成直连。
 */
async function recoverPush(ctx) {
  const { op, body, argv, result, dir, timeoutMs, extraArgs = [], signal } = ctx
  const reason = result.code === 0 ? 'none' : classifyPushFailure(result.stderr)
  if (op !== 'push' || result.code === 0) return { argv, result, reason, retried: false }
  // 用户在这次请求里显式选了远程（面板的「推送到」/远程行的「推送到此」）。
  const asked = trimmedOrNull(body === null || body === undefined ? undefined : body.remote)

  // 本地分支名 ≠ 上游名：git 直接拒绝，**任何形态的重试都白搭** —— 换个 refspec 就等于
  // 替用户在「推到上游那个分支」和「另建同名远端分支」之间做选择，而这两件事的后果
  // 完全不同。所以这里只把现场（上游是谁、本地叫什么）带回去，由路由拼成可点的路
  // （见 mismatchPushChoices）。两次 git 只在**失败路径**上花。
  if (reason === 'upstream-name-mismatch') {
    const local = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
    // 先问 @{upstream}（一条 git）；它在「远端跟踪引用还没下载到本地」时会解析失败 ——
    // 而「本地名 ≠ 上游名」的现场常常正是这样（刚手工配好上游、还没 fetch 过），
    // 所以再退一步读 branch.<名字>.remote/merge 配置。两步都拿不到才算真不知道。
    let upstream = hasText(local) ? await upstreamRef(dir, timeoutMs) : null
    if (upstream === null && hasText(local)) upstream = await upstreamFromConfig(local, dir, timeoutMs)
    // 连上游都问不出来时，至少要给出「往哪个远程推」——否则「另建同名分支」这条路也没了。
    let remote = upstream !== null ? upstream.remote : null
    if (remote === null) remote = asked
    if (remote === null) {
      const remotes = parseRemotes(
        (await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout,
      )
      if (remotes.some((item) => item.name === 'origin')) remote = 'origin'
      else if (remotes.length > 0) remote = remotes[0].name
    }
    const known = hasText(local) && hasText(remote)
    return {
      argv,
      result,
      reason,
      retried: false,
      mismatch: known ? { remote: remote, branch: upstream !== null ? upstream.branch : null, local: local } : null,
    }
  }

  // 「这个远程不让推」的两种现场：没有写权限（授权）与分支受保护。两者的下一步都是
  // **换一个你能推的远程**（自己的 fork）—— 所以共用同一份现场与按钮，
  // 差别只在 reason 与提示文案（诊断必须说实话：受保护分支不是权限问题）。
  if (reason === 'no-permission' || reason === 'branch-protected') {
    return {
      argv,
      result,
      reason,
      retried: false,
      remoteChoices: await pushRemoteScene(dir, timeoutMs, asked, argv),
    }
  }

  if (reason !== 'no-upstream') return { argv, result, reason, retried: false }
  const mode = body !== null && typeof body.mode === 'string' ? body.mode : 'auto'
  if (mode === 'plain') return { argv, result, reason, retried: false }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }

  // 用**用户选的那个**远程；他没选（或选的那个已经不在了）才退回 origin、再退回唯一的那个。
  // 这里原先一律优先 origin —— 那正是「多远程下替你推错地方」的来源。
  const picked = asked !== null && remotes.some((item) => item.name === asked) ? asked : null
  const chosen = picked ?? (remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name)
  const retryArgv = [...extraArgs, 'push', '--set-upstream', chosen, 'HEAD']
  const retry = await runGit(retryArgv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
  if (retry.code === 0) {
    return {
      argv: retryArgv,
      result: {
        code: 0,
        stdout: [result.stdout, retry.stdout].filter((text) => text.length > 0).join('\n'),
        stderr: [result.stderr, retry.stderr].filter((text) => text.length > 0).join('\n'),
      },
      reason: 'none',
      retried: true,
      // 替用户选了哪个远程必须说出来：补救动作不能默默发生（这次是用户选的就照说，
      // 是他选的更要说清楚「推到了你选的那个」）。
      note: picked !== null
        ? '已自动改用 git push --set-upstream ' + chosen + ' HEAD 重推并建立跟踪（推的是你选的远程 '
          + chosen + '）。以后点「推送」即可'
        : (remotes.length > 1
            ? '已自动改用 git push --set-upstream ' + chosen + ' HEAD 重推并建立跟踪（仓库有多个远程，选的是 '
              + chosen + '）。以后点「推送」即可'
            : '已自动改用 git push --set-upstream ' + chosen + ' HEAD 重推，并把这个分支登记为跟踪（以后点「推送」即可）'),
    }
  }
  const retryReason = classifyPushFailure(retry.stderr)
  // **重试这一下也可能撞上同一个墙**（正是本次现场：裸推缺上游 → 自动补 -u 重推到
  // origin → 服务器说 Permission denied / 分支受保护）。这条路的终点必须和直连那次
  // 一样带上现场，否则面板拿不到候选，只剩一句提示、没有一个能点的按钮 ——
  // 而那正是用户被卡住的地方。
  const blocked = retryReason === 'no-permission' || retryReason === 'branch-protected'
  return {
    argv: retryArgv,
    result: retry,
    reason: retryReason,
    retried: true,
    remoteChoices: blocked ? await pushRemoteScene(dir, timeoutMs, asked, retryArgv) : undefined,
  }
}

/**
 * 「这次到底是推给哪个远程、还能往哪儿推」的现场，交给路由拼「推送到 xxx」按钮。
 *
 * 只在**失败路径**上跑几条本地 git（列远程 / 当前分支名 / 上游配置），所以放这儿不心疼。
 * 两个关键判断：
 *   1. 认出**刚失败的那个远程**并把它排除 —— 认不出来时面板会给出一个「再试一次它」
 *      的按钮，用户点一下还是同一堵墙；
 *   2. 排除**与它同地址**的远程 —— 两个远程名指向同一个 URL 时，换名字推过去是同一堵墙
 *      （本插件专门为「两个远程同地址」给过警告，见 git.js 的 duplicateRemotes）。
 *
 * @param asked - 用户在这次请求里显式选的远程（body.remote），没有则为 null。
 * @param argv - 这次真正执行的 argv（裸推时里面没有远程名，靠上游/配置推出来）。
 * @returns { names, attempted, local }：names 已经排掉「刚失败那个」与「同地址的那些」。
 */
async function pushRemoteScene(dir, timeoutMs, asked, argv) {
  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  const local = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
  let attempted = asked ?? pushRemoteFromArgv(argv)
  if (attempted === null && hasText(local)) {
    const upstream = await upstreamRef(dir, timeoutMs) ?? await upstreamFromConfig(local, dir, timeoutMs)
    if (upstream !== null) attempted = upstream.remote
  }
  // 还是没有（例如 push.default=matching 且没配上游）：问 git 自己的推送目标配置。
  if (attempted === null) attempted = await pushRemoteOverride(local, dir, timeoutMs)
  const failed = remotes.find((item) => item.name === attempted) ?? null
  const candidates = failed === null
    ? remotes
    : remotes.filter((item) => item.url !== failed.url)
  return { names: candidates.map((item) => item.name), attempted, local }
}

/**
 * 一次 `git push` 没有上游、argv 里也没写远程时，git 会把提交推给**哪个**远程？
 * 读 git 自己的两级推送目标配置：`branch.<名字>.pushRemote` → `remote.pushDefault`
 * （上游 `branch.<名字>.remote` 已在上一步查过，不重复）。
 *
 * 为什么要在失败路径上多查这一条：`push.default=matching` 这类配置下裸 push 不需要
 * 上游也能推，失败时如果认不出推的是谁，面板就会把刚刚被拒的那个远程又列成候选 ——
 * 用户点一下还是同一堵墙。查不到就返回 null，调用方照旧把候选留给用户自己判断。
 */
async function pushRemoteOverride(local, dir, timeoutMs) {
  const wait = timeoutMs ?? GIT_LOCAL_TIMEOUT_MS
  const keys = []
  if (hasText(local)) keys.push('branch.' + local + '.pushRemote')
  keys.push('remote.pushDefault')
  for (const key of keys) {
    const found = await runGit(['config', '--get', key], dir, { timeoutMs: wait })
    const name = found.code === 0 ? found.stdout.trim() : ''
    if (name.length > 0 && name !== '.') return name
  }
  return null
}

/**
 * 从一个 push 的 argv 里取「推到了哪个远程」（裸推时没有，返回 null）。
 *
 * 只在失败路径上用：说清「这次推的是 origin」，面板据此把按钮给成「推送到 fork」
 * 而不是再给一次 origin。argv 形如 `['push', 'origin', 'HEAD']`、
 * `['-c', 'key=value', …网络参数…, 'push', '--set-upstream', 'fork', 'HEAD']`：
 * 从**第一个** `push`（子命令一定在最前，`-c` 的值永远是 `key=value` 形状，
 * 不会等于 `push` 这个裸词）往后走，跳过选项，第一个普通参数就是远程名。
 * 这里刻意不用 lastIndexOf：远程名恰好叫 `push` 时（`git push push HEAD`），
 * 从后往前会把 `HEAD` 当成远程。
 */
function pushRemoteFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  const at = list.indexOf('push')
  if (at < 0) return null
  for (let index = at + 1; index < list.length; index += 1) {
    const item = String(list[index] ?? '')
    if (item.length === 0 || item.startsWith('-')) continue
    return item
  }
  return null
}

/**
 * 当前分支的上游拆成 { remote, branch }；没有上游返回 null。
 *
 * 用途：裸 `git pull` 直接撞上「两套历史互不相关」时（分支已经配了上游，
 * 所以第一步就走到了合并），报错里没有远程名和分支名 —— 而渲染「选一个结果」
 * 的两个按钮恰恰需要它们（见路由里的 choices）。
 */
async function upstreamRef(dir, timeoutMs) {
  const found = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    dir,
    { timeoutMs: timeoutMs ?? GIT_LOCAL_TIMEOUT_MS },
  )
  const name = found.code === 0 ? found.stdout.trim() : ''
  const slash = name.indexOf('/')
  if (slash <= 0 || slash >= name.length - 1) return null
  return { remote: name.slice(0, slash), branch: name.slice(slash + 1) }
}

/**
 * 当前分支的上游，直接读**配置**：`branch.<名字>.remote` + `branch.<名字>.merge`。
 *
 * 为什么不只用 `@{upstream}`（见 upstreamRef）：它要求对应的远端跟踪引用已经存在。
 * 而「本地名 ≠ 上游名」的现场常常是刚手工配好上游、还没 fetch 过 —— 这时
 * `@{upstream}` 会解析失败，现场信息就白丢了（面板因此给不出那三条路）。
 * 配置永远在，所以它是那一步的兜底。
 *
 * @returns { remote, branch }；没配上游返回 null（`remote = .` 表示上游是本地分支，不算远端）。
 */
async function upstreamFromConfig(local, dir, timeoutMs) {
  const wait = timeoutMs ?? GIT_LOCAL_TIMEOUT_MS
  const remoteResult = await runGit(['config', '--get', 'branch.' + local + '.remote'], dir, { timeoutMs: wait })
  const mergeResult = await runGit(['config', '--get', 'branch.' + local + '.merge'], dir, { timeoutMs: wait })
  const remote = remoteResult.stdout.trim()
  const merge = mergeResult.stdout.trim()
  if (merge.length === 0) return null
  if (remote === '.') return null
  const branch = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : merge
  if (branch.length === 0) return null
  return { remote: remote.length > 0 ? remote : 'origin', branch: branch }
}

/**
 * 在远端分支列表里挑出「该按哪个分支拉」的那一个。
 *
 * 规则（都是**确定**的推断，绝不猜）：
 *   - 远端自己的默认分支（`origin/HEAD -> origin/main`）优先；
 *   - 拿不到指针、但该远程只有一个分支时，就是它；
 *   - 多个分支又没有指针 → 返回 null，交回给 remote-branch-missing 的提示，
 *     让用户自己去「管理」里选。
 * 结果和本地分支同名时也返回 null：同名说明走到这里的场景不成立。
 *
 * @param parsed - parseRemoteBranchOutput 的结果。
 * @returns 远端分支名（如 'main'）或 null。
 */
function pickRemoteDefaultBranch(parsed, remote, localBranch) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const items = Array.isArray(source.items) ? source.items : []
  const own = items.filter((item) => item.remote === remote)
  if (own.length === 0) return null
  let target = null
  if (typeof source.defaultRef === 'string' && own.some((item) => item.ref === source.defaultRef)) {
    target = source.defaultRef
  } else if (own.length === 1) {
    target = own[0].ref
  }
  if (target === null || target.slice(0, remote.length + 1) !== remote + '/') return null
  const branch = target.slice(remote.length + 1)
  if (branch.length === 0 || branch === localBranch) return null
  return branch
}

/**
 * 逐个远程向服务器问「你的默认分支是哪个」。
 *
 * 为什么需要这一问：本地标出默认分支靠的是 `origin/HEAD` 这个符号引用，而它**只在
 * git clone 时建立**（新版 git 也会在首次 fetch 顺手补一个，但旧版不会）。于是：
 *   - `git init` + 手动加远程（旧版 git）→ 本地没有 origin/HEAD → 列表里没有任何标记；
 *   - 从镜像拉取 → 镜像常常不导出 HEAD 符号引用 → 同样没有；
 *   - 远端默认分支改过名 → 本地 origin/HEAD 还指旧名字，指向的分支被 `--prune` 清掉后
 *     就成了「有指针、没着落」，同样标不出来。
 * 这里用 `git ls-remote --symref <远程> HEAD` 直接问服务器（只读、只传一个引用），
 * 三种现场都能拿到正确答案。加速设置（镜像/代理）同样作用于这条查询：
 * 开了加速却连不上 github.com 的用户，这条查询也必须走同一套线路。
 *
 * @returns [{ remote, branch }]；每个远程最多一条，查不到（失败/超时/服务器不认
 *   --symref）就跳过 —— 兜底是加分项，任何失败都不能让分支列表跟着报错。
 */
async function remoteDefaultBranches(dir) {
  const listed = await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (listed.code !== 0) return []
  const remotes = parseRemotes(listed.stdout).map((item) => item.name)
  if (remotes.length === 0) return []
  const accel = networkExtraArgs('ls-remote', await readNetConfig())
  const results = await Promise.all(remotes.map(async (name) => {
    const result = await runGit(
      [...accel.args, 'ls-remote', '--symref', name, 'HEAD'],
      dir,
      { timeoutMs: REMOTE_HEAD_TIMEOUT_MS },
    )
    if (result.code !== 0) return null
    const branch = parseLsRemoteHead(result.stdout)
    return branch === null || branch.length === 0 ? null : { remote: name, branch: branch }
  }))
  return results.filter((item) => item !== null)
}

/**
 * 远端分支列表的「默认分支补全」（挂在 branches / remoteBranches 的 enhance 上）。
 *
 * 本地 `git branch --remotes` 已经给出 origin/HEAD 指针时（典型克隆），**不做任何
 * 网络查询**，原样返回；只有指针缺失或指向的分支不在列表里（见 remoteDefaultBranches
 * 的三种现场）才补查。补查结果里能对应上的分支标 head=true，同时把
 * `defaults: [{ remote, branch }]` 带回 —— 面板据此在远端分组顶部写一行
 * 「远端默认分支：origin/main」，即使那个分支还没下载到本地也能看见。
 *
 * @param parsed - parseRemoteBranchOutput 的结果。
 * @returns { items, defaultRef, defaults }：defaultRef 仍是本地解析出来的指针
 *   （可能为 null），defaults 是本次查到的服务器答案。
 */
async function enhanceRemoteBranches(parsed, dir) {
  const base = parsed !== null && typeof parsed === 'object' ? parsed : { items: [], defaultRef: null }
  const items = Array.isArray(base.items) ? base.items.slice() : []
  const known = typeof base.defaultRef === 'string' && base.defaultRef.length > 0
    && items.some((item) => item.ref === base.defaultRef)
  if (known) return { items: items, defaultRef: base.defaultRef, defaults: [] }

  let defaults = []
  try {
    defaults = await remoteDefaultBranches(dir)
  } catch {
    // 查远程失败绝不能让分支列表跟着失败：默认标记是加分项，不是依赖项。
    defaults = []
  }
  const marked = new Set()
  for (const found of defaults) {
    const ref = found.remote + '/' + found.branch
    if (marked.has(ref)) continue
    const item = items.find((entry) => entry.ref === ref)
    if (item !== undefined) item.head = true
    marked.add(ref)
  }
  return { items: items, defaultRef: base.defaultRef, defaults: defaults }
}

/**
 * 本地分支名在远端不存在时的第二条路（见 recoverPull）。
 *
 * 现场：本地是 `git init` 出来的 `master`，远端默认分支叫 `main`。裸 `git pull` 报
 * 「没有跟踪信息」，自动重试 `git pull origin master` 又报 `couldn't find remote ref
 * master`；面板于是给一句「先点一次推送把它推上去」—— 用户照做会在 GitHub 上多出一个
 * master 分支，而真正的出路（远端那份要不要拿过来）一个字都没提。
 *
 * 这里按远端的默认分支（`origin/HEAD -> origin/main`）再判断一次：
 *   - 两套历史互不相关 → **不合并**（git 自己也会拒绝），把 reason 报成 unrelated，
 *     面板据此渲染「要远端那份 / 要本地那份」两个按钮，动作指向真正的 origin/main；
 *   - 历史相关（同名分支被改名这类）→ 用「远程 + 远端默认分支」拉一次并说明用了哪个分支。
 *
 * @returns { argv, result, reason, retried, remote, branch, note?, message? }；没有可用的
 *   远端默认分支时返回 null，交回给原来的 remote-branch-missing 提示。
 * @param failed - 刚才那次真正跑过、失败的 pull（{ argv, result }）。无关历史那一支
 *   直接把它报回去：结论（远端没有这个分支、默认分支是哪个、两边无关）写在 message 里，
 *   **不伪造 git 的报错原文**。
 */
async function pullRemoteDefaultBranch(dir, remote, localBranch, timeoutMs, extraArgs, failed, signal) {
  const remoteBranch = await pullRemoteDefaultBranchName(dir, remote, localBranch)
  if (remoteBranch === null) return null
  const remoteRef = remote + '/' + remoteBranch

  const situation = '远端没有和当前分支同名的 ' + localBranch + '；远端的默认分支是 ' + remoteRef + '，'
  const base = await runGit(['merge-base', remoteRef, 'HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const unrelated = base.code !== 0 || base.stdout.trim().length === 0
  if (unrelated) {
    return {
      argv: failed.argv,
      result: failed.result,
      reason: 'unrelated',
      retried: true,
      remote: remote,
      branch: remoteBranch,
      message: situation + '两边是两套互不相关的历史（git 不会替你合并）',
    }
  }

  const argv = [...extraArgs, 'pull', remote, remoteBranch]
  const result = await runGit(argv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
  if (result.code !== 0) {
    return {
      argv: argv,
      result: result,
      reason: classifyPullFailure(pullFailureText(result)),
      retried: true,
      remote: remote,
      branch: remoteBranch,
      note: situation + '这次按它拉取（结果见上）',
    }
  }
  return {
    argv: argv,
    result: result,
    reason: 'none',
    retried: true,
    remote: remote,
    branch: remoteBranch,
    note: situation + '这次按它拉取；没有登记上游（分支名不同，登记后推送会撞上 git 的 simple 规则）',
  }
}

/**
 * 「这个远端有没有和本地分支不同名的默认分支」——只有默认分支名，不执行任何拉取。
 *
 * 两个调用方共用：pullRemoteDefaultBranch（裸 pull 的自动兜底，会真的去拉）与
 * recoverPull（显式选了远程时把这条路做成按钮，绝不自动拉）。纯本地（`branch --remotes`），
 * 不发网络请求 —— 拿不到远端分支列表时返回 null，调用方照旧给「先点获取远程」的提示。
 *
 * @returns 远端分支名（如 'main'）或 null（列表读不到 / 远端没有分支 / 只有同名那条）。
 */
async function pullRemoteDefaultBranchName(dir, remote, localBranch) {
  const listed = await runGit(['branch', '--remotes', '--no-color'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (listed.code !== 0) return null
  return pickRemoteDefaultBranch(parseRemoteBranchOutput(listed.stdout), remote, localBranch)
}

/**
 * 从**真正执行的那条 argv** 里读回「这次是从哪个远程的哪个分支拉的」。
 *
 * 为什么读 argv 而不是读 body：分支名常常是宿主补的（面板只传 remote，见 OPS.pull.argv），
 * body 里没有它；而补救动作（镜像回退、无上游重试）还会**替换** argv —— 只有这份
 * 最终命令才是真的执行过的那一条。识别方式是找最后一个 `pull` 子命令，它后面第一个
 * 不以 `-` 开头的参数就是远程（加速参数 `-c …` 都在子命令之前，所以不会被误读）。
 *
 * @returns { remote, branch } 或 null（裸 pull / 读不出来）。
 */
function pullTargetFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  const at = list.lastIndexOf('pull')
  if (at < 0) return null
  const rest = list.slice(at + 1).filter((item) => (
    typeof item === 'string' && item.length > 0 && item.charAt(0) !== '-'
  ))
  if (rest.length === 0) return null
  return { remote: rest[0], branch: rest.length > 1 ? rest[1] : null }
}

/**
 * 「这次是从你选的远程拉的」——只在**选了远程**时给一句说明（裸 pull 不给）。
 *
 * 为什么必须说：多远程下「刚才那一下把哪个仓库的更新合进了我的分支」直接决定了代码的
 * 来源，而它和「推送到」是两件事（可能推 fork、却要从 origin 拉）。与 pushTargetNote
 * 同一个理由，也是同一种克制：目标由 git 配置决定时面板不替它说话。
 */
function pullFromNote(target) {
  const info = target === null || target === undefined ? {} : target
  const remote = trimmedOrNull(info.remote)
  if (remote === null) return null
  const branch = trimmedOrNull(info.branch)
  const from = remote + (branch === null ? '' : '/' + branch)
  return '这次是从你选的远程拉的（git pull ' + remote + (branch === null ? '' : ' ' + branch)
    + '，即 ' + from + '）：只换这一次的来源，当前分支的上游跟踪关系一个字节没动'
}

/**
 * 「远端没有这条分支」时告诉用户下一步点哪里。
 *
 * 与 pullHint 的通用版分开：通用版的场景是**裸 pull**（来源由上游决定），这句是
 * 「你点名要的那个远端上没有这个名字」—— 这时「先获取远程再在管理里看」只是诊断，
 * 真正的出路是面板下面那个「改从 <远程>/<默认分支> 拉取」按钮。
 */
function pullMissingBranchHint(remote, branch, fallback) {
  const head = '远端 ' + remote + ' 上没有 ' + (branch ?? '这条') + ' 分支，所以这次没有可拉的东西：'
    + '本地记着的是上一次获取远程时的样子，远端可能刚改过。'
  if (fallback === null || fallback === undefined || fallback.length === 0) {
    return head + '点「获取远程」把它的分支列表下载下来，再展开「管理」看 ' + remote
      + ' 有哪些分支（在那里也能把它某条分支一键拿成本地新分支）。'
  }
  return head + '它自己的默认分支是 ' + remote + '/' + fallback + '：'
    + '要拿那一份就点下面的「改从 ' + remote + '/' + fallback + ' 拉取」；'
    + '想拉别的分支，先「获取远程」再去「管理」里看。'
}

/**
 * 拉取失败后的自动补救；成功时补一句「这次是从你选的远程拉的」。
 *
 * 背景：面板的「拉取」原先固定跑裸 `git pull`，而**没有上游的分支上它必然失败**
 * （`There is no tracking information for the current branch`）—— 那条命令连网络
 * 都没碰，面板却把它当成网络/镜像故障，用户就卡在「要推送得先拉取、要拉取又得先有上游」
 * 的循环里。这里按 git 自己给的补救办法处理：
 *
 *   - 没有上游 → 用「远程 + 当前分支」再拉一次（`git pull <远程> <分支>` 不要求上游），
 *     成功后顺手登记上游（`branch --set-upstream-to`），以后裸 pull 就能直接用。
 *   - 重试报「远端没有这个分支」→ 改用远端的默认分支再判断一次（见 pullRemoteDefaultBranch）。
 *   - 没有远程 / 无关历史 / 冲突 → 不做自动动作，只回传 reason，
 *     由 pullHint 告诉用户下一步点哪里（无关历史还会附带两个按钮）。
 *
 * **用户显式选了远程时**（面板「拉取自」/「安全拉取」，见 OPS.pull 的 remote 参数）
 * 另有三条不同：
 *   - 成功 → 带回一句 `note` 说明这次的目标（裸 pull 不说：来源由配置决定，面板不替它说）；
 *   - 「远端没有这条分支」→ **不自动**改拉默认分支（那是把另一条线并进当前分支），
 *     只带回 `pullFromDefault`，由面板渲染成一个可点的按钮；
 *   - 「两套历史互不相关」→ 两条路指向**这次真正拉的那个**远端，而不是当前分支的上游
 *     （「拉取自 upstream」的现场里，上游往往恰恰是另一个仓库）。
 *
 * @returns { argv, result, reason, retried, remote?, branch?, note?, message?, hint?, pullFromDefault? }
 *   —— 与 recoverPush 同形，路由同一处处理。
 * @param ctx.extraArgs - 网络加速参数。重试也要带上：否则「开着代理重拉一次」会退化成直连。
 *
 * 与 recoverPush 共用同一个 `(ctx)` 形状：两者原先签名不同（push 多一个 body），
 * 挂到 OPS 表上时就得在两处记两套参数顺序 —— 那种差异正是分叉的起点。
 */
async function recoverPull(ctx) {
  const { op, argv, result, dir, timeoutMs, extraArgs = [], signal } = ctx
  const reason = result.code === 0 ? 'none' : classifyPullFailure(pullFailureText(result))
  if (op !== 'pull') return { argv, result, reason, retried: false }

  // 这次到底是从哪儿拉的：从**真正执行的 argv** 里读回来，而不是重新推一遍
  // （body 里可能只有 remote、分支名是宿主补的，见 OPS.pull.argv）。两个用途：
  // 成功时说清目标；失败时让「改从默认分支拉」这类出路指向对的远程。
  const askedTarget = pullTargetFromArgv(argv)

  // 成功也要说一句「这次是从你选的远程拉的」——与 pushTargetNote 同一理由：
  // 多远程下「刚才那一下把哪个仓库的更新合进来了」是用户最该被告知的事。
  // 裸 pull（没选远程）不说：那时来源由 git 的配置决定，面板不替它说。
  if (result.code === 0) {
    return {
      argv, result, reason, retried: false,
      note: askedTarget === null ? undefined : pullFromNote(askedTarget),
    }
  }

  // 「两套历史互不相关」有两种到达方式：有上游时裸 pull 就撞上，或者下面的自动重试撞上。
  // 第一种原先只带回 reason、不带 remote/branch，于是按钮渲染不出来，而提示里却写着
  // 「在下面的选项里选一个结果」—— 用户看到的是一句指向不存在按钮的话。这里把上游补出来。
  //
  // 显式选了远程时**优先用这次真正拉的那个**：裸 pull 时来源由上游配置决定，所以才有
  // 必要去问 upstreamRef；而「拉取自 X」的现场里，上游往往恰恰是另一个人（fork）——
  // 拿它去拼「把远端那份拿成新分支」的按钮会指向错误的仓库。
  if (reason === 'unrelated') {
    const target = askedTarget !== null ? askedTarget : await upstreamRef(dir, timeoutMs)
    if (target === null) return { argv, result, reason, retried: false }
    return {
      argv: argv,
      result: result,
      reason: reason,
      retried: false,
      remote: target.remote,
      branch: target.branch,
    }
  }

  // 远端没有和当前分支同名的那条分支。**绝不自动改拉默认分支**：那是把另一条历史
  // 并进当前分支，与「在远端另建同名分支」完全不是一回事，替用户做等于替他改了
  // 代码的来龙去脉。只把这条路摆出来（面板渲染成一个按钮），点一下才算数。
  if (reason === 'remote-branch-missing' && askedTarget !== null) {
    const fallback = await pullRemoteDefaultBranchName(dir, askedTarget.remote, askedTarget.branch)
    return {
      argv: argv,
      result: result,
      reason: reason,
      retried: false,
      remote: askedTarget.remote,
      branch: askedTarget.branch,
      pullFromDefault: fallback === null ? null : { remote: askedTarget.remote, branch: fallback },
      message: '远端 ' + askedTarget.remote + ' 上没有 ' + (askedTarget.branch ?? '这条') + ' 分支',
      hint: pullMissingBranchHint(askedTarget.remote, askedTarget.branch, fallback),
    }
  }
  if (reason !== 'no-upstream') return { argv, result, reason, retried: false }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }
  // 用户选的那个远程优先（与 recoverPush 同一条判断）；他没选才退回 origin、再退回唯一的那个。
  const askedRemote = askedTarget === null ? null : askedTarget.remote
  const picked = askedRemote !== null && remotes.some((item) => item.name === askedRemote) ? askedRemote : null
  const chosen = picked ?? (remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name)

  // 当前分支名。真游离 HEAD 时拿不到名字，那就不硬猜了，交回给 pullHint 说清楚。
  const branch = askedTarget !== null && askedTarget.branch !== null
    ? askedTarget.branch
    : await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
  if (branch.length === 0) return { argv, result, reason, retried: false }

  const retryArgv = [...extraArgs, 'pull', chosen, branch]
  const retry = await runGit(retryArgv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
  if (retry.code !== 0) {
    const retryReason = classifyPullFailure(pullFailureText(retry))
    // 只有「远端没有这个分支」才值得换默认分支再试：别的失败（冲突、认证、网络）与分支名无关。
    if (retryReason === 'remote-branch-missing') {
      const fallback = await pullRemoteDefaultBranch(
        dir, chosen, branch, timeoutMs, extraArgs, { argv: retryArgv, result: retry }, signal,
      )
      if (fallback !== null) return fallback
    }
    // 把这次真正用的远程与分支带回去：路由要靠它们构造「两套历史互不相关」时的
    // 两个选择（见 unrelatedChoices），否则又得多查一遍 git。
    return {
      argv: retryArgv,
      result: retry,
      reason: retryReason,
      retried: true,
      remote: chosen,
      branch: branch,
    }
  }

  // 拉成功：顺手把上游登记上，让「拉取」按钮下次能直接用。登记失败也要照实说
  // （本次拉取确实完成了，只是下次还得再走一遍自动判断），不能写成「已建立跟踪」。
  const tracked = await runGit(
    ['branch', '--set-upstream-to=' + chosen + '/' + branch, branch],
    dir,
    { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  )
  const note = tracked.code === 0
    ? '这个分支原先没有上游：已自动按「' + chosen + ' ' + branch + '」拉取，并把它登记为上游（以后直接点「拉取」即可）'
    : '这个分支原先没有上游：已自动按「' + chosen + ' ' + branch + '」拉取；上游没能自动登记（'
      + (firstLine(tracked.stderr) || 'git 退出码 ' + tracked.code) + '）'
  return { argv: retryArgv, result: retry, reason: 'none', retried: true, note: note }
}


// ── 「两套历史互不相关」时用户要做的选择 ──────────────────────────────────
//
// 背景：本地是 `git init` 出来的一条历史、远端是别人另一条历史时，git 不会自动合并
// （`refusing to merge unrelated histories`）。**这不是命令写错了，而是要用户做一个
// 决定**：要远端那份，还是要本地那份。以前面板只能把这个决定翻译成中文再丢回给用户
// （「请在终端里处理」），对不懂 git 的人来说等于没帮上忙。
//
// 这里把两条路都实现成可执行的操作，由面板渲染成按钮：
//   branch —— 安全：把远端那份开成一个新分支（当前分支一点不动）；
//   reset  —— 覆盖：让当前分支直接等于远端（有前置检查，并告诉用户旧提交怎么找回）。
// 面板不替用户猜哪条对，但把「选哪个结果」变成只需要点一下。
// ──────────────────────────────────────────────────────────────────────────

/** `/git-sidebar/op` 的响应骨架：面板会读这些字段，缺哪个它就读到 undefined。 */
function opResponse(partial = {}) {
  return {
    ok: false,
    command: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    message: null,
    reason: 'none',
    hint: null,
    retried: false,
    accelerated: 'direct',
    network: false,
    notes: [],
    clonedDir: null,
    branches: null,
    remoteBranches: null,
    compare: null,
    diff: null,
    choices: null,
    ...partial,
  }
}

/**
 * 「本地分支名 ≠ 上游分支名」时给面板的三条路（面板渲染成按钮）。
 *
 * git 只回一句英文拒绝（默认配置 `push.default=simple` 只在两边同名时才肯裸推），
 * 三条路对应三种真实意图，全都由面板代跑 —— 用户不必记住 `HEAD:main` 这种 refspec。
 * 拿不到上游名或本地名时对应那条就不出现：宁缺勿猜。
 *
 * @param mismatch - { remote, branch, local }（见 recoverPush）。
 */
function mismatchPushChoices(mismatch) {
  const info = mismatch !== null && typeof mismatch === 'object' ? mismatch : {}
  const remote = trimmedOrNull(info.remote)
  const branch = trimmedOrNull(info.branch)
  const local = trimmedOrNull(info.local)
  const choices = []
  if (remote !== null && branch !== null) {
    choices.push({
      id: 'push-upstream',
      label: '推到上游跟踪的 ' + remote + '/' + branch,
      detail: '本地分支名一点不动，只把这次的提交推到它一直在跟踪的那个远端分支上'
        + '（git push ' + remote + ' HEAD:' + branch + '）。',
      op: 'pushUpstream',
      params: { remote: remote, branch: branch },
      confirm: null,
    })
  }
  if (remote !== null && local !== null) {
    choices.push({
      id: 'push-same-name',
      label: '在远端另建同名分支 ' + local,
      detail: '远端会多出一个 ' + remote + '/' + local + '，本地分支的上游随即改成它'
        + '（git push --set-upstream ' + remote + ' HEAD）。原来跟踪的 '
        + (branch !== null ? remote + '/' + branch : '那个上游') + ' 保持原样，不受影响。',
      op: 'pushSameName',
      params: { remote: remote },
      confirm: null,
    })
  }
  if (branch !== null && local !== null && branch !== local) {
    choices.push({
      id: 'rename-local',
      label: '把本地分支改名成 ' + branch + '（以后不用再选）',
      detail: '两边同名之后 push.default=simple 不会再拒绝，直接点「推送」即可。'
        + '改的只是本地分支名，提交历史一个不动。',
      op: 'renameBranch',
      // from 显式带上：宿主执行 `git branch -m <本地名> <上游名>`。不给 from 的话命令会
      // 变成「改当前分支」—— 与这条路的语义（把**这条**本地分支改成上游的名字）不符。
      params: { name: branch, from: local },
      confirm: '确定把本地分支 ' + local + ' 改名为 ' + branch + ' 吗？\n\n'
        + '· 只改本地分支名，提交历史一个不动\n'
        + '· 上游跟踪关系跟着这个分支保留（仍指向 ' + remote + '/' + branch + '）\n'
        + '· 本地若已经有一个叫 ' + branch + ' 的分支，git 会拒绝，面板会把原因写清楚\n'
        + '· 改完名点一次「推送」就能推上去',
    })
  }
  return choices.length > 0 ? choices : null
}

/**
 * 「这个远程推不进去」时给面板的路：**换一个远程推**。
 *
 * 服务两种现场（两者共用一个按钮组，因为下一步是同一件事）：
 *   · 没有写权限（`no-permission`）—— 现场：origin 指向别人的仓库、你的账号只能读；
 *   · 分支受保护（`branch-protected`）—— 账号能写，但这条引用不许直接更新，
 *     标准出路同样是「推到你自己的远程 → 开 PR」。
 * 因此文案对两者都成立，**不写死「没有权限」**——诊断由各自的 hint 负责说实话。
 *
 * 传进来的 names 已经排掉了「刚失败那个」与「同地址的那些」（见 pushRemoteScene），
 * 这里只做最后一道「名字不等于刚失败那个」的过滤。
 *
 * 参数里只带 remote：面板执行的就是普通的 `git push <远程> HEAD`（显式 refspec），
 * 因此不依赖上游配置、也不改用户的 push.default。`local` 只用来把话说清楚。
 *
 * @param info - { names, attempted, local }（见 recoverPush 的 remoteChoices）。
 */
function otherRemoteChoices(info) {
  const body = info !== null && typeof info === 'object' ? info : {}
  const names = Array.isArray(body.names) ? body.names : []
  const attempted = trimmedOrNull(body.attempted)
  const local = trimmedOrNull(body.local)
  const others = names.filter((name) => hasText(name) && name !== attempted)
  if (others.length === 0) return null
  return others.map((name) => ({
    id: 'push-to-' + name,
    label: '推送到 ' + name,
    detail: '换成远程 ' + name + ' 再推一次' + (local !== null ? '（当前分支 ' + local + '）' : '')
      + '：只把这一次的远程换掉，不动上游配置，也不改任何 git 配置。'
      + (attempted !== null ? '刚才那次推的是 ' + attempted + '，它拒绝了这次推送。' : ''),
    op: 'push',
    params: { remote: name },
    confirm: null,
  }))
}

/**
 * 分支「未完全合并」所以删不掉时给面板的出口：强制删除（-D）。
 *
 * 只给一条路，而且必须二次确认：这条路的后果（丢掉未合并的提交）是不可逆的，
 * 面板能做的是把后果讲清楚，再把决定权交回去。
 */
function forceDeleteChoice(name) {
  const branch = trimmedOrNull(name)
  if (branch === null) return null
  return [{
    id: 'force-delete',
    label: '强制删除分支 ' + branch + '（git branch -D）',
    detail: '这条分支上还没并进当前分支的提交会失去分支引用（短期内还能用 git reflog 找回）。',
    op: 'deleteBranchForce',
    params: { branch: branch },
    confirm: '确定强制删除分支 ' + branch + ' 吗？\n\n'
      + '· 它上面未合并的提交不再有分支指着（可用 git reflog 找回，但有时间限制）\n'
      + '· 当前分支与工作区不受影响\n'
      + '· 这个动作不可逆',
  }]
}

/**
 * 构造「两套历史互不相关」时给面板的两条路（面板渲染成按钮）。
 * @param remote - 远程名（如 origin）。
 * @param branch - 当前本地分支名（如 master）。
 */
function unrelatedChoices(remote, branch) {
  const remoteRef = remote + '/' + branch
  return [
    {
      id: 'branch',
      label: '把远端那份拿成新分支（安全）',
      detail: '新开一个分支，内容就是远端的 ' + remoteRef + '；当前分支 ' + branch + ' 一点都不动。',
      op: 'adoptRemote',
      // 远端分支名必须**显式带上**：这两个按钮出现的场景恰恰是「本地分支名和远端对不上」
      // （本地 master、远端 main 就是最常见的一种），再让 adoptRemote 按当前分支去猜，
      // 只会拼出一个不存在的 origin/master。
      params: { mode: 'branch', remote: remote, branch: branch },
      confirm: null,
    },
    {
      id: 'reset',
      label: '让当前分支直接变成远端那份',
      detail: '用 ' + remoteRef + ' 覆盖当前分支和工作区文件；本地现有提交不再有分支指着（还能用 git reflog 找回）。',
      op: 'adoptRemote',
      params: { mode: 'reset', remote: remote, branch: branch },
      confirm: '确定用远端 ' + remoteRef + ' 覆盖当前分支 ' + branch + ' 吗？\n\n'
        + '· 工作区里已提交的内容会被远端那份替换\n'
        + '· 本地现有提交不再有分支指着（可以用 git reflog 找回）\n'
        + '· 若有未提交的改动，面板会先拒绝执行，不会静默抹掉\n'
        + '· 未跟踪的文件（?? 那些）不受影响',
    },
  ]
}

/**
 * 「远端没有你要的那条同名分支，但它有默认分支」时给的一条明路（面板渲染成一个按钮）。
 *
 * 为什么做成按钮而不是自动做：`git pull <远程> <别的分支名>` 会把**另一条线**的内容
 * 合并进当前分支 —— 对「我的分支叫 local.2、远端只有 master」这种现场，这可能是想
 * 要的（拿主线更新），也可能是灾难（把无关历史并进来）。面板一贯不给这种判断，只把
 * 动作变成一次点击：点了就是「我确实要那一份」。
 */
function pullFromDefaultChoice(remote, branch) {
  return {
    id: 'pull-default-branch',
    label: '改从 ' + remote + '/' + branch + ' 拉取',
    detail: '执行 git pull ' + remote + ' ' + branch + '：把 ' + remote + '/' + branch
      + ' 合并进当前分支（当前分支名不变，上游跟踪关系也不动）。'
      + '两边改到同一处时会出现冲突，面板会给出冲突文件和「撤销这次合并」。',
    op: 'pull',
    params: { remote: remote, branch: branch },
    confirm: null,
  }
}

/**
 * 拉取失败后要摆给用户的选择（面板渲染成一排按钮）。
 *
 * **只此一处**：面板走 routes.js 的 opChoices、安全拉取走 pullOpPayload，两条路
 * 指向同一个函数 —— 此前那段 if/else 抄了两份，新增一条路时漏掉一份就会出现
 * 「面板有按钮、安全拉取没有」（或者反过来的静默分叉）。
 */
function pullChoices(recovery) {
  const info = recovery === null || recovery === undefined ? {} : recovery
  if (info.reason === 'unrelated' && hasText(info.remote) && hasText(info.branch)) {
    return unrelatedChoices(info.remote, info.branch)
  }
  if (info.reason === 'conflict' || info.reason === 'merge-unfinished') return mergeAbortChoice()
  const fallback = info.pullFromDefault
  if (info.reason === 'remote-branch-missing'
    && fallback !== null && fallback !== undefined
    && hasText(fallback.remote) && hasText(fallback.branch)) {
    return [pullFromDefaultChoice(fallback.remote, fallback.branch)]
  }
  return null
}

/**
 * 冲突 / 合并没收尾时给面板的退路：撤销这次合并，回到拉取之前。
 *
 * 为什么「撤销」可以做成按钮，而「解决冲突」不行：解决冲突要用户对每个文件判断留哪边，
 * 面板不能替他选；而「我不想合了」是一个**不需要判断**的决定，git 又恰好有一个安全的
 * 对应动作 —— `merge --abort` 把仓库退回合并开始前，已提交的内容一点不动。
 * 所以这里只给退路，不给答案。
 */
function mergeAbortChoice() {
  return [
    {
      id: 'abort-merge',
      label: '撤销这次合并（回到拉取之前）',
      detail: '你已提交的内容一点不动；冲突文件里那些还没提交的临时改动（包括你已经改了一部分的解决结果）会没有。',
      op: 'abortMerge',
      params: {},
      confirm: '确定撤销这次合并吗？\n\n'
        + '· 仓库回到「拉取之前」的样子\n'
        + '· 你自己已经提交的内容不受影响\n'
        + '· 冲突文件里还没提交的临时改动（含你已经解决了一部分的结果）会丢失，'
        + '需要重新拉取、重新处理',
    },
  ]
}

/**
 * 执行「撤销这次合并」（见 mergeAbortChoice）。
 *
 * 先确认真的有一次合并在进行（MERGE_HEAD 存在），否则 `git merge --abort` 只会回一句
 * 英文报错 —— 用户看到的是"我点了撤销，它却报错"，而真相是"本来就没有需要撤销的东西"。
 */
async function abortMerge(dir, timeoutMs = OP_TIMEOUT_MS) {
  const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (mergeHead.code !== 0) {
    return opResponse({
      ok: false,
      message: '现在没有正在进行的合并，不需要撤销（上一次可能已经撤销掉或提交完成了）。点「刷新」看看当前状态。',
    })
  }

  const branch = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
  const argv = ['merge', '--abort']
  const result = await runGit(argv, dir, { timeoutMs })
  const ok = result.code === 0
  return opResponse({
    ok: ok,
    command: 'git ' + argv.join(' '),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    notes: ok
      ? ['已撤销这次合并：' + (branch.length > 0 ? '分支 ' + branch + ' ' : '')
        + '回到拉取之前的样子，你已提交的内容没有受影响']
      : [],
  })
}

/**
 * 哪条本地分支在跟踪这个远端引用（没有就返回 null）。
 *
 * 一条 `for-each-ref`，纯本地。面板的「远端行 → 已有本地分支 fork-local.2」
 * 交叉引用在客户端用同一份数据（branchUpstreams）算；这里是宿主的兜底判定，
 * 服务 adoptRemote 的「别再造一个 -2」以及将来的其它路径。
 * 多条本地分支跟踪同一个远端引用时按 for-each-ref 的输出顺序取第一条（git 按 ref 排序）。
 */
async function branchTrackingRef(remoteRef, dir) {
  const listed = await runGit(
    ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads'],
    dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  )
  if (listed.code !== 0) return null
  const table = parseBranchUpstreams(listed.stdout)
  for (const name of Object.keys(table)) {
    const entry = table[name]
    if (entry !== null && entry !== undefined && entry.upstream === remoteRef) return name
  }
  return null
}

/**
 * 执行面板上那两条路之一（见 unrelatedChoices）。
 *
 * 为什么单独成一个操作、不走 buildOpArgv：它不是一个「参数 → argv」的纯函数，
 * 而是一段有前置检查、有不可逆后果的动作（看远程、看当前分支、看远端引用在不在、
 * 看工作区干不干净），塞进纯函数里既读不懂也守不住。
 *
 * @param body.mode - 'branch'（安全）| 'reset'（覆盖当前分支）。
 * @param body.name - mode=branch 时可指定新分支名，缺省用 `<远程>-<分支>`。
 * @param body.remote / body.branch - 要拿的是**哪个**远端分支。面板「管理」里点
 *   远端分支时用它（用户点的是 origin/main，不能被当成「当前分支叫 main」）；
 *   缺省仍按当前分支推导 —— 「两套历史互不相关」的两个按钮走这条缺省路。
 * @returns 与 /git-sidebar/op 其余分支同形的响应（不含 state，由调用方补）。
 */
async function adoptRemote(body, dir, timeoutMs = OP_TIMEOUT_MS) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const mode = typeof input.mode === 'string' ? input.mode : ''
  if (mode !== 'branch' && mode !== 'reset') {
    return opResponse({ ok: false, message: '未知的操作方式：' + (mode.length > 0 ? mode : '(空)') })
  }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  if (remotes.length === 0) {
    return opResponse({ ok: false, message: '这个仓库还没有配置远程地址：先在「远程」里填地址并保存。' })
  }

  const askedRemote = typeof input.remote === 'string' ? input.remote.trim() : ''
  const askedBranch = typeof input.branch === 'string' ? input.branch.trim() : ''
  let remote
  if (askedRemote.length > 0) {
    if (!remotes.some((item) => item.name === askedRemote)) {
      return opResponse({ ok: false, message: '这个仓库没有远程 ' + askedRemote + '：先在「远程」里配置。' })
    }
    remote = askedRemote
  } else {
    remote = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name
  }

  let branch = askedBranch
  if (branch.length === 0) {
    branch = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
    if (branch.length === 0) {
      return opResponse({ ok: false, message: '当前不在任何分支上（游离 HEAD）：先切到一个分支再操作。' })
    }
  }
  // 远端分支名同样要校验：它会作为参数交给 git switch / reset。
  if (!isSafeRemoteRef(remote + '/' + branch)) {
    return opResponse({ ok: false, message: '远端分支名不合法：' + remote + '/' + branch })
  }

  const remoteRef = remote + '/' + branch
  const known = await runGit(['rev-parse', '--verify', '--quiet', remoteRef], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (known.code !== 0) {
    return opResponse({
      ok: false,
      message: '本地还没有 ' + remoteRef + '：先点「获取远程」把它下载下来，再做这个选择。',
    })
  }

  if (mode === 'branch') {
    const askedName = typeof input.name === 'string' && input.name.trim().length > 0
    const wanted = askedName ? input.name.trim() : localBranchNameFor(remoteRef)
    /**
     * 「这条远端分支已经有本地分支在跟踪」时**不要**静默建成 `fork-local.2-2`。
     *
     * 那正是「分支越用越乱」的来源：现场 `fork/local.2` 已经由本地 `fork-local.2`
     * 跟踪着，用户只是不知道，点一下「拿成新分支」就多出一条名字相近的分支。
     * 面板现在会在这一行显示「切过去」（见 client.js 的远端行交叉引用），这里再兜一层：
     * 旧版界面、模型工具、以及任何绕过界面的调用，撞名时都拿到同一条指路消息。
     *
     * 只拦**自动命名**这一种（askedName 为真时是调用方明确点名，照旧顺延后缀）：
     * 面板不给自定义名字之前，自动命名撞名 = 几乎必然是重复。
     */
    if (askedName !== true) {
      const autoTaken = await runGit(
        ['rev-parse', '--verify', '--quiet', 'refs/heads/' + wanted], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      )
      if (autoTaken.code === 0) {
        const owner = await branchTrackingRef(remoteRef, dir)
        if (owner !== null) {
          return opResponse({
            ok: false,
            reason: 'already-tracked',
            // 面板据此把话说完整（切过去，而不是再建一条）。
            alreadyTrackedBy: owner,
            message: '本地分支 ' + owner + ' 已经在跟踪 ' + remoteRef + '：直接切过去就行'
              + '（面板里点它一下，或在「管理」里点这一行的「切过去」），不需要再建一个 ——'
              + '那只会多出一条名字相近的分支，以后更难分清。',
          })
        }
      }
    }
    // 同名分支可能已经存在（用户点过两次）：顺延后缀，而不是直接报错。
    let target = wanted
    for (let index = 2; index <= 9; index += 1) {
      const taken = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
      if (taken.code !== 0) break
      target = wanted + '-' + index
    }
    const occupied = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (occupied.code === 0) {
      return opResponse({
        ok: false,
        message: '分支 ' + wanted + ' 及其后缀都已被占用：先在「管理」里删掉，或换个名字。',
      })
    }

    const argv = ['switch', '-c', target, remoteRef]
    const result = await runGit(argv, dir, { timeoutMs })
    const ok = result.code === 0
    return opResponse({
      ok: ok,
      command: 'git ' + argv.join(' '),
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
      notes: ok
        ? ['已新建分支 ' + target + '（内容 = ' + remoteRef + '），你现在就在这个分支上；原来的 '
          + branch + ' 一点没动，随时可以切回去']
        : [],
    })
  }

  // mode === 'reset'：会覆盖工作区，先做前置检查（未跟踪文件不受影响，所以只拦已跟踪的改动）。
  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const trackedChanges = status.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('??'))
  if (trackedChanges.length > 0) {
    return opResponse({
      ok: false,
      message: '工作区还有 ' + trackedChanges.length + ' 处未提交的改动：先「全部暂存」并提交（或丢弃），'
        + '再执行覆盖 —— 否则这些改动会被直接抹掉。',
    })
  }

  // 未跟踪文件不是「改动」，但远端那份里同名文件会把它们撞掉（git 会拒绝覆盖并报
  // untracked working tree files would be overwritten —— 那条报错原先会落到「未知错误」）。
  // 这里把「远端树里将要出现的名字」与本地未跟踪清单做交集，提前拦下来。
  const untracked = (await runGit(['ls-files', '--others', '--exclude-standard'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout
  const remoteTree = await runGit(['ls-tree', '-r', '--name-only', remoteRef], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (remoteTree.code === 0) {
    const remoteFiles = remoteTree.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const blockers = []
    for (const entry of untracked.split('\n')) {
      const name = entry.trim()
      if (name.length === 0) continue
      // 未跟踪的目录在 ls-files 里是一整行 `dir/`，远端树里是 `dir/file` —— 按前缀比。
      if (name.endsWith('/')) {
        if (remoteFiles.some((file) => file.startsWith(name))) blockers.push(name)
      } else if (remoteFiles.includes(name)) {
        blockers.push(name)
      }
    }
    if (blockers.length > 0) {
      return opResponse({
        ok: false,
        message: '工作区有 ' + blockers.length + ' 个未跟踪文件/目录会和远端那份撞名（'
          + blockers.slice(0, 5).join('、') + (blockers.length > 5 ? ' 等' : '')
          + '）：先移走或提交它们，再做这次覆盖 —— 否则它们会被远端覆盖掉。',
      })
    }
  }

  const before = await runGit(['rev-parse', 'HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const argv = ['reset', '--hard', remoteRef]
  const result = await runGit(argv, dir, { timeoutMs })
  const ok = result.code === 0
  const oldHead = before.code === 0 ? before.stdout.trim() : ''
  return opResponse({
    ok: ok,
    command: 'git ' + argv.join(' '),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    notes: ok && oldHead.length > 0
      ? ['当前分支 ' + branch + ' 现在等于 ' + remoteRef + '；被替换掉的提交是 ' + oldHead
        + '，需要找回时执行 git reset --hard ' + oldHead + '（或 git reflog）']
      : [],
  })
}


// ── 「安全拉取」：有未提交改动时也可以拉取 ─────────────────────────────────
//
// 背景：面板的「拉取」要求工作区干净（git 会拒绝覆盖未提交改动），于是
// 「本地有改动、又想拉更新」只能先提交 / 丢弃 / 手动 stash，三条路都要用户
// 自己弄明白。这一节把其中最安全的一条路做成一个按钮：
//   1. git stash push -u —— 把改动（**含未跟踪文件**）藏起来，工作区变干净；
//   2. git pull —— 与「拉取」按钮同一条路：网络加速、失败自动补救全都有；
//   3. git stash pop —— 拉取成功后把改动原样弹回来。
// 安全保证（改动绝不能丢）：
//   · 第一步失败（藏不起来）→ 拉取根本不开始，改动原样在工作区；
//   · 第二步失败 → 先撤销这次合并撞出的冲突现场（只有冲突才会留下合并现场），
//     再把改动弹回工作区，仓库回到拉取前；弹不回（极少数）→ 改动仍安全存在
//     stash 里，提示给出恢复命令；
//   · 第三步弹回时冲突 → 拉取已经完成，两边的改动都在冲突文件里，stash 那份
//     备份也还留着，提示给出怎么收尾。

/** 「安全拉取」藏起来时写的 stash 说明（git stash list 里能认出是面板藏的）。 */
const STASH_PULL_LABEL = 'dsh-git-sidebar：拉取前暂存（自动）'

/** 「安全切分支」藏起来时写的 stash 说明（与安全拉取分开，收尾时能分清是谁藏的）。 */
const STASH_SWITCH_LABEL = 'dsh-git-sidebar：切分支前暂存（自动）'

/** 拉取失败的原始报错里取第一行（没有就退回退出码）。 */
function pullFailureLine(result) {
  return firstLine(String(result.stderr ?? '').trim()) || 'git 退出码 ' + result.code
}

/**
 * 组装一段「git 命令链」的展示文本（stashPush → pull → pop 这类多步操作）。
 * argv 经 displayArgv 打码：代理之类的东西不会进面板结果栏。
 */
function chainCommand(...argvLists) {
  return argvLists.map((argv) => 'git ' + displayArgv(argv).join(' ')).join(' → ')
}

/** 把多步 git 命令的结果合并成一份（每一步的 stdout / stderr 串联，不丢信息）。 */
function mergeResults(...results) {
  const list = results.filter((item) => item !== null && item !== undefined)
  return {
    code: list.length > 0 ? list[list.length - 1].code : -1,
    stdout: list.map((item) => String(item.stdout ?? '')).filter((text) => text.length > 0).join('\n'),
    stderr: list.map((item) => String(item.stderr ?? '')).filter((text) => text.length > 0).join('\n'),
  }
}

/**
 * 组装「拉取类」操作的响应体（与 runPanelOp 对 pull 的组装规则一致）：
 * 网络失败给 networkHint、其余走 pullHint；无关历史 / 冲突给可点的按钮。
 * @param attempt - { argv, args, result, accel, notes }：executeWithAcceleration / 测试执行器的返回。
 * @param recovery - recoverPull 的返回（{ argv, result, reason, retried, note?, … }）。
 * @param notes - 本次多步操作的说明（按时间顺序，already 含 attempt.notes 之外的面板文案）。
 * @param patch - 覆盖字段（多步流程的特殊分支改 message / hint / choices 用）。
 */
function pullOpPayload(attempt, recovery, notes, patch = {}) {
  const failure = recovery.result.code === 0 ? null : recovery.result
  const networkFailure = failure === null ? null : classifyNetworkFailure(failure.stderr)
  return opResponse({
    ok: recovery.result.code === 0,
    command: chainCommand(recovery.argv),
    exitCode: recovery.result.code,
    stdout: recovery.result.stdout,
    stderr: recovery.result.stderr,
    message: recovery.result.code === 0
      ? null
      : (hasText(recovery.message) ? recovery.message : pullFailureLine(recovery.result)),
    reason: recovery.reason,
    hint: failure === null
      ? null
      : (networkFailure !== null
          ? networkHint(attempt.accel.mode !== 'direct')
          : (hasText(recovery.hint) ? recovery.hint : pullHint(recovery.reason))),
    retried: recovery.retried === true,
    accelerated: attempt.accel.mode,
    network: networkFailure !== null,
    notes: [...notes, ...(hasText(recovery.note) ? [recovery.note] : [])],
    choices: pullChoices(recovery),
    ...patch,
  })
}

/**
 * 「安全拉取」弹回改动失败时告诉用户怎么收尾的提示（改动还在 stash 里，没丢）。
 */
function popFailedHint() {
  return '改动没有丢：还安全地存在 stash 里（git stash list 可以确认）。'
    + '先执行 git stash pop 把改动拿回来 —— 如果弹出冲突，解决后用 git add + git commit 收尾，'
    + '再执行 git stash drop 清掉备份；不想要这些改动了，直接 git stash drop 即可。'
}

/**
 * 执行「安全拉取」（面板按钮；见本文件「安全拉取」一节的流程与安全保证）。
 *
 * @param body - 请求体：`remote`（面板「拉取自」选的那个远程；不传 = 跟随上游）、
 *   `branch`（可选，一般不给 —— 宿主按当前分支补）、`rebase`（面板的「变基」勾选）。
 *   这三个字段**必须一路传到 pull**：用户在「拉取自」里选了 origin，却又点了「安全拉取」，
 *   而它偷偷裸拉（上游 fork）—— 那就成了「同一个面板里两个拉取按钮拉的不是同一个地方」，
 *   正是本插件一直在消灭的那类不一致。`dir` 之外的字段与 adoptRemote 同形。
 * @param dir - **已经归一化**的执行目录（路由传 getDefaultDir() 的结果）。
 * @param pullRunner - 执行 `git pull` 的通道：路由把 executeWithAcceleration 传进来，
 *   于是拉取这一步和「拉取」按钮完全同路（镜像 / 代理 / 失败补救）。
 *   测试可以直接传一个直连执行器。形状：async (argv, timeoutMs) => attempt。
 * @param timeoutMs - 拉取这步的预算（联网操作，给足 10 分钟）。
 * @returns 与 /git-sidebar/op 其余分支同形的响应（不含 state，由调用方补）。
 */
async function stashPull(body, dir, pullRunner = null, timeoutMs = NETWORK_OP_TIMEOUT_MS) {
  // 0. 先把「这次拉哪儿」定下来。**排在藏改动之前**：分支名解析不出来（游离 HEAD）时
  //    直接拒绝，绝不能先把用户的改动藏进 stash 再发现拉不了。
  const request = body === null || body === undefined ? {} : body
  const remote = trimmedOrNull(request.remote)
  let branch = trimmedOrNull(request.branch)
  if (remote !== null && branch === null) {
    branch = trimmedOrNull(await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS))
    if (branch === null) {
      return opResponse({
        ok: false,
        message: '要拉取哪个分支还不确定：当前处于游离 HEAD（没有分支名）。'
          + '先切到一个分支上再拉取（不改动你的任何文件）。',
      })
    }
  }
  let pullArgv
  try {
    pullArgv = argvPull({ rebase: request.rebase === true, remote: remote, branch: branch })
  } catch (error) {
    return opResponse({ ok: false, message: message(error) })
  }

  // 1. 工作区干不干净？干净就直接拉取（与「拉取」按钮完全一致），不需要 stash。
  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (status.code !== 0) {
    return opResponse({
      ok: false,
      message: gitMissingMessage(status) ?? (firstLine(status.stderr) || 'git 退出码 ' + status.code),
    })
  }
  const dirty = status.stdout.trim().length > 0
  const stashNotes = []

  // 1. 有改动 → 连未跟踪文件一起藏起来（藏不起来就到此为止，改动不动用户的东西）。
  let stashArgv = null
  if (dirty) {
    stashArgv = ['stash', 'push', '-u', '-m', STASH_PULL_LABEL]
    const stash = await runGit(stashArgv, dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (stash.code !== 0) {
      return opResponse({
        ok: false,
        message: '你的改动原样没动：藏起改动这一步就失败了（' + pullFailureLine(stash) + '），拉取没有开始。',
        command: chainCommand(stashArgv),
        exitCode: stash.code,
        stderr: stash.stderr,
      })
    }
    stashNotes.push('已把你的改动（含未跟踪文件）藏进 stash（git stash push -u）：拉取成功会原样恢复，失败也会自动还给你')
  }

  if (pullRunner === null) {
    return opResponse({
      ok: false,
      message: '插件内部错误：拉取通道没有就绪',
      notes: stashNotes,
    })
  }

  // 2. 拉取：与「拉取」按钮同一条路（加速 + 失败自动补救，见 recoverPull）。
  const attempt = await pullRunner(pullArgv, timeoutMs)
  const recovery = await recoverPull({
    op: 'pull',
    // body 现在**不被 recoverPull 读取**（「这次拉的是哪儿」一律从真正的 argv 里读，
    // 因为分支名可能是宿主补的），照传只是保持两条调用路径（面板 / 模型工具）的 ctx 形状一致。
    body: request,
    argv: attempt.argv,
    result: attempt.result,
    dir,
    timeoutMs,
    extraArgs: attempt.args,
  })

  // 3. 没藏东西：结果与「拉取」按钮完全一致。
  if (!dirty) {
    return pullOpPayload(attempt, recovery, attempt.notes)
  }

  // 4. 拉取成功 → 把改动弹回工作区。
  if (recovery.result.code === 0) {
    const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (pop.code === 0) {
      return pullOpPayload(attempt, recovery, [
        ...stashNotes,
        ...attempt.notes,
        '拉取成功，你的改动已原样还原（git stash pop）',
      ], {
        command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
        stdout: mergeResults(recovery.result, pop).stdout,
        stderr: mergeResults(recovery.result, pop).stderr,
      })
    }
    // 弹回时冲突：拉取已完成，两边的改动都在冲突文件里，stash 备份也还留着。
    const popConflicts = await conflictedFiles(dir)
    return pullOpPayload(attempt, recovery, [
      ...stashNotes,
      ...attempt.notes,
      '拉取这一步成功了；还原你的改动时和拉下来的内容撞了车（有冲突）——',
      '两边的改动都没有丢：冲突文件就在工作区里（你的改动 + 拉取内容，用 <<<<<<< 标着）。',
      ...(popConflicts.length > 0 ? ['要处理的冲突文件：' + popConflicts.join('、')] : []),
      '你原来的改动还额外留着一份备份：git stash list 能看到，git stash show -p 可以查看内容',
    ], {
      ok: false,
      reason: 'stash-pop-conflict',
      message: '拉取成功了，但把你的改动还原回工作区时发生了冲突，需要你处理一下。',
      hint: '先把冲突文件改好（每处冲突选一边，或合并两边）：git add 冲突文件 → git commit 收尾，'
        + '再执行 git stash drop 清掉那份备份；不想要你的改动了，就执行 git checkout -- . '
        + '清掉冲突现场，再执行 git stash drop。',
      command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
      exitCode: pop.code,
      stdout: mergeResults(recovery.result, pop).stdout,
      stderr: mergeResults(recovery.result, pop).stderr,
      choices: null,
    })
  }

  // 5. 拉取失败 → 把改动还给用户：这次拉取撞出的冲突现场先撤销（只有冲突会留下
  //    合并现场；merge-unfinished 是**上一次**没收尾的合并，不是这次造成的，
  //    不能替用户撤——那是面板上「撤销这次合并」按钮的决策），再 stash pop。
  if (recovery.reason === 'conflict') {
    const aborted = await runGit(['merge', '--abort'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (aborted.code === 0) stashNotes.push('已自动撤销这次合并（git merge --abort），仓库回到拉取前的样子')
  }
  const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (pop.code !== 0) {
    // 极少数：弹不回来。改动仍在 stash 里，是安全的 —— 提示给出恢复命令。
    return pullOpPayload(attempt, recovery, [
      ...stashNotes,
      ...attempt.notes,
      '拉取失败；自动把改动弹回工作区这一步也没成功 —— 改动没有丢，还在 stash 里',
    ], {
      message: '拉取失败（' + pullFailureLine(recovery.result) + '），自动还原你的改动也没成功。',
      hint: popFailedHint(),
      command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
      exitCode: recovery.result.code,
      stdout: mergeResults(recovery.result, pop).stdout,
      stderr: mergeResults(recovery.result, pop).stderr,
    })
  }
  const rollbackPatch = {
    // 多步操作的结果串起来展示（每一步的真实输出都保留）。
    command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
    exitCode: recovery.result.code,
    stdout: mergeResults(recovery.result, pop).stdout,
    stderr: mergeResults(recovery.result, pop).stderr,
  }
  if (recovery.reason === 'conflict') {
    // 这次拉取撞出的冲突已经被我们撤销（merge --abort），不能再给「改好冲突文件 /
    // 撤销这次合并」这类提示和按钮 —— 那两句话指向的现场已经不存在了。
    rollbackPatch.hint = '冲突说明两个版本改了同一个地方。想保留本地改动，先把它提交了再点「拉取」'
      + '（两边的提交会合到一起）；不想要本地改动，就点「丢弃改动」后再点「拉取」。'
    rollbackPatch.choices = null
  }
  return pullOpPayload(attempt, recovery, [
    ...stashNotes,
    ...attempt.notes,
    '拉取没有成功，但你的改动已经原样还给了工作区（仓库回到拉取前的样子）',
  ], rollbackPatch)
}

// ── 「安全切分支」：有未提交改动时也可以切分支 ──────────────────────────────
//
// 与「安全拉取」完全对称的一条路（stash push -u → switch → stash pop）：
// git 的裸 switch 在脏工作区上会直接拒绝（Your local changes would be overwritten），
// 面板原先只能把英文原文甩给用户，让人自己去 commit / stash / 丢弃。这里把最安全的
// 那条做成默认路径，安全保证与 stashPull 一致：
//   · 藏不起来 → 切换根本不开始，改动原样不动；
//   · 切换失败 → 立刻把改动还回工作区（仓库回到切换前）；
//   · 弹回冲突 → 切换已完成，两边改动都在冲突文件里，原改动仍留着一份 stash 备份。
//
// 目标有两种，同一个流程都覆盖：
//   · body.branch —— 分支名（面板的「点分支名切换」）；
//   · body.commit —— 提交号（最近提交行的「切到此」）：git switch --detach，即
//     「看看那个版本的代码」的游离 HEAD 切换。切过去之后查看/编译/运行都可以，
//     但不再有分支指着 —— 成功提示必须把「怎么回去、想改代码先建分支」说明白。
//
// @returns 与 /git-sidebar/op 其余分支同形的响应（不含 state，由调用方补）。

/** 提交号形状：只认 4~40 位十六进制（git log / 面板「最近提交」里的短哈希就是这种）。 */
function isCommitHash(value) {
  return /^[0-9a-fA-F]{4,40}$/.test(String(value ?? '').trim())
}

async function stashSwitch(body, dir, timeoutMs = OP_TIMEOUT_MS) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const branch = trimmedOrNull(input.branch)
  const commit = trimmedOrNull(input.commit)
  // 两种目标、两道校验：分支名走 isSafeRemoteRef；提交号只认十六进制短哈希 ——
  // 它会原样交给 git 当参数，别的东西（选项、路径、ref 区间）一律不当提交号。
  let switchArgv = null
  let target = null
  if (commit !== null) {
    if (!isCommitHash(commit)) {
      return opResponse({ ok: false, message: '提交号不合法：' + commit + '（只支持 git log 里的提交号）' })
    }
    switchArgv = ['switch', '--detach', commit]
    target = '提交 ' + commit
  } else {
    if (branch === null) return opResponse({ ok: false, message: '请选择要切换的分支或提交' })
    if (!isSafeRemoteRef(branch)) return opResponse({ ok: false, message: '分支名不合法：' + branch })
    switchArgv = ['switch', branch]
    target = branch
  }

  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (status.code !== 0) {
    return opResponse({
      ok: false,
      message: gitMissingMessage(status) ?? (firstLine(status.stderr) || 'git 退出码 ' + status.code),
    })
  }
  const dirty = status.stdout.trim().length > 0
  const notes = []
  let stashArgv = null

  // 1. 有改动 → 连未跟踪文件一起藏起来（藏不起来就到此为止，不动用户的东西）。
  if (dirty) {
    stashArgv = ['stash', 'push', '-u', '-m', STASH_SWITCH_LABEL]
    const stash = await runGit(stashArgv, dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (stash.code !== 0) {
      return opResponse({
        ok: false,
        reason: 'stash-failed',
        message: '你的改动原样没动：藏起改动这一步就失败了（' + pullFailureLine(stash) + '），切换没有开始。',
        command: chainCommand(stashArgv),
        exitCode: stash.code,
        stderr: stash.stderr,
      })
    }
    notes.push('已把你的改动（含未跟踪文件）藏进 stash：切换成功会原样恢复，切换失败也会自动还给你')
  }

  const switchCommand = 'git ' + switchArgv.join(' ')
  const switched = await runGit(switchArgv, dir, { timeoutMs })

  // 2. 切换失败 → 把改动还回去（藏过才需要还）。
  if (switched.code !== 0) {
    const reason = classifyCheckoutFailure(switched.stderr)
    let pop = null
    if (dirty) {
      pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
      notes.push(pop.code === 0
        ? '切换没有成功，你的改动已经原样还给了工作区（仓库回到切换前的样子）'
        : '切换没有成功；改动仍安全存在 stash 里（git stash list 可查）')
    }
    const merged = pop === null ? switched : mergeResults(switched, pop)
    return opResponse({
      ok: false,
      reason: reason === 'none' ? 'switch-failed' : reason,
      message: firstLine(switched.stderr) || 'git 退出码 ' + switched.code,
      hint: reason === 'none'
        ? (pop !== null && pop.code !== 0 ? popFailedHint() : null)
        : checkoutHint(reason),
      command: dirty ? chainCommand(stashArgv, switchArgv, ['stash', 'pop']) : switchCommand,
      exitCode: switched.code,
      stdout: merged.stdout,
      stderr: merged.stderr,
      notes: notes,
    })
  }

  // 游离 HEAD 的成功提示必须把退路讲清楚：此时没有分支指着这个提交，用户
  // 「回不去了怎么办」的担心要在结果栏里就被回答掉。
  const detachedNotes = commit !== null
    ? ['现在是「游离 HEAD」：查看、编译、运行都可以；要在这个版本上继续改代码，'
      + '先新建分支（git switch -c 新分支名）。回到最新：在「管理」里点一下原来的分支名即可']
    : []

  // 3. 工作区本来就干净：行为与普通「切换分支」完全一致。
  if (!dirty) {
    return opResponse({
      ok: true,
      command: switchCommand,
      exitCode: 0,
      stdout: switched.stdout,
      stderr: switched.stderr,
      notes: ['已切换到 ' + target, ...detachedNotes],
    })
  }

  const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (pop.code === 0) {
    return opResponse({
      ok: true,
      command: chainCommand(stashArgv, switchArgv, ['stash', 'pop']),
      exitCode: 0,
      stdout: mergeResults(switched, pop).stdout,
      stderr: mergeResults(switched, pop).stderr,
      notes: [...notes, '已切换到 ' + target + '，你的改动已原样恢复（git stash pop）', ...detachedNotes],
    })
  }

  // 4. 弹回冲突：切换已完成，两边改动都在冲突文件里，stash 备份仍留着。
  const conflicts = await conflictedFiles(dir)
  return opResponse({
    ok: false,
    reason: 'stash-pop-conflict',
    message: '已切换到 ' + target + '，但把你的改动还原回工作区时发生了冲突，需要你处理一下。',
    hint: '冲突文件里是你的改动 + 新分支上的内容（用 <<<<<<< 标着）。改好后 git add 冲突文件 → git commit 收尾，'
      + '再执行 git stash drop 清掉备份（stash 备份在面板的「stash 备份」里也能看到）；不想要这些改动了，直接 git stash drop 即可。',
    command: chainCommand(stashArgv, switchArgv, ['stash', 'pop']),
    exitCode: pop.code,
    stdout: mergeResults(switched, pop).stdout,
    stderr: mergeResults(switched, pop).stderr,
    notes: [
      ...notes,
      '切换已成功，但还原改动时撞了车（有冲突）——',
      '两边的改动都没有丢：冲突文件在工作区里，你原来的改动还留着一份 stash 备份',
      ...(conflicts.length > 0 ? ['要处理的冲突文件：' + conflicts.join('、')] : []),
    ],
  })
}

export {
  opResponse, unrelatedChoices, mergeAbortChoice, abortMerge, adoptRemote, stashPull, stashSwitch,
  // 「本地名 ≠ 上游名」「未合并删不掉」「这个远程推不进去」三条现场的路（面板渲染成按钮）
  mismatchPushChoices, forceDeleteChoice, otherRemoteChoices, pullChoices, pullFromDefaultChoice,
  branchNameRemoteConflict, upstreamBranchName,
  assertSafeNewBranch,
  recoverPush, recoverPull, pickRemoteDefaultBranch, pullTargetFromArgv, pullFromNote,
  remoteDefaultBranches, enhanceRemoteBranches, REMOTE_HEAD_TIMEOUT_MS,
  executeWithAcceleration, conflictedFiles,
  // 共享 argv 构造器（tools.js 的 toArgv 全部指向它们）
  argvStatus, argvAdd, argvCommit, argvLog, argvDiff, argvBranch, argvCheckout,
  argvPull, argvPush, pushTargetNote, argvClone, argvInit, argvRemote, argvRun, pullArgvForDir,
  // 注册表与面板入口
  OPS, buildOpArgv, opTimeoutMs, toolArgv, formatGitResult, requiredText,
  LOCAL_OP_TIMEOUT_MS, OP_TIMEOUT_MS, NETWORK_OP_TIMEOUT_MS, DIFF_MAX_CHARS,
}
