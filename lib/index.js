// dsh-git-sidebar —— Host half（宿主 / Node 侧）· 插件入口
// ============================================================================
// 职责：
//   1. 注册同源 HTTP 路由 /git-sidebar/*，供浏览器面板读写 git（见 routes.js）。
//   2. 把一组 git 命令注册成模型工具（见 tools.js），让会话里的 AI 也能执行 git。
//
// 模块划分（原来全在 2711 行的单文件里，按职责拆开后每层都能单独读）：
//   util.js     无依赖小工具（打码、归一化、文本处理）—— 最底层，不 import 本项目模块
//   log.js      统一操作日志（JSONL、级别、轮转、串行写入）
//   failure.js  失败分类 + 「下一步点哪里」的中文提示（纯函数）
//   git.js      git 执行（execFile + 参数数组）与 porcelain / branch / remote 解析、状态读取
//   net.js      网络加速（镜像 / 代理）配置、参数注入、线路实测
//   help.js     帮助文档（独立 HTML 页面）
//   ops.js      操作注册表：每个操作的 argv 形状、超时、结果解析、补救、提示（唯一事实来源）
//   routes.js   HTTP 路由与 op 流水线
//   tools.js    模型工具（argv 全部复用 ops.js 的构造器）
//
// 设计要点（未变）：
//   * 零外部依赖：只用 Node 内置模块，因此 link 安装到任何 profile 都能解析。
//   * 用 child_process.execFile + 参数数组执行 git，**不经过 shell**：
//     路径/提交信息里的引号、空格、分号都不构成注入面。
//   * 非零退出不抛异常，归一化成 { code, stdout, stderr }，面板与模型都能读到原因。
// ============================================================================

import {
  checkoutHint, classifyCheckoutFailure, classifyCommitFailure, classifyDeleteBranchFailure,
  classifyNetworkFailure, classifyPullFailure, classifyPushFailure, classifyRenameFailure,
  classifySetUpstreamFailure,
  commitHint, deleteBranchHint, mirrorFallbackWorthwhile, networkHint, pullFailureText, pullHint,
  pushHint, renameHint, setUpstreamHint,
} from './failure.js'
import {
  BARE_REPO_NOTICE, GIT_LOCAL_TIMEOUT_MS, MAX_STATE_CHANGES, NOT_REPO_NOTICE, cloneTargetName,
  currentBranchName, duplicateRemotes, emptyState, gitMissingMessage, isSafePushTarget, isSafeRemoteRef,
  localBranchNameFor, notRepoNotice, parseBranchLine, parseBranchOutput, parseBranchUpstreams,
  parseCompareOutput,
  parseLsRemoteHead, parseRemoteBranchOutput, parseRemoteHeads, parseRemotes, parseStashList,
  readState, remoteOpFor,
  repoPageUrl, runGit,
} from './git.js'
import { renderHelpHtml } from './help.js'
import {
  appendLog, logFilePath, normalizeLogLevel, normalizeLogMaxBytes, readLogTail, setLogConfig,
  shouldLog,
} from './log.js'
import {
  AUX_NET_OPS, MIRROR_CANDIDATES, NETWORK_OPS, PROBE_URL, mirrorLabel, netConfigPath,
  netConfigView, networkExtraArgs, normalizeNetConfig, probeJobs, probeNetwork, readNetConfig,
  resetNetConfigCache, writeNetConfig,
} from './net.js'
import {
  OPS, abortMerge, adoptRemote, argvAdd, argvBranch, argvCheckout, argvClone, argvCommit,
  argvDiff, argvInit, argvLog, argvPull, argvPush, argvRemote, argvRun, argvStatus, branchNameRemoteConflict,
  buildOpArgv, conflictedFiles, enhanceRemoteBranches, executeWithAcceleration, forceDeleteChoice,
  formatGitResult, mergeAbortChoice, mismatchPushChoices, opResponse, opTimeoutMs,
  otherRemoteChoices, pickRemoteDefaultBranch, pullChoices, pullFromDefaultChoice, pullFromNote,
  pullTargetFromArgv, pushTargetNote, recoverPull, recoverPush,
  remoteDefaultBranches,
  requiredText, stashPull, stashSwitch, toolArgv, unrelatedChoices, upstreamBranchName,
} from './ops.js'
import { createRoutes, netPatch, resetCsrfTokens } from './routes.js'
import { TOOL_SPECS, registerTools, resolveToolDir } from './tools.js'
import {
  MASK_TOKEN, displayArgv, escapeHtml, firstLine, hasText, maskProxy, normalizeDir,
  trimmedOrNull, truncateText,
} from './util.js'

/** 插件名（cordis patch 通过包名挂载，这里同时导出以便调试识别）。 */
export const name = 'dsh-git-sidebar'

/**
 * 惰性服务的两种时机都要覆盖：现在就有 → 直接挂；稍后才就绪 → inject 等它。
 *
 * 为什么不能只读 ctx.get：`tools` 与 `webServer` 都是**惰性服务**，插件 apply 时
 * 它们可能还没就绪，只读一次会让路由或工具静默缺失（实测就是如此）。
 * 这段逻辑原先为两个服务各抄了一份，抽出来之后「第三种服务」也不会再抄第三份。
 */
function withService(ctx, service, mount) {
  const existing = typeof ctx.get === 'function' ? ctx.get(service) : undefined
  if (existing !== undefined && existing !== null) {
    mount(existing)
    return
  }
  if (typeof ctx.inject !== 'function') {
    const detail = '未找到 ' + service + ' 服务：相关能力未注册（其余部分不受影响）'
    console.error('[git-sidebar] ' + detail)
    appendLog('error', 'lifecycle', { msg: service + '-missing', detail })
    return
  }
  ctx.inject([service], (hostCtx) => {
    const resolved = hostCtx !== undefined && hostCtx !== null && hostCtx[service] !== undefined
      ? hostCtx[service]
      : (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
    if (resolved === undefined || resolved === null) return
    mount(resolved)
  })
}

/**
 * 插件入口：挂载面板 HTTP 路由并注册 git 模型工具。
 * @param ctx - cordis 上下文。
 * @param config - 行配置（defaultDir：面板缺省执行目录）。
 *
 * 网络加速（镜像 / 代理）**不在这里配置**，而是落在 $DSH_HOME/git-sidebar-net.json，
 * 由面板的 🌐 按钮读写 —— 那个设置要能在换机器后随时改，不该逼用户去编辑 yml 再重启。
 */
export function apply(ctx, config = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const configured = normalizeDir(cfg.defaultDir)
  const getDefaultDir = () => configured ?? process.cwd()
  // 插件级配置可覆盖日志行为（logLevel / logMaxBytes / logFile）；默认 info +
  // 本插件仓库根目录下的 git-sidebar.log（不跟 process.cwd() 走，见 lib/log.js）。
  setLogConfig({ level: cfg.logLevel, maxBytes: cfg.logMaxBytes, file: cfg.logFile })
  appendLog('info', 'lifecycle', { msg: 'apply', defaultDir: getDefaultDir(), logFile: logFilePath() })

  const disposers = []
  // 路由表只构造一次：日志里的条数直接取它的长度，不再手写「6」这种会过期的常数。
  const routes = createRoutes(getDefaultDir)

  const mountRoutes = (server) => {
    for (const route of routes) {
      try {
        disposers.push(server.register(route))
      } catch (error) {
        const detail = error !== null && error !== undefined && error.message ? error.message : String(error)
        console.error('[git-sidebar] 注册路由 ' + route.path + ' 失败：' + detail)
        appendLog('error', 'route-register', { path: route.path, error: detail })
      }
    }
  }

  const mountTools = (registry) => {
    for (const dispose of registerTools(registry, getDefaultDir)) disposers.push(dispose)
  }

  withService(ctx, 'webServer', mountRoutes)
  withService(ctx, 'tools', mountTools)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载期忽略 */
        }
      }
      appendLog('info', 'lifecycle', { msg: 'disposed' })
    })
  }

  console.log('[git-sidebar] 就绪：面板路由 ' + routes.length + ' 条 + ' + TOOL_SPECS.length + ' 个 git 工具')
  appendLog('info', 'lifecycle', { msg: 'ready', routes: routes.length, tools: TOOL_SPECS.length })
}

// ── 对外导出 ──────────────────────────────────────────────────────────────
//
// 运行时只需要 name / apply。其余全部是**给测试用的内部函数**：零依赖插件没有更好
// 的注入点，而这些解析/决策/分类都是纯函数，直接断言比隔着 HTTP 断言可靠得多。
// 拆模块之后它们各自住在自己的文件里，这里只是汇总转发（测试的 import 面不变）。

export {
  // 纯解析与决策（git.js）
  parseBranchLine, parseRemotes, duplicateRemotes, remoteOpFor, cloneTargetName, repoPageUrl,
  parseBranchOutput, parseBranchUpstreams,
  parseRemoteBranchOutput, parseLsRemoteHead, parseRemoteHeads, isSafeRemoteRef, isSafePushTarget,
  parseCompareOutput,
  parseStashList,
  pickRemoteDefaultBranch,
  localBranchNameFor, readState, currentBranchName, emptyState, runGit, gitMissingMessage,
  MAX_STATE_CHANGES, GIT_LOCAL_TIMEOUT_MS,
  // 「不是工作区」的四种诊断文案（客户端按 NOT_REPO_NOTICE 去重，两边必须一致）
  NOT_REPO_NOTICE, BARE_REPO_NOTICE, notRepoNotice,
  // 失败分类与提示（failure.js）
  classifyPushFailure, pushHint, classifyPullFailure, pullHint, pullFailureText,
  classifyNetworkFailure, mirrorFallbackWorthwhile, networkHint,
  classifyCommitFailure, commitHint, classifyCheckoutFailure, checkoutHint,
  classifyDeleteBranchFailure, deleteBranchHint, classifyRenameFailure, renameHint,
  // 「把本地分支的上游绑到某条远端分支」的失败分类与提示（本地名 ≠ 上游名 的解药）
  classifySetUpstreamFailure, setUpstreamHint,
  // 操作注册表（ops.js）
  opResponse, unrelatedChoices, mergeAbortChoice, buildOpArgv, OPS, opTimeoutMs, toolArgv,
  formatGitResult, requiredText, recoverPush, recoverPull, abortMerge, adoptRemote, stashPull,
  stashSwitch, remoteDefaultBranches, enhanceRemoteBranches,
  // 「本地名 ≠ 上游名」三条路 + 「未合并删不掉」一条路 + 「这个远程推不进去」一条路
  // + 分支名撞远端名的判定 + 「拉取自」的远程/分支识别与出路
  mismatchPushChoices, forceDeleteChoice, otherRemoteChoices, branchNameRemoteConflict,
  upstreamBranchName, pullChoices, pullFromDefaultChoice, pullTargetFromArgv, pullFromNote,
  executeWithAcceleration, conflictedFiles,
  argvStatus, argvAdd, argvCommit, argvLog, argvDiff, argvBranch, argvCheckout,
  argvPull, argvPush, pushTargetNote, argvClone, argvInit, argvRemote, argvRun,
  // 网络加速（net.js）
  normalizeNetConfig, networkExtraArgs, netConfigView, netConfigPath, readNetConfig,
  writeNetConfig, resetNetConfigCache, probeNetwork, probeJobs, mirrorLabel,
  MIRROR_CANDIDATES, PROBE_URL, NETWORK_OPS, AUX_NET_OPS,
  // 帮助文档与工具（help.js / util.js）
  renderHelpHtml, escapeHtml, normalizeDir, truncateText, firstLine, maskProxy, displayArgv,
  hasText, trimmedOrNull, MASK_TOKEN,
  // 模型工具（tools.js）
  TOOL_SPECS, registerTools, resolveToolDir,
  // 日志（log.js）
  appendLog, readLogTail, logFilePath, setLogConfig, shouldLog,
  normalizeLogLevel, normalizeLogMaxBytes,
  // 路由（routes.js）
  createRoutes, netPatch, resetCsrfTokens,
}
