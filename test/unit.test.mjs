// dsh-git-sidebar —— 纯函数回归测试（node --test test/）
// ============================================================================
// 覆盖宿主侧的关键纯函数：porcelain 分支行解析、远程列表解析、推送失败分类、
// 中文提示、远程配置决策（面板与 AI 工具共用）、clone 目标名推导、目录归一化。
// 这些函数不触网、不落盘，跑一次毫秒级完成。
// ============================================================================

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseBranchLine,
  parseRemotes,
  classifyPushFailure,
  pushHint,
  remoteOpFor,
  cloneTargetName,
  repoPageUrl,
  normalizeDir,
  parseBranchOutput,
  parseBranchUpstreams,
  parseRemoteBranchOutput,
  parseLsRemoteHead,
  parseRemoteHeads,
  isSafeRemoteRef,
  isSafePushTarget,
  parseCompareOutput,
  parseStashList,
  pickRemoteDefaultBranch,
  buildOpArgv,
  unrelatedChoices,
  pullHint,
  classifyCommitFailure,
  commitHint,
  classifyCheckoutFailure,
  checkoutHint,
  classifyPullFailure,
  classifyDeleteBranchFailure,
  deleteBranchHint,
  classifyRenameFailure,
  renameHint,
  classifySetUpstreamFailure,
  setUpstreamHint,
  mismatchPushChoices,
  forceDeleteChoice,
  otherRemoteChoices,
  argvPush,
  argvPull,
  pullTargetFromArgv,
  pullFromNote,
  pullChoices,
  pullFromDefaultChoice,
  pushTargetNote,
  currentBranchName,
  branchNameRemoteConflict,
  upstreamBranchName,
  duplicateRemotes,
  opTimeoutMs,
  OPS,
  GIT_LOCAL_TIMEOUT_MS,
  truncateText,
  renderHelpHtml,
  escapeHtml,
  // 日志模块
  appendLog,
  readLogTail,
  logFilePath,
  setLogConfig,
  shouldLog,
  normalizeLogLevel,
  normalizeLogMaxBytes,
} from '../lib/index.js'

// ── parseBranchLine：porcelain `## ` 分支行 ────────────────────────────────

test('parseBranchLine：常规分支 + 上游 + ahead/behind', () => {
  const parsed = parseBranchLine('## main...origin/main [ahead 1, behind 2]')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 1)
  assert.equal(parsed.behind, 2)
})

test('parseBranchLine：有上游但无领先落后', () => {
  const parsed = parseBranchLine('## main...origin/main')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 0)
  assert.equal(parsed.behind, 0)
})

test('parseBranchLine：只有 ahead', () => {
  const parsed = parseBranchLine('## dev...origin/dev [ahead 3]')
  assert.equal(parsed.branch, 'dev')
  assert.equal(parsed.ahead, 3)
  assert.equal(parsed.behind, 0)
})

test('parseBranchLine：尚无提交（No commits yet on …）', () => {
  const parsed = parseBranchLine('## No commits yet on main')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, null)
})

test('parseBranchLine：游离 HEAD', () => {
  const parsed = parseBranchLine('## HEAD (no branch)')
  assert.equal(parsed.branch, 'HEAD')
  assert.equal(parsed.upstream, null)
})

test('parseBranchLine：没有上游的本地分支', () => {
  const parsed = parseBranchLine('## feature/x')
  assert.equal(parsed.branch, 'feature/x')
  assert.equal(parsed.upstream, null)
  assert.equal(parsed.ahead, 0)
})

// ── parseRemotes：git remote -v ───────────────────────────────────────────

test('parseRemotes：只取 fetch 行、去重、按名称排序', () => {
  const stdout = [
    'upstream\tssh://git@github.com/c/d.git (fetch)',
    'origin\thttps://github.com/a/b.git (fetch)',
    'origin\thttps://github.com/a/b.git (push)',
    'weird\tline\twithout\tparens',
    '',
  ].join('\n')
  const remotes = parseRemotes(stdout)
  assert.deepEqual(remotes, [
    { name: 'origin', url: 'https://github.com/a/b.git' },
    { name: 'upstream', url: 'ssh://git@github.com/c/d.git' },
  ])
})

// ── classifyPushFailure：推送失败原因探测 ─────────────────────────────────

const FAILURE_CASES = [
  ['fatal: The current branch master has no upstream branch.', 'no-upstream'],
  ["fatal: The current branch 'dev' has no upstream branch.", 'no-upstream'],
  ["ERROR: Repository not found.\nfatal: Could not read from remote repository.", 'remote-not-found'],
  ['Permission denied (publickey).', 'auth-failed'],
  ['! [rejected] main -> main (fetch first)', 'rejected'],
  ["fatal: 'origin' does not appear to be a git repository", 'remote-not-found'],
  ['fatal: No configured push destination.', 'no-remote'],
  ['fatal: 没有配置推送目标', 'no-remote'],
]

for (const [stderr, expected] of FAILURE_CASES) {
  test('classifyPushFailure：' + (stderr.split('\n')[0] || stderr).slice(0, 40) + '…', () => {
    assert.equal(classifyPushFailure(stderr), expected)
  })
}

test('classifyPushFailure：未知错误 → none', () => {
  assert.equal(classifyPushFailure('fatal: something unexpected'), 'none')
})

test('classifyPushFailure：空输出 → none', () => {
  assert.equal(classifyPushFailure(''), 'none')
})

// ── pushHint：失败原因 → 中文下一步提示 ───────────────────────────────────

test('pushHint：每个已知原因都有提示，none 返回 null', () => {
  for (const reason of ['no-remote', 'no-upstream', 'remote-not-found', 'auth-failed', 'auth-http', 'rejected']) {
    assert.equal(typeof pushHint(reason), 'string', reason + ' 应有提示')
    assert.ok(pushHint(reason).length > 0, reason + ' 提示非空')
  }
  assert.equal(pushHint('none'), null)
})

// ── 新增失败分类：HTTPS 认证失败（push / pull 两侧） ──────────────────────
//
// 回归：原先只认 SSH 的 `Permission denied (publickey)`，HTTPS 走 GitHub 时
// `Authentication failed` / `could not read Username` 全部落到 none ——
// 面板只能把 git 英文原文甩给用户，而这是新手在 HTTPS 推送时最常见的一条。

const AUTH_HTTP_CASES = [
  ["fatal: Authentication failed for 'https://github.com/o/r.git/'", 'auth-http'],
  ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth-http'],
]

for (const [stderr, expected] of AUTH_HTTP_CASES) {
  test('classifyPushFailure（HTTPS 认证）：' + stderr.slice(0, 32) + '… → ' + expected, () => {
    assert.equal(classifyPushFailure(stderr), expected)
  })
  test('classifyPullFailure（HTTPS 认证）：' + stderr.slice(0, 32) + '… → ' + expected, () => {
    assert.equal(classifyPullFailure(stderr), expected)
  })
}

test('auth-http 的提示必须指向令牌与 credential.helper，而不是 SSH 公钥', () => {
  const push = pushHint('auth-http')
  assert.match(push, /Token/i, '要说明 GitHub 不再支持密码、需要令牌')
  assert.match(push, /credential\.helper/)
  assert.doesNotMatch(push, /公钥/)
  const pull = pullHint('auth-http')
  assert.match(pull, /Token/i)
  assert.match(pull, /credential\.helper/)
})

test('classifyPushFailure：SSH 认证仍走 auth-failed（两条不能互相顶掉）', () => {
  assert.equal(classifyPushFailure('Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyPushFailure('git@github.com: Permission denied (publickey).'), 'auth-failed')
})

// ── 提交失败单独分类：身份没配置 / 没有可提交的内容 ──────────────────────

test('classifyCommitFailure：git 不知道你是谁时给出 identity-missing', () => {
  for (const text of [
    '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
    'fatal: unable to auto-detect email address (got \'x@y.(none)\')',
    'Author identity unknown',
  ]) {
    assert.equal(classifyCommitFailure(text), 'identity-missing', text.slice(0, 30))
  }
})

test('classifyCommitFailure：工作区干净时给出 nothing-to-commit', () => {
  assert.equal(classifyCommitFailure('nothing to commit, working tree clean'), 'nothing-to-commit')
  assert.equal(classifyCommitFailure('无文件要提交，干净的工作区'), 'nothing-to-commit')
})

test('classifyCommitFailure：别的失败仍是 none', () => {
  assert.equal(classifyCommitFailure('fatal: something else'), 'none')
  assert.equal(classifyCommitFailure(''), 'none')
})

test('commitHint：身份问题必须给出两条确切的配置命令', () => {
  const hint = commitHint('identity-missing')
  assert.match(hint, /user\.name/)
  assert.match(hint, /user\.email/)
  assert.match(commitHint('nothing-to-commit'), /暂存/)
  assert.equal(commitHint('none'), null)
})

// ── 切换分支失败单独分类：脏工作区 / 分支不存在 ──────────────────────────

test('classifyCheckoutFailure：脏工作区与分支不存在分开认', () => {
  assert.equal(
    classifyCheckoutFailure('error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt'),
    'dirty-worktree',
  )
  assert.equal(
    classifyCheckoutFailure('error: The following untracked working tree files would be overwritten by checkout:\n\tu.txt'),
    'dirty-worktree',
  )
  assert.equal(classifyCheckoutFailure("fatal: invalid reference: nope"), 'branch-missing')
  assert.equal(classifyCheckoutFailure('fatal: something else'), 'none')
})

test('checkoutHint：脏工作区要指向「安全切分支」，分支不存在要指向新建', () => {
  const dirty = checkoutHint('dirty-worktree')
  assert.match(dirty, /安全切分支/, '要把面板上真正能救场的那条路说出来')
  assert.match(checkoutHint('branch-missing'), /新建/)
  assert.equal(checkoutHint('none'), null)
})

// ── parseStashList：git stash list（面板「stash 备份」） ────────────────────

test('parseStashList：编号与说明分开取，编号必须原样（它是会交给 git 的参数）', () => {
  assert.deepEqual(parseStashList('stash@{0}: WIP on main: 1234abc 提交说明\nstash@{1}: On dev: 手头的改动\n'), [
    { ref: 'stash@{0}', text: 'WIP on main: 1234abc 提交说明' },
    { ref: 'stash@{1}', text: 'On dev: 手头的改动' },
  ])
})

test('parseStashList：空输出与不成形的行都跳过（宁可少列一条，不能拼错编号）', () => {
  assert.deepEqual(parseStashList(''), [])
  assert.deepEqual(parseStashList('stash@{x}: 坏的\n随便一行\n'), [])
  assert.deepEqual(parseStashList(null), [])
})

// ── remoteOpFor：配置推送目标（面板 setRemote 与工具 git_remote set 共用） ─

test('remoteOpFor：远程已存在 → set-url 改地址', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', 'origin\nupstream\n'), ['remote', 'set-url', 'origin', 'https://new/a.git'])
})

test('remoteOpFor：远程不存在 → add 新建', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', 'upstream\n'), ['remote', 'add', 'origin', 'https://new/a.git'])
})

test('remoteOpFor：空远程列表 → add', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', ''), ['remote', 'add', 'origin', 'https://new/a.git'])
})

// ── cloneTargetName：git clone 默认目标名 ─────────────────────────────────

test('cloneTargetName：https + .git 后缀', () => {
  assert.equal(cloneTargetName('https://github.com/user/my-repo.git'), 'my-repo')
})

test('cloneTargetName：https 无 .git、带尾部斜杠', () => {
  assert.equal(cloneTargetName('https://github.com/user/my-repo'), 'my-repo')
  assert.equal(cloneTargetName('https://github.com/user/my-repo/'), 'my-repo')
})

test('cloneTargetName：scp 风格 ssh 地址', () => {
  assert.equal(cloneTargetName('git@github.com:user/other.git'), 'other')
})

test('cloneTargetName：本地路径与 Windows 路径 → 取最后一段（与 git 一致）', () => {
  assert.equal(cloneTargetName('/tmp/some/repo'), 'repo')
  assert.equal(cloneTargetName('C:\\work\\win-repo'), 'win-repo')
})

test('cloneTargetName：无路径分隔的输入原样返回（git 对本地路径即取 basename）', () => {
  assert.equal(cloneTargetName('not a url at all'), 'not a url at all')
})

test('cloneTargetName：空输入退化为占位名', () => {
  assert.equal(cloneTargetName(''), 'repository')
  assert.equal(cloneTargetName(null), 'repository')
})

// ── repoPageUrl：远程地址 → 仓库主页（面板「仓库页 ↗」入口） ────────────────

test('repoPageUrl：https + .git 后缀 → 去后缀', () => {
  assert.equal(repoPageUrl('https://github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：https 无 .git、尾部斜杠、大写 .GIT', () => {
  assert.equal(repoPageUrl('https://github.com/user/my-repo'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('https://github.com/user/my-repo/'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('https://github.com/user/my-repo.GIT/'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：scp 风格 ssh 地址（git@host:path）', () => {
  assert.equal(repoPageUrl('git@github.com:user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：git:// 与 ssh:// 协议', () => {
  assert.equal(repoPageUrl('git://github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('ssh://git@github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：非 GitHub 主机同样可打开（GitLab / Gitee）', () => {
  assert.equal(repoPageUrl('https://gitlab.com/group/proj.git'), 'https://gitlab.com/group/proj')
  assert.equal(repoPageUrl('git@gitee.com:user/proj.git'), 'https://gitee.com/user/proj')
})

test('repoPageUrl：带端口的主机保留端口', () => {
  assert.equal(repoPageUrl('https://example.com:8443/a.git'), 'https://example.com:8443/a')
})

test('repoPageUrl：推导不出来的一律 null（本地路径 / 盘符 / file / 空 / 无路径）', () => {
  assert.equal(repoPageUrl('/home/me/repo'), null)
  assert.equal(repoPageUrl('C:\\work\\win-repo'), null)
  assert.equal(repoPageUrl('file:///home/me/repo'), null)
  assert.equal(repoPageUrl('not a url at all'), null)
  assert.equal(repoPageUrl(''), null)
  assert.equal(repoPageUrl(null), null)
  assert.equal(repoPageUrl('https://github.com'), null)
  assert.equal(repoPageUrl('git@github.com:'), null)
})

// ── normalizeDir：目录参数归一化 + ~ 展开 ─────────────────────────────────

test('normalizeDir：空白/非字符串按“未提供”处理', () => {
  assert.equal(normalizeDir(''), undefined)
  assert.equal(normalizeDir('   '), undefined)
  assert.equal(normalizeDir(undefined), undefined)
  assert.equal(normalizeDir(null), undefined)
})

test('normalizeDir：绝对路径原样返回', () => {
  assert.equal(normalizeDir('/home/user/project'), '/home/user/project')
})

test('normalizeDir：~ 与 ~/ 展开为主目录', () => {
  assert.equal(normalizeDir('~'), homedir())
  // 期望值必须和实现用同一套拼接（path.join）：写成 homedir() + '/work/repo'
  // 在 Windows 上必然失败 —— 那是测试自己的 bug，不是代码的。
  assert.equal(normalizeDir('~/work/repo'), join(homedir(), 'work', 'repo'))
})

// ── parseBranchOutput：git branch --no-color（面板分支管理器） ─────────────

test('parseBranchOutput：常规列表，* 标记当前分支', () => {
  const parsed = parseBranchOutput('* main\n  feature/x\n  dev\n')
  assert.equal(parsed.current, 'main')
  assert.deepEqual(parsed.items, [
    { name: 'main', current: true },
    { name: 'feature/x', current: false },
    { name: 'dev', current: false },
  ])
})

test('parseBranchOutput：游离 HEAD 时伪条目被跳过且没有分支被标为当前', () => {
  const parsed = parseBranchOutput('* (HEAD detached at abc1234)\n  main\n')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [{ name: 'main', current: false }])
})

test('parseBranchOutput：只有游离 HEAD（空仓库孤儿分支）→ current 为 null', () => {
  const parsed = parseBranchOutput('* (HEAD detached at abc1234)\n')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [])
})

test('parseBranchOutput：还没有任何分支 → 空列表', () => {
  const parsed = parseBranchOutput('')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [])
})

// ── parseRemoteBranchOutput：git branch --remotes（面板「管理」的远端分组） ──

test('parseRemoteBranchOutput：HEAD 指针不是分支，真分支按 ref 排序并标出默认分支', () => {
  const parsed = parseRemoteBranchOutput(
    '  origin/HEAD -> origin/main\n  upstream/dev\n  origin/main\n',
  )
  assert.equal(parsed.defaultRef, 'origin/main')
  assert.deepEqual(parsed.items, [
    { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
    { remote: 'upstream', name: 'dev', ref: 'upstream/dev', head: false },
  ])
})

test('parseRemoteBranchOutput：只有 HEAD 指针（远端分支还没下载下来）→ 没有可点的分支', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n')
  assert.equal(parsed.defaultRef, 'origin/main')
  assert.deepEqual(parsed.items, [])
})

test('parseRemoteBranchOutput：空输出 / 非分支行都被忽略', () => {
  assert.deepEqual(parseRemoteBranchOutput(''), { items: [], defaultRef: null })
  assert.deepEqual(parseRemoteBranchOutput('  main\n  origin/\n'), { items: [], defaultRef: null })
})

// ── parseBranchUpstreams：git for-each-ref（面板「本地分支」的 → 远端 标签） ──

test('parseBranchUpstreams：制表符分列，上游与领先/落后都解析出来', () => {
  const table = parseBranchUpstreams(
    'main\torigin/main\t[ahead 1, behind 2]\n'
    + 'dev\tupstream/dev\t\n'
    + 'solo\t\t\n',
  )
  assert.deepEqual(table, {
    main: { upstream: 'origin/main', ahead: 1, behind: 2, gone: false },
    dev: { upstream: 'upstream/dev', ahead: 0, behind: 0, gone: false },
    solo: { upstream: null, ahead: 0, behind: 0, gone: false },
  })
})

test('parseBranchUpstreams：中文 locale 的领先/落后同样认（数字不该跟着 git 语言变）', () => {
  const table = parseBranchUpstreams('main\torigin/main\t[领先 3, 落后 4]\n')
  assert.deepEqual(table.main, { upstream: 'origin/main', ahead: 3, behind: 4, gone: false })
})

test('parseBranchUpstreams：上游被删（[gone]）要标出来，而不是当成正常跟踪', () => {
  const table = parseBranchUpstreams('feat\torigin/feat\t[gone]\n')
  assert.equal(table.feat.upstream, 'origin/feat')
  assert.equal(table.feat.gone, true, '[gone] 必须能被识别：否则界面显示「→ origin/feat」会骗人')
})

test('parseBranchUpstreams：畸形输入不抛异常（空行 / 缺字段 / CRLF / 非数字 / 含方括号的名字）', () => {
  assert.deepEqual(parseBranchUpstreams(''), {})
  assert.deepEqual(parseBranchUpstreams('\n\n'), {})
  assert.deepEqual(parseBranchUpstreams('main'), { main: { upstream: null, ahead: 0, behind: 0, gone: false } })
  assert.deepEqual(parseBranchUpstreams('main\t'), { main: { upstream: null, ahead: 0, behind: 0, gone: false } })
  // 含方括号的分支名：这正是不能用 `git branch -vv` 解析的原因（那里切不出字段）。
  assert.deepEqual(parseBranchUpstreams('feat[x]/y\torigin/feat[x]/y\t'), {
    'feat[x]/y': { upstream: 'origin/feat[x]/y', ahead: 0, behind: 0, gone: false },
  })
  assert.deepEqual(parseBranchUpstreams('a\torigin/a\t[ahead x]\r\n'), {
    a: { upstream: 'origin/a', ahead: 0, behind: 0, gone: false },
  })
  // 多余字段不越界，取前三个。
  assert.deepEqual(parseBranchUpstreams('b\torigin/b\t[ahead 1]\tEXTRA'), {
    b: { upstream: 'origin/b', ahead: 1, behind: 0, gone: false },
  })
})

// ── parseLsRemoteHead：git ls-remote --symref <远程> HEAD（默认分支兜底） ──

test('parseLsRemoteHead：符号引用行给出分支名（tab 分隔）', () => {
  assert.equal(parseLsRemoteHead('ref: refs/heads/master\tHEAD\n'), 'master')
  assert.equal(parseLsRemoteHead('ref: refs/heads/feature/llama-4\tHEAD\n'), 'feature/llama-4')
  // 老服务器不认 --symref，只回哈希行 —— 解析不出名字，返回 null 而不是瞎猜。
  assert.equal(parseLsRemoteHead('3d82ef62d47fd74e18f36c5eccbdcf965b617b17\tHEAD\n'), null)
  assert.equal(parseLsRemoteHead(''), null)
  assert.equal(parseLsRemoteHead(null), null)
})

// ── parseRemoteHeads：每个远程各自的默认分支（面板「拉取自」要点名分支） ────
//
// 这一段盯的是「切得对不对」：解析错了会静默给出**别的远程**的分支名，面板于是把
// `origin/master` 说成 `fork/master` —— 而用户是照着这句话去拉代码的。

test('parseRemoteHeads：每个远程各给一条默认分支（tab 分隔，取 %(refname) 与 %(symref)）', () => {
  const parsed = parseRemoteHeads(
    'refs/remotes/origin/HEAD\trefs/remotes/origin/master\n'
    + 'refs/remotes/fork/HEAD\trefs/remotes/fork/local.2\n',
  )
  assert.deepEqual(parsed, { origin: 'master', fork: 'local.2' })
})

test('parseRemoteHeads：分支名里的斜杠要完整保留（feature/x 不是「远程名」）', () => {
  const parsed = parseRemoteHeads('refs/remotes/upstream/HEAD\trefs/remotes/upstream/feature/llama-4\n')
  assert.deepEqual(parsed, { upstream: 'feature/llama-4' })
})

test('parseRemoteHeads：自指、指向别的远程、非 HEAD 行与空输出一律不给答案', () => {
  // `origin/HEAD -> origin/HEAD`：异常仓库，不是分支名 —— 给了会让面板去拉一条不存在的分支。
  assert.deepEqual(parseRemoteHeads('refs/remotes/origin/HEAD\trefs/remotes/origin/HEAD\n'), {})
  // 符号引用指向别的远程（也不可能，但绝不能把对方的 HEAD 名字算成这个远程的分支）。
  assert.deepEqual(parseRemoteHeads('refs/remotes/origin/HEAD\trefs/remotes/other/main\n'), {})
  // 真分支行（没有 symref 那一列）不是 HEAD 指针，不能当默认分支。
  assert.deepEqual(parseRemoteHeads('refs/remotes/origin/main\t\n'), {})
  assert.deepEqual(parseRemoteHeads('refs/remotes/origin/main\n'), {})
  assert.deepEqual(parseRemoteHeads(''), {})
  assert.deepEqual(parseRemoteHeads(null), {})
})

test('parseRemoteHeads：没有 HEAD 指针的远程不出现在表里（面板据此按当前分支拉，而不是猜一条）', () => {
  // 老版 git 手动 remote add + fetch（本地不会建立 refs/remotes/<远程>/HEAD）：
  // 拿不到答案就**不给**答案 —— 面板的「从此外拉」于是退回「拉当前分支同名那条」。
  const parsed = parseRemoteHeads('refs/remotes/origin/main\t\nrefs/remotes/fork/HEAD\trefs/remotes/fork/master\n')
  assert.deepEqual(parsed, { fork: 'master' })
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'origin'), false, 'origin 没有指针就不该出现在表里')
})

// ── isSafeRemoteRef：远端引用会作为参数交给 git，必须先校验 ────────────────

test('isSafeRemoteRef：正常远端引用通过', () => {
  for (const ref of ['origin/main', 'origin/feature/x', 'upstream/v1.2.3', 'origin/main-2']) {
    assert.equal(isSafeRemoteRef(ref), true, ref + ' 应该通过')
  }
})

test('isSafeRemoteRef：选项、区间、空白与非法字符一个都不能放过', () => {
  for (const ref of ['-x', '--upload-pack=y', 'a..b', 'HEAD~2', 'a b', 'a^', 'a:b', 'a?b', 'a*b',
    '/x', 'x/', 'x.lock', 'a@{1}', '', null, undefined, 'x'.repeat(201)]) {
    assert.equal(isSafeRemoteRef(ref), false, JSON.stringify(ref) + ' 必须被拒绝')
  }
})

// ── parseCompareOutput：git rev-list --left-right --count ──────────────────

test('parseCompareOutput：左列是本地领先、右列是本地落后', () => {
  assert.deepEqual(parseCompareOutput('3\t5\n', 'origin/main'), { ref: 'origin/main', ahead: 3, behind: 5 })
  assert.deepEqual(parseCompareOutput('0\t0', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
})

test('parseCompareOutput：解析不出来一律 0（宁可不说，也不报假数字）', () => {
  assert.deepEqual(parseCompareOutput('', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
  assert.deepEqual(parseCompareOutput('换个说法', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
  assert.deepEqual(parseCompareOutput('7', 'origin/main'), { ref: 'origin/main', ahead: 7, behind: 0 })
  assert.deepEqual(parseCompareOutput('-1\t-2', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
})

// ── pickRemoteDefaultBranch：本地分支名在远端不存在时，该按哪个分支重试 ────
//
// 这是「本地 master / 远端 main」那条路上的推断环节：推错了会去拉一个不存在的分支，
// 所以只允许两种确定的答案 —— 远端自己的默认分支指针，或该远程唯一的分支。

test('pickRemoteDefaultBranch：优先用远端自己的默认分支指针', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n  origin/main\n  origin/dev\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'main')
})

test('pickRemoteDefaultBranch：没有指针但该远程只有一个分支时就是它', () => {
  const parsed = parseRemoteBranchOutput('  origin/main\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'main')
})

test('pickRemoteDefaultBranch：多个分支又没有指针 → 不猜（null）', () => {
  const parsed = parseRemoteBranchOutput('  origin/dev\n  origin/release\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), null)
})

test('pickRemoteDefaultBranch：同名、远程对不上、空列表一律 null', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n  origin/main\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'main'), null, '同名不是这个场景')
  assert.equal(pickRemoteDefaultBranch(parsed, 'upstream', 'master'), null, '别的远程的分支不算')
  assert.deepEqual(parseRemoteBranchOutput(''), { items: [], defaultRef: null })
  assert.equal(pickRemoteDefaultBranch(parseRemoteBranchOutput(''), 'origin', 'master'), null)
  assert.equal(pickRemoteDefaultBranch(null, 'origin', 'master'), null)
})

test('pickRemoteDefaultBranch：指针指向别的远程时不能拿来用', () => {
  const parsed = parseRemoteBranchOutput('  upstream/HEAD -> upstream/main\n  upstream/main\n  origin/dev\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'dev', 'origin 只有一个分支 → dev')
  assert.equal(pickRemoteDefaultBranch(parsed, 'upstream', 'master'), 'main')
})

// ── buildOpArgv：新增的两种只读本地操作 ────────────────────────────────────

test('buildOpArgv：remoteBranches 只列远端分支，不碰网络', async () => {
  assert.deepEqual(await buildOpArgv('remoteBranches', {}), ['branch', '--remotes', '--no-color'])
})

test('buildOpArgv：compare 用 HEAD...<ref>，ref 非法时明确报错', async () => {
  assert.deepEqual(
    await buildOpArgv('compare', { ref: ' origin/main ' }),
    ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
  )
  await assert.rejects(() => buildOpArgv('compare', { ref: '-x' }), /远端分支/)
  await assert.rejects(() => buildOpArgv('compare', {}), /远端分支/)
})

// ── 新增操作的 argv：单文件暂存/还原、提交详情、stash、改名、变基 ─────────

test('buildOpArgv：单文件暂存 / 取消暂存 / 还原都带 `--` 分隔符', async () => {
  assert.deepEqual(await buildOpArgv('add', { path: 'a b.txt' }), ['add', '--', 'a b.txt'])
  assert.deepEqual(await buildOpArgv('unstageFile', { path: 'a.txt' }), ['restore', '--staged', '--', 'a.txt'])
  assert.deepEqual(await buildOpArgv('restoreFile', { path: 'a.txt' }), ['restore', '--', 'a.txt'])
  // 路径缺失是可展示的中文错误，而不是拼出一条 `git add --` 去执行。
  await assert.rejects(() => buildOpArgv('add', {}), /文件路径/)
  await assert.rejects(() => buildOpArgv('restoreFile', {}), /文件路径/)
})

test('buildOpArgv：提交详情带 --stat 与完整作者信息，并走本地超时档', async () => {
  const argv = await buildOpArgv('show', { ref: 'abc1234' })
  assert.deepEqual(argv, ['show', '--no-color', '--stat', '--format=fuller', 'abc1234'])
  assert.equal(opTimeoutMs(OPS.show), GIT_LOCAL_TIMEOUT_MS, '本地命令不该按两分钟预算等')
  await assert.rejects(() => buildOpArgv('show', {}), /提交号/)
})

test('buildOpArgv：stash 应用/删除只接受 stash@{n} 形态的编号', async () => {
  assert.deepEqual(await buildOpArgv('stashApply', { ref: 'stash@{0}' }), ['stash', 'apply', 'stash@{0}'])
  assert.deepEqual(await buildOpArgv('stashDrop', { ref: 'stash@{12}' }), ['stash', 'drop', 'stash@{12}'])
  // 编号会作为参数交给 git，形状不对必须当场拒绝（否则可能 drop 到别的东西上）。
  await assert.rejects(() => buildOpArgv('stashDrop', { ref: 'HEAD' }), /stash/)
  await assert.rejects(() => buildOpArgv('stashApply', { ref: '-x' }), /stash/)
  await assert.rejects(() => buildOpArgv('stashDrop', {}), /stash/)
})

test('buildOpArgv：分支改名与暂存列表', async () => {
  assert.deepEqual(await buildOpArgv('renameBranch', { name: 'main' }), ['branch', '-m', 'main'])
  await assert.rejects(() => buildOpArgv('renameBranch', { name: '-x' }), /分支名/)
  await assert.rejects(() => buildOpArgv('renameBranch', {}), /新分支名/)
  assert.deepEqual(await buildOpArgv('stashList', {}), ['stash', 'list'])
})

test('buildOpArgv：改名给了 from 就显式写全两个位置参数（改的是那一条，不是「谁在那儿谁挨改」）', async () => {
  assert.deepEqual(
    await buildOpArgv('renameBranch', { name: 'trunk', from: 'master' }),
    ['branch', '-m', 'master', 'trunk'],
    '面板的编辑器标题写的是「把分支 master 改名」，命令就必须真的改 master',
  )
  // 两个位置都过白名单：from 也是要交给 git 的参数，形状不对当场拒。
  await assert.rejects(() => buildOpArgv('renameBranch', { name: 'ok', from: '-x' }), /分支不合法/)
  await assert.rejects(() => buildOpArgv('renameBranch', { name: 'ok', from: 'a b' }), /分支不合法/)
})

test('renameBranch 的结果说明：给了 from 就把「改成什么」写成一句中文（git 成功时一个字都不打印）', () => {
  const note = OPS.renameBranch.note({}, { name: 'trunk', from: 'master' })
  assert.match(note, /master/)
  assert.match(note, /trunk/)
  assert.match(note, /提交历史/, '要写明历史不动：这是用户此刻唯一想确认的事')
  // 老调用方（模型工具 / 老客户端）只给 name：宿主并不知道改的是哪一条，不编造。
  assert.equal(OPS.renameBranch.note({}, { name: 'trunk' }), null)
  assert.equal(OPS.renameBranch.note({}, null), null)
})

test('buildOpArgv：pull 的 rebase 开关来自请求体，默认不加', async () => {
  assert.deepEqual(await buildOpArgv('pull', {}), ['pull'])
  assert.deepEqual(await buildOpArgv('pull', { rebase: true }), ['pull', '--rebase'])
})

test('buildOpArgv：commit 的 amend 开关', async () => {
  assert.deepEqual(await buildOpArgv('commit', { message: 'x' }), ['commit', '-m', 'x'])
  assert.deepEqual(await buildOpArgv('commit', { message: 'x', amend: true }), ['commit', '--amend', '-m', 'x'])
})

test('opTimeoutMs：数据型/本地操作用 20 秒档，联网操作用 10 分钟档', () => {
  // 600000 = NETWORK_OP_TIMEOUT_MS（联网操作 10 分钟预算，见 ops.js）。
  for (const op of ['diff', 'branches', 'remoteBranches', 'compare', 'show', 'stashList']) {
    assert.equal(opTimeoutMs(OPS[op]), GIT_LOCAL_TIMEOUT_MS, op + ' 应该走本地档')
  }
  for (const op of ['pull', 'push', 'fetch', 'clone']) {
    assert.equal(opTimeoutMs(OPS[op]), 600000, op + ' 是联网操作，要给足预算')
  }
})

// ── 「两套历史互不相关」的两个选择必须带着远端分支名 ──────────────────────
//
// 回归：按钮原先只回 { mode }，adoptRemote 于是按「当前分支名」去拼 remoteRef。
// 而这两个按钮出现的典型场景恰恰是本地 master、远端 main —— 拼出来的
// origin/master 根本不存在，点下去只会得到「本地还没有 origin/master」。

test('unrelatedChoices：两个选择的参数里都带上真正的远端与分支', () => {
  const choices = unrelatedChoices('origin', 'main')
  assert.equal(choices.length, 2)
  for (const choice of choices) {
    assert.equal(choice.op, 'adoptRemote')
    assert.equal(choice.params.remote, 'origin')
    assert.equal(choice.params.branch, 'main')
  }
  assert.equal(choices[0].params.mode, 'branch')
  assert.equal(choices[1].params.mode, 'reset')
  // 文案要说清「动的是谁」：写错分支名比不写更糟。
  assert.match(choices[0].detail, /origin\/main/)
  assert.match(choices[1].confirm, /origin\/main/)
})

test('pullHint：remote-branch-missing 不能再只说「去推送」（那会推出多余的 master）', () => {
  const hint = pullHint('remote-branch-missing')
  assert.match(hint, /获取远程/, '要先让用户把远端分支信息拿下来')
  assert.match(hint, /管理/, '要指向能看到远端分支的地方')
  assert.doesNotMatch(hint, /^远端还没有这个分支：先点一次「推送」/)
})

// ── truncateText：超长输出截断（diff 面板防爆） ────────────────────────────

test('truncateText：短文本原样返回', () => {
  assert.equal(truncateText('hello', 100), 'hello')
  assert.equal(truncateText('刚好', 2), '刚好')
})

test('truncateText：超长按上限截断并保留截断提示', () => {
  const text = 'x'.repeat(500)
  const result = truncateText(text, 40)
  assert.ok(result.startsWith('x'.repeat(40)))
  assert.ok(result.includes('已截断'))
  assert.ok(result.length < text.length)
  assert.ok(result.length < 100)
})

// ── 帮助文档：escapeHtml / renderHelpHtml ────────────────────────────────

test('escapeHtml：转义 HTML 敏感字符', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

test('escapeHtml：null/undefined 当空串处理', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('renderHelpHtml：是完整文档且含全部分组与命令', () => {
  const html = renderHelpHtml()
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<title>Git 帮助 · dsh-git-sidebar</title>'))
  assert.ok(html.includes('面板操作方式'))
  for (const title of ['👀 查看状态与更新', '✍️ 提交与推送', '🌿 分支', '📦 救场 stash', '⌛ 撤销', '🏷️ 标签与历史', '🔌 远程仓库']) {
    assert.ok(html.includes(title), title + ' 应出现在文档里')
  }
  // 命令既要显示成按钮，也要进 data-cmd（复制用的原文）
  assert.ok(html.includes('>git status -sb</button>'))
  assert.ok(html.includes('data-cmd="git status -sb"'))
  // 复制脚本与深浅色适配
  assert.ok(html.includes('navigator.clipboard'))
  assert.ok(html.includes('prefers-color-scheme'))
  assert.ok(html.trimEnd().endsWith('</html>'))
})

test('renderHelpHtml：命令里的引号被转义进属性，不会截断 HTML', () => {
  const html = renderHelpHtml()
  assert.ok(html.includes('data-cmd="git commit -m &quot;提交说明&quot;"'))
  assert.ok(html.includes('data-cmd="git tag -a v1.0 -m &quot;版本说明&quot;"'))
})

// ── 日志模块（临时目录，不碰用户真实主目录、也不写进仓库根） ────────────────
//
// 日志**默认**落在本插件仓库根目录（lib/log.js 的上一级），所以这里每个用例都
// 显式把 logFile 指到临时目录：否则用例之间、乃至并行运行的其它测试文件会一起
// 往仓库根那个 git-sidebar.log 里写，行数断言立刻变成随机的。

/** 本仓库根目录：`test/unit.test.mjs` 的上一级（与 lib/log.js 推导出的那个一致）。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let logHome = null

/** 本段用例共用的日志文件（临时目录里的那个）。 */
const logPath = () => join(logHome, 'git-sidebar.log')

/** 设置日志配置，并强制把文件钉在临时目录。 */
function useLog(options = {}) {
  setLogConfig(Object.assign({}, options, { file: logPath() }))
}

before(async () => {
  logHome = await mkdtemp(join(tmpdir(), 'git-sidebar-log-'))
  process.env.DSH_HOME = logHome
})

after(async () => {
  setLogConfig({})
  if (logHome !== null) await rm(logHome, { recursive: true, force: true })
})

test('日志：默认落在本插件仓库根目录，且与启动目录（process.cwd()）无关', () => {
  setLogConfig({})
  assert.equal(logFilePath(), join(repoRoot, 'git-sidebar.log'))

  // 只比对上面的常量还不够 —— 跑测试时 cwd 恰好也是仓库根，等式两边会一起变。
  // 真正锁住「不跟 cwd 走」：在一个无关目录里起一个 node 进程，读它算出的默认路径。
  const entry = new URL('../lib/log.js', import.meta.url).href
  const probe = `import { logFilePath } from ${JSON.stringify(entry)}; process.stdout.write(logFilePath())`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: tmpdir(),
    encoding: 'utf8',
  })
  assert.equal(out, join(repoRoot, 'git-sidebar.log'), '换个 cwd 启动，日志路径必须原地不动')
})

test('日志：级别归一化 —— 非法/缺省落 info，off 是可用的合法值', () => {
  assert.equal(normalizeLogLevel('off'), 'off')
  assert.equal(normalizeLogLevel('error'), 'error')
  assert.equal(normalizeLogLevel('warn'), 'warn')
  assert.equal(normalizeLogLevel('info'), 'info')
  assert.equal(normalizeLogLevel('debug'), 'debug')
  assert.equal(normalizeLogLevel('INFO'), 'info')
  assert.equal(normalizeLogLevel(''), 'info')
  assert.equal(normalizeLogLevel(null), 'info')
  assert.equal(normalizeLogLevel(42), 'info')
})

test('日志：轮转上限归一化 —— 非正数落默认值', () => {
  assert.equal(normalizeLogMaxBytes(1024), 1024)
  assert.equal(normalizeLogMaxBytes(0), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes(-5), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes(NaN), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes('x'), 2 * 1024 * 1024)
})

test('日志：shouldLog 按当前级别过滤', () => {
  useLog({ level: 'warn' })
  assert.equal(shouldLog('error'), true)
  assert.equal(shouldLog('warn'), true)
  assert.equal(shouldLog('info'), false)
  assert.equal(shouldLog('debug'), false)
  useLog({ level: 'off' })
  assert.equal(shouldLog('error'), false)
  useLog()
})

test('日志：appendLog 写 JSONL，字段齐全且可解析', async () => {
  useLog({ level: 'debug' })
  const path = logFilePath()
  assert.equal(path, logPath())
  await rm(path, { force: true })
  await appendLog('info', 'op', { op: 'push', dir: '/tmp/x', argv: ['push'], exit: 0, ms: 12 })
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text.trim())
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.event, 'op')
  assert.equal(parsed.op, 'push')
  assert.equal(parsed.exit, 0)
  assert.ok(typeof parsed.at === 'string' && parsed.at.length > 0, '要有时间戳')
  useLog()
})

test('日志：级别过滤生效 —— info 级别下 debug 事件不落盘', async () => {
  useLog({ level: 'info' })
  const path = logFilePath()
  await rm(path, { force: true })
  await appendLog('debug', 'git', { argv: ['status'] })
  await appendLog('warn', 'op', { op: 'push', exit: 128 })
  const text = await readFile(path, 'utf8')
  assert.ok(!text.includes('"event":"git"'), 'debug 事件不该出现在 info 日志里')
  assert.ok(text.includes('"event":"op"'), 'warn 事件应该落盘')
  useLog()
})

test('日志：超过上限自动轮转，只保留当前与 .1 两份', async () => {
  useLog({ level: 'debug', maxBytes: 200 })
  const path = logFilePath()
  await rm(path, { force: true })
  await rm(path + '.1', { force: true })
  // 每条约 90 字节，上限 200：写 6 条必然触发至少一次轮转。
  for (let index = 0; index < 6; index += 1) {
    await appendLog('info', 'op', { op: 'push', exit: 0, payload: 'x'.repeat(40) })
  }
  const current = await stat(path)
  assert.ok(current.size <= 200 + 200, '当前文件应被控制在轮转阈值附近（有一条是「跨过线」的那条）')
  const backup = await stat(path + '.1')
  assert.ok(backup.size > 0, '旧日志应被改名成 .1')
  useLog()
})

test('日志：readLogTail 只读尾部指定行数', async () => {
  useLog({ level: 'debug' })
  const path = logFilePath()
  await rm(path, { force: true })
  for (let index = 0; index < 10; index += 1) {
    await appendLog('info', 'op', { op: 'push', n: index })
  }
  const tail = await readLogTail(3)
  assert.equal(tail.length, 3)
  assert.ok(tail[0].includes('"n":7'), '尾部第一行应是第 8 条')
  assert.ok(tail[2].includes('"n":9'))
  const all = await readLogTail(200)
  assert.equal(all.length, 10, '行数上限内应全量返回')
  const fallback = await readLogTail(0)
  assert.equal(fallback.length, 10, '非正行数按默认值（取全部），但不该抛异常')
  assert.equal((await readLogTail(-3)).length, 10)
  useLog()
})

test('日志：readLogTail 文件不存在时返回空数组而不是抛异常', async () => {
  setLogConfig({ file: join(logHome, 'does-not-exist.log') })
  assert.deepEqual(await readLogTail(10), [])
  setLogConfig({})
})

// ── 本地分支名 ≠ 上游分支名（本次的真实现场） ─────────────────────────────
//
// 现场：本地分支叫 `origin-main`、它跟踪的是 `origin/main`，点「推送」只回一句
// `fatal: The upstream branch of your current branch does not match the name of
// your current branch.`（push.default=simple 只在两边同名时才肯裸推）。
// 这段话里没有一个字告诉用户下一步该做什么 —— 所以既要有分类，也要有可点的路。

test('classifyPushFailure：本地名与上游名不一致要单独成一类，不能被 rejected 抢走', () => {
  const real = 'fatal: The upstream branch of your current branch does not match\n'
    + 'the name of your current branch.  To push to the upstream branch\n'
    + 'on the remote, use\n\n    git push origin HEAD:main\n'
  assert.equal(classifyPushFailure(real), 'upstream-name-mismatch')
  // 单行形态（git 换行位置可能不同）
  assert.equal(
    classifyPushFailure('fatal: The upstream branch of your current branch does not match the name of your current branch.'),
    'upstream-name-mismatch',
  )
  // 被 git 提到 push.default 时的说法
  assert.equal(classifyPushFailure('fatal: push.default is set to ...'), 'upstream-name-mismatch')
})

test('pushHint：名称不一致这条必须给出「不用敲命令」的下一步', () => {
  const hint = pushHint('upstream-name-mismatch')
  assert.equal(typeof hint, 'string')
  assert.match(hint, /同名|一致/, '要说清原因：两边名字不一样')
  assert.match(hint, /选项|选一个/, '要指向下面那几条可点的路')
  assert.doesNotMatch(hint, /^\s*fatal:/, '不能把 git 英文原文当提示')
})

test('upstreamBranchName：origin/main → main（含远端名带斜杠时按第一个斜杠切）', () => {
  assert.equal(upstreamBranchName('origin/main'), 'main')
  assert.equal(upstreamBranchName('upstream/feat/x'), 'feat/x')
  assert.equal(upstreamBranchName('main'), null, '没有斜杠就不是上游全名')
  assert.equal(upstreamBranchName('origin/'), null)
  assert.equal(upstreamBranchName(null), null)
  assert.equal(upstreamBranchName(''), null)
})

test('mismatchPushChoices：三条路都给出明确的 op 与参数（面板点了就能跑）', () => {
  const choices = mismatchPushChoices({ remote: 'origin', branch: 'main', local: 'origin-main' })
  assert.equal(choices.length, 3)
  const byId = Object.fromEntries(choices.map((item) => [item.id, item]))
  assert.equal(byId['push-upstream'].op, 'pushUpstream')
  assert.deepEqual(byId['push-upstream'].params, { remote: 'origin', branch: 'main' })
  assert.equal(byId['push-same-name'].op, 'pushSameName')
  assert.deepEqual(byId['push-same-name'].params, { remote: 'origin' })
  assert.equal(byId['rename-local'].op, 'renameBranch')
  // from 必须显式带上：这条路的语义是「把 origin-main 改名为 main」，而裸
  // `git branch -m main` 改的是**当前分支**——两者只在巧合时才是同一条。
  assert.deepEqual(byId['rename-local'].params, { name: 'main', from: 'origin-main' })
  // 三条都要能自解释：label 是按钮上那行字，detail 说清后果。
  for (const item of choices) {
    assert.ok(item.label.length > 0, item.id + ' 要有 label')
    assert.ok(item.detail.length > 0, item.id + ' 要有 detail')
  }
  // 改名是有副作用的：必须二次确认，且确认文案里写清「历史不动」。
  assert.match(byId['rename-local'].confirm, /提交历史/)
  assert.equal(byId['push-upstream'].confirm, null, '推到上游是纯追加，不需要确认')
})

test('mismatchPushChoices：信息不全时宁缺勿猜（没有上游就不给「推到上游」）', () => {
  assert.equal(mismatchPushChoices(null), null)
  assert.equal(mismatchPushChoices({}), null)
  assert.equal(mismatchPushChoices({ remote: 'origin' }), null, '既没 branch 也没 local → 没有可给的路')
  const onlyBranch = mismatchPushChoices({ branch: 'main' })
  assert.equal(onlyBranch, null)
  const same = mismatchPushChoices({ remote: 'origin', branch: 'main', local: 'main' })
  assert.ok(
    !same.some((item) => item.id === 'rename-local'),
    '两边同名时不该出现「改名」这条路（那本来就不是不一致）',
  )
})

test('classifyDeleteBranchFailure：未完全合并被拒要认出来（git 的保护，不是故障）', () => {
  assert.equal(classifyDeleteBranchFailure("error: the branch 'main' is not fully merged"), 'unmerged')
  assert.equal(classifyDeleteBranchFailure('error: 分支 main 未完全合并'), 'unmerged')
  assert.equal(classifyDeleteBranchFailure("error: branch 'main' not found."), 'missing')
  assert.equal(classifyDeleteBranchFailure('fatal: something else'), 'none')
})

test('deleteBranchHint + forceDeleteChoice：讲清后果，再给一条可点的 -D', () => {
  const hint = deleteBranchHint('unmerged')
  assert.match(hint, /保护|防误删/, '要说清这是 git 的保护')
  assert.match(hint, /强制删除/, '要指向「强制删除」这个出口')
  assert.equal(deleteBranchHint('none'), null)

  const choices = forceDeleteChoice('main')
  assert.equal(choices.length, 1)
  assert.equal(choices[0].op, 'deleteBranchForce')
  assert.deepEqual(choices[0].params, { branch: 'main' })
  assert.match(choices[0].confirm, /不可逆/, '不可逆的动作必须写在确认文案里')
  assert.match(choices[0].confirm, /reflog/, '也要说明「还能找回」的边界')
  assert.equal(forceDeleteChoice(null), null, '没有分支名就不给这条按钮')
})

test('classifyRenameFailure + renameHint：改名撞名时指向「推到上游」那条不用改名的路', () => {
  assert.equal(classifyRenameFailure("fatal: A branch named 'main' already exists."), 'exists')
  assert.equal(classifyRenameFailure("error: branch 'x' not found"), 'missing')
  assert.equal(classifyRenameFailure('fatal: nothing here'), 'none')
  const hint = renameHint('exists')
  assert.match(hint, /已经有同名/, '要说清撞名这个事实')
  assert.match(hint, /推送/, '要指向不用改名的替代路')
  assert.equal(renameHint('none'), null)
})

test('OPS.setUpstream：把本地分支的上游绑到指定远端分支，三个参数一个都不能漏校验', async () => {
  assert.deepEqual(
    await buildOpArgv('setUpstream', { local: 'fork-local.2', remote: 'fork', branch: 'local.2' }, process.cwd()),
    ['branch', '--set-upstream-to=fork/local.2', 'fork-local.2'],
  )
  await assert.rejects(
    () => buildOpArgv('setUpstream', { remote: 'fork', branch: 'local.2' }, process.cwd()),
    /本地分支/, '缺本地分支要当场拒绝，不能把 undefined 拼进命令',
  )
  await assert.rejects(
    () => buildOpArgv('setUpstream', { local: 'x', branch: 'local.2' }, process.cwd()),
    /远程/,
  )
  await assert.rejects(
    () => buildOpArgv('setUpstream', { local: 'x', remote: 'fork' }, process.cwd()),
    /远端分支/,
  )
  // 每一条都是要拼成 `--set-upstream-to=<remote>/<branch>` 的，所以三个位置都过白名单。
  await assert.rejects(
    () => buildOpArgv('setUpstream', { local: 'x', remote: 'fork', branch: '-x' }, process.cwd()),
    /不合法/,
  )
  await assert.rejects(
    () => buildOpArgv('setUpstream', { local: 'x', remote: 'fork', branch: 'a..b' }, process.cwd()),
    /不合法/,
  )
  await assert.rejects(
    () => buildOpArgv('setUpstream', { local: '--all', remote: 'fork', branch: 'x' }, process.cwd()),
    /不合法/, '本地分支名以 - 开头会被 git 当成选项',
  )
})

test('classifySetUpstreamFailure + setUpstreamHint：两种失败的下一步完全不同', () => {
  assert.equal(
    classifySetUpstreamFailure("error: the requested upstream branch 'origin/main' does not exist"),
    'remote-missing',
  )
  assert.equal(classifySetUpstreamFailure("error: branch 'feat-x' not found"), 'branch-missing')
  assert.equal(classifySetUpstreamFailure('fatal: not a valid object name'), 'not-a-branch')
  assert.equal(classifySetUpstreamFailure('fatal: 其它错误'), 'none')

  assert.match(setUpstreamHint('remote-missing'), /获取远程/, '远端引用没下载下来时要说清第一步是「获取远程」')
  assert.match(setUpstreamHint('branch-missing'), /过期|最新列表/, '本地分支没了要说清列表过期')
  assert.match(setUpstreamHint('not-a-branch'), /不是分支/)
  assert.equal(setUpstreamHint('none'), null)
})

test('branchNameRemoteConflict：新分支名撞远端名要被拦下（origin/main 这类）', () => {
  assert.equal(branchNameRemoteConflict('origin/main', ['origin', 'upstream']), 'origin')
  assert.equal(branchNameRemoteConflict('upstream/feat/x', ['origin', 'upstream']), 'upstream')
  assert.equal(branchNameRemoteConflict('main', ['origin']), null)
  assert.equal(branchNameRemoteConflict('origin-main', ['origin']), null, '横线不是命名空间分隔符')
  assert.equal(branchNameRemoteConflict('feature/origin', ['origin']), null, '前缀不是远端名')
  assert.equal(branchNameRemoteConflict('', ['origin']), null)
  assert.equal(branchNameRemoteConflict('origin/main', []), null, '没有远端就不存在这个歧义')
  assert.equal(branchNameRemoteConflict('origin/main', undefined), null)
})

test('新操作的 argv：显式 refspec，不依赖用户的 push.default 配置', async () => {
  assert.deepEqual(
    await buildOpArgv('pushUpstream', { remote: 'origin', branch: 'main' }, process.cwd()),
    ['push', 'origin', 'HEAD:main'],
  )
  assert.deepEqual(
    await buildOpArgv('pushSameName', { remote: 'origin' }, process.cwd()),
    ['push', '--set-upstream', 'origin', 'HEAD'],
  )
  assert.deepEqual(
    await buildOpArgv('deleteBranchForce', { branch: 'main' }, process.cwd()),
    ['branch', '-D', 'main'],
  )
  // 参数不合法要当场拒绝（refspec 是拼出来的，不能让 -x、空格这类东西混进去）
  await assert.rejects(() => buildOpArgv('pushUpstream', { remote: 'origin', branch: '-x' }, process.cwd()))
  await assert.rejects(() => buildOpArgv('pushUpstream', { remote: 'origin' }, process.cwd()))
  await assert.rejects(() => buildOpArgv('pushSameName', {}, process.cwd()))
})

// ── 推到指定的那个远程（本次需求：多远程下「我想推 fork」） ───────────────────
//
// 真实现场（git-sidebar.log）：origin = 别人的仓库（只能读）、fork = 自己的仓库，
// 点「推送」只回一句 `remote: Permission to … denied to …`，而面板连「换一个远程推」
// 这个入口都没有 —— 因为 argvPush 只认 mode，面板传进来的 remote 被丢掉了。

test('argvPush：给了远程就走显式 refspec，不给就还是裸 push（老行为）', () => {
  assert.deepEqual(argvPush({}), ['push'], '不选远程 = 跟随上游')
  assert.deepEqual(argvPush({ remote: 'fork' }), ['push', 'fork', 'HEAD'], '选了远程：推当前分支到同名远端分支')
  assert.deepEqual(argvPush({ remote: 'fork', branch: 'main' }), ['push', 'fork', 'main'])
  assert.deepEqual(argvPush({ remote: 'fork', setUpstream: true }), ['push', '--set-upstream', 'fork', 'HEAD'])
  // 只给 setUpstream（模型工具的老用法，没有 remote）也要照旧带上 -u，不能悄悄丢掉
  assert.deepEqual(argvPush({ setUpstream: true }), ['push', '--set-upstream'])
  assert.deepEqual(argvPush({ remote: 'fork', force: true }), ['push', '--force', 'fork', 'HEAD'])
  assert.deepEqual(argvPush({ branch: 'main' }), ['push', 'main'], '只给分支的老形状照旧')
  // 兼容历史的 mode='upstream'（当时远程写死 origin，现在也接受显式 remote）
  assert.deepEqual(argvPush({ mode: 'upstream' }), ['push', '--set-upstream', 'origin', 'HEAD'])
  assert.deepEqual(argvPush({ mode: 'upstream', remote: 'fork' }), ['push', '--set-upstream', 'fork', 'HEAD'])
  // 远程那个位置参数：`-` 开头会被 git 当选项、`proto::` 会让 git 去跑远程助手，
  // 其余 URL / 路径形状本来就是 git 的合法目标（用分支名的规则去套会把它们全拒掉）。
  assert.throws(() => argvPush({ remote: '-x' }), /远程名或地址不合法/)
  assert.throws(() => argvPush({ remote: 'ext::sh -c x' }), /远程名或地址不合法/)
  assert.throws(() => argvPush({ remote: 'my remote' }), /远程名或地址不合法/)
  assert.throws(() => argvPush({ remote: 'a\u0000b' }), /远程名或地址不合法/)
  assert.deepEqual(argvPush({ remote: 'https://github.com/u/r.git' }), ['push', 'https://github.com/u/r.git', 'HEAD'])
  assert.deepEqual(argvPush({ remote: 'git@github.com:u/r.git' }), ['push', 'git@github.com:u/r.git', 'HEAD'])
  assert.deepEqual(argvPush({ remote: 'D:\\repos\\r.git' }), ['push', 'D:\\repos\\r.git', 'HEAD'])
  assert.deepEqual(argvPush({ remote: '../other.git' }), ['push', '../other.git', 'HEAD'])
  // 分支那个位置参数是一个 ref：仍然按 ref 的规则拦（空格 / .. / : ）
  assert.throws(() => argvPush({ remote: 'fork', branch: '-x' }), /分支名不合法/)
  assert.throws(() => argvPush({ remote: 'fork', branch: 'a b' }), /分支名不合法/)
})

test('OPS.push：面板传的 remote 要真的转成 git 参数（此前被丢掉）', async () => {
  assert.deepEqual(
    await buildOpArgv('push', { remote: 'fork' }, process.cwd()),
    ['push', 'fork', 'HEAD'],
  )
  assert.deepEqual(await buildOpArgv('push', {}, process.cwd()), ['push'])
  await assert.rejects(() => buildOpArgv('push', { remote: '-x' }, process.cwd()))
  assert.equal(typeof OPS.push.note, 'function', '结果里要说清这次推到了哪个远程')
})

test('pushTargetNote：只在选了远程时才说明目标（裸 push 由 git 的配置决定，面板不替它说）', () => {
  assert.equal(pushTargetNote({}), null)
  assert.equal(pushTargetNote(null), null)
  const note = pushTargetNote({ remote: 'fork' })
  assert.match(note, /fork/)
  assert.match(note, /不动/, '要讲清「只换这一次的远程」，否则用户会以为动了配置')
  assert.match(String(pushTargetNote({ remote: 'fork', setUpstream: true })), /上游/)
})

// ── 从指定的那个远程拉（本次需求：多远程下「我要拿 origin 的更新」） ───────────
//
// 现场：分支跟踪 fork（自己的），更新在 origin（别人的上游）上。旧面板的「拉取」只有一个
// 按钮、来源由上游配置决定 —— 要拿上游的更新就得先把上游改绑过去、拉完再改回来。
// 下面几条钉住与推送对称的那套：argv 形状、参数校验、「这次是从你选的远程拉的」说明、
// 以及「远端没有这条分支」时那条**不自动执行**的明路。

test('argvPull：给了远程就是显式来源，不给就还是裸 pull（老行为）', () => {
  assert.deepEqual(argvPull({}), ['pull'], '不选远程 = 跟随上游')
  assert.deepEqual(argvPull({ rebase: true }), ['pull', '--rebase'])
  assert.deepEqual(argvPull({ remote: 'origin' }), ['pull', 'origin'], '只给远程：分支由调用方补')
  assert.deepEqual(argvPull({ remote: 'origin', branch: 'main' }), ['pull', 'origin', 'main'])
  assert.deepEqual(argvPull({ rebase: true, remote: 'origin', branch: 'main' }),
    ['pull', '--rebase', 'origin', 'main'], '选项要在位置参数之前')
  // 只给分支是**错的形状**：git 会把分支名当成仓库地址或路径（`git pull main`），
  // 报一句和意图完全无关的错。这个形状此前会被静默拼出来，现在在入口就拦下。
  assert.throws(() => argvPull({ branch: 'main' }), /只给分支名会被 git 当成仓库地址/)
  assert.deepEqual(argvPull({ remote: 'origin', branch: 'feature/x' }), ['pull', 'origin', 'feature/x'])
  // 两个位置参数各按各的白名单（与 push 同一套）：远程可以是 URL / 路径 / scp，
  // 但 `-` 开头与 `proto::` 会被 git 当选项或远程助手；分支必须是一个 ref。
  assert.deepEqual(argvPull({ remote: 'https://github.com/u/r.git', branch: 'main' }),
    ['pull', 'https://github.com/u/r.git', 'main'])
  assert.deepEqual(argvPull({ remote: 'git@github.com:u/r.git' }), ['pull', 'git@github.com:u/r.git'])
  assert.throws(() => argvPull({ remote: '-x' }), /远程名或地址不合法/)
  assert.throws(() => argvPull({ remote: 'ext::sh -c x' }), /远程名或地址不合法/)
  assert.throws(() => argvPull({ remote: 'origin', branch: '-x' }), /分支名不合法/)
  assert.throws(() => argvPull({ remote: 'origin', branch: 'a b' }), /分支名不合法/)
  assert.throws(() => argvPull({ remote: 'origin', branch: 'a..b' }), /分支名不合法/)
})

test('OPS.pull：面板传的 remote 要真的转成 git 参数，并补上当前分支名', async () => {
  // 「拉取自 X」只给了远程：宿主按**当前分支名**补一条（同名分支是最不意外的目标），
  // 否则 `git pull <远程>` 会退化成「按该远程的 merge 配置拉」，而这里的前提恰恰是
  // 当前分支的上游不是它 —— 那条路走不通，git 只会报一句不相干的错。
  assert.deepEqual(
    await buildOpArgv('pull', { remote: 'origin' }, process.cwd()),
    ['pull', 'origin', await currentBranchName(process.cwd(), GIT_LOCAL_TIMEOUT_MS)],
  )
  assert.deepEqual(await buildOpArgv('pull', {}, process.cwd()), ['pull'])
  assert.deepEqual(await buildOpArgv('pull', { rebase: true, remote: 'origin', branch: 'main' }, process.cwd()),
    ['pull', '--rebase', 'origin', 'main'])
  // 显式给了分支就用它，不去读仓库（argv 构造器在不给 branch 时也不该凭空发明一个名字）。
  assert.deepEqual(await buildOpArgv('pull', { remote: 'origin', branch: 'trunk' }, process.cwd()),
    ['pull', 'origin', 'trunk'])
  await assert.rejects(() => buildOpArgv('pull', { branch: 'main' }, process.cwd()))
  await assert.rejects(() => buildOpArgv('pull', { remote: '-x' }, process.cwd()))
})

test('pullTargetFromArgv：从真正执行的命令行里读回「这次是从哪儿拉的」', () => {
  // 加速参数（-c …）在子命令之前，不能被误读成远程；裸 pull 读不出目标（返回 null）。
  assert.deepEqual(pullTargetFromArgv(['pull', 'origin', 'main']), { remote: 'origin', branch: 'main' })
  assert.deepEqual(
    pullTargetFromArgv(['-c', 'http.proxy=http://127.0.0.1:7890', 'pull', 'upstream']),
    { remote: 'upstream', branch: null },
  )
  // 镜像下 url.<镜像>.insteadOf 的值里可能带 "pull" 字样的子串：按整词找，不受影响。
  assert.deepEqual(
    pullTargetFromArgv(['-c', 'url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/', 'pull', 'origin', 'main']),
    { remote: 'origin', branch: 'main' },
  )
  assert.deepEqual(pullTargetFromArgv(['pull', '--rebase', 'origin', 'main']),
    { remote: 'origin', branch: 'main' }, '选项参数要被跳过')
  assert.equal(pullTargetFromArgv(['pull']), null, '裸 pull 读不出目标')
  assert.equal(pullTargetFromArgv([]), null)
  assert.equal(pullTargetFromArgv(null), null)
})

test('pullFromNote：只在选了远程时才说明来源（裸 pull 由 git 的配置决定）', () => {
  assert.equal(pullFromNote(null), null)
  assert.equal(pullFromNote({}), null)
  const note = pullFromNote({ remote: 'origin', branch: 'main' })
  assert.match(note, /origin\/main/)
  assert.match(note, /没动/, '要讲清「上游跟踪关系一个字节没动」，否则用户会以为改了配置')
  assert.match(String(pullFromNote({ remote: 'upstream' })), /upstream/,
    '拿不到分支名时也要说清是哪个远程')
})

test('pullChoices：无关历史 / 冲突 / 「远端没有这条分支」三条路各自给对', () => {
  // 两套历史互不相关 → 两条路（拿成新分支 / 覆盖当前分支），指向**这次真正拉的那个**远程。
  const unrelated = pullChoices({ reason: 'unrelated', remote: 'origin', branch: 'main' })
  assert.equal(unrelated.length, 2)
  assert.deepEqual(unrelated[0].params, { mode: 'branch', remote: 'origin', branch: 'main' })
  // 冲突 → 只给「撤销这次合并」（面板不替用户决定留哪边）。
  const conflict = pullChoices({ reason: 'conflict' })
  assert.equal(conflict.length, 1)
  assert.equal(conflict[0].op, 'abortMerge')
  assert.equal(pullChoices({ reason: 'merge-unfinished' })[0].op, 'abortMerge')
  // 远端没有这条分支、但它有默认分支 → 一条**要用户点**的路（绝不自动把另一条线并进来）。
  const fallback = pullChoices({
    reason: 'remote-branch-missing',
    remote: 'origin',
    branch: 'local-only',
    pullFromDefault: { remote: 'origin', branch: 'master' },
  })
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].op, 'pull')
  assert.deepEqual(fallback[0].params, { remote: 'origin', branch: 'master' })
  assert.match(fallback[0].label, /origin\/master/)
  assert.equal(fallback[0].confirm, null, '从另一个分支拉不是破坏性动作，不该每点一次都弹确认')
  // 与 pullChoices 走的是同一个构造器（面板按钮与宿主的 choices 不会各写一套文案）。
  assert.deepEqual(
    pullFromDefaultChoice('origin', 'master'),
    fallback[0],
    'pullChoices 里那条路必须就是 pullFromDefaultChoice 造的',
  )
  // 没有默认分支可指 / 别的失败原因 → 不给按钮（宁缺勿猜）。
  assert.equal(pullChoices({ reason: 'remote-branch-missing', pullFromDefault: null }), null)
  assert.equal(pullChoices({ reason: 'auth-http' }), null)
  assert.equal(pullChoices(null), null)
})

test('classifyPushFailure：没有写权限要单独成一类（本次现场：origin 只读）', () => {
  // 原样取自 git-sidebar.log —— GitHub 在「你是登录用户、但这个仓库不给你写」时的说法。
  const github = 'remote: Permission to MichengAI/dsh-skills-manager.git denied to wangyuncai2024.'
    + "\nfatal: unable to access 'https://github.com/MichengAI/dsh-skills-manager.git/': The requested URL returned error: 403"
  assert.equal(classifyPushFailure(github), 'no-permission')
  assert.equal(
    classifyPushFailure('remote: You are not allowed to push code to this project.'),
    'no-permission',
  )
  assert.equal(classifyPushFailure('remote: You do not have write access.'), 'no-permission')
  // 授权失败排在 rejected 之前：pre-receive 拒绝同样带 `failed to push some refs`。
  assert.equal(
    classifyPushFailure('remote: Permission to o/r.git denied to u.\n'
      + ' ! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs to \'x\''),
    'no-permission',
  )
  // 不能误伤：SSH 公钥被拒是「认证」，不是「授权」；也不是 rejected / none。
  assert.equal(classifyPushFailure('git@github.com: Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyPushFailure('remote: Repository not found.'), 'remote-not-found')
})

test('classifyPushFailure：分支受保护不能报成「你没有写权限」（账号明明有写权限）', () => {
  // GitHub 受保护分支的原话（账号有写权限，只是这条引用不许直接更新）。
  const protectedGithub = 'remote: error: GH006: Protected branch update failed for refs/heads/main.\n'
    + 'remote: error: Changes must be made through a pull request.\n'
    + ' ! [remote rejected] main -> main (protected branch hook declined)\n'
    + "error: failed to push some refs to 'github.com:org/repo.git'"
  assert.equal(classifyPushFailure(protectedGithub), 'branch-protected')
  // GitLab 那句同时含 `not allowed to push code`（无权限那条的模式）——必须仍然认成受保护。
  assert.equal(
    classifyPushFailure('remote: You are not allowed to push code to protected branches on this project.'),
    'branch-protected',
  )
  // GitHub ruleset（GH013）同属「规则不让推」，也不是权限问题。
  assert.equal(
    classifyPushFailure('remote: error: GH013: Repository rule violations found for refs/heads/main.'),
    'branch-protected',
  )
  // 提示必须说实话：讲「受保护 + 走 PR / 请维护者放开」，不能说你没有写权限。
  const hint = String(pushHint('branch-protected'))
  assert.match(hint, /保护/)
  assert.match(hint, /Pull Request|Merge Request/, '要指出开 PR 这条路')
  assert.match(hint, /维护者/)
  assert.doesNotMatch(hint, /没有写权限/, '不能把保护规则说成权限问题')
})

test('pushHint：没有写权限时指向「换一个远程推」，而不是让用户反复重试', () => {
  const hint = String(pushHint('no-permission'))
  assert.match(hint, /写权限/)
  assert.match(hint, /推送到|远程/, '要指向那个能改的入口')
  assert.doesNotMatch(hint, /检查仓库地址/, '地址是对的，别把用户引去改地址')
  assert.equal(pushHint('none'), null)
})

test('isSafePushTarget：接受 URL / 路径，只拦会被当成选项或远程助手的形状', () => {
  for (const value of ['origin', 'fork', 'https://github.com/u/r.git', 'git@github.com:u/r.git',
    '../other.git', '/srv/x.git', 'D:\\repos\\r.git', 'file:///tmp/r.git']) {
    assert.equal(isSafePushTarget(value), true, value + ' 是 git 的合法目标')
  }
  for (const value of ['-x', '--upload-pack=x', 'ext::sh -c x', 'a::b', 'my remote', 'a\u0000b',
    '', '   ', null, undefined]) {
    assert.equal(isSafePushTarget(value), false, JSON.stringify(value) + ' 不该放行')
  }
})

test('otherRemoteChoices：只给「别的远程」，刚失败的那个不再出现', () => {
  const choices = otherRemoteChoices({ names: ['fork', 'origin'], attempted: 'origin', local: 'local.2' })
  assert.equal(choices.length, 1, '只该给 fork 一条路：' + JSON.stringify(choices))
  assert.equal(choices[0].op, 'push')
  assert.deepEqual(choices[0].params, { remote: 'fork' })
  assert.match(choices[0].label, /fork/)
  assert.match(choices[0].detail, /local\.2/, '把当前分支说清楚')
  assert.equal(choices[0].confirm, null, '推一次不需要二次确认')
  // 文案对「没有写权限」与「分支受保护」两种原因都要成立：不能写死「你没有权限」
  // （受保护分支时账号是有写权限的，诊断由各自的 hint 负责）。
  assert.doesNotMatch(choices[0].detail, /没有写权限|不在你的账号上/)

  // 只有一个远程（就是刚失败的那个）：没有可给的路 → null（此时提示负责指路去加远程）
  assert.equal(otherRemoteChoices({ names: ['origin'], attempted: 'origin', local: 'main' }), null)
  assert.equal(otherRemoteChoices(null), null)
  assert.equal(otherRemoteChoices({ names: [], attempted: null, local: null }), null)
  // 没认出 attempted 时不能把远程全列成候选里的空壳
  assert.deepEqual(
    otherRemoteChoices({ names: ['a', 'b'], attempted: null, local: null }).map((item) => item.params.remote),
    ['a', 'b'],
  )
})

test('OPS 注册表：删分支的两条路都在，且 classify/hint 都挂上了', () => {
  for (const op of ['deleteBranch', 'deleteBranchForce']) {
    assert.equal(typeof OPS[op].classify, 'function', op + ' 要挂失败分类')
    assert.equal(typeof OPS[op].hint, 'function', op + ' 要挂中文提示')
  }
  assert.equal(typeof OPS.renameBranch.classify, 'function')
  assert.equal(typeof OPS.createBranch.argv, 'function')
  assert.equal(OPS.pushUpstream.network, true, '替代推送路也是联网操作（要走同一条加速线路）')
  assert.equal(OPS.pushSameName.network, true)
})

// ── 两个远程指向同一地址（本次现场：remote `main` 与 `origin` 同 URL） ──────
//
// 冗余不只是难看：远程名会和本地分支名撞在一起 —— `git log main` /
// `git branch -D main` 从此报 `warning: refname 'main' is ambiguous`。

test('duplicateRemotes：同地址的远程成组，保留 origin', () => {
  assert.deepEqual(duplicateRemotes([]), [])
  assert.deepEqual(duplicateRemotes(null), [])
  assert.deepEqual(duplicateRemotes([{ name: 'origin', url: 'git@x:y.git' }]), [], '只有一个远程不算重复')
  assert.deepEqual(
    duplicateRemotes([
      { name: 'main', url: 'https://github.com/u/r.git' },
      { name: 'origin', url: 'https://github.com/u/r.git' },
    ]),
    [{ url: 'https://github.com/u/r.git', keep: 'origin', remove: ['main'] }],
    '有 origin 就保留 origin（git clone 的默认名），其余算可删',
  )
  // 没有 origin：保留传进来的第一个（parseRemotes 已按名字排好序，因此顺序是稳定的）
  assert.deepEqual(
    duplicateRemotes([{ name: 'a', url: 'u' }, { name: 'b', url: 'u' }]),
    [{ url: 'u', keep: 'a', remove: ['b'] }],
  )
  // 三个同地址：其余两个都要出现在 remove 里
  assert.deepEqual(
    duplicateRemotes([
      { name: 'origin', url: 'u' }, { name: 'dup1', url: 'u' }, { name: 'dup2', url: 'u' },
    ])[0].remove,
    ['dup1', 'dup2'],
  )
  // 地址不同不算重复；缺字段 / 非对象条目一律跳过（状态可能来自老宿主）
  assert.deepEqual(duplicateRemotes([{ name: 'a', url: 'u1' }, { name: 'b', url: 'u2' }]), [])
  assert.deepEqual(duplicateRemotes([{ name: 'a', url: '' }, { name: 'b' }, null, undefined]), [])
  // 首尾空白不该造成「看起来一样却被判成两个地址」
  assert.equal(
    duplicateRemotes([{ name: 'a', url: ' u ' }, { name: 'b', url: 'u' }]).length,
    1,
  )
})

test('removeRemote 的 argv：只删本地配置的那条命令', async () => {
  assert.deepEqual(
    await buildOpArgv('removeRemote', { name: 'main' }, process.cwd()),
    ['remote', 'remove', 'main'],
  )
  await assert.rejects(() => buildOpArgv('removeRemote', {}, process.cwd()), /远程名/)
  assert.equal(OPS.removeRemote.network, undefined, '删远程不发网络请求')
})