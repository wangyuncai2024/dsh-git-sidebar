// dsh-git-sidebar —— 失败分类与「下一步点哪里」
// ============================================================================
// 全是纯文本函数：把 git 的英文报错归一化成原因，再翻译成可操作的中文提示。
// 分类必须区分「服务器答复了」（404/403，链路是通的）和「连不上」——
// 归错会把用户引到完全错误的排查方向。
// ============================================================================

/**
 * 判断一次失败是不是「网络连不上」这一类。
 *
 * 关键是和「服务器答复了」区分开：`The requested URL returned error: 404` 说明链路
 * 是通的，报的是仓库不存在 —— 归成网络问题会把用户引到完全错误的排查方向。
 */
function classifyNetworkFailure(text) {
  const value = String(text ?? '')
  if (value.length === 0) return null
  if (/The requested URL returned error: \d{3}/i.test(value)) return null
  if (/Recv failure|Send failure|Connection was reset|connection reset|Could not connect|Failed to connect|Connection timed out|Operation timed out|Empty reply from server|Connection refused|gnutls_handshake|SSL_ERROR|TLS handshake|unable to access|Proxy CONNECT aborted|命令超时/i.test(value)) {
    return 'network'
  }
  return null
}

/**
 * 这次失败该不该算在镜像头上（= 要不要回退直连、要不要提「镜像没走通」）。
 *
 * 判据只取「可能是镜像线路造成的」两类特征：
 *   1. 网络类故障（连不上 / 连接被重置 / 超时 / TLS 握手失败 …）；
 *   2. 服务器回了 HTTP 状态码（404/403/5xx —— 镜像没缓存、私有仓库它看不到，直连可能通）。
 *
 * 本地配置类错误（没有上游、没有远程、无关历史、冲突、SSH 认证失败）两个特征都没有，
 * 因此不会被误判成镜像故障。早先只要命令失败就回退并写下「镜像没走通」，结果是用户
 * 被引去折腾网络加速，而真正的原因在本地 —— 排查方向被彻底带偏。
 *
 * 注：classifyNetworkFailure 故意把 `The requested URL returned error: 404` 排除在
 * 「网络问题」之外（服务器答复了就不算连不上），所以状态码这一类在这里单独补上。
 */
function mirrorFallbackWorthwhile(stderr) {
  const value = String(stderr ?? '')
  if (value.length === 0) return false
  if (classifyNetworkFailure(value) !== null) return true
  return /The requested URL returned error: \d{3}/i.test(value)
}

/** 网络失败时给面板的「下一步点哪里」（区分「已经开过加速还是不通」）。 */
function networkHint(accelerated) {
  if (accelerated === true) {
    return '还是连不上。镜像对私有仓库、刚建的空仓库常常不可用，换一个镜像再试；'
      + '要推送或访问私有仓库，请改填本机代理（如 http://127.0.0.1:7890）。'
  }
  return '连不上远端（连接被重置 / 超时），国内直连 github.com 很常见。'
    // 注意：这里**不能**写「右上角的 🌐」—— 网络加速已搬进「设置」表面（面板头部
    // 那个 🌐 按钮没有了），照着旧文案去找会找不到。失败提示条本身带「去设置」
    // 直达入口，文案指向它即可。
    + '点上面提示条里的「去设置」打开「网络加速」：公开仓库用镜像，私有仓库或要推送就填本机代理。'
}

/**
 * HTTPS 认证失败的样子（SSH 证书失败是另一套，见 auth-failed）。
 *
 * GitHub 已经不支持密码推送，`Authentication failed` 基本都意味着
 * 「需要 Personal Access Token / 凭据管理器」；`could not read Username`
 * 是 git 在非交互环境拿不到凭据（terminal prompts disabled 是它的后半句）。
 * 这类报错在 push 和 pull 两侧都出现，所以两条分类共用这一个模式。
 */
const HTTP_AUTH_PATTERN = /Authentication failed|could not read Username|terminal prompts disabled|HTTP \d{3}.*(?:Unauthorized|Forbidden)|invalid username or password|access denied|401/i

/**
 * 「本地分支名」与「它跟踪的远端分支名」对不上的原文。
 *
 * 触发条件是 git 的默认配置 `push.default=simple`：只在两边**同名**时才肯裸推。
 * 本地 `origin-main` 跟踪 `origin/main` 这种形态（改名、拉别人的分支、手工配上游
 * 都会造出来）就会撞上它，而报错原文里没有任何中文线索，用户完全不知道下一步
 * 该做什么 —— 这是本次要修的核心现场。
 *
 * 注意这条必须排在 `rejected` 之前：原文里没有 `failed to push some refs`，
 * 但它同样是「配置/命名」类失败，不能被后面的分支误吞。
 */
const UPSTREAM_NAME_MISMATCH_PATTERN = /does not match\s+the name of your current branch|upstream branch of your current branch does not match|push\.default/i

/**
 * 「服务器明确说：你没有这个仓库的写权限」的原文（**授权**失败，不是认证失败）。
 *
 * 这几个模式都是服务器**答复**回来的，因此与链路问题无关；它们此前全部落进 `none`，
 * 用户只看到一行英文。现场（本次真踩到）：
 *
 *   remote: Permission to MichengAI/dsh-skills-manager.git denied to wangyuncai2024.
 *   fatal: unable to access 'https://github.com/MichengAI/dsh-skills-manager.git/': ...
 *
 * —— `Permission to … denied to …` 是 GitHub 在「你是登录用户、但这个仓库不给你写」时的
 * 说法（不是 SSH 公钥被拒，那是 `Permission denied (publickey)`）。GitLab 的说法是
 * `You are not allowed to push code to this project`；Bitbucket 是
 * `You do not have write access`。
 *
 * **受保护分支不在这里**：那些报错（GH006 / protected branch）说的是「这个**引用**不允许
 * 直接更新」，与账号有没有写权限是两件事，混进这一类的后果是给用户一句错误的诊断
 * （见 PROTECTED_BRANCH_PATTERN）。
 *
 * 这类失败**不能自动重试**（换任何参数都一样），但它是可解的：多远程下换一个远程推
 * 就行（官方仓库只读 + 自己的 fork 可写，正是最常见的形态）。
 */
const NO_PERMISSION_PATTERN = /Permission to .* denied to|not allowed to push code|You do not have write access/i

/**
 * 「这个分支/引用受保护，谁都不能直接推」的原文。
 *
 * 与「没有写权限」必须分开：这里账号**有**写权限，只是规则不允许直接更新这条引用。
 * GitHub 受保护分支的原文：
 *
 *   remote: error: GH006: Protected branch update failed for refs/heads/main.
 *   remote: error: Changes must be made through a pull request.
 *    ! [remote rejected] main -> main (protected branch hook declined)
 *
 * GitLab 是 `You are not allowed to push code to protected branches on this project.`，
 * GitHub 的 ruleset（GH013 / Repository rule violations）同属这一类。
 *
 * 顺序上必须排在 NO_PERMISSION_PATTERN **之前**：GitLab 那句同时含
 * `not allowed to push code`（会被无权限那条误认），而两边的下一步完全不同。
 */
const PROTECTED_BRANCH_PATTERN = /protected branch|protected branches|GH006|GH013|repository rule violations|Changes must be made through a pull request/i

/**
 * 探测一次 push 为什么失败：没有远程、没有上游、远程不存在、认证被拒、非快进。
 * 面板与模型工具都用它把 git 的原始 stderr 翻译成下一步该做什么。
 * @returns 归一化原因；`none` 表示不是已知的推送类故障。
 */
function classifyPushFailure(stderr) {
  const text = String(stderr ?? '')
  if (/has no upstream branch|没有上游分支/i.test(text)) return 'no-upstream'
  if (UPSTREAM_NAME_MISMATCH_PATTERN.test(text)) return 'upstream-name-mismatch'
  if (/does not appear to be a git repository|无法读取远程仓库|Repository not found/i.test(text)) return 'remote-not-found'
  // 引用受保护排在「没有写权限」之前：GitLab 那句两边都命中，而它们的下一步不同。
  if (PROTECTED_BRANCH_PATTERN.test(text)) return 'branch-protected'
  // 授权（没有写权限）必须排在 auth 之前：两者都是「服务器不让」，但下一步完全不同 ——
  // 认证失败要换凭据，授权失败换凭据也没用，得换目标仓库或换远程。
  if (NO_PERMISSION_PATTERN.test(text)) return 'no-permission'
  if (/Permission denied \(publickey\)|Could not read from remote repository/i.test(text)) return 'auth-failed'
  if (HTTP_AUTH_PATTERN.test(text)) return 'auth-http'
  if (/failed to push some refs|non-fast-forward|\[rejected\]|fetch first/i.test(text)) return 'rejected'
  if (/no configured push destination|没有配置推送目标/i.test(text)) return 'no-remote'
  return 'none'
}

/** 把探测到的失败原因翻译成可操作的中文提示。 */
function pushHint(reason) {
  if (reason === 'no-remote') {
    return '这个仓库还没有配置远程地址：填入仓库地址后点「保存并推送」即可。'
  }
  if (reason === 'no-upstream') {
    return '当前分支还没有上游分支：点一次「推送」即可自动建立跟踪（git push -u）。'
  }
  if (reason === 'upstream-name-mismatch') {
    return '本地分支名和它跟踪的远端分支名不一样，git 因此拒绝执行裸 push'
      + '（默认配置 push.default=simple 只在两边同名时才推）。下面有几个选项，选一个就行，不用敲命令。'
  }
  if (reason === 'branch-protected') {
    // 说清「不是你的权限问题」：账号有写权限，是这条引用的规则不允许直接更新。
    // 出路是「推到自己的远程 → 开 PR」或「请维护者放开规则」，两条都要讲。
    return '服务器拒绝这次推送：这个分支受保护（GitHub 的 GH006 / GitLab 的 protected branch），'
      + '就算你对这个远程有写权限，也不能直接更新它。两条常见的路：'
      + '① 把提交推到你自己的远程（例如 fork），再在仓库网页上开 Pull Request / Merge Request 让维护者合并；'
      + '② 请维护者放开这条保护规则，或把这条分支/你的账号加进允许直接推送的名单。'
      + '面板不会替你改动远端的保护设置。'
  }
  if (reason === 'no-permission') {
    // 这条的下一步不是「检查地址」也不是「换凭据」——地址是对的、凭据也是对的，
    // 只是这个仓库不给你的账号写。可解的那条路是**换一个你有权限的远程**：
    // 常见的形态是 origin 指向别人的仓库（只读）+ fork 指向你自己的那份（可写）。
    return '服务器拒绝写入：你的账号对这个远程没有写权限（别人的仓库通常只能拉、不能推）。'
      + '如果你的账号下已经有一份（fork），用「+ 添加远程」把它配成一个新远程（例如 fork），'
      + '再在「推送到」里选中它推 —— 面板只换这一次的远程，不改你的任何 git 配置；'
      + '还没有的话，先去服务器上 fork / 新建一个仓库，再把地址加进来。'
  }
  if (reason === 'remote-not-found') {
    return '远程仓库不存在或没有访问权限：检查仓库地址是否写对，以及是否已在 GitHub 上创建该仓库。'
  }
  if (reason === 'auth-failed') {
    return 'SSH 认证失败：确认这台机器的公钥已加到 GitHub 账号，或把远程地址换成 HTTPS。'
  }
  if (reason === 'auth-http') {
    return 'HTTPS 认证没通过：GitHub 已不支持账号密码，需要 Personal Access Token（Settings → Developer settings → Tokens）。'
      + '先在终端执行 git config --global credential.helper store，再点一次「推送」，按提示输入用户名和令牌。'
  }
  if (reason === 'rejected') {
    // 顺序要写全：先「获取远程」再「拉取」——只写「先拉取」时，没有上游的分支
    // 会当场再撞一次墙，用户就卡在两条提示互相指的死循环里。
    return '推送被拒绝（远端有你本地没有的提交）：先点「获取远程」，再点「拉取」，合并后重新推送。'
  }
  return null
}

/**
 * 探测一次 pull 为什么失败。
 *
 * 与 push 分开是必要的：拉取的报错文本是另一套，而最常见的那条
 * （`There is no tracking information for the current branch`）在 push 的分类里
 * 认不出来，于是面板只能把英文原文甩给用户 —— 这正是「想拉取却卡住」的现场。
 * @returns 归一化原因；`none` 表示不是已知的拉取类故障。
 */
function classifyPullFailure(text) {
  const value = String(text ?? '')
  if (/has no tracking information|no tracking information|没有跟踪信息/i.test(value)) return 'no-upstream'
  if (/No remote repository specified|no configured push destination|没有配置推送目标/i.test(value)) return 'no-remote'
  if (HTTP_AUTH_PATTERN.test(value)) return 'auth-http'
  if (/couldn't find remote ref|Could not find remote branch|Remote branch .* not found|找不到远程引用/i.test(value)) return 'remote-branch-missing'
  // 「仓库卡在某个中间状态」这一类：命令没错、网络也没错，只是上一次合并没收尾。
  // 三种真实文案都要认：git 在不同阶段给的是不同句子（实测都出现过）：
  //   - `Pulling is not possible because you have unmerged files.`（冲突还没解决）
  //   - `error: You have not concluded your merge (MERGE_HEAD exists).`
  //   - `fatal: Exiting because of an unresolved conflict.`
  // 必须排在 conflict 之前：这些句子里也带 conflict/merge 字样。
  if (/unmerged files|unresolved conflict|You have not concluded your merge|MERGE_HEAD exists|unfinished merge|尚未结束的合并/i.test(value)) return 'merge-unfinished'
  if (/Your local changes to the following files would be overwritten|commit your changes or stash them before you merge/i.test(value)) return 'dirty-worktree'
  if (/refusing to merge unrelated histories|unrelated histories/i.test(value)) return 'unrelated'
  if (/CONFLICT|Automatic merge failed|fix conflicts|冲突/i.test(value)) return 'conflict'
  return 'none'
}

/**
 * pull 的报错**分散在两个流上**，分类必须看两边。
 *
 * 实测（见 test 里的真实文案）：
 *   - 合并冲突整段在 **stdout**：`Auto-merging … / CONFLICT (content): … / Automatic merge failed…`
 *   - 网络类故障在 stderr。
 * 早先只喂 stderr，于是最常见的"拉取撞上冲突"被判成「未知错误」，面板一个提示都没有 ——
 * 恰恰是最需要提示的那一种。
 */
function pullFailureText(result) {
  const value = result !== null && result !== undefined ? result : {}
  return String(value.stderr ?? '') + '\n' + String(value.stdout ?? '')
}

/** 把探测到的拉取失败原因翻译成可操作的中文提示（每条都要说清下一步点哪里）。 */
function pullHint(reason) {
  if (reason === 'no-remote') {
    return '这个仓库还没有配置远程地址：在「远程」里填入地址并保存，再点「拉取」。'
  }
  if (reason === 'auth-http') {
    return 'HTTPS 认证没通过：仓库需要访问令牌（GitHub 的 Settings → Developer settings → Tokens 里生成）。'
      + '先在终端执行 git config --global credential.helper store，再点一次「拉取」，按提示输入用户名和令牌。'
  }
  if (reason === 'no-upstream') {
    return '当前分支既没有上游、也推不出该拉远程哪个分支（例如处于游离 HEAD）：先在「管理」里切到一个分支，再点「拉取」。'
  }
  if (reason === 'remote-branch-missing') {
    // 措辞不能再是「先点一次推送把它推上去」：远端往往**有**分支，只是名字不一样
    // （本地 master、远端 main）。照老话去推送，只会在 GitHub 上多出一个 master。
    return '远端没有和当前分支同名的分支，也没有对得上的默认分支：先点「获取远程」，再展开「管理」'
      + '看看远端有哪些分支（在那里可以把远端那份一键拿成新分支）；或者确实想推本地这一份时再点「推送」。'
  }
  if (reason === 'merge-unfinished') {
    return '上一次拉取留下的合并还没结束（工作区里有未合并的文件），git 因此拒绝再拉一次：'
      + '要么在终端里把冲突文件改好 → git add 那个文件 → git commit 收尾；'
      + '要么执行 git merge --abort 撤销这次合并，直接回到拉取之前的样子（撤销是安全的，不会动你已有的提交）。'
  }
  if (reason === 'dirty-worktree') {
    return '工作区里有未提交的改动，会被这次合并覆盖，所以 git 先拒绝了：'
      + '先「全部暂存」并写提交信息提交（不想要的改动则点「丢弃改动」），再点「拉取」。'
  }
  if (reason === 'unrelated') {
    // 这条提示下面是两个真正的按钮（见 unrelatedChoices），所以绝不能再写「请去终端处理」——
    // 那等于把已经替用户铺好的路又收回去了。
    return '本地和远端是两套互不相关的历史，git 不会替你合并：在下面的选项里选一个结果就行，不用敲命令。'
  }
  if (reason === 'conflict') {
    return '合并出现冲突：面板不替你决定要哪边。改好冲突文件后 git add + git commit 收尾；'
      + '不想合了执行 git merge --abort，回到拉取之前的样子。'
  }
  return null
}

// ── commit 单独一个分类器 ──────────────────────────────────────────────────
//
// 例：面板「提交」失败可不是 git 的 push/pull 那几类 —— 最常见的两条是
// 「git 不知道你是谁」（新机器第一次提交，git 拒绝猜身份）和
// 「没有可提交的东西」（工作区其实是干净的）。把它塞进 push 的分类表里
// 只会得到 none，用户看到的就是一句英文原文。

/**
 * 探测一次 commit 为什么失败：身份没配置 / 没有可提交的改动。
 * @returns 归一化原因；`none` 表示不是已知的提交类故障。
 */
function classifyCommitFailure(stderr) {
  const text = String(stderr ?? '')
  if (/Please tell me who you are|unable to auto-detect email address|Author identity unknown|Committer identity unknown/i.test(text)) return 'identity-missing'
  if (/nothing to commit|无文件要提交|没有要提交的内容|无内容可提交|干净的工作区/i.test(text)) return 'nothing-to-commit'
  return 'none'
}

/** commit 失败时给面板的中文下一步（身份问题给出确切的两条命令）。 */
function commitHint(reason) {
  if (reason === 'identity-missing') {
    return 'git 还不知道你是谁（第一次提交必须设置）：在终端执行 '
      + 'git config --global user.name "你的名字" 和 git config --global user.email "you@example.com"，然后重新点「提交」。'
  }
  if (reason === 'nothing-to-commit') {
    return '没有需要提交的改动（工作区是干净的）：先做点改动，或点「全部暂存」后在改动清单里确认。'
  }
  return null
}

// ── checkout 单独一个分类器 ────────────────────────────────────────────────

/**
 * 探测一次 switch / checkout 为什么失败。
 *
 * 最常见的是「脏工作区被拒」（`Your local changes would be overwritten` —— 面板
 * 的「安全切分支」就是为它准备的）和「分支不存在」。其余失败（游离 HEAD、
 * 未知选项）不属于这两类，返回 none。
 * @returns 归一化原因；`none` 表示不是已知的切换类故障。
 */
function classifyCheckoutFailure(stderr) {
  const text = String(stderr ?? '')
  if (/Your local changes to the following files would be overwritten|local changes would be overwritten|untracked working tree files would be overwritten|The following untracked working tree files would be overwritten|会被以下检出操作覆盖/i.test(text)) return 'dirty-worktree'
  if (/invalid reference|did not match any file|no such branch|Not a valid object name|Unknown branch|找不到分支/i.test(text)) return 'branch-missing'
  return 'none'
}

/** checkout 失败时给面板的中文下一步。 */
function checkoutHint(reason) {
  if (reason === 'dirty-worktree') {
    return '工作区还有未提交的改动，切换会被 git 拒绝：先「全部暂存」并提交（不想要就「丢弃改动」），'
      + '或者直接再点一次分支名 —— 面板会用「安全切分支」自动藏起改动、切换成功后再原样恢复。'
  }
  if (reason === 'branch-missing') {
    return '找不到这个分支：检查名字是否写对。想从当前状态开一条新分支，在「管理」里输入新名字点「新建」。'
  }
  return null
}

// ── 删分支 / 改分支名：各一个分类器 ────────────────────────────────────────
//
// 「删不掉」是面板里最常见的哑火之一：点「删除」只回一句
// `error: the branch 'main' is not fully merged`，用户既不知道这是**保护**而不是
// 故障，也不知道「确实不要了」该怎么继续（面板此前连 -D 的入口都没有）。
// 改名的失败同理：`A branch named 'main' already exists` 只说明撞名了，
// 而撞名恰恰意味着「改名对齐」这条路走不通、该换另一条路推。

/**
 * 探测一次 `git branch -d/-D` 为什么失败。
 * @returns 归一化原因；`none` 表示不是已知的删除类故障。
 */
function classifyDeleteBranchFailure(stderr) {
  const text = String(stderr ?? '')
  if (/not fully merged|未完全合并|尚未完全合并|还没合并/i.test(text)) return 'unmerged'
  if (/branch ['"]?[^'"]*['"]? not found|没有找到分支|找不到分支/i.test(text)) return 'missing'
  return 'none'
}

/** 删分支失败时给面板的中文下一步（把「保护」讲清楚，并给出确实不要时的出口）。 */
function deleteBranchHint(reason) {
  if (reason === 'unmerged') {
    return '这个分支上的提交没有并进当前分支，git 拒绝删除 —— 这是它的防误删保护，不是故障。'
      + '想留住这些提交就先切过去看看（或在「管理」里点「比较」看差了哪些）；'
      + '确认这条线的历史不要了，点下面的「强制删除」（git branch -D）。'
  }
  if (reason === 'missing') {
    return '找不到这个分支：可能已经被删掉了（点「刷新」看最新列表），或者名字写错了。'
  }
  return null
}

/**
 * 探测一次 `git branch -m` 为什么失败（撞名最常见）。
 *
 * 两种措辞都要认：旧版 git 说 `not found`，而 `git branch -m <不存在> <新名>` 在
 * git 2.55 上说的是 `fatal: no branch named 'x'` —— 少认这一句，用户拿到的就是
 * 「未知故障 + 一行英文」，而这条本来有很明确的下一步（列表过期了，刷新一下）。
 * @returns 归一化原因；`none` 表示不是已知的改名类故障。
 */
function classifyRenameFailure(stderr) {
  const text = String(stderr ?? '')
  if (/already exists|已存在/i.test(text)) return 'exists'
  if (/no branch named|not found|没有找到|找不到/i.test(text)) return 'missing'
  return 'none'
}

/** 改名失败时给面板的中文下一步。 */
function renameHint(reason) {
  if (reason === 'exists') {
    return '本地已经有同名的分支了（git 不会覆盖它）：要么先把那个分支改名或删掉，'
      + '要么换一条路 —— 点「推送」，在给出的选项里直接把这次提交推到上游跟踪的那个分支上，本地名不用动。'
  }
  if (reason === 'missing') {
    return '要改名的分支不存在：可能已经被删掉了，点「刷新」看最新列表。'
  }
  return null
}

/**
 * 探测一次 `git branch --set-upstream-to=<ref> <local>` 为什么失败。
 *
 * 这条命令是面板「本地名 ≠ 上游名」现场的解药（把 fork-local.2 绑到 fork/local.2），
 * 它只有两种失败，而两种的下一步完全相反：
 *   · 远端引用还没下载到本地 → 先去「获取远程」，不是去检查分支名；
 *   · 要设的本地分支不存在   → 列表过期了（别处删掉了），重新展开管理器。
 * 分不清就只能甩一句 git 英文，用户会去改错的东西。
 * @returns 归一化原因；`none` 表示不是已知的上游类故障。
 */
function classifySetUpstreamFailure(stderr) {
  const text = String(stderr ?? '')
  if (/does not exist|不存在/i.test(text)) return 'remote-missing'
  if (/not a valid|不是有效/i.test(text)) return 'not-a-branch'
  if (/not found|没有找到|找不到/i.test(text)) return 'branch-missing'
  return 'none'
}

/** 设置上游失败时给面板的中文下一步。 */
function setUpstreamHint(reason) {
  if (reason === 'remote-missing') {
    return '要跟踪的那条远端分支本地还没有：先点一次「获取远程」把它下载下来，再设置上游 ——'
      + '上游只能指向已经在本地的远端引用（这条命令不发网络请求）。'
  }
  if (reason === 'branch-missing') {
    return '要设置上游的本地分支不存在：列表可能过期了（在终端 / 另一个会话里删掉过），'
      + '重新展开一次「管理」看最新列表再试。'
  }
  if (reason === 'not-a-branch') {
    return '那条引用不是分支（例如 origin/HEAD 这种符号引用）：换一条真正的远端分支再试。'
  }
  return null
}

export {
  classifyNetworkFailure, mirrorFallbackWorthwhile, networkHint,
  classifyPushFailure, pushHint, classifyPullFailure, pullFailureText, pullHint,
  classifyCommitFailure, commitHint, classifyCheckoutFailure, checkoutHint,
  classifyDeleteBranchFailure, deleteBranchHint, classifyRenameFailure, renameHint,
  classifySetUpstreamFailure, setUpstreamHint,
}
