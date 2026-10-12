/**
 * dsh-token-usage-panel 自测：`node test/self-test.mjs`
 *
 * 覆盖：
 *   1. 峰谷时段判定（工作日峰 / 午休谷 / 夜间谷 / 周末谷 / 法定节假日谷 / 切换点）
 *   2. 计价口径（峰=谷×2、缓存命中按命中价、缓存写入并入未命中、reasoning 不重复计费）
 *   3. 端到端：用假 Cordis root 跑真实 apply()，喂一条 assistant/message，
 *      再经真实 HTTP 路由读回 snapshot / calls / heatmap，并落盘校验
 *   4. 配置写入后回读
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-test-'))
process.env.DSH_HOME = tmpHome

const mod = await import('../lib/index.js')
const T = mod.__test__

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

/** 北京时间某天某点 → epoch 毫秒。 */
const bj = (day, hour, minute = 0) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)

console.log('1) 峰谷时段')
const config = T.normalizeConfig({})

check('周一 10:00 是峰（180ms 后转谷）', () => {
  assert.equal(T.isPeakAt(bj('2026-10-12', 10), config), true)
})
check('周一 13:00 是谷（午休）', () => {
  assert.equal(T.isPeakAt(bj('2026-10-12', 13), config), false)
})
check('周一 15:00 是峰', () => {
  assert.equal(T.isPeakAt(bj('2026-10-12', 15), config), true)
})
check('周一 20:00 是谷', () => {
  assert.equal(T.isPeakAt(bj('2026-10-12', 20), config), false)
})
check('周六全天谷价', () => {
  assert.equal(T.isPeakAt(bj('2026-10-10', 10), config), false)
})
check('法定节假日（2026-10-01 周四）全天谷价', () => {
  assert.equal(T.isPeakAt(bj('2026-10-01', 10), config), false)
})
check('08:59 之后的下一个切换点是 09:00', () => {
  const next = T.nextPeakChangeAt(bj('2026-10-12', 8, 59), config)
  assert.equal(new Date(next).getTime(), bj('2026-10-12', 9))
})
check('峰时段内下一个切换点是 12:00', () => {
  const next = T.nextPeakChangeAt(bj('2026-10-12', 10), config)
  assert.equal(new Date(next).getTime(), bj('2026-10-12', 12))
})
check('时区偏移可配置（UTC+0 下 10:00Z 是峰、01:00Z 是谷）', () => {
  const utc = T.normalizeConfig({ peak: { offsetHours: 0 } })
  assert.equal(T.isPeakAt(Date.parse('2026-10-12T10:00:00Z'), utc), true)
  assert.equal(T.isPeakAt(Date.parse('2026-10-12T01:00:00Z'), utc), false)
})

console.log('2) 计价口径')
const flash = T.priceFor(config, 'deepseek-flash')
const pro = T.priceFor(config, 'deepseek-v4-pro')

check('deepseek-flash 命中默认价表', () => {
  assert.deepEqual(flash, { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
})
check('deepseek-v4-pro 命中 Pro 价表', () => {
  assert.deepEqual(pro, { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] })
})
check('未知模型回落到 _default', () => {
  assert.deepEqual(T.priceFor(config, 'some-other-model'), config.prices._default)
})
check('1M 未命中输入：谷价 ¥1 / 峰价 ¥2', () => {
  const usage = { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }
  assert.equal(T.costOf(config, usage, flash, false), 1)
  assert.equal(T.costOf(config, usage, flash, true), 2)
})
check('1M 缓存命中：谷价 ¥0.02', () => {
  const usage = { input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }
  assert.equal(T.costOf(config, usage, flash, false), 0.02)
})
check('1M 输出：谷价 ¥4', () => {
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }
  assert.equal(T.costOf(config, usage, flash, false), 4)
})
check('缓存写入按未命中计价，关掉后不计', () => {
  const usage = { input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }
  assert.equal(T.costOf(config, usage, flash, false), 1)
  assert.equal(T.costOf(T.normalizeConfig({ cacheWriteBilledAsMiss: false }), usage, flash, false), 0)
})
check('reasoning ⊆ output，不重复计费', () => {
  const plain = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6 }
  const reasoned = { input: 0, cacheRead: 0, cacheWrite: 0, output: 1e6, reasoning: 8e5 }
  assert.equal(T.costOf(config, reasoned, flash, false), T.costOf(config, plain, flash, false))
})
check('usage 全零时不计账', () => {
  assert.equal(T.usageOf({ usage: { inputTokens: 0, outputTokens: 0 } }), null)
})
check('usage 归一：input 只算未命中部分', () => {
  const usage = T.usageOf({ usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 20 } })
  assert.deepEqual(usage, { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 20, total: 1050 })
})

console.log('3) 端到端（假 Cordis root + 真实路由）')
const listeners = new Map()
const routes = []
const effects = []

const fakeContext = {
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

const fakeRoot = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: (name, fn) => {
    const list = listeners.get(name) || []
    list.push(fn)
    listeners.set(name, list)
    return () => {}
  },
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return () => {}
  },
  inject: (names, callback) => {
    if (names.includes('webServer')) callback(fakeContext)
    return () => {}
  },
}

mod.default.apply(fakeRoot, {})

const emit = (event) => {
  for (const fn of listeners.get('session/event') || []) fn({ id: 'sess-1', header: {} }, event)
}

const assistantMessage = (over) => ({
  type: 'assistant/message',
  seq: over.seq,
  time: over.time,
  data: {
    turn: over.turn || 1,
    step: 1,
    usage: over.usage,
    message: { source: { provider: 'deepseek-official', model: over.model || 'deepseek-flash' } },
  },
})

check('注册了 5 条 /dsh-usage-panel 路由', () => {
  assert.equal(routes.length, 5)
  assert.ok(routes.every((route) => route.path.startsWith('/dsh-usage-panel/')))
})

// 周一 10:00（峰）1M 未命中输入 → ¥2；周一 20:00（谷）1M 未命中 → ¥1；
// 再补一条「此刻」的调用，用来验证 today 分支（其峰/谷由同一套规则推导）。
// 2026-09-28 是普通周一（中秋 9/25–9/27 已过），既能落在热力图窗口内，又不受“今天”影响。
const nowAt = Date.now()
const nowUsage = { inputTokens: 1e6, outputTokens: 0 }
const nowCost = T.costOf(
  config,
  T.usageOf({ usage: nowUsage }),
  T.priceFor(config, 'deepseek-flash'),
  T.isPeakAt(nowAt, config),
)

emit(assistantMessage({ seq: 3, time: bj('2026-09-28', 10), usage: { inputTokens: 1e6, outputTokens: 0 } }))
emit(assistantMessage({ seq: 4, time: bj('2026-09-28', 20), usage: { inputTokens: 1e6, outputTokens: 0 } }))
emit(assistantMessage({ seq: 5, time: nowAt, usage: nowUsage }))
emit({ type: 'session/title', seq: 6, time: nowAt, data: { title: '用量面板自测' } })

const call = async (suffix, options = {}) => {
  const route = routes.find((item) => item.path === '/dsh-usage-panel' + suffix.split('?')[0])
  assert.ok(route, '缺少路由 ' + suffix)
  const req = {
    method: options.method || 'GET',
    url: '/dsh-usage-panel' + suffix,
    headers: { host: '127.0.0.1:19387' },
    on: (name, fn) => {
      if (name === 'data' && options.body !== undefined) fn(Buffer.from(options.body))
      if (name === 'end') fn()
      return req
    },
    destroy: () => {},
  }
  let status = 0
  let body = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (text) => {
      body = text
    },
  }
  await route.handler(req, res)
  return { status, json: JSON.parse(body) }
}

const snapshot = await call('/snapshot.json?sessionId=sess-1')
check('snapshot 路由返回本次会话与今日账目', () => {
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.json.ok, true)
  assert.equal(snapshot.json.session.calls, 3)
  assert.equal(snapshot.json.session.cost, 3 + nowCost)
  assert.equal(snapshot.json.session.title, '用量面板自测')
  assert.equal(snapshot.json.session.tokens, 3e6)
  assert.equal(snapshot.json.today.calls, 1)
  assert.equal(snapshot.json.today.cost, nowCost)
  assert.equal(snapshot.json.totals.cost, 3 + nowCost)
  assert.equal(snapshot.json.month.calls, 3)
  assert.equal(snapshot.json.peak.multiplier, 2)
})

const nonLoopback = await (async () => {
  const route = routes.find((item) => item.path === '/dsh-usage-panel/snapshot.json')
  const req = { method: 'GET', url: '/dsh-usage-panel/snapshot.json', headers: { host: 'evil.example.com' } }
  let status = 0
  let body = ''
  await route.handler(req, {
    writeHead: (code) => {
      status = code
    },
    end: (text) => {
      body = text
    },
  })
  return { status, json: JSON.parse(body) }
})()
check('非回环 Host 被信任栅栏拒绝', () => {
  assert.equal(nonLoopback.status, 403)
  assert.equal(nonLoopback.json.ok, false)
})

const calls = await call('/calls.json?scope=session&sessionId=sess-1&limit=10')
check('calls 路由按会话返回明细（含峰/谷标记与单价）', () => {
  assert.equal(calls.json.total, 3)
  assert.equal(calls.json.summary.cost, 3 + nowCost)
  const valley = calls.json.calls.find((item) => item.at === bj('2026-09-28', 20))
  const peak = calls.json.calls.find((item) => item.at === bj('2026-09-28', 10))
  assert.equal(valley.peak, false)
  assert.equal(valley.cost, 1)
  assert.equal(peak.peak, true)
  assert.equal(peak.cost, 2)
  assert.deepEqual(peak.price, { hit: 0.04, miss: 2, out: 8 })
})

const heatmap = await call('/heatmap.json?weeks=13')
check('heatmap 路由返回按日聚合与总量', () => {
  assert.equal(heatmap.json.days.length, 91)
  assert.equal(heatmap.json.totals.calls, 3)
  assert.equal(heatmap.json.totals.cost, 3 + nowCost)
  const row = heatmap.json.days.find((day) => day.day === '2026-09-28')
  assert.ok(row, '热力图缺少 2026-09-28')
  assert.equal(row.calls, 2)
  assert.equal(row.cost, 3)
  assert.equal(row.costPeak, 2)
  assert.equal(row.costValley, 1)
  assert.equal(row.tokens, 2e6)
})

const saved = await call('/config.json', {
  method: 'POST',
  body: JSON.stringify({ heatmapWeeks: 39, prices: { 'my-model': { hit: [0.01, 0.02], miss: [0.5, 1], out: [2, 4] } } }),
})
check('config POST 持久化并归一化', () => {
  assert.equal(saved.json.config.heatmapWeeks, 39)
  assert.deepEqual(saved.json.config.prices['my-model'], { hit: [0.01, 0.02], miss: [0.5, 1], out: [2, 4] })
  const onDisk = JSON.parse(fs.readFileSync(T.CONFIG_FILE, 'utf8'))
  assert.equal(onDisk.heatmapWeeks, 39)
})

check('非法配置被收敛（周数越界回落、未知币种回落）', () => {
  const bad = T.normalizeConfig({ heatmapWeeks: 900, currency: 'XXX', balanceRefreshMs: 1 })
  assert.equal(bad.heatmapWeeks, 53)
  assert.equal(bad.currency, 'CNY')
  assert.equal(bad.balanceRefreshMs, 30000)
})

check('账本落盘（flush 后文件存在且含 3 条明细）', () => {
  for (const dispose of effects) {
    try {
      dispose()
    } catch {
      /* 忽略 */
    }
  }
  const ledger = JSON.parse(fs.readFileSync(T.LEDGER_FILE, 'utf8'))
  assert.equal(ledger.calls.length, 3)
  assert.equal(ledger.totals.cost, 3 + nowCost)
  assert.equal(ledger.days['2026-09-28'].calls, 2)
})

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('\n全部通过：' + String(passed) + ' 项')
