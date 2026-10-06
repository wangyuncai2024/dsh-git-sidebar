// dsh-git-sidebar —— Client half（浏览器侧）
// ============================================================================
// 纯手写 bundle，格式与官方 dsh-client-ui-* 一致：
//   window.__ModuleLoader__.load({ id, factory })，factory 的 require 只能取种子模块
//   （react / react-dom / @deepseek-ai/dsh-client-store / …）。
// 本插件只 require('react')，因此不依赖任何构建产物。
//
// 职责（全部走公开扩展点）：**把 Git 面板做成右侧栏的一种标签类型**，与「工作区文件」
// 「新建终端」「浏览器」并列。四件事，缺一不可（前三件是 tab 类型的三段式注册）：
//   1. sidebarRightTabs.register(...)   —— 声明这是一种什么 tab（kind / id / 标题 /
//      指南页入口）。右侧栏的「+」列表里那一项就是它。
//   2. sidebar.right.pane.tab          —— keyed 插槽，key = 上面那个 id：标签正文。
//   3. sidebar.right.pane.tab.title    —— 同 key：标签标题（可省，省了用 registry 捕获的标题）。
//   4. settings.general.item           —— 「设置 → 通用」里的开关行，控制标签内容是否渲染。
//
// 与旧版（dsh-git-panel）的根本差别：旧版把自己挂在 `shell.overlay` 上，是一个自己
// 管位置、尺寸、最小化状态的右下角浮窗；这一版**没有任何自己的窗口壳**——标签的
// 停靠/浮动/分屏/关闭全部交给右侧栏的 docking kit，面板只负责往给定的框里画内容。
//
// 仓库卡的「切换」弹目录选择小窗口：与 DSH「添加工作区」共用宿主的目录选择器
// （uiWorkspace.listDirectory / createDirectory —— 宿主那个对话框内部走的也是这
// 两个方法），浏览 / 手输路径 / 新建文件夹都在里面完成。
// 该服务缺失时退化成只能手输绝对路径，面板本体照常工作。
//
// 本文件自上而下：
//   开关状态 → 同源 HTTP 通信 → 视觉基线（内联样式 + 局部样式表）
//   → 面板状态（一个 reducer）→ useGitPanel（状态与动作）→ 展示组件 → 插槽注册
//
// 帮助不走浮层：头部的「?」是指向宿主文档路由 GET /git-sidebar/help 的普通链接，
// 在新标签页打开（原生滚动/查找/打印/收藏），内容由 lib/help.js 生成。
//
// 数据经同源 HTTP /git-sidebar/* 读写宿主（lib/routes.js）。
// 开关的持久化用浏览器 localStorage（key: dsh-git-sidebar-enabled），
// 同页切换用自定义事件同步两个组件，跨标签页由 storage 事件兜底。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-git-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ── 这个 tab 类型的身份（右侧栏三段式注册的共用常量） ────────────────────
    //
    // 三段注册必须用**同一个 id**，所以它只在这里写一次：
    //   · sidebarRightTabs.register({ id, kind, … })  —— 声明这是什么 tab
    //   · sidebar.right.pane.tab       { key: id }    —— 标签正文
    //   · sidebar.right.pane.tab.title { key: id }    —— 标签标题
    //
    // id 取包名：右侧栏的类型注册表要求它在**所有注册里唯一**（kind 才允许被扩展
    // 覆盖），而包名天然唯一，官方那几个 tab 也是这么做的
    // （见 @deepseek-ai/dsh-client-ui-sidebar-files 的 FILES_ID）。
    const GIT_TAB_ID = 'dsh-git-sidebar'
    // kind 是「这一类标签是什么」的判别子，也是 openTab(kind) 的名字。用小写短名，
    // 与官方的 'files' / 'terminal' / 'browser' 同级。
    const GIT_TAB_KIND = 'git'
    /**
     * priority: 'extension' 是**默认档**，也是最高档 —— 产品之外的插件就该用这一档。
     * 显式写出来是为了让「这是第三方类型」这件事在代码里看得见，而不是靠默认值。
     */
    const GIT_TAB_PRIORITY = 'extension'

    // ── 开关状态：localStorage + 事件同步 ─────────────────────────────────

    const STORAGE_KEY = 'dsh-git-sidebar-enabled'
    const CHANGE_EVENT = 'dsh-git-sidebar:change'

    /**
     * 面板之外的改动只能靠定时读状态来发现（编辑器保存、终端命令、另一个会话、AI 工具
     * —— 它调的就是本插件的 git_* 工具）：宿主与浏览器之间只有「问一次答一次」的 HTTP，
     * 没有任何事件能把「git 变了」推给面板。
     *
     * 两档间隔：有未提交改动 → 20 秒（胶囊上的红点与改动数要跟得上编辑器的节奏）；
     * 干净仓库 → 60 秒。一次读状态 = 4 条本地 git（rev-parse + status + log + remote），
     * 代价很小，而**干净时恰恰是最需要轮询的时候**：切分支、拉取、别人替你提交，
     * 这些都发生在工作区干净的时候（见 useGitPanel 里的轮询 effect）。
     */
    const POLL_DIRTY_MS = 20000
    const POLL_CLEAN_MS = 60000

    // ── 旧版浮窗记忆的清理 ────────────────────────────────────────────────
    //
    // 旧版（dsh-git-panel 的浮层时代）把面板宽度与「收起成胶囊」存在 localStorage
    // 里，还留过帮助浮窗的位置/尺寸键。这一版没有任何自己的窗口壳：宽度、停靠/浮动
    // /分屏、以及「这个标签开没开」全部由右侧栏的 docking kit 拥有，那四个键再不
    // 会有任何读取方。插件加载时一并删掉，不留垃圾。
    const LEGACY_STORAGE_KEYS = [
      'dsh-git-sidebar-help-pos', 'dsh-git-sidebar-help-size',
      'dsh-git-sidebar-width', 'dsh-git-sidebar-min',
      // 旧插件的键（本插件是 dsh-git-panel 的侧边栏版，同一个浏览器里可能两个都装过）。
      'dsh-git-panel-width', 'dsh-git-panel-min',
    ]

    /** 清理旧键；隐私模式等 localStorage 不可用时静默跳过。 */
    function cleanupLegacyKeys() {
      try {
        for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key)
      } catch (error) {
        /* 忽略 */
      }
    }

    /** 读取开关；默认开启（首次安装即见面板）。 */
    function readEnabled() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw === null ? true : raw === '1'
      } catch (error) {
        return true
      }
    }

    /** 写入开关（localStorage 失败也不影响当前会话内的显示）。 */
    function writeEnabled(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value === true ? '1' : '0')
      } catch (error) {
        /* 隐私模式等场景忽略 */
      }
    }

    // ── 面板尺寸 / 折叠态的记忆（都是 localStorage，失败即静默） ────────────
    //
    // 已删除：这两个函数读的键属于旧版浮窗（宽度、最小化胶囊）。右侧栏的标签由
    // docking kit 管尺寸，没有「插件自己记住的宽度」这回事了。

    function writeStorage(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch (error) {
        /* 忽略 */
      }
    }

    // ── 「推送到 / 拉取自哪个远程」的记忆（按仓库目录各记一份） ──────────────
    //
    // 为什么按目录记而不是全局记一个：多远程是**每个仓库各不相同**的形态 ——
    // 同一个名字（origin）在一个仓库里是可写的、在另一个里是只读的。按目录记之后，
    // 「这个仓库我推 fork、从 origin 拉」不会跟着你跑到另一个仓库去。
    // 记住的值还必须是这个仓库**当前存在**的远程（见 remoteTargetFor）：远程被删掉
    // 或改了名字之后，不能还拿旧名字去推 / 去拉。
    //
    // 推与拉各一个键、共用同一套读写：表的形状（{ 仓库目录: 远程名 }）和校验规则完全
    // 一样，分成两份实现只会让下一次修 bug 漏掉其中一边 —— 而这两个选择本来就是
    // 「对称的一对」，用户也按对称去理解它们。
    const PUSH_REMOTE_KEY = 'dsh-git-sidebar-push-remote'
    const PULL_REMOTE_KEY = 'dsh-git-sidebar-pull-remote'

    /** 读回记忆表 { 仓库目录: 远程名 }；内容不合法就当作没有（宁可用默认值）。 */
    function readStoredRemoteTable(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const out = {}
        for (const dir of Object.keys(parsed)) {
          const value = parsed[dir]
          if (typeof dir === 'string' && dir.length > 0 && typeof value === 'string' && value.length > 0) {
            out[dir] = value
          }
        }
        return out
      } catch (error) {
        return {}
      }
    }

    /** 写入记忆表；空表就删掉这个键，不留垃圾。 */
    function writeStoredRemoteTable(key, table) {
      const keys = Object.keys(table)
      writeStorage(key, keys.length === 0 ? null : JSON.stringify(table))
    }

    const readStoredPushRemotes = () => readStoredRemoteTable(PUSH_REMOTE_KEY)
    const readStoredPullRemotes = () => readStoredRemoteTable(PULL_REMOTE_KEY)

    /**
     * 订阅开关状态：返回 [enabled, setEnabled]。
     * 同页用自定义事件即时同步（设置行 ↔ 面板），跨标签页由 storage 事件兜底。
     */
    function useEnabled() {
      const [enabled, setEnabled] = React.useState(readEnabled)
      React.useEffect(() => {
        const sync = () => setEnabled(readEnabled())
        window.addEventListener(CHANGE_EVENT, sync)
        window.addEventListener('storage', sync)
        return () => {
          window.removeEventListener(CHANGE_EVENT, sync)
          window.removeEventListener('storage', sync)
        }
      }, [])
      const update = (next) => {
        const value = next === true
        writeEnabled(value)
        setEnabled(value)
        try {
          window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch (error) {
          /* 忽略 */
        }
      }
      return [enabled, update]
    }

    // ── 与宿主通信（同源 HTTP） ───────────────────────────────────────────

    /**
     * 会话令牌（CSRF 加固）：宿主在 GET /state 与 GET /net 的响应里发一枚，此后
     * 所有 POST 必须带上。存在模块级变量而不是 React 状态里 —— 它不参与渲染，
     * 面板与设置开关两个组件共用同一枚，放进组件状态反而要同步两份。
     *
     * 读不到就保持空串：旧版宿主（或测试里的假 fetch）不发令牌时，POST 不带这个
     * 字段，行为与加固前完全一致；宿主一旦发过令牌，就得带对才放行。
     */
    let csrfToken = ''

    /** 记下响应里带的令牌（没有就原样返回数据）。 */
    function rememberCsrf(data) {
      if (data !== null && typeof data === 'object' && typeof data.csrf === 'string' && data.csrf.length > 0) {
        csrfToken = data.csrf
      }
      return data
    }

    /** 把令牌放进 POST 请求体（没拿到就不放，保持旧宿主兼容）。 */
    function withCsrf(payload) {
      if (csrfToken.length === 0) return payload
      return Object.assign({}, payload, { csrf: csrfToken })
    }

    /** 读取仓库状态。 */
    async function fetchState(dir) {
      const query = typeof dir === 'string' && dir.length > 0 ? '?dir=' + encodeURIComponent(dir) : ''
      const response = await fetch('/git-sidebar/state' + query, { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return rememberCsrf(data)
    }

    /** 执行一个 git 操作，返回 { ok, command, stdout, stderr, message, state, … }。 */
    async function postOp(payload) {
      const response = await fetch('/git-sidebar/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withCsrf(payload)),
      })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return rememberCsrf(data)
    }

    // ── 小谓词 ────────────────────────────────────────────────────────────
    //
    // 「有内容的字符串」和「宿主回的成功结果」在面板里出现了几十次，
    // 每次手写 `typeof x === 'string' && x.length > 0` / `data !== null && data.ok === true`
    // 既是噪音，也是漏判的来源（漏一次就是「明明成功了却报未知错误」）。

    /** 非空字符串。 */
    function hasText(value) {
      return typeof value === 'string' && value.length > 0
    }

    /** 宿主回的成功结果。 */
    function isOk(data) {
      return data !== null && data !== undefined && data.ok === true
    }

    /** 失败原因文本（宿主回 message，没有就退回 HTTP 状态）。 */
    function whyFailed(data, status) {
      return data !== null && data !== undefined && hasText(data.message) ? data.message : 'HTTP ' + status
    }

    /**
     * 警告**文字**的颜色，一处定义、面板内所有提醒共用。
     *
     * 为什么不是直接用 `state-warn-primary`（amber-500 / #f59e0b）：那个 token 在宿主里
     * 是给**填充块与边框**用的，拿它当 11px 正文色时浅色主题只有 2.15:1 ——
     * 「私有仓库请改用代理」这种必须读进去的句子，在浅色下基本看不清。
     *
     * 做法分两层（见 PANEL_CSS 里的 --dgs-warn-text）：
     *   1. 兜底 = 宿主专给警告文字的那一档 `state-warn-label`（amber-600 / #dd8629）；
     *   2. 支持 `color-mix` 时，把它朝当前主题的前景色压 40% ——
     *      浅色得到 #8b5721（6.03:1）、深色 #e8b47d（7.47:1），两个主题都过正文阈值，
     *      而且仍然是同一支琥珀色的深浅变化，不是面板自己发明的新颜色。
     * 用自定义属性而不是给每个站点加类名：颜色只声明一次，内联样式只管引用。
     */
    const WARN_TEXT = 'var(--dgs-warn-text, var(--dsw-alias-state-warn-label, #dd8629))'

    /**
     * 语义**文字**色，一处定义、面板内共用（同 WARN_TEXT 的理由）。
     *
     * 三个 `--dsw-alias-state-*-primary` 在宿主里都是给**填充块 / 描边**用的饱和色：
     * 拿它们当小号正文色时，浅色主题下都不够 —— 实测（.ui-preview/audit.js）：
     *   · `state-warn-primary`（#f59e0b）压白底 2.15:1、压代码块底 2.06:1
     *   · `state-success-primary`（#22c55e）压白底 2.28:1
     *   · `state-error-primary` 在深色下是 #f25a5a，压面板底 4.24:1
     * 所以文字一律走下面这三个变量：每一支都把宿主的那个色朝**当前主题的前景色**
     * 压暗/提亮到过阈值（浅色压暗、深色提亮 —— 同一个 40% 在两边都成立，因为
     * label-primary 本身就是随主题翻转的黑/白）。`color-mix` 不可用时退回宿主原色。
     */
    const GOOD_TEXT = 'var(--dgs-good-text, var(--dsw-alias-state-success-primary, #16a34a))'
    const BAD_TEXT = 'var(--dgs-bad-text, var(--dsw-alias-state-error-primary, #dc2626))'

    const S = {
      /**
       * 面板本体：宿主的「浮层」三件套 —— `bg-layer-2` 打底、`elevation-prominent`
       * 投影、`radius-lg` 圆角（与宿主自己的对话框同一套配方，见 app.asar 里
       * `.bjRJiG_menu` / `.list, .submenu` 那几条规则）。
       *
       * 这里**曾经**用 `--dsw-alias-bg-overlay` 当面板底色，是个货真价实的用错：
       * 那个 token 在宿主里是给「小徽章 / 遮罩」用的（`--dsw-static-neutral-bluish-150`，
       * 浅色 #e9ecf2、深色 #61666b），拿它当浮层底会同时坏掉两件事——
       *   浅色：面板变成一块灰底，里面的白卡片浮在灰上（层级对但显脏），
       *   深色：**面板比它自己的卡片还亮**（#61666b vs #232324），层级完全倒过来。
       * 实测（.ui-preview/audit.js，深色模式）：正文里的 12.5px 说明文字压在
       * #61666b 上只有 3.85:1，而区块标题只有 1.57:1 —— 整屏发灰、标头看不清。
       * 换成 `bg-layer-2`（浅 #fff / 深 #2c2c2e）之后，卡片用 `bg-layer-1`
       * （浅 #fff / 深 #232324）自然读作「面板里的凹陷内容块」，方向就对了。
       */
      /**
       * 标签正文的根：**填满右侧栏给的那块框**，不再是浮窗。
       *
       * 旧版（dsh-git-panel）这里是 position:fixed + right/bottom + zIndex —— 一个
       * 自己管位置和尺寸的浮层。现在位置、尺寸、停靠/浮动/分屏全部由右侧栏的
       * docking kit 决定，这里只负责「在给我的框里铺满、并让正文能滚」：
       *   · height:100% + minHeight:0 —— 让内部的 flex-basis:0 正文区能真正收缩，
       *     否则内容一长就把整列撑开（flex 子项的 min-height 默认是 auto）；
       *   · overflow:hidden —— 圆角与滚动收在框内，不外溢到相邻标签；
       *   · 去掉 zIndex / 阴影 / 投影 —— 框的层级与边缘由宿主画，插件再画一层就是两层。
       */
      panel: {
        height: '100%', minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        fontSize: '12.5px', lineHeight: 1.55, overflow: 'hidden',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px 8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #eeeeee)', fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)', userSelect: 'none',
      },
      title: { display: 'flex', alignItems: 'center', gap: '6px' },
      /** 头部右侧的图标按钮组：彼此只隔 2px，与标题之间用分隔线断开。 */
      headActions: { display: 'flex', alignItems: 'center', gap: '2px' },
      spacer: { flex: '1 1 auto' },
      mini: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '3px 7px', borderRadius: '7px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      body: {
        // flex-basis 0：正文区高度完全由容器剩余空间决定，不按内容高度参与
        // 布局——引擎差异下也能保证溢出时内部滚动可靠（basis:auto 会退化）。
        flex: '1 1 0%', minHeight: 0, padding: '10px 12px 12px',
        display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto',
        overscrollBehavior: 'contain',
      },
      /**
       * 分组卡片：把「同一件事」的几行圈进一个浅底描边块，避免一长串同权重的行。
       *
       * 描边用 `border-l2`（浅 rgba(0,0,0,.10) / 深 rgba(255,255,255,.12)）而不是
       * `border-l1`（浅 **.04**）：浅色主题下 `bg-layer-1/2/3` **三层全是纯白**，
       * 卡片的层次只能靠描边表达，而 .04 的黑几乎等于没有 —— 整块面板会糊成
       * 一张白纸（这正是改之前浅色截图的样子）。宿主自己的浅色对话框也走
       * 「更明显的描边 + 阴影」而不是靠底色区分（见 app.asar 的 `.sHDmOW_card`：
       * `border: .5px solid var(--dsw-alias-border-l4)`）。
       */
      card: {
        display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 10px',
        borderRadius: 'var(--dsw-radius-md, 12px)', border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      /**
       * 区块小标题：一道品牌色短杠 + 一行小字 + 一条细分隔线，用来切分
       * 「改动 / 同步 / 最近提交」。
       *
       * 字色用 `label-secondary`（浅 #61666b / 深 #cfd3d6）而不是 `label-caption`
       * （浅 #adb2b8 -> 白底 2.13:1、灰底 1.80:1；深色 4.24:1）—— caption 是给
       * 「正文里的小字注解」用的最淡一档，而这里是**分组标头**：实测它在 11px
       * 加粗下只有 1.8–2.1:1，比 WCAG 正文阈值 4.5:1 低了一半还多，扫读时几乎
       * 看不见（audit.js 的 FAILS 里它常年排最前）。加粗小字本来最怕发灰，
       * 而分组标头正是用户找段落用的东西。
       */
      sectionTitle: {
        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
        fontSize: '11px', fontWeight: 600, letterSpacing: '.06em',
      },
      /** 标题前的那道短杠。纯装饰，但它是「这一段从哪儿开始」最省字的标记。 */
      sectionTick: {
        flex: '0 0 auto', width: '3px', height: '11px', borderRadius: '2px',
        background: 'var(--dsw-alias-brand-primary, #2563eb)', opacity: 0.8,
      },
      sectionRule: { flex: '1 1 auto', height: '1px', background: 'var(--dsw-alias-border-l1, #eeeeee)' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      label: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      path: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 分支名允许收缩：太长的分支（feature/xxx 这类）不能把「管理」按钮顶出面板，
      // 收缩后省略号截断，全名交给 tooltip（见仓库卡的 title）。
      branch: {
        flex: '0 1 auto', minWidth: 0, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /**
       * 说明文字。textWrap 'pretty'：中文提示一行放不下换行时，避免末行只孤零零
       * 挂一个字符（浏览器支持时），配合提示文案自身的长度控制。
       */
      note: {
        flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)',
        textWrap: 'pretty',
      },
      /**
       * 就地告警（如「新分支名撞上了远端名」）：贴在输入框下面，不走命令结果栏 ——
       * 结果栏是「命令干完之后的回音」，而这条是「还没执行、先别点」。
       */
      warnText: {
        margin: '6px 0 0', fontSize: '11px', lineHeight: 1.5,
        color: WARN_TEXT,
      },
      /** 状态小胶囊：把「3 处改动（1 已暂存）」这类摘要收成一个视觉单元。
       *  底色用「代码块」那一档：bg-layer-3 在浅色主题下是纯白，胶囊就没有底、
       *  只剩一圈描边，读起来不像一个胶囊。 */
      chip: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2, #f5f5f5))',
        color: 'var(--dsw-alias-label-secondary, #666666)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)', whiteSpace: 'nowrap',
      },
      /**
       * 有未提交改动时的摘要胶囊：品牌色描边 + 一层极淡的品牌色底
       * （底色由 .dgs-chip-active 给，主题色换了它也跟着换），让「有东西要提交」一眼可见。
       */
      chipActive: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'transparent', color: 'var(--dsw-alias-brand-primary, #2563eb)',
        border: '1px solid var(--dsw-alias-brand-primary, #2563eb)', whiteSpace: 'nowrap',
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      /** 提交表单：输入框一行、动作一行（见 CommitForm 的注释）。 */
      commitForm: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '0 0 auto' },
      commitActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
      box: { display: 'flex', gap: '6px', alignItems: 'center' },
      input: {
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', padding: '5px 9px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
      },
      list: {
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '5px',
        // flex 0 0 auto 不能省：面板正文是「可滚动的 flex 列」，而 overflow:auto 的
        // 子项自动最小尺寸是 0 —— 默认的 flex-shrink:1 会把列表压扁。早先展开 diff
        // 时改动清单被挤成一条缝，看着就像「diff 把清单盖住了」，根因就在这里。
        // 列表自己会滚，所以它永远不需要被压：宁可让正文整体滚动。
        flex: '0 0 auto', maxHeight: '148px', overflowY: 'auto', borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      item: { display: 'flex', gap: '7px', minWidth: 0, alignItems: 'center' },
      /**
       * 一个远程仓库占一行：名字（固定宽度，多个远程时竖排对齐）+ 地址（可收缩，
       * 省略号截断、tooltip 给全）+ 动作。
       *
       * 名字用等宽字体：远程名是 git 的标识符（origin / fork / upstream），
       * 等宽下不同行的名字看起来是「同类」，不容易和右侧的地址混淆。
       *
       * **允许换行**，并且地址有最小宽度 —— 这两条是一起加的，缺一不可：
       * 一行里要塞「名字 + 地址 + 最多 5 个按钮」，实测 360px 面板下按钮就吃掉
       * 238px，地址被压到 **10px**（渲染成 `g...`，等于这一行根本没有地址；
       * 见 .ui-preview/audit.js 的 REMOTE ROWS）。加 `flexWrap` 后，按钮宁可
       * 换到第二行，也不再把地址挤没；`rowGap` 让换行后的两行有间距。
       */
      remoteRow: {
        display: 'flex', flexWrap: 'wrap', gap: '6px', rowGap: '4px', minWidth: 0, alignItems: 'center',
        padding: '2px 0',
      },
      remoteName: {
        flex: '0 0 auto', maxWidth: '84px', fontFamily: 'ui-monospace, Menlo, monospace',
        fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /**
       * 远程地址：可收缩但**有下限**（minWidth 由内联给，见调用处）——
       * 低于这个宽度就只剩 `https://git...`，用户看不出这是哪个仓库，
       * 而这个地址正是「我到底连的是哪儿」的唯一答案。
       */
      remoteUrl: {
        flex: '1 1 auto', minWidth: 0, color: 'var(--dsw-alias-label-secondary, #666666)',
        fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /** 编辑既有远程时左侧那个只读的名字（改名=删除重建，所以这里不可编辑）。 */
      remoteEditName: {
        flex: '0 0 auto', maxWidth: '84px', fontFamily: 'ui-monospace, Menlo, monospace',
        fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /**
       * 远端分支的远程分组标题：比区块小标题更轻（更小的字号、无左侧竖杠），
       * 因为它是**区块内部**的第二层分组，不能和「本地分支 / 远端分支」同级。
       */
      groupTitle: {
        display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', paddingLeft: '2px',
        color: 'var(--dsw-alias-label-secondary, #666666)', fontSize: '11px', fontWeight: 600,
      },
      groupName: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace' },
      // 这里**曾经**有一个 groupBadge（「当前跟踪」挂在组标题上）。0.19 把它下沉到了
      // 具体那一行（见 currentTag）：组标题只回答「属于哪个远程」，而「我跟踪的是
      // 哪一条」必须落在行上，否则行一多还得在组里再找一遍。
      /**
       * 本地分支行上的跟踪标签：`→ origin/master` 或 `未跟踪`。
       * 字号比分支名小、颜色更淡 —— 它是注解，不是主信息；但必须与名字同一行，
       * 否则「哪个本地分支对应哪个远端」又要靠用户自己脑补。
       */
      trackTag: {
        flex: '0 1 auto', minWidth: 0, fontSize: '10.5px', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 暂存状态标记：实心=已暂存、空心=未暂存。不靠颜色单独表意（色觉差异）。 */
      marker: { flex: '0 0 auto', fontSize: '9px', lineHeight: 1 },
      /**
       * 「默认」徽章：远端默认分支的角标。**独立于名字渲染**（flex 0 0 auto），
       * 名字被省略号截断时徽章仍然完整可见 —— 原先「（默认）」写在名字字符串后面，
       * 名字一截断标记就跟着消失，用户于是在一大串分支里找不到默认分支。
       */
      headBadge: {
        flex: '0 0 auto', padding: '0 6px', borderRadius: '999px', fontSize: '10px',
        lineHeight: '16px', fontWeight: 600, whiteSpace: 'nowrap',
        color: GOOD_TEXT,
        border: '1px solid rgba(22, 163, 74, .35)',
        background: 'rgba(22, 163, 74, .12)',
      },
      /**
       * 行内的「当前跟踪」徽章：当前分支跟踪的就是这一条远端分支（或这一条就是当前
       * 本地分支）。原先它挂在整个远程分组的标题上 —— 只说明「这组里有一条是你跟的」，
       * 行一多还得在组里再找一遍。挂在行上才是「一眼看到是哪一条」。
       */
      currentTag: {
        flex: '0 0 auto', padding: '0 6px', borderRadius: '999px', fontSize: '10px',
        lineHeight: '16px', fontWeight: 600, whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-brand-primary, #2563eb)',
        border: '1px solid rgba(37, 99, 235, .35)',
        background: 'rgba(37, 99, 235, .10)',
      },
      /**
       * 远端行上的交叉引用标记（`↩ fork-local.2`）：本地已经有哪条分支在跟踪它。
       *
       * 这是本次修掉的「越用越乱」的正面解法 —— 没有它，用户看不出这条远端分支自己
       * 已经有了，点「拿成新分支」就会得到 `fork-local.2-2`。字号比名字小、颜色更淡：
       * 它是注解，不是主信息（与本地行的跟踪标签同一层级）。
       */
      ownerTag: {
        flex: '0 1 auto', minWidth: 0, fontSize: '10.5px', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /**
       * 分支行「⋯」展开的次级动作 / 「设置上游」选择器：**就地展开在该行下面**，
       * 与「点改动看 diff」「点提交看详情」是同一套交互（面板里只有这一种展开方式，
       * 不引入浮层：360px 的浮层面板里，弹层很容易跑出可视区）。
       */
      rowMenu: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px',
        padding: '6px 8px 8px 26px', margin: '0 0 2px',
        borderLeft: '2px solid var(--dsw-alias-brand-primary, #2563eb)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, .03))',
        borderRadius: '0 8px 8px 0',
      },
      /** 展开区里的一句说明（占满一行）：写清这次展开的是哪条分支。 */
      menuTitle: {
        flexBasis: '100%', fontSize: '10.5px', lineHeight: '15px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /**
       * 状态码（` M` / `M ` / `??`）。外面再套 .dgs-code 给它一个等宽小徽章的样子 ——
       * 徽章靠 CSS 给（字号、内边距、底色），这里只保留「已暂存 = 成功色」这一层语义。
       */
      code: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: WARN_TEXT },
      /**
       * 提交短哈希。等宽、比正文淡一档，但仍然要读得清：走 `label-secondary`
       * （浅 #61666b -> 白底 5.80:1）而不是 `label-tertiary`（#81858c -> 3.71:1，
       * 低于 12.5px 正文该有的 4.5:1）。哈希是这一行的「链接锚点」，
       * 用户正是靠它把手上的提交和列表对上号，不该是最淡的一档。
       */
      hash: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-secondary, #666666)' },
      name: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      out: {
        margin: 0, padding: '9px', flex: '0 0 auto', maxHeight: '132px', overflow: 'auto', borderRadius: 'var(--dsw-radius-sm, 8px)',
        // 内嵌表面：优先用宿主主题的「代码块」底色（浅 #f9fafb / 深 #1b1b1c）。
        // 顺序很关键 —— `bg-layer-3` 在**浅色主题下同样是纯白**（宿主
        // bg-layer-1/2/3 三层全白），拿它当首选会让代码块和卡片糊成一片；
        // markdown-code-block 才是那个「比底色深一点」的档位，深色主题下
        // 也比面板底更暗，方向上正是一块凹陷的内嵌面。
        background: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05)))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /**
       * 改动 diff：**内联展开在被点的那一行下面**，是改动清单的一部分。
       *
       * 这里刻意不给自己滚动条、也不设 maxHeight —— 它和文件行共用清单那一个滚动区。
       * 早先它是清单外面的独立框：面板正文本来就要滚动，展开后它既挤掉清单的高度、
       * 又常常落到可视区之外，用户看到的就是「diff 把改动清单盖住了」。
       */
      diff: {
        margin: '2px 0 4px', padding: '9px', flex: '0 0 auto', borderRadius: 'var(--dsw-radius-sm, 8px)',
        // 与命令结果同一块内嵌面（顺序理由见 S.out 的注释）。
        background: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-3, rgba(0,0,0,.05)))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /**
       * diff / 提交详情上方的小标题条：写清「现在展开的是哪个文件（或哪条提交）」。
       * 展开的那一行可能已经被滚出视野，这一条就是那块内容的抬头，同时钉在它正上方。
       */
      diffTitle: {
        display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto',
        padding: '2px 1px 0', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 小标题条里的路径：等宽、可省略，全名交给 tooltip。 */
      diffPath: {
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontFamily: 'ui-monospace, Menlo, monospace',
      },
      /** 帮助入口：头部那个「?」，是一个新标签页链接（帮助是独立 HTML 文档，
       *  不在浮层里画窗口——文档页有原生滚动/查找/打印，还能收藏）。 */
      miniLink: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '3px 7px', borderRadius: '7px', textDecoration: 'none',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 网络加速折叠块：展开时才占地方，平时不打扰日常操作。 */
      netBox: {
        display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 10px',
        borderRadius: 'var(--dsw-radius-md, 12px)', border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      netRow: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' },
      /** 「需要你选一个结果」的选择区：标题 + 若干按钮（每个按钮下面写清后果）。 */
      choiceBox: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '9px 10px',
        borderRadius: 'var(--dsw-radius-md, 12px)', border: '1px solid var(--dsw-alias-state-warn-primary, #d97706)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      choiceItem: { display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' },
      netTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 },
      select: {
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', padding: '5px 7px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
      },
      /** 勾选框不参与 flex 拉伸，否则会被压成一条线。 */
      check: { flex: '0 0 auto', margin: 0 },
      /** 安全提醒（镜像会把请求转给第三方）用警告色，不能混在普通说明里。 */
      warn: {
        fontSize: '11px', lineHeight: 1.5,
        color: WARN_TEXT,
      },
      /** 警告行 + 行内动作按钮（如「两个远程指向同一地址」那一行）：允许换行，别把按钮挤出去。 */
      warnRow: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px',
        fontSize: '11px', lineHeight: 1.5,
        color: WARN_TEXT,
      },
      good: { flex: '0 0 auto', color: GOOD_TEXT },
      bad: { flex: '0 0 auto', color: BAD_TEXT },
      probeMs: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      /** 空态说明（还不是仓库 / 工作区干净）：虚线框 + 居中弱化文字。 */
      empty: {
        padding: '14px 10px', borderRadius: 'var(--dsw-radius-md, 12px)', textAlign: 'center',
        border: '1px dashed var(--dsw-alias-border-l2, #dddddd)',
        color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '12px',
      },
      /** 空态的大图标：给这块灰字一个视觉落点，也让「空」和「坏了」看起来不一样。 */
      emptyIcon: { fontSize: '22px', lineHeight: 1.4, opacity: 0.9 },
      /** 设置行：与官方设置项的版式保持一致（分隔线 + 左标题右控件）。 */
      settingRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, #dddddd)',
      },
      settingText: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      /** 设置行右侧的控件组（「打开」+ 开关）：并排，间距与官方设置项一致。 */
      settingActions: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
      settingTitle: { fontSize: '14px', fontWeight: 400, color: 'var(--dsw-alias-label-primary, #111111)' },
      settingHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666666)' },

      // ── 面板下半部分的固定区（都在正文滚动区之外） ──────────────────────
      //
      // 这三块不参与正文滚动：命令结果与「要你选一个结果」都是**刚刚那一下动作的
      // 回音**，滚到看不见就等于没回音；底部状态条则是「我一直在哪儿」的常驻信息。

      /** 固定区容器：本身不滚，内部各块自己滚。上方一条分隔线把它和滚动正文分开。 */
      footer: {
        display: 'flex', flexDirection: 'column', gap: '8px', flex: '0 0 auto',
        padding: '8px 12px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
      },
      /** 结果区里的小动作条（「清空」这类）。 */
      outBar: {
        display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto',
      },
      /** 结果块：标题条 + 那块结果本身。 */
      outBlock: {
        display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto', minHeight: 0,
      },
      /** 底部状态条：分支 + 改动数 + 上一次操作的结果，点一下回到顶部。 */
      status: {
        display: 'flex', alignItems: 'center', gap: '7px', flex: '0 0 auto',
        padding: '6px 12px', cursor: 'pointer', userSelect: 'none',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
        background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
        fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /**
       * 上一次操作的结果点：绿=成功、红=失败、灰=还没操作过。
       * 灰点走 `label-tertiary`（#81858c，白底 3.71:1）：它是 9px 的**图形指示器**，
       * 按 WCAG 1.4.11 的 3:1 判，不是正文的 4.5:1 —— audit.js 对单个符号也按 3:1 判。
       */
      statusDot: { flex: '0 0 auto', fontSize: '9px', lineHeight: 1 },
      statusText: {
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /**
       * 状态条右侧的 `→ origin/main`。11px 正文，走 `label-secondary`
       * （浅 #61666b -> 5.80:1；深 #cfd3d6 -> 9.25:1）而不是 `label-tertiary`
       * （#81858c -> 白底 3.71:1，低于阈值）—— 它写的是「我这条分支跟踪谁」，
       * 是状态条上要被读的第二个信息，不是装饰。
       */
      statusTail: {
        flex: '0 0 auto', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /**
       * 状态条上的「名称不一致」小标。颜色走产品主题变量，明暗主题都自适应；
       * 加粗只是为了让它在 11px 的一行里也能被一眼看到。
       */
      statusWarn: {
        flex: '0 0 auto', whiteSpace: 'nowrap', fontWeight: 600,
        color: WARN_TEXT,
      },
      /**
       * 忙碌指示（头部那个小圈）：border 只给上边着色 + 旋转，就是最常见的转圈。
       * 旋转动画由 .dgs-spin 提供 —— 关掉动画（prefers-reduced-motion）时它退化成
       * 一个静止的小圈，仍然表示「正在忙」。
       */
      busyDot: {
        flex: '0 0 auto', width: '8px', height: '8px', borderRadius: '999px',
        border: '1.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.20))',
        borderTopColor: 'var(--dsw-alias-brand-primary, #2563eb)',
      },
    }

    // ── 面板局部样式表 ───────────────────────────────────────────────────
    //
    // 渲染成一个 <style> 元素随组件挂载，卸载即回收（不写全局样式表、不动宿主 DOM）。
    //
    // 为什么必须有它：内联 style 表达不了 :hover / :focus-visible / 过渡 / 滚动条
    // 外观，diff 与命令结果的分行着色也需要真实选择器。基础外观仍然留在 S 里
    // （见上），所以本样式表失效时界面依然可用 —— 这也是为什么这里的悬停覆盖
    // 必须带 !important：内联样式优先级高于样式表，这是有意为之，不是偷懒。
    const PANEL_CSS = [
      '.dgs-panel *{box-sizing:border-box}',
      // 面板自己的 token 层：内联样式里只写 `var(--dgs-*)`，主题相关的取值集中在这里。
      // 定义在**每一个根容器**上（面板 / 胶囊 / 目录选择小窗口）—— 这三者是平级的
      // 顶层节点，挂在 .dgs-panel 上时另外两个拿不到（它们内部也有警告文字）。
      // --dgs-warn-text：警告文字的配色，两层回退 ——
      //   color-mix 把宿主的「警告文字」档朝当前主题的前景色压 40%：浅色 #8b5721
      //   （白底 6.03:1）、深色 #e8b47d（深底 7.47:1），都过正文阈值；
      //   引擎不支持 color-mix 时由下面的 @supports 换回 warn-label 原色。
      '.dgs-panel,.dgs-pick-mask{--dgs-warn-text:color-mix(in srgb,var(--dsw-alias-state-warn-label,#dd8629) 60%,var(--dsw-alias-label-primary,#111111))}',
      // 成功 / 失败的文字同理：宿主的 state-success-primary(#22c55e) 与深色下的
      // state-error-primary(#f25a5a) 都是「填充色」，当 10–12px 的文字用不够
      // （前者压白底 2.28:1、后者压深色面板 4.24:1，见 S 里 GOOD_TEXT/BAD_TEXT 注释）。
      // 同样朝当前主题的前景色压 40%：浅色压暗、深色提亮，与 warn 是同一套做法。
      '.dgs-panel,.dgs-pick-mask{--dgs-good-text:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 60%,var(--dsw-alias-label-primary,#111111));--dgs-bad-text:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 60%,var(--dsw-alias-label-primary,#111111))}',
      '@supports not (color:color-mix(in srgb,red 50%,blue)){.dgs-panel,.dgs-pick-mask{--dgs-warn-text:var(--dsw-alias-state-warn-label,#dd8629);--dgs-good-text:var(--dsw-alias-state-success-primary,#16a34a);--dgs-bad-text:var(--dsw-alias-state-error-primary,#dc2626)}}',
      // 面板出现时轻轻上浮一下：浮层「出现」比「弹出」少一点突兀。
      '@keyframes dgpIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.dgs-panel{animation:dgpIn .16s ease-out}',
      // 头部顶端一道品牌色渐变横条：整个面板的「身份条」，换主题色它跟着换。
      '.dgs-head{position:relative}',
      '.dgs-head::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary,#2563eb),transparent 72%)}',
      // 细滚动条：默认滚动条在这个 360px 的小面板里太抢眼。
      // 颜色走宿主自己的滚动条令牌（浅色 neutral-200 / 深色 neutral-600），
      // 悬停用它的 hover 档 —— 不拿 border-l2 凑（那是给描边用的，深色下偏亮）。
      '.dgs-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dgs-panel ::-webkit-scrollbar-track{background:transparent}',
      '.dgs-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,var(--dsw-alias-border-l2,rgba(0,0,0,.18)));border-radius:999px}',
      '.dgs-panel ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,var(--dsw-alias-label-tertiary,rgba(0,0,0,.3)))}',
      // 按钮：统一高度（成排的按钮不再高低不齐）、悬停/按下/键盘焦点
      '.dgs-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:26px;transition:background-color .12s ease,border-color .12s ease,filter .12s ease,transform .08s ease}',
      '.dgs-btn-compact{min-height:20px}',
      '.dgs-btn:not(:disabled):hover{filter:brightness(.95)}',
      '.dgs-btn:not(:disabled):active{transform:translateY(1px)}',
      // 焦点环走**宿主的焦点系统**（--dsw-focus-ring-color / -width）而不是自己写死品牌色：
      // 宿主的 `:focus-visible` 全局规则用 state-business-primary（蓝）描环，并且会在
      // 「指针操作」的模态下把 --dsw-focus-ring-color 置成 transparent（点鼠标不该留焦点环）。
      // 面板原先写死 `2px solid brand-primary`，浅色主题下品牌色接近黑 —— 焦点环和
      // 面板描边撞色，而且样式与宿主其它控件不一致。跟着令牌走，两边自动对齐。
      '.dgs-btn:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:1px}',
      '.dgs-btn-ghost:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important}',
      // 主按钮：顶上压一层极淡的高光，实心色因此有点体积感；悬停用宿主的
      // 「主按钮悬停色」而不是整体调亮度（品牌色在深色主题里是白的，提亮等于没反应）。
      '.dgs-btn-primary{background-image:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0))}',
      '.dgs-btn-primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover,#3b82f6)!important;filter:none}',
      '.dgs-btn-danger:not(:disabled):hover{background:var(--dsw-alias-state-error-primary,#dc2626)!important;color:#fff!important;border-color:var(--dsw-alias-state-error-primary,#dc2626)!important}',
      // 危险按钮不要那层高光：它悬停时是实心错误色，再有高光会显得像主操作。
      '.dgs-btn-danger{background-image:none}',
      // 有未提交改动时的摘要胶囊：品牌色描边 + 一层极淡的品牌色底
      '.dgs-chip-active{background:rgba(37,99,235,.10)!important;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 12%,transparent)!important}',
      // 状态码 / 提交短哈希的小徽章：等宽、定宽、浅底，纵向对得齐。
      // 底色同样走「代码块」那一档：bg-layer-3 在浅色主题下是纯白，徽章会没有底。
      '.dgs-code{display:inline-block;min-width:22px;padding:0 4px;border-radius:var(--dsw-radius-xs,4px);text-align:center;font-size:10px;line-height:15px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-3,rgba(0,0,0,.05)))}',
      '.dgs-hash{min-width:0;text-align:left;background:transparent}',
      // 头部图标按钮 / 最小化后的胶囊
      '.dgs-mini{transition:background-color .12s ease,color .12s ease}',
      '.dgs-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important;color:var(--dsw-alias-label-primary,#111111)!important}',
      '.dgs-mini:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:1px}',
      // 有改动时那颗红点轻轻呼吸：余光里也能察觉「还有东西没提交」
      // （旧版这里还有 .dgs-pill 的悬停上浮 —— 胶囊随浮窗一起去掉了）。
      '@keyframes dgpPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dgs-pulse{animation:dgpPulse 1.6s ease-in-out infinite}',
      // 忙碌指示：转圈（关掉动画时退化成一个静止的小圈，仍然表示「正在忙」）
      '@keyframes dgpSpin{to{transform:rotate(360deg)}}',
      '.dgs-spin{animation:dgpSpin .9s linear infinite}',
      // 列表行：整行悬停，可点的行给出手型与焦点环
      '.dgs-rowitem{border-radius:6px;padding:2px 5px;margin:0 -3px;transition:background-color .12s ease}',
      '.dgs-rowitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      // 当前展开了 diff 的那一行：左侧一道品牌色短杠，和它下面那块 diff 对上号。
      // 用伪元素而不是 inset 阴影：行有 6px 圆角，阴影会被圆角剪成「［」形；短杠
      // 自己做圆角，和区块标题前的那道 tick 是同一个视觉语言。
      '.dgs-rowitem-active{position:relative;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgs-rowitem-active::before{content:"";position:absolute;left:-1px;top:2px;bottom:2px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dgs-clickable{cursor:pointer}',
      '.dgs-clickable:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:1px}',
      // 输入框：聚焦时给一圈可见的焦点环（内联里没有 border-color 的悬停态）
      '.dgs-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb)!important;box-shadow:0 0 0 3px rgba(37,99,235,.16)}',
      // 命令结果 / diff / 提交详情：同一套「内嵌代码块」外观（细边框 + 圆角）
      '.dgs-pre{border:1px solid var(--dsw-alias-border-l1,#eeeeee)}',
      // diff 逐行着色 + 行底纹：文件头/区块头/新增/删除各一色，新增与删除再给一层底色，
      // 一屏 diff 因此可以直接扫出「加了哪些、删了哪些」，而不是逐字读颜色。
      '.dgs-diff-line{display:block;padding:0 6px}',
      '.dgs-diff-meta{color:var(--dsw-alias-label-tertiary,#999999)}',
      '.dgs-diff-hunk{color:var(--dsw-alias-state-business-primary,#2563eb);font-weight:500;background:rgba(37,99,235,.08);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 10%,transparent)}',
      '.dgs-diff-add{color:var(--dgs-good-text,var(--dsw-alias-state-success-primary,#16a34a));background:rgba(22,163,74,.10);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 13%,transparent)}',
      '.dgs-diff-del{color:var(--dgs-bad-text,var(--dsw-alias-state-error-primary,#dc2626));background:rgba(220,38,38,.10);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 13%,transparent)}',
      // 命令结果栏分行着色：命令回显 / stderr / 加速说明 / 下一步提示
      '.dgs-out-cmd{color:var(--dsw-alias-label-secondary,#666666)}',
      '.dgs-out-err{color:var(--dgs-bad-text,var(--dsw-alias-state-error-primary,#dc2626))}',
      '.dgs-out-note{color:var(--dgs-warn-text,var(--dsw-alias-state-warn-label,#dd8629))}',
      '.dgs-out-hint{color:var(--dsw-alias-state-business-primary,#2563eb)}',
      // 操作成功时结果栏闪一下：点「全部暂存」之类的按钮后，这一下短暂的描边
      // 告诉他「刚才那一下有回音」。
      '@keyframes dgpFlash{from{box-shadow:0 0 0 3px rgba(37,99,235,.35)}to{box-shadow:0 0 0 0 rgba(37,99,235,0)}}',
      '.dgs-out-flash{animation:dgpFlash .8s ease-out}',
      // 底部状态条与浮层里的「点一下」元素：悬停给底色，键盘焦点给焦点环
      '.dgs-status:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgs-status:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:-2px}',
      // 目录选择小窗口：淡入 + 轻微上浮（与面板出现同一套动效语言）
      '@keyframes dgpFadeIn{from{opacity:0}to{opacity:1}}',
      '.dgs-pick-mask{animation:dgpFadeIn .12s ease-out}',
      '.dgs-pick-card{animation:dgpIn .16s ease-out}',
      // 目录行：整行可点（单击选中、双击进入），选中态沿用列表行那道品牌色短杠
      '.dgs-pick-row{display:flex;align-items:center;gap:7px;width:100%;padding:5px 9px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dgs-pick-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgs-pick-row:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:-1px}',
      '.dgs-pick-row-selected{position:relative;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dgs-pick-row-selected::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#2563eb)}',
      // 面包屑与「显示隐藏文件」这类文字型小按钮
      '.dgs-pick-crumb{padding:2px 5px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666666);font:inherit;white-space:nowrap;cursor:pointer}',
      '.dgs-pick-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111111)}',
      '.dgs-pick-crumb:focus-visible{outline-style:solid;outline-width:var(--dsw-focus-ring-width,2px);outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));outline-offset:-1px}',
      // 尊重「减少动态效果」：所有装饰性动画一并关掉（转圈退化成静止小圈）
      '@media (prefers-reduced-motion: reduce){.dgs-panel{animation:none}.dgs-pulse,.dgs-spin{animation:none}.dgs-pick-mask,.dgs-pick-card{animation:none}}',
    ].join('')

    /** 局部样式表元素：跟着组件一起挂载/卸载，不产生全局副作用。 */
    function panelStyles() {
      return React.createElement('style', { key: 'dgs-css' }, PANEL_CSS)
    }

    /**
     * 把多行文本渲染成带分行的 <pre>：每行一个 <span>，按行首特征着色。
     * 文本内容一字不改（换行原样保留），所以「结果栏里有什么」仍然可以整段
     * 复制、搜索、被测试按纯文本断言。
     */
    function renderLines(text, style, classify, key, ref, ariaLive) {
      const lines = String(text).split('\n')
      return React.createElement('pre', {
        style: style,
        key: key,
        ref: ref,
        // 代码块的统一外观（细边框 + 圆角）由样式表给：内联只写文字与布局。
        className: 'dgs-pre',
        // 结果栏是异步写入的：让读屏软件把「刚才那条命令的结果」播报出来。
        'aria-live': ariaLive,
      },
        lines.map((line, index) => React.createElement('span', {
          key: 'l' + index,
          className: classify === undefined ? undefined : classify(line),
        }, index === lines.length - 1 ? line : line + '\n')))
    }

    /** diff 行着色：文件头/区块头/新增/删除各一色，其余保持默认前景色。 */
    function diffLineClass(line) {
      if (line.startsWith('@@')) return 'dgs-diff-line dgs-diff-hunk'
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')
        || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ')
        || line.startsWith('similarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
        return 'dgs-diff-line dgs-diff-meta'
      }
      if (line.startsWith('+')) return 'dgs-diff-line dgs-diff-add'
      if (line.startsWith('-')) return 'dgs-diff-line dgs-diff-del'
      return 'dgs-diff-line'
    }

    // ── 结果栏与按钮：小件 ────────────────────────────────────────────────

    /**
     * 命令结果行的前缀字符。**与 outputLineClass 是一对**：'⇢ ' 走 note 色、
     * '→ ' 走 hint 色，改一处必须改另一处，所以它们只在这里定义一次。
     */
    const OUT_CMD = '$ '
    const OUT_ERR = '[stderr] '
    const OUT_NOTE = '⇢ '
    const OUT_HINT = '→ '

    /** 命令结果行着色：命令回显、stderr、加速说明、下一步提示各一色。 */
    function outputLineClass(line) {
      if (line.startsWith(OUT_CMD)) return 'dgs-out-cmd'
      if (line.startsWith(OUT_ERR)) return 'dgs-out-err'
      if (line.startsWith(OUT_NOTE)) return 'dgs-out-note'
      if (line.startsWith(OUT_HINT)) return 'dgs-out-hint'
      return undefined
    }

    /**
     * 命令结果栏的文本行。文本一字不改，只是把「哪一行是什么」编码进前缀，
     * 再由 outputLineClass 还原成颜色 —— 整段结果因此仍可复制、搜索、被测试断言。
     */
    function opOutputLines(data) {
      const parts = []
      if (typeof data.command === 'string') parts.push(OUT_CMD + data.command)
      if (hasText(data.stdout)) parts.push(data.stdout.replace(/\s+$/, ''))
      if (hasText(data.stderr)) parts.push(OUT_ERR + data.stderr.replace(/\s+$/, ''))
      if (hasText(data.message)) parts.unshift(data.message)
      if (Array.isArray(data.notes)) {
        for (const note of data.notes) parts.push(OUT_NOTE + String(note))
      }
      if (hasText(data.hint)) parts.push(OUT_HINT + data.hint)
      return parts
    }

    /**
     * 按钮外观。primary = 主操作（实心品牌色）；danger = 破坏性操作（平时只用错误色
     * 文字，悬停才变实心，避免「丢弃改动」和普通按钮长得一样）；其余是次要按钮。
     *
     * 基础外观写在内联样式里（样式表没生效也不至于裸奔），悬停/按下/焦点环由
     * PANEL_CSS 提供 —— 内联优先级更高，所以那里的覆盖带 !important。
     */
    function buttonStyle(primary, disabled, danger, compact, hot) {
      const filled = primary === true
      const small = compact === true
      const accent = hot === true
      return {
        padding: small ? '2px 6px' : '4px 10px',
        borderRadius: small ? '6px' : '8px',
        fontSize: small ? '11px' : '12px',
        whiteSpace: 'nowrap',
        fontWeight: filled === true || accent === true ? 500 : 400,
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        // hot：平时不动声色，只在「现在最该点它」时描一圈品牌色（例如脏工作区下的
        // 「安全拉取」）。它不改变按钮的主次关系，所以不抢「推送」的实心样式。
        border: filled === true || accent === true
          ? '1px solid var(--dsw-alias-brand-primary, #2563eb)'
          : '1px solid var(--dsw-alias-border-l2, #dddddd)',
        // 实心按钮的底色与文字色都必须走令牌：品牌色在浅色主题里接近黑、在深色主题里
        // 接近白，文字写死 #fff 在深色主题下就成了「白底白字」——按钮直接消失
        // （这正是空态里「初始化仓库 / 开始克隆」曾经的样子）。
        background: filled === true
          ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))'
          : 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: filled === true
          ? 'var(--dsw-alias-label-primary-foreground, #ffffff)'
          : (danger === true
              ? BAD_TEXT
              : (accent === true ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111111)')),
      }
    }

    /** 按钮的类名：实心/次要 + 危险色 + 悬停与焦点环（见 PANEL_CSS）。 */
    function buttonClass(primary, danger) {
      return 'dgs-btn'
        + (primary === true ? ' dgs-btn-primary' : ' dgs-btn-ghost')
        + (danger === true ? ' dgs-btn-danger' : '')
    }

    /**
     * 面板里的一个按钮。locked = 面板正忙（统一禁用，避免并发操作）。
     * compact 的按钮还要挂一个 .dgs-btn-compact —— 成排的小按钮（改动行里那三个）
     * 不能被样式表里「统一按钮高度」的规则撑高，否则一行改动会占掉两行的位置。
     */
    function panelButton(label, onClick, options) {
      const opts = options === null || options === undefined ? {} : options
      const primary = opts.primary === true
      const danger = opts.danger === true
      const locked = opts.locked === true
      const compact = opts.compact === true
      const hot = opts.hot === true
      return React.createElement('button', {
        key: opts.key === undefined ? label : opts.key,
        type: 'button',
        className: buttonClass(primary, danger) + (compact === true ? ' dgs-btn-compact' : ''),
        style: buttonStyle(primary, locked, danger, compact, hot),
        disabled: locked,
        title: typeof opts.title === 'string' && opts.title.length > 0 ? opts.title : undefined,
        onClick: onClick,
      }, label)
    }

    /**
     * 面板里的一个外链：外观与次要按钮一致，但语义是跳转而不是动作 ——
     * 「打开仓库页」这类入口必须用 <a>：浏览器会保留中键 / 长按 / 复制地址，
     * <button> 全都没有。新标签页打开（target=_blank），rel 带上 noopener。
     *
     * `options.compact` 必须**透传**给 buttonStyle 与类名。这里曾经漏掉它，
     * 于是「仓库页 ↗」在一排 20px 的紧凑按钮（推送到此 / 从此外拉 / 复制 / 改）
     * 中间独自长成 26px —— 实测同一行里 22px 与 27px 两档高度并存，
     * 整行看着就是歪的，外层 flex 的 `align-items:center` 只会把这种不等高
     * 摆得更明显。外观（次要按钮）与紧凑度是两件事，不能一起丢。
     */
    function panelLink(label, href, title, key, options) {
      const opts = options === null || options === undefined ? {} : options
      const compact = opts.compact === true
      return React.createElement('a', {
        key: key,
        href: href,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: title,
        className: 'dgs-btn dgs-btn-ghost' + (compact === true ? ' dgs-btn-compact' : ''),
        style: buttonStyle(false, false, false, compact),
      }, label)
    }

    // ── 派生小函数（纯计算，无状态） ──────────────────────────────────────

    /** 已暂存的条目数。 */
    function stagedCount(changes) {
      let staged = 0
      for (const item of changes) {
        if (item !== null && typeof item === 'object' && item.staged === true) staged += 1
      }
      return staged
    }

    /**
     * 改动摘要：**总数用宿主回的真实条数**（changesTotal），已暂存数只能按当前
     * 列表算（宿主最多回 100 条）。混用会让胶囊上的数字和「还有 N 处未显示」对不上。
     */
    function changesSummary(total, changes) {
      if (total === 0) return '没有改动'
      const staged = stagedCount(changes)
      return staged === 0 ? total + ' 处改动' : total + ' 处改动（' + staged + ' 已暂存）'
    }

    /**
     * 与上游的领先/落后摘要。
     * 没有上游时不显示「领先 N」——那种情况下推送失败的原因是没有目标，
     * 而不是有提交没推，提示成「领先」会误导用户。
     */
    function trackingSummary(snapshot) {
      if (snapshot === null || snapshot === undefined) return ''
      const ahead = typeof snapshot.ahead === 'number' ? snapshot.ahead : 0
      const behind = typeof snapshot.behind === 'number' ? snapshot.behind : 0
      if (ahead === 0 && behind === 0) return ''
      const parts = []
      if (ahead > 0) parts.push('领先 ' + ahead)
      if (behind > 0) parts.push('落后 ' + behind)
      return parts.join(' / ')
    }

    /** 已暂存的条目用成功色标出，和未暂存项一眼可分。 */
    function codeStyle(staged) {
      return staged === true
        ? Object.assign({}, S.code, { color: GOOD_TEXT })
        : S.code
    }

    /**
     * 底部状态条上的那一句话：分支 + 改动数 + 领先/落后。
     *
     * 三样都拼进**同一个文本节点**（而不是并排的几个 span）：状态条是常驻信息，
     * 「main · 3 处改动未提交 · 领先 2」连起来读最省横向空间；也避免面板里多出一堆
     * 只含一个词的散节点 —— 那些节点会让「按文本找元素」（用户读屏、测试断言）变含糊。
     */
    /**
     * `origin/main` → `main`（上游短名）。远端名里含 `/` 时按**第一个**斜杠切 —— 与宿主
     * ops.js 的 upstreamRef 同一套切法：两边对「上游叫什么」的理解必须一致，否则面板
     * 会算出和宿主不一样的结论。
     */
    function upstreamShortName(upstream) {
      if (!hasText(upstream)) return null
      const text = String(upstream)
      const at = text.indexOf('/')
      return at > 0 && at < text.length - 1 ? text.slice(at + 1) : null
    }

    /**
     * 本地分支名和它跟踪的远端分支名是否不一致。
     *
     * 这不是「显示细节」：默认配置 `push.default=simple` 下裸 `git push` 会被 git
     * 直接拒绝（`fatal: The upstream branch … does not match …`），所以状态条要**提前**
     * 说一声 —— 而不是等用户点了推送，才看到一句没头没尾的英文。
     */
    function upstreamNameMismatch(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return false
      const branch = hasText(snapshot.branch) ? String(snapshot.branch) : ''
      const short = upstreamShortName(snapshot.upstream)
      return branch.length > 0 && short !== null && branch !== short
    }

    /**
     * 新建分支名是否撞上远端名（`origin/main` 这种）—— 与宿主 ops.js 的
     * branchNameRemoteConflict 同一判定。宿主那一侧会在建之前拒绝，这里在输入框旁边
     * 立刻说清楚（用户不用点一下才知道为什么不行）。
     */
    function branchNameRemoteConflict(name, remoteNames) {
      const draft = hasText(name) ? String(name).trim() : ''
      if (draft.length === 0) return null
      const list = Array.isArray(remoteNames) ? remoteNames : []
      for (const remote of list) {
        if (!hasText(remote)) continue
        if (draft.startsWith(String(remote) + '/')) return String(remote)
      }
      return null
    }

    /**
     * 宿主这次到底有没有按「你选的那个远程」跑？（拉取与推送共用）
     *
     * 判据是宿主回执里的命令行（`data.command`，例如 `git push fork HEAD` /
     * `git pull origin main`）里有没有那个远程名。宿主半边**不会热重载**（改完
     * lib/*.js 要重启 dsh），而客户端界面会随页面刷新 —— 于是存在「新客户端 + 旧宿主」
     * 这个中间态：旧宿主的 push / pull 根本不看 remote 参数，会照旧裸跑。这时不能沉默：
     * 用户明明选了 fork / origin，回执里却是 `git push`，不说清楚就成了「这个功能点了没反应」。
     *
     * 拿不到 command（早期参数错、未知操作）时返回 false：那种失败有自己的消息，
     * 不该再叠一句「宿主是旧版本」。
     */
    function remoteStaleHost(data, remote) {
      if (remote.length === 0) return false
      if (data === null || typeof data !== 'object') return false
      const command = hasText(data.command) ? String(data.command) : ''
      if (command.length === 0) return false
      // 按**整词**比对而不是 includes：远程名可能只是命令行里另一段文本的子串
      // （`git push https://…/fork.git` 里就有 fork），子串判定会两种错都犯
      // —— 该报的不报、不该报的乱报。
      return !command.split(/\s+/).includes(remote)
    }

    /**
     * 把「拉取自」记着的那一个值拆成 { remote, branch }。
     *
     * 值的两种形状：
     *   `origin`         —— 从 origin 拉**当前分支**（同名分支，宿主负责补分支名）；
     *   `origin master`  —— 从 origin 拉 **master** 这条（远端没有同名分支时的那条路）。
     *
     * 为什么用**空白**当分隔符：远程名与分支名在 git 里都不允许含空白
     * （实测 `git remote add "a b"` 与 `git branch "x y"` 都被拒），所以这个分隔符
     * 在本插件面对的取值范围内是无歧义的；而斜杠两者都合法（`a/b` 是合法远程名），
     * 所以绝不能用 `/` 切。
     *
     * 按**任意空白**切（不是只按空格）：本插件自己产出的值一定只有一个普通空格，但
     * localStorage 可能被手改或被别的工具写过制表符（`origin\tmaster`）。只认空格时
     * 那种值会被当成一个叫 `origin\tmaster` 的远程名 → 校验不通过 → 用户的记忆**静默消失**
     * （退回「跟随上游」）。按空白切之后它与 `origin master` 等价，记忆照旧生效。
     */
    function parsePullTarget(value) {
      const text = hasText(value) ? String(value).trim() : ''
      if (text.length === 0) return { remote: '', branch: '' }
      const parts = text.split(/\s+/).filter((part) => part.length > 0)
      if (parts.length === 0) return { remote: '', branch: '' }
      return { remote: parts[0], branch: parts.slice(1).join(' ') }
    }

    /**
     * 把记忆里的值归一化成**规范形状**（`origin` / `origin master`）：去掉多余空白，
     * 两端都空的形状退回空串（= 跟随上游）。
     *
     * 为什么必须归一化：`<select value=…>` 是**逐字符**匹配 option 的 value 的，而 option
     * 只由本插件产出规范形状。手改过 localStorage、或别的版本写入过 `' origin '` 这类值时，
     * select 匹配不到任何 option —— HTML 的行为是 selectedIndex = -1，也就是**下拉显示空白**，
     * 用户看不出这一次会从哪儿拉。归一化让这类值自愈，不必等用户自己去清存储。
     */
    function normalizePullTarget(value) {
      const parsed = parsePullTarget(value)
      if (parsed.remote.length === 0) return ''
      return parsed.branch.length === 0 ? parsed.remote : parsed.remote + ' ' + parsed.branch
    }

    /**
     * 这个仓库记住的那个远程（且它**现在**还在远程列表里）。空串 = 跟随上游
     * （推/拉都由 git 按上游决定，也就是老行为）。
     *
     * 「还在不在」按**值开头那个远程名**判定（`origin master` 判的是 origin）：
     * 拉取记忆比推送记忆多带一个可选的远端分支名，而校验规则是同一件事 ——
     * 「我记着的那个远程现在还在吗」。分成两套实现只会让下一次改动漏掉一边。
     *
     * 返回值一律是归一化之后的形状（见 normalizePullTarget）：调用方拿它直接填进
     * `<select value>` 或拼进请求体，两边看到的必须是同一个字符串。
     *
     * @param field - 'pushRemoteByDir' 或 'pullRemoteByDir'：推与拉各记一份，
     *   但取值规则完全一样，所以是同一个函数（两份实现只会慢慢分叉）。
     */
    function remoteTargetFor(state, field) {
      if (state === null || typeof state !== 'object') return ''
      const table = state[field] !== null && typeof state[field] === 'object' ? state[field] : {}
      const wanted = hasText(state.workdir) && hasText(table[state.workdir]) ? String(table[state.workdir]) : ''
      if (wanted.length === 0) return ''
      const name = parsePullTarget(wanted).remote
      if (name.length === 0) return ''
      const remotes = state.snapshot !== null && typeof state.snapshot === 'object'
        && Array.isArray(state.snapshot.remotes)
        ? state.snapshot.remotes
        : []
      const known = remotes.some((item) => item !== null && typeof item === 'object' && String(item.name) === name)
      // 远程还在 → 回归一化后的值（下拉与请求体都用它）；不在了 → 空串，干净退回跟随上游。
      return known ? normalizePullTarget(wanted) : ''
    }

    /**
     * 「推送到」下拉 / 远程行「推送到此」当前记着的远程。
     *
     * 只取**开头那个远程名**：推送目标在 git 里只能是一个远程（`git push <远程> HEAD`），
     * 记忆里若带着分支（`origin master` —— 只可能来自手改存储、或老版本把拉取的记忆
     * 写进了推送的键），照原样返回会同时犯两个错：
     *   · 「推送到」下拉的候选只有远程名（`推送到 X`），那个带分支的串匹配不到任何 option
     *     → `<select>` 显示空白，用户看不出这次会推到哪儿；
     *   · 整串 `origin master` 会被当成远程名发给宿主，宿主按 isSafePushTarget 校验时
     *     因含空格而拒绝（报「远程名或地址不合法」）—— 用户看到的是一次莫名其妙的失败。
     * 取第一个 token 之后这两种都消失，且对正常值（只有远程名）行为一字不变。
     *
     * 本插件自己的界面**产生不了**带分支的推送目标（`setPushRemote` 收到的永远是远程名），
     * 所以这是防御性的收口，不是修复一个能点出来的现场。
     */
    function pushTargetRemote(state) {
      const value = remoteTargetFor(state, 'pushRemoteByDir')
      return value.length === 0 ? '' : parsePullTarget(value).remote
    }

    /** 「拉取自」下拉 / 远程行「从此外拉」当前记着的值（空串 = 跟随上游，裸 git pull）。 */
    function pullTargetRemote(state) {
      return remoteTargetFor(state, 'pullRemoteByDir')
    }

    /**
     * 「从这个远程拉」这件事的一次具体计划：拉哪个远程、哪条分支、行尾与按钮上怎么写字。
     *
     * 分支的取法**只有一种推断，且只用确定的信息**：
     *   · 远端自己声明的默认分支（`origin/HEAD -> origin/master`，宿主随状态一起带回的
     *     `remoteHeads`）与当前分支**不同名**时 → 拉远端的默认分支，按钮上把它写出来
     *     （「拉 master」）；
     *   · 其余情况（默认分支与当前分支同名 / 本地没有那个指针 / 游离 HEAD）→ 拉**当前
     *     分支**，按钮写「从此外拉」（宿主按当前分支名补分支）。
     *
     * 为什么「不同名」时才给默认分支：这正是 fork 工作流的现场 —— 本地分支叫 `local.2`、
     * 别人的上游默认分支叫 `master`，**一键把上游拉到当前分支**就是这一条。而它必须是
     * 一个**点名了分支的按钮**（标签与 tooltip 都写出 `git pull origin master`），不能是
     * 静默的推断：把另一条线并进当前分支，与用户的意图可能完全相反。同名时两条路本来就
     * 是同一条命令，不给第二个选项（下拉里出现两个看起来一样的选项只会让人犹豫）。
     */
    function pullPlanFor(state, remote) {
      const name = hasText(remote) ? String(remote) : ''
      if (name.length === 0) return null
      const branch = state !== null && typeof state === 'object' && state.snapshot !== null
        && typeof state.snapshot === 'object' && hasText(state.snapshot.branch)
        ? String(state.snapshot.branch)
        : ''
      const heads = state !== null && typeof state === 'object' && state.snapshot !== null
        && typeof state.snapshot === 'object' && state.snapshot.remoteHeads !== null
        && typeof state.snapshot.remoteHeads === 'object' && typeof state.snapshot.remoteHeads !== 'string'
        ? state.snapshot.remoteHeads
        : {}
      const known = hasText(heads[name]) ? String(heads[name]) : ''
      if (known.length > 0 && known !== branch) {
        return { remote: name, branch: known, value: name + ' ' + known, label: '拉 ' + known }
      }
      return { remote: name, branch: '', value: name, label: '从此外拉' }
    }

    /**
     * 「拉取自」下拉的**候选**（一项一个可选的来源），与远程行的「从此外拉」同源。
     *
     * 每个远程最多两项：
     *   · 一项拉**当前分支**（值就是远程名，宿主按当前分支名补分支）；
     *   · 远端默认分支与当前分支**不同名**时，再多一项点名那条分支
     *     （值是 `origin master`），标签写成「从 origin/master 拉」。
     *
     * 只在真的不同名时才多给一项：同名时两项会拼出**同一条命令**，摆两个看起来一样的
     * 选项只会让人犹豫「这俩差在哪」—— 而从 git 的角度它们确实完全一样。
     *
     * 记忆里存着的那个值**永远保留一项**（即使当前现场已经算不出它）：否则用户切了分支
     * 回来，`<select>` 的 value 找不到对应 option，界面会显示成空白 —— 那比记住一个
     * 过时的选择更糟（他不知道自己会从哪儿拉）。这个值仍然受 remoteTargetFor 校验，
     * 远程被删掉时它整个退回空串，不会走到这里。
     */
    function pullSourceChoices(state, remotes) {
      const list = Array.isArray(remotes) ? remotes : []
      const picked = parsePullTarget(remoteTargetFor(state, 'pullRemoteByDir'))
      const choices = []
      /**
       * 加一项候选（同一 value 只加一次）。
       *
       * 显式去重而不是靠控制流（原先这里是「plan 那一项 push 完就 continue」）：
       * 那个 `continue` 会把下面「记忆里的值也要有一项」整段跳过 —— 于是当**记忆里的
       * 分支名与现在算出来的不同名**时（远端默认分支改过名：记忆 `origin master`、
       * 现在算出 `origin main`），下拉里没有 `origin master` 这一项，而 `pullTarget`
       * 仍是它 → `<select>` 匹配不到任何 option → **下拉空白**，用户看不出会从哪儿拉。
       * 三种值可能同时成立（同名那条 / 现在的默认分支 / 记忆里那条），所以这里按
       * **value** 去重，而不是按「每个远程最多两项」。
       */
      const add = (value, label, branch) => {
        if (value.length === 0 || choices.some((entry) => entry.value === value)) return
        choices.push({ value: value, label: label, remote: parsePullTarget(value).remote, branch: branch })
      }
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        const name = String(item.name)
        if (name.length === 0) continue
        // ① 拉**当前分支**同名那条（值就是远程名，宿主按当前分支名补分支）。
        add(name, '从 ' + name + ' 拉', '')
        // ② 远端默认分支与当前分支不同名时，点名那条（这是 fork 现场最常要的那一下）。
        const plan = pullPlanFor(state, name)
        if (plan !== null && plan.branch.length > 0) {
          add(plan.value, '从 ' + name + '/' + plan.branch + ' 拉', plan.branch)
        }
        // ③ 记忆里那个值**永远保留一项**（即使现场已经算不出它）。
        //    没有这一项时 `<select value>` 会匹配不到 option 而显示空白 —— 那比「记住一个
        //    看起来过时的选择」更糟：用户不知道自己会从哪儿拉。它仍受 remoteTargetFor 校验，
        //    远程被删掉时整条已退回空串，不会走到这里。
        //    标签点明这是上次选的：它通常正因为**远端改过默认分支名**而与上面那项不同，
        //    说清楚用户才知道「为什么这里还有一条 master」。
        if (picked.remote === name && picked.branch.length > 0) {
          add(name + ' ' + picked.branch, '从 ' + name + '/' + picked.branch + ' 拉（上次选的）', picked.branch)
        }
      }
      return choices
    }

    function statusSummary(isRepo, snapshot, changesTotal) {
      if (isRepo !== true) return '还不是 Git 仓库 · 可以初始化或克隆一个'
      const branch = snapshot !== null && hasText(snapshot.branch) ? String(snapshot.branch) : '（尚无提交）'
      const parts = [branch, changesTotal > 0 ? changesTotal + ' 处改动未提交' : '工作区干净']
      const track = trackingSummary(snapshot)
      if (track.length > 0) parts.push(track)
      return parts.join(' · ')
    }

    /** 改动条目的稳定标识：同一个文件的「已暂存 / 未暂存」是两个不同的 diff。 */
    function changeKey(item) {
      return (item.staged === true ? 's:' : 'u:') + String(item.path)
    }

    // ── 目录选择小窗口：纯 helper ─────────────────────────────────────────
    //
    // 「切换目录」弹的小窗口跟 DSH「添加工作区」是同一个目录选择器（宿主
    // ctx.remote.directoryPicker 的 browse 能力：list / createDirectory）。
    // 宿主浏览器里那个对话框（DirectoryBrowser）是 ui-directory-picker-browse 包
    // 的内部组件，第三方插件 import 不到，所以面板里实现一个同交互的紧凑版：
    // 面包屑 + 目录列表 + 新建文件夹 + 直接输入路径，走的是同一条宿主通道。

    /**
     * 列表的路径分隔符：从宿主盖的 home 路径推断（不要从条目路径猜 —— POSIX 上
     * 反斜杠是合法的文件名字符）。
     */
    function pickSeparator(listing) {
      return listing !== null && typeof listing === 'object' && hasText(listing.home)
        ? (String(listing.home).includes('\\') ? '\\' : '/')
        : '/'
    }

    /**
     * 面包屑：home 子树内从「主目录」开始，子树外显示完整祖先链（根用它自己的
     * 路径作名字）。与宿主 DirectoryBrowser 的 displayCrumbs 同一套规则。
     */
    function pickCrumbs(listing) {
      if (listing === null || typeof listing !== 'object' || !Array.isArray(listing.crumbs)) return []
      const homeIndex = listing.crumbs.findIndex((crumb) => crumb !== null && typeof crumb === 'object' && crumb.path === listing.home)
      if (homeIndex === -1) return listing.crumbs
      return [{ name: '主目录', path: listing.home, hidden: false }].concat(listing.crumbs.slice(homeIndex + 1))
    }

    /** remote 调用的失败文本：优先取宿主业务消息（rpcError.message），没有就退回普通错误文本。 */
    function pickFailureText(error) {
      if (error !== null && typeof error === 'object' && 'rpcError' in error) {
        const rpcError = error.rpcError
        if (rpcError !== null && typeof rpcError === 'object' && hasText(rpcError.message)) return String(rpcError.message)
      }
      return error !== null && typeof error === 'object' && hasText(error.message) ? String(error.message) : String(error)
    }

    /**
     * 这次失败是不是「宿主的目录选择器只组合了系统对话框（native），网页里列不了目录」。
     *
     * 宿主把两种交互做成同一个 remote 命名空间的两个能力：list / createDirectory 要
     * browse，pick 要 native，一次启动只组合其中一种，另一种调用会被拒绝并回
     * `directory-picker/unavailable`（details.capability 是**实际组合出来**的那种）。
     * 以 127.0.0.1 启动的本机 DSH 组合的就是 native —— 这时小窗口不该把宿主的
     * 英文错误甩给用户，而该改走 pick（系统对话框）。
     */
    function isBrowseUnavailable(error) {
      const rpcError = error !== null && typeof error === 'object' && 'rpcError' in error ? error.rpcError : null
      if (rpcError === null || typeof rpcError !== 'object') return false
      if (rpcError.code !== 'directory-picker/unavailable') return false
      const details = rpcError.details
      if (details === null || details === undefined || typeof details !== 'object') return true
      // 组合出来的是 browse 却在 list 上失败，就不是这个场景（另走普通错误显示）。
      return details.capability === undefined || details.capability === 'native'
    }

    // ── 面板状态：一个 reducer 管全部 ─────────────────────────────────────
    //
    // 为什么不是一堆 useState：面板上有一批状态属于**某个具体仓库**（命令结果、
    // 展开的 diff、分支列表、提交草稿、远程地址草稿、待选选项…）。用独立 state 时，
    // 换工作区必须逐个手写清理，**漏一个就会把旧仓库的数据显示成新仓库的**——
    // 上一版就漏了 branchDraft（换工作区后「新建分支」的输入框里还留着上一个仓库的
    // 名字）。收进一个 reducer 后，清理只有一个动作（'reset-repo'），新增字段不可能再漏。
    // 注意：目录选择小窗口（pick* 字段）是**界面开关**，不属于任何仓库 —— 它由
    // openPicker / closePicker 自己成对清空，与 'reset-repo' 无关。

    const PANEL_INITIAL = {
      workdir: '',
      picked: false,
      // ── 目录选择小窗口（与 DSH「添加工作区」同一个目录选择器） ──────────
      // 点仓库卡的「切换」弹出：目录浏览 / 直接输入路径 / 新建文件夹。
      // 它只回答「面板接下来看哪个目录」，不注册 workspace、不开新会话。
      pickerOpen: false,
      // 宿主这次组合出来的目录选择器只提供系统对话框（browse 能力缺席）时为 true：
      // 网页里列不了目录，小窗口改成「打开系统对话框 / 手输绝对路径」两条路。
      pickNative: false,
      pickLevel: null,
      pickSelected: null,
      pickBusy: false,
      pickError: '',
      pickShowHidden: false,
      pickDraft: null,
      pickFolder: null,
      pickCreating: false,
      pickCreateError: '',
      snapshot: null,
      busy: false,
      message: '',
      output: '',
      // 上一次操作的结果（null = 还没操作过）：底部状态条上那个小点的颜色。
      lastOk: null,
      cloneUrl: '',
      showClone: false,
      cloneShallow: false,
      /**
       * 远程编辑器。**编辑的是哪一个远程**由 editingRemote 唯一决定 ——
       * 这是修掉「串线」的关键：原先只有一个 remoteName/remoteUrl 草稿，
       * 名字框写死 origin、地址框却播种自 remotes[0]，于是「fork」排在前面时，
       * 点「改」再点「保存」会把 origin 的地址改成 fork 的地址（实测确认过）。
       * 现在草稿永远跟着被点的那一行走，不再有「显示 A、改到 B」的可能。
       *   null → 没有编辑器打开
       *   ''   → 打开的是「添加远程」表单（名字待填）
       *   其他 → 打开的是这个远程的就地编辑器
       */
      editingRemote: null,
      remoteDraftName: '',
      remoteDraftUrl: '',
      remoteError: '',
      /** 刚复制过地址的远程名（1.5 秒后清掉，按钮回到「复制」）。 */
      remoteCopied: null,
      /**
       * 「推送到」选的那个远程**没有出现在宿主的回执里** —— 典型是「浏览器里是新的
       * 客户端、宿主进程还是旧版本」（link 安装时宿主半边不会热重载，改完 lib/*.js
       * 必须重启 dsh）。这时命令其实按旧逻辑跑了，必须明说，否则用户会以为
       * 「选了 fork 却没反应」。见 push()。
       */
      pushHostStale: false,
      /**
       * 「推送到 / 拉取自哪个远程」的记忆：{ 仓库目录: 远程名 }（各一份）。
       *
       * 空串 / 没有这一项 = 跟随上游（裸 git push / git pull，老行为）。它们属于**界面记忆**
       * 而不是「上一个仓库的运行结果」，所以不放进 REPO_RESET —— 切回来时还该记得
       * 你上次推的是哪个远程、从哪个远程拉。
       */
      pushRemoteByDir: readStoredPushRemotes(),
      pullRemoteByDir: readStoredPullRemotes(),
      /**
       * 「拉取自」选的那个远程**没有出现在宿主的回执里**：与 pushHostStale 同一条
       * 中间态判断（新客户端 + 旧宿主），见 remoteStaleHost。旧宿主的 pull 不看 remote
       * 参数，会照旧裸拉 —— 不说清楚，用户就会以为「选了 origin 却从 fork 拉了」。
       */
      pullHostStale: false,
      showBranches: false,
      branches: null,
      remoteBranches: null,
      /**
       * 分支行「⋯」展开的是哪一行（null = 都收起）。键：`local:<分支名>` /
       * `remote:<ref>`。同一时刻只开一个 —— 展开区就在行下面，开两个会把列表撑得很长。
       */
      branchMenu: null,
      /**
       * 「把哪个本地分支的上游设成远端某一条」的选择器打开在谁身上（null = 关闭）。
       * 候选列表来自**已经拿到的** remoteBranches，所以打开它不发任何请求。
       */
      upstreamPickerFor: null,
      /**
       * 「改名」的就地编辑器打开在谁身上（null = 关闭）：renameFor 是要改的那条分支名，
       * renameDraft 是输入框里的草稿，renameError 是**点了也白跑**的情形（空名字 /
       * 名字没变 / 撞远端名 / 有空格）的就地说明。
       *
       * 为什么必须有这套状态：这条操作此前用 `window.prompt()` 拿名字 —— 而桌面版
       * （Electron 外壳）**不支持 prompt**（Chromium 那句 `prompt() is and will not be
       * supported.`），于是点「⋯ → 改名」的结局是**静默什么都不发生**，日志里连一条
       * renameBranch 都没有。面板里所有需要输入的地方都必须用面板自己的输入框
       * （新建分支 / 改远程地址 / 设置上游都是这么做的），不能借浏览器弹框。
       */
      renameFor: null,
      renameDraft: '',
      renameError: '',
      branchDraft: '',
      diffKey: '',
      diffText: '',
      choices: null,
      logRef: '',
      logText: '',
      showStash: false,
      stashList: [],
      commitAmend: false,
      pullRebase: false,
      net: null,
      showNet: false,
      netProxy: '',
      netProbe: null,
      netBusy: false,
    }

    /**
     * 属于「上一个仓库」的字段。界面开关（是否最小化、加速设置是否展开、网络配置）
     * 不属于任何一个仓库，因此不在这里清。
     */
    const REPO_RESET = {
      output: '',
      // 状态条上那个点表示「上一次操作成没成」——那是上一个仓库的操作，跟着一起清。
      lastOk: null,
      diffKey: '',
      diffText: '',
      branches: null,
      remoteBranches: null,
      branchUpstreams: null,
      showBranches: false,
      // 展开着的「⋯」菜单与「设置上游」选择器都属于**上一个仓库的界面状态**：
      // 跟着仓库一起清，否则切过去会发现某个分支行莫名开着菜单（而且指向另一条分支）。
      branchMenu: null,
      upstreamPickerFor: null,
      // 改名编辑器同理：它是**上一个仓库那条分支**的界面状态（草稿里就是那条分支的名字）。
      renameFor: null,
      renameDraft: '',
      renameError: '',
      message: '',
      remoteError: '',
      choices: null,
      branchDraft: '',
      // 「宿主是旧版本」这条提示也是**上一个仓库那一次操作**的结论：跟着仓库一起清，
      // 否则切到另一个仓库后它还挂在那儿（那个仓库可能根本没推过）。
      // 注意 pushRemoteByDir / pullRemoteByDir 不在这里 —— 那是「这个仓库推哪儿、
      // 从哪儿拉」的界面记忆，不是运行结果。
      pushHostStale: false,
      pullHostStale: false,
      // 提交详情、stash 列表与远程编辑器同理：它们都是「上一个仓库的运行结果」，
      // 跟着仓库一起清（否则新仓库的面板里会挂着旧仓库的 commit 详情，
      // 更糟的是编辑器还停在旧仓库某个远程的路径上）。
      logRef: '',
      logText: '',
      showStash: false,
      stashList: [],
      editingRemote: null,
      remoteDraftName: '',
      remoteDraftUrl: '',
      remoteCopied: null,
    }

    function panelReducer(state, action) {
      if (action.type === 'patch') return Object.assign({}, state, action.patch)
      if (action.type === 'reset-repo') return Object.assign({}, state, REPO_RESET)
      return state
    }

    /** 一次最多渲染多少条改动（宿主最多回 100 条，超出部分在列表末尾明确说明）。 */
    const CHANGES_SHOWN = 40

    // ── useGitPanel：状态 + 动作 ──────────────────────────────────────────

    /**
     * 面板的全部状态与动作。GitPanel 只负责把结果画出来。
     *
     * 所有异步结果都要过两道归属校验：
     *   · 请求序号 —— 切工作区时上一条 state 请求可能还在飞，迟到的旧状态不能盖回去；
     *   · 目录归属 —— 拉取/推送/克隆在宿主侧的超时是 10 分钟，用户完全可能在结果
     *     回来之前就切到别的工作区去了；这时整条结果必须丢弃。
     */
    function useGitPanel(props) {
      const [state, dispatch] = React.useReducer(panelReducer, PANEL_INITIAL)
      const patch = React.useCallback((fields) => dispatch({ type: 'patch', patch: fields }), [])

      // 面板当前绑在哪个仓库目录上（宿主归一化后的绝对路径；null = 还不知道）。
      const shownDirRef = React.useRef(null)
      // 状态请求序号：同时只认最新一次请求的结果。
      const loadSeqRef = React.useRef(0)
      // 展开的 diff 元素：点开之后要把它滚进可视区（改动清单与面板正文都可能要滚）。
      const diffRef = React.useRef(null)
      // 命令结果栏：操作成功后把它滚进视口并闪一下（结果栏在最底部，容易被忽略）。
      const outRef = React.useRef(null)
      // 面板正文的滚动区：底部状态条被点一下时用它回到顶部。
      const bodyRef = React.useRef(null)
      // 「下一次 output 变化要闪一下」的标记：只有操作**成功**时才置位，
      // 所以「执行中…」和失败路径不会触发。
      const flashRef = React.useRef(false)

      // 目录选择小窗口的归属校验（与 loadSeqRef 同一套思路）：
      //   · 代（gen）—— 窗口每打开/关闭一次就换代，迟到的响应一律丢弃；
      //   · 序号（seq）—— 同一次打开里多次列出，只认最新那一次；
      //   · abort —— 在飞的列出请求直接掐断，不让宿主白扫（browse 的 list 支持
      //     调用方取消；老环境没有 AbortController 就退化成只丢弃结果）。
      const pickGenRef = React.useRef(0)
      const pickSeqRef = React.useRef(0)
      const pickAbortRef = React.useRef(null)

      // 当前会话的工作目录。
      //
      // **这一版与旧版（浮窗）的关键差别**：`sidebar.right.pane.tab` 是 **session
      // scope** 的插槽，标准 props 里直接带着 `sessionId` —— 也就是「这个标签属于
      // 哪个会话」。所以正常路径是拿 sessionId 去 byId 里取那一行的 cwd：精确、
      // 不依赖任何启发式。
      //
      // 之所以还留着下面那段「被主视图持有的那一行」的兜底：`sessionId` 可能缺失
      // （宿主版本差异、或测试里用假 props 直接渲染面板），而旧版的启发式在那种
      // 情况下仍然是最好的近似 —— 宿主自己的 publishMain 与 ui-workspace 的
      // mainSessionId 用的就是这个判据（retainedBy.mainView > 0）。
      //
      // 注意 sessionId 要参与 hooks 的去重：它不是 props 里一个无关紧要的字段，
      // 换了会话就得重新取 cwd（见下面的依赖数组）。
      const sessionId = props !== null && props !== undefined && hasText(props.sessionId)
        ? props.sessionId
        : null
      const useSessions = props !== null && props !== undefined && typeof props.useSessions === 'function'
        ? props.useSessions
        : null
      const sessionCwd = useSessions === null ? undefined : useSessions((store) => {
        if (store === null || store === undefined) return undefined
        const rows = store.byId
        if (rows === undefined || rows === null) return undefined
        // 精确路径：这个标签所属会话的那一行。
        if (sessionId !== null) {
          const own = rows[sessionId]
          if (own !== null && own !== undefined && hasText(own.cwd)) return own.cwd
        }
        for (const row of Object.values(rows)) {
          if (row === null || row === undefined) continue
          const retained = row.retainedBy
          if (retained === null || retained === undefined || !((retained.mainView ?? 0) > 0)) continue
          return hasText(row.cwd) ? row.cwd : undefined
        }
        return undefined
      })

      /**
       * 读一次仓库状态。序号校验保证只有最新那次的结果会被采用。
       * @param silent - 后台刷新（窗口重新获得焦点、脏工作区轮询）用：不点亮
       *   「同步中…」也不在失败时把结果栏刷成错误 —— 这类刷新是顺手做的，
       *   失败了不该打扰正在操作的人。
       */
      const load = async (requested, silent) => {
        const seq = ++loadSeqRef.current
        if (silent !== true) patch({ busy: true })
        try {
          const data = await fetchState(typeof requested === 'string' ? requested : '')
          // 期间又切换过一次：这条响应已经过时，丢掉 —— 否则旧目录的状态会把刚切
          // 过去的面板盖回去。（过期的这一条不碰 busy：锁归最新那次请求收尾。）
          if (seq !== loadSeqRef.current) return
          const nextDir = hasText(data.dir) ? data.dir : null
          const previousDir = shownDirRef.current
          shownDirRef.current = nextDir
          const fields = { snapshot: data }
          // 「换目录」才清掉上一轮「需要你选一个结果」的选项；**同一个目录的刷新不清**：
          // 窗口失焦再回来会触发一次后台刷新，若照清不误，用户正盯着看的
          // 「两套历史无关」按钮会在眼皮底下消失。
          if (nextDir !== null && nextDir !== previousDir) fields.choices = null
          if (nextDir !== null) fields.workdir = nextDir
          patch(fields)
        } catch (error) {
          if (seq !== loadSeqRef.current) return
          if (silent !== true) {
            patch({ output: '读取状态失败：' + String(error && error.message ? error.message : error) })
          }
        }
        if (silent !== true) patch({ busy: false })
      }

      /**
       * 清掉「属于上一个工作区」的瞬时结果（见 REPO_RESET）。
       *
       * **不能把它挂在「目录变了」上**：克隆成功后也会换目录，但那时输出正是用户要看
       * 的克隆结果。所以只在真正由用户发起的切换入口调用（见 switchDir）。
       */
      const forgetRepoDetails = () => dispatch({ type: 'reset-repo' })

      /**
       * 切换工作区：先清掉上一个工作区的运行结果，再加载新目录。
       * 「换一个仓库看」的入口都必须走这里 —— 这是「命令结果栏跟着工作区走」的
       * 唯一保证点。
       */
      const switchDir = (target) => {
        forgetRepoDetails()
        load(target)
      }

      // ── 目录选择小窗口：动作 ─────────────────────────────────────────────
      //
      // 与 DSH「添加工作区」共享同一个目录选择器：宿主那个对话框内部也是调
      // `uiWorkspace.listDirectory` / `createDirectory`（见 ui-directory-picker-browse
      // 的注入面），这里用的是同一个服务、同一条 wire，所以权限与错误消息一致。
      //
      // 服务由 apply 通过 props.getPicker() 交给面板（live getter，取一次没用完
      // 就接着取）；拿不到就退化成「只能直接输入绝对路径」。

      /** 此刻的宿主目录选择器（list / createDirectory）；不可用返回 null。 */
      const resolvePicker = () => {
        const getter = props !== null && props !== undefined && typeof props.getPicker === 'function'
          ? props.getPicker
          : null
        if (getter === null) return null
        try {
          return getter()
        } catch (error) {
          return null
        }
      }

      /**
       * 打开小窗口：清掉上次的状态，从宿主主目录开始列。
       * 不动面板当前绑定的仓库 —— 选完并确认才切（见 pickConfirm）。
       */
      const openPicker = () => {
        pickGenRef.current += 1
        pickSeqRef.current = 0
        patch({
          pickerOpen: true, pickNative: false, pickLevel: null, pickSelected: null, pickBusy: false,
          pickError: '', pickShowHidden: false, pickDraft: null, pickFolder: null,
          pickCreating: false, pickCreateError: '',
        })
        pickList('')
      }

      /** 关掉小窗口：掐断在飞的列出，丢弃一切迟到结果。 */
      const closePicker = () => {
        pickGenRef.current += 1
        pickSeqRef.current = 0
        if (pickAbortRef.current !== null && pickAbortRef.current !== undefined) {
          pickAbortRef.current.abort()
          pickAbortRef.current = null
        }
        patch({
          pickerOpen: false, pickNative: false, pickLevel: null, pickSelected: null, pickBusy: false,
          pickError: '', pickShowHidden: false, pickDraft: null, pickFolder: null,
          pickCreating: false, pickCreateError: '',
        })
      }

      /** 列出目录，rawPath 为空串列宿主主目录。迟到/被取代的响应一律丢弃。 */
      const pickList = async (rawPath) => {
        const api = resolvePicker()
        if (api === null) {
          patch({ pickError: '宿主没有提供目录浏览服务：可以直接在上方输入绝对路径后回车，一步切换过去。' })
          return
        }
        const gen = pickGenRef.current
        const seq = ++pickSeqRef.current
        if (pickAbortRef.current !== null && pickAbortRef.current !== undefined) pickAbortRef.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        pickAbortRef.current = controller
        patch({ pickBusy: true, pickError: '' })
        try {
          const listing = await api.list(rawPath === '' || rawPath === undefined ? undefined : rawPath,
            controller === null ? undefined : controller.signal)
          if (gen !== pickGenRef.current || seq !== pickSeqRef.current) return
          patch({ pickLevel: listing, pickSelected: null, pickBusy: false })
        } catch (error) {
          if (gen !== pickGenRef.current || seq !== pickSeqRef.current) return
          if (isBrowseUnavailable(error)) {
            // 宿主组合的是系统对话框：不报错，换成「系统对话框 / 手输路径」那一版界面。
            patch({ pickBusy: false, pickError: '', pickNative: true })
            return
          }
          patch({ pickBusy: false, pickError: pickFailureText(error) })
        }
      }

      /** 选一行（单击）：记成「待选择的目录」，不导航。 */
      const pickSelect = (entry) => {
        if (entry === null || typeof entry !== 'object' || !hasText(entry.path)) return
        patch({ pickSelected: entry, pickDraft: null })
      }

      /** 进入一行（双击 / 回车）：把它列成当前目录。 */
      const pickEnter = (entry) => {
        if (entry === null || typeof entry !== 'object' || !hasText(entry.path)) return
        pickList(entry.path)
        patch({ pickDraft: null })
      }

      /** 点面包屑跳到某个祖先目录。 */
      const pickCrumb = (path) => {
        if (!hasText(path)) return
        pickList(path)
      }

      /** 打开路径输入：从「选中的目录 ?? 当前显示目录」接续，末尾补分隔符。 */
      const pickDraftStart = () => {
        const level = state.pickLevel
        const base = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (base.length === 0) {
          patch({ pickDraft: '' })
          return
        }
        const sep = pickSeparator(level)
        patch({ pickDraft: base.endsWith('/') || base.endsWith('\\') ? base : base + sep })
      }

      /** 取消路径输入，回到面包屑。 */
      const pickDraftCancel = () => patch({ pickDraft: null })

      /** 提交路径：有浏览能力就列那个目录；没有（或宿主只给系统对话框）就直接切过去（一步到位）。 */
      const pickDraftSubmit = () => {
        const draft = state.pickDraft
        if (draft === null || typeof draft !== 'string') return
        const trimmed = draft.trim()
        if (trimmed.length === 0) return
        patch({ pickDraft: null })
        if (resolvePicker() === null || state.pickNative === true) {
          closePicker()
          patch({ picked: true })
          switchDir(trimmed)
          return
        }
        pickList(trimmed)
      }

      /**
       * 用宿主的系统对话框选目录 —— 宿主这次只组合了 native 能力时的正道。
       *
       * 选到就关窗切过去；用户取消（返回空）就留在小窗口里，不静默关窗；失败把
       * 宿主的消息显示出来，并提示手输路径这条保底路。
       */
      const pickSystem = async () => {
        const api = resolvePicker()
        if (api === null || typeof api.pick !== 'function') {
          patch({ pickError: '宿主没有提供目录选择服务：可以直接在上方输入绝对路径后回车，一步切换过去。' })
          return
        }
        const gen = pickGenRef.current
        patch({ pickBusy: true, pickError: '' })
        try {
          const chosen = await api.pick()
          if (gen !== pickGenRef.current) return
          patch({ pickBusy: false })
          if (!hasText(chosen)) return
          closePicker()
          patch({ picked: true })
          switchDir(String(chosen))
        } catch (error) {
          if (gen !== pickGenRef.current) return
          patch({ pickBusy: false, pickError: pickFailureText(error) })
        }
      }

      /** 确认选择：选中的目录 ?? 当前显示的目录，关窗并切过去。 */
      const pickConfirm = () => {
        const level = state.pickLevel
        const target = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (target.length === 0) return
        closePicker()
        patch({ picked: true })
        switchDir(target)
      }

      /** 打开「新建文件夹」小窗口。 */
      const pickCreateStart = () => patch({ pickFolder: '', pickCreateError: '' })

      /** 收起「新建文件夹」小窗口。 */
      const pickCreateCancel = () => patch({ pickFolder: null, pickCreateError: '' })

      /** 确认新建：在「选中的目录 ?? 当前显示目录」里创建，成功后面板选中它。 */
      const pickCreate = async () => {
        const draft = state.pickFolder
        if (draft === null || typeof draft !== 'string') return
        if (draft.trim().length === 0) return
        const level = state.pickLevel
        const parentPath = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (parentPath.length === 0) {
          patch({ pickCreateError: '还没有可创建目录的位置' })
          return
        }
        const api = resolvePicker()
        if (api === null || state.pickNative === true) {
          patch({ pickCreateError: '宿主没有提供目录浏览服务' })
          return
        }
        const gen = pickGenRef.current
        patch({ pickCreating: true, pickCreateError: '' })
        try {
          const created = await api.createDirectory(parentPath, draft)
          if (gen !== pickGenRef.current) return
          patch({ pickFolder: null, pickCreating: false })
          // 重新列出父目录并选中新建的文件夹（与宿主浏览器同一套落地姿态）。
          await pickList(parentPath)
          if (gen !== pickGenRef.current) return
          patch({ pickSelected: { name: draft, path: String(created), hidden: false } })
        } catch (error) {
          if (gen !== pickGenRef.current) return
          patch({ pickCreating: false, pickCreateError: pickFailureText(error) })
        }
      }

      // ── 网络加速：读写宿主配置 ──────────────────────────────────────────
      //
      // 这里不缓存任何「加速是否生效」的判断，一律以宿主返回的视图为准 —— 真正决定
      // git 怎么执行的是宿主，面板只是它的界面，两边各存一份状态迟早会对不上。

      /**
       * 读宿主配置。refreshProxy=true 时连输入框草稿一起刷新；用户正在打字时不能刷，
       * 否则一个无关的开关动作会把没保存的代理地址抹掉。
       */
      const loadNet = async (refreshProxy) => {
        try {
          const response = await fetch('/git-sidebar/net', { cache: 'no-store' })
          const data = rememberCsrf(await response.json().catch(() => null))
          if (isOk(data) !== true) return
          const fields = { net: data }
          if (refreshProxy === true) fields.netProxy = hasText(data.proxy) ? data.proxy : ''
          patch(fields)
        } catch (error) {
          // 网络加速只是为了修「连不上」，它自己读不到绝不能让面板跟着坏掉。
        }
      }

      /** 保存配置。changes 里只放要改的字段，其余保持不动。 */
      const saveNet = async (changes, refreshProxy) => {
        patch({ netBusy: true })
        try {
          const response = await fetch('/git-sidebar/net', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(withCsrf(changes)),
          })
          const data = rememberCsrf(await response.json().catch(() => null))
          if (isOk(data) !== true) {
            patch({ output: '保存网络加速设置失败：' + whyFailed(data, response.status) })
            return
          }
          const fields = { net: data }
          if (refreshProxy === true) fields.netProxy = hasText(data.proxy) ? data.proxy : ''
          patch(fields)
        } catch (error) {
          patch({ output: '保存网络加速设置失败：' + String(error && error.message ? error.message : error) })
        } finally {
          patch({ netBusy: false })
        }
      }

      /** 现场实测每条线路（直连 / 各镜像 / 代理），把结果原样列出来。 */
      const probeNet = async () => {
        patch({ netBusy: true, netProbe: null })
        try {
          const response = await fetch('/git-sidebar/net?probe=1', { cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (isOk(data) !== true) {
            patch({ output: '检测网络失败：HTTP ' + response.status })
            return
          }
          patch({ netProbe: Array.isArray(data.results) ? data.results : [] })
        } catch (error) {
          patch({ output: '检测网络失败：' + String(error && error.message ? error.message : error) })
        } finally {
          patch({ netBusy: false })
        }
      }

      /**
       * 执行一个操作。
       * @param options.quiet - 数据型操作（列分支、查 diff）不回显命令输出，避免把
       *   结果栏刷成一大段 git 原文；失败时仍回显，保证错误可见。
       * @param options.state - false 时请求带 noState，宿主跳过仓库状态回读（每次省
       *   4 条 git 进程）。这类操作只读、不写结果栏，因此不参与「归属校验」。
       */
      const runOp = async (op, extra, options) => {
        const opts = options === null || options === undefined ? {} : options
        const quiet = opts.quiet === true
        const wantState = opts.state !== false
        patch({ busy: true })
        if (quiet !== true) patch({ output: '执行中…' })
        // data 必须声明在 try **外面**：它在 try 里赋值、在 try 之后返回。
        // 若用 `const data` 声明在 try 里，后面的 `return data` 会抛 ReferenceError
        // （块级作用域），于是每次 runOp 都以 rejected promise 结束 —— 宿主侧 git
        // 明明执行成功了，调用方却永远拿不到返回值：diff 停在「加载中…」、
        // 分支管理器列不出分支、推送失败的自愈提示不再出现。
        let data
        try {
          const payload = { op: op }
          if (hasText(state.workdir)) payload.dir = state.workdir
          if (extra !== null && extra !== undefined) {
            for (const key of Object.keys(extra)) payload[key] = extra[key]
          }
          if (wantState !== true) payload.noState = true
          data = await postOp(payload)
          // 这条结果是哪个仓库的？宿主在 state.dir 里回了这次操作真正作用的目录。
          const resultDir = data.state !== null && typeof data.state === 'object' && hasText(data.state.dir)
            ? data.state.dir
            : null
          // 操作跑得比用户切换工作区慢时（拉取/推送/克隆的宿主超时是 10 分钟），结果
          // 回来时面板已经绑在另一个仓库上了。这时必须**整条丢弃**：既不能把旧仓库的
          // 输出写进命令结果栏，也不能用旧仓库的状态盖掉新仓库的面板。
          // 只有两边目录都确知、且确实不同才丢；信息不全（state/dir 缺失）一律照单
          // 接收 —— 宁可少拦一次，也不能把真实输出吞掉。
          const stale = resultDir !== null && shownDirRef.current !== null && resultDir !== shownDirRef.current
          // 判定是「网络连不上」时自动展开加速设置：提示里说了「点 🌐」，那就替用户点开，
          // 否则他还要自己找那个按钮在哪。
          if (data.network === true) patch({ showNet: true })
          if (stale !== true) {
            if (resultDir !== null) shownDirRef.current = resultDir
            const fields = {}
            if (quiet !== true || data.ok !== true) {
              const lines = opOutputLines(data)
              fields.output = lines.length > 0 ? lines.join('\n') : '完成'
              // 成功、且真的写了结果栏 → 下一次渲染把结果栏滚进视口并闪一下。
              if (data.ok === true) flashRef.current = true
            }
            if (data.state !== null && typeof data.state === 'object') fields.snapshot = data.state
            // 底部状态条上那个小点的颜色跟着「上一次操作成没成」走：成功绿、
            // 失败红。它回答的是「我刚才那一下到底行不行」，所以用 ok 而不是有无 stderr。
            fields.lastOk = data.ok === true
            // 宿主有时会回一组「需要你选一个结果」的选项（例如拉取撞上两套互不相关的
            // 历史）。渲染成按钮，用户点一下就把决定交给面板去执行。
            fields.choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null
            patch(fields)
          }
        } catch (error) {
          const reason = String(error && error.message ? error.message : error)
          patch({ output: '操作失败：' + reason, lastOk: false })
          // 归一化成失败结果：调用方统一用 data.ok 判断，否则只会得到「未知错误」。
          data = { ok: false, message: reason }
        }
        patch({ busy: false })
        return data
      }

      /**
       * 执行宿主给出的一个「选择」。
       *
       * 这类按钮常常是不可逆的（例如「让当前分支直接变成远端那份」），所以：
       *   · 带 confirm 的必须先确认，用户取消就什么都不做；
       *   · 执行前先 forgetRepoDetails()：切换分支/覆盖工作区之后，旧的分支列表、
       *     diff、上一轮输出都属于「上一份内容」，留着就是谎报。
       */
      const runChoice = async (choice) => {
        const op = typeof choice.op === 'string' ? choice.op : ''
        if (op.length === 0) return
        if (hasText(choice.confirm) && window.confirm(choice.confirm) !== true) return
        forgetRepoDetails()
        await runOp(op, choice.params !== null && typeof choice.params === 'object' ? choice.params : null)
      }

      /**
       * 拉分支列表（本地 + 远端 + 每条本地分支的上游）。**一次 op 拿三份**：
       * 宿主对 branches 会把 remoteBranches 与 branchUpstreams 一起解析回来，
       * 且数据型操作不回读仓库状态（noState）—— 原先这里连发两次 op，每次都要
       * 额外跑 4 条 git，展开一次管理器就是 10 条进程。
       */
      const fetchBranches = async () => {
        const data = await runOp('branches', null, { quiet: true, state: false })
        if (isOk(data) !== true) return
        const fields = {}
        if (data.branches !== null && data.branches !== undefined) fields.branches = data.branches
        if (data.remoteBranches !== null && data.remoteBranches !== undefined) {
          fields.remoteBranches = data.remoteBranches
        }
        if (data.branchUpstreams !== null && data.branchUpstreams !== undefined) {
          fields.branchUpstreams = data.branchUpstreams
        }
        if (Object.keys(fields).length > 0) patch(fields)
      }

      /** 展开/收起分支管理器：展开时拉一次列表，保证和当前仓库一致。 */
      const toggleBranches = () => {
        const next = state.showBranches !== true
        patch({ showBranches: next })
        if (next === true) fetchBranches()
      }

      /**
       * stash 备份列表（数据型操作，不回读仓库状态）。
       * 「安全拉取」「安全切分支」留下的备份在这里能看到、能恢复、能删除 ——
       * 否则弹回冲突时用户只能被指去终端敲 git stash pop。
       */
      const fetchStashList = async () => {
        const data = await runOp('stashList', null, { quiet: true, state: false })
        if (isOk(data)) patch({ stashList: Array.isArray(data.stash) ? data.stash : [] })
      }

      /** 展开/收起 stash 备份区：展开时拉一次列表。 */
      const toggleStash = () => {
        const next = state.showStash !== true
        patch({ showStash: next })
        if (next === true) fetchStashList()
      }

      /** 恢复某份 stash（git stash apply，**不删除**备份，用户确认没问题再点删除）。 */
      const doStashApply = async (item) => {
        const data = await runOp('stashApply', { ref: item.ref })
        if (isOk(data)) await fetchStashList()
      }

      /** 删除某份 stash（不可逆，必须先确认）。 */
      const doStashDrop = async (item) => {
        const ok = window.confirm('确定删除 ' + item.ref + ' 吗？\n\n'
          + '· 这份备份里的改动会永久丢失（不可恢复）\n'
          + '· 如果它已经 apply 回工作区，删除它只是清掉备份，不影响工作区\n\n'
          + '内容：' + item.text)
        if (ok !== true) return
        const data = await runOp('stashDrop', { ref: item.ref })
        if (isOk(data)) await fetchStashList()
      }

      // 下面这些动作都**不再手动 load()**：宿主在 op 响应里已经带回了最新状态，
      // runOp 会把它写进 snapshot。手动再拉一次状态是纯浪费（每次 4 条 git 进程）。

      /**
       * 切换分支。工作区有未提交改动时走「安全切分支」（stashSwitch）：
       * git 的裸 switch 在脏工作区上会被拒绝，而「先自己 commit / stash 再切」
       * 正是安全拉取已经替用户铺好的那条路 —— 这里对称地铺一遍。
       */
      const doCheckout = async (name) => {
        const dirty = state.snapshot !== null && typeof state.snapshot.changesTotal === 'number'
          && state.snapshot.changesTotal > 0
        if (dirty) {
          const question = '工作区还有 ' + state.snapshot.changesTotal + ' 处未提交的改动，直接切换会被 git 拒绝。\n\n'
            + '用「安全切分支」：先把改动（含未跟踪文件）自动藏起来，切到 ' + name + ' 后原样恢复；\n'
            + '切换失败也会自动还给你。\n\n确定这样切换吗？'
          if (window.confirm(question) !== true) return
          const data = await runOp('stashSwitch', { branch: name })
          if (isOk(data)) await fetchBranches()
          return
        }
        const data = await runOp('checkout', { branch: name })
        if (isOk(data)) await fetchBranches()
      }

      /**
       * 切换到某一次提交（最近提交行右侧的「切到此」）。
       *
       * 这是「看看那个版本的代码」的切换：宿主执行 git switch --detach <提交号>，
       * 之后处于游离 HEAD —— 没有分支指着这个提交。与切分支共用同一条「安全切分支」
       * 通道（stashSwitch）：工作区有未提交改动时先自动藏起来、切过去后原样恢复，
       * 对它来说目标只是「一个提交」而已。
       */
      const doCheckoutCommit = async (hash) => {
        const dirty = state.snapshot !== null && typeof state.snapshot.changesTotal === 'number'
          && state.snapshot.changesTotal > 0
        const question = '确定切换到提交 ' + hash + ' 吗？\n\n'
          + '· 切过去后处于「游离 HEAD」状态：查看、编译、运行都可以\n'
          + '· 想在这个版本上继续改代码：切过去后新建一个分支（git switch -c 名字）\n'
          + '· 回到最新：在「管理」里点一下原来的分支名即可\n'
          + (dirty
            ? '\n工作区还有 ' + state.snapshot.changesTotal + ' 处未提交的改动：'
              + '会先自动藏起来（含未跟踪文件），切过去后原样恢复。'
            : '')
        if (window.confirm(question) !== true) return
        const data = await runOp('stashSwitch', { commit: hash })
        if (isOk(data)) await fetchBranches()
      }

      /**
       * 打开「给这条分支改名」的就地编辑器。
       *
       * 草稿**从这条分支现在的名字播种**（改名通常是在原名上改几个字，这不是「猜」——
       * 要猜的是新名字，而新名字仍然只能由用户敲进去）。与「设置上游」互斥：面板里
       * 同一时刻只留一个就地展开区，两个一起出现会让人不知道在看哪个。
       */
      const openRenameEditor = (name) => {
        const branch = hasText(name) ? String(name) : ''
        patch({
          renameFor: branch,
          renameDraft: branch,
          renameError: '',
          branchMenu: null,
          upstreamPickerFor: null,
        })
      }

      /** 收起改名编辑器（什么都不做，只是关掉；草稿一起丢掉）。 */
      const closeRenameEditor = () => patch({ renameFor: null, renameDraft: '', renameError: '' })

      /** 输入框里的草稿：改一下就顺手清掉上一次的就地告警。 */
      const renameDraftChange = (value) => patch({ renameDraft: value, renameError: '' })

      /**
       * 执行改名（宿主跑 `git branch -m <这条分支> <新名字>`）。
       *
       * 名字必须由用户输入 —— 面板不替他猜。点击「保存」（或回车）之前先就地拦下
       * 四种「点了也只会白跑一次 git」的情形，把原因写在输入框下面（不改命令结果栏）。
       *
       * 注意这里**没有 window.prompt**：桌面版（Electron）不支持 prompt，用它换来的
       * 是「点了没反应」。名字从面板自己的输入框里拿。
       */
      const doRenameBranch = async () => {
        const from = hasText(state.renameFor) ? String(state.renameFor).trim() : ''
        const name = state.renameDraft.trim()
        if (name.length === 0) {
          patch({ renameError: '分支名不能为空：写一个新名字再点「保存」。' })
          return
        }
        // git 对「改成同名」是**成功的空操作**（exit 0、什么都不打印），用户会以为
        // 改名没生效。所以这一句必须由面板说清楚，而不是让 git 沉默地跑一遍。
        if (name === from) {
          patch({ renameError: '新名字和现在的分支名一样（' + from + '）：改一个字再点「保存」。' })
          return
        }
        if (/\s/.test(name)) {
          patch({ renameError: '分支名里不能有空格（' + name + '）。' })
          return
        }
        // 撞远端名（origin/main 这种）与新建分支同一判定：本地分支与
        // refs/remotes/origin/main 同名之后，git 的命令行会开始报 refname ambiguous。
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes)
          ? state.snapshot.remotes
          : []
        const conflict = branchNameRemoteConflict(
          name,
          remotes.map((item) => (item !== null && typeof item === 'object' ? item.name : null)),
        )
        if (conflict !== null) {
          patch({
            renameError: '新名字 ' + name + ' 和远端名 ' + conflict + ' 撞了：' + conflict
              + '/… 是它的远端跟踪引用，本地再有一条同名分支会让 git 的引用产生歧义'
              + '（refname ambiguous）。去掉前缀再改即可。',
          })
          return
        }
        const data = await runOp('renameBranch', { name: name, from: from })
        if (isOk(data)) {
          patch({ renameFor: null, renameDraft: '', renameError: '' })
          await fetchBranches()
        }
      }

      /** 新建分支并切换（输入框回车或点按钮）。 */
      const doCreateBranch = async () => {
        const name = state.branchDraft.trim()
        if (name.length === 0) return
        // 输入框的回车**不经过按钮的 disabled**，所以这里必须再拦一次；宿主也会拒
        // （同一判定，见 ops.js 的 branchNameRemoteConflict）。所以不变量有三层：
        // 按钮锁住 / 这里挡住 / 宿主兜底。
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes)
          ? state.snapshot.remotes
          : []
        const conflict = branchNameRemoteConflict(
          name,
          remotes.map((item) => (item !== null && typeof item === 'object' ? item.name : null)),
        )
        if (conflict !== null) {
          patch({
            output: '分支名 ' + name + ' 和远端名 ' + conflict + ' 撞了：' + conflict
              + '/… 是它的远端跟踪引用，本地再建一个同名分支会让两个引用产生歧义（git 会开始报 ambiguous）。'
              + '去掉前缀再建即可。',
          })
          return
        }
        const data = await runOp('createBranch', { branch: name })
        if (isOk(data)) patch({ branchDraft: '', showBranches: false })
      }

      /** 删除分支：只做安全删除（-d，未合并会被 git 拒绝）。 */
      const doDeleteBranch = async (name) => {
        if (window.confirm('确定删除分支 ' + name + '？\n（仅安全删除：含未合并提交的分支会被拒绝，避免误删历史。）')) {
          const data = await runOp('deleteBranch', { branch: name })
          if (isOk(data)) await fetchBranches()
        }
      }

      /**
       * 点远端分支的「拿成新分支」：把远端那一份开成一个本地新分支并切过去
       * （宿主执行 `git switch -c <remote>-<branch> <remote>/<branch>`）。
       * **原来的分支一点没动**（随时能切回去），但你会**站在新分支上** ——
       * 面板里那句「当前分支不动」曾经把这件事说反了。
       * 远端分支名**显式传给宿主**：这一条的正常场景恰恰是两边名字不一样。
       *
       * 已经有本地分支在跟踪这条远端分支时，面板根本不会给出这个按钮
       * （见 BranchManager 的交叉引用），宿主侧还有一层兜底（见 ops.js 的 adoptRemote）。
       */
      const doAdoptRemoteBranch = async (item) => {
        const data = await runOp('adoptRemote', { mode: 'branch', remote: item.remote, branch: item.name })
        if (isOk(data)) await fetchBranches()
      }

      /**
       * 点远端分支的「比较」：宿主跑 `git rev-list --left-right --count HEAD...<ref>`，
       * 原始输出只是两列数字，所以由宿主翻成人话放进 notes 一起回显 ——
       * 这条**故意不 quiet**：notes 就是用户要看的结论。
       */
      const doCompareRemoteBranch = async (item) => {
        await runOp('compare', { ref: item.ref }, { state: false })
      }

      /**
       * 展开 / 收起某一行的「⋯」次级动作。同一时刻只开一个，而且打开菜单就收起
       * 「设置上游」「改名」这两个就地展开区（它们占的是同一块地方，同时出现只会
       * 让人不知道在看哪个）。
       */
      const toggleBranchMenu = (key) => {
        patch({
          branchMenu: state.branchMenu === key ? null : key,
          upstreamPickerFor: null,
          renameFor: null,
          renameDraft: '',
          renameError: '',
        })
      }

      /** 打开「设置上游」选择器（候选用已经拿到的远端分支列表，不发请求）。 */
      const openUpstreamPicker = (name) => patch({
        upstreamPickerFor: name,
        branchMenu: null,
        renameFor: null,
        renameDraft: '',
        renameError: '',
      })

      /** 收起「设置上游」选择器（什么都不做，只是关掉）。 */
      const closeUpstreamPicker = () => patch({ upstreamPickerFor: null })

      /**
       * 把某个本地分支的上游绑到某条远端分支（宿主执行
       * `git branch --set-upstream-to=<remote>/<branch> <local>`）。
       *
       * 这是「本地名 ≠ 上游名」现场最直接的那条路（现场：`fork-local.2` ↔
       * `fork/local.2`）：以前面板只能把这件事讲清楚（推送失败后给三条补路），
       * 没有任何地方能改它。改完以后本地名不用动，推送 / 拉取都对着选的那条，
       * 也不用到远端另建一个同名分支。
       */
      const doSetUpstream = async (local, item) => {
        const data = await runOp('setUpstream', {
          local: String(local), remote: String(item.remote), branch: String(item.name),
        })
        // 成功才收起选择器：失败时留着，用户可以直接挑另一条再试（结果栏里有原因）。
        if (isOk(data)) {
          patch({ upstreamPickerFor: null, branchMenu: null })
          await fetchBranches()
        }
      }

      /**
       * 点改动条目查看 diff：再点同一条目收起。
       * untracked 文件没有 diff 内容，给一句中文说明而不是空白的输出框。
       */
      const showDiff = async (item) => {
        const key = changeKey(item)
        if (state.diffKey === key) {
          patch({ diffKey: '', diffText: '' })
          return
        }
        patch({ diffKey: key, diffText: '加载中…' })
        const data = await runOp(
          'diff',
          { path: String(item.path), cached: item.staged === true },
          { quiet: true, state: false },
        )
        if (isOk(data)) {
          const text = hasText(data.diff) ? data.diff : ''
          if (typeof item.code === 'string' && item.code.charAt(0) === '?' && text.trim().length === 0) {
            patch({ diffText: '未跟踪文件没有 diff（还没进入版本库）：先「全部暂存」，再点开看已暂存版本。' })
          } else {
            patch({ diffText: hasText(text) ? text : '（这个改动没有可显示的 diff 内容）' })
          }
        } else {
          patch({ diffText: '查看 diff 失败：' + whyFailed(data, '未知错误') })
        }
      }

      // ── 单个改动的三个按钮（暂存 / 取消暂存 / 还原） ────────────────────
      //
      // 面板原先只有「全部暂存」「丢弃改动」两个全量动作：只想提交其中一个文件时，
      // 只能去终端或找 AI。这三个动作正好补齐日常操作的最小闭环。

      /** 暂存这个文件（未跟踪文件也走这条，等价 git add -- <path>）。 */
      const doStageFile = async (item) => {
        await runOp('add', { path: String(item.path) }, { quiet: true })
      }

      /** 取消暂存这个文件：只动暂存区，工作区内容保留（git restore --staged）。 */
      const doUnstageFile = async (item) => {
        await runOp('unstageFile', { path: String(item.path) }, { quiet: true })
      }

      /** 还原这个文件的未提交改动（不可恢复，必须确认）。 */
      const doRestoreFile = async (item) => {
        const ok = window.confirm('确定还原 ' + item.path + ' 的未提交改动吗？\n\n'
          + '· 这个文件在工作区的改动会丢失（不可恢复）\n'
          + '· 已经暂存的部分不受影响')
        if (ok !== true) return
        await runOp('restoreFile', { path: String(item.path) }, { quiet: true })
      }

      /**
       * 点最近提交的一行看详情：再点同一行收起。
       * 详情来自 git show（作者 / 日期 / 改动统计），由宿主截断后回传。
       */
      const doShowCommit = async (hash) => {
        if (state.logRef === hash) {
          patch({ logRef: '', logText: '' })
          return
        }
        patch({ logRef: hash, logText: '加载中…' })
        const data = await runOp('show', { ref: hash }, { quiet: true, state: false })
        if (isOk(data)) {
          patch({ logText: hasText(data.show) ? data.show : '（这条提交没有可显示的详情）' })
        } else {
          patch({ logText: '查看提交详情失败：' + whyFailed(data, '未知错误') })
        }
      }

      /**
       * 「拉这儿」的请求体：「拉取自」下拉里选的那个远程（可能还点名了分支）+「变基」勾选。
       *
       * 「拉取」与「安全拉取」共用同一份：用户在「拉取自」里选了 origin，却因为工作区
       * 脏而点了「安全拉取」—— 那时它必须也从 origin 拉。两个按钮拉的不是同一个地方，
       * 正是本插件一直在消灭的那类不一致，而且它发生在「只差一个按钮就成功」的时刻。
       *
       * @param wanted - 这次要拉的值（'origin' 或 'origin master'）。不给时用「拉取自」
       *   里选的那一个。远程行的「从此外拉」把值直接传进来，于是「我想拉上游那份」这件事
       *   在面板上有两条入口，走的是同一条命令（与「推送到此」和「推送到」的关系一样）。
       *
       * 两样都没有时返回 null：老客户端 / 老宿主都按 null 处理成裸 pull。
       */
      const pullBody = (wanted) => {
        const target = parsePullTarget(hasText(wanted) ? wanted : pullTargetRemote(state))
        const body = {}
        if (target.remote.length > 0) {
          body.remote = target.remote
          // 点名的分支（远端默认分支那条路）才传 branch：不传时宿主按当前分支名补，
          // 那正是「拉同名分支」的老行为。
          if (target.branch.length > 0) body.branch = target.branch
        }
        if (state.pullRebase === true) body.rebase = true
        return Object.keys(body).length > 0 ? body : null
      }

      /**
       * 「拉取」：把选中的来源交给宿主（不选 = 跟随上游，裸 git pull）。
       * 与 push() 完全对称 —— 两边都读自己那份按仓库的记忆，都做同一种
       * 「新客户端 + 旧宿主」守卫（见 remoteStaleHost）。
       *
       * @param wanted - 见 pullBody。远程行的「从此外拉」从这里进来。
       */
      const pull = async (wanted) => {
        const value = hasText(wanted) ? String(wanted) : pullTargetRemote(state)
        const data = await runOp('pull', pullBody(value))
        patch({ pullHostStale: remoteStaleHost(data, parsePullTarget(value).remote) })
      }

      /**
       * 「安全拉取」：与「拉取」同一个来源、同一套安全保证（stash → pull → pop）。
       * 来源不跟随「拉取自」的话，用户会得到一个「从 fork 拉」的按钮和一个「从 origin 拉」
       * 的按钮，而它们看起来是同一件事的两个版本（工作区脏不脏而已）。
       */
      const stashPullNow = async () => {
        const value = pullTargetRemote(state)
        const data = await runOp('stashPull', pullBody(value))
        patch({ pullHostStale: remoteStaleHost(data, parsePullTarget(value).remote) })
      }

      /**
       * 推送失败后的面板侧补救：需要用户先填地址（没有远程 / 远程不存在）时，
       * 把地址输入框打开并给出提示，而不是只留一行 git 的英文报错。
       *
       * @param remote - 这一次要推到哪个远程。不给时用「推送到」下拉里选的那一个
       *   （没有选 = 跟随上游，裸 git push）。远程行的「推送到此」直接把名字传进来，
       *   于是「我想推 fork」这件事在面板上有两条入口，走的是同一条命令。
       */
      const push = async (remote) => {
        const wanted = hasText(remote) ? String(remote) : pushTargetRemote(state)
        const data = await runOp('push', wanted.length > 0 ? { remote: wanted } : null)
        // 「新客户端 + 旧宿主」中间态：旧宿主的回执里没有你选的那个远程（见 remoteStaleHost）。
        patch({ pushHostStale: remoteStaleHost(data, wanted) })
        const reason = data !== null && data !== undefined && typeof data.reason === 'string' ? data.reason : 'none'
        if (isOk(data) !== true && (reason === 'no-remote' || reason === 'remote-not-found')) {
          // 没有远程 / 远程不存在 → 直接打开「添加远程」表单（editingRemote=''），
          // 而不是把某个已有远程的编辑器打开（那会把地址填进错误的输入框）。
          patch({
            editingRemote: '',
            remoteDraftName: 'origin',
            remoteDraftUrl: '',
            remoteError: hasText(data.hint) ? data.hint : '需要先配置远程仓库地址',
          })
        }
        // 服务器说这个远程推不进去（没有写权限 / 分支受保护）、而宿主又没给出任何
        // 「推送到别的远程」按钮：把「添加远程」表单直接打开（现场：origin 是别人的
        // 仓库、你还没有自己的那份），让用户当场把地址加进来。
        //
        // 判断依据是**宿主的回执**（data.choices）而不是渲染时的 snapshot.remotes：
        // 远程可能在面板之外刚被加上/删掉（终端里 git remote add、AI 工具删了一个），
        // 而面板最多 60 秒才知道。用 snapshot 判断会同时犯两种错 —— 刚加上的 fork
        // 被当成「没有别的远程」而弹表单（宿主其实已经给了按钮），或者刚删掉的远程
        // 还留在 snapshot 里，于是既没有按钮、也不开表单，用户只看到一句提示。
        if (isOk(data) !== true && (reason === 'no-permission' || reason === 'branch-protected')) {
          const choices = data !== null && Array.isArray(data.choices) ? data.choices : []
          if (choices.length === 0) {
            patch({
              editingRemote: '',
              remoteDraftName: 'fork',
              remoteDraftUrl: '',
              remoteError: hasText(data.hint) ? data.hint : '这个远程推不进去：把你能推的仓库地址加进来再试。',
            })
          }
        }
      }

      /**
       * 记住「以后推 / 拉到这个远程」（按仓库目录记在 localStorage 里）。
       * 传空串 = 回到「跟随上游」。渲染时会再校验一次该远程是否还存在
       * （见 remoteTargetFor），所以这里不必替删掉远程的情况操心。
       *
       * 写入前**重读一次**存储表再合并：面板可能同时开着几个标签页（同一台机器的
       * 127.0.0.1 端口），而 state 里那份是挂载时读的快照 —— 拿它整体覆盖会把别的
       * 标签页刚记下的其它仓库条目一起抹掉。
       *
       * 推与拉共用这一个实现（键与 state 字段不同）：两个选择是对称的一对，
       * 分两份写只会让下一次改动漏掉其中一边。
       */
      const rememberRemoteTarget = (key, name, field) => {
        const dir = hasText(state.workdir) ? String(state.workdir) : ''
        if (dir.length === 0) return
        const value = hasText(name) ? String(name) : ''
        const table = Object.assign({}, readStoredRemoteTable(key))
        if (value.length === 0) delete table[dir]
        else table[dir] = value
        writeStoredRemoteTable(key, table)
        patch({ [field]: table })
      }

      const setPushRemote = (name) => rememberRemoteTarget(PUSH_REMOTE_KEY, name, 'pushRemoteByDir')
      const setPullRemote = (name) => rememberRemoteTarget(PULL_REMOTE_KEY, name, 'pullRemoteByDir')

      /**
       * 远程行的「从此外拉」/「拉 master」：**记住这个来源，然后拉一次**。
       *
       * 与「推送到此」完全对称（见 GitPanel 里的 onPushToRemote），理由也一样：只拉不记的话，
       * 用户点完这一行再点「拉取」会突然拉回原处，像功能失灵。
       *
       * @param value - 'origin' 或 'origin master'（见 parsePullTarget / pullPlanFor）。
       */
      const pullFromRemote = async (value) => {
        const wanted = hasText(value) ? String(value) : ''
        if (wanted.length === 0) return
        setPullRemote(wanted)
        await pull(wanted)
      }

      /**
       * 清掉固定结果区里的那块结果。
       * 结果会一直挂在面板底部（不再随正文滚走），所以必须给用户一个「看完了，收起来」
       * 的动作 —— 否则它会一直占着面板的高度，直到下一次操作为止。
       */
      const clearOutput = () => {
        patch({ output: '' })
      }

      /**
       * 回到正文顶部。面板长了以后（分支管理 + stash + 提交历史全展开），
       * 从底部一路滑回「改动」要滚很久 —— 底部状态条点一下就是这条捷径。
       * 假节点（测试）没有 scrollTop，所以先判类型再动。
       */
      const scrollToTop = () => {
        const node = bodyRef.current
        if (node === null || node === undefined) return
        if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior: 'smooth' })
        else node.scrollTop = 0
      }

      /**
       * 打开某个远程的就地编辑器（remote 为该远程名）。
       *
       * 草稿从**这一行**播种（名字与地址都取自同一个远程），所以「显示哪一行、
       * 保存到哪一行」永远一致。原先只有一个草稿字段、名字框写死 origin：
       * fork 排在 origin 前面时，编辑 fork 会让地址框显示 fork 的地址、名字框
       * 却写着 origin，点保存就把 origin 改指向 fork（实测复现过）。
       */
      const openRemoteEditor = (remote) => {
        const name = hasText(remote) ? String(remote) : ''
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes) ? state.snapshot.remotes : []
        const found = remotes.find((item) => item !== null && typeof item === 'object' && item.name === name)
        patch({
          editingRemote: name,
          remoteDraftName: name,
          remoteDraftUrl: found !== undefined && hasText(found.url) ? String(found.url) : '',
          remoteError: '',
        })
      }

      /** 打开「添加远程」表单：名字留空（由用户填），地址留空。 */
      const openRemoteAdder = () => {
        patch({ editingRemote: '', remoteDraftName: '', remoteDraftUrl: '', remoteError: '' })
      }

      /** 收起远程编辑器（草稿一起丢，下次打开重新播种）。 */
      const closeRemoteEditor = () => {
        patch({ editingRemote: null, remoteError: '' })
      }

      /** 保存远程地址；成功返回**落到哪个远程名**，失败返回 null。 */
      const saveRemote = async () => {
        const url = state.remoteDraftUrl.trim()
        if (url.length === 0) {
          patch({ remoteError: '请填写仓库地址' })
          return null
        }
        // 编辑既有远程时名字由被编辑的那一行决定，不读草稿里的名字框 ——
        // 名字栏在编辑态是只读文本，这样即便状态被外部刷新也不会改错对象。
        const editing = state.editingRemote
        const name = hasText(editing)
          ? String(editing)
          : (state.remoteDraftName.trim().length > 0 ? state.remoteDraftName.trim() : 'origin')
        const data = await runOp('setRemote', { name: name, url: url })
        if (isOk(data) === true) {
          // 保存成功：草稿已落盘，收起编辑器并由新 snapshot 重新渲染那一行。
          patch({ editingRemote: null, remoteError: '' })
          return name
        }
        patch({ remoteError: whyFailed(data, '保存远程地址失败') })
        return null
      }

      /**
       * 面板上的「保存并推送」：配好地址后直接推一次，省掉第二次点击。
       *
       * 推的是**刚保存的那个远程**（而不是裸 push）：用户在这里的意图就是「把代码推到
       * 我刚填的这个仓库」，而裸 push 走的是上游/默认远程 —— 刚加了 fork 却推到 origin
       * 正是要避免的事。同时也把它记成这个仓库的「推送到」选择，后面的「推送」按钮
       * 跟着一起走。
       */
      const saveRemoteAndPush = async () => {
        const name = await saveRemote()
        if (name === null) return
        setPushRemote(name)
        await push(name)
      }

      /**
       * 删掉一个远程。
       *
       * 必须二次确认，而且确认文案要说清「只动本地」：服务器上的仓库与你的提交都不受影响，
       * 但它的远端跟踪引用（`refs/remotes/<名字>/*`）会一起消失，重新加回来就是一句
       * git remote add —— 这几件事不说清楚，用户不敢点，或者点了才后悔。
       */
      const removeRemote = async (name) => {
        if (!hasText(name)) return
        const ok = window.confirm('删掉远程 ' + name + ' 吗？\n\n'
          + '· 只删本地的配置与它的远端跟踪引用 refs/remotes/' + name + '/*\n'
          + '· 服务器上的仓库、以及你的提交都不受影响\n'
          + '· 需要时可以用 git remote add ' + name + ' <地址> 加回来')
        if (ok !== true) return
        const data = await runOp('removeRemote', { name: String(name) })
        if (isOk(data) !== true) return
        // 删掉的可能正是面板正在编辑的那一个：收起编辑器，别让它停在一个已经不存在的远程上。
        patch({ editingRemote: null, remoteError: '' })
      }

      /**
       * 复制某个远程的地址到剪贴板（优先 Clipboard API，非安全上下文退回 execCommand）。
       * 复制的是**被点的那一行**的地址，不再固定取 remotes[0] —— 多远程下
       * 点 fork 的「复制」却得到 origin 的地址，是同一个串线问题的另一面。
       * @param name - 远程名。
       * @param url - 该远程的地址（调用方从 snapshot 里取好传进来，避免二次查找）。
       */
      const copyRemote = async (name, url) => {
        const target = hasText(url) ? String(url) : ''
        if (target.length === 0) return
        const done = () => {
          patch({ remoteCopied: hasText(name) ? String(name) : '' })
          window.setTimeout(() => patch({ remoteCopied: null }), 1500)
        }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined
            && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(target)
            done()
            return
          }
        } catch (error) {
          /* 落到下面的 execCommand 兜底 */
        }
        try {
          if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const area = document.createElement('textarea')
            area.value = target
            document.body.appendChild(area)
            area.select()
            const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
            document.body.removeChild(area)
            if (copied === true) {
              done()
              return
            }
          }
        } catch (error) {
          /* 下面统一提示失败 */
        }
        patch({ output: '复制失败：请手动选中远程地址复制\n' + target })
      }

      /**
       * 提交。amend=true 时用 --amend 补充到上一次提交。
       * @returns 宿主返回的响应对象，调用方按 isOk 判断（「提交并推送」要靠它决定推不推）。
       */
      const doCommit = async (amend) => {
        const withAmend = amend === true
        const text = state.message
        patch({ message: '' })
        const data = await runOp('commit', { message: text, amend: withAmend })
        if (isOk(data)) {
          if (withAmend) patch({ commitAmend: false })
        } else {
          // 失败时把输入文本写回，方便修改后重试（空提交、钩子失败很常见）。
          patch({ message: text })
        }
        return data
      }

      /** 提交并推送：成功提交后直接推一次，省掉「提交完再点推送」的第二下。 */
      const doCommitAndPush = async (amend) => {
        const data = await doCommit(amend)
        if (isOk(data)) await push()
      }

      // 只读一次；失败就静默保持「未加载」，面板其余部分照常可用。
      React.useEffect(() => { loadNet(true) }, [])

      // 跟随当前会话目录刷新；用户手动切换过目录后不再覆盖。
      // 当前会话的 cwd 变了就是「换了工作区」，走 switchDir 连旧工作区的运行结果
      // 一起清掉。（首次运行时这些字段本来就是空的，多清一次是无操作。）
      React.useEffect(() => {
        if (state.picked === true) return
        switchDir(hasText(sessionCwd) ? sessionCwd : '')
      }, [sessionCwd])

      // diff 一展开就把它滚进可视区：它内联在改动清单里，清单本身和面板正文都可能
      // 需要滚动 —— 不滚的话用户点了一下可能什么都没看见（以为没反应）。
      // scrollIntoView 只在真实浏览器里有（测试里的假节点没有），所以先判类型。
      React.useEffect(() => {
        if (state.diffKey.length === 0) return
        const node = diffRef.current
        if (node === null || node === undefined || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest' })
      }, [state.diffKey])

      /**
       * 这里**曾经**有一个「从 state 同步远程地址草稿」的 effect，现已删除。
       *
       * 它之所以存在，是因为旧设计只有一个全局草稿、靠 `remoteDirty` 标记「用户改没改过」
       * 来决定要不要用 snapshot 覆盖它 —— 而 snapshot 里的是 remotes[0]，于是「编辑哪个
       * 远程」取决于排序，而不是取决于用户点了哪一行（串线 bug 的根源）。
       *
       * 现在草稿只在**打开编辑器的那一刻**从「被点的那一行」播种（见 openRemoteEditor），
       * 打开期间不被任何状态刷新覆盖，用户输入因此不会被吃掉；保存/收起时草稿随编辑器
       * 一起丢弃，下次打开重新播种。少了这个 effect，也就少了「草稿属于哪个远程」
       * 这个必须靠标记维护的隐含状态。
       */

      // 界面的记忆：折叠态与宽度都存 localStorage（失败了只是下次用默认值）。
      // 已删除：这一版没有「插件自己的窗口壳」——右下角浮窗时代才需要记住宽度与
      // 最小化胶囊；现在由右侧栏的 docking kit 管布局，插件不写这两个键。

      // 操作成功后的回音：把结果栏滚进视口并闪一下（结果栏在最底部，容易被漏看）。
      // classList / scrollIntoView 在测试的假节点里都没有，先判类型再动。
      React.useEffect(() => {
        if (flashRef.current !== true) return
        flashRef.current = false
        const node = outRef.current
        if (node === null || node === undefined) return
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        if (node.classList !== undefined && node.classList !== null && typeof node.classList.add === 'function') {
          node.classList.remove('dgs-out-flash')
          // 读一次布局属性强制重排，让「同一个 class 再加一次」也能重放动画。
          void node.offsetWidth
          node.classList.add('dgs-out-flash')
        }
      }, [state.output])

      /**
       * 后台自动刷新：窗口重新获得焦点 / 标签页重新可见时静默读一次状态。
       *
       * 为什么需要：用户在终端里提交完回到浏览器，面板还停在上一次操作的结果上，
       * 得手动点「刷新」才会更新 —— 而那正是最容易被忘记的一步。
       * 只在已经绑定了仓库时刷新；静默 = 不点亮「同步中…」、失败不刷结果栏。
       */
      React.useEffect(() => {
        const isRepo = state.snapshot !== null && state.snapshot.isRepo === true
        if (isRepo !== true) return undefined
        if (typeof window.addEventListener !== 'function') return undefined
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(hasText(state.workdir) ? state.workdir : '', true)
        }
        window.addEventListener('focus', refresh)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', refresh)
        }
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', refresh)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', refresh)
          }
        }
      }, [state.workdir, state.snapshot === null ? null : state.snapshot.isRepo])

      /**
       * 轻量轮询：面板之外的 git 改动没有任何事件可听，只能定时读一次状态。
       *   · 有未提交改动 → 20 秒：胶囊上的红点与改动数要跟得上编辑器 / 终端的节奏。
       *   · 工作区干净 → 60 秒：**干净时也必须轮询** —— 切分支、拉取、别人替你提交、
       *     AI 工具在同一个 DSH 里跑 git，这些都发生在工作区干净的时候。早先「干净就
       *     不轮询」会让面板一直停在旧分支 / 旧领先数上，只有用户碰巧切了一次标签页
       *     （focus / visibilitychange 那次静默刷新）或手动点「刷新」才会更新。
       * 只在标签页可见时跑，隐藏时靠 visibilitychange 那一次补上。
       */
      React.useEffect(() => {
        const snapshot = state.snapshot
        if (snapshot === null || snapshot.isRepo !== true) return undefined
        if (typeof window.setInterval !== 'function') return undefined
        const total = typeof snapshot.changesTotal === 'number' ? snapshot.changesTotal : 0
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(hasText(state.workdir) ? state.workdir : '', true)
        }, total > 0 ? POLL_DIRTY_MS : POLL_CLEAN_MS)
        return () => {
          if (typeof window.clearInterval === 'function') window.clearInterval(timer)
        }
      }, [
        state.workdir,
        // 依赖只放三个**原始值**：state.snapshot 每次轮询都会换成新对象，放进依赖会让
        // 定时器每轮都被清掉重建 —— 那样它永远等不到 20 / 60 秒。
        state.snapshot === null ? null : state.snapshot.isRepo,
        state.snapshot === null || typeof state.snapshot.changesTotal !== 'number'
          ? 0
          : state.snapshot.changesTotal,
      ])

      /**
       * 分支管理开着时，仓库状态一变就重列一次分支：外部（终端 / AI 工具 / 另一个会话）
       * 切分支、新建、删除都不经过面板的按钮，列表不刷新就会停在旧分支上 —— 刚删掉的
       * 分支还挂在列表里、AI 刚建出来的分支看不见。与下面 stash 备份区那条 effect 同一套
       * 理由：只读、且只在展开状态下跑，不给日常操作加请求。
       */
      React.useEffect(() => {
        if (state.showBranches !== true) return
        fetchBranches()
      }, [state.snapshot])

      /**
       * stash 备份区开着时，仓库状态一变就把它刷新一次：操作之后（安全拉取、
       * 安全切分支、应用/删除备份）列表里的编号 stash@{n} 会整体前移一位，
       * 不刷新的话用户看到的编号是旧的 —— 而编号就是要交给 git 的参数。
       * 只读、且只在展开状态下跑，所以不会给日常操作增加任何请求。
       */
      React.useEffect(() => {
        if (state.showStash !== true) return
        fetchStashList()
      }, [state.snapshot])

      return {
        state,
        patch,
        diffRef,
        outRef,
        bodyRef,
        sessionCwd,
        actions: {
          load, switchDir, forgetRepoDetails, loadNet, saveNet, probeNet, runOp, runChoice,
          fetchBranches, toggleBranches, fetchStashList, toggleStash, doStashApply, doStashDrop,
          doCheckout, doCheckoutCommit, doCreateBranch, doDeleteBranch, doRenameBranch,
          doAdoptRemoteBranch, doCompareRemoteBranch, showDiff,
          toggleBranchMenu, openUpstreamPicker, closeUpstreamPicker, doSetUpstream,
          openRenameEditor, closeRenameEditor, renameDraftChange,
          doStageFile, doUnstageFile, doRestoreFile, doShowCommit,
          push, saveRemote, saveRemoteAndPush, copyRemote, removeRemote, doCommit, doCommitAndPush,
          setPushRemote, pull, stashPullNow, setPullRemote, pullFromRemote,
          openRemoteEditor, openRemoteAdder, closeRemoteEditor,
          remoteDraftName: (value) => patch({ remoteDraftName: value }),
          remoteDraftUrl: (value) => patch({ remoteDraftUrl: value }),
          clearOutput, scrollToTop,
          openPicker, closePicker, pickList, pickSelect, pickEnter, pickCrumb,
          pickDraftStart, pickDraftCancel, pickDraftSubmit,
          pickDraftChange: (value) => patch({ pickDraft: value }),
          pickToggleHidden: () => patch({ pickShowHidden: state.pickShowHidden !== true }),
          pickConfirm, pickSystem,
          pickCreateStart, pickCreateCancel, pickCreate,
          pickCreateDraft: (value) => patch({ pickFolder: value }),
        },
      }
    }

    // ── 展示组件（纯函数，不持有任何 hook） ───────────────────────────────
    //
    // 全部由 GitPanel 用 React.createElement(Component, props) 挂载。它们不调用
    // hook，因此 hook 顺序永远只由 useGitPanel / GitPanel 决定 —— 这是把上千行的
    // 组件拆开却不会踩「hook 顺序」坑的前提。

    /** 头部：标题 + 「同步中」提示 + 右侧图标按钮组。 */
    function HeadBar(props) {
      const h = React.createElement
      // 三个图标的**文本标签一个字都不改**（🌐 / ? / —）：用户和测试都按它找按钮。
      return h('div', { style: S.head, className: 'dgs-head', key: 'head' },
        h('span', { style: S.title }, '🐙 Git 面板'),
        // 忙碌提示 = 转圈 + 文字。转圈那个 span 里没有文字，所以面板的可见文本里
        // 仍然只有「同步中…」这三个字加省略号（用户和测试读到的都是它）。
        props.busy === true
          ? h('span', {
              style: Object.assign({}, S.note, { display: 'inline-flex', alignItems: 'center', gap: '5px' }),
              key: 'busy',
            },
              h('span', { style: S.busyDot, className: 'dgs-spin' }),
              h('span', null, '同步中…'))
          : null,
        h('span', { style: S.spacer }),
        h('div', { style: S.headActions },
          h('button', {
            style: S.mini,
            className: 'dgs-mini',
            key: 'net',
            type: 'button',
            'aria-label': '网络加速设置',
            title: '网络加速：连不上 github.com（Connection was reset / 超时）时打开，可走镜像或本机代理',
            onClick: () => props.onToggleNet(props.showNet !== true),
          }, '🌐'),
          h('a', {
            style: S.miniLink,
            className: 'dgs-mini',
            href: '/git-sidebar/help',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '打开 Git 帮助文档（新标签页）：面板操作方式 + 常用命令，命令点一下即复制',
          }, '?'),
        ),
      )
    }

    /**
     * 标签正文的容器：右侧栏给一块框，这里把它铺满。
     *
     * 与旧版（shell.overlay 浮窗）的差别：不画任何自己的窗口壳 —— 没有定位、没有
     * 阴影、没有「最小化成胶囊」。右侧栏的标签栏已经负责「这个面板在不在、在哪、
     * 多大」，插件再实现一遍既重复又会和宿主的控件抢同一块区域。
     *
     * 这一层保留下来是为了两件事：
     *   · 把「开关关掉」表达成**内容区留一条说明**，而不是整块消失 —— 标签是用户
     *     自己开的，突然空掉会像坏了；说清楚「去设置里开回来」才是可理解的。
     *   · 挂载局部样式表（panelStyles），随本标签卸载一起回收。
     */
    function GitTabBody(props) {
      const h = React.createElement
      const [enabled] = useEnabled()
      if (enabled !== true) {
        return h(React.Fragment, null,
          panelStyles(),
          h('div', { style: S.panel, className: 'dgs-panel' },
            h('div', { style: S.body },
              h('div', { style: S.empty },
                h('div', { style: S.emptyIcon }, '🐙'),
                h('div', null, 'Git 面板已关闭'),
                h('div', { style: S.note },
                  '在「设置 → 通用 → Git 面板」里重新开启即可。')))))
      }
      return h(GitPanel, props)
    }

    /**
     * 面板底部常驻状态条：左边「上一次操作成没成 + 我在哪个分支、有多少改动」，
     * 右边「和远端是什么关系」。
     *
     * 为什么把它单独拎出来常驻：面板长了以后（分支管理 + stash + 提交历史全展开），
     * 分支与改动数早就滚出视野了 —— 而这两个正是「我现在该干什么」的依据。
     * 点它一下回到正文顶部（长面板里从底部滑回改动清单要滚很久）。
     */
    function StatusBar(props) {
      const h = React.createElement
      const ok = props.lastOk
      const dotColor = ok === true
        ? GOOD_TEXT
        : (ok === false
            ? BAD_TEXT
            // 中立档保持 label-tertiary：这颗点是一个**图形指示器**（9px 的圆点），
            // 适用 WCAG 1.4.11 的 3:1，而不是正文的 4.5:1 ——
            // #81858c 压白底是 3.71:1，已经过关（audit.js 对单个符号按 3:1 判）。
            : 'var(--dsw-alias-label-tertiary, #999999)')
      const dotTitle = ok === true
        ? '上一次操作：成功'
        : (ok === false ? '上一次操作：失败（原因见命令结果）' : '还没有在这个仓库里执行过操作')
      const goTop = () => props.onTop()
      return h('div', {
        style: S.status,
        className: 'dgs-status dgs-clickable',
        key: 'status-bar',
        role: 'button',
        tabIndex: 0,
        title: dotTitle + ' · 点击回到面板顶部',
        onClick: goTop,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            goTop()
          }
        },
      },
        h('span', {
          style: Object.assign({}, S.statusDot, { color: dotColor }),
          title: dotTitle,
        }, '●'),
        h('span', { style: S.statusText, title: String(props.summary) }, String(props.summary)),
        hasText(props.tail) ? h('span', { style: S.statusTail }, String(props.tail)) : null,
        // 本地名 ≠ 上游名：提前把「点了推送会被 git 拒」这件事说出来，并指向那三条路。
        props.mismatch === true ? h('span', {
          style: S.statusWarn,
          className: 'dgs-status-warn',
          title: '本地分支名和上游的远端分支名不一样：默认配置（push.default=simple）下裸 push 会被 git 拒绝。'
            + '点「推送」，面板会给出三条可选的路（推到上游那条 / 另建同名远端分支 / 把本地名改成和上游一致）。',
        }, '名称不一致') : null,
      )
    }

    /** 网络加速设置块：放在最前面 —— 它解释「为什么刚才那条命令连不上」。 */
    function NetSection(props) {
      const h = React.createElement
      const net = props.net
      const netCfg = net !== null && typeof net === 'object' ? net : {}
      const candidates = Array.isArray(netCfg.candidates) ? netCfg.candidates : []
      // 这里刻意不用 panelButton：那个会被 busy 锁住，而用户在等待一次卡住的 fetch 时
      // 恰恰最需要能改设置。
      const netBtn = (label, onClick, primary) => h('button', {
        key: label,
        type: 'button',
        className: buttonClass(primary === true, false),
        style: buttonStyle(primary === true, props.netBusy === true),
        disabled: props.netBusy === true,
        onClick: onClick,
      }, label)

      const children = [
        h('div', { style: S.netTitle, key: 'title' },
          h('span', null, '🌐 网络加速'),
          h('span', { style: S.spacer }),
          h('span', { style: S.note }, props.ready !== true
            ? '不可用'
            : (netCfg.mirrorEnabled === true
                ? '镜像已开' + (netCfg.hasProxy === true ? ' + 代理' : '')
                : (netCfg.hasProxy === true ? '仅代理' : '仅直连'))),
        ),
      ]

      if (props.ready !== true) {
        // 配置读不到（典型是「客户端已热重载、宿主还没重启」）时**只显示说明**：
        // 控件照着渲染而没有宿主可写，比不显示更糟 —— 用户会点、会以为生效了。
        children.push(h('div', { style: S.warn, key: 'unavailable' },
          '读不到宿主配置：宿主半边还是旧版本，重启一次 dsh 后本设置即可用'
          + '（客户端界面会热重载，但宿主路由不会）。'))
      } else {
        children.push(
          h('div', { style: S.netRow, key: 'mirrorpick' },
            h('select', {
              style: S.select,
              className: 'dgs-input',
              value: hasText(netCfg.mirror) ? netCfg.mirror : '',
              onChange: (event) => props.onSave({ mirror: event.target.value, mirrorEnabled: true }, false),
            }, candidates.map((item) => h('option', {
              key: String(item.prefix),
              value: String(item.prefix),
            }, String(item.label)))),
          ),
          h('label', { style: S.netRow, key: 'mirrortoggle' },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: netCfg.mirrorEnabled === true,
              onChange: (event) => props.onSave({ mirrorEnabled: event.target.checked }, false),
            }),
            h('span', null, '用镜像加速克隆 / 获取 / 拉取'),
          ),
          h('div', { style: S.warn, key: 'mirrorwarn' },
            '镜像会把请求转给第三方：公开仓库没问题，私有仓库请改用下面的代理；推送不走镜像。'),
          h('div', { style: S.netRow, key: 'proxy' },
            h('input', {
              style: S.input,
              className: 'dgs-input',
              value: props.netProxy,
              placeholder: '本机代理 http://127.0.0.1:7890（留空 = 不用）',
              onChange: (event) => props.onProxyChange(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onSave({ proxy: props.netProxy }, true)
                }
              },
            }),
            netBtn('保存代理', () => props.onSave({ proxy: props.netProxy }, true), true),
          ),
          h('div', { style: S.netRow, key: 'probe' },
            netBtn(props.netBusy === true ? '检测中…' : '检测网络', () => props.onProbe()),
            h('span', { style: S.note }, '实测这台机器上哪条线路通'),
          ),
        )
      }

      if (Array.isArray(props.netProbe)) {
        children.push(h('div', { style: S.list, key: 'results' },
          props.netProbe.map((item, index) => h('div', {
            style: S.item, className: 'dgs-rowitem', key: 'p' + index,
          },
            h('span', { style: item.ok === true ? S.good : S.bad }, item.ok === true ? '✓' : '✗'),
            h('span', {
              style: S.name,
              title: String(item.error === undefined || item.error === null ? '' : item.error),
            }, String(item.label)),
            h('span', { style: S.probeMs }, item.ok === true
              ? (String(item.ms) + 'ms')
              : String(item.error === undefined || item.error === null ? '失败' : item.error)),
          )),
        ))
      }

      return h('div', { style: S.netBox, key: 'net' }, children)
    }

    /**
     * 仓库卡片：目录 / 分支 / 远程三行。
     * 这三行都是「这个仓库现在是什么样」的只读信息（各自带一个动作按钮），放进同一张
     * 卡里与下面的改动 / 提交 / 同步区分开，避免一长串同权重的行。
     */
    function RepoCard(props) {
      const h = React.createElement
      const s = props.state
      const locked = props.locked === true
      const isRepo = props.isRepo === true
      const remotes = props.remotes
      const rows = []
      // 当前分支名（游离 HEAD / 尚无提交时是空串）：远程行的「从此外拉」要把它写进 tooltip，
      // 用户才知道「同名那条」到底是哪一条。
      const branchName = isRepo && s.snapshot !== null && hasText(s.snapshot.branch)
        ? String(s.snapshot.branch)
        : ''

      rows.push(h('div', { style: S.row, key: 'dir' },
        h('span', { style: S.label }, '目录'),
        h('span', { style: S.path, title: s.workdir }, hasText(s.workdir) ? s.workdir : '（默认目录）'),
        // 「切换」弹目录选择小窗口 —— 与 DSH「添加工作区」同一个选择器
        // （见 PickDialog）：浏览目录 / 直接输入路径 / 新建文件夹，选完就切过去。
        panelButton('切换', () => props.onPickDir(), {
          locked: locked,
          title: '弹出目录选择小窗口（与「添加工作区」同一个选择器），选完面板就切到那个目录',
        }),
        panelButton('刷新', () => props.onRefresh(), { locked: locked }),
        s.picked === true && hasText(props.sessionCwd)
          ? panelButton('跟随会话', () => props.onFollowSession(props.sessionCwd), { locked: locked })
          : null,
      ))

      const upstream = isRepo && hasText(s.snapshot.upstream) ? s.snapshot.upstream : null
      rows.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        // 名字过长会被省略号截断：tooltip 里给全名兜底（见 S.branch 的注释）。
        h('span', {
          style: S.branch,
          title: isRepo && hasText(s.snapshot.branch) ? '当前分支：' + String(s.snapshot.branch) : undefined,
        }, isRepo
          ? (hasText(s.snapshot.branch) ? s.snapshot.branch : '（尚无提交）')
          : '—'),
        // 上游状态：`→ origin/master`；没有上游时明说，并在 tooltip 里指向按钮
        // （面板的「拉取」会自动补这一步，所以不要求用户去记 git 命令）。
        // 与分支名一样可收缩（省略号 + tooltip 全名），长分支下「管理」不被顶出面板。
        isRepo
          ? h('span', {
              style: Object.assign({}, S.note, {
                flex: '0 1 auto', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }),
              title: upstream === null
                ? '未设上游：本地分支还不知道对应远端哪个分支。直接点「拉取」即可，面板会自动按「远程 + 当前分支」拉取并登记上游。'
                : '上游：本地 ' + String(s.snapshot.branch) + ' 对应远端 ' + upstream,
            }, upstream === null ? '未设上游' : '→ ' + upstream)
          : null,
        h('span', { style: S.spacer }),
        // 「领先/落后」留在这一行；改动摘要搬到了下面「改动」区块的标题上 ——
        // 那才是它描述的内容（点「全部暂存」后数字要跟着变）。
        isRepo
          ? (trackingSummary(s.snapshot).length > 0
              ? h('span', { style: S.note }, trackingSummary(s.snapshot))
              : null)
          : h('span', { style: S.note }, '还不是 Git 仓库'),
        isRepo
          ? panelButton(s.showBranches === true ? '收起' : '管理', () => props.onToggleBranches(), { locked: locked })
          : null,
      ))

      // ── 远程仓库 ────────────────────────────────────────────────────────
      //
      // 这里曾经只显示 `remotes[0]`（按名字排序的第一个），其余远程在界面上完全
      // 不存在；而展开的编辑框名字写死 origin、地址却播种自 remotes[0] —— 于是
      // 「fork 排在 origin 前面」时，点「改」再点「保存」会把 origin 的地址改成
      // fork 的地址（实测复现）。现在改成：**每个远程一行，各自带自己的编辑区**，
      // 编辑器认的是「被点的那一行」，不存在「显示 A、改到 B」的可能。
      if (isRepo) {
        rows.push(h('div', { style: S.sectionTitle, key: 'remotetitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, remotes.length === 0
            ? '远程仓库'
            : '远程仓库（' + remotes.length + '）'),
          h('span', { style: S.sectionRule }),
        ))

        if (remotes.length === 0) {
          rows.push(h('div', { style: S.note, key: 'remote-empty' },
            '还没有远程仓库：推送到不了任何地方。'))
        }

        const duplicated = Array.isArray(s.snapshot.duplicateRemotes) ? s.snapshot.duplicateRemotes : []
        /**
         * 哪个远程是「重复的那个」：宿主说保留 keep、其余可删。
         *
         * 只给**可删的那些行**挂提示（保留的那行不该也报警告：两边都报会让用户
         * 以为两个都有问题），而且提示要点名「跟谁重复」——只写「有重复」等于没说。
         */
        const duplicateOf = new Map()
        for (const group of duplicated) {
          if (group === null || typeof group !== 'object') continue
          if (!Array.isArray(group.remove) || !hasText(group.keep)) continue
          for (const name of group.remove) {
            if (hasText(name)) duplicateOf.set(String(name), String(group.keep))
          }
        }

        for (let index = 0; index < remotes.length; index += 1) {
          const remote = remotes[index]
          if (remote === null || typeof remote !== 'object') continue
          const name = String(remote.name)
          const url = hasText(remote.url) ? String(remote.url) : ''
          const editing = s.editingRemote !== null && s.editingRemote === name
          // 这一行「从此外拉」会拉哪条（见 pullPlanFor）：远端默认分支与当前分支不同名时
          // 点名那条分支，按钮因此写成「拉 master」而不是含糊的「从此外拉」。
          const rowPlan = isRepo ? pullPlanFor(s, name) : null
          // 这一行是否有可打开的主页：宿主只按 remotes[0] 推导了一个 pageUrl，
          // 因此只有那一行有入口；其余行不显示，而不是给出一个指错的链接。
          const rowPageUrl = index === 0 && hasText(props.pageUrl) ? props.pageUrl : null

          rows.push(h('div', {
            style: S.remoteRow, className: 'dgs-remote-row', key: 'remote-' + name,
          },
            h('span', {
              style: S.remoteName,
              className: 'dgs-remote-name',
              title: '远程名：' + name + '\n地址：' + url,
            }, name),
            h('span', {
              // minWidth 是「地址至少要有这么宽」的下限：再窄就只剩 `https://g...`，
              // 而地址是这一行里唯一回答「我连的是哪儿」的东西（见 S.remoteRow 注释）。
              // flexBasis 160px 让它优先占满能占的宽度，放不下的按钮换到第二行。
              style: Object.assign({}, S.remoteUrl, { minWidth: '120px', flexBasis: '160px' }),
              className: 'dgs-remote-url',
              title: url,
            }, url.length > 0 ? url : '（没有地址）'),
            rowPageUrl === null
              ? null
              : panelLink('仓库页 ↗', rowPageUrl, '打开仓库主页（新标签页）：' + rowPageUrl, 'repo-page-' + name,
                  // compact：它是远程行里的一分子，必须和右边那排紧凑按钮同高（见 panelLink 注释）。
                  { compact: true }),
            // 「推送到此」：多远程下最直接的那个入口 —— 点哪一行就推到哪一行。
            // 当前选中的那个用品牌色（primary）标出来，于是「推送按钮会推到哪里」
            // 在远程列表里一眼可见，不需要额外的徽章占位置。
            panelButton('推送到此', () => props.onPushToRemote(name), {
              locked: locked, compact: true, primary: props.pushTarget === name, key: 'push-' + name,
              title: props.pushTarget === name
                ? '当前「推送」按钮就推这个远程（在「同步」区的「推送到」里改）：git push ' + name + ' HEAD'
                : '把当前分支推到这个远程，并把它记成这个仓库的推送目标（git push ' + name + ' HEAD，'
                  + '显式 refspec，不受 push.default 配置限制）：不动上游配置，也不改任何 git 配置',
            }),
            // 「从此外拉」：与「推送到此」对称的那一半 —— 点哪一行就从哪一行拉。
            // 远端的默认分支和当前分支不同名时（fork 现场：本地 local.2、上游 master），
            // 按钮直接写成「拉 master」并把那条命令说进 tooltip：这一次要合进来的是
            // **另一条线**，用户必须在点之前就看得见。它同样会记住这个来源。
            panelButton(rowPlan === null ? '从此外拉' : rowPlan.label, () => props.onPullFromRemote(name), {
              locked: locked, compact: true,
              primary: rowPlan !== null && props.pullTarget === rowPlan.value, key: 'pull-' + name,
              title: rowPlan === null
                ? '从 ' + name + ' 拉取它上面和当前分支同名的那条：不动上游配置，也不改任何 git 配置'
                : (rowPlan.branch.length > 0
                    ? '从 ' + name + ' 拉取它自己的默认分支：git pull ' + name + ' ' + rowPlan.branch
                      + ' —— 把 ' + name + '/' + rowPlan.branch + ' 合并进当前分支'
                      + (branchName.length > 0 ? ' ' + branchName : '')
                      + '（当前分支名不变，上游跟踪关系也不动）。'
                      + '它不等于「拉当前分支」：远端的默认分支和你现在的分支不是同一条'
                    : '从 ' + name + ' 拉取它上面和当前分支同名的那条'
                      + (branchName.length > 0 ? '（git pull ' + name + ' ' + branchName + '）' : '')
                      + '：不动上游配置，也不改任何 git 配置'),
            }),
            panelButton(s.remoteCopied === name ? '已复制' : '复制',
              () => props.onCopyRemote(name, url),
              { locked: locked, compact: true, key: 'copy-' + name, title: '复制这个远程的地址到剪贴板：' + url }),
            panelButton(editing ? '收起' : '改', () => props.onToggleRemote(name),
              { locked: locked, compact: true, key: 'edit-' + name, title: '修改远程 ' + name + ' 的地址' }),
          ))

          // 就地编辑器：只改这一行那个远程。名字在编辑态是只读文本（改名字等于
          // 删掉再建一个，git 没有 rename remote），避免用户在输入框里改了名字
          // 却发现保存后多出一个新远程。
          //
          // 「删除」放在编辑器里而不是折叠行上：一列远程各挂一个删除按钮太挤，
          // 而这个动作既罕见又破坏性，收进「改」后面正好多一道手。
          if (editing) {
            rows.push(h('div', { style: S.box, key: 'remote-edit-' + name, className: 'dgs-remote-edit' },
              h('span', { style: S.remoteEditName, title: '远程名不可改：改名等于删掉再新建一个' }, name),
              h('input', {
                style: S.input,
                className: 'dgs-input',
                value: s.remoteDraftUrl,
                placeholder: '仓库地址 git@github.com:用户名/仓库.git',
                onChange: (event) => props.onRemoteDraftUrl(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    props.onSaveRemote()
                  }
                },
              }),
              panelButton('保存', () => props.onSaveRemote(), { locked: locked }),
              panelButton('保存并推送', () => props.onSaveRemoteAndPush(), { primary: true, locked: locked }),
            ))
            rows.push(h('div', { style: S.row, key: 'remote-edit-actions-' + name },
              h('span', { style: S.spacer }),
              panelButton('删除此远程', () => props.onRemoveRemote(name), {
                locked: locked, compact: true, danger: true, key: 'remove-' + name,
                title: '只删本地的这个远程与它的远端跟踪引用 refs/remotes/' + name + '/*；'
                  + '服务器上的仓库和你的提交都不受影响',
              }),
            ))
            if (s.remoteError.length > 0) {
              rows.push(h('div', { style: S.warn, key: 'remote-err-' + name }, '⚠ ' + s.remoteError))
            }
          }

          // 同地址重复的提示贴在这一行下面：只说这一行的问题，并直接给「删它」。
          if (duplicateOf.has(name)) {
            const kept = duplicateOf.get(name)
            rows.push(h('div', {
              style: S.warnRow, className: 'dgs-dup-remote', key: 'dup-' + name,
            },
              h('span', null, '⚠ ' + name + ' 与 ' + kept + ' 指向同一地址（保留 ' + kept + '）。'
                + '重复的远程名会让 git 命令行产生歧义（refname ambiguous），也可能和本地分支名撞车。'),
              h('span', { style: S.spacer }),
              panelButton('删掉 ' + name, () => props.onRemoveRemote(name), {
                locked: locked, compact: true, danger: true, key: 'remove-dup-' + name,
                title: '只删本地配置与它的远端跟踪引用（refs/remotes/' + name + '/*）；'
                  + '服务器上的仓库和你的提交都不受影响',
              }),
            ))
          }
        }

        // 「添加远程」：与编辑既有远程复用同一个表单区（editingRemote='' 表示新增）。
        const adding = s.editingRemote === ''
        if (adding) {
          rows.push(h('div', { style: S.box, key: 'remote-add', className: 'dgs-remote-add' },
            h('input', {
              style: Object.assign({}, S.input, { flex: '0 0 72px' }),
              className: 'dgs-input',
              value: s.remoteDraftName,
              placeholder: 'origin',
              title: '远程名，一般用 origin',
              onChange: (event) => props.onRemoteDraftName(event.target.value),
            }),
            h('input', {
              style: S.input,
              className: 'dgs-input',
              value: s.remoteDraftUrl,
              placeholder: '仓库地址 git@github.com:用户名/仓库.git',
              onChange: (event) => props.onRemoteDraftUrl(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onSaveRemote()
                }
              },
            }),
            panelButton('保存', () => props.onSaveRemote(), { locked: locked }),
            panelButton('保存并推送', () => props.onSaveRemoteAndPush(), { primary: true, locked: locked }),
            panelButton('取消', () => props.onCloseRemote(), { locked: locked, compact: true }),
          ))
          if (s.remoteError.length > 0) {
            rows.push(h('div', { style: S.warn, key: 'remote-err-add' }, '⚠ ' + s.remoteError))
          }
        } else {
          rows.push(h('div', { style: S.row, key: 'remote-add-btn' },
            h('span', { style: S.spacer }),
            panelButton('+ 添加远程', () => props.onAddRemote(), {
              locked: locked, compact: true,
              title: '为这个仓库再配置一个远程（例如你的 fork）。已有远程的地址不会被改动',
            }),
          ))
        }
      }

      return h('div', { style: S.card, key: 'repo' }, rows)
    }

    /**
     * 分支管理器：本地分支（点名字切换、点「删除」安全删除）+ 新建并切换 + 远端分支。
     *
     * 三段各带小标题，因为三边的动作完全不同（本地是切换/删除，远端是取回/比较）。
     * **远端段按远程名再分一层组**：多远程时 `origin/master` 与 `fork/master` 同屏出现，
     * 只按 ref 排成一列会让人分不清哪个属于谁 —— 而「哪个属于谁」正是用户在这里要找的答案。
     */
    function BranchManager(props) {
      const h = React.createElement
      const s = props.state
      const locked = props.locked === true
      const branchItems = s.branches !== null && Array.isArray(s.branches.items) ? s.branches.items : []
      const remoteItems = s.remoteBranches !== null && Array.isArray(s.remoteBranches.items)
        ? s.remoteBranches.items
        : []
      // 每条本地分支的上游（宿主用一条 for-each-ref 一次带回）。缺这份数据时界面
      // 只是不显示「→ origin/master」，不影响其余部分 —— 旧宿主也能正常用。
      const upstreamTable = s.branchUpstreams !== null && typeof s.branchUpstreams === 'object'
        && typeof s.branchUpstreams !== 'string'
        ? s.branchUpstreams
        : {}
      const trackingOf = (name) => {
        const entry = upstreamTable[name]
        return entry !== null && entry !== undefined && typeof entry === 'object' ? entry : null
      }
      // 当前分支 + 它跟踪的那条远端分支。**必须在交叉引用之前算出来**：多分支跟踪
      // 同一个远端引用时，优先把「当前分支」认成这一行的归属者（那才是用户在用的那条）。
      const currentBranch = s.branches !== null && hasText(s.branches.current) ? String(s.branches.current) : null
      const currentTracking = currentBranch !== null ? trackingOf(currentBranch) : null
      const currentUpstream = currentTracking !== null && hasText(currentTracking.upstream)
        ? String(currentTracking.upstream)
        : null
      /**
       * 远端 ref → 正在跟踪它的本地分支。**这是本地行与远端行之间的交叉引用**：
       * 现场 `fork/local.2` 早就由本地 `fork-local.2` 跟踪着，面板原先在远端那一行
       * 完全看不出这件事，用户点「拿成新分支」就会得到 `fork-local.2-2` —— 多出一条
       * 名字相近、内容相同的分支，从此更难分清。有了这张表，那一行的按钮直接变成
       * 「切过去」（或「当前分支」），从源头不再制造重复分支。
       */
      const localByUpstream = {}
      for (const name of Object.keys(upstreamTable)) {
        const entry = trackingOf(name)
        if (entry === null || !hasText(entry.upstream)) continue
        const ref = String(entry.upstream)
        const known = localByUpstream[ref]
        if (known === undefined || name === currentBranch) localByUpstream[ref] = name
      }
      // 远端分组把「默认分支」钉在第一行（其余仍按 ref 排序）。用户按「第一条就是
      // 默认」找人，而不是在一长串里翻（llama.cpp 这类仓库几十条分支，字母序下
      // master 会夹在中间，看着就像「没下载下来」）。head 标记既来自本地指针
      // （parseRemoteBranchOutput），也可能来自默认分支兜底补查（enhance），
      // 统一在这里排序，两条路径都生效。
      const remoteRows = [...remoteItems].sort((left, right) => {
        if (left.head !== right.head) return left.head === true ? -1 : 1
        return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
      })
      /**
       * 按远程名分组（顺序按远程名，与「远程仓库」区一致），组内保持 default 钉头。
       * 远端分支的 `remote` 字段就是组名 —— 它一定来自 refs/remotes/<remote>/<branch>，
       * 所以不会出现「组名不是配置里的远程」这种对不上的情况。
       */
      const remoteGroups = []
      for (const item of remoteRows) {
        if (item === null || typeof item !== 'object') continue
        const key = String(item.remote)
        let group = remoteGroups.find((entry) => entry.remote === key)
        if (group === undefined) {
          group = { remote: key, items: [] }
          remoteGroups.push(group)
        }
        group.items.push(item)
      }
      remoteGroups.sort((left, right) => (left.remote < right.remote ? -1 : left.remote > right.remote ? 1 : 0))
      // 配置里的远程总数（判断要不要显示分组标题：只有一个远程时分组标题是多余的）。
      const configuredRemotes = (s.snapshot !== null && Array.isArray(s.snapshot.remotes) ? s.snapshot.remotes : [])
        .map((item) => (item !== null && typeof item === 'object' ? item.name : null))
        .filter((name) => hasText(name))
      const multiRemote = configuredRemotes.length > 1
      /**
       * 新分支名撞上远端名（`origin/main` 这种）就地拦下。
       *
       * 本地分支 `origin/main` 会和 `refs/remotes/origin/main` 变成两个同名引用：
       * 从此 `git branch -a`、部分脚本乃至面板自己的命令都开始有歧义（git 会打
       * `warning: refname 'main' is ambiguous`），而且这个分支第一次推送还会在远端
       * 造出一个同样叫 `origin/main` 的分支。宿主也会拒（同一判定，见 ops.js 的
       * branchNameRemoteConflict）—— 这里拦是为了在输入框旁边立刻说清楚。
       */
      const remoteNames = configuredRemotes
      const draftConflict = branchNameRemoteConflict(s.branchDraft, remoteNames)
      const card = [
        h('div', { style: S.sectionTitle, key: 'localtitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, branchItems.length === 0 ? '本地分支' : '本地分支（' + branchItems.length + '）'),
          h('span', { style: S.sectionRule }),
        ),
      ]

      /**
       * 本地分支：名字可点（切换）+ 上游跟踪标签 + 行尾「⋯」。
       *
       * 「删除 / 改名 / 设置上游」都收进「⋯」：它们低频，却常驻行尾（删除 46px、
       * 改名 36px），把分支名挤到 300px 这一行的临界宽度上 —— 实测 `fork-local.2`
       * 这种 13 字符的名字已经被省略号吃掉 1px。收进菜单后名字拿到整行。
       */
      const localRows = []
      for (let index = 0; index < branchItems.length; index += 1) {
        const item = branchItems[index]
        const tracking = trackingOf(item.name)
        const upstreamRef = tracking !== null && hasText(tracking.upstream) ? String(tracking.upstream) : null
        // 领先/落后只在上游存在且非零时说，避免每行挂一个「领先 0 落后 0」。
        const ahead = tracking !== null && typeof tracking.ahead === 'number' ? tracking.ahead : 0
        const behind = tracking !== null && typeof tracking.behind === 'number' ? tracking.behind : 0
        // `[gone]`：上游在远端被删了。这时照常显示上游名会骗人 —— 加一句明说。
        const gone = tracking !== null && tracking.gone === true
        const trackingText = upstreamRef === null
          ? '未跟踪'
          : '→ ' + upstreamRef + (gone
            ? '（已在远端删除）'
            : (ahead > 0 || behind > 0
              ? '（' + [ahead > 0 ? '领先 ' + ahead : null, behind > 0 ? '落后 ' + behind : null]
                  .filter((text) => text !== null).join(' / ') + '）'
              : ''))
        const menuKey = 'local:' + item.name
        const menuOpen = s.branchMenu === menuKey
        localRows.push(h('div', {
          style: S.item, className: 'dgs-rowitem', key: 'b' + index,
        },
          // 当前分支用实心点标出：颜色之外再给一个形状，色觉差异下也分得清。
          h('span', {
            style: Object.assign({}, S.marker, {
              color: item.current === true
                ? GOOD_TEXT
                : 'var(--dsw-alias-label-tertiary, #999999)',
            }),
          }, item.current === true ? '●' : '○'),
          h('span', {
            style: item.current === true
              ? Object.assign({}, S.name, {
                  fontWeight: 600,
                  color: GOOD_TEXT,
                })
              : Object.assign({}, S.name, { cursor: 'pointer' }),
            // 名字可能被省略号截断：tooltip 里给全名兜底。
            title: item.current === true
              ? '当前分支：' + String(item.name)
              : '点击切换到此分支：' + String(item.name),
            onClick: item.current === true ? undefined : () => props.onCheckout(item.name),
          }, item.name),
          // 跟踪关系：本地分支对应远端哪一份。这是「本地/远端分不清」的正面解法 ——
          // 原来两边的名字都只写自己那截，用户没有任何线索把它俩对上。
          h('span', {
            style: S.trackTag,
            className: 'dgs-track',
            title: upstreamRef === null
              ? '这个本地分支没有跟踪任何远端分支：推送时需要指定目标（面板会自动补 --set-upstream）'
              : (gone
                ? '它的上游 ' + upstreamRef + ' 已经在远端被删除了（常见于分支合并后清理）。\n'
                  + '再点「推送」会因为远端没有这个分支而失败；可以重推一次把上游重新建出来。'
                : '跟踪关系：本地 ' + String(item.name) + ' ↔ 远端 ' + upstreamRef
                  + (ahead > 0 ? '\n本地比它多 ' + ahead + ' 个提交（还没推上去）' : '')
                  + (behind > 0 ? '\n远端比它多 ' + behind + ' 个提交（还没拉下来）' : '')),
          }, trackingText),
          h('span', { style: S.spacer }),
          // 当前分支不再挂「当前」文字：● 实心点 + 绿色粗体名字已经说清了，
          // 而它要吃掉 41px —— 实测正是这 41px 让 `fork-local.2` 这种名字掉字。
          panelButton('⋯', () => props.onToggleMenu(menuKey), {
            locked: locked, compact: true, key: 'more',
            title: '更多操作：设置上游 / ' + (item.current === true ? '改名' : '删除'),
          }),
        ))
        if (menuOpen) {
          localRows.push(h('div', {
            style: S.rowMenu, className: 'dgs-row-menu', key: 'menu-' + index,
          },
            panelButton('设置上游…', () => props.onOpenUpstream(item.name), {
              locked: locked, key: 'up',
              title: '把 ' + String(item.name) + ' 的上游绑到某条远端分支：本地名不用改，'
                + '以后在这个分支上的推送 / 拉取都对着它',
            }),
            // 「改名」只给**当前分支**这一行：这不是 git 的限制（宿主已按名字显式执行
            // `git branch -m <这条> <新名>`），而是界面上的取舍 —— 只有当前分支的行
            // 才常驻在列表顶部、用户一眼看得到自己改的是哪一条。
            item.current === true
              ? panelButton('改名…', () => props.onRenameBranch(item.name), {
                  locked: locked, key: 'rename',
                  title: '给这条分支改名（git branch -m）：只改名字，提交历史与上游跟踪都不动',
                })
              : null,
            item.current === true
              ? null
              : panelButton('删除', () => props.onDeleteBranch(item.name), {
                  locked: locked, danger: true, key: 'del',
                }),
          ))
        }
      }
      if (branchItems.length === 0) {
        localRows.push(h('div', { style: S.note, key: 'nobranches' }, '还没有分支：提交一次，或直接在下面新建一个。'))
      }
      card.push(h('div', { style: S.list, key: 'branches' }, localRows))

      /**
       * 「设置上游」的候选列表：**就地展开在本地分支这一块下面**，标题写清是给哪个
       * 分支设置的。数据用已经拿到的 remoteBranches（分支管理器展开时那一次 op 就
       * 把它们带回来了），所以打开它**不发任何请求**。
       *
       * 为什么不放进上面那个列表里：那个列表有 148px 的高度上限，几十条远端分支
       * 会变成「在一个小盒子里滚」；这里还顺带说明了这条操作到底改了什么。
       */
      if (s.upstreamPickerFor !== null && hasText(s.upstreamPickerFor)) {
        const localName = String(s.upstreamPickerFor)
        const currentOfLocal = trackingOf(localName)
        const currentOfLocalRef = currentOfLocal !== null && hasText(currentOfLocal.upstream)
          ? String(currentOfLocal.upstream)
          : null
        const candidates = []
        for (const group of remoteGroups) {
          for (const item of group.items) {
            const isCurrent = currentOfLocalRef !== null && currentOfLocalRef === item.ref
            candidates.push(panelButton(item.ref + (isCurrent ? '（当前上游）' : ''), () => {
              if (isCurrent) return
              props.onSetUpstream(localName, item)
            }, {
              locked: locked || isCurrent,
              compact: true,
              key: 'up-' + item.ref,
              title: isCurrent
                ? '本地分支 ' + localName + ' 的上游已经指向它了'
                : '把 ' + localName + ' 的上游绑到 ' + item.ref + '（git branch --set-upstream-to='
                  + item.ref + ' ' + localName + '）：本地名不用改，推送 / 拉取以后都对着它',
            }))
          }
        }
        card.push(h('div', {
          style: S.rowMenu, className: 'dgs-upstream-picker', key: 'upstream-picker',
        },
          h('div', { style: S.menuTitle, key: 'uptitle' },
            '把 ' + localName + ' 的上游设为' + (currentOfLocalRef !== null ? '（现在是 ' + currentOfLocalRef + '）' : '')),
          candidates.length === 0
            ? h('div', { style: S.menuTitle, key: 'upempty' },
                '还没有远端分支：先点一次「获取远程」，再回来设置上游')
            : h(React.Fragment, { key: 'uplist' }, candidates),
          panelButton('取消', () => props.onCloseUpstream(), { compact: true, key: 'upcancel' }),
        ))
      }

      /**
       * 「改名」的就地编辑器：展开在本地分支这一块下面（与「设置上游」同一位置、
       * 同一套交互），标题先写清改的是哪条分支、改完之后什么不变。
       *
       * **这是本次修的现场**：改名此前是面板里唯一一处用 `window.prompt()` 拿输入的
       * 地方，而桌面版（Electron 外壳）不支持 prompt（浏览器控制台那句
       * `prompt() is and will not be supported.`）—— 于是点「⋯ → 改名」什么都不会
       * 发生，用户看到的就是「改名用不了」。输入框由面板自己画，浏览器与桌面版都
       * 一样能用；草稿从原分支名播种（改名字多半是在原名上改几个字）。
       */
      if (s.renameFor !== null && hasText(s.renameFor)) {
        const renameFrom = String(s.renameFor)
        card.push(h('div', {
          style: S.rowMenu, className: 'dgs-rename-editor', key: 'rename-editor',
        },
          h('div', { style: S.menuTitle, key: 'renametitle' },
            '把分支 ' + renameFrom + ' 改名（git branch -m）：只改名字，提交历史一个不动，'
            + '上游跟踪关系跟着这条分支保留'),
          h('input', {
            style: S.input,
            className: 'dgs-input dgs-rename-input',
            value: s.renameDraft,
            placeholder: '新分支名',
            // 无障碍：输入框自己说清在改哪条分支，而不是只靠上面那行说明。
            'aria-label': '把分支 ' + renameFrom + ' 改名成',
            onChange: (event) => props.onRenameDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onRenameSubmit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                props.onCloseRename()
              }
            },
          }),
          panelButton('保存', () => props.onRenameSubmit(), {
            primary: true, locked: locked, key: 'renamesave',
            title: '执行 git branch -m ' + renameFrom + ' <新名字>',
          }),
          panelButton('取消', () => props.onCloseRename(), { compact: true, locked: locked, key: 'renamecancel' }),
        ))
        // 就地告警贴在输入框下面：说的不是「命令失败了」，而是「这个名字现在就不能用」。
        if (hasText(s.renameError)) {
          card.push(h('div', {
            style: S.warnText, className: 'dgs-rename-warn', key: 'rename-warn', role: 'alert',
          }, '⚠ ' + String(s.renameError)))
        }
      }

      card.push(h('div', { style: S.box, key: 'newbranch' },
          h('input', {
            style: S.input,
            className: 'dgs-input',
            value: s.branchDraft,
            placeholder: '新分支名（新建并切换）',
            onChange: (event) => props.onBranchDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onCreateBranch()
              }
            },
          }),
          // 撞上远端名时按钮直接锁住（输入框回车那条路由 onCreateBranch 自己再拦一次）。
          panelButton('新建', () => props.onCreateBranch(), {
            primary: true, locked: locked || draftConflict !== null,
          }),
          // 就地告警贴在输入框下面：说的不是「命令失败了」，而是「这个名字不能建」。
          draftConflict !== null ? h('div', {
            style: S.warnText,
            className: 'dgs-branchname-warn',
            key: 'branchname-warn',
            role: 'alert',
          }, '这个名字不能建：' + draftConflict + ' 是配置好的远程，' + draftConflict
            + '/… 已经是它的远端跟踪引用。去掉前缀、用「'
            + String(s.branchDraft).trim().slice(draftConflict.length + 1) + '」这样的本地名。') : null,
      ))

      // 远端分支。点它**不直接切换**（那会变成游离 HEAD，对不懂 git 的人是坑）。
      // 每行按「这条远端分支本地有没有对应」给一个动作：
      //   · 已经有本地分支在跟踪它 → 「切过去」（切到那条本地分支，**不新建**）；
      //   · 本来就是这个分支          → 「当前分支」（禁用，避免自己切自己）；
      //   · 还没有本地对应            → 「拿成新分支」（宿主 `git switch -c`，会切到新
      //     分支上；原来的分支一点没动）。
      // 低频的「比较」收进「⋯」，把行宽让给分支名 —— 原先两个常驻按钮占了行宽的 41%。
      //
      // **按远程分组**：多远程时 `origin/master` 与 `fork/master` 会同屏出现，
      // 排成一列平铺的话，用户看到的是两条都叫 master 的记录，分不清哪个属于谁 ——
      // 而「哪个属于谁」正是打开这个管理器要回答的问题。
      card.push(h('div', { style: S.sectionTitle, key: 'remotetitle' },
        h('span', { style: S.sectionTick }),
        h('span', null, remoteItems.length === 0 ? '远端分支' : '远端分支（' + remoteItems.length + '）'),
        h('span', { style: S.sectionRule }),
      ))
      card.push(h('div', { style: S.note, key: 'remotehint' },
        remoteItems.length === 0
          ? '点一次「获取远程」就能在这里看到（只下载，不改你的代码）'
          // 文案刻意压在一行（23 个全角字符）以内：原先「…当前分支一点不动」超出
          // 一行容量，换行后第二行只剩下一个「动」，面板里显得很难看。
          // 而且那句「当前分支不动」本身是**错的**：拿成新分支会切到新分支上
          // （宿主执行 git switch -c），现在只说「已有对应的直接切过去」。
          : '已有本地对应分支的行直接切过去，其余才新建'))

      // 「远端默认分支」提示行：本地有 origin/HEAD 指针时它就是指针的值；本地指针
      // 缺失（旧版 git / 镜像远端）时由宿主补查远程 HEAD 得到（defaults）。就算默认
      // 分支还没下载到本地，用户也能一眼知道该拿哪一份。
      const knownDefaults = s.remoteBranches !== null && Array.isArray(s.remoteBranches.defaults)
        ? s.remoteBranches.defaults
        : []
      const defaultLine = knownDefaults.length > 0
        ? knownDefaults.map((item) => item.remote + '/' + item.branch).join('、')
        : (s.remoteBranches !== null && typeof s.remoteBranches.defaultRef === 'string'
            && s.remoteBranches.defaultRef.length > 0
          ? s.remoteBranches.defaultRef
          : null)
      if (defaultLine !== null) {
        card.push(h('div', { style: S.note, key: 'defaultline' }, '远端默认分支：' + defaultLine))
      }

      for (let groupIndex = 0; groupIndex < remoteGroups.length; groupIndex += 1) {
        const group = remoteGroups[groupIndex]
        // 只有一个远程时组标题是噪音（屏幕上一半的行都在重复同一个词），省略。
        if (multiRemote) {
          card.push(h('div', {
            style: S.groupTitle,
            className: 'dgs-remote-group',
            key: 'rgroup-' + group.remote,
          },
            h('span', { style: S.groupName, title: '远程 ' + group.remote + ' 在本地保存的分支引用' }, group.remote),
            h('span', { style: S.sectionRule }),
          ))
        }

        for (let index = 0; index < group.items.length; index += 1) {
          const item = group.items[index]
          // 本地已经有分支在跟踪这条远端分支（交叉引用）：这一行的动作就不能是
          // 「拿成新分支」—— 那会造出一条名字相近的重复分支（现场实测会得到
          // fork-local.2-2），而用户根本看不出自己已经有了。
          const owner = localByUpstream[item.ref] !== undefined ? String(localByUpstream[item.ref]) : null
          const tracksHere = currentUpstream !== null && currentUpstream === item.ref
          const menuKey = 'remote:' + item.ref
          card.push(h('div', { style: S.item, className: 'dgs-rowitem', key: 'r-' + group.remote + '-' + index },
            // 多远程时只写**短名**（组标题已经写明属于哪个远程），把行宽让给名字本身；
            // 单远程没有组标题，必须写完整 ref —— 否则「这是远端哪一份」整个丢掉，
            // 而那正是用户打开管理器要找的信息。
            // title 里始终带完整 ref：名字可能被省略号截断（而且远端分支常常很长），
            // 悬停必须能看全；「默认」徽章独立于名字渲染，截断不影响它。
            h('span', {
              style: S.name,
              title: (item.head === true
                ? item.ref + '（远端默认分支：拉取 / 获取远程会从它更新）'
                : item.ref + '（远端分支：获取远程时会下载到本地）')
                + (owner !== null ? '\n本地分支 ' + owner + ' 已经在跟踪它' : ''),
            }, multiRemote ? item.name : item.ref),
            item.head === true
              ? h('span', {
                  // className 供自查工具按类名定位这块徽章（.ui-preview/audit.js 会逐个
                  // 量「默认 / 当前跟踪」这些角标的对比度）。
                  style: S.headBadge,
                  className: 'dgs-head-badge',
                  key: 'headbadge',
                  title: '远端默认分支：' + item.ref,
                }, '默认')
              : null,
            // 「当前跟踪」从**分组标题**下沉到**行**：分组标题只说「这组里有一条是你跟的」，
            // 行一多还得在组里再找一遍到底哪一条；挂在行上就一眼看到。
            tracksHere
              ? h('span', {
                  style: S.currentTag, className: 'dgs-current-tag', key: 'cur',
                  title: '当前分支 ' + String(currentBranch) + ' 跟踪的就是它：推送 / 拉取都对着这一条',
                }, '当前跟踪')
              : null,
            // 交叉引用标记。两种情况不写：
            //   · `tracksHere` —— 这一行已经是「当前分支跟踪的那条」，行上已有
            //     「当前跟踪」徽章 + 禁用的「当前分支」按钮，再写一句就是重复（而且
            //     实测正是这一句把 `local.2` 这种短名字挤掉 3px）；
            //   · 归属的本地分支名与这一行显示的名字**同名**时才加「本地」二字 ——
            //     多远程下远端行只写短名，`master ↩ master` 会被读成同一件事。
            owner !== null && !tracksHere
              ? h('span', {
                  style: S.ownerTag, className: 'dgs-owner', key: 'owner',
                  title: '本地分支 ' + owner + ' 已经在跟踪它：点右边的按钮切过去就行，不会新建分支',
                }, owner === (multiRemote ? item.name : item.ref) ? '↩ 本地 ' + owner : '↩ ' + owner)
              : null,
            h('span', { style: S.spacer }),
            tracksHere
              ? panelButton('当前分支', () => {}, {
                  locked: true, key: 'primary',
                  title: '你现在就在这个分支上（面板不会再给你建一个内容相同的分支）',
                })
              : (owner !== null
                  ? panelButton('切过去', () => props.onCheckout(owner), {
                      locked: locked, key: 'primary',
                      title: '切到本地分支 ' + owner + '：它已经在跟踪 ' + item.ref + '，所以不新建分支',
                    })
                  : panelButton('拿成新分支', () => props.onAdopt(item), {
                      locked: locked, key: 'primary',
                      title: '把 ' + item.ref + ' 开成本地新分支并切过去；原来的分支一点没动，随时能切回去',
                    })),
            panelButton('⋯', () => props.onToggleMenu(menuKey), {
              locked: locked, compact: true, key: 'more', title: '更多操作：比较',
            }),
          ))
          if (s.branchMenu === menuKey) {
            card.push(h('div', {
              style: S.rowMenu, className: 'dgs-row-menu', key: 'rmenu-' + group.remote + '-' + index,
            },
              panelButton('比较', () => props.onCompare(item), {
                locked: locked, key: 'cmp',
                title: '看本地（当前分支）相对 ' + item.ref + ' 领先 / 落后几个提交：结论出现在面板下方',
              }),
            ))
          }
        }
      }

      return h('div', { style: S.card, key: 'branch-card' }, card)
    }

    /**
     * 一条改动（整行可点、可键盘触达），右侧带这个文件自己的三个小动作。
     *
     * 行本身是「点开看 diff」，小按钮是「只对这个文件做点什么」——按钮的 onClick
     * 必须 stopPropagation，否则点「暂存」会顺手把 diff 也展开/收起。
     * 「还原」只对**工作区里确实有改动**的条目开放（porcelain 第二列 M/D）：
     * 已暂存未改工作区的条目没有可还原的内容，而未跟踪文件要「还原」等于删文件，
     * 那种破坏性动作不放进这个紧凑的按钮组。
     */
    function changeRow(item, open, locked, onToggle, onStage, onUnstage, onRestore) {
      const h = React.createElement
      const staged = item.staged === true
      const code = String(item.code === undefined || item.code === null ? '  ' : item.code)
      const actions = []
      if (staged) {
        actions.push(panelButton('取消暂存', (event) => { event.stopPropagation(); onUnstage(item) },
          { locked: locked, compact: true, key: 'unstage-' + changeKey(item) }))
      } else {
        actions.push(panelButton('暂存', (event) => { event.stopPropagation(); onStage(item) },
          { locked: locked, compact: true, key: 'stage-' + changeKey(item) }))
      }
      if (code.charAt(0) !== '?' && (code.charAt(1) === 'M' || code.charAt(1) === 'D')) {
        actions.push(panelButton('还原', (event) => { event.stopPropagation(); onRestore(item) },
          { locked: locked, compact: true, danger: true, key: 'restore-' + changeKey(item) }))
      }
      return h('div', {
        style: S.item,
        // 展开中的那一行带品牌色竖条（dgs-rowitem-active），和下面的 diff 对上号。
        className: 'dgs-rowitem dgs-clickable' + (open ? ' dgs-rowitem-active' : ''),
        key: 'c' + changeKey(item),
        title: (staged ? '已暂存' : '未暂存') + ' · 点击查看 diff（再点收起）',
        // 整行是一个动作，就得像按钮一样能被键盘触达（焦点环见 PANEL_CSS）。
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: () => onToggle(item),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle(item)
          }
        },
      },
        // 暂存状态：实心=已暂存、空心=未暂存。颜色之外再给一个形状。
        h('span', {
          style: Object.assign({}, S.marker, {
            color: staged
              ? GOOD_TEXT
              : 'var(--dsw-alias-label-tertiary, #999999)',
          }),
        }, staged ? '●' : '○'),
        h('span', { style: codeStyle(staged), className: 'dgs-code' }, code),
        h('span', { style: S.name }, String(item.path)),
        h('span', { style: S.spacer }),
        actions,
        h('span', { style: S.chevron }, open ? '▲' : '▼'),
      )
    }

    /**
     * 展开的 diff / 提交详情上方那行抬头：写清「现在展开的是什么」。
     *
     * 为什么需要它：展开的那一行（改动清单里的文件行 / 提交列表里的一行）随时可能
     * 被滚出视野，抬头就是那块内容的落款；右侧的小胶囊顺带说明这是「已暂存」还是
     * 「工作区」的那一份 —— 同一个文件的两份 diff 内容完全不同。
     *
     * item：{ path, staged, chip, title }。chip 传 null 表示不画胶囊。
     */
    function diffTitleBar(item) {
      const h = React.createElement
      const staged = item.staged === true
      const path = String(item.path)
      const chip = item.chip === null
        ? null
        : (hasText(item.chip) ? String(item.chip) : (staged === true ? '已暂存' : '未暂存'))
      const title = hasText(item.title)
        ? String(item.title)
        : ((staged === true ? '已暂存' : '工作区') + '改动：' + path)
      return h('div', {
        style: S.diffTitle,
        className: 'dgs-difftitle',
        key: 'difftitle-' + path,
      },
        h('span', { style: S.sectionTick }),
        h('span', { style: S.diffPath, title: title }, path),
        chip === null ? null : h('span', { style: S.chip }, chip),
      )
    }

    /** 抬头条的兜底形态：清单刷新后 key 已经对不上任何一行，但仍要知道是哪个文件。 */
    function diffTitleBarForKey(key) {
      return diffTitleBar({ path: key.slice(2), staged: key.charAt(0) === 's' })
    }

    /**
     * 改动区块：标题（带改动摘要胶囊）+ 列表 + 点开的 diff。
     *
     * diff **内联展开在被点的那一行下面**，而不是列表外面的另一个框：面板正文是
     * 可滚动的 flex 列，清单也是；放在外面时它既挤掉清单的高度（见 S.list 的注释），
     * 又常常落到可视区之外 —— 用户看到的就是「diff 把改动清单盖住了」。放进清单里
     * 之后两者永远是同一个滚动区：点哪个文件，就在那个文件下面看它的 diff。
     */
    function ChangesSection(props) {
      const h = React.createElement
      const changes = props.changes
      const total = typeof props.changesTotal === 'number' ? props.changesTotal : changes.length
      const shown = changes.slice(0, CHANGES_SHOWN)
      const rows = []
      let diffInline = false
      for (const item of shown) {
        const open = props.diffKey === changeKey(item)
        rows.push(changeRow(
          item, open, props.locked === true, props.onToggle,
          props.onStage, props.onUnstage, props.onRestore,
        ))
        if (open) {
          rows.push(diffTitleBar(item))
          rows.push(renderLines(props.diffText, S.diff, diffLineClass, 'diff', props.diffRef))
          diffInline = true
        }
      }
      // 兜底：清单在 diff 打开之后被刷新掉了（典型是点了「全部暂存」，条目的已暂存
      // 状态翻转、key 对不上任何一行）—— diff 仍要有地方显示，不能凭空消失。
      // 同样放进清单内部：与文件行共用同一个滚动区。
      if (props.diffKey.length > 0 && diffInline !== true) {
        rows.push(diffTitleBarForKey(props.diffKey))
        rows.push(renderLines(props.diffText, S.diff, diffLineClass, 'diff-fallback', props.diffRef))
      }
      // 截断必须说出来：宿主最多回 100 条、这里最多画 40 条。静默截断会让用户
      // 以为「我的仓库只有 40 个改动」。
      const hidden = Math.max(0, total - shown.length)
      if (hidden > 0) {
        rows.push(h('div', { style: S.note, key: 'more' },
          '还有 ' + hidden + ' 处未显示（面板一次最多列 ' + CHANGES_SHOWN + ' 处）'))
      }

      const children = [
        h('div', { style: S.sectionTitle, key: 'changestitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '改动'),
          h('span', { style: S.sectionRule }),
          h('span', {
            style: changes.length > 0 ? S.chipActive : S.chip,
            className: changes.length > 0 ? 'dgs-chip-active' : undefined,
            title: '工作区里的改动总数，以及其中已经暂存的数量',
          }, changesSummary(total, changes)),
        ),
      ]
      if (changes.length > 0) {
        children.push(h('div', {
          style: props.diffKey.length > 0 ? Object.assign({}, S.list, { maxHeight: '360px' }) : S.list,
          key: 'changes',
        }, rows))
      }
      return children
    }

    /** 「需要你选一个结果」：宿主判断出这不是命令写错、而是要用户做个决定时回传的选项。 */
    function ChoiceBox(props) {
      const h = React.createElement
      return h('div', { style: S.choiceBox, key: 'choices' },
        h('div', { style: S.netTitle, key: 'title' }, '🤔 面板需要你选一个结果'),
        props.choices.map((item, index) => {
          const choice = item !== null && typeof item === 'object' ? item : {}
          return h('div', { style: S.choiceItem, key: 'choice-' + index },
            h('button', {
              type: 'button',
              className: buttonClass(index === 0, false),
              style: buttonStyle(index === 0, props.locked === true),
              disabled: props.locked === true,
              onClick: () => props.onChoose(choice),
            }, hasText(choice.label) ? choice.label : '执行'),
            hasText(choice.detail) ? h('div', { style: S.note, key: 'detail' }, choice.detail) : null,
          )
        }),
      )
    }

    /** 命令结果栏：逐行着色（命令回显 / stderr / 加速说明 / 下一步提示），文本一字不改。 */
    function OutputPanel(props) {
      if (hasText(props.output) !== true) return null
      return renderLines(props.output, S.out, outputLineClass, 'out', props.outRef, 'polite')
    }

    /** 空态：还不是仓库 / 状态读取失败。**宿主给的 notice 才是「为什么」**。 */
    function EmptyState(props) {
      const h = React.createElement
      const notice = hasText(props.notice) ? props.notice : null
      // 「还不是仓库」这句和下面的通用说明重复，就不再叠一遍；其余（未装 git、
      // 读取失败、权限问题…）都要显示出来 —— 那是用户唯一能看到的诊断。
      const extra = notice !== null && notice !== '当前目录还不是 Git 仓库' ? notice : null
      return h('div', { style: S.empty, key: 'hint' },
        // 一个图标 + 一句「这是什么情况」：空态最怕的是一整块没有重点的灰字。
        h('div', { style: S.emptyIcon }, '📂'),
        h('div', null, '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'),
        extra === null ? null : h('div', { style: S.warn }, '⚠ ' + extra),
      )
    }

    /**
     * 提交表单：输入框单独占一行，按钮与勾选项排到下一行。
     *
     * 原先三者挤在同一行：360px 的面板里输入框只剩半行宽，「填写提交信息…（回车直接
     * 提交）」被截成「填写提交信息…（」——提示本身就没了。分两行之后输入框是整行宽，
     * 主操作（提交）和两个辅助项也有了清楚的主次。
     */
    function CommitForm(props) {
      const h = React.createElement
      return h('form', {
        style: S.commitForm, key: 'commit',
        onSubmit: (event) => { event.preventDefault(); props.onSubmit(props.amend === true) },
      },
        h('input', {
          // flex 0 0 auto：在纵向 flex 里 '1 1 auto' 会去撑高度，输入框会被拉高。
          style: Object.assign({}, S.input, { flex: '0 0 auto' }),
          className: 'dgs-input',
          value: props.message,
          placeholder: '填写提交信息…（回车直接提交）',
          onChange: (event) => props.onChange(event.target.value),
        }),
        h('div', { style: S.commitActions },
          h('button', {
            className: buttonClass(true, false),
            style: buttonStyle(true, props.locked === true),
            disabled: props.locked === true,
            type: 'submit',
          }, '提交'),
          h('button', {
            className: buttonClass(false, false),
            style: buttonStyle(false, props.locked === true),
            disabled: props.locked === true,
            type: 'button',
            title: '提交成功后立刻推送一次（远程没配好时推送的提示会照常给出）',
            onClick: () => props.onCommitAndPush(props.amend === true),
            key: 'commit-push',
          }, '提交并推送'),
          h('label', {
            style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
            title: '把这次提交合并进上一次提交（git commit --amend）：适合「刚提交完发现漏了东西」',
            key: 'amend',
          },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: props.amend === true,
              onChange: (event) => props.onAmendChange(event.target.checked),
            }),
            h('span', null, '补充上次'),
          ),
        ),
      )
    }

    /** 克隆表单（还不是仓库时才出现）：地址 + 可选浅克隆。 */
    function CloneForm(props) {
      const h = React.createElement
      return h('div', { style: S.box, key: 'clone' },
        h('input', {
          style: S.input,
          className: 'dgs-input',
          value: props.url,
          placeholder: '仓库地址 https://github.com/…',
          onChange: (event) => props.onChange(event.target.value),
        }),
        panelButton('开始克隆', () => props.onClone(), { primary: true, locked: props.locked === true }),
        h('label', {
          style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
          title: '浅克隆（git clone --depth 1）：只取最新一次提交，快很多、体积小很多；需要完整历史时不要勾',
          key: 'shallow',
        },
          h('input', {
            style: S.check,
            type: 'checkbox',
            checked: props.shallow === true,
            onChange: (event) => props.onShallowChange(event.target.checked),
          }),
          h('span', null, '浅克隆'),
        ),
      )
    }

    /**
     * 最近提交列表。**整行可点**：点开看这条提交的详情（作者 / 日期 / 改动统计），
     * 再点同一行收起 —— 与改动清单「点开看 diff」是同一套交互。
     * 行右侧另有「切到此」小按钮：切换到那个提交（git switch --detach）。
     * 与改动清单的小按钮一样，onClick 必须 stopPropagation，
     * 否点点「切到此」会顺手把详情也展开/收起。
     */
    function LogList(props) {
      const h = React.createElement
      return [
        h('div', { style: S.sectionTitle, key: 'logtitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '最近提交'),
          h('span', { style: S.sectionRule }),
        ),
        h('div', { style: S.list, key: 'log' },
          props.commits.slice(0, 8).map((item, index) => {
            const hash = String(item.hash)
            const open = props.openRef === hash
            return h('div', {
              style: S.item,
              className: 'dgs-rowitem dgs-clickable' + (open ? ' dgs-rowitem-active' : ''),
              key: 'l' + index,
              title: String(item.subject) + '\n点击查看提交详情（再点收起）',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: () => props.onShow(hash),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onShow(hash)
                }
              },
            },
              h('span', { style: S.hash }, hash),
              h('span', { style: S.name, title: String(item.subject) }, String(item.subject)),
              h('span', { style: S.spacer }),
              panelButton('切到此', (event) => { event.stopPropagation(); props.onCheckoutCommit(hash) }, {
                locked: props.locked,
                compact: true,
                key: 'checkout-' + hash,
                title: '切换到这个提交（git switch --detach）：之后处于游离 HEAD，查看/编译/运行都可以；'
                  + '回到最新在「管理」里点原来的分支名',
              }),
            )
          }),
        ),
      ]
    }

    /**
     * stash 备份列表：应用 / 删除。
     * 「安全拉取」「安全切分支」留下的备份都在这里 —— 面板自己藏的东西，
     * 收尾也得能在面板里做完，而不是把用户指回终端。
     */
    function StashList(props) {
      const h = React.createElement
      const items = Array.isArray(props.items) ? props.items : []
      if (items.length === 0) {
        return h('div', { style: S.note, key: 'stash-empty' },
          '没有 stash 备份（「安全拉取」「安全切分支」自动藏起来的改动会出现在这里）')
      }
      return h('div', { style: S.list, key: 'stash-list' },
        items.map((item, index) => h('div', {
          style: S.item, className: 'dgs-rowitem', key: 'st' + index,
        },
          h('span', { style: S.name, title: item.ref + '：' + item.text }, String(item.text)),
          h('span', { style: S.spacer }),
          panelButton('恢复', () => props.onApply(item), { locked: props.locked, compact: true }),
          panelButton('删除', () => props.onDelete(item), { locked: props.locked, compact: true, danger: true }),
        )),
      )
    }

    // ── 目录选择小窗口（与 DSH「添加工作区」同一个目录选择器） ─────────────
    //
    // 点仓库卡的「切换」弹出：面包屑 + 目录列表 + 直接输入路径 + 新建文件夹，
    // 选完面板就切到那个目录。与 DSH「添加工作区」共用宿主的 browse 通道
    // （remote.directoryPicker 的 list / createDirectory），所以弹的是同一个
    // 目录选择器、同一套权限与错误。它不注册 workspace、不开新会话 —— 只回答
    // 「面板接下来看哪个目录」。

    /** 遮罩：盖住整页（含面板）。点遮罩空白处 = 取消。 */
    const PICK_MASK = {
      position: 'fixed', inset: '0', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      background: 'rgba(0,0,0,.45)',
    }
    /**
     * 小窗口卡片：与面板同一套主题令牌、同一种圆角与阴影语言。
     * 底色同样走 `bg-layer-2` + `elevation-prominent`（不是 `bg-overlay` ——
     * 那是宿主给徽章/遮罩用的一档，做浮层底会反过来，理由见 S.panel 的注释）。
     */
    const PICK_CARD = {
      width: '500px', maxWidth: '100%', maxHeight: '76vh',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #111111)',
      border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
      borderRadius: 'var(--dsw-radius-lg, 16px)',
      boxShadow: 'var(--dsw-elevation-prominent, 0 24px 64px rgba(0,0,0,.35), 0 4px 12px rgba(0,0,0,.18))',
      fontSize: '12.5px', lineHeight: 1.55,
    }

    /** 「新建文件夹」的子窗口：主窗口之上再盖一层，只回答「建在哪、叫什么」。 */
    function PickCreateDialog(props) {
      const h = React.createElement
      const s = props.state
      const a = props.actions
      const level = s.pickLevel
      const targetName = s.pickSelected !== null && s.pickSelected !== undefined && hasText(s.pickSelected.name)
        ? String(s.pickSelected.name)
        : (level !== null && level !== undefined && Array.isArray(level.crumbs) && level.crumbs.length > 0
            ? String(level.crumbs[level.crumbs.length - 1].name)
            : '当前目录')
      const busy = s.pickCreating === true
      return h('div', {
        style: Object.assign({}, PICK_MASK, { zIndex: 210 }),
        className: 'dgs-pick-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) a.pickCreateCancel() },
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          event.preventDefault()
          a.pickCreateCancel()
        },
      },
        h('div', {
          style: Object.assign({}, PICK_CARD, { width: '340px' }),
          className: 'dgs-pick-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '新建文件夹',
        },
          h('div', { style: { padding: '14px 14px 0', fontWeight: 600 } }, '新建文件夹'),
          h('div', { style: Object.assign({}, S.note, { padding: '4px 14px 0' }) }, '在 ' + targetName + ' 中创建'),
          h('input', {
            style: Object.assign({}, S.input, { margin: '10px 14px 0' }),
            className: 'dgs-input',
            value: s.pickFolder === null ? '' : s.pickFolder,
            placeholder: '文件夹名称',
            autoFocus: true,
            disabled: busy,
            onChange: (event) => a.pickCreateDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && busy !== true) {
                event.preventDefault()
                a.pickCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                event.preventDefault()
                a.pickCreateCancel()
              }
            },
          }),
          hasText(s.pickCreateError)
            ? h('div', { style: Object.assign({}, S.warn, { padding: '8px 14px 0' }) }, '⚠ ' + s.pickCreateError)
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 14px' } },
            panelButton('取消', () => a.pickCreateCancel(), { locked: busy }),
            panelButton('创建', () => a.pickCreate(), { primary: true, locked: busy }),
          ),
        ),
      )
    }

    /** 目录选择小窗口本体。 */
    function PickDialog(props) {
      const h = React.createElement
      const s = props.state
      const a = props.actions
      const level = s.pickLevel
      const hasLevel = level !== null && typeof level === 'object'
      const entries = hasLevel && Array.isArray(level.entries) ? level.entries : []
      const visibleEntries = entries.filter((entry) => entry !== null && typeof entry === 'object'
        && (s.pickShowHidden === true || entry.hidden !== true))
      const crumbs = pickCrumbs(level)
      const selectedPath = s.pickSelected !== null && s.pickSelected !== undefined && hasText(s.pickSelected.path)
        ? s.pickSelected.path
        : null
      const canPick = hasLevel && (selectedPath !== null || hasText(level.path))
      const editing = s.pickDraft !== null
      const busy = s.pickBusy === true
      // 宿主只组合了系统对话框（native）：网页里列不了目录，这一版界面把「列出目录」
      // 换成「打开系统对话框」，手输绝对路径照旧可用。
      const native = s.pickNative === true

      return h('div', {
        style: PICK_MASK,
        className: 'dgs-pick-mask',
        key: 'pick-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) a.closePicker() },
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          // 新建文件夹的子窗口自己处理 Escape（它在更上面一层）。
          if (s.pickFolder !== null) return
          event.stopPropagation()
          a.closePicker()
        },
      },
        h('div', {
          style: PICK_CARD,
          className: 'dgs-pick-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '选择要查看的目录',
          tabIndex: -1,
          autoFocus: true,
        },
          // 头：标题 + 一句说明（和 DSH「添加工作区」同一个选择器）。
          h('div', { style: { padding: '14px 14px 0' } },
            h('div', { style: { fontWeight: 600 } }, '选择要查看的目录'),
            h('div', { style: Object.assign({}, S.note, { marginTop: '2px' }) },
              '与「添加工作区」同一个目录选择器；选中的目录将成为面板的新工作目录'),
          ),
          // 面包屑 / 路径输入（模式在 crumb ↔ input 之间切换）。
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 14px 0' } },
            editing
              ? h('input', {
                  style: S.input,
                  className: 'dgs-input',
                  value: s.pickDraft,
                  placeholder: native
                    ? '绝对路径（回车切换），如 C:\\Users\\me\\project'
                    : '绝对路径（回车进入），如 /home/me/project',
                  autoFocus: true,
                  onChange: (event) => a.pickDraftChange(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      a.pickDraftSubmit()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      a.pickDraftCancel()
                    }
                  },
                })
              : h(React.Fragment, null,
                  h('span', {
                    style: {
                      flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: '2px',
                      overflowX: 'auto', whiteSpace: 'nowrap',
                    },
                  },
                    crumbs.length === 0
                      ? h('span', { style: S.note }, native ? '（用系统对话框选择目录）' : '（还没有目录可列）')
                      : crumbs.map((crumb, index) => h('span', {
                          key: crumb.path, style: { display: 'inline-flex', alignItems: 'center' },
                        },
                          index > 0
                            ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '10px' } }, '›')
                            : null,
                          h('button', {
                            type: 'button',
                            className: 'dgs-pick-crumb',
                            title: crumb.path,
                            onClick: () => a.pickCrumb(crumb.path),
                          }, String(crumb.name)),
                        )),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dgs-mini dgs-pick-crumb',
                    'aria-label': '输入路径',
                    title: native ? '直接输入绝对路径（回车切换）' : '直接输入绝对路径（回车进入）',
                    onClick: () => a.pickDraftStart(),
                  }, '✎'),
                ),
          ),
          // 目录列表：单击选中、双击/回车进入。宿主只组合了系统对话框时（native）
          // 网页里列不了目录，这一块换成说明 + 「打开系统目录选择器」；手输路径照旧。
          native
            ? h('div', {
                style: {
                  flex: '1 1 0%', minHeight: '120px', maxHeight: '44vh', overflowY: 'auto',
                  margin: '10px 14px 0', padding: '18px 14px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: '10px', textAlign: 'center',
                  border: '1px dashed var(--dsw-alias-border-l2, #dddddd)',
                  borderRadius: '10px',
                },
              },
                h('div', { style: S.emptyIcon }, '🗂'),
                h('div', { style: S.note },
                  '这次 DSH 组合的目录选择器是系统对话框（不在网页里列目录），这里没法浏览目录。'),
                panelButton('打开系统目录选择器…', () => a.pickSystem(), {
                  primary: true,
                  locked: busy,
                  title: '调用 DSH 自带的目录选择器（系统对话框）',
                }),
                h('div', { style: S.note }, '也可以点上面的 ✎ 直接输入绝对路径后回车。'),
              )
            : h('div', {
            style: {
              flex: '1 1 0%', minHeight: '120px', maxHeight: '44vh', overflowY: 'auto',
              margin: '10px 14px 0', padding: '4px',
              border: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
              borderRadius: '10px',
              background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            },
          },
            visibleEntries.length === 0
              ? h('div', { style: Object.assign({}, S.empty, { border: 'none' }) },
                  h('div', { style: S.emptyIcon }, '📭'),
                  h('div', null, entries.length === 0
                    ? '此目录下没有子目录'
                    : '这里只有隐藏目录（点「显示隐藏文件」查看）'))
              : visibleEntries.map((entry) => {
                  const selected = entry.path === selectedPath
                  return h('button', {
                    type: 'button',
                    key: entry.path,
                    className: 'dgs-pick-row' + (selected ? ' dgs-pick-row-selected' : ''),
                    'aria-current': selected ? 'true' : undefined,
                    title: (selected ? '已选中' : '单击选中，双击进入') + '：' + entry.path,
                    onClick: () => a.pickSelect(entry),
                    onDoubleClick: () => a.pickEnter(entry),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        a.pickEnter(entry)
                      }
                    },
                  },
                    h('span', { 'aria-hidden': true, style: { flex: '0 0 auto', fontSize: '13px' } }, '📁'),
                    h('span', {
                      style: {
                        flex: '1 1 auto', minWidth: 0, textAlign: 'left',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                    }, String(entry.name)),
                    h('span', {
                      'aria-hidden': true,
                      style: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
                    }, '›'),
                  )
                }),
          ),
          // 状态行：加载中 / 失败 / 条目被截断。
          busy
            ? h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px 0',
                  color: 'var(--dsw-alias-label-secondary, #666666)',
                },
              },
                h('span', { style: S.busyDot, className: 'dgs-spin' }),
                h('span', null, '加载中…'))
            : null,
          hasText(s.pickError)
            ? h('div', { style: Object.assign({}, S.warn, { padding: '8px 14px 0' }) }, '⚠ ' + s.pickError)
            : null,
          hasLevel && level.truncated === true
            ? h('div', { style: Object.assign({}, S.note, { padding: '8px 14px 0' }) }, '目录条目很多，列表只显示了前一部分')
            : null,
          // 底部操作：新建文件夹 / 显示隐藏文件 / 取消 / 选择此目录。
          // native 模式下浏览相关的两个按钮没有意义（宿主没有 browse 能力），隐藏它们。
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '12px 14px' } },
            native
              ? null
              : panelButton('新建文件夹', () => a.pickCreateStart(), {
                  locked: busy || canPick !== true,
                  title: '在选中的目录（没选就是当前目录）里新建一个文件夹',
                }),
            native
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dgs-pick-crumb',
                  'aria-pressed': s.pickShowHidden === true,
                  title: '默认隐藏以 . 开头的目录（与宿主浏览器一致）',
                  onClick: () => a.pickToggleHidden(),
                }, s.pickShowHidden === true ? '隐藏文件 ✓' : '显示隐藏文件'),
            h('span', { style: S.spacer }),
            panelButton('取消', () => a.closePicker(), { locked: false }),
            native
              ? null
              : panelButton('选择此目录', () => a.pickConfirm(), {
                  primary: true,
                  locked: busy || canPick !== true,
                  title: hasLevel && selectedPath !== null
                    ? '面板切换到选中的目录：' + selectedPath
                    : (hasLevel ? '面板切换到当前显示的目录' : '还没有可选择的目录'),
                }),
          ),
        ),
        s.pickFolder !== null ? h(PickCreateDialog, { key: 'pick-create', state: s, actions: a }) : null,
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────────

    function GitPanel(props) {
      const h = React.createElement
      const [enabled] = useEnabled()
      const panel = useGitPanel(props)
      const s = panel.state
      const a = panel.actions

      if (enabled !== true) return null

      const isRepo = s.snapshot !== null && s.snapshot.isRepo === true
      const changes = isRepo && Array.isArray(s.snapshot.changes) ? s.snapshot.changes : []
      const changesTotal = isRepo && typeof s.snapshot.changesTotal === 'number'
        ? s.snapshot.changesTotal
        : changes.length
      const commits = isRepo && Array.isArray(s.snapshot.log) ? s.snapshot.log : []
      const remotes = s.snapshot !== null && Array.isArray(s.snapshot.remotes) ? s.snapshot.remotes : []
      const locked = s.busy === true
      // 「推送」按钮这次会推到哪里：这个仓库记住的那个远程（且它现在还在远程列表里）。
      // 空串 = 跟随上游，也就是老行为（裸 git push）。
      const pushTarget = pushTargetRemote(s)
      const pushSummary = isRepo !== true
        ? ''
        : (pushTarget.length > 0
            ? 'git push ' + pushTarget + ' HEAD'
            : (hasText(s.snapshot.upstream)
                ? '跟随上游 → ' + String(s.snapshot.upstream)
                : '还没有上游：会自动建立跟踪'))
      // 「拉取」按钮这次会从哪儿拉：与推送同一套记忆（各记一份）。空串 = 跟随上游。
      // 选中的值可能点名了分支（`origin master`，见 pullPlanFor）：无论哪种形状，行尾都要
      // 写出**真正会跑的那条命令** —— 没点名时宿主按当前分支名补，这里就把补出来的写全，
      // 用户不必猜「从 origin 拉」到底会拉哪条。
      const pullTarget = pullTargetRemote(s)
      const pullBranch = isRepo === true && hasText(s.snapshot.branch) ? String(s.snapshot.branch) : ''
      const pullPicked = parsePullTarget(pullTarget)
      // 下拉里的候选（跟随上游那一项在渲染处另外写死）：远程 + 需要点名分支时的第二项。
      const pullChoices = isRepo === true ? pullSourceChoices(s, remotes) : []
      const pullSummary = isRepo !== true
        ? ''
        : (pullTarget.length > 0
            ? 'git pull ' + pullPicked.remote
              + (pullPicked.branch.length > 0
                  ? ' ' + pullPicked.branch
                  : (pullBranch.length > 0 ? ' ' + pullBranch : ''))
              + '（上游不动）'
            : (hasText(s.snapshot.upstream)
                ? '跟随上游 → ' + String(s.snapshot.upstream)
                : '还没有上游：会自动建立跟踪'))

      const children = []

      // 网络加速设置块放在最前面（见 NetSection 注释）。
      // 注意：children 是数组，数组里的**每个元素都必须有 key**（真实 React 会警告，
      // 而且没有 key 时同一位置换组件会按索引复用，状态可能串味）。假 React 不检查
      // 这一点，所以这条约束由「真实 React + jsdom」那一轮验证兜住。
      if (s.showNet === true) {
        children.push(h(NetSection, {
          key: 'net-section',
          net: s.net,
          ready: s.net !== null && typeof s.net === 'object',
          netBusy: s.netBusy,
          netProxy: s.netProxy,
          netProbe: s.netProbe,
          onProxyChange: (value) => panel.patch({ netProxy: value }),
          onSave: a.saveNet,
          onProbe: a.probeNet,
        }))
      }

      children.push(h(RepoCard, {
        key: 'repo',
        state: s,
        locked: locked,
        isRepo: isRepo,
        remotes: remotes,
        // 「推送目标」= 这个仓库记住的那个远程（不是上游推导出来的）：远程行据此
        // 把「推送到此」标成当前目标，并让「同步」区的下拉与远程列表永远一致。
        pushTarget: pushTarget,
        // 「推送到此」= 「选它当这个仓库的推送目标，然后推一次」：两个动作一起做，
        // 于是它和「推送到」下拉是同一件事的两个入口（文档里也是这么写的）。
        // 只推不记的话，用户点完这一行再点「推送」会突然推回原处，像功能失灵。
        onPushToRemote: (name) => {
          a.setPushRemote(name)
          a.push(name)
        },
        // 「拉来源」= 这个仓库记住的那个值（`origin` 或 `origin master`）：远程行据此把它
        // 标成当前来源。与 pushTarget 同一套记忆，只是拉多带了可选的分支名。
        pullTarget: pullTarget,
        // 「从此外拉」= 「把它记成这个仓库的拉取来源，然后拉一次」，与「推送到此」同构。
        // 远程行的按钮自己算出要拉哪个值（见 pullPlanFor）并传进来 —— 让按钮与
        // 「拉取自」下拉是同一件事的两个入口，而不是两条各算各的路。
        onPullFromRemote: (name) => {
          const plan = pullPlanFor(s, name)
          a.pullFromRemote(plan === null ? name : plan.value)
        },
        // 仓库主页链接：宿主在 state.pageUrl 里推导好了（本地路径 / 无远程时为 null）。
        pageUrl: isRepo && s.snapshot !== null && hasText(s.snapshot.pageUrl) ? s.snapshot.pageUrl : null,
        sessionCwd: panel.sessionCwd,
        onPickDir: () => a.openPicker(),
        onRefresh: () => a.load(s.workdir),
        onFollowSession: (target) => {
          panel.patch({ picked: false })
          a.switchDir(target)
        },
        onToggleBranches: a.toggleBranches,
        // 远程编辑：每个远程各自一行，打开的是**被点的那一行**（见 openRemoteEditor）。
        onToggleRemote: (name) => {
          if (s.editingRemote !== null && s.editingRemote === name) a.closeRemoteEditor()
          else a.openRemoteEditor(name)
        },
        onAddRemote: a.openRemoteAdder,
        onCloseRemote: a.closeRemoteEditor,
        onRemoteDraftName: a.remoteDraftName,
        onRemoteDraftUrl: a.remoteDraftUrl,
        onSaveRemote: a.saveRemote,
        onSaveRemoteAndPush: a.saveRemoteAndPush,
        onCopyRemote: a.copyRemote,
        onRemoveRemote: a.removeRemote,
      }))

      if (isRepo === true && s.showBranches === true) {
        children.push(h(BranchManager, {
          key: 'branch-manager',
          state: s,
          locked: locked,
          onCheckout: a.doCheckout,
          onCreateBranch: a.doCreateBranch,
          onDeleteBranch: a.doDeleteBranch,
          // 「改名」：就地展开输入框（**不用 window.prompt** —— 桌面版不支持 prompt，
          // 点了会静默无反应）。再点一次收起，与「设置上游」同一套展开方式。
          onRenameBranch: (name) => {
            if (s.renameFor !== null && s.renameFor === name) a.closeRenameEditor()
            else a.openRenameEditor(name)
          },
          onRenameDraft: a.renameDraftChange,
          onRenameSubmit: a.doRenameBranch,
          onCloseRename: a.closeRenameEditor,
          onBranchDraft: (value) => panel.patch({ branchDraft: value }),
          onAdopt: a.doAdoptRemoteBranch,
          onCompare: a.doCompareRemoteBranch,
          // 「⋯」菜单 / 设置上游 / 把上游绑到某条远端分支。
          onToggleMenu: a.toggleBranchMenu,
          onOpenUpstream: a.openUpstreamPicker,
          onCloseUpstream: a.closeUpstreamPicker,
          onSetUpstream: a.doSetUpstream,
        }))
      }

      if (isRepo !== true) {
        children.push(h(EmptyState, { key: 'empty', notice: s.snapshot !== null ? s.snapshot.notice : null }))
      }

      if (isRepo === true) {
        children.push(h(ChangesSection, {
          key: 'changes-section',
          changes,
          changesTotal,
          diffKey: s.diffKey,
          diffText: s.diffText,
          diffRef: panel.diffRef,
          locked,
          onToggle: a.showDiff,
          onStage: a.doStageFile,
          onUnstage: a.doUnstageFile,
          onRestore: a.doRestoreFile,
        }))

        // 操作区按语义分成两段，提交夹在中间：
        //   改动（全部暂存 / 撤销暂存 / 丢弃改动）→ 提交 → 同步（拉取 / 推送 / 获取远程）
        // 这正好是日常的先后顺序；原先六个按钮挤在一行里，暂存和同步混在一起。
        children.push(h('div', { style: S.actions, key: 'change-actions' },
          panelButton('全部暂存', () => a.runOp('addAll'), { locked: locked }),
          stagedCount(changes) > 0 ? panelButton('撤销暂存', () => a.runOp('unstage'), { locked: locked }) : null,
          // 「丢弃改动」是唯一不可逆的动作：单独用危险色，别和普通按钮长得一样。
          changes.length > 0
            ? panelButton('丢弃改动', () => {
                if (window.confirm('确定丢弃所有未提交的工作区改动？此操作不可恢复。\n（不影响未跟踪文件；已暂存的内容请先「撤销暂存」。）')) {
                  a.runOp('discard')
                }
              }, { danger: true, locked: locked })
            : null,
        ))

        children.push(h(CommitForm, {
          key: 'commit-form',
          message: s.message,
          amend: s.commitAmend,
          locked: locked,
          onChange: (value) => panel.patch({ message: value }),
          onAmendChange: (value) => panel.patch({ commitAmend: value }),
          onSubmit: a.doCommit,
          onCommitAndPush: a.doCommitAndPush,
        }))

        children.push(h('div', { style: S.sectionTitle, key: 'synctitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '同步'),
          h('span', { style: S.sectionRule }),
        ))
        children.push(h('div', { style: S.actions, key: 'sync-actions' },
          // 「安全拉取」在拉取行里（它与「拉取」只差「工作区脏不脏」的处理，来源必须一致）；
          // 这里只留与来源无关的动词：获取远程 + 变基。
          panelButton('获取远程', () => a.runOp('fetch'), { locked: locked }),
          h('label', {
            style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
            title: '勾上之后「拉取」改用 --rebase（本地提交挪到远端之上）',
            key: 'rebase',
          },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: s.pullRebase === true,
              onChange: (event) => panel.patch({ pullRebase: event.target.checked }),
            }),
            h('span', null, '变基'),
          ),
        ))

        /**
         * 拉取行：「拉取自」下拉 + 「拉取」+「安全拉取」。
         *
         * 与下面的推送行**完全对称**，理由也一样：来源是一个**选择**，不该混进动词排里。
         * 下拉第一项是「跟随上游」（裸 git pull，来源由上游配置决定），后面每个远程一项。
         *
         * 为什么必须有这个入口（真实现场）：分支跟踪的是 `fork`（自己的），而更新在
         * `origin`（别人的上游）上 —— 没有这个下拉时，拿上游的更新只能先把上游改绑到
         * origin、拉完再改回 fork，或者到终端敲 `git pull origin main`。现在选一次即可，
         * 而且**不改任何 git 配置**（显式 `git pull <远程> <当前分支>`）。
         */
        children.push(h('div', { style: S.row, key: 'pull-row' },
          h('span', { style: S.label }, '拉取自'),
          h('select', {
            style: Object.assign({}, S.select, { flex: '0 1 auto', maxWidth: '132px' }),
            className: 'dgs-input dgs-pull-target',
            value: pullTarget,
            disabled: locked,
            title: '选择「拉取」/「安全拉取」从哪儿拉。选中的那个会被这个仓库记住（localStorage）。'
              + '「跟随上游」= 裸 git pull，从当前分支跟踪的那个远程拉（默认行为）。'
              + '远程的默认分支与当前分支不同名时，它下面还会多出一项点名那条分支'
              + '（例如「从 origin/master 拉」）：那是把**另一条线**合进当前分支，'
              + '所以必须由你点，面板不替你选。',
            onChange: (event) => a.setPullRemote(event.target.value),
          },
            h('option', { value: '', key: 'upstream' }, '跟随上游'),
            // 与推送行同样展开成独立子元素（假 React 不扁平化数组）。
            ...pullChoices.map((choice) => h('option', {
              value: choice.value,
              key: 'pull-from-' + choice.value,
            }, choice.label)),
          ),
          panelButton('拉取', () => a.pull(), {
            primary: true,
            locked: locked,
            title: pullTarget.length > 0
              // 没点名分支时宿主按当前分支名补；游离 HEAD 上补不出来（宿主会明确拒绝），
              // 这时不写出一个空的命令尾巴，只说清来源。
              ? ('从 ' + pullPicked.remote + ' 拉取 '
                  + (pullPicked.branch.length > 0
                      ? pullPicked.branch + '（git pull ' + pullPicked.remote + ' ' + pullPicked.branch + '）'
                      : (pullBranch.length > 0
                          ? pullBranch + '（git pull ' + pullPicked.remote + ' ' + pullBranch + '）'
                          : '当前分支（现在处于游离 HEAD，宿主会让你先切到一条分支上）'))
                + '：显式指定来源，不动你的上游配置')
              : (s.pullRebase === true
                  ? '以 git pull --rebase 方式拉取：把你本地的提交挪到远端提交之上（历史更直）'
                  : 'git pull：从当前分支跟踪的上游拉取并合并到当前分支'),
          }),
          // 工作区脏的时候「安全拉取」才是该点的那一个 —— 描一圈品牌色，别让用户在
          // 「拉取」和「安全拉取」之间靠读提示猜（两个按钮行为在干净时完全一样）。
          // 它与「拉取」**同一个来源**（都读「拉取自」），只是多了 stash 保护。
          panelButton('安全拉取', () => a.stashPullNow(), {
            locked: locked,
            hot: changesTotal > 0,
            title: '本地有未提交改动（含未跟踪文件）时也能拉取：先自动藏起改动，拉取成功后再原样恢复；拉取失败也会自动还给你。'
              + '来源与「拉取」相同（看左边的「拉取自」）',
          }),
          h('span', { style: S.note }, pullSummary),
        ))

        // 「新客户端 + 旧宿主」时把原因说出来（与推送同一条判断、同一类中间态）。
        if (s.pullHostStale === true) {
          children.push(h('div', {
            style: S.warn, className: 'dgs-pull-stale', key: 'pull-stale',
          }, '⚠ 宿主的回执里没有你选的远程：宿主半边还是旧版本（它不会热重载）。'
            + '重启一次 dsh 再刷新页面，「拉取自」才会真的生效；这次拉取按旧逻辑跑了（从上游拉）。'))
        }

        /**
         * 推送行：「推送到」下拉 + 「推送」按钮。
         *
         * 单独占一行，因为「推到哪个远程」是一个**选择**，不该挤进上面那排动词里。
         * 下拉里第一项是「跟随上游」（裸 git push，老行为），后面每个远程一项；
         * 选中之后这一行会写出真正要跑的那条命令，并且**按仓库记住**这个选择
         * （localStorage，切回来还在）—— 多远程下「我永远推 fork」只需选一次。
         * 远程行的「推送到此」是同一件事的另一个入口。
         */
        children.push(h('div', { style: S.row, key: 'push-row' },
          h('span', { style: S.label }, '推送到'),
          h('select', {
            style: Object.assign({}, S.select, { flex: '0 1 auto', maxWidth: '132px' }),
            className: 'dgs-input dgs-push-target',
            value: pushTarget,
            // 与其他控件一致：正忙（上一次操作还在跑）时不可改 —— 否则用户在
            // 「推送 fork」还没回来时改成 origin，会以为这次推的是 origin。
            disabled: locked,
            title: '选择「推送」按钮推给哪个远程。选中的那个会被这个仓库记住（localStorage）。'
              + '「跟随上游」= 裸 git push，推给当前分支跟踪的那个远程（默认行为）。',
            onChange: (event) => a.setPushRemote(event.target.value),
          },
            h('option', { value: '', key: 'upstream' }, '跟随上游'),
            // 展开成**独立子元素**而不是一个数组子元素：数组在真实 React 里会被扁平化，
            // 但面板的假 React 测试环境不会 —— 展开后两边看到的是同一棵树。
            ...remotes.map((item) => (item !== null && typeof item === 'object'
              ? h('option', { value: String(item.name), key: 'push-to-' + String(item.name) },
                  '推送到 ' + String(item.name))
              : null)),
          ),
          panelButton('推送', () => a.push(), {
            primary: true,
            locked: locked,
            title: pushTarget.length > 0
              ? '把当前分支推到 ' + pushTarget + '（git push ' + pushTarget + ' HEAD）：显式 refspec，不受 push.default 配置限制'
              : 'git push：推给当前分支跟踪的上游；还没有上游时面板会自动补 --set-upstream 重推',
          }),
          h('span', { style: S.note }, pushSummary),
        ))

        // 「新客户端 + 旧宿主」时把原因说出来，而不是让用户以为「选了远程却没反应」。
        if (s.pushHostStale === true) {
          children.push(h('div', {
            style: S.warn, className: 'dgs-push-stale', key: 'push-stale',
          }, '⚠ 宿主的回执里没有你选的远程：宿主半边还是旧版本（它不会热重载）。'
            + '重启一次 dsh 再刷新页面，「推送到」才会真的生效；这次推送按旧逻辑跑了。'))
        }

        // stash 备份：面板自己藏的改动，收尾也在面板里做完。
        children.push(h('div', { style: S.box, key: 'stash-row' },
          panelButton(
            s.showStash === true ? '收起 stash 备份' : ('stash 备份' + (s.stashList.length > 0 ? '（' + s.stashList.length + '）' : '')),
            () => a.toggleStash(),
            { locked: locked, title: '「安全拉取」「安全切分支」自动藏起来的改动会出现在这里，可以恢复或删除' },
          ),
        ))
        if (s.showStash === true) {
          children.push(h(StashList, {
            key: 'stash-list',
            items: s.stashList,
            locked,
            onApply: a.doStashApply,
            onDelete: a.doStashDrop,
          }))
        }
      } else {
        children.push(h('div', { style: S.actions, key: 'actions' },
          panelButton('初始化仓库', () => a.runOp('init'), { primary: true, locked: locked }),
          panelButton(s.showClone === true ? '收起克隆' : '克隆仓库',
            () => panel.patch({ showClone: s.showClone !== true }), { locked: locked }),
        ))
      }

      if (isRepo !== true && s.showClone === true) {
        children.push(h(CloneForm, {
          key: 'clone-form',
          url: s.cloneUrl,
          shallow: s.cloneShallow,
          locked: locked,
          onChange: (value) => panel.patch({ cloneUrl: value }),
          onShallowChange: (value) => panel.patch({ cloneShallow: value }),
          onClone: async () => {
            const data = await a.runOp('clone', s.cloneShallow === true
              ? { url: s.cloneUrl, depth: 1 }
              : { url: s.cloneUrl })
            // 克隆成功后宿主会回传新仓库的落点（clonedDir），直接切进去并刷新，
            // 省掉「再手动切一次目录」这一步。**这里不走 switchDir**：克隆的输出
            // 正是用户要看的克隆结果，清掉就白跑了。
            if (isOk(data) && hasText(data.clonedDir)) {
              panel.patch({ picked: true, workdir: data.clonedDir, showClone: false, cloneUrl: '' })
              a.load(data.clonedDir)
            }
          },
        }))
      }

      if (commits.length > 0) {
        children.push(h(LogList, {
          key: 'log-list',
          commits,
          openRef: s.logRef,
          locked,
          onShow: a.doShowCommit,
          onCheckoutCommit: a.doCheckoutCommit,
        }))
      }
      // 提交详情：内联在提交列表下面（与「点改动看 diff」同一套交互），
      // 加载中与失败都写进 logText，所以这里一定有东西可画。
      if (s.logRef.length > 0) {
        // 提交详情用同一个抬头条：短哈希当主体，右侧挂着「提交详情」而不是暂存状态。
        children.push(diffTitleBar({
          path: s.logRef,
          chip: '提交详情',
          title: '这条提交的详情：' + s.logRef,
        }))
        children.push(renderLines(s.logText, S.diff, undefined, 'log-detail'))
      }

      /**
       * 面板下半部分的**固定区**：命令结果、以及「要你选一个结果」的选项都在
       * 正文滚动区之外。
       *
       * 为什么搬出来：这两块都是「刚刚那一下动作的回音」—— 结果栏原先挂在正文最末尾，
       * 点一次「全部暂存」它可能落在滚动区之外（所以才有那个闪一下的补偿）。固定之后
       * 正文怎么滚，回音与待决定的事都在视野里。
       */
      const footer = []
      if (Array.isArray(s.choices) && s.choices.length > 0) {
        footer.push(h(ChoiceBox, { key: 'choices', choices: s.choices, locked, onChoose: a.runChoice }))
      }
      if (hasText(s.output)) {
        footer.push(h('div', { key: 'outblock', style: S.outBlock },
          h('div', { style: S.outBar },
            h('span', { style: S.note }, '命令结果'),
            h('span', { style: S.spacer }),
            panelButton('清空', () => a.clearOutput(), {
              compact: true,
              key: 'clear-output',
              title: '收起这块结果（下一次操作会重新写进来）',
            }),
          ),
          h(OutputPanel, { output: s.output, outRef: panel.outRef }),
        ))
      }

      const upstream = isRepo && s.snapshot !== null && hasText(s.snapshot.upstream)
        ? String(s.snapshot.upstream)
        : null

      // 局部样式表随面板一起挂载/卸载（不写全局样式表，也不动宿主 DOM）。
      return h(React.Fragment, null,
        panelStyles(),
        h('div', {
          style: S.panel,
          className: 'dgs-panel',
        },
          // 注意这里**没有**「拉宽 / 最小化」这类控件：标签的宽度、停靠还是浮动、
          // 以及要不要收起来，全归右侧栏的标签栏与 docking kit。插件再画一套，
          // 就会和宿主的控件在同一块区域里打架。
          h(HeadBar, {
            busy: s.busy,
            showNet: s.showNet,
            onToggleNet: (next) => panel.patch({ showNet: next }),
          }),
          // 正文的滚动区：底部状态条点一下要能把这里的 scrollTop 归零（见 scrollToTop）。
          h('div', { style: S.body, className: 'dgs-body', ref: panel.bodyRef }, children),
          // 固定区（命令结果 / 待选项）：不在滚动区里，所以永远看得见。
          footer.length > 0 ? h('div', { style: S.footer }, footer) : null,
          // 常驻状态条：我在哪个分支、有多少改动、上一次操作成没成。
          h(StatusBar, {
            key: 'status',
            summary: statusSummary(isRepo, s.snapshot, changesTotal),
            tail: isRepo === true ? (upstream === null ? '未设上游' : '→ ' + upstream) : '',
            mismatch: isRepo === true && upstreamNameMismatch(s.snapshot),
            lastOk: s.lastOk,
            onTop: a.scrollToTop,
          })),
        // 目录选择小窗口：与面板同级挂在最外层（fixed 定位，盖住整页），
        // 只在打开时渲染 —— 关掉即卸载，不残留任何浮层。
        s.pickerOpen === true ? h(PickDialog, { key: 'pick-dialog', state: s, actions: a }) : null)
    }

    // ── 标签标题组件（sidebar.right.pane.tab.title） ──────────────────────

    /**
     * 标签 chip 上显示的文字。
     *
     * 为什么要注册它、而不是让右侧栏用 registry 里那个 `title()` 就够了：
     * 两者都可以，注册的这个是**活的** —— 宿主在每次投影时读它，因此将来若要
     * 把「改动数」这类实时信息写进标题，不用重新注册类型。
     *
     * 现在标题是固定的「Git」：面板的正文已经把分支和改动数写在最显眼处了，
     * 标签上再挤一遍反而在窄栏里被截断。于是这里只做一件轻量的事：把
     * 「有没有东西要提交」放进 tooltip。
     */
    function GitTabTitle() {
      const h = React.createElement
      return h('span', { title: 'Git：改动、暂存、提交、分支与远程' }, 'Git')
    }

    // ── 设置行组件（设置 → 通用） ─────────────────────────────────────────

    function GitPanelToggle(props) {
      const h = React.createElement
      const [enabled, setEnabled] = useEnabled()
      const onOpen = props !== null && props !== undefined && typeof props.onOpen === 'function'
        ? props.onOpen
        : null
      return h('div', { style: S.settingRow },
        h('div', { style: S.settingText },
          h('div', { style: S.settingTitle }, 'Git 面板'),
          h('div', { style: S.settingHint },
            enabled === true
              ? '已开启：右侧栏里可以打开 Git 标签（与「工作区文件」「新建终端」「浏览器」并列），在里面完成暂存、提交、拉取、推送等操作。'
              : '已关闭：Git 标签会显示为「已关闭」。随时可以在这里重新开启。'),
        ),
        h('div', { style: S.settingActions },
          // 「打开」只在开启时有意义，而且只在拿得到右侧栏控制器时出现 ——
          // 拿不到（宿主没有这个服务）就不该画一个点了没反应的按钮。
          enabled === true && onOpen !== null
            ? h('button', {
                key: 'open',
                type: 'button',
                className: buttonClass(false, false),
                style: buttonStyle(false, false),
                onClick: onOpen,
                title: '在右侧栏里打开 Git 标签',
              }, '打开')
            : null,
          h('button', {
            key: 'toggle',
            type: 'button',
            'aria-pressed': enabled === true,
            // 开关的实心色跟着**当前状态**走：开启时是高亮的品牌色，关闭时是普通
            // 次要按钮。反过来（关闭才高亮）会让「已关闭」看起来像一个动作按钮。
            className: buttonClass(enabled === true, false),
            style: buttonStyle(enabled === true, false),
            onClick: () => setEnabled(enabled !== true),
          }, enabled === true ? '已开启' : '已关闭'),
        ),
      )
    }

    // ── 渲染错误边界 ──────────────────────────────────────────────────────
    //
    // 宿主半边把「故障可见」做得很足（notice、归一化、永不抛异常），客户端却一直
    // 没有这一层：渲染里抛一次异常，整个面板就无声消失 —— 而浏览器控制台对用户不可见，
    // 与「出了问题要看得见」的原则相悖。加一层边界：出错时画一个可读的失败态、
    // 把原因写进宿主日志（diag），并给一个「重试」按钮。
    //
    // 但 React 的错误边界**只能是 class 组件**，而测试是拿假 React 求值 bundle 的
    // （没有 Component，也不支持 new 调用类组件）。所以这里做成「有 Component 才启用」：
    // 真实 React 下是一层真正的边界，假 React 下退化成直接渲染子节点 ——
    // 测试不必为了一个测试替身去实现整个 class 语义。

    function makeErrorBoundary(ComponentBase) {
      if (ComponentBase === null || ComponentBase === undefined) return null
      return class PanelErrorBoundary extends ComponentBase {
        constructor(props) {
          super(props)
          this.state = { error: null }
          this.retry = this.retry.bind(this)
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error) {
          const detail = error !== null && error !== undefined && error.message ? error.message : String(error)
          diag('render-error', detail)
        }
        retry() {
          // 边界捕获后子树已被卸载，清掉 error 即重新挂载一个全新的面板。
          this.setState({ error: null })
        }
        render() {
          if (this.state.error !== null) {
            const detail = this.state.error !== null && this.state.error !== undefined && this.state.error.message
              ? this.state.error.message
              : String(this.state.error)
            return React.createElement('div', { style: S.panel, className: 'dgs-panel' },
              panelStyles(),
              React.createElement('div', { style: S.head },
                React.createElement('span', { style: S.title }, '🐙 Git 面板')),
              React.createElement('div', { style: S.body },
                React.createElement('div', { style: S.empty }, '面板界面出错（原因已写进宿主日志 git-sidebar.log）'),
                React.createElement('div', { style: S.warn }, '⚠ ' + detail),
                React.createElement('div', { style: S.actions },
                  React.createElement('button', {
                    type: 'button',
                    className: buttonClass(true, false),
                    style: buttonStyle(true, false),
                    onClick: this.retry,
                  }, '重试'))),
            )
          }
          return this.props.children
        }
      }
    }

    const PanelErrorBoundary = makeErrorBoundary(React.Component)

    /** 给组件包一层错误边界；没有可用的 Component 时原样返回。 */
    function withBoundary(component) {
      if (PanelErrorBoundary === null) return component
      return function BoundedPanel(props) {
        return React.createElement(PanelErrorBoundary, null, React.createElement(component, props))
      }
    }

    // ── cordis 客户端插件 ─────────────────────────────────────────────────

    /** 诊断上报：把注册过程写回宿主日志（浏览器控制台对用户不可见时的观测通道）。 */
    function diag(stage, detail) {
      try {
        fetch('/git-sidebar/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: stage, detail: detail === undefined ? null : String(detail) }),
        }).catch(() => {})
      } catch (error) {
        /* 诊断失败不影响功能 */
      }
    }

    /**
     * 注册一个 slot 条目，两种"声明时机"都覆盖。
     *
     * 要点：`ctx.slots.inject(name, cb)` 只在**声明事件**上回调（当前实现订阅后会
     * 立刻 reconcile 一次，但这一点不保证跨版本稳定）。因此对一个「插件加载时
     * 就已经存在」的 slot（例如 ui-settings-general 早已声明好的
     * `settings.general.item`），只写 inject 有等不到回调的风险，界面条目会静默消失。
     *
     * 所以：先直接 register；只有抛错（slot 尚未声明）才退回 inject 等待声明。
     * 异步声明时，cordis 会在回调返回的 disposer 上负责回收。
     *
     * 关键：**不能用"有一处失败"就判断"没声明"**。注册失败也可能是别的原因
     * （同 priority 已有占用、options 结构变化等），把它当成"还没声明"会让组件
     * 永远不出现，而真实原因只在控制台里一闪而过。因此只有回调里真的注册成功了
     * 才记 `declared-later`，否则把真实原因照原样回报诊断通道。
     */
    function registerSlot(ctx, options, component, label) {
      if (ctx.slots === undefined || ctx.slots === null) {
        diag(label + ':no-slots-service')
        return undefined
      }
      try {
        const dispose = ctx.slots.register(options, component)
        diag(label + ':registered-direct')
        return dispose
      } catch (error) {
        diag(label + ':direct-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
      }
      try {
        ctx.slots.inject(options.name, () => {
          try {
            const dispose = ctx.slots.register(options, component)
            diag(label + ':declared-later')
            return dispose
          } catch (error) {
            // 声明已经到来却仍注册失败：这是真问题（选项结构变化、priority 占用…），
            // 报出来而不是让界面无声消失。
            diag(label + ':register-failed-after-declaration', error !== null && error !== undefined && error.message ? error.message : String(error))
            return undefined
          }
        })
      } catch (error) {
        diag(label + ':inject-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
      }
      return undefined
    }

    /**
     * 需要的客户端服务（cordis fiber inject）：
     *   · slots             —— 注册界面（标签正文 / 标签标题 / 设置开关行）。
     *   · sidebarRightTabs  —— **标签类型注册表**：声明「这是一种什么 tab」。
     *     它由 @deepseek-ai/dsh-client-ui-sidebar-right 用 ctx.reflect.provide 提供，
     *     register({ id, kind, priority, title, guide }) 返回一个 disposer。
     *     不 inject 就取不到：客户端服务是 cordis 懒注入的，不声明的话 ctx 上根本没有。
     *   · sidebarRight      —— 右侧栏控制器：openTab(kind) / isExpanded() 等。
     *     本插件用它实现「点设置里的按钮 / 快捷键时把标签打开」。
     *   · uiWorkspace       —— 目录选择小窗口用的目录服务（listDirectory / createDirectory /
     *     pickDirectory），与 DSH「添加工作区」用的是同一个服务、同一条 wire。
     *
     * 关于 uiWorkspace 为什么要 inject 而不是「读 ctx.remote.directoryPicker」：
     * 同样是懒注入 —— **不声明的服务，在插件上下文里读不到**。实测过：那样写小窗口
     * 永远拿不到目录服务，只能手输路径。声明 inject 后 cordis 会等服务就绪再 apply，
     * 取到的是真身。
     */
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']

    /**
     * 本插件的标签类型定义，交给 sidebarRightTabs.register。
     *
     * 四段注册里的第一段，回答「这是一种什么 tab」：
     *   · id       —— 实现身份，**全局唯一**，也是正文与标题两个 keyed 插槽的 key。
     *                 用包名（官方那几个 tab 也这么干，见 sidebar-files 的 FILES_ID）。
     *   · kind     —— 类型判别子，openTab(kind) 用它点名这一类。用小写短名 'git'。
     *   · priority —— 'extension'：产品之外的插件用这一档。它是最高档，也是默认值，
     *                 但显式写出来让「这是第三方类型」这件事在代码里看得见。
     *   · title    —— 标签 chip 的初始文字，**开标签那一刻就被捕获**进布局记录。
     *   · guide    —— 指南页里的入口卡片。给了它，用户在空的右侧栏指南页里就能
     *                 直接点「Git」开一个 —— 与「工作区文件」「新建终端」并列，
     *                 这正是这个插件要的效果。order 排在 official 那几项之后。
     *
     * 不写 patterns：本插件是**页面类型**（靠 kind 打开），不是资源类型的 viewer
     * （那类要声明 address globs，比如 dsh-resource://file/**）。
     */
    function gitTabDefinition() {
      return {
        id: GIT_TAB_ID,
        kind: GIT_TAB_KIND,
        priority: GIT_TAB_PRIORITY,
        // 直接返回中文字面量：本插件的界面文案全程是中文，没有接 locale 词典体系
        // （官方那几个 tab 走 ctx.locale，是为了多语言；本插件不需要，
        //  而且 title 是 thunk，将来要接多语言只需把这里换成读词典）。
        title: () => 'Git',
        guide: [
          {
            id: 'git-panel',
            // 放在官方那几项之后（files 10 / terminal 20 / browser 30）：
            // 指南页的条目按 order 升序排，官方功能应该在前面。
            order: 40,
            title: () => 'Git 面板',
            description: () => '查看改动、暂存、提交、切分支、拉取与推送',
          },
        ],
      }
    }

    function apply(ctx) {
      diag('apply:start', ctx !== undefined && ctx.slots !== undefined ? 'slots ready' : 'slots missing')
      // 清掉旧版浮窗遗留的 localStorage 键（宽度 / 最小化胶囊 / 帮助窗口，已无读取方）。
      cleanupLegacyKeys()

      /**
       * 目录选择器的 live getter：面板的「切换」小窗口与 DSH「添加工作区」共用
       * 同一个选择器（uiWorkspace 的 listDirectory / createDirectory / pickDirectory，
       * 宿主那个对话框内部走的也是这几个方法）。
       *
       * 每次打开小窗口时现取（而不是 apply 时抓一次）：服务可能被重载（HMR、
       * 插件重挂），拿最新的那个引用更稳。方法一个一个包成闭包，避免宿主服务
       * 依赖调用时的 this 绑在别处。
       *
       * 注意 list / pick 是**两个能力**：一次启动只组合其中一种（见
       * lib/client.js 顶部的 isBrowseUnavailable）。三条都交出去，让面板按宿主
       * 实际组合出来的那种交互走；缺哪条在调用处退化，不在取值处抛。
       */
      const getPicker = () => {
        try {
          const service = ctx !== null && ctx !== undefined ? ctx.uiWorkspace : undefined
          if (service !== null && service !== undefined) {
            return {
              list: (path, signal) => service.listDirectory(path, signal),
              createDirectory: (path, name) => service.createDirectory(path, name),
              pick: () => {
                if (typeof service.pickDirectory !== 'function') {
                  throw new Error('宿主目录服务没有提供系统对话框')
                }
                return service.pickDirectory()
              },
            }
          }
        } catch (error) {
          /* 取不到就退回手输路径 */
        }
        return null
      }

      // 把 live getter 交给面板（owner 自己传了 getPicker 时以 owner 为准，测试用得上）。
      const BoundBody = withBoundary((props) => React.createElement(GitTabBody, Object.assign({}, props, {
        getPicker: props !== null && props !== undefined && typeof props.getPicker === 'function'
          ? props.getPicker
          : getPicker,
      })))

      // ── 标签类型的三段式注册 ────────────────────────────────────────────
      //
      // 这三段缺一不可，而且**必须用同一个 id**（见 GIT_TAB_ID 注释）：
      //   1. 声明类型（右侧栏据此把「Git」列进指南页与「+」菜单）
      //   2. 标签正文（keyed，key = id）
      //   3. 标签标题（keyed，key = id）
      //
      // 每段都自己判可用性、失败只影响自己：没有 sidebarRightTabs 服务时正文与标题
      // 仍会注册（虽然打不开），而类型注册失败时正文也不会连带消失 —— 让故障是
      // 「少了一块」而不是「整个插件没了」，诊断信息同时进宿主日志（diag）。

      // 1) 标签类型。register 会在 id 重复、或 kind 与已注册者冲突时抛异常
      //    （同一 kind 只有 builtin/extension 各一个名额，id 则全局唯一）。
      const registerTabType = () => {
        try {
          const tabs = ctx !== null && ctx !== undefined ? ctx.sidebarRightTabs : undefined
          if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') {
            diag('tab-type:no-registry')
            return undefined
          }
          const dispose = tabs.register(gitTabDefinition())
          diag('tab-type:registered', GIT_TAB_KIND + ' / ' + GIT_TAB_ID)
          return dispose
        } catch (error) {
          const detail = error !== null && error !== undefined && error.message ? error.message : String(error)
          diag('tab-type:failed', detail)
          return undefined
        }
      }

      const disposeType = registerTabType()
      if (disposeType !== undefined && typeof ctx.effect === 'function') {
        // 类型注册的寿命跟着插件走（服务可能在插件之后才就绪，所以也试一次 inject）。
        ctx.effect(() => disposeType)
      } else if (disposeType === undefined && typeof ctx.inject === 'function') {
        // 注册表稍后就绪的场景：等它出现再注册一次。
        try {
          ctx.inject(['sidebarRightTabs'], (readyCtx) => {
            const tabs = readyCtx !== null && readyCtx !== undefined ? readyCtx.sidebarRightTabs : undefined
            if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') return
            try {
              const dispose = tabs.register(gitTabDefinition())
              diag('tab-type:registered-late', GIT_TAB_KIND)
              if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
            } catch (error) {
              diag('tab-type:late-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
            }
          })
        } catch (error) {
          diag('tab-type:inject-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
        }
      }

      // 2) 标签正文。keyed 插槽，key = 类型定义的 id。
      registerSlot(
        ctx,
        { name: 'sidebar.right.pane.tab', key: GIT_TAB_ID },
        BoundBody,
        'tab-body',
      )

      // 3) 标签标题。同样是 keyed + 同 key。
      //
      // 这里注册的是一个「活标题」组件：右侧栏优先用它而不是 registry 捕获的
      // title(address) 文字。Git 面板的标题不需要跟着仓库变（始终是「Git」），
      // 所以这个组件只返回固定文字 —— 但**仍然要注册**：与正文成对出现，
      // 宿主换 title 投影方式时不会两边不一致。顺带在标题上挂一个有改动数的
      // tooltip，鼠标扫过标签就能知道「有没有东西要提交」。
      registerSlot(
        ctx,
        { name: 'sidebar.right.pane.tab.title', key: GIT_TAB_ID },
        withBoundary(GitTabTitle),
        'tab-title',
      )

      // 4) 「设置 → 通用」里的开关行（带一个「打开」——直接开这个标签，不用去右侧栏里找）。
      //
      // 只有真的拿得到右侧栏控制器时才交出 onOpen：设置行据此决定画不画「打开」。
      // 否则会画出一个点了没反应的按钮 —— 那比没有按钮更让人困惑。
      const canOpenTab = ctx !== null && ctx !== undefined
        && ctx.sidebarRight !== null && ctx.sidebarRight !== undefined
        && typeof ctx.sidebarRight.openTab === 'function'
      registerSlot(
        ctx,
        { name: 'settings.general.item', id: 'git-sidebar-toggle', order: 30 },
        withBoundary(canOpenTab
          ? (props) => React.createElement(GitPanelToggle, Object.assign({}, props, {
            onOpen: () => {
              // ctx.sidebarRight.openTab(kind)：按 kind 开一个页面类型。
              // 它同时会把右侧栏展开（内容看不见就不算打开），所以这里不用再调
              // toggleExpanded —— 重复调用反而可能把刚展开的栏又收回去。
              try {
                ctx.sidebarRight.openTab(GIT_TAB_KIND)
                diag('open-tab:ok', GIT_TAB_KIND)
              } catch (error) {
                const detail = error !== null && error !== undefined && error.message ? error.message : String(error)
                diag('open-tab:failed', detail)
              }
            },
          }))
          : GitPanelToggle),
        'settings',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
