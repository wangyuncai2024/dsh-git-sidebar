// dsh-git-sidebar —— 帮助文档（独立 HTML 页面，面板的「?」在新标签页打开）
// ============================================================================
// 纯内容 + 一个生成器，和业务逻辑零耦合，所以单独成文件。
// 镜像地址**从 MIRROR_CANDIDATES 取**，不在这里抄一份（抄的那份一定会过期）。
// ============================================================================

import { escapeHtml } from './util.js'
import { MIRROR_CANDIDATES } from './net.js'

// ── 帮助文档 ──────────────────────────────────────────────────────────────
//
// 说明：帮助内容做成**独立 HTML 文档**由宿主直接提供（GET /git-sidebar/help），
// 面板上的「?」在新标签页打开它。相比在浮层里画窗口，文档页面是浏览器原生
// 滚动/查找/打印/收藏，没有 overlay 层级与 flex 收缩那一堆坑。
// 内容在这里是唯一来源，将来也可以给模型工具复用。

/** 面板操作方式：文档开头（面向不熟 git 的用户）。 */
const HELP_HOWTO = [
  '第一次连远端：在「远程」里填仓库地址并保存 —— 这只是记下仓库在哪；点一次「推送」才会把本地分支和远端分支对应起来（面板自动做，不用记命令）。',
  '「仓库地址」和「上游」不是一回事：地址回答"仓库在哪"，上游回答"本地分支对应远端哪个分支"。没有上游时直接点「拉取」也行，面板会自动按「远程 + 当前分支」拉取并顺手登记上游。',
  '查更新：点「获取远程」→ 看分支行「落后 N」，N>0 就是有更新；确认后再点「拉取」合并。',
  '提交：点「全部暂存」→ 在提交框写说明 → 回车。推送失败后面板会提示下一步点哪里。',
  '看改动：改动清单里点任意条目，直接展开这个文件的 diff；再点一次收起。',
  '切分支：分支行点「管理」→ 点分支名切换；输入新名字可新建并切换。',
  '看远端分支：先点「获取远程」，再展开「管理」—— 下面会列出 origin/main 这些远端分支，'
    + '并且**按远程分组**、每行末尾有「⋯」（比较 / 设置上游）。'
    + '这条远端分支本地已经有了就直接点「切过去」（切到那条本地分支，不会新建）；'
    + '还没有对应本地分支时点「拿成新分支」——它会切到新建的那条分支上（原来的分支一点没动，随时切回来）。',
  '本地分支名和远端不一样（例如本地是 master、远端默认分支叫 main）：直接点「拉取」会报「远端没有这个分支」。'
    + '这不是让你去推送一个 master 出来 —— 先在「管理」里看远端有哪些分支，把需要的那份「拿成新分支」；'
    + '如果是「本地分支已经在跟踪某条远端分支、只是两边名字不一样」，'
    + '在本地那一行的「⋯ → 设置上游…」里把它绑到想跟的那条远端分支上（本地名不用改），'
    + '或按下面那一节处理两套无关历史。',
  '点「推送」报「上游分支名和当前分支名不一致」：本地分支名和它跟踪的远端分支名对不上，'
    + '而 git 默认配置只在两边同名时才肯推。面板会给出三条路 —— 推到上游那个分支（本地名一点不动）、'
    + '在远端另建同名分支、或把本地名改成与上游一致，选一个就行，不用敲命令。'
    + '（状态条上那个「名称不一致」小标就是提前告诉你这件事。）',
  '想让「推送」推到指定的那个远程（例如 origin 是别人的仓库只能读、fork 是你自己的）：'
    + '在「同步」区的「推送到」里选一个远程，再点「推送」；或者直接在下面「远程」那一行点「推送到此」。'
    + '两条入口是同一件事：都会推一次、并把那个远程记成这个仓库的推送目标（下次打开还推那里）。'
    + '面板会跑 git push <远程> HEAD（显式指定，不受 push.default 配置限制）；'
    + '这不会改动你的任何 git 配置（上游、push.default 都不动）。'
    + '想连以后 pull 也走那个远程，才需要设置上游（见下面「远程仓库」里的 git push -u 那条）。',
  '推送被服务器拒绝、理由是「Permission to … denied to …」：这不是网络问题，也不是地址写错，'
    + '而是你的账号对这个远程没有写权限（别人的仓库一般只能拉不能推）。'
    + '如果这个仓库还有别的远程，面板会直接给一个「推送到 xxx」按钮，点一下就用那个远程再推一次；'
    + '没有的话点「+ 添加远程」把你自己那份（fork）的地址加进来，再在「推送到」里选它。',
  '推送被拒绝、理由是「GH006: Protected branch update failed」或「protected branch」：'
    + '这条分支**受保护**，就算你对这个远程有写权限也不能直接推（与上面那条「没有写权限」是两回事，面板会分开说）。'
    + '标准做法是推到你自己的远程（面板给的「推送到 fork」按钮）再在网页上开 Pull Request；'
    + '或者请仓库维护者放开这条保护规则 / 把这条分支加进允许直接推送的名单 —— 面板不会替你改远端的设置。',
  '删分支被拒（提示「未完全合并」）：那是 git 的防误删保护，不是故障。确认这条线的提交不要了，'
    + '就在提示下面点「强制删除」（等价 git branch -D）；想留住就先切过去看看差哪些。'
    + '另外，新建分支名别写成 origin/main 这种带远端前缀的形式：它会和远端跟踪引用同名，'
    + 'git 之后处处报 ambiguous，面板会直接拦住并给出安全的本地名。',
  '「远程」那行提示「N 个远程指向同一地址」：多出来的那个远程除了冗余，还会让 git 命令行产生歧义'
    + '（远程名可能和本地分支名撞上）。点提示里的「删掉 名字」即可 —— 只动本地配置和它的远端跟踪引用，'
    + '服务器上的仓库与你的提交都不受影响，需要时 git remote add 加回来就行。',
  '救场：改动没弄完要切分支？直接点分支名就行 —— 面板会先确认一句，然后把改动（含未跟踪文件）自动藏起来，'
    + '切换成功后再原样恢复（「安全切分支」）；切换失败也会自动还给你。',
  '只想提交其中一个文件：在改动清单里点那一行右侧的「暂存」（已暂存的给「取消暂存」），再写提交信息提交。',
  '刚提交完发现漏了东西：勾上提交框旁边的「补充上次」再提交（等价 git commit --amend）。',
  '看某次提交改了什么：在「最近提交」里点那一行，详情（作者 / 日期 / 改动统计）就展开在下面；再点收起。',
  '想看看某个历史版本的代码：在「最近提交」那一行点「切到此」（等价 git switch --detach 提交号）。'
    + '切过去后查看、编译、运行都可以；想在这个版本上继续改代码，先新建分支（git switch -c 名字）。'
    + '回到最新：在「管理」里点一下原来的分支名即可。',
  '改动被面板自动藏起来过（安全拉取 / 安全切分支）：展开「stash 备份」就能看到，一键恢复或删除；'
    + '弹回冲突时面板会列出要处理的文件。',
  '想先把工作区清干净（改动还没弄完）：点「藏起当前改动」（git stash push -u），改动进「stash 备份」，随时「恢复」拿回来。',
  '改动一多找不到：改动清单是按目录折叠的树 —— 点目录行展开/收起；「暂存目录」一次收下整个目录的改动。',
  '拉取/合并撞上冲突：改动清单顶部会出现横幅列出冲突文件；改好冲突文件（删掉 <<<<<<< 标记）→ 点该行「暂存」→ 提交收尾。',
  '提交很多翻不完：在「最近提交」点「加载更多」往下翻（每次 20 条，本地查询不联网）。',
  '有未提交改动（包括还没加入版本库的文件）又想拉取：点「安全拉取」——面板会先把改动自动藏起来（`git stash push -u`），拉取成功后再原样恢复；拉取失败也会自动还给你，改动不会丢。',
  '拉取撞上冲突：面板不替你决定要哪边。改好冲突文件 → git add → git commit 收尾；不想合了就点面板上的「撤销这次合并」（等价于 git merge --abort，安全，不动你已有的提交）。下面有专门一节。',
  '连不上：报错里有 Connection was reset / timed out 时，点失败提示条里的「去设置」—— 网络加速（镜像 / 本机代理）在「设置」那一档里：公开仓库用镜像，私有仓库或要推送就填本机代理。',
]

/** 常用命令分组：每条命令在文档里点一下即复制。 */
const HELP_SECTIONS = [
  {
    title: '👀 查看状态与更新',
    cmds: [
      { cmd: 'git status -sb', desc: '看当前分支、改动和领先/落后几个提交' },
      { cmd: 'git fetch', desc: '下载远程更新信息（不会改动你的代码）' },
      { cmd: 'git log HEAD..origin/main --oneline', desc: '看远程 origin/main 上你还没有的提交明细' },
    ],
  },
  {
    title: '✍️ 提交与推送',
    cmds: [
      { cmd: 'git add -A', desc: '暂存所有改动' },
      { cmd: 'git add 文件路径', desc: '只暂存某一个文件（面板改动行右侧的「暂存」就是这条）' },
      { cmd: 'git commit -m "提交说明"', desc: '创建一次提交，引号里换成你的话' },
      { cmd: 'git commit --amend', desc: '把这次提交并进上一次（面板的「补充上次」）；已经推出去的提交别改' },
      { cmd: 'git config --global user.name "你的名字"', desc: '第一次提交报「Please tell me who you are」时：先设置身份' },
      { cmd: 'git config --global user.email "you@example.com"', desc: '同上，填你的邮箱（不需要和 GitHub 账号一致，但建议一致）' },
      { cmd: 'git push', desc: '把本地提交推到远程' },
      { cmd: 'git push -u origin main', desc: '新分支第一次推送，顺便建立上游跟踪' },
    ],
  },
  {
    title: '🌿 分支',
    cmds: [
      { cmd: 'git branch -a', desc: '列出所有本地和远程分支' },
      { cmd: 'git switch 分支名', desc: '切换到已有分支' },
      { cmd: 'git switch --detach 提交号', desc: '切换到某一次提交看看（游离 HEAD；回到最新再 switch 回分支名即可；面板「最近提交」的「切到此」就是这条）' },
      { cmd: 'git switch -c 新分支名', desc: '新建分支并切换过去' },
      { cmd: 'git branch -d 分支名', desc: '安全删除分支（未合并的分支会被拒绝；确实不要了用 git branch -D 强制删除）' },
      { cmd: 'git merge 分支名', desc: '把某个分支合并到当前分支' },
    ],
  },
  {
    title: '📦 救场 stash（临时收起改动）',
    cmds: [
      { cmd: 'git stash push -u -m "说明"', desc: '把改动藏起来并留一句说明（-u 连未跟踪文件一起；面板的「藏起当前改动」就是这条）' },
      { cmd: 'git stash push -u', desc: '把改动藏起来（-u 连未跟踪文件一起；面板的「安全拉取」「安全切分支」用的就是这条）' },
      { cmd: 'git stash', desc: '把当前改动收起来，工作区瞬间变干净' },
      { cmd: 'git stash pop', desc: '恢复最近收起的那次改动' },
      { cmd: 'git stash list', desc: '看看收起了几份（面板的「stash 备份」就是这条的图形版）' },
      { cmd: 'git stash apply stash@{0}', desc: '恢复某一份备份但保留它（面板的「恢复」就是这条）' },
      { cmd: 'git stash drop stash@{0}', desc: '删掉某一份备份（不可恢复；面板的「删除」就是这条）' },
    ],
  },
  {
    title: '⌛ 撤销（小心）',
    cmds: [
      { cmd: 'git reset', desc: '撤销「暂存」，工作区改动保留' },
      { cmd: 'git restore 文件路径', desc: '只丢弃某个文件的改动' },
      { cmd: 'git restore .', desc: '丢弃所有未提交改动！不可恢复，慎用（面板的「丢弃改动」就是这条）' },
    ],
  },
  {
    title: '⚔️ 拉取撞上冲突怎么办',
    cmds: [
      { cmd: 'git status', desc: '看哪些文件冲突了（会列在 "Unmerged paths" 下面）' },
      { cmd: 'git checkout --ours 文件路径', desc: '这个文件保留「我这边」的版本（拉取方是 --theirs）' },
      { cmd: 'git add 文件路径', desc: '冲突解决完，把文件标记为已解决' },
      { cmd: 'git commit', desc: '收尾这次合并（git 已经写好了提交信息，直接保存即可）' },
      { cmd: 'git merge --abort', desc: '不想合了：撤销这次合并，回到拉取之前的样子（安全，不动已有提交）' },
    ],
  },
  {
    title: '🧭 本地和远端是两套无关历史 / 分支名对不上',
    cmds: [
      { cmd: 'git branch -r', desc: '看远端有哪些分支（远端默认分支标在 origin/HEAD 上）' },
      { cmd: 'git fetch origin', desc: '先把远端分支信息下载下来，上面那条才有东西可看' },
      { cmd: 'git switch -c main origin/main', desc: '把远端那份拿成本地新分支（之后你就在这条新分支上；原来的分支没动）' },
      { cmd: 'git branch --set-upstream-to=origin/main my-branch', desc: '把某个本地分支的上游绑到这条远端分支（面板里是本地行的「⋯ → 设置上游…」）' },
      { cmd: 'git rev-list --left-right --count HEAD...origin/main', desc: '看本地和远端各差几个提交（左=本地多，右=远端多）' },
      { cmd: 'git pull origin main --allow-unrelated-histories', desc: '确认要把两套无关历史合成一条时才用（会创建一次合并提交）' },
      { cmd: 'git branch -m master main', desc: '把本地分支改名成和远端一致，之后裸 pull / push 都能直接用' },
    ],
  },
  {
    title: '🏷️ 标签与历史',
    cmds: [
      { cmd: 'git log --oneline -10', desc: '看最近 10 条提交' },
      { cmd: 'git diff', desc: '看工作区改动的具体内容' },
      { cmd: 'git diff --staged', desc: '看已经暂存、即将提交的内容' },
      { cmd: 'git tag -a v1.0 -m "版本说明"', desc: '给当前提交打一个标签' },
      { cmd: 'git push origin v1.0', desc: '把标签推到远程' },
    ],
  },
  {
    title: '🔌 远程仓库',
    cmds: [
      { cmd: 'git remote -v', desc: '查看配置了哪些远程地址' },
      { cmd: 'git push fork HEAD', desc: '推到指定的那个远程（fork 换成你的远程名；HEAD = 当前分支，推到同名的远端分支）。面板的「推送到」下拉与远程行的「推送到此」跑的就是这条' },
      { cmd: 'git push -u fork HEAD', desc: '同上，并且把当前分支的上游设成这个远程（以后裸 git push / git pull 就走它）。面板不擅自替你设，只有你自己敲或让 AI 工具带 setUpstream 才会改' },
      { cmd: 'git branch -vv', desc: '看每个本地分支「对应远端的哪个分支」（方括号里就是上游）' },
      { cmd: 'git branch --set-upstream-to=origin/main', desc: '把当前分支的上游设为 origin/main，之后 pull / push 不用再带参数' },
      { cmd: 'git pull origin main', desc: '还没有上游时也能拉一次（面板的「拉取」会自动这样做）' },
      { cmd: 'git pull upstream main', desc: '从**指定的那个远程**拉（不要求当前分支的上游是它，也不改上游配置）。面板「拉取自」下拉跑的就是这条：分支跟踪 fork、但要拿 origin（别人的上游）的更新时用它' },
      { cmd: 'git pull upstream master', desc: '把上游**它自己的默认分支**拉进你现在的分支（分支名不变、上游配置也不动）。面板里不用敲：远程行的「拉 master」与「拉取自」里的「从 origin/master 拉」就是这条 —— 本地分支叫 local.2、别人的默认分支叫 master 时，这是拿更新的那条路。**面板绝不自动做这件事**：把另一条线并进当前分支可能与你的意图相反，所以它只摆在按钮上，点一下才算数' },
      { cmd: 'git for-each-ref --format="%(refname:short) %(symref:short)" refs/remotes', desc: '看每个远程各自声明的默认分支（面板「拉取自」里那个「从 <远程>/<分支> 拉」就是按这份数据点名的）。本地没有这个指针时面板不猜，退回「拉当前分支同名那条」' },
      { cmd: 'git remote set-url origin 新地址', desc: '改远程地址（比如从 HTTPS 换成 SSH）' },
      { cmd: 'git config --global credential.helper store', desc: 'HTTPS 推送报「Authentication failed」时：保存凭据后重推一次（会询问用户名与令牌）' },
      { cmd: 'git clone 仓库地址', desc: '克隆远程仓库到当前目录' },
      { cmd: '面板「远程」行的「仓库页 ↗」', desc: '远程地址是网页地址（GitHub / GitLab / Gitee…）时出现：点击直接在新标签页打开仓库主页' },
    ],
  },
  {
    title: '🌐 连不上 GitHub？（报错：Connection was reset / timed out）',
    cmds: [
      {
        // 镜像地址**从 MIRROR_CANDIDATES 取**：这里手抄一份的话，换默认镜像时
        // 文档就会教用户敲一条早已不通的命令（而这份文档正是「出问题时看的东西」）。
        cmd: 'git -c url."' + MIRROR_CANDIDATES[0].prefix
          + 'https://github.com/".insteadOf="https://github.com/" fetch --all',
        desc: '临时走镜像获取更新 —— 只影响这一条命令，不改任何配置，克隆下来的 origin 也还是原地址',
      },
      {
        cmd: 'git config --global http.proxy http://127.0.0.1:7890',
        desc: '给所有 git 命令设本机代理（Clash / V2Ray 等），推送和私有仓库也能走',
      },
      { cmd: 'git config --global --unset http.proxy', desc: '不需要代理了，取消这个设置' },
      { cmd: 'git config --global --get http.proxy', desc: '看看当前设了代理没有' },
    ],
  },
]

/** 文档样式：跟随系统深浅色，命令行点一下复制。 */
const HELP_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 30px 18px 64px;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1a1a1a;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 23px; margin: 0 0 8px; }
  .lead { margin: 0 0 18px; color: #55606e; }
  .lead strong { color: #1a1a1a; }
  nav.toc { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
  nav.toc a {
    padding: 4px 11px; border-radius: 999px; text-decoration: none; font-size: 13px;
    background: #ffffff; border: 1px solid #dfe3e8; color: #334155;
  }
  nav.toc a:hover { border-color: #2563eb; color: #2563eb; }
  section {
    background: #ffffff; border: 1px solid #e6e9ee; border-radius: 12px;
    padding: 14px 16px; margin-bottom: 14px;
  }
  h2 { font-size: 15px; margin: 0 0 10px; }
  ul.howto { margin: 0; padding-left: 20px; }
  ul.howto li { margin-bottom: 6px; }
  .row { padding: 9px 0; border-top: 1px dashed #eceff3; }
  .row:first-of-type { border-top: 0; }
  .desc { color: #55606e; font-size: 13px; margin-bottom: 4px; }
  button.cmd {
    display: block; width: 100%; text-align: left; cursor: pointer;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 8px 11px; border-radius: 8px; word-break: break-all;
    background: #f4f6f8; border: 1px solid #e2e6ea; color: #0f172a;
  }
  button.cmd:hover { border-color: #2563eb; background: #eef4ff; }
  button.cmd.copied { border-color: #16a34a; color: #15803d; background: #f0fdf4; }
  footer { margin-top: 22px; color: #7b8794; font-size: 12.5px; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6e8eb; }
    .lead, .desc { color: #9aa4b2; }
    .lead strong { color: #e6e8eb; }
    nav.toc a, section { background: #1e2127; border-color: #2b3038; color: #cbd5e1; }
    button.cmd { background: #23272e; border-color: #333a44; color: #e6e8eb; }
    button.cmd:hover { border-color: #60a5fa; background: #1d2735; }
    button.cmd.copied { border-color: #22c55e; color: #4ade80; background: #17251c; }
    .row { border-top-color: #2b3038; }
  }
`

/** 文档脚本：点命令复制（Clipboard API，失败退回 execCommand，再失败弹出手动复制）。 */
const HELP_JS = `
  document.querySelectorAll('button.cmd').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-cmd') || button.textContent || '';
      var original = button.textContent;
      var done = function (ok) {
        if (!ok) { window.prompt('复制失败，请手动复制这行命令：', text); return; }
        button.textContent = '✓ 已复制：' + text;
        button.classList.add('copied');
        window.setTimeout(function () {
          button.textContent = original;
          button.classList.remove('copied');
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        return;
      }
      try {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        done(ok);
      } catch (error) {
        done(false);
      }
    });
  });
`

/** 生成完整的帮助 HTML 文档（零外部依赖：可直接打开、收藏、打印）。 */
function renderHelpHtml() {
  const toc = HELP_SECTIONS
    .map((section, index) => '<a href="#s' + String(index) + '">' + escapeHtml(section.title) + '</a>')
    .join('')

  const sections = HELP_SECTIONS.map((section, index) => {
    const rows = section.cmds.map((item) => [
      '<div class="row">',
      '<div class="desc">' + escapeHtml(item.desc) + '</div>',
      '<button class="cmd" type="button" data-cmd="' + escapeHtml(item.cmd) + '">'
        + escapeHtml(item.cmd) + '</button>',
      '</div>',
    ].join('')).join('')
    return [
      '<section id="s' + String(index) + '">',
      '<h2>' + escapeHtml(section.title) + '</h2>',
      rows,
      '</section>',
    ].join('')
  }).join('')

  const howto = HELP_HOWTO.map((text) => '<li>' + escapeHtml(text) + '</li>').join('')

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Git 帮助 · dsh-git-sidebar</title>',
    '<style>' + HELP_CSS + '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<header>',
    '<h1>Git 帮助</h1>',
    '<p class="lead">面板怎么用 + 常用命令小抄。<strong>点任意命令即可复制</strong>，'
      + '粘到终端就能跑；命令里需要替换的地方（「提交说明」「分支名」等）换成你自己的即可。</p>',
    '</header>',
    '<nav class="toc">' + toc + '</nav>',
    '<section id="howto">',
    '<h2>🧭 面板操作方式</h2>',
    '<ul class="howto">' + howto + '</ul>',
    '</section>',
    sections,
    '<footer>由 dsh-git-sidebar 提供 · 面板上的「?」就是打开本页 · 可以收藏，边看边敲</footer>',
    '</div>',
    '<script>' + HELP_JS + '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export { renderHelpHtml, HELP_SECTIONS, HELP_HOWTO }
