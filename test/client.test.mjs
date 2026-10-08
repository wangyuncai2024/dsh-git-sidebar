// dsh-git-sidebar —— 客户端半边 standalone 测试
// ============================================================================
// 客户端半边是**手写 bundle**（`window.__ModuleLoader__.load({id, factory})`），
// 不经过任何构建工具。这个测试用假的 window + 假的 React 把它完整跑一遍，
// 从而在**不启动 DSH、不安装浏览器依赖**的情况下证明：
//
//   1. bundle 格式正确：只调用一次 `load`，id 与包名一致，factory 可调用；
//   2. 只 require 平台种子（react）；请求别的说明依赖了构建产物，换版本会炸；
//   3. 只导出 apply / inject 两个契约字段，且 inject 声明了 slots；
//   4. 界面注册在三种时机下都不抛异常：slots 服务缺失 / 直接注册成功 /
//      插槽尚未声明需等待（含「真实错误不被吞掉」的区分）；
//   5. 两个组件都能渲染（含 props 缺失——将来 slot 契约变了也不能白屏）；
//   6. 点改动看 diff 能走到终态（真状态重渲染），不会永远停在「加载中…」——
//      这一条是回归测试：runOp 曾把结果变量声明在 try 块里，每次调用都以
//      ReferenceError 结束，宿主侧 git 明明执行成功了，调用方却永远拿不到返回值。
//   7. 切换工作区后，面板上的东西（命令结果栏 / diff / 分支列表 / 状态）都属于
//      新工作区：属于旧仓库的瞬时结果会被清掉，切走之后才回来的异步结果会被丢弃。
//   8. 「跟随会话工作目录」真的会跟随：假 store 用的是**真实形状**的 SessionListState
//      （当前会话 = `retainedBy.mainView > 0` 的那一行，没有 `state.current` 这个字段）。
//      回归的是：面板曾读一个不存在的字段，于是永远按宿主进程的 cwd 跑。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

// ── 假 React：只实现 bundle 真正用到的面 ─────────────────────────────────────

function makeFakeReact() {
  let hookIndex = 0
  const effects = []
  const nodes = []
  return {
    api: {
      createElement: (type, props, ...children) => {
        // 函数组件就地展开（复刻 reconciler 唯一必需的那一步）。面板被拆成多个
        // 展示组件之后，测试仍然拿到一棵扁平的宿主元素树 —— 不需要真的实现 reconciler，
        // 但**必须**有这一步，否则组件的内容在树里根本不存在。
        if (typeof type === 'function') return type(Object.assign({}, props, { children: children }))
        const node = { type, props: props === null || props === undefined ? {} : props, children }
        nodes.push(node)
        return node
      },
      useState: (initial) => {
        const index = hookIndex++
        return [typeof initial === 'function' ? initial() : initial, (value) => { effects.push([index, value]) }]
      },
      useReducer: (reducer, initial) => [
        typeof initial === 'function' ? initial() : initial,
        (action) => { effects.push(['reducer', action]) },
      ],
      useRef: (initial) => ({ current: initial }),
      useEffect: (callback) => { effects.push(['effect', callback]) },
      useCallback: (callback) => callback,
      useMemo: (factory) => factory(),
      Fragment: 'Fragment',
    },
    nodes,
    effects,
    /** 每个组件渲染前重置 hook 序号（直接调用函数组件，绕过 reconciler）。 */
    beginRender() { hookIndex = 0; effects.length = 0 },
    consumedHooks() { return hookIndex },
  }
}

/**
 * 有状态的假 React：真的保存 hook 值，并在 setState 之后重渲染组件。
 *
 * `makeFakeReact` 只记录 setState 的值、不重渲染，够验「渲染不白屏」；
 * 但验不了「点一下之后状态有没有走到终态」——而「点改动看 diff 永远停在
 * 加载中」正是这种形态：异常发生在 await 之后，界面停在中间态。
 */
function makeStatefulReact() {
  let component = null
  let props = null
  let hooks = []
  let cursor = 0
  let tree = null
  let dirty = false
  const pendingEffects = []

  const api = {
    createElement: (type, elementProps, ...children) => {
      // 与 makeFakeReact 同一套展开规则：函数组件就地调用，返回它画出的宿主元素。
      if (typeof type === 'function') return type(Object.assign({}, elementProps, { children: children }))
      return {
        type,
        props: elementProps === null || elementProps === undefined ? {} : elementProps,
        children,
      }
    },
    useState: (initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value
        if (Object.is(next, hooks[index])) return
        hooks[index] = next
        dirty = true
      }
      return [hooks[index], set]
    },
    // 面板的状态全部收在一个 reducer 里（见 lib/client.js 的 panelReducer）：
    // 假 React 必须真的存值、真的跑 reducer，才能验「切工作区把旧仓库的字段清掉」。
    useReducer: (reducer, initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const dispatch = (action) => {
        const next = reducer(hooks[index], action)
        if (Object.is(next, hooks[index])) return
        hooks[index] = next
        dirty = true
      }
      return [hooks[index], dispatch]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial }
      return hooks[index]
    },
    // deps 比较复刻 React：引用相等即不重跑，避免 effect 里的 setState 打转。
    useEffect: (callback, deps) => {
      const index = cursor++
      const previous = hooks[index]
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, at) => !Object.is(value, previous[at]))
      hooks[index] = deps
      if (changed) pendingEffects.push(callback)
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    Fragment: 'Fragment',
  }

  function renderOnce() {
    cursor = 0
    tree = component(props)
    for (const effect of pendingEffects.splice(0)) effect()
    return tree
  }

  return {
    api,
    mount(component_, props_) {
      component = component_
      props = props_
      hooks = []
      cursor = 0
      dirty = false
      pendingEffects.length = 0
      renderOnce()
    },
    /** 反复渲染直到没有新的 setState / effect（让 await 链跑完），返回最终树。 */
    async settle(rounds = 12) {
      for (let round = 0; round < rounds; round += 1) {
        dirty = false
        renderOnce()
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        if (!dirty && pendingEffects.length === 0) return tree
      }
      return tree
    },
  }
}

/** 深度展开假 React 的元素树（children 里可能嵌数组）。 */
function flattenTree(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) flattenTree(child, out)
    return out
  }
  out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) flattenTree(child, out)
  return out
}

/** 取一棵假 React 元素树里的所有 button 元素（按深度优先顺序）。 */
function collectButtons(tree) {
  return flattenTree(tree).filter((node) => node.type === 'button')
}

/** 取一个元素子树的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

// ── 假 window：只提供 bundle 真正用到的面 ────────────────────────────────────
function makeFakeWindow(options = {}) {
  const registrations = []
  const storage = new Map()
  const listeners = new Map()
  const calls = { fetch: [], diag: [] }
  /** 面板注册的定时器（假时钟不会自己走，只记录「注册了没有 / 间隔多少 / 有没有被清」）。 */
  const timers = []
  if (options.prefillStorage !== undefined) {
    for (const [key, value] of Object.entries(options.prefillStorage)) storage.set(key, value)
  }
  const win = {
    __ModuleLoader__: { load: (registration) => { registrations.push(registration) } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    },
    addEventListener: (type, listener) => { listeners.set(type, listener) },
    removeEventListener: (type) => { listeners.delete(type) },
    setInterval: (listener, ms) => {
      const timer = { listener, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (timer) => {
      if (timer !== null && timer !== undefined) timer.cleared = true
    },
    dispatchEvent: () => true,
    confirm: () => true,
  }
  const stateResponse = options.stateResponse ?? {
    ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [], notice: '不是仓库',
  }
  const opResponse = options.opResponse ?? stateResponse
  /**
   * 状态响应可以在**每次请求时**求值（options.stateResponse 传函数），并且每次返回新对象 ——
   * 真实的 `fetch(...).json()` 就是这么干的，而 `state.snapshot` 的对象身份正是「依赖它的
   * effect 会不会重跑」的根据（例如「状态一变就重列分支」）。传静态对象的老用例照旧。
   */
  const stateFor = () => (typeof options.stateResponse === 'function' ? options.stateResponse() : stateResponse)
  /**
   * 每个 op 可以给不同的响应（options.opResponses，按 op 名索引）；没配的 op 仍然
   * 落在 opResponse 上 —— 老用例因此一行都不用改。
   */
  const opResponseFor = (init) => {
    if (options.opResponses === undefined) return opResponse
    try {
      const parsed = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
      const found = options.opResponses[parsed.op]
      return found !== undefined ? found : opResponse
    } catch {
      return opResponse
    }
  }
  // 网络加速配置：默认是「什么都没开」的干净状态。
  const netResponse = options.netResponse ?? {
    ok: true, mirrorEnabled: false, mirror: 'https://gh-proxy.com/',
    proxy: '', hasProxy: false,
    candidates: [
      { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
      { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
      { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
    ],
  }
  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    if (String(url).includes('/git-sidebar/diag')) {
      calls.diag.push(JSON.parse(init.body))
      return { status: 200, json: async () => ({ ok: true }) }
    }
    if (String(url).includes('/git-sidebar/net')) {
      // 面板一挂载就会读这份配置；点「检测网络」时走 probe=1 那条分支。
      const body = options.probeResults !== undefined && String(url).includes('probe=1')
        ? { ok: true, results: options.probeResults }
        : netResponse
      return { status: 200, json: async () => body }
    }
    const body = String(url).includes('/git-sidebar/op') ? opResponseFor(init) : stateFor()
    return { status: 200, json: async () => body }
  }
  return { win, registrations, storage, listeners, timers, calls, fetchStub, netResponse }
}

/**
 * 在隔离的假浏览器环境里求值 bundle，并返回 factory 产物。
 * 用 `new Function` 而不是 import：bundle 会写 `window` 全局，且必须验证
 * 它是普通脚本（没有 import/export、没有构建产物语法）。
 */
function evaluateBundle(harness, reactApi) {
  const { win, fetchStub } = harness
  const sandbox = {
    window: win,
    fetch: fetchStub,
    URL, JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp, Error, Promise,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, console,
    // 目录选择小窗口用它取消在飞的列出（浏览器里本来就是全局对象）。
    AbortController, AbortSignal,
    Event: class Event { constructor(type) { this.type = type } },
  }
  sandbox.globalThis = sandbox
  const keys = Object.keys(sandbox)
  const runner = new Function('window', 'fetch', 'Event', ...keys.filter((k) => !['window', 'fetch', 'Event'].includes(k)), CLIENT_SOURCE)
  runner(win, fetchStub, sandbox.Event, ...keys.filter((k) => !['window', 'fetch', 'Event'].includes(k)).map((k) => sandbox[k]))
  assert.equal(harness.registrations.length, 1, 'bundle 必须恰好调用一次 __ModuleLoader__.load')
  const registration = harness.registrations[0]
  assert.equal(registration.id, 'dsh-git-sidebar', 'bundle 注册的 id 必须是包名')
  assert.equal(typeof registration.factory, 'function', 'factory 必须是函数')
  const requested = []
  const exports = registration.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return reactApi
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  })
  return { registration, exports, requested }
}

// ── 1. bundle 格式与依赖面 ──────────────────────────────────────────────────

test('client standalone：bundle 只 require 平台种子 react，不动其它模块', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports, requested } = evaluateBundle(harness, react.api)
  assert.deepEqual(requested, ['react'], '客户端半边只允许 require react（平台种子）；其它模块名换版本就没了')
  assert.equal(typeof exports.apply, 'function', '必须导出 apply')
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace'],
    'slots 是界面依赖；sidebarRightTabs 是标签类型注册表（不声明就读不到 —— cordis 懒注入）；'
    + 'sidebarRight 用来 openTab；uiWorkspace 是目录选择小窗口的目录服务')
})

test('client standalone：bundle 是普通脚本，没有 ESM / JSX / TS 语法', () => {
  assert.doesNotMatch(CLIENT_SOURCE, /^\s*(import|export)\s/m, 'bundle 不能有 ESM 语句')
  assert.doesNotMatch(CLIENT_SOURCE, /<\/?[A-Z][A-Za-z]*[\s/>]/, 'bundle 不能有 JSX')
  assert.doesNotMatch(CLIENT_SOURCE, /:\s*(string|number|boolean|any)\b/, 'bundle 不能有 TS 类型标注')
})

// ── 1b. 强调色（--dgs-accent*）的取值链 ────────────────────────────────────
//
// 这一组盯的是**一个我这次真踩过的坑**：强调色 trio 有三个档位，用途不同、
// 光学要求也不同，混用会在某一条分支上悄悄跌破对比度阈值：
//   · --dgs-accent       装饰：短杠 / 顶条 / 描边 / 定位条。它们是**图形**，阈 3:1。
//                        宿主的 state-business-primary 生色（浅 #4176e6）压白底 4.23:1，够用。
//   · --dgs-accent-text  文字：胶囊文字 / 当前跟踪徽章 / hot 按钮。**正文**，阈 4.5:1。
//                        生色压自己的 8% 底只有 3.84:1 —— 不够，所以必须走压过前景色的那一档。
//   · --dgs-accent-tint  极淡底色：胶囊底 / 展开行 / 选中行。百分比被行内小符号
//                        （○ / ▼，阈 3:1）和成功色文字（阈 4.5:1）两头夹住。
//
// 最容易被忽略的是**兜底链**：`color-mix` 不支持时退回哪一档。退回「生」的强调蓝
// 就等于把上面那条 3.84:1 的坑重新踩回来（HEAD 在这一处用 brand-primary，那样才是对的）。
test('client standalone：强调色的文字档不能退回「生」的强调蓝（兜底链也要过阈值）', () => {
  // --dgs-accent-text 的定义（color-mix 支）必须把强调色朝 label-primary 压，
  // 而不是直接用强调色。
  const textDef = /--dgs-accent-text:color-mix\(in srgb,var\(--dsw-alias-state-business-primary[^)]*\)\s*\d+%,var\(--dsw-alias-label-primary/
  assert.match(CLIENT_SOURCE, textDef,
    '--dgs-accent-text 必须是「强调色 × label-primary」的 color-mix：'
    + '直接用生强调色当 11px 正文，压自己那层浅底只有 3.84:1')

  // @supports 兜底支：--dgs-accent-text 要退回随主题翻转的前景色档（brand-primary），
  // 不能退回 state-business-primary 生色。
  const supportsBlock = CLIENT_SOURCE.match(/@supports not \(color:color-mix\([^)]*\)\)\{[^']*--dgs-accent-text:([^;}]+)/)
  assert.ok(supportsBlock !== null, '应有 @supports not (color:color-mix(...)) 兜底支')
  assert.match(supportsBlock[1], /--dsw-alias-brand-primary/,
    '兜底支的 --dgs-accent-text 必须退回 brand-primary（随主题翻转），'
    + '退回 state-business-primary 生色会让白底只剩 4.23:1、胶囊底 3.84:1，都过不了正文阈值')

  // 抖一遍全文件：凡是 --dgs-accent-text 的**内联兜底**（closing fallback）都不能落在
  // 生强调色上。合法形态只允许 brand-primary / label-primary。
  const badFallbacks = [...CLIENT_SOURCE.matchAll(/var\(--dgs-accent-text,\s*(?:var\()?(--[\w-]+)/g)]
    .map((m) => m[1])
    .filter((name) => name !== '--dsw-alias-brand-primary' && name !== '--dsw-alias-label-primary')
  assert.deepEqual(badFallbacks, [],
    '--dgs-accent-text 的兜底只能是 brand-primary / label-primary（随主题翻转的前景色档）：'
    + JSON.stringify(badFallbacks))

  // --dgs-accent（装饰档）反过来不该被「压」——它是给图形用的生色，
  // 压过就失去了描边/顶条该有的分量。
  assert.match(CLIENT_SOURCE, /--dgs-accent:var\(--dsw-alias-state-business-primary/,
    '--dgs-accent 是装饰档，直接用宿主的交互强调色')
})

test('client standalone：兜底色阶的兜底百分比要和定义一致（别一边 8% 一边 16%）', () => {
  // --dgs-accent-tint 当前定义在 8%（见 S 里的注释：12% 会把行内成功色压到 4.49:1）。
  const def = CLIENT_SOURCE.match(/--dgs-accent-tint:color-mix\([^;]*?(\d+)%,transparent\)/)
  assert.ok(def !== null, '应有 --dgs-accent-tint 的 color-mix 定义')
  const percent = Number(def[1])
  assert.ok(percent >= 6 && percent <= 10,
    '--dgs-accent-tint 的百分比必须落在 6–10%：太高会把行内小符号/成功色压到阈值以下，'
    + '太低则「选中了」看不出来。当前 ' + percent + '%')

  // 只看**替 --dgs-accent-tint 兜底**的那些值 —— 它们必须与定义同百分比。
  // 不能全文扫 rgba(37,99,235,...)：diff 区块里的那几条（hunk 底 .08 + color-mix 10%）
  // 与闪烁动画的 .35 属于**别的调色板**（diff 行底 / 一次性脉冲），早在 HEAD 就存在，
  // 与强调底色阶无关；把它们一起断言只会制造一条假失败。
  const fallbacks = [...CLIENT_SOURCE.matchAll(/var\(--dgs-accent-tint,\s*rgba\(37,\s*99,\s*235,\s*\.(\d+)\)\)/g)]
    .map((m) => Number('0.' + m[1]))
  assert.ok(fallbacks.length >= 3,
    '应有若干处 --dgs-accent-tint 的 rgba 兜底（胶囊底 / 焦点环 / 展开行 / 选中行），实际 ' + fallbacks.length)
  for (const value of fallbacks) {
    assert.ok(Math.abs(value - percent / 100) < 0.001,
      'var(--dgs-accent-tint, rgba(37,99,235,' + value + ')) 的兜底与定义的 ' + percent + '% 不一致：'
      + '兜底值虽然不会在支持 color-mix 的引擎里生效，但两处对不上会误导后来改它的人')
  }

  // @supports 兜底支里的 --dgs-accent-tint 也要同值。
  const supportsTint = CLIENT_SOURCE.match(/@supports not \(color:color-mix\([^)]*\)\)\{[^']*--dgs-accent-tint:rgba\(37,99,235,\.(\d+)\)/)
  assert.ok(supportsTint !== null, '@supports 支里应有 --dgs-accent-tint 的兜底')
  assert.ok(Math.abs(Number('0.' + supportsTint[1]) - percent / 100) < 0.001,
    '@supports 支里的 --dgs-accent-tint 兜底与定义不一致：' + supportsTint[1])
})

// ── 2. 界面注册：三种时机 ──────────────────────────────────────────────────

/** 造一个 mock slots 服务，记录 register 调用与顺序。 */
function makeSlots(options = {}) {
  const registered = []
  const injected = []
  const declared = new Set()
  // declareLater 语义：插槽在 apply 时尚未声明，但 inject 订阅后立刻被声明，
  // 于是回调里的第二次 register 成功——正是真实 ui-renderer 的 reconcile 行为。
  if (options.declareLater !== true) {
    // 本插件往这三个插槽注册：标签正文 / 标签标题（都是 keyed，key = 类型 id）
    // 与设置开关行（list）。
    declared.add('sidebar.right.pane.tab')
    declared.add('sidebar.right.pane.tab.title')
    declared.add('settings.general.item')
  }
  const slots = {
    register(options_, component) {
      if (options.registerAlwaysFails === true) {
        throw new Error(`single slot "${options_.name}" already has a registration at priority 0 — register at a different priority to shadow it`)
      }
      if (!declared.has(options_.name)) {
        throw new Error(`slot "${options_.name}" is not declared (a parent entry's children table must declare it)`)
      }
      if (options.duplicate === true) {
        throw new Error(`single slot "${options_.name}" already has a registration at priority 0 — register at a different priority to shadow it`)
      }
      registered.push({ options: options_, component })
      return () => {
        const index = registered.findIndex((entry) => entry.options === options_)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    inject(key, callback) {
      injected.push({ key, callback })
      // 真实实现会在订阅后立刻 reconcile 一次：这里复刻「插槽稍后声明」。
      if (options.declareLater === true) {
        declared.add(key)
        const dispose = callback()
        return dispose
      }
      return () => {}
    },
  }
  return { slots, registered, injected }
}

/**
 * 造一个 mock 标签类型注册表（ctx.sidebarRightTabs）。
 *
 * 真实契约（见 @deepseek-ai/dsh-client-ui-sidebar-right 的 tab-registry.d.ts）：
 *   register(definition) 返回 disposer；id 已被占用、或 kind 与同一 band 的注册冲突时抛异常。
 * 这里复刻这两条**硬约束** —— 它们正是「插件注册错了要能立刻发现」的地方。
 */
function makeTabRegistry(options = {}) {
  const posted = []
  const ids = new Set()
  const kinds = new Set()
  return {
    posted,
    register(definition) {
      if (options.alwaysFails === true) throw new Error('tab kind "git" is already registered in the "extension" band')
      if (ids.has(definition.id)) throw new Error(`tab type id "${definition.id}" is already in use`)
      if (kinds.has(definition.kind)) throw new Error(`tab kind "${definition.kind}" is already registered at this band`)
      ids.add(definition.id)
      kinds.add(definition.kind)
      posted.push(definition)
      return () => { ids.delete(definition.id); kinds.delete(definition.kind) }
    },
  }
}

/** 造一个 mock 右侧栏控制器（ctx.sidebarRight）。 */
function makeSidebarRight() {
  const opened = []
  let expanded = false
  return {
    opened,
    isExpanded: () => expanded,
    openTab(kind) {
      if (typeof kind !== 'string' || kind.length === 0) throw new Error('openTab: kind 不能为空')
      opened.push(kind)
      expanded = true
    },
  }
}

test('client standalone：注册三件界面 —— 标签正文、标签标题、设置开关行', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots, registered, injected } = makeSlots()
  assert.doesNotThrow(() => exports.apply({ slots }))
  assert.deepEqual(
    registered.map((entry) => entry.options.name),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.general.item'],
  )
  // 正文与标题是 keyed 插槽：两者**必须用同一个 key**（类型定义的 id），
  // 否则正文挂在 A 下面、标题挂在 B 下面，会话里就会各显示各的。
  const body = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const title = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
  assert.equal(body.options.key, title.options.key, '正文与标题的 key 必须是同一个（类型 id）')
  assert.equal(body.options.key, 'dsh-git-sidebar', 'key 用包名，与类型定义的 id 一致')
  assert.equal(injected.length, 0, '直接注册成功就不该走 inject 等待')
  for (const entry of registered) {
    assert.equal(typeof entry.component, 'function', `${entry.options.name} 的组件必须是函数`)
  }
})

test('client standalone：标签类型注册进 registry，kind / id / priority / guide 都对', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  const tabs = makeTabRegistry()
  exports.apply({ slots, sidebarRightTabs: tabs })
  assert.equal(tabs.posted.length, 1, '必须恰好注册一个标签类型')
  const def = tabs.posted[0]
  assert.equal(def.id, 'dsh-git-sidebar', 'id 用包名（要与两个 keyed 插槽的 key 一致）')
  assert.equal(def.kind, 'git', 'kind 是 openTab 用的判别子')
  assert.equal(def.priority, 'extension', '第三方插件用 extension 档（也是最高档）')
  assert.equal(typeof def.title, 'function', 'title 必须是函数（thunk，每次投影重读）')
  assert.equal(def.title(), 'Git')
  // 指南页入口：右侧栏空的指南页里要能看到「Git 面板」这一项，
  // 它就是用户说的「与工作区文件 / 新建终端 / 浏览器并列」的那一项。
  assert.equal(def.guide.length, 1, '必须有一个指南页入口')
  const entry = def.guide[0]
  assert.equal(typeof entry.order, 'number', 'order 决定它在指南页里的位置')
  assert.ok(entry.order > 30, '要排在官方那几项（files 10 / terminal 20 / browser 30）之后')
  assert.equal(entry.title(), 'Git 面板')
  assert.equal(typeof entry.description, 'function', 'description 也是 thunk')
  // 页面类型不声明地址 globs（那是资源 viewer 才要的东西）。
  assert.equal(def.patterns, undefined, '页面类型不该声明 patterns')
})

test('client standalone：拿不到标签注册表时，正文与标题仍然注册（不整块消失）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots, registered } = makeSlots()
  // 宿主没有提供 sidebarRightTabs（旧版本，或服务还没就绪）。
  assert.doesNotThrow(() => exports.apply({ slots }))
  assert.deepEqual(
    registered.map((entry) => entry.options.name),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.general.item'],
    '类型注册失败不该连带干掉正文/标题/设置行 —— 故障要「少一块」而不是「全没」',
  )
})

test('client standalone：标签类型注册失败会把真实原因回报宿主', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  exports.apply({ slots, sidebarRightTabs: makeTabRegistry({ alwaysFails: true }) })
  const row = harness.calls.diag.find((entry) => entry.stage === 'tab-type:failed')
  assert.ok(row !== undefined, '类型注册失败必须回报诊断，不能静默')
  assert.match(row.detail, /already registered/, '诊断里要带上宿主给的真实原因')
})

test('client standalone：slots 服务缺失时静默降级，不抛异常', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply({ slots: undefined }))
  assert.doesNotThrow(() => exports.apply({ slots: null }))
})

test('client standalone：插槽尚未声明时退回 inject 等待并成功注册', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots, registered, injected } = makeSlots({ notDeclared: true, declareLater: true })
  assert.doesNotThrow(() => exports.apply({ slots }))
  assert.deepEqual(
    injected.map((entry) => entry.key),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.general.item'],
  )
  assert.deepEqual(
    registered.map((entry) => entry.options.name),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.general.item'],
  )
})

test('client standalone：注册失败会把原因回报宿主（不静默）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots({ duplicate: true })
  exports.apply({ slots })
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.ok(stages.includes('tab-body:direct-failed'), '直接注册失败必须回报诊断')
  assert.ok(stages.includes('settings:direct-failed'), '直接注册失败必须回报诊断')
  const failed = harness.calls.diag.find((row) => row.stage === 'tab-body:direct-failed')
  assert.match(failed.detail, /already has a registration/, '诊断里要带上真实原因')
})

test('client standalone：声明已到但注册仍失败时，必须报出真实原因（不谎报成功）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  // declareLater：插槽稍后声明，inject 回调会真的跑；registerAlwaysFails：注册永远失败。
  const { slots } = makeSlots({ declareLater: true, registerAlwaysFails: true })
  assert.doesNotThrow(() => exports.apply({ slots }))
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.equal(stages.includes('declared-later'), false, '注册没成功就不能报 declared-later')
  assert.ok(stages.includes('tab-body:register-failed-after-declaration'), '必须区分出「声明已到但注册失败」')
  const failed = harness.calls.diag.find((row) => row.stage === 'tab-body:register-failed-after-declaration')
  assert.match(failed.detail, /already has a registration/, '诊断里要带上真实原因')
})

test('client standalone：slots.inject 本身抛异常时也不影响 apply', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const slots = {
    register() { throw new Error('slot "sidebar.right.pane.tab" is not declared (a parent entry\'s children table must declare it)') },
    inject() { throw new Error('slots 服务正在卸载') },
  }
  assert.doesNotThrow(() => exports.apply({ slots }))
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.ok(stages.includes('tab-body:inject-failed'), 'inject 失败也要回报诊断')
})

test('client standalone：重复 apply 不会抛异常（HMR / 重启场景）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  assert.doesNotThrow(() => { exports.apply({ slots }); exports.apply({ slots }) })
})

test('client standalone：「打开」按钮走 ctx.sidebarRight.openTab(kind)', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  const sidebarRight = makeSidebarRight()
  exports.apply({ slots, sidebarRight })
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  // onOpen 由 apply 在拿得到控制器时才注入，所以这里不传（等价于真实渲染）。
  const tree = renderComponent(harness, react, toggle, {})
  const open = collectButtons(tree).find((b) => textOf(b) === '打开')
  assert.ok(open !== undefined, '设置行里应当有「打开」按钮')
  open.props.onClick()
  assert.deepEqual(sidebarRight.opened, ['git'], '点「打开」要按 kind 开一个 Git 标签')
  const stage = harness.calls.diag.find((entry) => entry.stage === 'open-tab:ok')
  assert.ok(stage !== undefined, '打开成功要留诊断痕迹')
})

test('client standalone：openTab 抛异常时留诊断、不炸设置页', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots, sidebarRight: { openTab() { throw new Error('sidebarRight: no tab type is registered as "git"') } } })
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  const tree = renderComponent(harness, react, toggle, {})
  const open = collectButtons(tree).find((b) => textOf(b) === '打开')
  assert.ok(open !== undefined)
  assert.doesNotThrow(() => open.props.onClick(), '宿主报错不该把设置页带崩')
  const row = harness.calls.diag.find((entry) => entry.stage === 'open-tab:failed')
  assert.ok(row !== undefined, '要留诊断痕迹')
  assert.match(row.detail, /no tab type is registered/, '诊断要带真实原因')
})

test('client standalone：没有 sidebarRight 服务时不画「打开」按钮（不画点了没反应的控件）', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  const tree = renderComponent(harness, react, toggle, {})
  const buttons = collectButtons(tree)
  assert.equal(buttons.some((b) => textOf(b) === '打开'), false, '拿不到控制器就不该出现「打开」')
})

// ── 3. 组件渲染：props 缺失 / 完整都不能白屏 ────────────────────────────────

function renderComponent(harness, react, component, props) {
  react.beginRender()
  return component(props)
}

test('client standalone：GitPanel 在 props 缺失时也能渲染（slot 契约变化不白屏）', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  assert.doesNotThrow(() => renderComponent(harness, react, panel, undefined))
  assert.doesNotThrow(() => renderComponent(harness, react, panel, {}))
  assert.doesNotThrow(() => renderComponent(harness, react, panel, { useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })) }))
})

test('client standalone：GitPanelToggle 能渲染且读得到开关状态', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
  // 默认开启：localStorage 没有值时面板应显示为开。
  harness.storage.delete('dsh-git-sidebar-enabled')
  renderComponent(harness, react, toggle, undefined)
  // 关掉之后仍然能渲染。
  harness.storage.set('dsh-git-sidebar-enabled', '0')
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
})

test('client standalone：加载时清理旧版浮动帮助窗口遗留的 localStorage 键', () => {
  const harness = makeFakeWindow({
    prefillStorage: { 'dsh-git-sidebar-help-pos': '{x:1}', 'dsh-git-sidebar-help-size': '{w:1}' },
  })
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  exports.apply({ slots })
  assert.equal(harness.storage.has('dsh-git-sidebar-help-pos'), false, '旧位置键应被删除')
  assert.equal(harness.storage.has('dsh-git-sidebar-help-size'), false, '旧尺寸键应被删除')
})

test('client standalone：localStorage 不可用（隐私模式）也不崩', () => {
  const harness = makeFakeWindow()
  harness.win.localStorage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  assert.doesNotThrow(() => exports.apply({ slots }))
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
})

// ── 4. 回归：点改动看 diff 必须走到终态 ─────────────────────────────────────

test('client standalone：点改动看 diff 不会停在「加载中…」（runOp 必须把结果返回给调用方）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: { ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n', state: repoState },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component

  react.mount(panel, {
    useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })),
  })
  const initial = await react.settle()

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined, '改动清单里应出现可点击的条目（先要拿到仓库状态）')

  // 修复前的形态：runOp 里 `const data` 声明在 try 块内、却用 `return data` 在
  // try 之外返回，每次调用都以 ReferenceError 结束 —— 于是这个 onClick 的
  // promise 直接 reject，await 之后的 setDiffText 永远不执行，界面停在中间态。
  await assert.doesNotReject(
    () => clickable.props.onClick(),
    '点 diff 的处理函数不能以异常结束，否则 diff 区永远停在「加载中…」',
  )

  const finalTree = await react.settle()
  const pres = flattenTree(finalTree).filter((node) => node.type === 'pre').map(textOf)
  assert.ok(!pres.includes('加载中…'), 'diff 区不能停在「加载中…」')
  assert.ok(pres.some((text) => text.includes('+two')), `diff 区应显示真实 diff，实际拿到：${JSON.stringify(pres)}`)
})

test('client standalone：runOp 失败时调用方拿到 ok:false（而不是 undefined 导致「未知错误」）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  // 让 /git-sidebar/op 直接抛（网络层失败），走 runOp 的 catch 分支。
  const failing = harness.fetchStub
  harness.fetchStub = async (url, init) => {
    if (String(url).includes('/git-sidebar/op')) throw new Error('HTTP 500')
    return failing(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  react.mount(panel, {
    useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })),
  })
  const initial = await react.settle()
  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined)

  await assert.doesNotReject(() => clickable.props.onClick())
  const finalTree = await react.settle()
  const pres = flattenTree(finalTree).filter((node) => node.type === 'pre').map(textOf)
  assert.ok(
    pres.some((text) => text.includes('查看 diff 失败：HTTP 500')),
    `失败原因要原样回报，而不是「未知错误」：${JSON.stringify(pres)}`,
  )
})

// ── 4b. 回归：展开的 diff 必须内联在改动清单里 ──────────────────────────────
//
// 现场：点改动条目后，diff 原先渲染在清单**外面**，而面板正文是一个可滚动的 flex 列
// —— 展开后 diff 既把清单挤成一条缝（`overflow:auto` 的 flex 子项自动最小尺寸为 0，
// 默认的 flex-shrink:1 会压缩它），又常常落到可视区之外。用户看到的现象就是
// 「弹出来的改动信息框把改动文件展示框盖住了」。
//
// 修法：diff 内联在被点的那一行下面，与文件行共用清单这一个滚动区；清单本身
// flex:0 0 auto（自带滚动，永不被压），展开期间把清单取景框放高。

test('client standalone：展开的 diff 内联在改动清单里，不挤掉也不盖住清单', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [
      { code: ' M', path: 'a.txt', staged: false },
      { code: ' M', path: 'b.txt', staged: false },
    ],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n', state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const initial = await react.settle()
  const list = flattenTree(initial).find((node) => node.props.key === 'changes')
  assert.ok(list !== undefined, '应渲染出改动清单容器')
  // 这一条钉的是根因：清单自带滚动，绝不能被 flex 压缩（否则就是「被盖住」）。
  assert.equal(list.props.style.flex, '0 0 auto', '改动清单不能被 flex 压扁')
  assert.equal(list.props.style.maxHeight, '148px', '没展开 diff 时清单保持紧凑高度')

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined, '改动清单里应出现可点击的条目')
  await clickable.props.onClick()
  const opened = await react.settle()

  const openedList = flattenTree(opened).find((node) => node.props.key === 'changes')
  assert.ok(openedList !== undefined, '展开后清单容器仍在')
  const inline = flattenTree(openedList).find((node) =>
    node.type === 'pre' && textOf(node).includes('+two'))
  assert.ok(
    inline !== undefined,
    '展开的 diff 必须是改动清单的子树：放在清单外面会被正文滚动挤走，表现就是「盖住了清单」',
  )
  assert.equal(openedList.props.style.maxHeight, '360px', '展开 diff 时清单取景框要放高，否则 diff 只露一两行')
  assert.ok(textOf(openedList).includes('b.txt'), '展开一个文件的 diff 不能顶掉其它文件行')

  // 展开中的那一行要有标记，用户才知道下面那块 diff 是谁的。
  const active = flattenTree(openedList).find((node) =>
    typeof node.props.className === 'string' && node.props.className.includes('dgs-rowitem-active'))
  assert.ok(active !== undefined, '展开中的那一行要高亮')
  assert.ok(textOf(active).includes('a.txt'), '高亮的应该是被点开的那个文件')
})

// ── 5. 回归：切换工作区后，面板上的东西必须跟着切 ───────────────────────────
//
// 曾出现的问题：换工作区（切会话 / 手动切目录）后只有 snapshot 被替换，命令结果栏
// 还挂着旧仓库上一次 git 操作的输出。根因是有一批状态属于「某个具体仓库」却没有
// 任何人在切换时清理；同时迟到的异步结果也没有归属校验，慢操作（拉取/推送/克隆的
// 宿主超时是 10 分钟）回来时会直接盖到新工作区上。

/** 让 `/git-sidebar/state` 按 `?dir=` 返回不同仓库，用来验证面板真的换了工作区。 */
function makeDirAwareFetch(harness, byDir) {
  const base = harness.fetchStub
  return async (url, init = {}) => {
    const text = String(url)
    if (text.includes('/git-sidebar/state')) {
      const match = /[?&]dir=([^&]*)/.exec(text)
      const dir = match === null ? '' : decodeURIComponent(match[1])
      if (Object.hasOwn(byDir, dir)) {
        harness.calls.fetch.push({ url, init })
        return { status: 200, json: async () => byDir[dir] }
      }
    }
    return base(url, init)
  }
}

/**
 * 造一份**真实形状**的 SessionListState（宿主的 `@deepseek-ai/dsh-api-session-controller`
 * 契约）：字段是 ids / byId / phase / subagentsByParent / jobsBySession。
 *
 * 关键：「当前会话」**不是** `state.current` —— 那个字段不存在。宿主自己的
 * publishMain 与 ui-workspace 都是认列表里 `retainedBy.mainView > 0` 的那一行，
 * 这里刻意不提供 `current`：谁再照着不存在的字段写，测试立刻红。
 *
 * 缺省把第一行当作「主视图持有的会话」，要造别的形态（例如没有当前会话）就显式传
 * `retainedBy`。
 */
function sessionStore(rows) {
  const ids = Object.keys(rows)
  const byId = {}
  ids.forEach((id, index) => {
    byId[id] = {
      id,
      displayTitle: id,
      running: false,
      blank: false,
      updatedAt: 0,
      retainedBy: index === 0 ? { mainView: 1 } : {},
      ...rows[id],
    }
  })
  return { ids, byId, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }
}

/** 把「当前会话」换成另一行 —— 等价于用户在会话列表里点了另一个会话。 */
function selectSession(store, id) {
  for (const row of Object.values(store.byId)) {
    row.retainedBy = { mainView: row.id === id ? 1 : 0 }
  }
  return store
}

/**
 * 在给定会话 store 上挂载面板组件（`store` 可变，用来模拟切换工作区）。
 *
 * 目录选择服务有两条注入路径，测试都要能走：
 *   · `options.uiWorkspace` —— **真实路径**：cordis 按 inject 把服务放在 ctx 上，
 *     apply 时从 `ctx.uiWorkspace` 取（就是运行中的宿主那条路）。
 *   · `options.getPicker`   —— slot owner 直接塞给组件（测试替身/降级用）。
 * 两个都不传 = 服务缺失，面板应当退化成「只能手输绝对路径」。
 */
function mountPanel(exports, react, store, options = {}) {
  const { slots, registered } = makeSlots()
  exports.apply({ slots, uiWorkspace: options.uiWorkspace, sessionId: options.sessionId })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  react.mount(panel, {
    // 真实契约里 sessionId 是 session scope 的标准 props（sidebar.right.pane.tab 就是
    // session scope），所以默认按本用例的会话传；显式传 null 可以验「拿不到时的兜底」。
    sessionId: options.sessionId === undefined ? 's1' : options.sessionId,
    useSessions: (selector) => selector(store),
    getPicker: options.getPicker,
  })
}

/** 命令结果栏（面板里所有 <pre> 的文本）。 */
function outputBars(tree) {
  return flattenTree(tree).filter((node) => node.type === 'pre').map(textOf)
}

/** 找一个按钮元素（按可见文本）。 */
function findButton(tree, label) {
  return flattenTree(tree).find((node) => node.type === 'button' && textOf(node) === label)
}

/**
 * 展开分支管理区块（新版式下它默认收起，区块头是可点的 role=button）。
 * 返回展开后的树。前置条件：当前是仓库且树已 settle。
 */
async function openBranchManager(tree, react) {
  const head = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && node.props.className === 'dgs-fold-head'
    && typeof textOf(node) === 'string' && textOf(node).startsWith('本地分支'))
  assert.ok(head !== undefined, '应有「本地分支」折叠区块头')
  await head.props.onClick()
  return react.settle()
}

/**
 * 展开远程配置区块（默认收起；展开状态由 showRemotes 控制）。
 * 返回展开后的树。注意：正在编辑/出错/有重复远程时会强制展开，此时也安全。
 */
async function openRemotesSection(tree, react) {
  const head = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && node.props.className === 'dgs-fold-head'
    && typeof textOf(node) === 'string' && textOf(node).startsWith('远程仓库'))
  assert.ok(head !== undefined, '应有「远程仓库」折叠区块头')
  await head.props.onClick()
  return react.settle()
}

/** 按包裹它的 label 文本找一个勾选框（面板里有 amend / 变基 / 浅克隆几个）。 */
function findCheckbox(tree, labelText) {
  const label = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'label'
    && textOf(node).includes(labelText))
  if (label === undefined) return undefined
  return (label.children ?? []).find((child) =>
    child !== null && typeof child === 'object' && child.type === 'input')
}

const WS_A = {
  ok: true, dir: '/tmp/ws-a', isRepo: true, branch: 'main', upstream: null,
  ahead: 0, behind: 0, changes: [{ code: ' M', path: 'a.txt', staged: false }],
  log: [], remotes: [],
}
const WS_B = {
  ok: true, dir: '/tmp/ws-b', isRepo: true, branch: 'dev', upstream: null,
  ahead: 0, behind: 0, changes: [], log: [], remotes: [],
}

test('client standalone：切换工作区后命令结果栏不再挂着上一个工作区的输出', async () => {
  const opResult = {
    ok: true, command: 'git add -A', exitCode: 0, stdout: '', stderr: '', message: null,
    hint: null, clonedDir: null, branches: null, diff: null, state: WS_A,
  }
  const harness = makeFakeWindow({ stateResponse: WS_A, opResponse: opResult })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  assert.ok(textOf(first).includes('/tmp/ws-a'), '前置条件：面板要先加载到工作区 A')

  const addAll = findButton(first, '全部暂存')
  assert.ok(addAll !== undefined, 'A 是仓库，「全部暂存」按钮应该出现')
  await addAll.props.onClick()
  const afterOp = await react.settle()
  assert.ok(
    outputBars(afterOp).some((text) => text.includes('git add -A')),
    `前置条件：A 的命令结果栏里要有刚跑完的输出，实际：${JSON.stringify(outputBars(afterOp))}`,
  )

  // 换工作区：等价于用户在界面上切到另一个会话（当前会话的 cwd 变了）。
  store.byId.s1.cwd = '/tmp/ws-b'
  const afterSwitch = await react.settle()

  assert.ok(textOf(afterSwitch).includes('/tmp/ws-b'), '面板本身要跟着切到工作区 B')
  assert.ok(textOf(afterSwitch).includes('dev'), '分支要显示 B 的分支')
  assert.ok(
    !outputBars(afterSwitch).some((text) => text.includes('git add -A')),
    `切换工作区后命令结果栏不能还挂着 A 的输出，实际：${JSON.stringify(outputBars(afterSwitch))}`,
  )
})

test('client standalone：切到另一个会话后，面板跟着换到那个会话的工作目录', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  // 两个会话、两个工作目录：这才是「跟着会话切换工作目录」的真实形态
  // （旧测试只动同一个会话的 cwd，恰好绕过了「认哪一行是当前会话」这一步）。
  const store = sessionStore({ 's-a': { cwd: '/tmp/ws-a' }, 's-b': { cwd: '/tmp/ws-b' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  assert.ok(textOf(first).includes('/tmp/ws-a'), '前置条件：面板先跟着会话 A 的工作目录')
  assert.ok(textOf(first).includes('main'), '前置条件：显示的是 A 的分支')

  selectSession(store, 's-b')
  const after = await react.settle()

  assert.ok(textOf(after).includes('/tmp/ws-b'), `切会话后面板要落到新会话的工作目录，实际：${textOf(after).slice(0, 300)}`)
  assert.ok(textOf(after).includes('dev'), '分支要变成 B 的分支')
  assert.ok(!textOf(after).includes('/tmp/ws-a'), '面板不能再显示旧会话的工作目录')
})

test('client standalone：没有当前会话时退回宿主缺省目录，而不是瞎猜一行', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const requested = []
  const base = harness.fetchStub
  harness.fetchStub = async (url, init) => {
    if (String(url).includes('/git-sidebar/state')) requested.push(String(url))
    return base(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  // 两行都没有 mainView：一份「还没选中任何会话」的列表。
  const store = sessionStore({
    's-a': { cwd: '/tmp/ws-a', retainedBy: {} },
    's-b': { cwd: '/tmp/ws-b', retainedBy: {} },
  })
  mountPanel(exports, react, store)
  await react.settle()

  assert.ok(requested.length > 0, '面板还是要读一次状态（用宿主缺省目录）')
  assert.ok(
    requested.every((url) => !url.includes('dir=')),
    `没有当前会话时不能挑一行当当前会话，实际请求：${JSON.stringify(requested)}`,
  )
})

test('client standalone：手输目录（没有目录浏览服务时的退化路径）切过去后不再被会话目录覆盖', async () => {
  // 手填的目录必须由「宿主回传的 state.dir」确认（面板以宿主归一化后的路径为准），
  // 所以这一份响应的 dir 就是 /tmp/manual。
  const wsManual = { ...WS_B, dir: '/tmp/manual' }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, {
    '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B, '/tmp/manual': wsManual,
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ 's-a': { cwd: '/tmp/ws-a' }, 's-b': { cwd: '/tmp/ws-b' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  const switchButton = findButton(first, '切换')
  assert.ok(switchButton !== undefined, '目录行应有「切换」按钮')
  switchButton.props.onClick()

  const opened = await react.settle()
  assert.ok(textOf(opened).includes('选择要查看的目录'), '点「切换」应弹出目录选择小窗口')
  // 没有目录浏览服务：小窗口给出手输路径的入口（这条是「服务缺失也不白屏」的退化保证）。
  assert.ok(textOf(opened).includes('没有提供目录浏览服务'), '没有目录服务时要说明并给出替代路径')
  const pencil = flattenTree(opened).find((node) => node.props !== undefined && node.props['aria-label'] === '输入路径')
  assert.ok(pencil !== undefined, '小窗口里应有「输入路径」按钮')
  pencil.props.onClick()

  const editing = await react.settle()
  // 面板底部的提交表单也有输入框：小窗口那个是树里最后一个。
  const input = flattenTree(editing).filter((node) => node.type === 'input').pop()
  assert.ok(input !== undefined, '点「输入路径」后应出现路径输入框')
  input.props.onChange({ target: { value: '/tmp/manual' } })

  const typed = await react.settle()
  const typedInput = flattenTree(typed).filter((node) => node.type === 'input').pop()
  typedInput.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })

  const manual = await react.settle()
  assert.ok(textOf(manual).includes('/tmp/manual'), '手输切换后应停在自己填的目录')
  assert.ok(!textOf(manual).includes('选择要查看的目录'), '确认后小窗口要关掉')

  // 会话切走了：手动选过目录就不再跟随（这是有意的，避免覆盖用户的输入）。
  selectSession(store, 's-b')
  const stillManual = await react.settle()
  assert.ok(textOf(stillManual).includes('/tmp/manual'), '手动选过目录后不应被会话目录覆盖')

  // 点「跟随会话」才回到当前会话的工作目录。
  const follow = findButton(stillManual, '跟随会话')
  assert.ok(follow !== undefined, '手动切换后应出现「跟随会话」按钮')
  await follow.props.onClick()
  const followed = await react.settle()
  assert.ok(textOf(followed).includes('/tmp/ws-b'), `点「跟随会话」后应回到会话 B 的目录，实际：${textOf(followed).slice(0, 300)}`)
})

// ── 6.5 目录选择小窗口（「切换」按钮 = 与 DSH「添加工作区」同一个选择器） ─────
//
// 这一节保的是「点了真的有那个小窗口」：浏览/进入/选中/确认/取消/新建文件夹，
// 以及宿主目录服务缺失时不白屏（退化成手输路径）。
//
// 服务名与形状照抄宿主真实的 `uiWorkspace`（`listDirectory` / `createDirectory`）：
// 面板是从 `ctx.uiWorkspace` 取的 —— 回归：曾照着 `ctx.remote.directoryPicker` 写，
// 而 cordis 是懒注入，没在 inject 里声明的服务在插件上下文里读不到，小窗口于是
// 永远显示「宿主没有提供目录浏览服务」。

/** 一份假目录树，形状与宿主 uiWorkspace 回的 DirectoryListing 完全一致。 */
function makeFakePicker(levels) {
  const calls = { list: [], create: [] }
  return {
    calls,
    service: {
      listDirectory: async (path, signal) => {
        calls.list.push({ path, signal })
        const level = levels[path === undefined ? '' : path]
        if (level === undefined) throw Object.assign(new Error('目录读不到'), { rpcError: { message: '目录读不到：' + String(path) } })
        return level
      },
      createDirectory: async (parent, name) => {
        calls.create.push({ parent, name })
        const created = parent + '/' + name
        // 真宿主创建完再列父目录时，新目录就在那一层里 —— 假替身照做，
        // 否则「创建后选中它」这条链路在测试里根本验不到。
        const level = levels[parent]
        if (level !== undefined) {
          level.entries = level.entries.concat([{ name, path: created, hidden: false }])
        }
        return created
      },
    },
  }
}

const HOME_LEVEL = {
  path: '/home/me', home: '/home/me',
  crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'me', path: '/home/me', hidden: false }],
  entries: [
    { name: 'project-a', path: '/home/me/project-a', hidden: false },
    { name: '.cache', path: '/home/me/.cache', hidden: true },
  ],
  truncated: false,
}

/**
 * 一份「宿主这次只组合了系统对话框（native）」的假服务，形状照抄真宿主的拒绝：
 * list / createDirectory 要 browse 能力，组合出来的却是 native，于是回
 * `directory-picker/unavailable` + `details.capability: 'native'`（见
 * packages/api/workspace-controller/src/directory-picker.ts）；pickDirectory 可用。
 *
 * 回归的是：面板原来只认 browse 那条路，于是一打开小窗口就把宿主的英文能力错误
 * （`directoryPicker.list needs the browse capability; the composed picker serves "native"`）
 * 甩到界面上，系统对话框这条正道反而没走。
 */
function makeNativeOnlyPicker(chosen) {
  const calls = { list: [], create: [], pick: [] }
  const unavailable = (method) => Object.assign(
    new Error(`directory browse failed: directory-picker/unavailable: directoryPicker.${method} needs the browse capability; the composed picker serves "native"`),
    {
      name: 'DirectoryBrowseError',
      rpcError: {
        code: 'directory-picker/unavailable',
        message: `directoryPicker.${method} needs the browse capability; the composed picker serves "native"`,
        details: { capability: 'native' },
      },
    },
  )
  return {
    calls,
    service: {
      listDirectory: async (path) => { calls.list.push(path); throw unavailable('list') },
      createDirectory: async (parent, name) => { calls.create.push({ parent, name }); throw unavailable('createDirectory') },
      pickDirectory: async () => { calls.pick.push(true); return chosen },
    },
  }
}

test('client standalone：点「切换」弹出目录小窗口，选中目录后确认即切换（与添加工作区同一个选择器）', async () => {
  const target = { ...WS_B, dir: '/home/me/project-a' }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/home/me/project-a': target })
  const fake = makeFakePicker({ '': HOME_LEVEL })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  const switchButton = findButton(first, '切换')
  assert.ok(switchButton !== undefined, '目录行应有「切换」按钮')
  switchButton.props.onClick()

  const opened = await react.settle()
  const openedText = textOf(opened)
  assert.ok(openedText.includes('选择要查看的目录'), `点「切换」应弹出小窗口，实际：${openedText.slice(0, 300)}`)
  assert.ok(openedText.includes('与「添加工作区」同一个目录选择器'), '小窗口要说明它与添加工作区是同一个选择器')
  assert.deepEqual(fake.calls.list.map((call) => call.path), [undefined], '打开时应向宿主列一次主目录（path 缺省）')
  assert.ok(openedText.includes('project-a'), '列出的目录要画出来')
  assert.ok(!openedText.includes('.cache'), '隐藏目录默认不显示（与宿主浏览器一致）')
  assert.ok(openedText.includes('主目录'), '面包屑要从「主目录」开始')

  // 显示隐藏文件：.cache 出现。
  const toggle = flattenTree(opened).find((node) => node.type === 'button' && textOf(node) === '显示隐藏文件')
  assert.ok(toggle !== undefined, '应有「显示隐藏文件」开关')
  toggle.props.onClick()
  const withHidden = await react.settle()
  assert.ok(textOf(withHidden).includes('.cache'), '打开后隐藏目录要出现')

  // 单击选中 project-a，再确认。
  const row = flattenTree(withHidden).find((node) => node.type === 'button' && textOf(node).includes('project-a'))
  assert.ok(row !== undefined, '应有 project-a 这一行')
  row.props.onClick()
  const selected = await react.settle()
  assert.ok(
    flattenTree(selected).some((node) => typeof node.props.className === 'string'
      && node.props.className.includes('dgs-pick-row-selected')),
    '单击要选中该行（选中态有独立类名）',
  )

  const confirm = findButton(selected, '选择此目录')
  assert.ok(confirm !== undefined, '应有「选择此目录」按钮')
  await confirm.props.onClick()
  const after = await react.settle()

  assert.ok(!textOf(after).includes('选择要查看的目录'), '确认后小窗口要关掉')
  assert.ok(textOf(after).includes('/home/me/project-a'), `面板要切到选中的目录，实际：${textOf(after).slice(0, 300)}`)
  assert.ok(findButton(after, '跟随会话') !== undefined, '手动选过目录后应出现「跟随会话」')
})

test('client standalone：小窗口里能进子目录（双击）与退回（面包屑），取消则什么都不动', async () => {
  const child = {
    path: '/home/me/project-a', home: '/home/me',
    crumbs: [
      { name: '/', path: '/', hidden: false },
      { name: 'me', path: '/home/me', hidden: false },
      { name: 'project-a', path: '/home/me/project-a', hidden: false },
    ],
    entries: [{ name: 'src', path: '/home/me/project-a/src', hidden: false }],
    truncated: false,
  }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const requested = []
  const base = harness.fetchStub
  harness.fetchStub = async (url, init) => {
    if (String(url).includes('/git-sidebar/state')) requested.push(String(url))
    return base(url, init)
  }
  const fake = makeFakePicker({ '': HOME_LEVEL, '/home/me/project-a': child })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()

  // 双击 project-a 进入子目录。
  const row = flattenTree(opened).find((node) => node.type === 'button' && textOf(node).includes('project-a'))
  row.props.onDoubleClick()
  const inside = await react.settle()
  assert.ok(fake.calls.list.some((call) => call.path === '/home/me/project-a'), '双击应列出该目录')
  assert.ok(textOf(inside).includes('src'), '应看到子目录 src')
  assert.ok(textOf(inside).includes('project-a'), '面包屑里应出现 project-a')

  // 点面包屑「主目录」退回。
  const crumb = flattenTree(inside).find((node) => node.type === 'button' && textOf(node) === '主目录')
  assert.ok(crumb !== undefined, '应有「主目录」面包屑')
  crumb.props.onClick()
  const back = await react.settle()
  assert.ok(textOf(back).includes('project-a'), '退回后应重新看到 project-a')

  // 取消：小窗口关掉，且一次状态请求都没为新目录发出去。
  const before = requested.length
  findButton(back, '取消').props.onClick()
  const closed = await react.settle()
  assert.ok(!textOf(closed).includes('选择要查看的目录'), '取消后小窗口要关掉')
  assert.equal(requested.length, before, '取消不该触发任何目录切换')
})

test('client standalone：小窗口里能新建文件夹，创建成功后面板选中它', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A })
  const fake = makeFakePicker({
    '': { ...HOME_LEVEL, entries: HOME_LEVEL.entries.map((entry) => ({ ...entry })) },
    '/home/me': { ...HOME_LEVEL, entries: HOME_LEVEL.entries.map((entry) => ({ ...entry })) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()

  const newFolder = findButton(opened, '新建文件夹')
  assert.ok(newFolder !== undefined, '小窗口应有「新建文件夹」')
  newFolder.props.onClick()

  const creating = await react.settle()
  assert.ok(textOf(creating).includes('在 '), '新建小窗口要说明建在哪')
  const input = flattenTree(creating).filter((node) => node.type === 'input').pop()
  assert.ok(input !== undefined, '新建小窗口应有名字输入框')
  input.props.onChange({ target: { value: 'new-repo' } })
  const typed = await react.settle()
  const typedInput = flattenTree(typed).filter((node) => node.type === 'input').pop()
  typedInput.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  const after = await react.settle()

  assert.deepEqual(fake.calls.create, [{ parent: '/home/me', name: 'new-repo' }], '应把「父目录 + 名字」交给宿主创建')
  assert.ok(!textOf(after).includes('在 '), '创建成功后新建小窗口要关掉')
  assert.ok(
    flattenTree(after).some((node) => typeof node.props.className === 'string'
      && node.props.className.includes('dgs-pick-row-selected')
      && textOf(node).includes('new-repo')),
    '创建出来的文件夹应被选中',
  )
})

test('client standalone：目录服务报错时，小窗口把宿主的业务消息显示出来（不白屏、不静默）', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const fake = makeFakePicker({}) // 任何路径都读不到
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()

  assert.ok(textOf(opened).includes('选择要查看的目录'), '出错也要先把小窗口画出来')
  assert.ok(textOf(opened).includes('目录读不到'), `要显示宿主的业务错误消息，实际：${textOf(opened).slice(0, 400)}`)
  // 「目录读不到」是浏览能力**在**、只是这一层读不了：不能因此切成系统对话框模式，
  // 否则用户会被莫名其妙地踢出网页浏览器（只有能力缺席才是那个场景）。
  assert.ok(findButton(opened, '打开系统目录选择器…') === undefined, '普通读取失败不该退化成系统对话框模式')
  assert.ok(findButton(opened, '选择此目录') !== undefined, '普通读取失败仍应留在浏览模式')
})

test('client standalone：宿主只组合了系统对话框时，小窗口改走 pickDirectory（不再甩 browse 错误）', async () => {
  const target = { ...WS_B, dir: '/home/me/project-a' }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/home/me/project-a': target })
  const fake = makeNativeOnlyPicker('/home/me/project-a')
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()
  const openedText = textOf(opened)

  assert.ok(openedText.includes('选择要查看的目录'), '小窗口要照常画出来')
  assert.ok(
    !openedText.includes('needs the browse capability'),
    `不该把宿主的英文能力错误甩给用户，实际：${openedText.slice(0, 400)}`,
  )
  assert.ok(openedText.includes('系统对话框'), '要说明宿主这次组合的是系统对话框')
  assert.equal(fake.calls.list.length, 1, '打开时试列一次探测能力；失败后不再重试')
  assert.ok(findButton(opened, '选择此目录') === undefined, 'native 模式下没有「选择此目录」')
  assert.ok(findButton(opened, '新建文件夹') === undefined, 'native 模式下没有「新建文件夹」')

  const open = findButton(opened, '打开系统目录选择器…')
  assert.ok(open !== undefined, '应给出「打开系统目录选择器…」按钮')
  await open.props.onClick()
  const after = await react.settle()

  assert.deepEqual(fake.calls.pick, [true], '按钮要真的调宿主的 pickDirectory')
  assert.ok(!textOf(after).includes('选择要查看的目录'), '选到目录后小窗口要关掉')
  assert.ok(
    textOf(after).includes('/home/me/project-a'),
    `面板要切到系统对话框选中的目录，实际：${textOf(after).slice(0, 300)}`,
  )
})

test('client standalone：系统对话框取消（返回空）时小窗口留着，不静默关窗也不切目录', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/home/me/project-a': WS_B })
  const fake = makeNativeOnlyPicker(null) // 用户按了取消
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()
  await findButton(opened, '打开系统目录选择器…').props.onClick()
  const after = await react.settle()

  assert.deepEqual(fake.calls.pick, [true], '确实调过系统对话框')
  assert.ok(textOf(after).includes('选择要查看的目录'), '取消后小窗口要留着，别把用户晾在外面')
  assert.ok(textOf(after).includes('/tmp/ws-a'), '取消不该换目录')
})

test('client standalone：native 模式下直接手输绝对路径，回车一步切过去（不再去列目录）', async () => {
  const target = { ...WS_B, dir: '/home/me/project-b' }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/home/me/project-b': target })
  const fake = makeNativeOnlyPicker(null)
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/ws-a' } }), { uiWorkspace: fake.service })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()

  const pen = flattenTree(opened).find((node) => node.type === 'button' && textOf(node) === '✎')
  assert.ok(pen !== undefined, 'native 模式下也要有「直接输入路径」的入口')
  pen.props.onClick()
  const editing = await react.settle()
  // 面板本体也有别的 .dgs-input；小窗口挂在整棵树的最后，所以取最后一个。
  const input = flattenTree(editing).filter((node) => node.type === 'input' && node.props.className === 'dgs-input').pop()
  assert.ok(input !== undefined, '应展开路径输入框')
  input.props.onChange({ target: { value: '/home/me/project-b' } })
  const typed = await react.settle()
  flattenTree(typed)
    .filter((node) => node.type === 'input' && node.props.className === 'dgs-input')
    .pop()
    .props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  const after = await react.settle()

  assert.equal(fake.calls.list.length, 1, '手输路径不该再去列目录（宿主没有 browse 能力，列也列不出来）')
  assert.ok(!textOf(after).includes('选择要查看的目录'), '回车后小窗口要关掉')
  assert.ok(
    textOf(after).includes('/home/me/project-b'),
    `面板要切到手输的目录，实际：${textOf(after).slice(0, 300)}`,
  )
})

test('client standalone：目录服务只认 ctx.uiWorkspace（回归：曾读 ctx.remote.directoryPicker，永远拿不到）', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const fake = makeFakePicker({ '': HOME_LEVEL })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)

  // 服务放在 ctx.uiWorkspace 上（cordis 按 inject 注入的真身位置），
  // 同时在 ctx.remote.directoryPicker 上放一个**同名但会抛错**的诱饵：
  // 谁再照着 remote 那条路取，就会打中诱饵、或者干脆取不到。
  const { slots, registered } = makeSlots()
  let decoyHit = 0
  exports.apply({
    slots,
    uiWorkspace: fake.service,
    remote: {
      directoryPicker: {
        list: async () => { decoyHit += 1; throw new Error('不该走 remote.directoryPicker') },
        createDirectory: async () => { decoyHit += 1; throw new Error('不该走 remote.directoryPicker') },
      },
    },
  })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  react.mount(panel, { useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/ws-a' } })) })

  const first = await react.settle()
  findButton(first, '切换').props.onClick()
  const opened = await react.settle()

  assert.ok(fake.calls.list.length >= 1, '打开小窗口必须真的向 uiWorkspace 列一次目录')
  assert.equal(decoyHit, 0, '不能去碰 ctx.remote.directoryPicker')
  assert.ok(textOf(opened).includes('project-a'), '列出来的目录要画进小窗口')
  assert.ok(!textOf(opened).includes('宿主没有提供目录浏览服务'), '服务可用时不该显示「没有提供目录浏览服务」')
})

test('client standalone：切走之后才回来的操作结果不能盖到新工作区上', async () => {
  const opResult = {
    ok: true, command: 'git pull', exitCode: 0, stdout: 'Already up to date.', stderr: '',
    message: null, hint: null, clonedDir: null, branches: null, diff: null, state: WS_A,
  }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const dirAware = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  // 让 /git-sidebar/op 卡住不返回：模拟一次耗时的 pull（宿主侧超时 10 分钟）。
  let releaseOp = null
  harness.fetchStub = async (url, init = {}) => {
    if (String(url).includes('/git-sidebar/op')) {
      harness.calls.fetch.push({ url, init })
      return await new Promise((resolve) => { releaseOp = resolve })
    }
    return dirAware(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  const pull = findButton(first, '拉取')
  assert.ok(pull !== undefined, 'A 是仓库，「拉取」按钮应该出现')
  const pending = pull.props.onClick()
  assert.equal(typeof releaseOp, 'function', '拉取请求应该已经发出去（并且还没回来）')

  // 操作还没回来，用户就切到了另一个工作区。
  store.byId.s1.cwd = '/tmp/ws-b'
  const afterSwitch = await react.settle()
  assert.ok(textOf(afterSwitch).includes('/tmp/ws-b'), '面板要先切到工作区 B')

  // 现在旧工作区的操作结果才回来。
  releaseOp({ status: 200, json: async () => opResult })
  await pending
  const finalTree = await react.settle()

  assert.ok(
    !outputBars(finalTree).some((text) => text.includes('git pull') || text.includes('up to date')),
    `旧工作区的输出不能盖到新工作区上，实际：${JSON.stringify(outputBars(finalTree))}`,
  )
  assert.ok(textOf(finalTree).includes('/tmp/ws-b'), '面板不能被旧工作区的状态切回去')
  assert.ok(textOf(finalTree).includes('dev'), '旧工作区的状态不能盖掉新工作区的状态')
})

// ── 6. 网络加速界面 ───────────────────────────────────────────────────────
//
// 这一节保的是「点了按钮真的有反应」和「渲染分支不白屏」：面板是新写的手绘
// createElement，任何一处笔误都会让整个 sidebar.right.pane.tab 渲染抛异常 —— 表现是
// Git 面板直接消失，而不是局部出错。

/** 打开 🌐 网络加速折叠块。 */
async function openNet(react) {
  const before = await react.settle()
  const globe = findButton(before, '🌐')
  assert.ok(globe !== undefined, '头部应有 🌐 按钮')
  assert.equal(typeof globe.props.onClick, 'function')
  globe.props.onClick()
  return react.settle()
}

test('client standalone：点 🌐 能展开加速设置，且渲染不抛异常', async () => {
  const harness = makeFakeWindow()
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const tree = await openNet(react)
  const text = textOf(tree)
  assert.ok(text.includes('网络加速'), `展开后要看到设置块，实际：${text.slice(0, 200)}`)
  assert.ok(text.includes('gh-proxy.com'), '镜像候选要列出来')
  assert.ok(text.includes('检测网络'), '要有现场检测入口')
  // 安全提示必须在，且要说明私有仓库该怎么办 —— 这是这个功能的取舍核心。
  assert.ok(text.includes('第三方') && text.includes('私有仓库'))
  assert.ok(findButton(tree, '保存代理') !== undefined)
})

test('client standalone：面板挂载时会读一次宿主配置', async () => {
  const harness = makeFakeWindow({
    netResponse: {
      ok: true, mirrorEnabled: true, mirror: 'https://ghfast.top/',
      proxy: 'http://***@127.0.0.1:7890', hasProxy: true,
      candidates: [{ id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' }],
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  assert.ok(
    harness.calls.fetch.some((call) => String(call.url).includes('/git-sidebar/net')),
    '挂载时应读 /git-sidebar/net',
  )
  // 草稿框里应当是打码后的地址：真凭据永远不进浏览器。
  const text = textOf(tree)
  assert.ok(!text.includes('secret'))
  const globe = findButton(tree, '🌐')
  const opened = await (async () => { globe.props.onClick(); return react.settle() })()
  const proxyInput = flattenTree(opened).find((node) => node.type === 'input' && String(node.props.value).includes('127.0.0.1:7890'))
  assert.ok(proxyInput !== undefined, '代理输入框应预填宿主返回的（已打码）地址')
  assert.ok(String(proxyInput.props.value).includes('***'), '回传的必须是打码串')
})

test('client standalone：保存代理会把输入框内容 POST 给 /git-sidebar/net', async () => {
  const harness = makeFakeWindow()
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await openNet(react)

  const input = flattenTree(tree).find((node) => node.type === 'input' && String(node.props.placeholder).includes('本机代理'))
  assert.ok(input !== undefined, '应有代理输入框')
  input.props.onChange({ target: { value: 'http://127.0.0.1:7890' } })
  const afterType = await react.settle()

  const save = findButton(afterType, '保存代理')
  assert.equal(typeof save.props.onClick, 'function', '保存按钮必须真的接上处理函数')
  await save.props.onClick()
  await react.settle()

  // 只数打到 /git-sidebar/net 的 POST：/git-sidebar/diag 也是 POST，不能混进来。
  const posted = harness.calls.fetch.filter((call) =>
    String(call.url).includes('/git-sidebar/net') && call.init !== undefined && call.init.method === 'POST')
  assert.equal(posted.length, 1, `应恰好 POST 一次，实际 ${posted.length} 次`)
  assert.deepEqual(JSON.parse(posted[0].init.body), { proxy: 'http://127.0.0.1:7890' })
})

test('client standalone：宿主是旧版本、还没有 /git-sidebar/net 时，面板照常渲染并说明不可用', async () => {
  // 这正是「客户端已热重载、宿主还没重启」时的真实状态：404 回的是 HTML，
  // response.json() 会抛。读配置失败绝不能把整个面板带崩。
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const base = harness.fetchStub
  harness.fetchStub = async (url, init = {}) => {
    if (String(url).includes('/git-sidebar/net')) {
      return {
        status: 404,
        json: async () => { throw new Error('Unexpected token < in JSON') },
      }
    }
    return base(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const tree = await react.settle()
  assert.ok(textOf(tree).includes('main'), '读不到加速配置不影响仓库状态显示')
  assert.ok(findButton(tree, '获取远程') !== undefined, '按钮照常在')

  const opened = await openNet(react)
  assert.ok(textOf(opened).includes('读不到宿主配置'), '要明确告诉用户是宿主版本的问题，而不是静默空白')
  // 检测按钮不该在一个必然 404 的宿主上还让用户点。
  assert.equal(findButton(opened, '检测网络'), undefined)
})

test('client standalone：点「检测网络」把各线路结果列出来（含失败的线路）', async () => {
  const harness = makeFakeWindow({
    probeResults: [
      { kind: 'direct', label: '直连 github.com', ok: false, ms: 8000, error: '命令超时（8000ms 内无响应）' },
      { kind: 'mirror', label: 'gh-proxy.com', ok: true, ms: 820, error: null },
      { kind: 'mirror', label: 'ghfast.top', ok: true, ms: 1040, error: null },
    ],
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await openNet(react)

  await findButton(tree, '检测网络').props.onClick()
  const after = await react.settle()
  const text = textOf(after)

  assert.ok(harness.calls.fetch.some((call) => String(call.url).includes('probe=1')), '应请求 probe=1')
  assert.ok(text.includes('ghfast.top'), '通的线路要列出来')
  assert.ok(text.includes('820ms'), '通了的要显示耗时')
  assert.ok(text.includes('直连 github.com'), '不通的线路也要列出来（否则用户不知道差别在哪）')
  assert.ok(text.includes('✗'), '失败的线路要有明确标记')
})

test('client standalone：宿主判定是网络问题时自动展开加速设置，并把说明回显到结果栏', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: false, command: 'git fetch --all --prune', exitCode: 128,
      stdout: '', stderr: "fatal: unable to access 'https://github.com/x/y': Recv failure: Connection was reset",
      message: 'Recv failure: Connection was reset',
      hint: '连不上远端（连接被重置 / 超时），国内直连 github.com 很常见。点面板右上角的 🌐 打开「网络加速」…',
      network: true, accelerated: 'direct', notes: [],
      state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const initial = await react.settle()
  // 先确认设置块确实是收起的（不然下面那条断言会因为「本来就开着」而假通过）。
  assert.equal(findButton(initial, '检测网络'), undefined, '初始状态加速设置应是收起的')

  const fetchBtn = findButton(initial, '获取远程')
  assert.ok(fetchBtn !== undefined, '仓库里应有「获取远程」按钮')
  await fetchBtn.props.onClick()
  const after = await react.settle()
  const text = textOf(after)

  // 断言「只有展开时才存在」的控件，而不是「网络加速」这四个字 —— 后者在提示
  // 文案里也有（「点面板右上角的 🌐 打开「网络加速」」），拿它断言会假通过。
  assert.ok(
    findButton(after, '检测网络') !== undefined,
    '网络失败要自动把加速设置展开，而不是只说「点 🌐」让用户自己找',
  )
  assert.ok(text.includes('Connection was reset'), '原始报错要保留，用户才能搜')
  assert.ok(text.includes('连不上远端'), '要给出下一步提示')
})

test('client standalone：开了加速时，命令结果栏要说明这条命令走了哪条线路', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: true, command: 'git fetch --all --prune', exitCode: 0, stdout: '', stderr: '',
      message: null, hint: null, network: false, accelerated: 'mirror',
      notes: ['已通过镜像 gh-proxy.com 加速（只作用于本次命令，不改你的 git 配置）'],
      state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  await findButton(initial, '获取远程').props.onClick()
  const after = await react.settle()
  const bars = outputBars(after).join('\n')

  // 走镜像 = 请求经过了第三方，用户必须看得见，不能在后台默默发生。
  assert.ok(bars.includes('已通过镜像 gh-proxy.com'), `结果栏应说明走了镜像，实际：${JSON.stringify(outputBars(after))}`)
  assert.ok(bars.includes('$ git fetch --all --prune'), '命令回显仍要在')
})

test('client standalone：「安全拉取」按钮存在，点击把 stashPull 交给宿主并展示过程结果', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [{ code: ' M', path: 'f.txt', staged: false }],
    changesTotal: 1, log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      stashPull: {
        ok: true, command: 'git pull', exitCode: 0, stdout: 'Updating a1b2..c3d4', stderr: '',
        message: null, hint: null, network: false, accelerated: 'direct',
        notes: [
          '已把你的改动（含未跟踪文件）藏进 stash（git stash push -u）：拉取成功会原样恢复，失败也会自动还给你',
          '拉取成功，你的改动已原样还原（git stash pop）',
        ],
        state: repoState,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const btn = findButton(initial, '安全拉取')
  assert.ok(btn !== undefined, '仓库里应有「安全拉取」按钮')
  assert.equal(typeof btn.props.title, 'string', '按钮要带悬停说明（说明它做什么、改动不会丢）')

  await btn.props.onClick()
  const after = await react.settle()
  const posted = harness.calls.fetch.find((call) => String(call.url).includes('/git-sidebar/op'))
  assert.ok(posted !== undefined, '应发出 op 请求')
  assert.equal(JSON.parse(posted.init.body).op, 'stashPull', '请求的 op 名应是 stashPull')
  const bars = outputBars(after).join('\n')
  assert.ok(bars.includes('$ git pull'), '命令回显要在结果栏')
  assert.ok(bars.includes('藏进 stash'), '过程说明（先藏起来）要显示')
  assert.ok(bars.includes('已原样还原'), '结果说明（改动还原）要显示')
})

// ── 7. 远端分支：获取远程之后要能看见，并且能一键拿成本地新分支 ─────────────
//
// 现场：本地 `git init` 出来的分支叫 master，远端默认分支叫 main。面板原先只列本地
// 分支，界面上根本看不到 origin/main —— 用户既不知道远端有什么，也没有入口去点它，
// 于是「拉取」只会在 couldn't find remote ref master 上打转。

test('client standalone：分支管理器列出远端分支，点「拿成新分支」把显式的 origin/main 交给宿主', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'https://example.com/demo.git' }],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      // 合并后的契约：一次 branches 同时回本地与远端两份。宿主因此只花一次 HTTP
      // 往返，而且数据型操作不回读仓库状态（noState）—— 展开一次管理器由原先的
      // 两次 op ×（1 条 git + 4 条状态 git）降到 2 条 git。
      branches: {
        ok: true,
        branches: { current: 'master', items: [{ name: 'master', current: true }] },
        remoteBranches: {
          defaultRef: 'origin/main',
          items: [
            { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
            { remote: 'origin', name: 'dev', ref: 'origin/dev', head: false },
          ],
        },
        state: null,
      },
      adoptRemote: { ok: true, state: repoState },
      compare: { ok: true, compare: { ref: 'origin/main', ahead: 0, behind: 3 }, state: repoState },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const opened = await openBranchManager(initial, react)

  const opCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
  // 展开管理器只发**一次** branches（本地 + 远端一次拿回），且带 noState：
  // 数据型操作没必要让宿主再回读一次仓库状态（那要额外跑 4 条 git）。
  const branchCalls = opCalls().filter((payload) => payload.op === 'branches')
  assert.equal(branchCalls.length, 1, '展开时应恰好查一次 branches：' + JSON.stringify(opCalls()))
  assert.equal(branchCalls[0].noState, true, '数据型操作应带 noState')
  assert.ok(
    !opCalls().some((payload) => payload.op === 'remoteBranches'),
    '远端分支已随 branches 一起回来，不该再发第二次 op',
  )
  const texts = flattenTree(opened).map(textOf)
  assert.ok(
    texts.some((text) => text.includes('origin/main')),
    `远端分支要出现在管理器里，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  assert.ok(texts.some((text) => text.includes('origin/dev')), '远端不止一个分支时都要列出来')

  // 「拿成新分支」：必须显式带 remote/branch —— 当前分支叫 master，猜不出来。
  const take = findButton(opened, '拿成新分支')
  assert.ok(take !== undefined, '远端分支旁边要有「拿成新分支」')
  await assert.doesNotReject(() => take.props.onClick(), '点「拿成新分支」不能以异常结束')
  const afterTake = await react.settle()
  const asked = opCalls().filter((payload) => payload.op === 'adoptRemote')
  assert.equal(asked.length, 1, '应该 POST 过一次 adoptRemote：' + JSON.stringify(opCalls()))
  assert.deepEqual(
    { mode: asked[0].mode, remote: asked[0].remote, branch: asked[0].branch },
    { mode: 'branch', remote: 'origin', branch: 'main' },
  )
  // 点远端分支**不是**切换分支：不能顺手发出 checkout（那会变成游离 HEAD）。
  assert.ok(!opCalls().some((payload) => payload.op === 'checkout'), '点远端分支不该触发 checkout')

  // 「比较」：把 ref 交给宿主，原始两列数字由宿主翻成人话放进 notes。
  // A 批之后它收进了行尾「⋯」（第一层只留最常用的动作，把行宽让给分支名），
  // 所以要先把**那一行**的菜单展开 —— 本地分支行也有 ⋯，必须限定在远端那一行上，
  // 否则点到的是「设置上游 / 改名 / 删除」那个菜单。
  const rowsOf = (tree) => flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem'))
  const originRow = rowsOf(afterTake).find((row) => textOf(row).includes('origin/main'))
  assert.ok(originRow !== undefined, '前置条件：origin/main 那一行在')
  const more = flattenTree(originRow).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'button' && textOf(node) === '⋯')
  assert.ok(more !== undefined, '远端分支旁边要有「⋯」更多操作')
  await more.props.onClick()
  const menuOpened = await react.settle()
  const compare = findButton(menuOpened, '比较')
  assert.ok(compare !== undefined, '「⋯」菜单里要有「比较」')
  await assert.doesNotReject(() => compare.props.onClick(), '点「比较」不能以异常结束')
  await react.settle()
  const compares = opCalls().filter((payload) => payload.op === 'compare')
  assert.equal(compares.length, 1, '应该 POST 过一次 compare')
  assert.equal(compares[0].ref, 'origin/main')
})

test('client standalone：默认分支有独立「默认」徽章、全名进 tooltip、分组顶部有提示行且钉在第一行', async () => {
  // 回归一：默认标记原先写在名字字符串里（`origin/main（默认）`），名字一被省略号
  // 截断标记就跟着消失；远端行的 title 又不含 ref，截断后全名无法看到。现在
  // 「默认」是独立徽章（截图不影响），名字的 tooltip 带完整 ref，分组标题下
  // 多一行「远端默认分支：…」（本地指针缺失时由宿主补查 remoteBranches.defaults）。
  // 回归二：默认分支按字母序会夹在几十条分支中间（llama.cpp 的 master 就在第二十几条），
  // 用户看着像「没下载下来」。渲染时把 head 的那条钉到远端分组**第一行**。
  const LONG_REF = 'origin/feature/very-long-branch-name-that-will-definitely-be-ellipsized'
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'https://example.com/demo.git' }],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'master', items: [{ name: 'master', current: true }] },
        remoteBranches: {
          defaultRef: null, // 本地没有 origin/HEAD（镜像/旧 git 现场）
          defaults: [{ remote: 'origin', branch: 'main' }],
          // 刻意让默认分支**不在第一个**：wire 数据是字母序（长分支在前），
          // 钉到第一行必须是客户端的渲染职责。
          items: [
            { remote: 'origin', name: 'feature/very-long-branch-name-that-will-definitely-be-ellipsized',
              ref: LONG_REF, head: false },
            { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
            { remote: 'origin', name: 'dev', ref: 'origin/dev', head: false },
          ],
        },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  const texts = flattenTree(opened).map(textOf)
  // 分组顶部提示行：即使本地没有 origin/HEAD（defaultRef 为 null），宿主的
  // 补查答案（defaults）也要显示出来 —— 用户一眼知道该拿哪份。
  assert.ok(
    texts.some((text) => text.includes('远端默认分支：origin/main')),
    `应有默认分支提示行，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  // 「默认」徽章独立于名字存在（不再是名字后缀），且不包含在名字文本里 ——
  // 名字被 CSS 截断时徽章仍完整可见。
  assert.ok(
    texts.some((text) => text === '默认'),
    `应有独立的「默认」徽章文本，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  // tooltip 必须带完整 ref：长分支名被省略号截断后，悬停仍能看到全名。
  const titled = flattenTree(opened).filter((node) => typeof node.props.title === 'string')
  assert.ok(
    titled.some((node) => node.props.title.startsWith(LONG_REF)),
    `长分支名的 tooltip 要带完整 ref，实际：${JSON.stringify(titled.map((node) => node.props.title).slice(0, 10))}`,
  )
  const badge = flattenTree(opened).find((node) => node.type === 'span' && textOf(node) === '默认')
  assert.ok(badge !== undefined && typeof badge.props.title === 'string' && badge.props.title.includes('origin/main'),
    '默认徽章要注明它指哪个分支')
  // 名字文本本身不再带「（默认）」后缀（截断会吃掉它）。
  assert.ok(!texts.some((text) => text.includes('（默认）')), '默认标记不再作为名字后缀显示')

  // 渲染顺序：默认分支必须排在整个远端分组的第一行（wire 数据里它在中间）。
  const remoteNameSpans = flattenTree(opened).filter((node) =>
    node.type === 'span' && typeof node.props.title === 'string'
    && node.props.title.startsWith('origin/'))
  const titles = remoteNameSpans.map((node) => node.props.title)
  const mainPos = titles.findIndex((text) => text.startsWith('origin/main'))
  const longPos = titles.findIndex((text) => text.startsWith(LONG_REF))
  const devPos = titles.findIndex((text) => text.startsWith('origin/dev'))
  assert.ok(mainPos === 0, `默认分支要钉在远端分组第一行，实际顺序：${JSON.stringify(titles)}`)
  assert.ok(longPos > mainPos && devPos > mainPos, `其余分支仍按 ref 排序，实际顺序：${JSON.stringify(titles)}`)
})

// ── 8. 新增契约：宿主诊断必须可见 / 截断必须说出来 / noState / reset-repo ─────

test('client standalone：宿主给的 notice 必须显示出来（回归：宿主算了却没人读）', async () => {
  // 没装 git 时宿主会把「请先安装 git」放进 state.notice。面板原先只显示一句通用的
  // 「还不是 Git 仓库」—— 最有用的那条诊断在传输层就丢了。
  const harness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [],
      notice: '未检测到 git：请先安装 git（https://git-scm.com）后重试。',
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('未检测到 git'), `面板要显示宿主的诊断，实际：${text.slice(0, 300)}`)
  assert.ok(text.includes('还没有 Git 仓库'), '通用说明仍要在（它告诉用户下一步点哪里）')
})

test('client standalone：宿主只说「还不是仓库」时不重复叠加，通用说明就够了', async () => {
  const harness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [],
      notice: '当前目录还不是 Git 仓库',
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('还没有 Git 仓库'))
  assert.equal(text.includes('⚠'), false, '默认 notice 与通用说明重复，不该再叠一行')
})

test('client standalone：改动被截断时必须说明「还有 N 处未显示」，胶囊用真实总数', async () => {
  const changes = []
  for (let index = 0; index < 100; index += 1) {
    changes.push({ code: ' M', path: 'f' + index + '.txt', staged: false })
  }
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes, changesTotal: 137, log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  // 面板画 40 条，宿主回了 100 条、真实总数 137：差多少必须写出来。
  assert.ok(text.includes('还有 97 处未显示'), `截断要说出来，实际：${text.slice(0, 400)}`)
  assert.ok(text.includes('137 处改动'), '摘要胶囊要用宿主的真实总数，不是列表长度')
})

// ── 8b. 融合升级：目录树 / 冲突横幅 / 标签角标 / stash 藏起 / 提交历史徽章 ────

test('client standalone：嵌套改动折成目录树（单子目录链压缩、目录行带计数与「暂存目录」）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [
      { code: ' M', path: 'src/client/changes/a.ts', staged: false },
      { code: ' M', path: 'src/client/changes/b.ts', staged: false },
      { code: ' M', path: 'README.md', staged: false },
    ],
    changesTotal: 3, log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  // 单子目录链压缩：src/client/changes 三段并成一个目录行，不再出现中间层单独占行。
  assert.ok(text.includes('src/client/changes'), `单子目录链要压成一行：${text.slice(0, 500)}`)
  // 目录行带下级变更数胶囊与目录级暂存按钮。
  assert.ok(text.includes('暂存目录'), '目录行要有「暂存目录」按钮（git add -A -- <dir>）')
  const stagedir = flattenTree(tree).find((node) => textOf(node) === '暂存目录')
  assert.ok(stagedir !== undefined, '应找到暂存目录按钮')
  // 目录行的按钮会 stopPropagation（防止顺手把目录折叠）；假调用要给个像样的事件。
  await stagedir.props.onClick({ stopPropagation() {} })
  const calls = harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
  const addDir = calls.find((payload) => payload.op === 'addDir')
  assert.ok(addDir !== undefined, '点「暂存目录」应 POST op=addDir')
  assert.equal(addDir.path, 'src/client/changes', 'path 是目录路径（pathspec）')
})

test('client standalone：目录行可折叠（点一下收起子树，再点展开）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [
      { code: ' M', path: 'src/a.ts', staged: false },
      { code: ' M', path: 'src/b.ts', staged: false },
    ],
    changesTotal: 2, log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const dirRow = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('src（'))
  assert.ok(dirRow !== undefined, '应有 src 的目录行')
  await dirRow.props.onClick()
  const collapsed = await react.settle()
  assert.ok(!textOf(collapsed).includes('a.ts'), '收起后子树里的文件行不应再渲染')
  await dirRow.props.onClick()
  const expanded = await react.settle()
  assert.ok(textOf(expanded).includes('a.ts'), '再点一下应重新展开')
})

test('client standalone：UU 冲突条目带「冲突」徽章，且顶部有中文指引横幅', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [
      { code: 'UU', path: 'conflict.txt', staged: false },
      { code: ' M', path: 'a.txt', staged: false },
    ],
    changesTotal: 2,
    conflicts: ['conflict.txt'],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('撞上了冲突'), '应有冲突横幅')
  assert.ok(text.includes('conflict.txt'), '横幅要列出冲突文件')
  // 冲突行的说明在 tooltip 上（title 属性）：定位那一行并检查它。
  const conflictRow = flattenTree(tree).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('合并冲突'))
  assert.ok(conflictRow !== undefined, '冲突行要有「合并冲突」说明（tooltip）')
  assert.ok(conflictRow.props.title.includes('改好内容再「暂存」'), 'tooltip 要给下一步')
})

test('client standalone：「藏起当前改动」按钮把 stashPush 交给宿主并展开备份区', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1, log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: { stashPush: { ok: true, state: repoState }, stashList: { ok: true, stash: [], state: null } },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const button = flattenTree(tree).find((node) => textOf(node) === '藏起当前改动')
  assert.ok(button !== undefined, '应有「藏起当前改动」按钮')
  await button.props.onClick()
  const calls = harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
  assert.ok(calls.some((payload) => payload.op === 'stashPush'), '应 POST op=stashPush')
  assert.ok(calls.some((payload) => payload.op === 'stashList'), '成功后要拉一次 stash 备份列表')
})

test('client standalone：有改动时标签标题显示「Git · N」徽章', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 3, log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const title = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title').component
  react.mount(panel, { useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })) })
  await react.settle()
  // 面板拿到状态后，标签标题（宿主投影时渲染）读到的应是同一个徽章 store。
  const titleText = textOf(title({}))
  assert.ok(titleText.includes('Git · 3'), `有 3 处改动时标题应是「Git · 3」，实际：${titleText}`)
})

test('client standalone：提交历史显示 refs 徽章与作者/相对时间，满页时出现「加载更多」', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [], changesTotal: 0,
    log: [
      { hash: 'a1b2c3d', subject: 'fix: 修好它', refs: 'HEAD -> main', author: '张三', date: '2026-01-01 10:00:00 +0800' },
      { hash: 'e4f5g6h', subject: 'feat: 新功能', refs: 'tag: v1, origin/main', author: '李四', date: '2025-12-31 09:00:00 +0800' },
      ...Array.from({ length: 6 }, (_, index) => ({ hash: 'h' + index, subject: 'c' + index, refs: '', author: '', date: '' })),
    ],
    remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: { logPage: { ok: true, logPage: { entries: [], count: 0 }, state: null, notes: ['没有更早的提交了（历史已经到底）'] } },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('main'), 'refs 徽章要显示分支名（HEAD -> main 取箭头后）')
  assert.ok(text.includes('v1'), 'tag 装饰也要显示')
  assert.ok(text.includes('张三'), '作者要显示')
  const more = flattenTree(tree).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('加载更多'))
  assert.ok(more !== undefined, '满 8 条（一页首屏）时应出现「加载更多」')
  await more.props.onClick()
  const calls = harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
  const page = calls.find((payload) => payload.op === 'logPage')
  assert.ok(page !== undefined, '点「加载更多」应 POST op=logPage')
  assert.equal(page.skip, 8, 'skip = 已加载条数')
})

// 现场（真实截图）：一条提交挂着 4 个引用
//   `HEAD -> master, tag: dsh-v0.2.1-alpha.1, origin/master, origin/HEAD`
// ——「最近提交」整列只看得到被压没的 `Merge pull reques…`，标题等于没有。
// 回归的是：**无论挂多少引用，提交标题都必须拿到宽度**。徽章靠 CSS 收缩（这里
// 只能验组件侧的两条约定）：一行最多内联 2 个 + `+N` 收尾，且每个徽章本身
// 不再是 `flex:0 0 auto`（那正是把标题挤到 0 宽的原因）。
test('client standalone：一条提交挂 4 个引用时，标题不被徽章挤没（内联 2 个 + +N）', async () => {
  const refsLine = 'HEAD -> master, tag: dsh-v0.2.1-alpha.1, origin/master, origin/HEAD'
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: 'origin/master',
    ahead: 0, behind: 0, changes: [], changesTotal: 0,
    log: [{ hash: '5badb150', subject: 'Merge pull request #5650 from deepseek-harness/x', refs: refsLine, author: '张三', date: '2026-01-01 10:00:00 +0800' }],
    remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const row = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.onClick === 'function' && textOf(node).startsWith('5badb150'))
  assert.ok(row !== undefined, '提交行要在：' + textOf(tree).slice(-300))

  // 标题原样渲染在文档里（宽度问题由 flex 布局解决，组件不能靠截断标题来腾地方）。
  assert.ok(textOf(row).includes('Merge pull request #5650 from deepseek-harness/x'),
    '提交标题要完整渲染（不许为了让位而被组件截断）')

  // 引用徽章：tooltip 里必须仍能问出**全量**（4 个都在），哪怕只内联了 2 个。
  const chipTitles = flattenTree(row)
    .filter((node) => node.type === 'span' && typeof node.props.title === 'string')
    .map((node) => node.props.title)
  for (const ref of ['master', 'dsh-v0.2.1-alpha.1', 'origin/master', 'origin/HEAD']) {
    assert.ok(chipTitles.some((title) => title === ref || title.includes(ref)),
      '每个引用都要有落脚点（内联或在 +N 的 tooltip 里）：' + ref + '，实际：' + JSON.stringify(chipTitles))
  }

  // 内联上限：git 顺序（HEAD -> master 的 master、tag）在前，其余 2 个收进 +2。
  const more = flattenTree(row).find((node) => textOf(node) === '+2')
  assert.ok(more !== undefined, '超出的 2 个引用要收进一个「+2」徽章')
  assert.ok(String(more.props.title).includes('origin/master')
    && String(more.props.title).includes('origin/HEAD'),
    '「+2」的 tooltip 要点名收起来的是哪两个：' + String(more.props.title))

  // 不允许有第 3 个「真名」徽章和 +N 一起内联。
  assert.ok(textOf(row).includes('master') && textOf(row).includes('dsh-v0.2.1-alpha.1'),
    '前两个（本地分支 + tag）要内联可见')

  // 徽章自己必须可收缩：`flex:0 0 auto` 正是把标题压到 0 宽的那条规则。
  const chips = flattenTree(row)
    .filter((node) => node.type === 'span' && typeof node.props.title === 'string'
      && node.props.style !== undefined && node.props.style.borderRadius === '999px')
  assert.ok(chips.length >= 3, '该有 2 个内联徽章 + 1 个「+N」：' + chips.length)
  for (const chip of chips) {
    assert.notEqual(chip.props.style.flex, '0 0 auto',
      '引用徽章必须可收缩（否则 4 个一起把标题挤成 0 宽）：' + JSON.stringify(chip.props.style))
  }
})

test('client standalone：引用只有 1~2 个时不出现「+N」（没有噪点）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, changes: [], changesTotal: 0,
    log: [{ hash: 'abc1234', subject: 'fix: 修好它', refs: 'HEAD -> main, origin/main', author: '张三', date: '2026-01-01 10:00:00 +0800' }],
    remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const row = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.onClick === 'function' && textOf(node).startsWith('abc1234'))
  assert.ok(row !== undefined, '提交行要在')
  const plusBadge = flattenTree(row).find((node) => /^\+\d+$/.test(textOf(node)))
  assert.equal(plusBadge, undefined, '只有 2 个引用时不该出现「+N」：' + textOf(row))
  assert.ok(textOf(row).includes('main') && textOf(row).includes('origin/main'), '两个都直接可见')
})

// 回归：`relativeTime` 原先写的是 `Date.parse(text.replace(' ', 'T'))`，
// 而 git `%ai` 的 `2026-01-01 10:00:00 +0800` 换成 T 之后是
// `2026-01-01T10:00:00 +0800` —— 这个形状 Date.parse 返回 NaN（偏移前带空格、
// 且缺冒号都不是合法 ISO），于是**永远退回绝对日期**：「3 天前」这一档从来没
// 生效过，提交行里却一直显示最占宽度的 `2026-01-01 10:00`。
// 这里直接从渲染结果反推：新近的提交必须显示相对时间，很久以前的才退回绝对日期。
test('client standalone：提交时间显示相对时间（git %ai 的时区偏移要被正确解析）', async () => {
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 小时前
  const pad = (n) => String(n).padStart(2, '0')
  const gitDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0800`
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], changesTotal: 0,
    log: [
      { hash: 'aaa1111', subject: '刚提交的', refs: '', author: '张三', date: gitDate(recent) },
      { hash: 'bbb2222', subject: '很久以前', refs: '', author: '李四', date: '2000-01-01 10:00:00 +0800' },
    ],
    remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)

  assert.ok(/小时前/.test(text),
    '2 小时前的提交要显示「N 小时前」（不能退回绝对日期）：' + text.slice(-400))
  assert.ok(/26 年前/.test(text),
    '久远日期要走「N 年前」那一档：' + text.slice(-400))
  assert.ok(!text.includes('2000-01-01 10:00:00'),
    '作者日期不该整串原样出现（解析成功时就不该再露绝对日期）')
})

test('client standalone：diff 升级 —— 配对的删/增渲染成「改」行，长上下文折叠可展开', async () => {
  const diffText = [
    'diff --git a/a.txt b/a.txt',
    '@@ -1,12 +1,12 @@',
    ...Array.from({ length: 10 }, (_, index) => ' ctx' + index),
    '-旧名字',
    '+新名字',
    ...Array.from({ length: 10 }, (_, index) => ' tail' + index),
  ].join('\n')
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1, log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: { ok: true, diff: diffText, state: repoState },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  await clickable.props.onClick()
  const opened = await react.settle()
  const text = textOf(opened)
  assert.ok(text.includes('-旧名字'), '删侧行原样保留（文本一字不改）')
  assert.ok(text.includes('+新名字'), '加侧行原样保留')
  assert.ok(text.includes('行未改动'), '≥8 行的连续上下文要折叠')
  const fold = flattenTree(opened).find((node) =>
    typeof node.props.className === 'string' && node.props.className.includes('dgs-diff-fold'))
  assert.ok(fold !== undefined, '折叠块是可点元素')
  await fold.props.onClick()
  const expandedText = textOf(await react.settle())
  assert.ok(expandedText.includes('ctx0'), '点折叠块应展开出被折的上下文行')
})

test('client standalone：数据型操作带 noState，state:null 也不会抹掉面板状态', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1, log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      // 宿主对 noState 的回复：state 为 null（省掉 4 条 git 进程）。
      diff: { ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-one\n+two\n', state: null },
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  await clickable.props.onClick()
  const after = await react.settle()

  const opCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
  const diffCall = opCalls().find((payload) => payload.op === 'diff')
  assert.equal(diffCall.noState, true, 'diff 是数据型操作，应带 noState')
  assert.ok(textOf(after).includes('+two'), 'diff 仍然要显示出来')
  // state:null 绝不能把面板状态清空：分支、目录、改动清单都还在。
  assert.ok(textOf(after).includes('main'), 'state:null 不该抹掉分支')
  assert.ok(textOf(after).includes('/tmp/demo'), 'state:null 不该抹掉目录')
  assert.ok(textOf(after).includes('a.txt'), 'state:null 不该抹掉改动清单')
})

test('client standalone：数组子节点必须都带 key（真实 React 会警告，假 React 不会）', async () => {
  // 回归：GitPanel 的 children 是数组，拆分组件之后有几个元素忘了 key —— 假 React
  // 不检查这一点，真实 React 18 会打 "Each child in a list should have a unique key"。
  // 这里把规则显式编码进测试：数组里的每个元素都必须有 props.key。
  const problems = []
  const walk = (node, path) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, path + '[]')
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item !== null && typeof item === 'object' && !Array.isArray(item) && item.props.key === undefined) {
              problems.push(String(item.type) + ' @' + path)
            }
          }
        }
        walk(child, path + '>' + String(node.type))
      }
    }
  }
  const assertKeys = (tree) => {
    walk(tree, 'root')
    assert.deepEqual(problems, [], '数组里的元素必须带 key：' + JSON.stringify(problems))
  }

  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1,
    log: [{ hash: 'abc1234', subject: 'first' }],
    remotes: [{ name: 'origin', url: 'https://example.com/a.git' }],
  }
  // ① 仓库 + 展开网络块与分支管理器
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: 'origin/main', items: [{ remote: 'origin', name: 'main', ref: 'origin/main', head: true }] },
        state: null,
      },
      pull: {
        ok: false, reason: 'unrelated', message: '两边是两套互不相关的历史',
        choices: [{ id: 'branch', label: '拿成新分支', detail: '安全', op: 'adoptRemote', params: {}, confirm: null }],
        network: false, notes: [], accelerated: 'direct', state: repoState,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  let tree = await react.settle()
  assertKeys(tree)
  await findButton(tree, '🌐').props.onClick()
  tree = await react.settle()
  assertKeys(tree)
  tree = await openBranchManager(tree, react)
  assertKeys(tree)
  await findButton(tree, '拉取').props.onClick()
  tree = await react.settle()
  assert.ok(findButton(tree, '拿成新分支') !== undefined, '前置条件：选项按钮渲染出来了')
  assertKeys(tree)

  // ② 非仓库 + 展开克隆表单
  const emptyHarness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [], notice: null,
    },
  })
  const emptyReact = makeStatefulReact()
  const emptyBundle = evaluateBundle(emptyHarness, emptyReact.api)
  mountPanel(emptyBundle.exports, emptyReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  let emptyTree = await emptyReact.settle()
  assertKeys(emptyTree)
  await findButton(emptyTree, '克隆仓库').props.onClick()
  emptyTree = await emptyReact.settle()
  assert.ok(findButton(emptyTree, '开始克隆') !== undefined, '前置条件：克隆表单渲染出来了')
  assertKeys(emptyTree)
})

test('client standalone：换工作区会收起分支管理器并清掉远程编辑器草稿（reducer 的 reset-repo）', async () => {
  const harness = makeFakeWindow({
    stateResponse: WS_A,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
    },
  })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  let tree = await react.settle()
  tree = await openBranchManager(tree, react)
  assert.ok(textOf(tree).includes('本地分支'), '前置条件：分支管理器已展开')

  // A 没有远程 → 远程区块展开后是「+ 添加远程」；点开后填一个**没保存**的地址。
  // （新版式下远程区块默认收起；「添加远程」表单在区块内部，
  //   所以先展开区块再点「+ 添加远程」。验证意图不变：草稿不能跨仓库带走。）
  tree = await openRemotesSection(tree, react)
  await findButton(tree, '+ 添加远程').props.onClick()
  tree = await react.settle()
  // 输入框的「内容」在 props.value 里（textOf 只看子节点，DOM 里的 input 也一样）。
  const remoteInput = (node) => flattenTree(node).find((child) =>
    child.type === 'input' && String(child.props.placeholder).includes('git@github.com'))
  const before = remoteInput(tree)
  assert.ok(before !== undefined, '应出现仓库地址输入框')
  before.props.onChange({ target: { value: 'https://example.com/not-saved.git' } })
  tree = await react.settle()
  assert.ok(String(remoteInput(tree).props.value).includes('not-saved'), '前置条件：草稿已填进输入框')

  // 换工作区：属于旧仓库的东西必须清掉 —— 这正是 reducer 的 'reset-repo' 在管的事。
  store.byId.s1.cwd = '/tmp/ws-b'
  tree = await react.settle()
  // 折叠头本身永远显示「本地分支」字样，展开与否要看展开态才有的内容
  // （新建分支输入框 / 「设置上游」等）。
  assert.equal(textOf(tree).includes('新分支名（新建并切换）'), false, '分支管理器属于旧仓库，切走后要收起')
  const after = remoteInput(tree)
  assert.equal(
    after !== undefined && String(after.props.value).includes('not-saved'),
    false,
    '远程地址草稿不能带到新仓库',
  )
})

// ── 9. 打开仓库主页：远程地址能推导出网页地址时给出「仓库页 ↗」入口 ──────────

test('client standalone：有 pageUrl 时远程行出现「仓库页 ↗」外链（新标签页，不经过宿主）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'git@github.com:user/demo.git' }],
    // 宿主由远程地址推导出来（scp 风格 → https 页面地址）。
    pageUrl: 'https://github.com/user/demo',
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  // 远程区块默认收起，先展开再找那一行的外链。
  const tree = await openRemotesSection(initial, react)

  const link = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'a' && node.props.href === 'https://github.com/user/demo')
  assert.ok(link !== undefined, '远程行应渲染出仓库主页链接')
  assert.equal(link.props.target, '_blank', '要新标签页打开')
  assert.equal(link.props.rel, 'noopener noreferrer', '新标签页链接要带 rel=noopener')
  assert.ok(textOf(link).includes('仓库页'), '链接要自带「仓库页」字样，用户才知道它是干嘛的')
  assert.ok(
    String(link.props.title).includes('https://github.com/user/demo'),
    '链接标题要带真实地址：' + String(link.props.title),
  )
  // 它是 <a> 不是 <button>：跳转交给浏览器（支持中键/复制地址），不发任何 op。
  assert.equal(link.props.onClick, undefined, '外链不该有 onClick')
  const opCalls = harness.calls.fetch.filter((call) => String(call.url).includes('/git-sidebar/op'))
  assert.equal(opCalls.length, 0, '打开仓库页是纯跳转，不产生任何 git 操作')
})

test('client standalone：推导不出网页地址（本地路径 / 老宿主没回 pageUrl）时不显示死链', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: '/srv/local-mirror.git' }],
    // 地址是本地路径，宿主推导不出网页地址 → pageUrl 为 null；老版本宿主干脆没这个字段。
    pageUrl: null,
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const links = flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'a'
    && typeof node.props.href === 'string' && node.props.href.startsWith('http'))
  assert.equal(links.length, 0, '本地路径远程不该出现仓库页链接：' + JSON.stringify(links.map((node) => node.props.href)))

  // 老宿主：state 里根本没有 pageUrl 字段（例如宿主还是旧版本、客户端已热重载）。
  const legacyState = Object.assign({}, repoState, { remotes: [{ name: 'origin', url: 'https://github.com/user/demo.git' }] })
  delete legacyState.pageUrl
  const legacyHarness = makeFakeWindow({ stateResponse: legacyState })
  const legacyReact = makeStatefulReact()
  const legacyBundle = evaluateBundle(legacyHarness, legacyReact.api)
  mountPanel(legacyBundle.exports, legacyReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const legacyTree = await legacyReact.settle()
  const legacyLinks = flattenTree(legacyTree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'a'
    && typeof node.props.href === 'string' && node.props.href.startsWith('http'))
  assert.equal(legacyLinks.length, 0, '没回 pageUrl 时宁可没有入口，不能给出死链')
})


// ── 8. 新增交互：单文件操作 / 提交详情 / stash 备份 / 安全切分支 / 提交并推送 ──
//
// 这一批的共同点：**每个动作都要把正确的 op 与参数交给宿主**。面板本身不执行 git，
// 参数写错（少 path、少 branch、漏 amend）在界面上完全看不出来 —— 只有断言
// POST 出去的那份 JSON 才能钉住。

/** 收集本次测试里发往 /git-sidebar/op 的请求体。 */
function opPayloads(harness) {
  return harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
}

const REPO_WITH_CHANGES = {
  ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
  ahead: 0, behind: 0,
  changes: [
    { code: ' M', path: 'f.txt', staged: false },
    { code: 'M ', path: 'g.txt', staged: true },
  ],
  changesTotal: 2,
  log: [{ hash: 'abc1234', subject: '第一次提交' }],
  remotes: [{ name: 'origin', url: 'https://github.com/user/demo.git' }],
  pageUrl: 'https://github.com/user/demo',
}

/** 同一个仓库，但工作区干净（改动数为 0）—— 用来盯「干净时还会不会轮询」。 */
const REPO_CLEAN = { ...REPO_WITH_CHANGES, changes: [], changesTotal: 0 }

test('client standalone：改动行有单文件「暂存 / 取消暂存」按钮，点击把路径交给宿主', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  // 未暂存的那条给「暂存」，已暂存的那条给「取消暂存」。
  const stage = findButton(tree, '暂存')
  assert.ok(stage !== undefined, '未暂存的改动旁边要有「暂存」按钮')
  await stage.props.onClick({ stopPropagation: () => {} })
  await react.settle()
  const add = opPayloads(harness).find((payload) => payload.op === 'add')
  assert.ok(add !== undefined, '点「暂存」应该 POST op=add')
  assert.equal(add.path, 'f.txt', '要把这一行的文件路径交给宿主（再点一次别的行不能串味）')

  const unstage = findButton(tree, '取消暂存')
  assert.ok(unstage !== undefined, '已暂存的改动旁边要有「取消暂存」按钮')
  await unstage.props.onClick({ stopPropagation: () => {} })
  await react.settle()
  const restoreStaged = opPayloads(harness).find((payload) => payload.op === 'unstageFile')
  assert.ok(restoreStaged !== undefined, '点「取消暂存」应该 POST op=unstageFile')
  assert.equal(restoreStaged.path, 'g.txt')
})

test('client standalone：「还原」只出现在工作区确实有改动的条目上，且要确认', async () => {
  const harness = makeFakeWindow({
    stateResponse: Object.assign({}, REPO_WITH_CHANGES, {
      // 三条：工作区修改（可还原）、纯暂存（没有可还原的工作区内容）、未跟踪（还原=删文件）。
      changes: [
        { code: ' M', path: 'a.txt', staged: false },
        { code: 'M ', path: 'b.txt', staged: true },
        { code: '??', path: 'c.txt', staged: false },
      ],
      changesTotal: 3,
    }),
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const restoreButtons = flattenTree(tree).filter((node) => node.type === 'button' && textOf(node) === '还原')
  assert.equal(restoreButtons.length, 1, '只有「工作区有改动」的那一行该有还原：' + restoreButtons.length)

  await restoreButtons[0].props.onClick({ stopPropagation: () => {} })
  await react.settle()
  const payload = opPayloads(harness).find((item) => item.op === 'restoreFile')
  assert.ok(payload !== undefined, '确认后应 POST op=restoreFile')
  assert.equal(payload.path, 'a.txt')
})

test('client standalone：点最近提交的一行，把提交号交给宿主并渲染详情', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      show: {
        ok: true, show: 'commit abc1234\nAuthor: 张三 <z@example.com>\n\n    第一次提交\n f.txt | 2 +-',
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const row = flattenTree(initial).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.onClick === 'function' && textOf(node) === 'abc1234第一次提交切到此')
  assert.ok(row !== undefined, '提交行本身要可点（整行是一个动作）')
  await row.props.onClick()
  const after = await react.settle()

  const show = opPayloads(harness).find((payload) => payload.op === 'show')
  assert.ok(show !== undefined, '点提交行应 POST op=show')
  assert.equal(show.ref, 'abc1234')
  assert.equal(show.noState, true, '数据型操作不该让宿主回读仓库状态')
  assert.ok(textOf(after).includes('Author: 张三'), '详情要渲染在面板里：' + textOf(after).slice(-200))

  // 再点一次收起（同一个 hash）。
  const rowAgain = flattenTree(after).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.onClick === 'function' && textOf(node) === 'abc1234第一次提交切到此')
  await rowAgain.props.onClick()
  const closed = await react.settle()
  assert.ok(!textOf(closed).includes('Author: 张三'), '再点同一行应收起详情')
})

test('client standalone：「切到此」点确认后走 stashSwitch 并带上提交号，不影响整行看详情', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      // 脏工作区（REPO_WITH_CHANGES 有 2 处改动）也走同一条 stashSwitch 通道。
      stashSwitch: { ok: true, state: REPO_WITH_CHANGES },
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const checkout = findButton(initial, '切到此')
  assert.ok(checkout !== undefined, '最近提交行右侧应有「切到此」按钮')
  await checkout.props.onClick({ stopPropagation: () => {} })
  await react.settle()

  const payloads = opPayloads(harness)
  const switched = payloads.find((payload) => payload.op === 'stashSwitch')
  assert.ok(switched !== undefined, '确认后应 POST op=stashSwitch：' + JSON.stringify(payloads))
  assert.equal(switched.commit, 'abc1234', '提交号必须原样交给宿主（它是 git 的参数）')
  assert.equal(switched.branch, undefined, '提交号模式不该混入 branch 字段')

  // 「切到此」是行内小按钮：不能顺手触发行的「看详情」。
  assert.ok(!payloads.some((payload) => payload.op === 'show'), '点小按钮不该把详情也展开')
})

test('client standalone：stash 备份能展开、恢复、删除（删除要确认）', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      stashList: {
        ok: true,
        stash: [{ ref: 'stash@{0}', text: 'WIP on main: 拉取前暂存（自动）' }],
        state: null,
      },
      stashDrop: { ok: true, state: REPO_WITH_CHANGES },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const toggle = findButton(initial, 'stash 备份')
  assert.ok(toggle !== undefined, '应有「stash 备份」入口')
  await toggle.props.onClick()
  const opened = await react.settle()

  const list = opPayloads(harness).find((payload) => payload.op === 'stashList')
  assert.ok(list !== undefined, '展开时应查一次 stashList')
  assert.equal(list.noState, true)
  assert.ok(textOf(opened).includes('WIP on main'), '备份内容要列出来：' + textOf(opened).slice(-200))

  const drop = findButton(opened, '删除')
  assert.ok(drop !== undefined, '每份备份旁边要有「删除」')
  await drop.props.onClick()
  await react.settle()
  const dropped = opPayloads(harness).find((payload) => payload.op === 'stashDrop')
  assert.ok(dropped !== undefined, '确认后应 POST op=stashDrop')
  assert.equal(dropped.ref, 'stash@{0}', 'ref 必须原样交给宿主（它是 git 的参数）')
})

test('client standalone：脏工作区点分支名 → 确认后用「安全切分支」而不是裸 checkout', async () => {
  const repoState = Object.assign({}, REPO_WITH_CHANGES, {
    changes: [{ code: ' M', path: 'f.txt', staged: false }],
    changesTotal: 1,
  })
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }, { name: 'dev', current: false }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
      stashSwitch: { ok: true, state: repoState },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const opened = await openBranchManager(initial, react)

  const devName = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.onClick === 'function' && textOf(node) === 'dev')
  assert.ok(devName !== undefined, '本地分支名本身应可点（用来切换）')
  await devName.props.onClick()
  await react.settle()

  const payloads = opPayloads(harness)
  assert.ok(
    payloads.some((payload) => payload.op === 'stashSwitch' && payload.branch === 'dev'),
    '脏工作区下应走「安全切分支」并把分支名带上：' + JSON.stringify(payloads.filter((p) => p.op !== 'branches')),
  )
  assert.ok(!payloads.some((payload) => payload.op === 'checkout'),
    '不应该再发一条会被 git 拒绝的裸 checkout')
})

test('client standalone：「提交并推送」是提交成功后的两步，amend 勾选要带进请求', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      commit: { ok: true, command: 'git commit -m x', exitCode: 0, stdout: '', stderr: '', state: REPO_WITH_CHANGES },
      push: { ok: true, command: 'git push', exitCode: 0, stdout: '', stderr: '', state: REPO_WITH_CHANGES },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  // 填写提交信息并勾上「补充上次」。
  const input = flattenTree(initial).find((node) =>
    node.type === 'input' && node.props.placeholder === '填写提交信息…（回车直接提交）')
  assert.ok(input !== undefined, '应有提交信息输入框')
  await input.props.onChange({ target: { value: '修一处笔误' } })
  const amended = await react.settle()
  const amendBox = findCheckbox(amended, '补充上次')
  assert.ok(amendBox !== undefined, '应有「补充上次」勾选框')
  await amendBox.props.onChange({ target: { checked: true } })
  const checked = await react.settle()

  const commitAndPush = findButton(checked, '提交并推送')
  assert.ok(commitAndPush !== undefined, '应有「提交并推送」按钮')
  await commitAndPush.props.onClick()
  await react.settle()

  const payloads = opPayloads(harness)
  const commit = payloads.find((payload) => payload.op === 'commit')
  assert.ok(commit !== undefined, '应该先提交')
  assert.equal(commit.message, '修一处笔误')
  assert.equal(commit.amend, true, '勾了「补充上次」就要带 amend')
  assert.ok(payloads.some((payload) => payload.op === 'push'), '提交成功后要接着推送')
  assert.ok(amendBox !== undefined)
})

test('client standalone：变基 / 浅克隆两个开关都要带进对应请求', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      pull: { ok: true, state: REPO_WITH_CHANGES },
      clone: { ok: true, clonedDir: '/tmp/ws/new', state: REPO_WITH_CHANGES },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const rebaseBox = findCheckbox(initial, '变基')
  assert.ok(rebaseBox !== undefined, '同步区应有「变基」勾选框')
  await rebaseBox.props.onChange({ target: { checked: true } })
  const rebased = await react.settle()
  await findButton(rebased, '拉取').props.onClick()
  await react.settle()
  const pull = opPayloads(harness).find((payload) => payload.op === 'pull')
  assert.equal(pull.rebase, true, '勾了变基，拉取要带 rebase')

  // 非仓库状态才有克隆表单 —— 换一个假窗口单独验浅克隆。
  const cloneHarness = makeFakeWindow({
    stateResponse: { ok: true, dir: '/tmp/empty', isRepo: false, notice: '当前目录还不是 Git 仓库' },
    opResponses: { clone: { ok: true, clonedDir: '/tmp/empty/repo', state: null } },
  })
  const cloneReact = makeStatefulReact()
  const cloneBundle = evaluateBundle(cloneHarness, cloneReact.api)
  mountPanel(cloneBundle.exports, cloneReact, sessionStore({ s1: { cwd: '/tmp/empty' } }))
  const emptyTree = await cloneReact.settle()
  await findButton(emptyTree, '克隆仓库').props.onClick()
  const withForm = await cloneReact.settle()
  const shallowBox = findCheckbox(withForm, '浅克隆')
  assert.ok(shallowBox !== undefined, '克隆表单应有「浅克隆」勾选框')
  await shallowBox.props.onChange({ target: { checked: true } })
  const shallow = await cloneReact.settle()
  const urlInput = flattenTree(shallow).find((node) =>
    node.type === 'input' && String(node.props.placeholder).includes('仓库地址'))
  await urlInput.props.onChange({ target: { value: 'https://github.com/user/demo.git' } })
  const filled = await cloneReact.settle()
  await findButton(filled, '开始克隆').props.onClick()
  await cloneReact.settle()
  const clone = opPayloads(cloneHarness).find((payload) => payload.op === 'clone')
  assert.equal(clone.depth, 1, '勾了浅克隆要带 depth')
  assert.equal(clone.url, 'https://github.com/user/demo.git')
})

test('client standalone：标签正文铺满给定的框，不再是固定定位的浮窗', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const shell = findByClass(tree, 'dgs-panel')
  assert.ok(shell !== undefined, '应渲染出面板外壳')
  const style = shell.props.style
  // 这一条是本次改造的核心：旧版是 position:fixed + right/bottom + zIndex 的浮窗，
  // 自己管位置与尺寸。现在位置、尺寸、停靠/浮动全部归右侧栏的 docking kit。
  assert.equal(style.position, undefined, '不再是固定定位的浮窗（位置由右侧栏给）')
  assert.equal(style.zIndex, undefined, '不再自己定层级（框的层级由宿主画）')
  assert.equal(style.height, '100%', '要填满右侧栏给的那块框')
  assert.equal(style.minHeight, 0, 'flex 子项默认 min-height:auto，不归零的话正文撑开会把整列顶开')
  assert.equal(style.overflow, 'hidden', '滚动收在框内，不外溢到相邻标签')
  // 旧版浮窗自己的宽度记忆已删除 —— 宽度是 docking kit 的事。
  assert.equal(style.width, undefined, '不再有插件自己记住的宽度')
})

test('client standalone：旧版浮窗遗留的 localStorage 键会被清掉（不留垃圾）', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    prefillStorage: {
      'dsh-git-sidebar-width': '420',
      'dsh-git-sidebar-min': '1',
      'dsh-git-panel-width': '500',
      'dsh-git-panel-min': '1',
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  exports.apply({ slots: makeSlots().slots })
  for (const key of ['dsh-git-sidebar-width', 'dsh-git-sidebar-min', 'dsh-git-panel-width', 'dsh-git-panel-min']) {
    assert.equal(harness.storage.has(key), false, key + ' 已无读取方，应当被清掉')
  }
})

test('client standalone：没有「最小化胶囊」这种东西了（标签的显隐归右侧栏）', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    // 旧版只要这个键是 1 就会渲染成胶囊。现在它该被清掉、并且毫无影响。
    prefillStorage: { 'dsh-git-sidebar-min': '1' },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  assert.equal(findByClass(tree, 'dgs-pill'), undefined, '没有胶囊了')
  assert.ok(findByClass(tree, 'dgs-panel') !== undefined, '照样直接渲染完整面板')
})

test('client standalone：窗口重新获得焦点时静默刷新一次状态（不点亮「同步中…」）', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  await react.settle()

  const focus = harness.listeners.get('focus')
  assert.equal(typeof focus, 'function', '应注册窗口 focus 监听（回到浏览器时自动刷新）')
  const before = harness.calls.fetch.filter((call) => String(call.url).includes('/git-sidebar/state')).length
  focus()
  const after = await react.settle()
  const stateCalls = harness.calls.fetch.filter((call) => String(call.url).includes('/git-sidebar/state')).length
  assert.equal(stateCalls, before + 1, '获得焦点应重新读一次状态')
  assert.ok(!textOf(after).includes('同步中…'), '后台刷新不该点亮「同步中…」打扰用户')
})

test('client standalone：工作区干净时也会慢速轮询（外部的切分支 / 提交不会一直不显示）', async () => {
  // 有未提交改动 → 20 秒快档：胶囊红点与改动数要跟得上编辑器。
  const dirty = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const dirtyReact = makeStatefulReact()
  mountPanel(evaluateBundle(dirty, dirtyReact.api).exports, dirtyReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  await dirtyReact.settle()
  const dirtyTimer = dirty.timers.find((timer) => timer.cleared !== true)
  assert.ok(dirtyTimer !== undefined, '有未提交改动时应注册轮询定时器')
  assert.equal(dirtyTimer.ms, 20000, '有改动走 20 秒快档')

  // 干净仓库 → 60 秒慢档，但**必须存在**：切分支 / 拉取 / 别人替你提交都发生在干净的时候，
  // 没有这条轮询，面板会一直停在旧分支上，直到用户碰巧切了一次标签页。
  const clean = makeFakeWindow({ stateResponse: REPO_CLEAN })
  const cleanReact = makeStatefulReact()
  mountPanel(evaluateBundle(clean, cleanReact.api).exports, cleanReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  await cleanReact.settle()
  const cleanTimer = clean.timers.find((timer) => timer.cleared !== true)
  assert.ok(cleanTimer !== undefined, '干净仓库也要轮询：否则外部的切分支 / 提交面板永远不显示')
  assert.equal(cleanTimer.ms, 60000, '干净仓库走 60 秒慢档')

  // 不是仓库时不轮询（没有可读的状态，白跑 git 进程）。
  const noRepo = makeFakeWindow()
  const noRepoReact = makeStatefulReact()
  mountPanel(evaluateBundle(noRepo, noRepoReact.api).exports, noRepoReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  await noRepoReact.settle()
  assert.equal(
    noRepo.timers.filter((timer) => timer.cleared !== true).length,
    0,
    '「不是仓库」时不该注册轮询定时器',
  )
})

test('client standalone：分支管理开着时状态一变就重列分支（外部删掉的分支不会留在列表里）', async () => {
  // 宿主每次回的分支列表可以变：先用「main + master」，外部删掉 master 之后只回 main。
  const branchReply = {
    ok: true,
    branches: { current: 'main', items: [{ name: 'main', current: true }, { name: 'master' }] },
    remoteBranches: { defaultRef: null, items: [] },
    state: null,
  }
  const harness = makeFakeWindow({
    // 函数形态：每次读状态回一个**新对象**（真实 fetch 解析 JSON 也是新对象），
    // 这样「state.snapshot 换了对象 → 该重跑那条 effect」才成立。
    stateResponse: () => ({ ...REPO_WITH_CHANGES }),
    opResponses: { branches: branchReply },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  let tree = await openBranchManager(initial, react)
  const branchCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
    .filter((payload) => payload.op === 'branches')
  assert.equal(branchCalls().length, 1, '展开管理器查一次分支')
  assert.ok(
    flattenTree(tree).map(textOf).some((text) => text.trim() === 'master'),
    '刚展开时列表里应有 master',
  )

  // 外部的删除（终端 / AI 工具 / 另一个会话）发生了：下一次状态读之后，列表必须跟着重列。
  branchReply.branches = { current: 'main', items: [{ name: 'main', current: true }] }
  const refresh = harness.listeners.get('focus')
  assert.equal(typeof refresh, 'function', '需要 focus 触发的静默刷新来模拟「状态变了」')
  const stateCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/state')).length
  const beforeState = stateCalls()
  refresh()
  tree = await react.settle()
  assert.ok(stateCalls() > beforeState, `focus 应重新读一次状态（${beforeState} → ${stateCalls()}）`)

  assert.equal(branchCalls().length, 2, '状态一变要重新列一次分支：' + JSON.stringify(branchCalls()))
  assert.ok(
    !flattenTree(tree).map(textOf).some((text) => text.trim() === 'master'),
    '外部删掉的分支不该继续挂在列表里',
  )
})

// ── 9. UI：底部状态条 / 固定结果区 / diff 抬头条 / 忙碌指示 ───────────────────
//
// 这一组盯的是「版面结构」本身：哪些东西必须常驻可见（状态、命令结果、
// 待决定的事），哪些只是装饰（转圈、抬头条）。它们不是内部实现细节 ——
// 面板长起来之后，「结果滚走了」「不知道自己在哪个分支」正是最常被抱怨的两件事。

/** 按 className 找一个元素：className 可能是 'a b' 形态，按词匹配。 */
function findByClass(tree, className) {
  return flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes(className))
}

/** 状态条上那颗表示「上一次操作成没成」的小点。 */
function statusDot(tree) {
  const status = findByClass(tree, 'dgs-status')
  if (status === undefined) return undefined
  return flattenTree(status).find((node) => node.type === 'span' && textOf(node) === '●')
}

test('client standalone：底部状态条常驻显示分支 / 改动数 / 上游，且不在正文滚动区里', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const status = findByClass(tree, 'dgs-status')
  assert.ok(status !== undefined, '应渲染出底部状态条')
  const text = textOf(status)
  assert.ok(text.includes('main'), '状态条要写清当前分支：' + text)
  assert.ok(text.includes('2 处改动未提交'), '状态条要写清还有多少改动：' + text)
  assert.ok(text.includes('→ origin/main'), '状态条要写清上游：' + text)

  const body = findByClass(tree, 'dgs-body')
  assert.ok(body !== undefined, '应渲染出正文滚动区')
  assert.ok(
    !flattenTree(body).some((node) => node !== null && typeof node === 'object'
      && node.props !== undefined && node.props.className === 'dgs-status'),
    '状态条必须在正文滚动区之外，否则一滚就看不见了',
  )
  assert.ok(body.props.ref !== undefined && body.props.ref !== null, '正文要挂 ref（状态条点了要能回到顶部）')
})

test('client standalone：命令结果固定在正文之外，并且可以「清空」收起', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponse: { ok: true, stdout: 'done-ok', state: REPO_WITH_CHANGES },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  assert.equal(outputBars(initial).length, 0, '还没操作过就不该有结果区')
  assert.equal(findButton(initial, '清空'), undefined, '没有结果时不该有「清空」')

  await findButton(initial, '全部暂存').props.onClick()
  const after = await react.settle()
  assert.ok(outputBars(after).some((text) => text.includes('done-ok')), '操作结果要出现在结果区')
  const body = findByClass(after, 'dgs-body')
  assert.equal(
    flattenTree(body).filter((node) => node.type === 'pre').length, 0,
    '结果区必须在正文滚动区之外：点完按钮不用往下翻也知道刚才成没成',
  )

  // 点一下状态条（ref 上是假节点，这里自己补一个可写的 scrollTop）也要能工作。
  const dot = statusDot(after)
  assert.ok(dot !== undefined, '状态条上应有结果指示点')

  await findButton(after, '清空').props.onClick()
  const cleared = await react.settle()
  assert.equal(outputBars(cleared).length, 0, '「清空」应把结果区收起来')
  assert.equal(findButton(cleared, '清空'), undefined, '结果区没了，按钮也要跟着消失')
})

test('client standalone：状态条上的小点跟着上一次操作的结果变色', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: {
      addAll: { ok: true, state: REPO_WITH_CHANGES },
      discard: { ok: false, message: '丢弃失败', state: REPO_WITH_CHANGES },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  assert.ok(statusDot(initial).props.style.color.includes('label-tertiary'), '还没操作过时是中性色')

  await findButton(initial, '全部暂存').props.onClick()
  const okTree = await react.settle()
  assert.ok(
    statusDot(okTree).props.style.color.includes('state-success-primary'),
    '成功之后点要变绿：' + statusDot(okTree).props.style.color,
  )

  await findButton(okTree, '丢弃改动').props.onClick()
  const failTree = await react.settle()
  assert.ok(
    statusDot(failTree).props.style.color.includes('state-error-primary'),
    '失败之后点要变红：' + statusDot(failTree).props.style.color,
  )
})

test('client standalone：展开 diff 时先给出抬头条（哪个文件、哪一份）', async () => {
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponse: {
      ok: true, diff: 'diff --git a/f.txt b/f.txt\n@@ -1 +1,2 @@\n one\n+two\n', state: REPO_WITH_CHANGES,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  await clickable.props.onClick()
  const after = await react.settle()

  const bar = findByClass(after, 'dgs-difftitle')
  assert.ok(bar !== undefined, '展开的 diff 上方应有抬头条')
  const text = textOf(bar)
  assert.ok(text.includes('f.txt'), '抬头条要写清是哪个文件：' + text)
  assert.ok(text.includes('未暂存'), '抬头条要写清这是工作区那份还是已暂存那份：' + text)
  assert.ok(outputBars(after).some((line) => line.includes('+two')), 'diff 内容照常渲染')
})

test('client standalone：忙的时候头部是「同步中…」加一个纯装饰的转圈', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    opResponses: { addAll: gate.then(() => ({ ok: true, stdout: 'done', state: REPO_WITH_CHANGES })) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  assert.equal(findByClass(initial, 'dgs-spin'), undefined, '不忙的时候不该有转圈')

  // 不 await：让这次操作悬在「正在进行」的状态上，正好观察忙碌期的界面。
  const pending = findButton(initial, '全部暂存').props.onClick()
  const busyTree = await react.settle()
  assert.ok(textOf(busyTree).includes('同步中…'), '忙的时候头部要显示「同步中…」')
  const spin = findByClass(busyTree, 'dgs-spin')
  assert.ok(spin !== undefined, '忙的时候应有一个转圈')
  assert.equal(textOf(spin), '', '转圈里不能有文字：可见文案只有「同步中…」一句')

  release()
  await pending
  const done = await react.settle()
  assert.equal(findByClass(done, 'dgs-spin'), undefined, '操作结束后转圈要消失')
})

test('client standalone：标签正文直接用 sessionId 取本会话工作目录（比旧版的启发式精确）', async () => {
  // 两个会话都在，只有 s2 被主视图持有；但本标签属于 s1。
  // 旧版（root scope 的 shell.overlay）拿不到 sessionId，只能认「被主视图持有的那一行」，
  // 于是会错认成 s2 的目录。现在 sidebar.right.pane.tab 是 session scope，标准 props
  // 里直接带 sessionId，所以必须取 s1 的 cwd。
  const store = sessionStore({
    s1: { cwd: '/tmp/belongs-to-tab' },
    s2: { cwd: '/tmp/on-screen' },
  })
  // 让 s2 成为「被主视图持有」的那一行，制造旧启发式会走错的条件。
  store.byId.s2.retainedBy = { mainView: 1 }
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, store, { sessionId: 's1' })
  await react.settle()

  const stateCalls = harness.calls.fetch.filter((call) => String(call.url).includes('/git-sidebar/state'))
  assert.ok(stateCalls.length > 0, '应读一次状态')
  assert.ok(
    stateCalls.some((call) => decodeURIComponent(String(call.url)).includes('/tmp/belongs-to-tab')),
    '要按 sessionId 取本标签所属会话的目录，而不是「主视图持有的那一行」：'
    + JSON.stringify(stateCalls.map((call) => call.url)),
  )
})

test('client standalone：拿不到 sessionId 时退回旧启发式（不至于没有目录）', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  // 不传 sessionId：模拟 slot 契约变化 / 测试里直接渲染面板。
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/fallback', retainedBy: { mainView: 1 } } }), { sessionId: null })
  await react.settle()
  const stateCalls = harness.calls.fetch.filter((call) => String(call.url).includes('/git-sidebar/state'))
  assert.ok(
    stateCalls.some((call) => decodeURIComponent(String(call.url)).includes('/tmp/fallback')),
    '没有 sessionId 时仍要能认出当前会话的目录',
  )
})

test('client standalone：窄栏下分支名与「⋯」是两段可换行的行（不把名字挤没）', async () => {
  // 现场：右侧栏可拖到 RIGHTBAR_MIN=300。不换行时固定不动的「⋯」先占位，
  // 分支名被压到 28px（实测渲染成 `for...`）——整块面板最该看清的一项反而看不清。
  // 现在这一行是 S.rowWrap：左半（点 + 名字 + 跟踪标签）会占满整行，
  // 右半（⋯）在放不下时整组掉到第二行。
  const harness = makeFakeWindow({
    stateResponse: REPO_WITH_CHANGES,
    // 打开分支管理器会发一条 branches op：本地分支行要靠它才有内容。
    opResponses: {
      branches: {
        ok: true,
        branches: {
          current: 'feature/a-rather-long-branch-name',
          items: [
            { name: 'feature/a-rather-long-branch-name', current: true },
            { name: 'main', current: false },
          ],
        },
        remoteBranches: { defaultRef: null, items: [] },
        branchUpstreams: {
          'feature/a-rather-long-branch-name': { upstream: null, ahead: 0, behind: 0, gone: false },
        },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  // 分支行：带 dgs-track 类的那几行（改动清单的行也带 dgs-rowitem，
  // 但只有分支行有跟踪标签，用它把两类行区分开）。
  const rows = flattenTree(opened).filter((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem')
    && flattenTree(node).some((inner) => inner !== null && typeof inner === 'object'
      && inner.props !== undefined && inner.props.className === 'dgs-track'))
  assert.ok(rows.length > 0, '应有本地分支行')
  const row = rows[0]
  assert.equal(row.props.style.flexWrap, 'wrap', '分支行必须允许换行（窄栏下让名字拿整行）')
  // 行的直接子节点应当是「左半 + 右半」两段，而不是把名字和按钮平铺在一起。
  const kids = (row.children ?? []).filter((child) => child !== null && typeof child === 'object' && child.props !== undefined)
  assert.equal(kids.length, 2, '分支行应当是「左半 + 右半」两段')
  assert.ok(
    kids.some((child) => child.props.style.flex === '0 0 auto'),
    '右半（⋯ 那一组）要 flex 0 0 auto：不许被压扁，放不下就整组换行',
  )
  assert.ok(
    kids.some((child) => child.props.style.flex === '1 1 auto'),
    '左半（名字那一组）要 flex 1 1 auto：占满整行',
  )
})

test('client standalone：头部的分支行可换行，分支名有最小宽度（窄栏下不被压没）', async () => {
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  // 新版式：分支上下文住在头部（dgs-head），那一行是「<分支名> → <上游> 领先/落后」。
  const head = findByClass(tree, 'dgs-head')
  assert.ok(head !== undefined, '头部上下文条要在')
  const row = flattenTree(head).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && Array.isArray(node.children)
    && typeof textOf(node) === 'string'
    && textOf(node).includes(REPO_WITH_CHANGES.branch)
    && node.props.style !== undefined
    && node.props.style.flexWrap === 'wrap')
  assert.ok(row !== undefined, '头部的分支行必须允许换行（否则 300px 下分支名被压没）')
  // 名字那一项要有最小宽度，不能缩成几个字符。
  const nameSpan = flattenTree(row).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.title === 'string' && node.props.title.startsWith('当前分支'))
  assert.ok(nameSpan !== undefined, '找不到分支名那一段')
  assert.ok(
    typeof nameSpan.props.style.minWidth === 'string' && nameSpan.props.style.minWidth.endsWith('em'),
    '分支名要给一个最小宽度（4em 档），否则会被压到只剩省略号：' + nameSpan.props.style.minWidth,
  )
  // 头部不再有旧浮窗的大标题（右侧栏标签栏已经写着 Git，正文里不再重复）。
  assert.equal(textOf(head).includes('🐙'), false, '头部不该再有 🐙 大标题')
})

test('client standalone：面板仍是「铺满框」而不是浮窗（回归：别把 fixed 加回来）', async () => {
  // 这一条同时钉住两个方向：面板不能自己定位（那是旧版浮窗的做法），
  // 也不能没有高度约束（那样正文一长就把整列顶开）。
  const harness = makeFakeWindow({ stateResponse: REPO_WITH_CHANGES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const panel = findByClass(tree, 'dgs-panel')
  assert.equal(panel.props.style.position, undefined, '不允许自己定位')
  assert.equal(panel.props.style.height, '100%', '必须铺满给定的框')
  assert.equal(panel.props.style.minHeight, 0, 'flex 子项要能收缩，否则正文撑开会顶开整列')
  // 旧版浮窗的那几样东西都不该再出现。
  for (const key of ['right', 'bottom', 'zIndex', 'boxShadow', 'borderRadius', 'maxHeight']) {
    assert.equal(panel.props.style[key], undefined, '不该再有浮窗属性 ' + key)
  }
})

// ── 本地分支名 ≠ 上游分支名：提前说 / 就地拦（本次的真实现场） ──────────────
//
// 现场：本地 `origin-main` 跟踪 `origin/main`。用户点了「推送」才看到一句
// `fatal: The upstream branch of your current branch does not match …` ——
// 面板既没提前提醒，也没告诉他怎么办。下面两条盯的是「提前」和「不再造出这种名字」。

/** 按 placeholder 找输入框：页面里 class 为 dgs-input 的输入框有好几个。 */
function findInputByPlaceholder(tree, fragment) {
  return flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.props !== undefined
    && node.type === 'input' && typeof node.props.placeholder === 'string'
    && node.props.placeholder.includes(fragment))
}

test('client standalone：本地分支名与上游名不一致时，状态条提前标出来', async () => {
  const mismatchState = { ...REPO_WITH_CHANGES, branch: 'origin-main', upstream: 'origin/main' }
  const harness = makeFakeWindow({ stateResponse: mismatchState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const warn = findByClass(tree, 'dgs-status-warn')
  assert.ok(warn !== undefined, '两边名字不一致时状态条要给一个提醒')
  assert.equal(textOf(warn), '名称不一致')
  assert.match(String(warn.props.title), /push/, '提示里要说到「推送会被 git 拒绝」这件事')

  // 同名时绝不能出现这个标（否则天天误报，用户就不看了）。
  const normal = makeFakeWindow({ stateResponse: { ...REPO_WITH_CHANGES, branch: 'main', upstream: 'origin/main' } })
  const normalReact = makeStatefulReact()
  mountPanel(
    evaluateBundle(normal, normalReact.api).exports,
    normalReact,
    sessionStore({ s1: { cwd: '/tmp/demo' } }),
  )
  const normalTree = await normalReact.settle()
  assert.equal(findByClass(normalTree, 'dgs-status-warn'), undefined, '同名时不该出现提醒')

  // 没有上游时也不该报（那是「未设上游」，另一回事）。
  const noUpstream = makeFakeWindow({ stateResponse: { ...REPO_WITH_CHANGES, branch: 'main', upstream: null } })
  const noUpstreamReact = makeStatefulReact()
  mountPanel(
    evaluateBundle(noUpstream, noUpstreamReact.api).exports,
    noUpstreamReact,
    sessionStore({ s1: { cwd: '/tmp/demo' } }),
  )
  assert.equal(
    findByClass(await noUpstreamReact.settle(), 'dgs-status-warn'),
    undefined,
    '没有上游时不该报「名称不一致」',
  )
})

test('client standalone：新建分支名撞上远端名时就地拦下，不发给宿主', async () => {
  const harness = makeFakeWindow({
    stateResponse: {
      ...REPO_WITH_CHANGES,
      remotes: [{ name: 'origin', url: 'https://github.com/user/demo.git' }],
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  let tree = await openBranchManager(initial, react)

  const createdOps = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
    .filter((payload) => payload.op === 'createBranch')

  // 命中：输入 origin/main（本地分支会和 refs/remotes/origin/main 变成两个同名引用）。
  findInputByPlaceholder(tree, '新分支名').props.onChange({ target: { value: 'origin/main' } })
  tree = await react.settle()
  const warn = findByClass(tree, 'dgs-branchname-warn')
  assert.ok(warn !== undefined, '撞远端名时要就地告警')
  assert.ok(textOf(warn).includes('origin'), '告警要指出撞的是哪个远端名：' + textOf(warn))
  assert.equal(findButton(tree, '新建').props.disabled, true, '撞名时「新建」按钮要锁住')

  // 输入框回车那条路**不经过**按钮的 disabled —— 钩子里必须再挡一次。
  findInputByPlaceholder(tree, '新分支名').props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await react.settle()
  assert.equal(createdOps().length, 0, '撞名的分支名不该发给宿主：' + JSON.stringify(createdOps()))

  // 去掉前缀就该放行（不能把 feat/x 这类正常分支名一起误伤）。
  findInputByPlaceholder(tree, '新分支名').props.onChange({ target: { value: 'main' } })
  tree = await react.settle()
  assert.equal(findByClass(tree, 'dgs-branchname-warn'), undefined, '正常分支名不该报警')
  assert.equal(findButton(tree, '新建').props.disabled, false, '正常分支名要能建')
})

// ── 两个远程指向同一地址：提示 + 一键删多余的 ──────────────────────────────
//
// 现场：remote `main` 与 `origin` 指向同一个 GitHub 地址。除了冗余，它还会让
// `git log main` / `git branch -D main` 报 `warning: refname 'main' is ambiguous`。
// 判断在宿主侧（git.js 的 duplicateRemotes），这里盯的是「提示出现 + 一键能删对那个」。

test('client standalone：两个远程指向同一地址时给出警告行与一键删除', async () => {
  const duplicated = {
    ...REPO_WITH_CHANGES,
    remotes: [
      { name: 'main', url: 'https://github.com/user/demo.git' },
      { name: 'origin', url: 'https://github.com/user/demo.git' },
    ],
    duplicateRemotes: [{ url: 'https://github.com/user/demo.git', keep: 'origin', remove: ['main'] }],
  }
  const harness = makeFakeWindow({ stateResponse: duplicated })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const row = findByClass(tree, 'dgs-dup-remote')
  assert.ok(row !== undefined, '重复远程要给一行提示')
  assert.ok(textOf(row).includes('main'), '提示里要点名重复的那个远程：' + textOf(row))
  assert.ok(textOf(row).includes('origin'), '也要说清保留的是哪个')

  const remove = findButton(tree, '删掉 main')
  assert.ok(remove !== undefined, '提示行上要有「删掉 main」')
  await remove.props.onClick()
  await react.settle()
  const removed = harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-sidebar/op'))
    .map((call) => JSON.parse(call.init.body))
    .filter((payload) => payload.op === 'removeRemote')
  assert.equal(removed.length, 1, '应该 POST 一次 removeRemote')
  assert.equal(removed[0].name, 'main', '删的必须是提示里点名的那个远程')

  // 没有重复时不该出现这一行（否则天天挂着一条无意义的警告）。
  const clean = makeFakeWindow({ stateResponse: { ...REPO_WITH_CHANGES, duplicateRemotes: [] } })
  const cleanReact = makeStatefulReact()
  mountPanel(evaluateBundle(clean, cleanReact.api).exports, cleanReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  assert.equal(
    findByClass(await cleanReact.settle(), 'dgs-dup-remote'),
    undefined,
    '没有重复远程时不该有这一行',
  )
})

// ── 多远程：每个远程一行、各自编辑；编辑谁就保存到谁 ─────────────────────────
//
// 现场（本次真实仓库）：同时配了 `fork`（你的 fork）与 `origin`（官方）。
// 旧面板只显示 remotes[0]（按名字排序 = fork），而展开的编辑框名字写死
// `origin`、地址却播种自 remotes[0] —— 点「改」再点「保存」会把 **origin 的地址
// 改成 fork 的地址**（本地实测复现：两个远程从此指向同一个 fork，官方地址丢失）。
// 下面三条钉住修复后的行为：列全部、编辑谁是谁、保存发给正确的名字。

const TWO_REMOTES = {
  ...REPO_WITH_CHANGES,
  remotes: [
    { name: 'fork', url: 'git@github.com:me/demo.git' },
    { name: 'origin', url: 'https://github.com/up/demo.git' },
  ],
  duplicateRemotes: [],
}

test('client standalone：多个远程全部列出（不再只显示第一个）', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  const rows = flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-remote-row'))
  assert.equal(rows.length, 2, '两个远程要各占一行，实际：' + JSON.stringify(rows.map(textOf)))

  const text = textOf(tree)
  assert.ok(text.includes('fork'), 'fork 要出现在面板上')
  assert.ok(text.includes('git@github.com:me/demo.git'), 'fork 的地址要出现')
  assert.ok(text.includes('https://github.com/up/demo.git'), 'origin 的地址也要出现（旧版完全看不到它）')
})

test('client standalone：点某个远程的「改」，编辑器播种的是那一个远程（回归：串线会把 origin 改指向 fork）', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  // 找到 fork 那一行的「改」按钮（按行内定位，不按全局第一个按钮 —— 那正是旧 bug 的成因）。
  const forkRow = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-remote-row')
    && textOf(node).includes('fork'))
  assert.ok(forkRow !== undefined, '前置条件：fork 行渲染出来了')
  const editBtn = (forkRow.children ?? []).find((child) =>
    child !== null && typeof child === 'object' && child.type === 'button' && textOf(child) === '改')
  assert.ok(editBtn !== undefined, 'fork 行要有「改」')
  await editBtn.props.onClick()
  const opened = await react.settle()

  // 编辑器里的地址框必须是 fork 的地址（旧版这里是 remotes[0]=fork 的地址，
  // 但名字框写着 origin —— 保存就把 origin 改指向 fork）。
  const urlInput = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'input'
    && String(node.props.placeholder).includes('git@github.com'))
  assert.ok(urlInput !== undefined, '编辑器要出现地址输入框')
  assert.equal(String(urlInput.props.value), 'git@github.com:me/demo.git',
    '编辑 fork 时地址框里要是 fork 的地址')

  // 名字在编辑态是只读文本（不可改），且显示的正是 fork。
  const editBox = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className === 'dgs-remote-edit')
  assert.ok(editBox !== undefined, '应渲染出编辑框')
  assert.ok(textOf(editBox).includes('fork'), '编辑框要写明改的是哪个远程')

  // 点「保存」→ 发给宿主的必须是 fork（而不是写死的 origin）。
  const save = findButton(opened, '保存')
  assert.ok(save !== undefined, '编辑器里要有「保存」')
  await save.props.onClick()
  await react.settle()
  const saved = opPayloads(harness).filter((payload) => payload.op === 'setRemote')
  assert.equal(saved.length, 1, '应该 POST 一次 setRemote：' + JSON.stringify(opPayloads(harness)))
  assert.equal(saved[0].name, 'fork', '保存必须落到被点的那一个远程，而不是写死的 origin')
  assert.equal(saved[0].url, 'git@github.com:me/demo.git', '地址也要是那一个远程的')
})

test('client standalone：「+ 添加远程」打开的是新增表单（名字可填），保存后走 setRemote', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  const add = findButton(tree, '+ 添加远程')
  assert.ok(add !== undefined, '应有「+ 添加远程」入口')
  await add.props.onClick()
  const opened = await react.settle()

  const nameInput = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'input'
    && String(node.props.placeholder) === 'origin')
  assert.ok(nameInput !== undefined, '新增表单要有可填的名字框')
  nameInput.props.onChange({ target: { value: 'upstream' } })
  const filled = await react.settle()
  findInputByPlaceholder(filled, 'git@github.com').props.onChange(
    { target: { value: 'https://github.com/official/demo.git' } })
  const ready = await react.settle()
  await findButton(ready, '保存').props.onClick()
  await react.settle()

  const saved = opPayloads(harness).filter((payload) => payload.op === 'setRemote')
  assert.equal(saved.length, 1, '应该 POST 一次 setRemote')
  assert.equal(saved[0].name, 'upstream', '新增用的名字来自输入框')
  assert.equal(saved[0].url, 'https://github.com/official/demo.git')
})

// ── 本地/远端的对应关系：本地分支要标出「跟踪谁」，远端分支要按远程分组 ────────
//
// 用户原来的抱怨就是「远程和本地显示混乱、分不开」。这两条盯的正是分开之后
// 最关键的一件事：**每个本地分支对应哪个远端**，以及**每个远端分支属于哪个远程**。

test('client standalone：本地分支行标出跟踪关系（→ origin/main / 未跟踪）', async () => {
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: {
      branches: {
        ok: true,
        branches: {
          current: 'main',
          items: [{ name: 'main', current: true }, { name: 'local-only', current: false }],
        },
        remoteBranches: { defaultRef: 'origin/main', items: [] },
        branchUpstreams: {
          main: { upstream: 'origin/main', ahead: 1, behind: 2 },
          'local-only': { upstream: null, ahead: 0, behind: 0 },
        },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  const tags = flattenTree(opened).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.className === 'string' && node.props.className === 'dgs-track')
  const texts = tags.map(textOf)
  assert.ok(texts.some((text) => text.includes('→ origin/main')),
    '跟踪 origin/main 的分支要标出来，实际：' + JSON.stringify(texts))
  assert.ok(texts.some((text) => text.includes('领先 1') && text.includes('落后 2')),
    '领先/落后要跟在跟踪关系后面（用户才知道推还是拉），实际：' + JSON.stringify(texts))
  assert.ok(texts.some((text) => text === '未跟踪'),
    '没有上游的分支要明说「未跟踪」，实际：' + JSON.stringify(texts))
})

/** 找面板里那个「推送到」下拉（按 className 定位，因为它是本特性唯一的 select）。 */
function findPushTargetSelect(tree) {
  return flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'select'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-push-target'))
}

/** 某个远程行的「推送到此」按钮（按行内定位，避免多行时点错）。 */
function findPushToRemoteButton(tree, remoteName) {
  const row = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-remote-row')
    && textOf(node).includes(remoteName))
  if (row === undefined) return undefined
  return flattenTree(row).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'button' && textOf(node) === '推送到此')
}

// ── 推到指定的那个远程（本次需求） ───────────────────────────────────────────
//
// 现场：origin = 别人的仓库（只能读）、fork = 自己的。面板此前只有裸 `git push`，
// 于是「我想推 fork」这件事在界面上根本表达不出来。这四条盯的是：
// 选得中（下拉 + 远程行两个入口）、发得对（宿主收到的就是选的那个远程）、记得住（按仓库）。

test('client standalone：「推送到」下拉列出跟随上游 + 每个远程，选完「推送」就把远程交给宿主', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const select = findPushTargetSelect(tree)
  assert.ok(select !== undefined, '同步区要有「推送到」下拉')
  assert.equal(select.props.value, '', '默认是「跟随上游」（裸 push，老行为）')
  const options = (select.children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  assert.deepEqual(options.map((item) => item.props.value), ['', 'fork', 'origin'], '第一项是跟随上游，其余按远程列出')

  // 选 fork → 下拉的值跟着变，并且记住（localStorage 按仓库目录一份）
  select.props.onChange({ target: { value: 'fork' } })
  const picked = await react.settle()
  assert.equal(findPushTargetSelect(picked).props.value, 'fork')
  const stored = JSON.parse(String(harness.storage.get('dsh-git-sidebar-push-remote')))
  assert.deepEqual(stored, { '/tmp/demo': 'fork' }, '选择要按仓库记住：' + JSON.stringify(stored))

  // 点「推送」→ 宿主收到的是 fork（而不是裸 push）
  await findButton(picked, '推送').props.onClick()
  await react.settle()
  const pushes = opPayloads(harness).filter((payload) => payload.op === 'push')
  assert.equal(pushes.length, 1, '应 POST 一次 push：' + JSON.stringify(opPayloads(harness)))
  assert.equal(pushes[0].remote, 'fork', '推的必须是被选中的那个远程')
})

test('client standalone：远程行的「推送到此」直接把那个远程交给宿主，并记住它', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)
  assert.equal(findPushTargetSelect(tree).props.value, '', '前置条件：还没选过，默认跟随上游')

  const button = findPushToRemoteButton(tree, 'fork')
  assert.ok(button !== undefined, 'fork 行要有「推送到此」')
  await button.props.onClick()
  const after = await react.settle()

  const pushes = opPayloads(harness).filter((payload) => payload.op === 'push')
  assert.equal(pushes.length, 1, '应 POST 一次 push')
  assert.equal(pushes[0].remote, 'fork', '点哪一行就推哪一行')
  // 它和「推送到」下拉是同一件事的两个入口：点完要**记住**这个远程，
  // 否则用户点完这一行再点「推送」会突然推回原处（文档承诺了会记住）。
  assert.equal(findPushTargetSelect(after).props.value, 'fork', '「推送到此」之后下拉应停在 fork')
  assert.deepEqual(
    JSON.parse(String(harness.storage.get('dsh-git-sidebar-push-remote'))),
    { '/tmp/demo': 'fork' },
    '选择的远程要按仓库记下来',
  )
})

test('client standalone：记住的远程按仓库分开，且远程没了就干净退回「跟随上游」', async () => {
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    // 这个仓库记住了 fork、另一个目录记住了 origin；当前会话在 /tmp/demo。
    prefillStorage: { 'dsh-git-sidebar-push-remote': JSON.stringify({ '/tmp/demo': 'fork', '/tmp/ws-b': 'origin' }) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  assert.equal(findPushTargetSelect(tree).props.value, 'fork', '切回这个仓库时要记得上次推的是 fork')

  // 宿主状态说 fork 这个远程已经被删掉了（终端 / AI 工具删的不经过面板）：
  // 记忆里那个名字拿不出去，必须退回「跟随上游」，而不是拿它去推。
  const stale = makeFakeWindow({
    stateResponse: { ...TWO_REMOTES, remotes: [{ name: 'origin', url: 'https://github.com/up/demo.git' }] },
    prefillStorage: { 'dsh-git-sidebar-push-remote': JSON.stringify({ '/tmp/demo': 'fork' }) },
  })
  const staleReact = makeStatefulReact()
  const staleExports = evaluateBundle(stale, staleReact.api).exports
  mountPanel(staleExports, staleReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const staleTree = await staleReact.settle()
  assert.equal(findPushTargetSelect(staleTree).props.value, '', '远程不在了就退回跟随上游')
  const choices = (findPushTargetSelect(staleTree).children ?? []).filter((child) => child.type === 'option')
  assert.deepEqual(choices.map((item) => item.props.value), ['', 'origin'], '下拉里也只列当前存在的远程')

  await findButton(staleTree, '推送').props.onClick()
  await staleReact.settle()
  const pushes = opPayloads(stale).filter((payload) => payload.op === 'push')
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].remote, undefined, '退回默认时是裸 push（不带 remote）')
})

test('client standalone：服务器说没写权限且只有一个远程时，直接打开「添加远程」表单', async () => {
  const denied = {
    ok: false, op: 'push', exitCode: 128, stdout: '', stderr: 'remote: Permission to up/demo.git denied to me.',
    message: 'remote: Permission to up/demo.git denied to me.', reason: 'no-permission',
    hint: '服务器拒绝写入：你的账号对这个远程没有写权限。', choices: null, state: TWO_REMOTES,
  }
  const harness = makeFakeWindow({
    // 只有 origin 一个远程（就是刚被拒的那个）：没有别的远程可推 → 引导去加远程。
    stateResponse: { ...TWO_REMOTES, remotes: [{ name: 'origin', url: 'https://github.com/up/demo.git' }] },
    opResponses: { push: denied },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  await findButton(tree, '推送').props.onClick()
  const after = await react.settle()

  // 「+ 添加远程」的表单打开了：名字框默认 fork，告警里带宿主那句中文提示。
  const nameInput = flattenTree(after).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'input'
    && String(node.props.placeholder) === 'origin' && String(node.props.value) === 'fork')
  assert.ok(nameInput !== undefined, '应打开「添加远程」表单并预填 fork：' + textOf(after).slice(0, 400))
  assert.ok(textOf(after).includes('写权限'), '要把宿主的提示显示出来')

  // 多远程时不该抢着开表单：宿主的按钮组（推送到 fork）才是那条路。
  const withFork = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: {
      push: { ...denied, choices: [{ id: 'push-to-fork', label: '推送到 fork', detail: '换成远程 fork 再推一次', op: 'push', params: { remote: 'fork' } }] },
    },
  })
  const forkReact = makeStatefulReact()
  mountPanel(evaluateBundle(withFork, forkReact.api).exports, forkReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const forkTree = await forkReact.settle()
  await findButton(forkTree, '推送').props.onClick()
  const forkAfter = await forkReact.settle()
  assert.ok(findButton(forkAfter, '推送到 fork') !== undefined, '宿主给的路要渲染成按钮')
  //「+ 添加远程」这个入口平时就在（那是加远程的常驻按钮），这里要盯的是**表单没被打开**。
  const addFormNameInput = flattenTree(forkAfter).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'input'
    && String(node.props.placeholder) === 'origin')
  assert.equal(addFormNameInput, undefined, '有别的远程可试时不该开添加表单')

  // **面板之外的远程变化**（终端里 git remote add fork、AI 工具刚删了一个）：
  // 面板最多 60 秒才知道，所以「开不开表单」必须看宿主的回执而不是渲染时的 snapshot。
  // 这一条：snapshot 里只有 origin（旧），宿主其实已经给了「推送到 fork」的按钮。
  const staleSnapshot = makeFakeWindow({
    stateResponse: { ...TWO_REMOTES, remotes: [{ name: 'origin', url: 'https://github.com/up/demo.git' }] },
    opResponses: { push: { ...denied, choices: [{ id: 'push-to-fork', label: '推送到 fork', detail: '换成远程 fork 再推一次', op: 'push', params: { remote: 'fork' } }] } },
  })
  const staleReact2 = makeStatefulReact()
  mountPanel(evaluateBundle(staleSnapshot, staleReact2.api).exports, staleReact2, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const staleTree2 = await staleReact2.settle()
  await findButton(staleTree2, '推送').props.onClick()
  const staleAfter = await staleReact2.settle()
  assert.ok(findButton(staleAfter, '推送到 fork') !== undefined, '宿主给的路要渲染出来')
  assert.equal(
    flattenTree(staleAfter).find((node) =>
      node !== null && typeof node === 'object' && node.type === 'input'
      && String(node.props.placeholder) === 'origin'),
    undefined,
    '宿主已经给出了出路时，不能因为 snapshot 过时而再弹一个「添加远程」表单',
  )

  // 分支受保护走同一条客户端逻辑（没有别的远程可推时也要指路去加远程）。
  const protectedRepo = makeFakeWindow({
    stateResponse: { ...TWO_REMOTES, remotes: [{ name: 'origin', url: 'https://github.com/up/demo.git' }] },
    opResponses: {
      push: {
        ok: false, op: 'push', exitCode: 1, stdout: '', stderr: 'remote: error: GH006: Protected branch update failed.',
        message: 'remote: error: GH006: Protected branch update failed.', reason: 'branch-protected',
        hint: '服务器拒绝这次推送：这个分支受保护。', choices: null, state: null,
      },
    },
  })
  const protectedReact = makeStatefulReact()
  mountPanel(evaluateBundle(protectedRepo, protectedReact.api).exports, protectedReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const protectedTree = await protectedReact.settle()
  await findButton(protectedTree, '推送').props.onClick()
  const protectedAfter = await protectedReact.settle()
  assert.ok(
    flattenTree(protectedAfter).some((node) =>
      node !== null && typeof node === 'object' && node.type === 'input'
      && String(node.props.placeholder) === 'origin' && String(node.props.value) === 'fork'),
    '分支受保护且没有别的远程时，也要把「添加远程」表单打开：' + textOf(protectedAfter).slice(0, 300),
  )
})

test('client standalone：宿主没按选的远程跑（旧宿主）时要明说，不能沉默', async () => {
  // 现场：插件是 link 安装的 —— 客户端界面随刷新更新，宿主半边**不会**热重载。
  // 于是存在「新客户端 + 旧宿主」：旧宿主的 push 不看 remote，回执里是 `git push`。
  const selectFork = async (harness, react) => {
    const tree = await react.settle()
    findPushTargetSelect(tree).props.onChange({ target: { value: 'fork' } })
    const picked = await react.settle()
    await findButton(picked, '推送').props.onClick()
    return react.settle()
  }

  const stale = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: { push: { ok: true, command: 'git push', exitCode: 0, stdout: '', stderr: '', state: TWO_REMOTES } },
  })
  const staleReact = makeStatefulReact()
  mountPanel(evaluateBundle(stale, staleReact.api).exports, staleReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const staleTree = await selectFork(stale, staleReact)
  const warn = findByClass(staleTree, 'dgs-push-stale')
  assert.ok(warn !== undefined, '旧宿主没按选中的远程跑时要给出提示')
  assert.ok(textOf(warn).includes('重启'), '提示要指向「重启 dsh」这个动作：' + textOf(warn))

  // 宿主按选的远程跑了（回执是 git push fork HEAD）→ 不该出现这句提示。
  const fresh = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: { push: { ok: true, command: 'git push fork HEAD', exitCode: 0, stdout: '', stderr: '', state: TWO_REMOTES } },
  })
  const freshReact = makeStatefulReact()
  mountPanel(evaluateBundle(fresh, freshReact.api).exports, freshReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const freshTree = await selectFork(fresh, freshReact)
  assert.equal(findByClass(freshTree, 'dgs-push-stale'), undefined, '宿主照做了就不该报')
})

// ── 从指定的那个远程拉（本次需求） ───────────────────────────────────────────
//
// 现场：分支跟踪的是 `fork`（自己的），而更新在 `origin`（别人的上游）上。
// 旧面板的「拉取」只有一个按钮、来源由上游配置决定 —— 想拿上游的更新就得先把
// 上游改绑到 origin、拉完再改回 fork。这四条盯的是与推送完全对称的那套：
// 选得中（下拉）、发得对（宿主收到就是选的那个远程）、记得住（按仓库）、
// 两边按钮同源（「拉取」与「安全拉取」拉的是同一个地方）。

/** 找面板里那个「拉取自」下拉（按 className 定位）。 */
function findPullTargetSelect(tree) {
  return flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'select'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-pull-target'))
}

/**
 * 某个远程行的「从此外拉」按钮（按行内定位，避免多行时点错）。
 *
 * 它的标签会变（记着 current 时下拉的目标那行是 `拉 master`、否则是 `从此外拉`），
 * 所以按 className 定位（`dgs-pull-from` 挂在按钮上不可能 —— panelButton 只给
 * primary/danger/compact 三类样式），因此这里按「key 以 pull- 开头」找。
 */
function findPullFromRemoteButton(tree, remoteName) {
  const row = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className.includes('dgs-remote-row')
    && textOf(node).includes(remoteName))
  if (row === undefined) return undefined
  return (row.children ?? []).find((child) =>
    child !== null && typeof child === 'object' && child.type === 'button'
    && typeof child.props.key === 'string' && child.props.key.startsWith('pull-'))
}

test('client standalone：「拉取自」下拉列出跟随上游 + 每个远程，选完「拉取」就把远程交给宿主', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const select = findPullTargetSelect(tree)
  assert.ok(select !== undefined, '同步区要有「拉取自」下拉')
  assert.equal(select.props.value, '', '默认是「跟随上游」（裸 pull，老行为）')
  const options = (select.children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  assert.deepEqual(options.map((item) => item.props.value), ['', 'fork', 'origin'],
    '第一项是跟随上游，其余按远程列出')

  // 选 origin（别人的上游）→ 值跟着变，并**按仓库目录**记住
  select.props.onChange({ target: { value: 'origin' } })
  const picked = await react.settle()
  assert.equal(findPullTargetSelect(picked).props.value, 'origin')
  assert.deepEqual(
    JSON.parse(String(harness.storage.get('dsh-git-sidebar-pull-remote'))),
    { '/tmp/demo': 'origin' },
    '拉取的来源要按仓库记住（与推送各记一份，互不干扰）',
  )
  // 行尾要把真正要跑的命令写全（用户才知道会拉哪条分支）
  assert.ok(textOf(picked).includes('git pull origin main'),
    '选中远程后要写出这次真正要跑的命令：' + textOf(picked).slice(0, 400))

  // 点「拉取」→ 宿主收到的是 origin（而不是裸 pull）
  await findButton(picked, '拉取').props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls.length, 1, '应 POST 一次 pull：' + JSON.stringify(opPayloads(harness)))
  assert.equal(pulls[0].remote, 'origin', '拉的必须是被选中的那个远程')
})

test('client standalone：「安全拉取」与「拉取」同一个来源（同一份选择、同一份变基）', async () => {
  const harness = makeFakeWindow({ stateResponse: TWO_REMOTES })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  findPullTargetSelect(tree).props.onChange({ target: { value: 'origin' } })
  const picked = await react.settle()
  // 顺手勾上「变基」：它也要跟着一起走（用户在工作区脏的时候点的正是「安全拉取」）。
  const rebaseBox = findCheckbox(picked, '变基')
  assert.ok(rebaseBox !== undefined, '「变基」勾选框要在')
  rebaseBox.props.onChange({ target: { checked: true } })
  const rebased = await react.settle()

  await findButton(rebased, '安全拉取').props.onClick()
  await react.settle()
  const stashPulls = opPayloads(harness).filter((payload) => payload.op === 'stashPull')
  assert.equal(stashPulls.length, 1, '应 POST 一次 stashPull')
  assert.equal(stashPulls[0].remote, 'origin',
    '「安全拉取」必须从同一个来源拉：两个按钮拉的不是同一个地方，正是本插件一直在消灭的不一致')
  assert.equal(stashPulls[0].rebase, true, '「安全拉取」也要带上变基勾选')
})

test('client standalone：拉取来源按仓库分开，且远程没了就干净退回「跟随上游」', async () => {
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    prefillStorage: { 'dsh-git-sidebar-pull-remote': JSON.stringify({ '/tmp/demo': 'origin' }) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  assert.equal(findPullTargetSelect(tree).props.value, 'origin', '切回这个仓库时要记得上次从哪儿拉')

  // 宿主状态说 origin 已经被删掉了：记忆里那个名字拿不出去，必须干净退回「跟随上游」。
  const stale = makeFakeWindow({
    stateResponse: { ...TWO_REMOTES, remotes: [{ name: 'fork', url: 'git@github.com:me/demo.git' }] },
    prefillStorage: { 'dsh-git-sidebar-pull-remote': JSON.stringify({ '/tmp/demo': 'origin' }) },
  })
  const staleReact = makeStatefulReact()
  mountPanel(evaluateBundle(stale, staleReact.api).exports, staleReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const staleTree = await staleReact.settle()
  assert.equal(findPullTargetSelect(staleTree).props.value, '', '远程不在了就退回跟随上游')

  await findButton(staleTree, '拉取').props.onClick()
  await staleReact.settle()
  const pulls = opPayloads(stale).filter((payload) => payload.op === 'pull')
  assert.equal(pulls.length, 1)
  assert.equal(pulls[0].remote, undefined, '退回默认时是裸 pull（不带 remote）')
})

test('client standalone：宿主没按选的远程拉（旧宿主）时要明说，不能沉默', async () => {
  // 与推送同一条中间态（link 安装：客户端随刷新更新、宿主半边不热重载）。
  // 旧宿主的 pull 不看 remote 参数，回执里是 `git pull` —— 用户会以为「选了 origin
  // 却从 fork 拉了」，而真相是这次根本没按他选的来源跑。
  const selectOrigin = async (harness, react) => {
    const tree = await react.settle()
    findPullTargetSelect(tree).props.onChange({ target: { value: 'origin' } })
    const picked = await react.settle()
    await findButton(picked, '拉取').props.onClick()
    return react.settle()
  }

  const stale = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: { pull: { ok: true, command: 'git pull', exitCode: 0, stdout: '', stderr: '', state: TWO_REMOTES } },
  })
  const staleReact = makeStatefulReact()
  mountPanel(evaluateBundle(stale, staleReact.api).exports, staleReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const staleTree = await selectOrigin(stale, staleReact)
  const warn = findByClass(staleTree, 'dgs-pull-stale')
  assert.ok(warn !== undefined, '旧宿主没按选中的远程拉时要给出提示')
  assert.ok(textOf(warn).includes('重启'), '提示要指向「重启 dsh」这个动作：' + textOf(warn))

  // 宿主照做了（回执是 git pull origin main）→ 不该出现这句提示。
  const fresh = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: { pull: { ok: true, command: 'git pull origin main', exitCode: 0, stdout: '', stderr: '', state: TWO_REMOTES } },
  })
  const freshReact = makeStatefulReact()
  mountPanel(evaluateBundle(fresh, freshReact.api).exports, freshReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const freshTree = await selectOrigin(fresh, freshReact)
  assert.equal(findByClass(freshTree, 'dgs-pull-stale'), undefined, '宿主照做了就不该报')
})

test('client standalone：宿主给出「改从默认分支拉取」那条路时渲染成按钮，点了就带着参数跑', async () => {
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: {
      pull: {
        ok: false, op: 'pull', exitCode: 128, stdout: '',
        stderr: "fatal: couldn't find remote ref local-only",
        message: '远端 origin 上没有 local-only 分支',
        reason: 'remote-branch-missing',
        hint: '远端 origin 上没有 local-only 分支……它自己的默认分支是 origin/master',
        choices: [{
          id: 'pull-default-branch',
          label: '改从 origin/master 拉取',
          detail: '把 origin/master 合并进当前分支',
          op: 'pull',
          params: { remote: 'origin', branch: 'master' },
        }],
        state: TWO_REMOTES,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  findPullTargetSelect(tree).props.onChange({ target: { value: 'origin' } })
  const picked = await react.settle()
  await findButton(picked, '拉取').props.onClick()
  const after = await react.settle()

  const button = findButton(after, '改从 origin/master 拉取')
  assert.ok(button !== undefined, '宿主给的路要渲染成可点的按钮：' + textOf(after).slice(0, 400))
  await button.props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls.length, 2, '应再 POST 一次 pull')
  assert.equal(pulls[1].remote, 'origin')
  assert.equal(pulls[1].branch, 'master', '点了按钮就要带着那只默认分支去拉')
})

// ── fork 现场：远端默认分支与当前分支不同名 → 一键「把上游拉到当前分支」 ────────
//
// 真实仓库（dsh-skills-manager）：当前分支 `local.2` 跟踪 `fork/local.2`（自己的），
// 而别人的更新在 `origin` 上、默认分支叫 `master`。面板此前只有「从 origin 拉」这一项
// —— 而它拉的是 `origin/local.2`（不存在），于是「拿上游更新」要么先在终端敲
// `git pull origin master`，要么靠拉取失败后那条补救按钮。这几条盯的是：
// 一眼看得见（下拉里点名 origin/master）、点得到（远程行「拉 master」）、
// 说得清（tooltip 写出真要跑的命令）、记得住（按仓库存下 `origin master`）。

/** 用户的真实现场：分支 local.2 + 两个远程 + 远端默认分支随状态一起带回来。 */
const FORK_SCENE = {
  ...REPO_WITH_CHANGES,
  branch: 'local.2',
  upstream: 'fork/local.2',
  remotes: [
    { name: 'fork', url: 'git@github.com:wangyuncai2024/dsh-skills-manager.git' },
    { name: 'origin', url: 'https://github.com/MichengAI/dsh-skills-manager.git' },
  ],
  duplicateRemotes: [],
  // 宿主随状态读回「每个远程各自的默认分支」：fork 的默认分支就叫 local.2（同名 → 不预选），
  // origin 的默认分支是 master（与当前分支不同名 → 点名它）。
  remoteHeads: { fork: 'local.2', origin: 'master' },
}

test('client standalone：远端默认分支与当前分支不同名时，「拉取自」下拉多一项点名那条分支', async () => {
  const harness = makeFakeWindow({ stateResponse: FORK_SCENE })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const select = findPullTargetSelect(tree)
  const options = (select.children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  // 顺序：跟随上游 → fork（拉同名）→ fork/local.2 与它同名，所以只有一项
  // → origin（拉同名）→ origin/master（不同名，多出来的一项）。
  assert.deepEqual(options.map((item) => item.props.value), ['', 'fork', 'origin', 'origin master'],
    '远端默认分支不同名时才多给一项，实际：' + JSON.stringify(options.map((item) => item.props.value)))
  assert.equal(textOf(options[3]), '从 origin/master 拉',
    '那一项要写明是哪条远端分支，不能含糊成「从 origin 拉」')
  assert.equal(textOf(options[1]), '从 fork 拉', '同名的远程不给第二项（两条路是同一条命令）')
})

test('client standalone：选中「从 origin/master 拉」后，拉取把远程**和分支**一起交给宿主', async () => {
  const harness = makeFakeWindow({ stateResponse: FORK_SCENE })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  findPullTargetSelect(tree).props.onChange({ target: { value: 'origin master' } })
  const picked = await react.settle()
  assert.equal(findPullTargetSelect(picked).props.value, 'origin master', '选完要停在那一项上')
  assert.deepEqual(
    JSON.parse(String(harness.storage.get('dsh-git-sidebar-pull-remote'))),
    { '/tmp/demo': 'origin master' },
    '点名分支的选择也要按仓库记住（切回来还在）',
  )
  // 行尾要把真正要跑的命令写全 —— 这里**不能**写出当前分支名（那是另一条命令）。
  assert.ok(textOf(picked).includes('git pull origin master'),
    '要点出真正的那条命令：' + textOf(picked).slice(0, 400))
  assert.equal(textOf(picked).includes('git pull origin local.2'), false,
    '点名了分支就不该再显示「按当前分支拉」那条命令')

  await findButton(picked, '拉取').props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls.length, 1, '应 POST 一次 pull')
  assert.equal(pulls[0].remote, 'origin')
  assert.equal(pulls[0].branch, 'master', '点名的那条分支必须一路传给宿主')
})

test('client standalone：远程行的「拉 master」一键从此外拉，并把它记成这个仓库的来源', async () => {
  const harness = makeFakeWindow({ stateResponse: FORK_SCENE })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)
  assert.equal(findPullTargetSelect(tree).props.value, '', '前置条件：还没选过，默认跟随上游')

  // origin 那一行的按钮被点名成「拉 master」（与「推送到此」对称的那个入口）。
  const button = findPullFromRemoteButton(tree, 'origin')
  assert.ok(button !== undefined, 'origin 行要有「从此外拉」：' + textOf(tree).slice(0, 600))
  assert.equal(textOf(button), '拉 master', '远端默认分支不同名时按钮直接点名那条分支')
  assert.ok(String(button.props.title).includes('git pull origin master'),
    'tooltip 要写出真要跑的命令：' + String(button.props.title))
  await button.props.onClick()
  const after = await react.settle()

  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls.length, 1, '应 POST 一次 pull')
  assert.equal(pulls[0].remote, 'origin')
  assert.equal(pulls[0].branch, 'master', '点这一行就是拉它自己的默认分支')
  // 与「推送到此」同一个承诺：点完要**记住**，否则再点「拉取」会突然拉回原处。
  assert.equal(findPullTargetSelect(after).props.value, 'origin master', '「从此外拉」之后下拉要停在这一点上')
  assert.deepEqual(
    JSON.parse(String(harness.storage.get('dsh-git-sidebar-pull-remote'))),
    { '/tmp/demo': 'origin master' },
    '远程行的入口也要把它记成这个仓库的来源',
  )
})

test('client standalone：远程默认分支与当前分支同名时，远程行的按钮退回「拉同名那条」', async () => {
  // 同名（默认分支就是 local.2）时两条路是**同一条命令**，不该假装有第二种选择。
  const harness = makeFakeWindow({
    stateResponse: { ...FORK_SCENE, remoteHeads: { fork: 'local.2', origin: 'local.2' } },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  const button = findPullFromRemoteButton(tree, 'origin')
  assert.equal(textOf(button), '从此外拉', '同名时按钮不点名分支')
  assert.ok(String(button.props.title).includes('git pull origin local.2'),
    'tooltip 里仍要写全命令（宿主按当前分支名补）：' + String(button.props.title))
  await button.props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls[0].remote, 'origin')
  assert.equal(pulls[0].branch, undefined, '不点名时不该传 branch —— 让宿主按当前分支名补')
})

test('client standalone：宿主没有 remoteHeads（旧宿主）时退回老行为，不猜分支', async () => {
  // 旧宿主的状态里没有 remoteHeads 这个字段。面板**绝不能**因此去猜一条默认分支：
  // 猜错就是把另一条线合进当前分支。它应当退化成「从 origin 拉同名那条」。
  const noHeads = { ...FORK_SCENE }
  delete noHeads.remoteHeads
  const harness = makeFakeWindow({ stateResponse: noHeads })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  const options = (findPullTargetSelect(tree).children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  assert.deepEqual(options.map((item) => item.props.value), ['', 'fork', 'origin'],
    '不知道默认分支时不预选分支（只有远程那一项）')

  const button = findPullFromRemoteButton(tree, 'origin')
  assert.equal(textOf(button), '从此外拉')
  await button.props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls[0].remote, 'origin')
  assert.equal(pulls[0].branch, undefined, '不知道就不传 branch')
})

// ── 记忆里的值与现在的现场不一致（本次复核找出来的真缺陷） ───────────────────
//
// 现场：remoteHeads 说 origin 的默认分支已经**改名**成 main（别人的仓库真会改），
// 而 localStorage 里还记着用户上次选的 `origin master`。
// 修之前：下拉里只有 `origin` 与 `origin main` 两项，没有 `origin master`，而
// `<select value="origin master">` 又匹配不到任何 option —— HTML 的行为是
// selectedIndex = -1，**下拉显示空白**，用户看不出这一次到底会从哪儿拉
// （行尾摘要却还写着 `git pull origin master`，自相矛盾）。
// 修法是「记忆里的那个值永远保留一项」，按 value 显式去重（原先靠 `continue` 隐式
// 去重，把这一段整个跳过了）。

const RENAMED_HEADS = {
  ...FORK_SCENE,
  remoteHeads: { fork: 'local.2', origin: 'main' },
}

test('client standalone（回归）：远端默认分支改过名后，记忆里那个值仍在下拉里有一项（不空白）', async () => {
  const harness = makeFakeWindow({
    stateResponse: RENAMED_HEADS,
    prefillStorage: { 'dsh-git-sidebar-pull-remote': JSON.stringify({ '/tmp/demo': 'origin master' }) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const select = findPullTargetSelect(tree)
  const values = (select.children ?? [])
    .filter((child) => child !== null && typeof child === 'object' && child.type === 'option')
    .map((item) => item.props.value)
  // 三件不同的事都要有一项：拉同名那条 / 现在的默认分支（main）/ 记忆里那条（master）。
  assert.deepEqual(values, ['', 'fork', 'origin', 'origin main', 'origin master'],
    '记忆里那个值必须留一项，否则 <select> 显示空白：' + JSON.stringify(values))
  // 这是本用例的核心断言：value 必须**真的**匹配到一项（而不是只看列表里有）。
  assert.equal(values.includes(String(select.props.value)), true,
    '<select> 的 value 必须能在 option 里找到：value=' + String(select.props.value))
  // 记忆里那一项要点明是上次选的（用户才知道为什么这里多出一条 master）。
  const kept = (select.children ?? []).find((child) =>
    child !== null && typeof child === 'object' && child.type === 'option'
    && child.props.value === 'origin master')
  assert.ok(textOf(kept).includes('上次选的'),
    '要说清这一项是上次选的（它正因为远端改名才与上面那项不同）：' + textOf(kept))

  // 点「拉取」仍按记忆里那条跑（**不能**静默改用现在的 main —— 那等于替用户换命令）。
  await findButton(tree, '拉取').props.onClick()
  await react.settle()
  const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls[0].remote, 'origin')
  assert.equal(pulls[0].branch, 'master', '记忆里是 master 就还是 master，不静默换成 main')
})

test('client standalone（回归）：记忆值带多余空白时归一化，下拉不空白且请求体干净', async () => {
  // 这些形状只可能来自手改 localStorage 或别的版本写入（界面选不出来）。
  // 归一化让它们自愈：<select> 是逐字符匹配 value 的，`'origin '` 匹配不到 `'origin'`。
  //
  // **不止普通空格**：`\t` 与换行也算空白。只按空格切的话，`'origin\tmaster'` 会被当成
  // 一个叫 `origin\tmaster` 的远程名 → 校验不通过 → 用户的记忆**静默消失**（退回跟随上游）。
  // 当前实现按 /\s+/ 切，所以制表符形状与普通空格等价、记忆照旧生效。
  const cases = [' origin', 'origin ', 'origin  master', '  origin   master  ', 'origin\tmaster', 'origin\nmaster']
  for (const stored of cases) {
    const harness = makeFakeWindow({
      stateResponse: FORK_SCENE,
      prefillStorage: { 'dsh-git-sidebar-pull-remote': JSON.stringify({ '/tmp/demo': stored }) },
    })
    const react = makeStatefulReact()
    const { exports } = evaluateBundle(harness, react.api)
    mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
    const tree = await react.settle()

    const select = findPullTargetSelect(tree)
    const values = (select.children ?? [])
      .filter((child) => child !== null && typeof child === 'object' && child.type === 'option')
      .map((item) => item.props.value)
    assert.equal(values.includes(String(select.props.value)), true,
      JSON.stringify(stored) + ' 归一化后要匹配上某一项：value=' + String(select.props.value)
        + ' options=' + JSON.stringify(values))
    assert.equal(String(select.props.value), stored.trim().replace(/\s+/g, ' '),
      JSON.stringify(stored) + ' 要归一化成一个空格分隔的规范形状')

    await findButton(tree, '拉取').props.onClick()
    await react.settle()
    const pulls = opPayloads(harness).filter((payload) => payload.op === 'pull')
    assert.equal(pulls[0].remote, 'origin', JSON.stringify(stored) + ' 的远程名要干净')
    assert.equal(pulls[0].branch, stored.includes('master') ? 'master' : undefined,
      JSON.stringify(stored) + ' 的分支名要干净（不能带空白）')
  }
})

test('client standalone（回归）：推送记忆里带了分支时也只取远程名（下拉不空白、不发脏名给宿主）', async () => {
  // 推送目标在 git 里只能是一个远程。记忆里若带着分支（只可能来自手改存储），照原样用
  // 会同时坏两件事：「推送到」下拉的候选只有远程名 → value 匹配不上 → 空白；
  // 而且 `origin master` 会被当远程名发给宿主，宿主按 isSafePushTarget 以「含空格」拒绝。
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    prefillStorage: { 'dsh-git-sidebar-push-remote': JSON.stringify({ '/tmp/demo': 'origin master' }) },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const select = findPushTargetSelect(tree)
  const values = (select.children ?? [])
    .filter((child) => child !== null && typeof child === 'object' && child.type === 'option')
    .map((item) => item.props.value)
  assert.equal(values.includes(String(select.props.value)), true,
    '推送下拉的 value 要能匹配到 option（否则显示空白）：value=' + String(select.props.value)
      + ' options=' + JSON.stringify(values))
  assert.equal(String(select.props.value), 'origin', '只取开头那个远程名')

  await findButton(tree, '推送').props.onClick()
  await react.settle()
  const pushes = opPayloads(harness).filter((payload) => payload.op === 'push')
  assert.equal(pushes.length, 1, '应 POST 一次 push')
  assert.equal(pushes[0].remote, 'origin', '发给宿主的必须是干净的远程名，不能带分支/空格')
})

test('client standalone：真实现场（两个远程的默认分支都叫 master，当前分支叫 local.2）', async () => {
  // 这是用户真仓库 dsh-skills-manager 的实际形状，由 readState 实测读回来的：
  //   branch = local.2 / upstream = fork/local.2 / remoteHeads = { fork: 'master', origin: 'master' }
  // 两个远程的默认分支都**不同名**于当前分支，所以两个都该给出点名那一项 ——
  // 「把 fork/master 拉进 local.2」与「把 origin/master 拉进 local.2」是两条不同的命令。
  const realHarness = makeFakeWindow({
    stateResponse: { ...FORK_SCENE, remoteHeads: { fork: 'master', origin: 'master' } },
  })
  const realReact = makeStatefulReact()
  mountPanel(evaluateBundle(realHarness, realReact.api).exports, realReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const realInitial = await realReact.settle()
  // 「拉取自」下拉在同步区（不在折叠区块里），但远程行的按钮在收起的远程区块里。
  const real = await openRemotesSection(realInitial, realReact)

  const options = (findPullTargetSelect(real).children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  assert.deepEqual(options.map((item) => item.props.value),
    ['', 'fork', 'fork master', 'origin', 'origin master'],
    '每个远程「拉同名」与「拉它自己的默认分支」各一项，实际：'
      + JSON.stringify(options.map((item) => item.props.value)))
  assert.equal(textOf(options[2]), '从 fork/master 拉')
  assert.equal(textOf(options[4]), '从 origin/master 拉')

  // 远程行：两行各自都能一键拉到那个远程的默认分支（tooltip 里带各自的远程名）。
  for (const name of ['fork', 'origin']) {
    const button = findPullFromRemoteButton(real, name)
    assert.equal(textOf(button), '拉 master', name + ' 行要点名它自己的默认分支')
    assert.ok(String(button.props.title).includes('git pull ' + name + ' master'),
      name + ' 行的 tooltip 要写对自己的那条命令：' + String(button.props.title))
  }

  // 选 origin/master 那条 → 行尾命令与发给宿主的参数都点名它，而不是 fork 的。
  findPullTargetSelect(real).props.onChange({ target: { value: 'origin master' } })
  const picked = await realReact.settle()
  await findButton(picked, '拉取').props.onClick()
  await realReact.settle()
  const pulls = opPayloads(realHarness).filter((payload) => payload.op === 'pull')
  assert.equal(pulls[0].remote, 'origin', '别把 fork 的默认分支混进来')
  assert.equal(pulls[0].branch, 'master')
})

test('client standalone：当前分支正好就是远端默认分支的名字时，下拉也不多给一项', async () => {
  // 判断依据是「远端默认分支名 ≠ 当前分支名」，而不是「remoteHeads 里有没有这个远程」：
  // 切到 master 之后，origin/master 与「拉当前分支同名那条」是同一条命令，
  // 多一项只会让人犹豫「这俩差在哪」（而从 git 的角度它们确实完全一样）。
  const harness = makeFakeWindow({
    stateResponse: {
      ...FORK_SCENE,
      branch: 'master',
      upstream: 'origin/master',
      remoteHeads: { fork: 'master', origin: 'master' },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const tree = await openRemotesSection(initial, react)

  const options = (findPullTargetSelect(tree).children ?? []).filter((child) =>
    child !== null && typeof child === 'object' && child.type === 'option')
  assert.deepEqual(options.map((item) => item.props.value), ['', 'fork', 'origin'],
    '两个远程的默认分支都叫 master、当前分支也叫 master → 都不多给一项')
  // 远程行的按钮同样退回不点名分支的那一种。
  assert.equal(textOf(findPullFromRemoteButton(tree, 'origin')), '从此外拉')
})

test('client standalone：多远程时远端分支按远程分组并写短名，「当前跟踪」标在具体那一行', async () => {
  const harness = makeFakeWindow({
    stateResponse: TWO_REMOTES,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: {
          defaultRef: 'origin/main',
          items: [
            { remote: 'fork', name: 'main', ref: 'fork/main', head: false },
            { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
          ],
        },
        branchUpstreams: { main: { upstream: 'origin/main', ahead: 0, behind: 0 } },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  const groups = flattenTree(opened).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string' && node.props.className === 'dgs-remote-group')
  assert.equal(groups.length, 2, '两个远程要分成两组，实际：' + JSON.stringify(groups.map(textOf)))
  assert.ok(groups.some((group) => textOf(group).includes('fork')), 'fork 组要存在')
  assert.ok(groups.some((group) => textOf(group).includes('origin')), 'origin 组要存在')
  // A 批：「当前跟踪」从**分组标题**下沉到**行**（组标题只回答「属于谁」，
  // 「我跟踪的是哪一条」必须落到具体那一行，否则行一多还得在组里再找一遍）。
  const forkGroup = groups.find((group) => textOf(group).includes('fork'))
  const originGroup = groups.find((group) => textOf(group).includes('origin'))
  assert.ok(!textOf(forkGroup).includes('当前跟踪'), '组标题不再承担「哪一条」这个信息')
  assert.ok(!textOf(originGroup).includes('当前跟踪'), '组标题不再承担「哪一条」这个信息')

  const branchRows = (tree) => flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem'))
  const trackedRow = branchRows(opened).find((row) => textOf(row).includes('当前跟踪'))
  assert.ok(trackedRow !== undefined, '当前分支跟踪的那一条远端分支要挂「当前跟踪」徽章')
  // 被标的那一行必须是 origin/main（多远程下只渲染短名 `main`，完整 ref 在 tooltip 里）。
  const trackedName = flattenTree(trackedRow).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.title === 'string' && node.props.title.startsWith('origin/'))
  assert.ok(trackedName !== undefined, '「当前跟踪」要挂在 origin/main 那一行，而不是 fork/main')
  assert.equal(textOf(trackedName), 'main', '多远程时只写短名（属于哪个远程由分组标题交代）')
  // 你自己就在这个分支上：那行给的是禁用的「当前分支」，而不是让自己切自己。
  const selfButton = flattenTree(trackedRow).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'button' && textOf(node) === '当前分支')
  assert.ok(selfButton !== undefined, '当前分支跟踪的那一行要给「当前分支」（不是「切过去」）')
  assert.equal(selfButton.props.disabled, true, '「当前分支」必须是禁用的')

  // fork/main 这一行没有被任何本地分支跟踪 → 仍然是「拿成新分支」，并且带上 fork。
  const forkRow = branchRows(opened).find((row) => flattenTree(row).some((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.title === 'string' && node.props.title.startsWith('fork/')))
  assert.ok(forkRow !== undefined, 'fork/main 那一行要渲染出来')
  const forkTake = flattenTree(forkRow).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'button' && textOf(node) === '拿成新分支')
  assert.ok(forkTake !== undefined, '没有被本地跟踪的远端分支旁边要有「拿成新分支」')
  // 面板里 fork/main 在 origin/main 之前（分组按远程名升序），所以第一个「拿成新分支」
  // 就是 fork 那一组的 —— 这也顺带证明排序确实按远程分组走了。
  await forkTake.props.onClick()
  await react.settle()
  const adopted = opPayloads(harness).filter((payload) => payload.op === 'adoptRemote')
  assert.equal(adopted.length, 1, '应 POST 一次 adoptRemote')
  assert.equal(adopted[0].remote, 'fork', '取回的必须是点的那一组（fork）')
  assert.equal(adopted[0].branch, 'main')
})

// ── A 批：远端行 ↔ 本地行的交叉引用 ─────────────────────────────────────────
//
// 现场（dsh-skills-manager）：本地 `fork-local.2` 正在跟踪 `fork/local.2`，而远端
// 那一行原先只有一个通用的「拿成新分支」—— 用户点下去，宿主按 `fork/local.2` 自动
// 命名 `fork-local.2`，发现已被占用就**静默顺延**成 `fork-local.2-2`：一条名字相近、
// 内容相同的重复分支。根因是「这条远端分支我已经有了」这件事在界面上不存在。

/** 按「名字 tooltip 以某个 ref 开头」找那一行（多远程下渲染的是短名，只能靠 tooltip 定位）。 */
function rowForRef(tree, ref) {
  const rows = flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem'))
  return rows.find((row) => flattenTree(row).some((node) =>
    node !== null && typeof node === 'object' && node.type === 'span'
    && typeof node.props.title === 'string' && node.props.title.startsWith(ref)))
}

test('client standalone：远端分支已有本地分支跟踪时给「切过去」，不再给「拿成新分支」', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'fork-local.2', upstream: 'fork/local.2',
    ahead: 1, behind: 0, changes: [], log: [],
    remotes: [
      { name: 'fork', url: 'git@example.com:me/demo.git' },
      { name: 'origin', url: 'https://example.com/demo.git' },
    ],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: {
          current: 'fork-local.2',
          items: [{ name: 'fork-local.2', current: true }, { name: 'release-x', current: false }],
        },
        remoteBranches: {
          defaultRef: 'origin/master',
          items: [
            { remote: 'fork', name: 'local.2', ref: 'fork/local.2', head: false },
            { remote: 'fork', name: 'release/1.1.6', ref: 'fork/release/1.1.6', head: false },
            { remote: 'origin', name: 'master', ref: 'origin/master', head: true },
          ],
        },
        branchUpstreams: {
          'fork-local.2': { upstream: 'fork/local.2', ahead: 1, behind: 0 },
          'release-x': { upstream: 'fork/release/1.1.6', ahead: 0, behind: 0 },
        },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  // ① 当前分支跟踪的那一条：标出行内「当前跟踪」+ 禁用的「当前分支」——
  //    「你已经有了、而且就在上面」由这两个标记说清（再写一句 `↩ 本地 …` 反而是重复，
  //    实测会把 local.2 这种短名字挤掉 3px）。绝不会再给你建一个同内容的。
  const trackedRow = rowForRef(opened, 'fork/local.2')
  assert.ok(trackedRow !== undefined, '前置条件：fork/local.2 那一行在')
  assert.ok(textOf(trackedRow).includes('当前跟踪'), '当前分支跟踪的那一行要标「当前跟踪」')
  const selfButton = flattenTree(trackedRow).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'button' && textOf(node) === '当前分支')
  assert.ok(selfButton !== undefined, '当前分支跟踪的那一行要给「当前分支」而不是「拿成新分支」')
  assert.equal(selfButton.props.disabled, true, '「当前分支」必须是禁用的')
  assert.equal(
    flattenTree(trackedRow).find((node) => node.type === 'button' && textOf(node) === '拿成新分支'),
    undefined,
    '已经有本地对应就不该再给「拿成新分支」（那正是造出 fork-local.2-2 的入口）',
  )

  // ② 非当前分支跟踪的那一条：给「切过去」，点一下切到那条本地分支（不是新建）。
  const releaseRow = rowForRef(opened, 'fork/release/1.1.6')
  assert.ok(releaseRow !== undefined, '前置条件：fork/release/1.1.6 那一行在')
  assert.ok(textOf(releaseRow).includes('↩ release-x'), '非当前分支的跟踪关系同样要写在行上')
  const go = flattenTree(releaseRow).find((node) => node.type === 'button' && textOf(node) === '切过去')
  assert.ok(go !== undefined, '已有本地对应的行要给「切过去」')
  await go.props.onClick()
  await react.settle()
  const checkedOut = opPayloads(harness).filter((payload) => payload.op === 'checkout')
  assert.equal(checkedOut.length, 1, '点「切过去」要发一次 checkout：' + JSON.stringify(opPayloads(harness)))
  assert.equal(checkedOut[0].branch, 'release-x', '切的是那条已经在跟踪它的本地分支')
  assert.equal(
    opPayloads(harness).filter((payload) => payload.op === 'adoptRemote').length,
    0,
    '「切过去」绝不能变成 adoptRemote（那会新建分支）',
  )

  // ③ 没有任何本地对应的远端分支：仍然是「拿成新分支」。
  const masterRow = rowForRef(opened, 'origin/master')
  assert.ok(masterRow !== undefined, '前置条件：origin/master 那一行在')
  assert.ok(
    flattenTree(masterRow).find((node) => node.type === 'button' && textOf(node) === '拿成新分支') !== undefined,
    '没有本地对应的远端分支才给「拿成新分支」',
  )
})

test('client standalone：「设置上游」把本地分支绑到选中的远端分支（本地名不用改）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'fork-local.2', upstream: 'fork/local.2',
    ahead: 1, behind: 0, changes: [], log: [],
    remotes: [{ name: 'fork', url: 'git@example.com:me/demo.git' }],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'fork-local.2', items: [{ name: 'fork-local.2', current: true }] },
        remoteBranches: {
          defaultRef: 'fork/master',
          items: [
            { remote: 'fork', name: 'local.2', ref: 'fork/local.2', head: false },
            { remote: 'fork', name: 'fork-local.2', ref: 'fork/fork-local.2', head: false },
            { remote: 'fork', name: 'master', ref: 'fork/master', head: true },
          ],
        },
        branchUpstreams: { 'fork-local.2': { upstream: 'fork/local.2', ahead: 1, behind: 0 } },
        state: null,
      },
      setUpstream: {
        ok: true,
        command: 'git branch --set-upstream-to=fork/fork-local.2 fork-local.2',
        notes: ['已把本地分支 fork-local.2 的上游设为 fork/fork-local.2'],
        state: repoState,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)

  // 本地行：动作都收在「⋯」里（危险动作不再常驻）。改上游就在这里。
  // 定位靠它那一句跟踪标签（本地行的名字 tooltip 是「当前分支：…」，与远端行不同）。
  const localRow = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem')
    && textOf(node).includes('→ fork/local.2'))
  assert.ok(localRow !== undefined, '前置条件：本地 fork-local.2 那一行在')
  const more = flattenTree(localRow).find((node) => node.type === 'button' && textOf(node) === '⋯')
  assert.ok(more !== undefined, '本地分支行要有「⋯」')
  await more.props.onClick()
  const menu = await react.settle()
  const openUpstream = findButton(menu, '设置上游…')
  assert.ok(openUpstream !== undefined, '「⋯」里要有「设置上游…」：' + textOf(menu).slice(0, 200))

  await openUpstream.props.onClick()
  const picker = await react.settle()
  const pickerBox = findByClass(picker, 'dgs-upstream-picker')
  assert.ok(pickerBox !== undefined, '要就地展开候选远端分支，而不是什么都不发生')
  assert.ok(
    textOf(pickerBox).includes('把 fork-local.2 的上游设为（现在是 fork/local.2）'),
    '展开区要说清是给哪个分支设置的、现在指向哪：' + textOf(pickerBox),
  )
  // 当前上游标出来并且不可点（点了也没意义，只会白跑一次 git）。
  const currentChoice = findButton(picker, 'fork/local.2（当前上游）')
  assert.ok(currentChoice !== undefined, '当前上游要标出来：' + textOf(pickerBox))
  assert.equal(currentChoice.props.disabled, true, '当前上游那个按钮要是禁用的')

  // 选另一条 → 宿主执行 git branch --set-upstream-to。
  const target = findButton(picker, 'fork/fork-local.2')
  assert.ok(target !== undefined, '要能选到别的远端分支：' + textOf(pickerBox))
  await target.props.onClick()
  const after = await react.settle()
  const asked = opPayloads(harness).filter((payload) => payload.op === 'setUpstream')
  assert.equal(asked.length, 1, '应该 POST 一次 setUpstream：' + JSON.stringify(opPayloads(harness)))
  assert.deepEqual(
    { local: asked[0].local, remote: asked[0].remote, branch: asked[0].branch },
    { local: 'fork-local.2', remote: 'fork', branch: 'fork-local.2' },
    '本地分支名与远端分支名都要显式带上（不能靠宿主猜）',
  )
  assert.equal(findByClass(after, 'dgs-upstream-picker'), undefined, '成功之后选择器要收起')
  assert.equal(
    opPayloads(harness).filter((payload) => payload.op === 'branches').length,
    2,
    '改完之后要重列一次分支（本地名可没变，但上游变了）',
  )
})

// ── 分支改名：就地输入框（**不依赖 window.prompt**，桌面版也能用） ──────────────
//
// 本次现场：桌面版（Electron 外壳）里点「⋯ → 改名」什么都不会发生。根因是改名
// 此前是面板里**唯一**用 window.prompt() 拿输入的地方，而 Electron 不支持 prompt
// （Chromium 那句 `prompt() is and will not be supported.`）。日志里从头到尾没有一条
// renameBranch，用户看到的就是「改名功能用不了」。这一组把每一步都钉住：点击 →
// 就地展开 → 草稿播种 → 输入 → 回车 / 保存 → 交给宿主的是哪两条名字，以及四种
// 「点了也白跑」的就地拦截、失败时输入框留着、取消不发请求。

/** 改名的现场：仓库 /tmp/demo、当前分支 master、有一个远程 origin。 */
function renameRepoState() {
  return {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'https://example.com/demo.git' }],
  }
}

/**
 * 展开分支管理器并把当前分支行的「⋯」菜单点开。
 *
 * 顺带把 `window.prompt` 换成**会炸的替身**：面板里任何一处回退到浏览器弹框，
 * 用例立刻红 —— 这正是本次修掉的那条路（桌面版没有 prompt）。
 */
async function openBranchMoreMenu(options = {}) {
  const repoState = options.repoState ?? renameRepoState()
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: Object.assign({
      branches: {
        ok: true,
        branches: { current: 'master', items: [{ name: 'master', current: true }] },
        remoteBranches: {
          defaultRef: 'origin/main',
          items: [{ remote: 'origin', name: 'main', ref: 'origin/main', head: true }],
        },
        branchUpstreams: {},
        state: null,
      },
      renameBranch: {
        ok: true,
        command: 'git branch -m master trunk',
        stdout: '',
        notes: ['已把分支 master 改名为 trunk：提交历史一个没动'],
        state: repoState,
      },
    }, options.opResponses),
  })
  const prompted = []
  harness.win.prompt = (message) => {
    prompted.push(message)
    throw new Error('面板不该调用 window.prompt：桌面版没有它（这正是「改名没反应」的根因）')
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  const opened = await openBranchManager(initial, react)
  const localRow = flattenTree(opened).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('dgs-rowitem'))
  assert.ok(localRow !== undefined, '前置条件：本地分支行在')
  const more = flattenTree(localRow).find((node) => node.type === 'button' && textOf(node) === '⋯')
  assert.ok(more !== undefined, '本地分支行要有「⋯」')
  await more.props.onClick()
  const menu = await react.settle()
  return { harness, react, menu, prompted, repoState }
}

/** 再点一下「改名…」，返回输入框已就地展开的那棵树。 */
async function openRenameEditor(options = {}) {
  const ctx = await openBranchMoreMenu(options)
  const rename = findButton(ctx.menu, '改名…')
  assert.ok(rename !== undefined, '「⋯」里要有「改名…」：' + textOf(ctx.menu).slice(0, 200))
  // 这一下**不能**以异常结束：它必须展开面板自己的输入框，而不是去碰 window.prompt
  // （上面那个会炸的替身会让这条路立刻红）。
  await rename.props.onClick()
  const tree = await ctx.react.settle()
  assert.deepEqual(ctx.prompted, [], '改名不该调用 window.prompt（桌面版没有它）')
  return Object.assign({}, ctx, { tree })
}

test('client standalone：「⋯ → 改名…」就地展开输入框，回车把新旧两个名字一起交给宿主', async () => {
  const ctx = await openRenameEditor()
  const editor = findByClass(ctx.tree, 'dgs-rename-editor')
  assert.ok(editor !== undefined, '点了要展开一个就地输入框，而不是什么都不发生（本次现场）')
  const input = findByClass(editor, 'dgs-rename-input')
  assert.ok(input !== undefined, '展开区里要有输入框')
  assert.equal(input.props.value, 'master', '草稿从原分支名播种：改名多半是在原名上改几个字')
  assert.ok(
    textOf(editor).includes('把分支 master 改名'),
    '展开区要写清改的是哪条分支：' + textOf(editor),
  )
  assert.ok(
    textOf(editor).includes('提交历史'),
    '展开区要说清改完之后什么不变（历史不动、上游跟着走）：' + textOf(editor),
  )

  // 输入新名字 → 回车提交。输入框的回车**不经过按钮的 disabled**，所以两条路都要能用。
  input.props.onChange({ target: { value: 'trunk' } })
  const typed = await ctx.react.settle()
  const typedInput = findByClass(findByClass(typed, 'dgs-rename-editor'), 'dgs-rename-input')
  typedInput.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  const after = await ctx.react.settle()

  const asked = opPayloads(ctx.harness).filter((payload) => payload.op === 'renameBranch')
  assert.equal(asked.length, 1, '应该 POST 一次 renameBranch：' + JSON.stringify(opPayloads(ctx.harness)))
  assert.deepEqual(
    { name: asked[0].name, from: asked[0].from },
    { name: 'trunk', from: 'master' },
    '新旧名字都要显式带上 —— 宿主执行的是 git branch -m master trunk',
  )
  assert.equal(findByClass(after, 'dgs-rename-editor'), undefined, '成功之后输入框要收起')
  assert.equal(
    opPayloads(ctx.harness).filter((payload) => payload.op === 'branches').length,
    2,
    '改完要重列一次分支（名字变了）',
  )
  assert.ok(
    outputBars(after).some((text) => text.includes('已把分支 master 改名为 trunk')),
    '结果栏要说清改了哪条、改成什么（git 成功时一个字都不打印）：' + JSON.stringify(outputBars(after)),
  )
})

test('client standalone：改名的四种空跑情形就地拦下，取消不发请求', async () => {
  const ctx = await openRenameEditor()
  /** 敲一个名字再点「保存」，返回这一轮渲染出来的树。 */
  const typeAndSave = async (value) => {
    const tree = await ctx.react.settle()
    const input = findByClass(findByClass(tree, 'dgs-rename-editor'), 'dgs-rename-input')
    input.props.onChange({ target: { value } })
    const typed = await ctx.react.settle()
    await findButton(typed, '保存').props.onClick()
    return ctx.react.settle()
  }
  const warnOf = (tree) => {
    const warn = findByClass(tree, 'dgs-rename-warn')
    return warn === undefined ? '' : textOf(warn)
  }

  const empty = await typeAndSave('   ')
  assert.match(warnOf(empty), /不能为空/, '空名字要就地讲清：' + warnOf(empty))
  assert.ok(findByClass(empty, 'dgs-rename-editor') !== undefined, '拦下来之后输入框要留着')

  const same = await typeAndSave('master')
  assert.match(warnOf(same), /一样/, 'git 对同名改名是**成功的空操作**，不让它白跑一趟：' + warnOf(same))

  const spaced = await typeAndSave('new name')
  assert.match(warnOf(spaced), /空格/, '带空格的名字会被 git 当成两个参数：' + warnOf(spaced))

  const conflicted = await typeAndSave('origin/main')
  assert.match(warnOf(conflicted), /歧义/, '撞远端名（origin/main）与新建分支同一判定：' + warnOf(conflicted))
  assert.equal(
    opPayloads(ctx.harness).filter((payload) => payload.op === 'renameBranch').length,
    0,
    '四种情形都不该发请求：' + JSON.stringify(opPayloads(ctx.harness)),
  )

  await findButton(conflicted, '取消').props.onClick()
  const closed = await ctx.react.settle()
  assert.equal(findByClass(closed, 'dgs-rename-editor'), undefined, '取消要收起输入框')
  assert.equal(
    opPayloads(ctx.harness).filter((payload) => payload.op === 'renameBranch').length,
    0,
    '取消之后当然也不能有 renameBranch',
  )
})

test('client standalone：改名被 git 拒绝时输入框留着、中文原因进结果栏（不静默消失）', async () => {
  const ctx = await openRenameEditor({
    opResponses: {
      renameBranch: {
        ok: false,
        command: 'git branch -m master trunk',
        stderr: "fatal: a branch named 'trunk' already exists",
        reason: 'exists',
        hint: '本地已经有同名的分支了（git 不会覆盖它）：要么先把那个分支改名或删掉，'
          + '要么换一条路 —— 点「推送」，在给出的选项里直接把这次提交推到上游跟踪的那个分支上，本地名不用动。',
        state: null,
      },
    },
  })
  const input = findByClass(findByClass(ctx.tree, 'dgs-rename-editor'), 'dgs-rename-input')
  input.props.onChange({ target: { value: 'trunk' } })
  const typed = await ctx.react.settle()
  await findButton(typed, '保存').props.onClick()
  const after = await ctx.react.settle()

  // 失败时**不能**把输入框收掉：用户敲的名字要还在，否则只能从头再敲一遍。
  const editor = findByClass(after, 'dgs-rename-editor')
  assert.ok(editor !== undefined, '失败之后输入框要留着（用户还得改名字）')
  assert.ok(
    outputBars(after).some((text) => text.includes('已经有同名的分支')),
    '宿主给的中文下一步要出现在结果栏：' + JSON.stringify(outputBars(after)),
  )
  assert.deepEqual(ctx.prompted, [], '失败路径同样不能用 window.prompt')
})


