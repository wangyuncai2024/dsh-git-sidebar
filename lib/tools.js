// dsh-git-sidebar —— 模型工具（git_status / git_add / …）
// ============================================================================
// argv 形状全部来自 ops.js 的 argv* 构造器（面板与工具共用同一份定义），
// 这里只声明 name / description / parameters 和少量工具独有的语义。
// ============================================================================

import { appendLog } from './log.js'
import {
  OPS, argvAdd, argvBranch, argvCheckout, argvClone, argvCommit, argvDiff, argvInit, argvLog,
  argvPush, argvRemote, argvRun, argvStatus, assertSafeNewBranch, executeWithAcceleration,
  formatGitResult, pullArgvForDir, recoverPull, recoverPush, toolArgv,
} from './ops.js'
import { displayArgv, firstLine, message, normalizeDir } from './util.js'

// ── 模型工具 ──────────────────────────────────────────────────────────────

/** 所有 git 工具的公共参数。 */
const COMMON_PARAMS = {
  workdir: { type: 'string', description: '运行 git 命令的目录；默认是当前会话工作目录，相对路径基于它解析。' },
  timeoutMs: { type: 'number', description: '命令超时毫秒数，默认 120000。' },
}

/** 工具调用的默认超时（与 register 的预算一致；面板的联网操作用的是 10 分钟档）。 */
const TOOL_TIMEOUT_MS = 120000

/**
 * 需要失败补救的工具：`git_pull` / `git_push` 与面板的同名按钮走**同一套**补救逻辑。
 *
 * 为什么必须共享：面板侧 `recoverOp`（routes.js）早就给 pull/push 挂了自动补救
 * （无上游时自动补 `-u`、自动改按「远程 + 当前分支」拉取），而工具侧只是把 git 的
 * 原始报错原样回给模型 —— 两条路径的能力面就分叉了。模型在会话里「帮我拉一下」
 * 时撞上「没有上游」，得到的是一段英文失败，而不是面板上那条自动走通的路。
 */
const TOOL_RECOVER = {
  pull: recoverPull,
  push: recoverPush,
}

/**
 * 把「参数 → argv」指向 ops.js 里的**共享构造器**，并统一加上工具名前缀。
 *
 * 这是本文件最重要的一行设计：工具与面板从此不可能各写一套 argv。
 * 它们曾经就是两套，而且已经分叉 —— 面板切分支用 git switch（因为 checkout 在
 * 「名字既像分支又像路径」时会误判），工具却还在用 git checkout -b。
 */
function specArgv(name, build) {
  return (args, helpers) => toolArgv(name, () => build(
    args === null || args === undefined ? {} : args,
    helpers === null || helpers === undefined ? {} : helpers,
  ))
}

/**
 * 工具清单：名称、说明、参数 schema，以及“参数 → git argv”的纯函数。
 * argv 直接交给 execFile，因此提交信息、路径里的特殊字符都是安全的数据。
 */
const TOOL_SPECS = [
  {
    name: 'git_status',
    description: '查看 git 仓库当前状态：当前分支、暂存区/工作区的改动、未跟踪文件。porcelain=true 时输出机器可读格式。',
    parameters: {
      porcelain: { type: 'boolean', description: '为 true 时使用 --porcelain=v1 --branch 机器可读输出。' },
    },
    toArgv: specArgv('git_status', (args) => argvStatus(args)),
  },
  {
    name: 'git_add',
    description: '暂存文件到暂存区（git add）。paths 传入要暂存的文件路径列表，或设置 all=true 暂存所有改动。',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: '要暂存的文件或目录路径列表。' },
      all: { type: 'boolean', description: '为 true 时暂存所有改动（git add -A）。' },
    },
    toArgv: specArgv('git_add', (args) => argvAdd(args)),
  },
  {
    name: 'git_commit',
    description: '创建一次提交（git commit）。message 为提交信息；all=true 先暂存所有改动（-a）；amend=true 修改上一次提交（--amend）。',
    parameters: {
      message: { type: 'string', description: '提交信息（commit message）。' },
      all: { type: 'boolean', description: '为 true 时先用 -a 暂存所有已跟踪文件的改动。' },
      amend: { type: 'boolean', description: '为 true 时用 --amend 修改上一次提交。' },
    },
    toArgv: specArgv('git_commit', (args) => argvCommit(args)),
  },
  {
    name: 'git_log',
    description: '查看提交历史（git log --oneline）。count 控制条数（默认 10，最大 200）；graph=true 显示分支图；all=true 包含所有分支。',
    parameters: {
      count: { type: 'integer', description: '显示的提交条数，默认 10，最大 200。' },
      graph: { type: 'boolean', description: '为 true 时使用 --graph 显示分支图形。' },
      all: { type: 'boolean', description: '为 true 时显示所有分支（--all）。' },
    },
    toArgv: specArgv('git_log', (args) => argvLog(args)),
  },
  {
    name: 'git_diff',
    description: '查看工作区改动（git diff）。cached=true 查看已暂存改动；stat=true 只显示统计摘要；path 限定单个文件。',
    parameters: {
      cached: { type: 'boolean', description: '为 true 时查看已暂存的改动。' },
      stat: { type: 'boolean', description: '为 true 时只显示 --stat 统计摘要。' },
      path: { type: 'string', description: '限定查看某个文件或目录的改动。' },
    },
    toArgv: specArgv('git_diff', (args) => argvDiff(args)),
  },
  {
    name: 'git_branch',
    description: '分支管理。不传 name 时列出分支（all=true 含远程）；提供 name 创建分支；delete=true 删除分支（force=true 强制删除）。',
    parameters: {
      name: { type: 'string', description: '分支名。' },
      delete: { type: 'boolean', description: '为 true 时删除 name 指定的分支。' },
      force: { type: 'boolean', description: '配合 delete 使用 -D 强制删除。' },
      all: { type: 'boolean', description: '列出时包含远程分支（-a）。' },
    },
    toArgv: specArgv('git_branch', async (args, helpers) => {
      // 建分支时走与面板同一道命名检查（撞远端名的名字会让两个引用同名）。
      // 删除不算「新建」：删掉一个叫 origin/main 的分支反而是合理的清理。
      const input = args !== null && typeof args === 'object' ? args : {}
      if (typeof input.name === 'string' && input.name.trim().length > 0 && input.delete !== true) {
        await assertSafeNewBranch(input.name, helpers.dir)
      }
      return argvBranch(input)
    }),
  },
  {
    name: 'git_checkout',
    description: '切换分支（git switch，不会把「名字既像分支又像路径」误判成还原文件）。branch 为目标分支；create=true 时创建并切换（-c）。',
    parameters: {
      branch: { type: 'string', description: '要切换（或创建）的分支名。' },
      create: { type: 'boolean', description: '为 true 时用 -c 创建并切换。' },
    },
    toArgv: specArgv('git_checkout', async (args, helpers) => {
      // create=true 就是「建分支」的另一种写法，同一道检查必须覆盖它。
      const input = args !== null && typeof args === 'object' ? args : {}
      if (typeof input.branch === 'string' && input.branch.trim().length > 0 && input.create === true) {
        await assertSafeNewBranch(input.branch, helpers.dir)
      }
      return argvCheckout(input)
    }),
  },
  {
    name: 'git_pull',
    description: '拉取远程更新（git pull）。remote 指定从哪个远程拉（不传 = 跟随当前分支的上游；'
      + '多远程时用 git_remote list 看有哪些）；branch 指定拉它的哪条分支（不传 = 与当前分支同名的那条）；'
      + 'rebase=true 使用 --rebase。只传 remote 不会动上游配置 —— 适合「我的分支跟踪 fork、但要拿 origin 的更新」。',
    parameters: {
      remote: { type: 'string', description: '从哪个远程拉（如 origin / fork），也可以是仓库地址。不传时跟随当前分支的上游。' },
      branch: { type: 'string', description: '拉该远程的哪条分支，默认与当前分支同名。只给 branch 不给 remote 会被拒绝（git 会把分支名当成仓库地址）。' },
      rebase: { type: 'boolean', description: '为 true 时使用 --rebase。' },
    },
    // 与面板同一条路（见 ops.js 的 pullArgvForDir）：只给远程时补当前分支名。
    toArgv: specArgv('git_pull', (args, helpers) => pullArgvForDir(args, helpers.dir)),
  },
  {
    name: 'git_push',
    description: '推送提交到远程（git push）。remote 指定推到哪个远程（不传 = 跟随当前分支的上游；多远程时用 git_remote list 看有哪些）；'
      + 'branch 指定要推的分支名（不传 = 当前分支 HEAD；两者一起用时是 git push <remote> <branch>）；'
      + 'setUpstream=true 设置上游（-u）；force=true 强制推送。需要显式 refspec（如 HEAD:main）时用 git_run 传 push 的参数。',
    parameters: {
      remote: { type: 'string', description: '推到哪个远程（如 origin / fork），也可以是仓库地址。不传时跟随当前分支的上游；传了就显式推这个远程，不受 push.default 配置限制。' },
      branch: { type: 'string', description: '要推送的分支名（默认当前分支 HEAD）。这里只接受分支名，refspec（含冒号）请用 git_run。' },
      setUpstream: { type: 'boolean', description: '为 true 时加 -u 把该远程登记为当前分支的上游（需要同时给 remote）。' },
      force: { type: 'boolean', description: '为 true 时加 --force 强制推送。' },
    },
    toArgv: specArgv('git_push', (args) => argvPush(args)),
  },
  {
    name: 'git_clone',
    description: '克隆远程仓库（git clone）。url 为仓库地址；dir 指定目标目录；depth 为浅克隆深度。',
    parameters: {
      url: { type: 'string', description: '仓库地址（https/ssh/git 协议均可）。' },
      dir: { type: 'string', description: '克隆到的目标目录，缺省用仓库名。' },
      depth: { type: 'integer', description: '浅克隆深度（--depth N）。' },
    },
    toArgv: specArgv('git_clone', (args) => argvClone(args)),
  },
  {
    name: 'git_init',
    description: '在当前目录初始化新的 git 仓库（git init）。branch 指定初始分支名。',
    parameters: {
      branch: { type: 'string', description: '初始分支名（git init -b）。' },
    },
    toArgv: specArgv('git_init', (args) => argvInit(args)),
  },
  {
    name: 'git_remote',
    description: '管理远程仓库。默认列出所有远程（git remote -v）；action=add 需 name 与 url；'
      + 'action=set 配置推送目标（同名远程已存在则改地址，否则新增）；action=remove 删除远程。'
      + '多远程时推送用 git_push 的 remote 参数选其中一个（例如 origin 只读、fork 可写）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'set', 'remove'], description: '操作类型，默认 list。set 用于「配置推送目标」。' },
      name: { type: 'string', description: '远程名（add/set/remove 时使用，默认 origin）。' },
      url: { type: 'string', description: '远程地址（add/set 时必填）。' },
    },
    toArgv: specArgv('git_remote', (args, helpers) => argvRemote(args, helpers)),
  },
  {
    name: 'git_run',
    description: '执行任意其他 git 子命令（如 git stash、git tag）。subcommand 为子命令名，args 为原样参数列表。',
    parameters: {
      subcommand: { type: 'string', description: 'git 子命令名，例如 stash、tag、show、reset。' },
      args: { type: 'array', items: { type: 'string' }, description: '传给子命令的参数列表（每个参数原样传递）。' },
    },
    toArgv: specArgv('git_run', (args) => argvRun(args)),
  },
]

/** 为工具解析执行目录：显式 workdir → 会话工作目录 → 插件默认目录。 */
function resolveToolDir(args, exec, getDefaultDir) {
  const explicit = normalizeDir(args.workdir)
  if (explicit !== undefined) return explicit
  // 会话工作目录藏在 exec.agent.session.header.cwd 里（三级可选）。
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return getDefaultDir()
}

/**
 * 注册全部 git 模型工具。任何单个工具失败都只记日志，不影响面板与其它工具。
 * @param tools - ctx.tools 工具注册表。
 * @param getDefaultDir - 缺省执行目录。
 * @returns 注销函数数组。
 */
function registerTools(tools, getDefaultDir) {
  const disposers = []
  for (const spec of TOOL_SPECS) {
    try {
      const parameters = { type: 'object', properties: { ...spec.parameters, ...COMMON_PARAMS } }
      disposers.push(tools.register({
        name: spec.name,
        description: spec.description,
        parameters,
        output: {
          schema: { type: 'string' },
          render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
        },
        timeoutMs: 600000,
        execute: async (args, exec) => {
          const input = args !== null && typeof args === 'object' ? args : {}
          const dir = resolveToolDir(input, exec, getDefaultDir)
          const toolStartedAt = Date.now()
          // toArgv 的失败**必须抛**：harness 会把抛出的异常标成一次失败的调用，而返回
          // 一段普通文本会被模型读成「命令跑完了」——参数写错就变成静默的假成功。
          let argv
          try {
            argv = await spec.toArgv(input, { dir })
          } catch (error) {
            const detail = message(error)
            await appendLog('warn', 'tool', { tool: spec.name, dir, ok: false, ms: Date.now() - toolStartedAt, error: detail })
            throw new Error(detail)
          }
          const signal = exec !== undefined && exec !== null ? exec.signal : undefined
          // 与面板同一条执行通道：网络加速（镜像/代理）、镜像失败自动回退直连都在这里，
          // 不再各写一份 —— 早先工具侧只注入加速参数、没有回退，于是「开了镜像反而拉不动」
          // 在面板上会自愈、在 AI 工具里却不会。
          const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
            ? Math.floor(input.timeoutMs)
            : TOOL_TIMEOUT_MS
          const attempt = await executeWithAcceleration(argv[0], argv, dir, timeoutMs, { signal })

          // pull / push 失败时做与面板一致的补救（自动补上游、自动改按「远程 + 分支」拉）。
          let finalArgv = attempt.argv
          let finalResult = attempt.result
          const recover = TOOL_RECOVER[argv[0]]
          let recovery = null
          if (recover !== undefined && finalResult.code !== 0) {
            recovery = await recover({
              op: argv[0],
              body: input,
              argv: attempt.argv,
              result: attempt.result,
              dir,
              timeoutMs,
              extraArgs: attempt.args,
              signal,
            })
            finalArgv = recovery.argv
            finalResult = recovery.result
          }

          // 工具调用留痕：AI 在会话里执行了什么、结果如何，是 `git_* 工具失灵/误操作`
          // 类问题的主要排查入口（argv 打码后才落盘）。
          await appendLog(finalResult.code === 0 ? 'info' : 'warn', 'tool', {
            tool: spec.name,
            dir,
            argv: displayArgv(finalArgv),
            exit: finalResult.code,
            ms: Date.now() - toolStartedAt,
            retried: recovery !== null && recovery.retried === true,
            accelerated: attempt.accel.mode,
            error: finalResult.code === 0 ? undefined : firstLine(finalResult.stderr),
          })

          // 命令回显要打码：工具输出会进会话记录，代理凭据不能留在里面。
          // 加速说明与补救说明一并带上（⇢ 前缀），否则模型看不到「刚才为什么重试/走了镜像」。
          const lines = [formatGitResult(displayArgv(finalArgv), finalResult)]
          for (const note of attempt.notes) lines.push('⇢ ' + note)
          if (recovery !== null && typeof recovery.note === 'string' && recovery.note.length > 0) {
            lines.push('⇢ ' + recovery.note)
          }
          // 失败时补一句「下一步怎么办」：面板一直有这份中文提示（注册表的 hint），
          // AI 工具过去只回 git 的英文原文 —— 同一个故障，两半的体验不该不一样；
          // 而且模型也只有读到它，才可能照着做（例如「本地名和上游名不一致」那三条路）。
          if (finalResult.code !== 0) {
            const opSpec = OPS[argv[0]]
            const reason = recovery !== null && typeof recovery.reason === 'string'
              ? recovery.reason
              : (opSpec !== undefined && typeof opSpec.classify === 'function' ? opSpec.classify(finalResult) : null)
            const hint = opSpec !== undefined && typeof opSpec.hint === 'function' ? opSpec.hint(reason) : null
            if (typeof hint === 'string' && hint.length > 0) lines.push('⇢ ' + hint)
          }
          return lines.join('\n')
        },
      }))
    } catch (error) {
      const detail = message(error)
      console.error('[git-sidebar] 注册工具 ' + spec.name + ' 失败：' + detail)
      appendLog('error', 'tool-register', { tool: spec.name, error: detail })
    }
  }
  return disposers
}

export { TOOL_SPECS, COMMON_PARAMS, registerTools, resolveToolDir }
