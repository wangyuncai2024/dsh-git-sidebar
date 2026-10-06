# dsh-git-sidebar

DSH 的 **Git 侧边栏插件**：把 Git 面板做成右侧栏（rightbar）里的**一等标签**，
与内置的「工作区文件」「新建终端」「浏览器」并列。

这是 `dsh-git-panel`（右下角悬浮面板）的**侧边栏版**。两者是**两个独立的插件**，
目标是由本插件**取代**旧的那个（右下角浮窗要彻底移除）。过渡期若要两个都装，
注意模型工具会撞名——见下面「已知限制」。

---

## 它长什么样

1. 点右侧栏的「+」→ 出现功能列表（工作区文件 / 新建终端 / 浏览器 / **Git 面板**）。
2. 点「Git 面板」→ 它作为**一个标签**占据右侧栏，成为主工作区的一部分。
3. 标签可以像其它标签一样：分屏、拖出来浮动、关闭、随会话切换。

**没有右下角浮窗了。** 旧版那个自己管位置、尺寸、最小化胶囊的浮层，在这一版里
彻底移除——位置、尺寸、停靠/浮动/分屏全部交给右侧栏的 docking kit，插件只往
给定的框里画内容。

---

## 安装

```bash
cd <本插件根目录>
dsh plugin --profile web add "link:$PWD"
# 首次安装 / 卸载后要重启一次 dsh（bundles 是启动时读的）
```

卸载：

```bash
dsh plugin --profile web remove dsh-git-sidebar
```

零依赖（`dependencies` 为空），只用 Node 内置模块，因此 link 安装到任何 profile
都能解析。

---

## 可用行配置（profile 的 `cordis.patch.yml` 里用同一个 id 覆盖）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `defaultDir` | `''` | 面板默认操作的目录；留空 = 跟随当前会话工作目录 |
| `logLevel` | `'info'` | 日志级别：`off` / `error` / `warn` / `info` / `debug` |
| `logMaxBytes` | `2097152` | 日志轮转上限（超过后旧文件改名 `.1`，只留两份） |
| `logFile` | `''` | 日志路径；留空 = 本插件仓库根目录下的 `git-sidebar.log` |

网络加速（镜像 / 代理）**不走这里**，见 `$DSH_HOME/git-sidebar-net.json` ——
面板上的 🌐 按钮读写它（那个设置要能随时改，不该逼用户回来编辑 yml 再重启）。

---

## 它是怎么接进右侧栏的（本插件最核心的部分）

DSH 的右侧栏标签是**三段式注册**，缺一不可：

| # | 注册点 | 作用 |
| --- | --- | --- |
| 1 | `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` | **声明这是一种什么标签**。「+」列表里那一项就是它（`guide` 数组） |
| 2 | `sidebar.right.pane.tab`（keyed，key = 上面那个 `id`） | 标签**正文** |
| 3 | `sidebar.right.pane.tab.title`（keyed，同 key） | 标签**标题**（可省；省了用 registry 捕获的标题） |

三段必须用**同一个 id**，所以它在 `lib/client.js` 里只写一次（`GIT_TAB_ID`）。
`id` 取包名（官方那几个标签也这么做），因为它在**所有注册里必须全局唯一**；
`kind` 才是 `openTab('git')` 用来点名类型的判别子。

关键常量（`lib/client.js` 顶部）：

```js
const GIT_TAB_ID = 'dsh-git-sidebar'   // 全局唯一，也是两个 keyed 插槽的 key
const GIT_TAB_KIND = 'git'             // openTab('git') 用
const GIT_TAB_PRIORITY = 'extension'   // 产品之外的插件用这一档（也是最高档）
```

需要声明的客户端服务：

```js
const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']
```

> `sidebarRight` 与 `sidebarRightTabs` 由右侧栏用 `ctx.reflect.provide` **动态提供**，
> 不在 Inspect 的服务目录里（那份目录是手写白名单）——但 `ctx.get('sidebarRight')`
> 取得到，而且**必须写进 `inject`**：客户端服务是 cordis 懒注入的，不声明的服务
> 在插件上下文里读不到。这与 `uiWorkspace` 是同一个坑。

「设置 → 通用 → Git 面板」那一行里还有个「打开」按钮，走
`ctx.sidebarRight.openTab('git')`——它同时会把右侧栏展开（内容看不见就不算打开）。

---

## 与 dsh-git-panel 的关系

|  | `dsh-git-panel` | `dsh-git-sidebar`（本插件） |
| --- | --- | --- |
| 挂载点 | `shell.overlay`（右下角浮层） | `sidebar.right.pane.tab`（右侧栏标签） |
| 位置 / 尺寸 | 插件自己管（fixed 定位 + 拖拽改宽 + 最小化胶囊） | 宿主右侧栏的 docking kit 管 |
| 宿主侧 git 逻辑 | 一套 | **复制**了一份，各自独立演进 |
| 路由 | `/git-panel/*` | `/git-sidebar/*` |
| 模型工具 | `git_status` / `git_add` / … | 同名（`git_status` / `git_add` / …） |

**宿主侧代码（`lib/git.js` / `ops.js` / `routes.js` / `net.js` / `log.js` /
`help.js` / `failure.js` / `util.js` / `tools.js`）是从 `dsh-git-panel` 复制来的**，
按「复制一份，新仓库自包含」的选择。因此这个仓库可以独立安装、独立运行，
代价是两份宿主代码会各自演进——等侧边栏版稳定后再废弃旧的。

路由已经加了 `/git-sidebar/` 前缀与旧插件区分开。模型工具名仍是同一套（见下面
「已知限制」里那条已查清的撞名行为）——**过渡期建议先卸掉旧插件**。

---

## 目录结构

```
lib/
  index.js     宿主 / Node 侧入口：挂载 HTTP 路由 + 注册 git 模型工具
  client.js    浏览器侧：右侧栏标签的三段式注册 + 面板全部界面
  routes.js    HTTP 路由与 op 流水线
  ops.js       操作注册表：每个操作的 argv 形状、超时、解析、补救、提示（唯一事实来源）
  git.js       git 执行（execFile + 参数数组）与 porcelain / branch / remote 解析
  net.js       网络加速（镜像 / 代理）配置、参数注入、线路实测
  failure.js   失败分类 + 「下一步点哪里」的中文提示（纯函数）
  help.js      帮助文档（独立 HTML 页面，GET /git-sidebar/help）
  log.js       统一操作日志（JSONL、级别、轮转、串行写入）
  tools.js     模型工具（argv 全部复用 ops.js 的构造器）
  util.js      无依赖小工具（打码、归一化、文本处理）
test/
  client.test.mjs      客户端半边：假 window + 假 React 跑真实 bundle
  standalone.test.mjs  插件加载、路由、工具、op 流水线
  unit.test.mjs        纯函数：解析 / 决策 / 分类
  network.test.mjs     网络加速（镜像 / 代理）行为
```

---

## 界面：按侧边栏重新设计（不照搬浮窗布局）

旧浮窗的版式是为「360px 固定宽的角落小窗」设计的；右侧栏是**常驻的全高工作区**，
宽度用户可拖（`RIGHTBAR_MIN = 300px`，默认约视口 45%，上限 70%，
见 `packages/client/ui-layout/src/client/columns.ts` 与 `stores.ts`）。
两个容器的信息架构本来就不同，所以这一版没有照搬，而是按侧边栏重新组织：

- **头部 = 上下文条**（不再是「🐙 Git 面板」大标题）：右侧栏的标签栏已经写着
  Git，正文再画一遍标题是重复。头部两行回答「我在哪儿」——
  `分支名 → 上游 领先/落后` + 目录（切换 / 刷新 / 跟随会话在行尾）。
- **第一屏给日常动线**：改动 → 提交 → 同步（拉取 / 推送 / 获取远程 / stash）
  依次排开，打开标签即见。
- **分支管理与远程配置默认折叠**：两者是「找分支」「配一次管很久」的低频操作，
  各自只剩一条可点的区块头（带 ▸/▾ 箭头）；远程区块在编辑中 / 出错 /
  有重复远程时**自动展开**——配置的问题不能藏在收起的区块里。
- 最近提交与提交详情垫底；命令结果与待选项仍然固定在正文滚动区之外（不随滚动消失）。

窄栏适配（300px 最窄档）沿用实测驱动的做法，已经按实测修掉的问题：

- **分支名在窄栏下被挤没**（真缺陷）。300px 下不换行时，固定宽度的那一列控件先占位，
  分支名被压到 **28px**，渲染成 `for...` / `f...`。头部上下文条与本地分支行都是
  **可换行**版式（`S.rowWrap` / `S.rowMain` / `S.rowAside`）：左半占满整行，
  右半在放不下时整组掉到第二行，分支名因此拿到整行宽度。

自查工具怎么用：

```powershell
# 取测量结果（FILL / MEASURE / ELLIPSIS 三段）
pwsh -File .ui-preview/shot.ps1 -Name x -Query "?dirty=1&measure=1" -Frame "300x900" -Probe
# 截图（浅色 / 深色）
pwsh -File .ui-preview/shot.ps1 -Name x -Query "?dirty=1" -Frame "300x900" -Dark
# 一次跑完全部状态 × 两个宽度 × 两个主题的对比度审计（FAILS 必须为 0）
pwsh -File .ui-preview/audit-all.ps1
```

`?frame=WxH` 覆盖仿造框尺寸；`?off=1` 预览「设置里关掉开关」那一态；
`?branches=1` 点开「本地分支」折叠区块头（展开态截图用）。

---

## 开发

```bash
npm run check   # 语法检查（node --check 全部 lib/*.js）
npm test        # 全部测试（node --test）
```

**换机器、换 DSH 版本时先跑一次 `npm test`。** 它覆盖的是插件自身的加载与注册
契约；这些一旦坏掉，通常表现为「插件装上了、界面里却没有」，静默且难查。
其中 `test/client.test.mjs` 专门盯住右侧栏的三段式注册：

- 三段注册都发生了，且**正文与标题用同一个 key**；
- 类型定义的 `id` / `kind` / `priority` / `guide` 都对（`guide` 的 `order` 要排在
  官方 `files 10 / terminal 20 / browser 30` 之后）；
- 拿不到标签注册表时，正文与标题**仍然注册**（故障要「少一块」而不是「全没」）；
- 标签类型注册失败会带**真实原因**回报宿主日志（不静默、不谎报成功）；
- 标签正文铺满给定的框、**不再是固定定位的浮窗**（`position` / `zIndex` / `right` /
  `bottom` / `boxShadow` 都不该有）；
- **窄栏下分支名不被挤没**：「分支」行与本地分支行都是可换行版式（左半占满整行，
  右半整组换行），分支名带 4em 最小宽度；
- 旧版浮窗遗留的 localStorage 键会被清掉。

这两条窄栏用例做过**变异测试**：把 `S.rowWrap` 换回不可换行版式，它们会失败。

---

## 融合升级（v0.2.0：吸收 DSH-better-sidebar 与生态插件的优点）

本轮按调研结论（omdsh-dev/DSH-better-sidebar 的 Git 视角 / diff 栈 + dsh-git-plus、
dsh-solution-explorer、dsh-better-sidebar-svn 等生态插件）做了一轮融合，逐条：

**工程卫生（一行级，收益即刻）**

- 每条 git 命令统一带 `--no-pager -c color.ui=false -c core.quotePath=false`：
  **中文 / 空格路径原样显示**，不再出现 `"lib/\346\226\207\346\241\243.js"` 这种八进制转义
  （此前中文文件名在改动清单与 diff 里全是乱码形态）。
- `status` 改用 **`--porcelain=v1 -z`**（NUL 分帧）：文件名里的空格、换行不再把清单切碎；
  重命名（R/C）条目的原始路径 token 正确消费。
- `show` 与「切到此提交」加 **`--end-of-options` 哨兵**：调用方回传的提交号永远不可能
  被解析成 git 选项（`rev: "--output=NUL"` 这类 flag 注入在哨兵处停下、失败而不是写文件）。

**界面升级**

- **变更列表升级为目录树**（VS Code SCM 同款）：单子目录链压缩成一行
  （`src/client/changes` 不再是三层各占一行）、目录行可折叠、带下级变更数胶囊、
  目录行直接给「暂存目录」（`git add -A -- <dir>`，一次收下整个子树）。
- **diff 渲染升级**：连续的删块/增块配对成「改」（蓝色行），配对行做
  **行内字符级高亮**（真正变了的那几个字加深色小片）；≥8 行的连续上下文
  折叠成「… N 行」，点击展开（不发请求，内容已在）。
- **合并冲突可见**：porcelain 里的 UU/AA/DD 条目在状态里单列 `conflicts`，
  清单顶部出横幅（要做什么 + 是哪些文件），冲突行带「冲突」徽章。
- **提交历史升级**：每行带 refs 徽章（`HEAD -> main`、tag）与作者 + 相对时间
  （「3 天前」）；满一页（8 条）时出现「加载更多」，每次向后翻 20 条
  （`log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%D` 结构化分页，本地查询）。
- **标签角标**：右侧栏标签 chip 上实时显示未提交改动数（`Git · 3`），
  干净时就是纯「Git」零噪音。
- **「藏起当前改动」**：手动 `git stash push -u`（安全拉取/安全切分支的自动藏之外，
  主动想把工作区清干净的场合）；备份照旧进「stash 备份」区收尾。

**测试**：新增 16 个用例钉住以上行为（parseStatusZ 的 NUL 分帧与中文路径、
isConflictCode、logPage 的 argv/解析、addDir、目录树折叠/压缩、冲突横幅、
标签角标、diff 配对与折叠、stashPush）。`npm run check && npm test` 全绿
（333 tests / 330 pass / 3 skip——skip 的是需要真 git 且沙箱受限的用例）。

**未吸收（与调研结论一起明确不做）**：AI 生成提交信息（需要宿主模型通道，待宿主
暴露 API 后再加）、`@文件` 引用进输入框（同）、多仓库/worktree 下拉（当前单仓库
场景优先级低）、提交图谱（SVG 泳道，属 v2）。

---

## 已知限制 / 待办

- **过渡期两个插件同时安装时的工具撞名**（已查清，非未决）：
  `packages/core/tools/src/index.ts:746` 的 `NamedEntries` 在重名时抛
  `tool "<name>" is already registered`（`packages/core/scope/src/store.ts:43-46`）。
  因为本插件的 `registerTools` 有 try/catch（见 `lib/tools.js`），结果是：
  **谁先注册这 13 个 `git_*` 工具，就归谁**；后注册的那一份每个工具都会记一条
  「注册工具失败」的日志，然后被跳过。功能上无差别（两个插件跑同一套宿主 git 逻辑），
  但有个**卸载顺序的坑**：后注册者一个工具都没成功注册，所以卸掉先注册的那个插件后，
  这些工具会消失，直到后注册者重新 apply / 重启。
  之所以**不**把它们改名成 `git_sidebar_*`：目标是侧边栏版**取代**旧插件
  （「右下角的悬浮面板就彻底移除」），终态只剩本插件时 `git_status` 这个名字才是对的，
  改名只会带来一次无谓的迁移。若在过渡期要两个都装，建议先卸掉旧插件。
- `panel` 只暴露 `id`，**没有** docked / floating 字段；浮动态只能靠 `tab.visible`
  与 `sidebar.fullscreen` 间接推断。目前面板不需要这个信息，故未处理。
- 界面文案是中文硬编码，没接 `ctx.locale` 词典体系（官方那几个标签走 locale 是
  为了多语言；本插件暂时不需要，`title` 是 thunk，将来要接只需改一处）。
- 本轮改造**尚未在真实 DSH 里加载验证**，只到「假 window + 假 React 跑真实
  bundle」+「headless Chrome 按真实主题 token 量版面」两层。首次安装后请按下面
  「验收清单」在界面上确认一遍。
- 窄栏（300px）下仍有少量次要文本用省略号截断（远程地址、提交标题、`↩ 本地 master`
  这类注解）—— 这是**有意**的：它们都有 tooltip 给全量，而强行换行会把每行撑成两三行，
  反而更难扫读。已修的是「分支名」这种主信息。

---

## 验收清单（首次安装后人工确认）

- [ ] 右侧栏点「+」，列表里出现「Git 面板」，与「工作区文件 / 新建终端 / 浏览器」并列。
- [ ] 点它之后，右侧栏出现一个标题为「Git」的标签，面板内容铺满、能滚动。
- [ ] 右下角**没有**任何悬浮的 Git 面板（旧版浮窗应已消失）。
- [ ] 标签能分屏、能拖出来浮动、能关闭（这些是宿主 docking kit 的能力）。
- [ ] **把右侧栏拖到最窄**（约 300px）：分支名仍然完整可读，「领先/落后 + 管理」
      与本地分支行的「⋯」会换到第二行，不出现 `for...` 这种被挤没的名字。
- [ ] 「设置 → 通用 → Git 面板」的开关与「打开」按钮都工作；关掉开关后，
      标签内容显示「已关闭：在设置里重新开启」而不是空白。
- [ ] 切分支 / 暂存 / 提交 / 拉取 / 推送走一遍，`git-sidebar.log` 里有对应记录。
- [ ] 「本地分支」「远程仓库」区块头能展开收起；远程区块在「改」一个远程时自动展开。
- [ ] 面板的「?」打开帮助文档（`/git-sidebar/help`），🌐 与 ? 都正常。
