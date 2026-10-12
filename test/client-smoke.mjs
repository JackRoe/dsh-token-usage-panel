/**
 * dsh-token-usage-panel 浏览器半冒烟测试：`node test/client-smoke.mjs`
 *
 * 不依赖真实浏览器与真实 React：用一个极小的 hooks 运行时把 bundle 里的组件
 * 真的渲染一遍，data 来自被替换的 fetch。覆盖：
 *   1. bundle 以 __ModuleLoader__.load 注册，导出 apply / inject
 *   2. apply() 完成词典注册、样式注入、conversation.composer.dock 注册
 *   3. 收起态状态条渲染出会话花费 / token / 峰谷 / 余额
 *   4. 逐次调用表 / 热力图 / 余额 / 设置四个页签都能渲染出内容
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}
const checkAsync = async (name, fn) => {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

/* ---------------- 极小 React ---------------- */

let hooks = []
let cursor = 0
let pendingEffects = []

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = initial
    return [
      hooks[index],
      (value) => {
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      },
    ]
  },
  useRef: (initial) => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  },
  useCallback: (fn, deps) => {
    const index = cursor++
    const previous = hooks[index]
    if (!previous || !Array.isArray(deps) || deps.some((value, at) => value !== previous.deps[at])) {
      hooks[index] = { fn, deps: deps || [] }
    }
    return hooks[index].fn
  },
  useEffect: (fn, deps) => {
    const index = cursor++
    const previous = hooks[index]
    if (!previous || !Array.isArray(deps) || deps.some((value, at) => value !== previous.deps[at])) {
      hooks[index] = { deps: deps || [] }
      pendingEffects.push(fn)
    }
  },
  memo: (fn) => fn,
}

/** 渲染一次（组件独立持有一份 hooks 状态），并跑完本次排队的 effect。 */
let BAR_WIDTH = 900; // 假 DOM 里状态条可用的宽度，测试可改

/** 按元素内容估算一个像素宽度，供假 DOM 的 getBoundingClientRect 使用。 */
const fakeWidth = (node) => {
  if (node === null || node === undefined || node === false) return 0
  if (typeof node === 'string') return 6 * node.length
  if (typeof node === 'number') return 6 * String(node).length
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + fakeWidth(child), 0)
  const props = node.props || {}
  let own = 0
  if (typeof props.label === 'string') own += 6 * props.label.length
  if (typeof props.value === 'string') own += 6 * props.value.length
  const chrome = props.className && String(props.className).includes('up-chip') ? 18 : 0
  return own + chrome + fakeWidth(node.children)
}

/** 把树里带 ref 的元素接上假 DOM 节点，让组件的测量逻辑真的跑起来。 */
const assignRefs = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) assignRefs(child)
    return
  }
  if (node.props && node.props.ref) {
    const element = node
    // 子节点也接上 getBoundingClientRect，组件用「逐个量再加 gap」的口径算所需宽度
    const kids = (node.children || []).filter((child) => child && typeof child === 'object')
    for (const kid of kids) kid.getBoundingClientRect = () => ({ width: fakeWidth(kid) })
    node.props.ref.current = {
      children: kids,
      clientWidth: BAR_WIDTH,
      scrollWidth: BAR_WIDTH,
      getBoundingClientRect: () => ({ width: fakeWidth(element) }),
    }
  }
  assignRefs(node.children)
}

const render = async (component, props) => {
  hooks = []
  cursor = 0
  pendingEffects = []
  let tree = null
  // 反复 render → 接 ref → 跑 effect → 等一拍，让异步装载与密度测量收敛。
  // 注意：effect 返回的清理函数只在整段渲染结束时才跑（真实 React 的语义），
  // 不能混进 pendingEffects —— 否则 setup effect 的清理会把 measureRef 清空。
  const cleanups = []
  for (let pass = 0; pass < 4; pass += 1) {
    cursor = 0
    tree = component(props)
    assignRefs(tree)
    for (const effect of pendingEffects.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  cursor = 0
  tree = component(props)
  assignRefs(tree)
  return tree
}

/**
 * 收集整棵树的文本。
 * 说明：自测里的 createElement 不会真的调用子组件（Chip 之类的函数组件留在 props 上），
 * 所以这里把 label/value 这类字符串 prop 也算作文本。
 */
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const parts = []
  if (node.props && typeof node.props.label === 'string') parts.push(node.props.label)
  if (node.props && typeof node.props.value === 'string') parts.push(node.props.value)
  parts.push(textOf(node.children))
  return parts.join(' ')
}

/* ---------------- 假的 fetch / document / 模块加载器 ---------------- */

const NOW = Date.now()
const canned = {
  '/dsh-usage-panel/snapshot.json': {
    ok: true,
    currency: 'CNY',
    peak: { isPeak: true, nextChangeAt: NOW + 3 * 3600000 + 12 * 60000, multiplier: 2, windows: [[9, 12], [14, 18]], offsetHours: 8 },
    today: { day: '2026-10-10', cost: 0.99769, calls: 13, tokens: 1234567, observedDebit: 0.98 },
    session: { id: 'sess-1', title: '冒烟测试会话', cost: 0.4212345, calls: 3, tokens: 12345 },
    month: { cost: 1.2, calls: 20, tokens: 2000000 },
    totals: { calls: 20, tokens: 2000000, cost: 1.2 },
    balance: { at: NOW, status: 'ready', currency: 'CNY', wallets: [{ currency: 'CNY', balance: 4.49658 }], bonusWallets: [{ currency: 'CNY', balance: 0 }] },
    config: { showDock: true, heatmapWeeks: 26, callsScope: 'session' },
  },
  '/dsh-usage-panel/calls.json': {
    ok: true,
    scope: 'session',
    total: 1,
    summary: { calls: 1, tokens: 950, cost: 0.0123 },
    calls: [
      { id: 'a', at: NOW - 60000, model: 'deepseek-flash', input: 100, cacheRead: 800, output: 50, tokens: 950, cost: 0.0123, peak: false },
    ],
  },
  '/dsh-usage-panel/heatmap.json': {
    ok: true,
    weeks: 26,
    max: 0.5,
    totals: { cost: 0.5, tokens: 1000, calls: 2, activeDays: 2 },
    days: [
      { day: '2026-10-09', calls: 1, tokens: 400, cost: 0.5, costPeak: 0, costValley: 0.5, observedDebit: 0 },
      { day: '2026-10-10', calls: 1, tokens: 600, cost: 0.25, costPeak: 0.25, costValley: 0, observedDebit: 0.2 },
    ],
  },
  '/dsh-usage-panel/config.json': {
    ok: true,
    config: {
      showDock: true,
      heatmapWeeks: 26,
      cacheWriteBilledAsMiss: true,
      balanceRefreshMs: 300000,
      currency: 'CNY',
      peak: { windows: [[9, 12], [14, 18]], holidays: ['2026-10-01'] },
      prices: { 'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] } },
    },
  },
}

const requests = []
globalThis.fetch = async (url) => {
  const key = String(url).split('?')[0]
  requests.push(String(url))
  const payload = canned[key]
  if (!payload) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => payload }
}

const styleTags = []
globalThis.document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      registration = definition
    },
  },
}

const requireStub = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement }
  throw new Error('unexpected require: ' + specifier)
}

/* ---------------- 载入 bundle ---------------- */

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', 'require', source)(globalThis.window, requireStub)
const bundle = registration.factory(requireStub)
const internals = bundle.__internals__

/* ---------------- 用例 ---------------- */

console.log('1) bundle 与插件接线')
check('以 __ModuleLoader__.load 注册且 id 与包名一致', () => {
  assert.equal(registration.id, 'dsh-token-usage-panel')
  assert.equal(typeof registration.factory, 'function')
})
check('导出 apply / inject', () => {
  assert.equal(typeof bundle.apply, 'function')
  assert.deepEqual(bundle.inject, ['slots', 'locale'])
})

const registered = []
const localeRegistrations = []
const fakeCtx = {
  effect: (fn) => {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  locale: {
    register: (ns, dicts) => {
      localeRegistrations.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject: (name, callback) => {
      registered.push({ name, entry: callback() })
      return () => {}
    },
    register: (definition, component) => ({ definition, component }),
  },
}

bundle.apply(fakeCtx)

check('注册了一处 conversation.composer.dock', () => {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'conversation.composer.dock')
  const { definition, component } = registered[0].entry
  assert.equal(definition.name, 'conversation.composer.dock')
  assert.equal(definition.id, 'usage-panel')
  assert.equal(typeof definition.order, 'number')
  assert.equal(definition.locale, 'usage-panel')
  assert.equal(component, internals.UsageDock)
  assert.deepEqual(definition.inject('sess-1'), { sessionId: 'sess-1' })
})
check('注册了中英词典（zh/en 键覆盖一致）', () => {
  assert.equal(localeRegistrations.length, 1)
  const { ns, dicts } = localeRegistrations[0]
  assert.equal(ns, 'usage-panel')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
})
check('注入了自带样式表', () => {
  assert.equal(styleTags.length, 1)
  assert.equal(styleTags[0].dataset.pluginCss, 'usage-panel')
  assert.ok(styleTags[0].textContent.includes('.up-bar'))
})
check('状态条用 order:1 排到官方上下文环之后（环落在“本次会话”左边）', () => {
  // .dock 是 display:flex 的 flex 行；order:1 让本条目排到默认 order:0 的 ContextMeter 之后
  assert.ok(/\.up-root\{[^}]*order:1/.test(styleTags[0].textContent), styleTags[0].textContent.slice(0, 200))
  assert.ok(/\.up-root\{[^}]*flex:1 1 auto/.test(styleTags[0].textContent))
})

console.log('2) 收起态状态条')
const t = (key) => internals.zh[key] || key
const props = {
  t,
  sessionId: 'sess-1',
  useSession: (selector) => selector({ running: false }),
}

const bar = await render(internals.UsageDock, props)
const barText = textOf(bar)

check('状态条显示会话花费与 token', () => {
  assert.ok(barText.includes('会话'), '缺少“会话”')
  assert.ok(barText.includes('¥0.4212'), '缺少会话花费：' + barText)
  assert.ok(barText.includes('12.3k'), '缺少会话 token：' + barText)
})
check('状态条显示今日花费、峰价与余额', () => {
  assert.ok(barText.includes('今日'), '缺少“今日”')
  assert.ok(barText.includes('¥0.9977'), '缺少今日花费：' + barText)
  assert.ok(barText.includes('峰价×2'), '缺少峰价标记：' + barText)
  assert.ok(barText.includes('3h12m'), '缺少切换倒计时：' + barText)
  assert.ok(barText.includes('¥4.50'), '缺少余额：' + barText)
})
check('请求打到 Host 路由且带上 sessionId', () => {
  assert.ok(requests.some((url) => url.startsWith('/dsh-usage-panel/snapshot.json?sessionId=sess-1')), requests.join(','))
})

/** 在渲染树里找第一个满足条件的元素。 */
const findNode = (node, predicate) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findNode(node.children, predicate)
}

check('靠右分组顺序：会话 / 今日 → 弹簧 → 余额 / 峰谷 / 明细', () => {
  const barNode = findNode(bar, (node) => node.props && node.props.className === 'up-bar up-barLive')
  assert.ok(barNode, '找不到 .up-barLive')
  const kinds = barNode.children.map((child) => {
    if (typeof child === 'string') return 'text:' + child
    if (child && child.props && child.props.className === 'up-barSpacer') return 'spacer'
    if (child && child.props && typeof child.props.tone === 'string') return 'peak'
    if (child && child.props && child.props.label === '余额') return 'balance'
    if (child && child.props && child.props.label === '会话') return 'session'
    if (child && child.props && child.props.label === '今日') return 'today'
    if (child && child.props && child.props.className === 'up-toggle') return 'toggle'
    return 'other'
  })
  assert.deepEqual(kinds, ['session', 'today', 'spacer', 'balance', 'peak', 'toggle'])
})
check('一排到底：nowrap + 密度探针', () => {
  const css = styleTags[0].textContent
  assert.ok(/\.up-bar\{[^}]*flex-wrap:nowrap/.test(css), '状态条没有 nowrap')
  assert.ok(css.includes('.up-probe{'), '缺少密度探针样式')
  assert.ok(/\.up-probe \.up-chip,\.up-probe \.up-toggle\{flex:0 0 auto\}/.test(css), '探针项必须不可收缩')
  const probe = findNode(bar, (node) => node.props && node.props.className === 'up-bar up-probe')
  assert.ok(probe, '缺少探针节点')
  // 探针不可聚焦、不参与无障碍树
  assert.equal(probe.props['aria-hidden'], true)
  assert.ok(!JSON.stringify(probe).includes('"type":"button"'), '探针里不应出现可聚焦控件')
})

const barLabels = (tree) => {
  const live = findNode(tree, (node) => node.props && node.props.className === 'up-bar up-barLive')
  return live.children.filter((child) => child && child.props && child.props.label).map((child) => child.props.label)
}
const liveBar = (tree) => findNode(tree, (node) => node.props && node.props.className === 'up-bar up-barLive')
const peakText = (tree) => {
  const live = liveBar(tree)
  const peak = live.children.find((child) => child && child.props && typeof child.props.tone === 'string')
  return peak ? String(peak.props.value) : ''
}
const labeledValue = (tree, label) => {
  const live = liveBar(tree)
  const chip = live.children.find((child) => child && child.props && child.props.label === label)
  return chip ? String(chip.props.value) : ''
}

/** 用与组件相同的口径估出「当前档位需要多宽」。 */
const needOf = (tree) => {
  const probe = findNode(tree, (node) => node.props && node.props.className === 'up-bar up-probe')
  const kids = probe.children
  return kids.reduce((sum, kid) => sum + fakeWidth(kid), 0) + 6 * (kids.length - 1)
}

BAR_WIDTH = 900
const wideTree = await render(internals.UsageDock, props)
const needFull = needOf(wideTree)

await checkAsync('宽裕时全量显示：会话 / 今日 都带 token，峰谷带倒计时', async () => {
  BAR_WIDTH = 900
  const tree = await render(internals.UsageDock, props)
  assert.deepEqual(barLabels(tree), ['会话', '今日', '余额'])
  assert.ok(labeledValue(tree, '会话').includes('·'), '会话缺少 token：' + labeledValue(tree, '会话'))
  assert.ok(labeledValue(tree, '今日').includes('·'), '今日缺少 token：' + labeledValue(tree, '今日'))
  assert.ok(peakText(tree).includes('h'), '峰谷缺少倒计时：' + peakText(tree))
})

await checkAsync('偏窄时只压次要数字：今日先去 token，三项仍在', async () => {
  BAR_WIDTH = needFull - 10
  const tree = await render(internals.UsageDock, props)
  assert.deepEqual(barLabels(tree), ['会话', '今日', '余额'])
  assert.ok(!labeledValue(tree, '今日').includes('·'), '今日应当只剩金额：' + labeledValue(tree, '今日'))
  assert.ok(labeledValue(tree, '会话').includes('·'), '会话此时仍保留 token：' + labeledValue(tree, '会话'))
  assert.ok(peakText(tree).includes('h'), '峰谷此时仍保留倒计时：' + peakText(tree))
})

await checkAsync('很窄时再压一档：会话也去 token，峰谷倒计时与三项仍在', async () => {
  BAR_WIDTH = needFull - 200
  const tree = await render(internals.UsageDock, props)
  assert.deepEqual(barLabels(tree), ['会话', '今日', '余额'])
  assert.ok(!labeledValue(tree, '会话').includes('·'), '会话应当只剩金额：' + labeledValue(tree, '会话'))
  assert.ok(peakText(tree).includes('h'), '峰谷倒计时必须始终保留：' + peakText(tree))
  BAR_WIDTH = 900
})
check('余额把赠送额度算进来（只有赠送的账号不再显示 ¥0）', () => {
  assert.ok(barText.includes('¥4.50'), barText)
})
await checkAsync('赠送额度单独计入：充值 0 + 赠送 3.25 → 余额 ¥3.25（悬停显示拆分）', async () => {
  const snapshot = canned['/dsh-usage-panel/snapshot.json']
  const backupWallets = snapshot.balance.wallets
  const backupBonus = snapshot.balance.bonusWallets
  snapshot.balance.wallets = [{ currency: 'CNY', balance: 0 }]
  snapshot.balance.bonusWallets = [{ currency: 'CNY', balance: 3.25 }]
  try {
    const tree = await render(internals.UsageDock, props)
    const text = textOf(tree)
    assert.ok(text.includes('¥3.25'), '赠送额度未被计入：' + text)
    const chip = findNode(tree, (node) => node.props && node.props.label === '余额')
    assert.ok(chip, '找不到余额 chip')
    assert.ok(String(chip.props.title).includes('赠送 ¥3.25'), '悬停缺少赠送拆分：' + String(chip.props.title))
  } finally {
    snapshot.balance.wallets = backupWallets
    snapshot.balance.bonusWallets = backupBonus
  }
})

console.log('3) 展开面板的四个页签')
const callsTree = await render(internals.CallsTab, { t, sessionId: 'sess-1' })
const callsText = textOf(callsTree)
check('逐次调用表渲染出模型、token、时段与花费', () => {
  assert.ok(callsText.includes('deepseek-flash'), callsText)
  assert.ok(callsText.includes('谷'), callsText)
  assert.ok(callsText.includes('¥0.0123'), callsText)
  assert.ok(callsText.includes('1 次调用'), callsText)
})

const heatTree = await render(internals.HeatmapTab, { t, defaultWeeks: 26 })
const heatText = textOf(heatTree)
check('热力图渲染格子、图例与区间合计', () => {
  assert.ok(heatText.includes('26 周数'), heatText)
  assert.ok(heatText.includes('少') && heatText.includes('多'), heatText)
  assert.ok(heatText.includes('区间合计 ¥0.5'), heatText)
  assert.ok(heatText.includes('活跃 2 天'), heatText)
  const cells = (heatTree.children || []).filter((child) => child && child.props && child.props.className === 'up-grid')
  assert.equal(cells.length, 1)
  assert.equal(cells[0].children.length, 2)
})

const balanceTree = await render(internals.BalanceTab, {
  t,
  snapshot: canned['/dsh-usage-panel/snapshot.json'],
  onRefresh: async () => {},
})
const balanceText = textOf(balanceTree)
check('余额页渲染充值/赠送余额与今日实扣对账', () => {
  assert.ok(balanceText.includes('充值余额'), balanceText)
  assert.ok(balanceText.includes('¥4.50'), balanceText)
  assert.ok(balanceText.includes('余额实扣'), balanceText)
  assert.ok(balanceText.includes('¥0.9977'), balanceText)
})

const settingsTree = await render(internals.SettingsTab, { t, snapshot: canned['/dsh-usage-panel/snapshot.json'], onSaved: async () => {} })
const settingsText = textOf(settingsTree)
check('设置页渲染四项开关与三块 JSON 编辑区', () => {
  assert.ok(settingsText.includes('在对话区下方显示状态条'), settingsText)
  assert.ok(settingsText.includes('峰时段'), settingsText)
  assert.ok(settingsText.includes('法定节假日'), settingsText)
  assert.ok(settingsText.includes('单价表'), settingsText)
  assert.ok(settingsText.includes('保存'), settingsText)
})

console.log('4) 格式与降级')
check('金额格式化：小额保精度、大额两位', () => {
  assert.equal(internals.fmtMoney(0, 'CNY'), '¥0')
  assert.equal(internals.fmtMoney(0.000012345, 'CNY'), '¥0.00001')
  assert.equal(internals.fmtMoney(1.5, 'USD'), '$1.50')
})
check('token 格式化：k / M', () => {
  assert.equal(internals.fmtTokens(999), '999')
  assert.equal(internals.fmtTokens(12345), '12.3k')
  assert.equal(internals.fmtTokens(1234567), '1.2M')
})
check('Host 不可用时显示可重试提示而不抛错', async () => {
  const restore = canned['/dsh-usage-panel/snapshot.json']
  delete canned['/dsh-usage-panel/snapshot.json']
  const tree = await render(internals.UsageDock, props)
  const text = textOf(tree)
  canned['/dsh-usage-panel/snapshot.json'] = restore
  assert.ok(text.includes('用量服务不可用'), text)
  assert.ok(text.includes('重试'), text)
})

console.log('\n全部通过：' + String(passed) + ' 项')
// 组件内的轮询定时器属于真实浏览器生命周期，这里直接收尾。
process.exit(0)
