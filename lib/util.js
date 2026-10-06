// dsh-git-sidebar —— 无依赖小工具（宿主 / Node 侧）
// ============================================================================
// 这一层刻意**不 import 任何本项目模块**：日志、git、网络、路由都依赖它，
// 放在最底层就不会出现循环依赖。全是纯函数。
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 把任意异常压成一行可读文本。 */
function message(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** 展开开头的 `~` 为用户主目录（与 shell 直觉一致；对绝对路径无影响）。 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** 归一化一个可选的目录参数：空白串按“未提供”处理；`~` 展开为主目录。 */
function normalizeDir(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? expandHome(trimmed) : undefined
}

/** 取多行文本的第一行非空内容（错误提示展示第一行就够了）。 */
function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** 超长文本截断：diff 容易达到几十 KB，面板小窗口放不下，截断并留一行提示。 */
function truncateText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n…（内容过长，已截断）'
}

/** HTML 转义：内容目前由本插件提供，但生成器一律按数据转义，改内容时不会漏。 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 打码后的凭据形态；用户不可能真拿它当密码，见到它就表示「保持原值」。 */
const MASK_TOKEN = '***@'

/**
 * 把凭据部分打码。GET /git-sidebar/net 在局域网内是可达的（见 README 的安全说明），
 * 所以代理地址里的用户名/密码绝不能原样回显。
 */
function maskProxy(value) {
  return String(value ?? '').replace(/\/\/[^/@\s]+@/g, '//' + MASK_TOKEN)
}

/** 面板回显用的参数：`-c http.proxy=http://user:pass@…` 同样要打码。 */
function displayArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  return list.map((item) => maskProxy(item))
}

/** 非空字符串判定：宿主里「有内容的可选字符串」出现得太多，收成一个谓词。 */
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** 归一化可选字符串：非字符串 / 空白一律当「未提供」。 */
function trimmedOrNull(value) {
  return hasText(value) ? String(value).trim() : null
}

export {
  message, expandHome, normalizeDir, firstLine, truncateText, escapeHtml,
  MASK_TOKEN, maskProxy, displayArgv, hasText, trimmedOrNull,
}
