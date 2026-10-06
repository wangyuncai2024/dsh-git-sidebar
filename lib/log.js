// dsh-git-sidebar —— 统一操作日志（JSONL）
// ============================================================================
// 级别 off < error < warn < info < debug；默认 info；超过上限轮转只留两份。
// 所有失败都在内部消化 —— 日志是观测工具，不能成为插件的新故障点。
// ============================================================================

import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { message } from './util.js'

// ── 日志 ──────────────────────────────────────────────────────────────────
//
// 统一的操作日志：面板/工具每次动作、每条 git 命令、每次注册/配置变更都写进
// **本插件仓库根目录**下的 `git-sidebar.log`（JSONL：一行一条，`{ at, level, event, … }`）。
// 目的是「出了问题能复盘」：命令是什么、在哪个目录、跑多久、退出码多少、失败原因
// 是什么、走了哪条网络线路 —— 全都有迹可循，方便维护与排查。
//
// 设计要点：
//   * 位置：固定写在**本插件仓库根目录**（`lib/log.js` 的上一级，由 `import.meta.url`
//     推导），不跟 `process.cwd()` 走 —— dsh 的启动目录可能是任何一个仓库（宿主自己的
//     checkout、别人的项目…），写进那里等于往别人的仓库里丢文件；面板切换/刷新查看的
//     仓库也绝不能成为落盘位置。文件名固定，已在 `.gitignore` 里排除，不会被提交。
//   * 级别：off < error < warn < info < debug。默认 info。
//       - info：一次操作 / 一条命令 / 一次配置变更的**结果**（含失败原因）；
//       - debug：细粒度现场（面板每次刷新状态都会跑几条 git，归入 debug，默认不落盘）；
//       - error / warn：分别对应不该发生的事（注册失败、内部异常）与操作失败。
//   * 敏感信息：argv 一律经 displayArgv 打码（代理凭据 → `***@`）后才落盘，
//     和面板回显、模型工具输出同一套规则。
//   * 永不抛异常：写失败只落到宿主 console.error，绝不影响面板与 git 功能。
//   * 轮转：超过 logMaxBytes（默认 2 MiB）就把旧文件改名为 `.1` 再重新写，
//     只保留最近两份 —— 日志不会无限膨胀。
// ──────────────────────────────────────────────────────────────────────────

const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }
const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024

/** 日志配置（可由插件 config 的 logLevel / logMaxBytes / logFile 覆盖；模块级，测试可直接改）。 */
let logConfig = { level: 'info', maxBytes: DEFAULT_LOG_MAX_BYTES, file: null }

/** 归一化日志级别：非法值与缺省一律落到 info（保持“默认可观测”）。 */
function normalizeLogLevel(value) {
  return typeof value === 'string' && Object.hasOwn(LOG_LEVELS, value) ? value : 'info'
}

/** 归一化轮转上限：非正数落到默认值。 */
function normalizeLogMaxBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_LOG_MAX_BYTES
}

/**
 * 本插件仓库根目录：`lib/log.js` 的上一级。
 *
 * 由模块自身位置推导，而不是看 `process.cwd()` —— 后者是「启动 dsh 时所在的目录」，
 * 可能是宿主的 checkout，也可能是任何一个被查看的仓库。日志路径必须与「谁启动的、
 * 在哪个会话里点的刷新、当前选中的是哪个仓库」全都无关。
 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 日志文件路径：显式指定优先，否则固定落在**本插件仓库根目录**下的 `git-sidebar.log`。
 * 想放到别处（例如集中收集）用行配置 `logFile` 覆盖。
 */
function logFilePath() {
  return (logConfig.file !== null && logConfig.file !== undefined && String(logConfig.file).trim().length > 0)
    ? String(logConfig.file)
    : join(PLUGIN_ROOT, 'git-sidebar.log')
}

/** 设置日志配置（apply 时按插件 config 调用；测试可直接调用）。 */
function setLogConfig(config = {}) {
  const input = config !== null && typeof config === 'object' ? config : {}
  logConfig = {
    level: normalizeLogLevel(input.level),
    maxBytes: normalizeLogMaxBytes(input.maxBytes),
    file: typeof input.file === 'string' && input.file.trim().length > 0 ? input.file.trim() : null,
  }
}

/** 该级别在当前配置下是否会被记录。 */
function shouldLog(level) {
  return LOG_LEVELS[normalizeLogLevel(level)] <= LOG_LEVELS[logConfig.level]
}

/** 轮转：文件超过上限时改名 `.1`（覆盖旧备份），只保留两份。 */
async function rotateLogIfNeeded(path) {
  try {
    const info = await stat(path)
    if (info.size < logConfig.maxBytes) return
    const backup = path + '.1'
    await rm(backup, { force: true })
    await rename(path, backup)
  } catch (error) {
    // 文件不存在（还没写过）或不可读：不轮转，正常走追加。
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      console.error('[git-sidebar] 日志轮转失败：' + message(error))
    }
  }
}

/**
 * 追加一条日志（JSONL）。所有失败都在内部消化 —— 日志不能成为插件的新故障点。
 *
 * **必须串行**：appendLog 大量是不 await 的（git 执行路径不该为写日志让路），
 * 而 readState 一次就并发跑 3 条 git，于是这里天然是多写者。轮转的
 * stat → rm → rename 一旦并发进入，轻则 rename ENOENT、重则「A 已改名、B 又写回
 * 原路径」，把一份日志切成两段 —— 那正好毁掉本模块存在的唯一理由（按时间复盘）。
 * 所以用一个 promise 队列把「检查轮转 + 追加」整体串起来。
 *
 * @param level - error | warn | info | debug
 * @param event - 事件名（op / tool / git / state / net / diag / lifecycle / error…）
 * @param fields - 事件字段（**敏感值必须由调用方先打码再传入**）。
 */
let logQueue = Promise.resolve()

function appendLog(level, event, fields) {
  if (!shouldLog(level)) return Promise.resolve()
  const record = { at: new Date().toISOString(), level, event, ...(fields !== null && typeof fields === 'object' ? fields : {}) }
  const write = logQueue.then(() => writeLogRecord(record))
  // 队列自身不能因为一次写失败而断掉：吞掉拒绝，只留一条可继续的链。
  logQueue = write.catch(() => {})
  return write
}

/** 真正落盘的那一步（只在 logQueue 里被串行调用）。 */
async function writeLogRecord(record) {
  const path = logFilePath()
  try {
    await rotateLogIfNeeded(path)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    try {
      console.error('[git-sidebar] 日志写入失败：' + message(error))
    } catch {
      /* 连 console 都没有时只能放弃 */
    }
  }
}

/**
 * 一次尾读最多回看的字节数：日志本身按 logMaxBytes 轮转（默认 2 MiB），
 * 这个上限只是防止「用户把轮转阈值调得极大」时把整份日志读进内存。
 */
const LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024

/**
 * 读日志尾部（调试 / GET /git-sidebar/log 用）：返回最近 maxLines 行的原文数组。
 *
 * 从文件**末尾**按字节回读，而不是 readFile 整个文件再切片：日志默认 2 MiB，
 * 整读一次虽然不致命，但这是个会被面板反复调用的接口（排查时可能连着刷新），
 * 尾部读取的代价只与要看的行数有关。
 */
async function readLogTail(maxLines = 200) {
  const count = typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines > 0
    ? Math.min(Math.floor(maxLines), 2000)
    : 200
  try {
    const path = logFilePath()
    const info = await stat(path)
    if (info.size === 0) return []
    const length = Math.min(info.size, LOG_TAIL_MAX_BYTES)
    const from = info.size - length
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, from)
      let text = buffer.toString('utf8')
      // 从文件中间开始读时，起点可能落在某个多字节字符中间 —— 此刻第一行会带替换符。
      // 那一行本来就在我们要数的范围之外，直接丢掉。
      if (from > 0) {
        const firstBreak = text.indexOf('\n')
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
      }
      const lines = text.split('\n')
      while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop()
      return lines.slice(-count)
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

export {
  appendLog, readLogTail, logFilePath, setLogConfig, shouldLog,
  normalizeLogLevel, normalizeLogMaxBytes,
}
