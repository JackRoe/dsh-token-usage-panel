/**
 * dsh-token-usage-panel —— Host 半。
 *
 * 职责：
 *   1. 记账：监听 `session/event`，把每一次模型调用的真实 usage 记成一条账目；
 *   2. 计价：按「峰谷时段 + 单价表」把 token 折算成金额（CNY / 百万 token）；
 *   3. 余额：经官方 `deepseekAccount` 服务读取充值 / 赠送余额，并做当日实扣对账；
 *   4. 供数：注册 `/dsh-usage-panel/*` JSON 路由给浏览器半（slot: conversation.composer.dock）。
 *
 * 本文件刻意零外部依赖（只用 node: 内置模块）：第三方插件安装目录下解析不到
 * `@deepseek-ai/*` 依赖，凡是需要 DSH 能力的地方都走 Cordis 服务注入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 账本/配置的位置：与 DSH 其他本地状态同处 $DSH_HOME，插件升级或重装都不会丢。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'usage-panel')
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const ROUTE_PREFIX = '/dsh-usage-panel'

/** 金额一律用 1e-8 的整数单位记账，避免浮点累加漂移。 */
const SCALE = 100000000

/** 平台账号接口要求的客户端版本标识；可用环境变量覆盖。 */
const CLIENT_VERSION = process.env.DSH_CLIENT_VERSION || '0.2.0-rc.2'

/** 账本里保留的明细条数上限（更早的明细只保留按日聚合）。 */
const MAX_CALLS = 50000
/** 余额观测点上限。 */
const MAX_BALANCE_SAMPLES = 5000

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 2026 年法定节假日（全天谷价）。源自《国务院办公厅关于 2026 年部分节假日安排的通知》
 * 与 DeepSeek 官方计费脚注「周一至周五（不含中国法定节假日）…其余时段，包括周末及
 * 中国法定节假日全天均为空闲时段」。调休上班日都落在周末，按周末规则天然是谷价，无需单列。
 * ⚠️ 次年安排公布后请在这里补日期（或直接在面板设置里编辑 holidays）。
 */
const DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]

/** 单价表：每项为 [谷价, 峰价]，单位「元 / 百万 token」。键按子串匹配模型名。 */
const FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }

const DEFAULT_CONFIG = {
  version: 1,
  currency: 'CNY',
  /** 对话区下方状态条是否显示（插件开启后仍想临时隐藏时用）。 */
  showDock: true,
  /** 热力图默认周数。 */
  heatmapWeeks: 26,
  /** 设置页「默认账目范围」：session | today | all。 */
  callsScope: 'session',
  peak: {
    /** 时区偏移小时数：9 表示 UTC+9。默认 +8（北京时间）。 */
    offsetHours: 8,
    /** 峰时段（本地整点区间，左闭右开）。 */
    windows: [[9, 12], [14, 18]],
    /** 周末全天谷价。 */
    weekendValley: true,
    /** 法定节假日全天谷价。 */
    holidayValley: true,
    holidays: DEFAULT_HOLIDAYS,
    /** 峰价 = 谷价 × multiplier。 */
    multiplier: 2,
  },
  prices: {
    'deepseek-flash': FLASH_PRICE,
    'deepseek-v4-flash': FLASH_PRICE,
    'deepseek-v4-flash-vision-exp': FLASH_PRICE,
    'deepseek-v4-pro': PRO_PRICE,
    _default: FLASH_PRICE,
  },
  /** 缓存写入 token 是否按「未命中输入」计价（DeepSeek 官方口径如此）。 */
  cacheWriteBilledAsMiss: true,
  /** 余额自动刷新间隔（毫秒）。 */
  balanceRefreshMs: 300000,
  /** 明细保留天数。 */
  retentionDays: 400,
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 把外部（配置文件 / 设置页）传进来的配置收敛到可用范围。 */
function normalizeConfig(input) {
  let cfg = deepMerge(DEFAULT_CONFIG, input)
  cfg.showDock = cfg.showDock !== false
  cfg.heatmapWeeks = clampInt(cfg.heatmapWeeks, 4, 53, DEFAULT_CONFIG.heatmapWeeks)
  cfg.callsScope = ['session', 'today', 'all'].includes(cfg.callsScope) ? cfg.callsScope : 'session'
  cfg.cacheWriteBilledAsMiss = cfg.cacheWriteBilledAsMiss !== false
  cfg.balanceRefreshMs = clampInt(cfg.balanceRefreshMs, 30000, 3600000, DEFAULT_CONFIG.balanceRefreshMs)
  cfg.retentionDays = clampInt(cfg.retentionDays, 7, 3650, DEFAULT_CONFIG.retentionDays)
  if (cfg.currency !== 'CNY' && cfg.currency !== 'USD') cfg.currency = 'CNY'

  const peak = isPlainObject(cfg.peak) ? cfg.peak : {}
  const offset = Number(peak.offsetHours)
  const windows = Array.isArray(peak.windows)
    ? peak.windows
        .map((pair) => (Array.isArray(pair) ? [Number(pair[0]), Number(pair[1])] : null))
        .filter((pair) => pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[0] < pair[1])
    : null
  const multiplier = Number(peak.multiplier)
  const holidays = Array.isArray(peak.holidays)
    ? peak.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(0, 400)
    : DEFAULT_HOLIDAYS
  cfg.peak = {
    offsetHours: Number.isFinite(offset) ? Math.min(14, Math.max(-12, offset)) : 8,
    windows: windows && windows.length > 0 ? windows : DEFAULT_CONFIG.peak.windows,
    weekendValley: peak.weekendValley !== false,
    holidayValley: peak.holidayValley !== false,
    holidays,
    multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 2,
  }

  const prices = {}
  const source = isPlainObject(cfg.prices) ? cfg.prices : {}
  for (const [model, entry] of Object.entries(source)) {
    if (!isPlainObject(entry)) continue
    const pick = (value, fallback) => {
      if (!Array.isArray(value) || value.length === 0) return fallback
      const low = Number(value[0])
      const high = value.length > 1 ? Number(value[1]) : low
      if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < 0) return fallback
      return [low, high]
    }
    prices[model] = {
      hit: pick(entry.hit, FLASH_PRICE.hit),
      miss: pick(entry.miss, FLASH_PRICE.miss),
      out: pick(entry.out, FLASH_PRICE.out),
    }
  }
  cfg.prices = Object.keys(prices).length > 0 ? prices : { ...DEFAULT_CONFIG.prices }
  if (cfg.prices._default === undefined) cfg.prices._default = FLASH_PRICE
  return cfg
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------------------------------------------ *
 * 峰谷时段
 * ------------------------------------------------------------------ */

function localDate(ms, offsetHours) {
  return new Date(Number(ms) + offsetHours * 3600000)
}

/** 本地日历日（YYYY-MM-DD）。 */
function dayOf(ms, offsetHours = 8) {
  return localDate(ms, offsetHours).toISOString().slice(0, 10)
}

/** 该时刻是否处于峰时段。 */
function isPeakAt(ms, config) {
  const peak = config.peak
  const time = Number(ms)
  if (!Number.isFinite(time)) return false
  const date = localDate(time, peak.offsetHours)
  if (peak.weekendValley) {
    const dow = date.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (peak.holidayValley && peak.holidays.includes(date.toISOString().slice(0, 10))) return false
  const hour = date.getUTCHours()
  return peak.windows.some(([start, end]) => hour >= start && hour < end)
}

/** 下一个峰谷切换时刻（毫秒）；14 天内没有切换点时返回 null。 */
function nextPeakChangeAt(ms, config) {
  const time = Number(ms)
  if (!Number.isFinite(time)) return null
  const peak = config.peak
  const current = isPeakAt(time, config)
  const edges = new Set([0])
  for (const [start, end] of peak.windows) {
    edges.add(start)
    edges.add(end)
  }
  const dayStart = Math.floor((time + peak.offsetHours * 3600000) / 86400000) * 86400000
  for (let day = 0; day <= 14; day += 1) {
    for (const edge of [...edges].sort((a, b) => a - b)) {
      const candidate = dayStart + day * 86400000 + edge * 3600000 - peak.offsetHours * 3600000
      if (candidate <= time + 1) continue
      if (isPeakAt(candidate, config) !== current) return candidate
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 计价
 * ------------------------------------------------------------------ */

/** 按「最长键优先」的模型名子串匹配挑单价。 */
function priceFor(config, model) {
  const name = String(model || '').toLowerCase()
  const keys = Object.keys(config.prices)
    .filter((key) => key !== '_default')
    .sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (key && name.includes(key.toLowerCase())) return config.prices[key]
  }
  return config.prices._default || FLASH_PRICE
}

/**
 * 一次调用的花费（元）。
 * 口径：`inputTokens` 是「未命中缓存的输入」，`cacheReadTokens` 是命中部分，二者不重叠；
 *       `outputTokens` 已包含 reasoning（dsh-token-meter 保证 reasoning ⊆ output）。
 */
function costOf(config, usage, price, peak) {
  const tier = peak ? 1 : 0
  const missTokens = usage.input + (config.cacheWriteBilledAsMiss ? usage.cacheWrite : 0)
  const units =
    Math.round((missTokens / 1e6) * price.miss[tier] * SCALE) +
    Math.round((usage.cacheRead / 1e6) * price.hit[tier] * SCALE) +
    Math.round((usage.output / 1e6) * price.out[tier] * SCALE)
  return units / SCALE
}

/* ------------------------------------------------------------------ *
 * 账本
 * ------------------------------------------------------------------ */

function emptyDay(day) {
  return {
    day,
    calls: 0,
    peakCalls: 0,
    valleyCalls: 0,
    tokensIn: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensOut: 0,
    tokensTotal: 0,
    cost: 0,
    costPeak: 0,
    costValley: 0,
    byModel: {},
  }
}

function emptyLedger() {
  return {
    version: 1,
    createdAt: Date.now(),
    calls: [],
    days: {},
    sessions: {},
    balance: null,
    balanceHistory: [],
    totals: { calls: 0, tokensTotal: 0, cost: 0 },
  }
}

function normalizeLedger(raw) {
  const ledger = emptyLedger()
  if (!isPlainObject(raw)) return ledger
  if (Array.isArray(raw.calls)) ledger.calls = raw.calls.filter(isPlainObject)
  if (isPlainObject(raw.days)) {
    for (const [day, row] of Object.entries(raw.days)) {
      if (!isPlainObject(row)) continue
      ledger.days[day] = { ...emptyDay(day), ...row, byModel: isPlainObject(row.byModel) ? row.byModel : {} }
    }
  }
  if (isPlainObject(raw.sessions)) ledger.sessions = raw.sessions
  if (isPlainObject(raw.balance)) ledger.balance = raw.balance
  if (Array.isArray(raw.balanceHistory)) ledger.balanceHistory = raw.balanceHistory.filter(isPlainObject)
  if (isPlainObject(raw.totals)) ledger.totals = { ...ledger.totals, ...raw.totals }
  ledger.createdAt = Number(raw.createdAt) || ledger.createdAt
  return ledger
}

/** 一次调用的 token 概览。 */
function usageOf(data) {
  const usage = isPlainObject(data?.usage) ? data.usage : null
  if (!usage) return null
  const num = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0)
  const input = num(usage.inputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  const output = num(usage.outputTokens)
  const reasoning = num(usage.reasoningTokens)
  const total = input + cacheRead + cacheWrite + output
  if (total <= 0) return null
  return { input, cacheRead, cacheWrite, output, reasoning, total }
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

export default {
  name: 'usage-panel',
  apply(root, pluginConfig) {    let config = normalizeConfig(readJsonFile(CONFIG_FILE) || pluginConfig)
    const ledger = normalizeLedger(readJsonFile(LEDGER_FILE))

    const log = (level, ...args) => {
      try {
        const logger = root.logger
        if (logger && typeof logger[level] === 'function') logger[level](...args)
        else if (level === 'error') console.error('[usage-panel]', ...args)
        else if (level === 'warn') console.warn('[usage-panel]', ...args)
      } catch {
        /* 记账插件绝不能因为日志失败而影响会话 */
      }
    }

    /* ---------------- 落盘（合并写 + 原子替换） ---------------- */

    let flushTimer = null
    let dirty = false

    const writeNow = () => {
      flushTimer = null
      if (!dirty) return
      dirty = false
      try {
        // 明细按保留天数裁剪；按日聚合永久保留，热力图不会因为裁剪而出现空洞。
        const cutoff = Date.now() - config.retentionDays * 86400000
        if (ledger.calls.length > 0) {
          const kept = ledger.calls.filter((call) => Number(call.at) >= cutoff)
          if (kept.length !== ledger.calls.length) ledger.calls = kept
          if (ledger.calls.length > MAX_CALLS) ledger.calls = ledger.calls.slice(ledger.calls.length - MAX_CALLS)
        }
        if (ledger.balanceHistory.length > MAX_BALANCE_SAMPLES) {
          ledger.balanceHistory = ledger.balanceHistory.slice(ledger.balanceHistory.length - MAX_BALANCE_SAMPLES)
        }
        writeJsonAtomic(LEDGER_FILE, ledger)
      } catch (error) {
        log('warn', '账本写入失败：' + String((error && error.message) || error))
      }
    }

    const markDirty = () => {
      dirty = true
      if (flushTimer !== null) return
      flushTimer = setTimeout(writeNow, 1500)
      if (typeof flushTimer.unref === 'function') flushTimer.unref()
    }

    root.effect(() => () => {
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushTimer = null
      dirty = true
      writeNow()
    })

    const saveConfig = (patch) => {
      config = normalizeConfig(deepMerge(config, patch))
      try {
        writeJsonAtomic(CONFIG_FILE, config)
      } catch (error) {
        log('warn', '配置写入失败：' + String((error && error.message) || error))
      }
      return config
    }

    /* ---------------- 记账 ---------------- */

    const recordCall = (session, event) => {
      try {
        if (!isPlainObject(event) || event.type !== 'assistant/message') return
        const data = isPlainObject(event.data) ? event.data : {}
        const usage = usageOf(data)
        if (usage === null) return
        const at = Number(event.time) || Date.now()
        const sessionId = String((session && session.id) || 'default')
        const id = `${sessionId}:${String(event.seq)}`
        const existing = ledger.calls.length > 0 ? ledger.calls[ledger.calls.length - 1] : null
        if (existing && existing.id === id) return

        const source = isPlainObject(data.message) && isPlainObject(data.message.source) ? data.message.source : {}
        const provider = String(source.provider || '')
        const model = String(source.model || '')
        const peak = isPeakAt(at, config)
        const price = priceFor(config, model)
        const cost = costOf(config, usage, price, peak)
        const day = dayOf(at, config.peak.offsetHours)

        const entry = {
          id,
          at,
          day,
          sessionId,
          model,
          provider,
          turn: Number(data.turn) || 0,
          step: Number(data.step) || 0,
          input: usage.input,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          output: usage.output,
          reasoning: usage.reasoning,
          tokens: usage.total,
          peak,
          price: { hit: price.hit[peak ? 1 : 0], miss: price.miss[peak ? 1 : 0], out: price.out[peak ? 1 : 0] },
          cost,
          currency: config.currency,
        }
        ledger.calls.push(entry)
        if (ledger.calls.length > MAX_CALLS + 2000) ledger.calls = ledger.calls.slice(-MAX_CALLS)

        const row = ledger.days[day] || (ledger.days[day] = emptyDay(day))
        row.calls += 1
        if (peak) {
          row.peakCalls += 1
          row.costPeak += cost
        } else {
          row.valleyCalls += 1
          row.costValley += cost
        }
        row.tokensIn += usage.input
        row.tokensCacheRead += usage.cacheRead
        row.tokensCacheWrite += usage.cacheWrite
        row.tokensOut += usage.output
        row.tokensTotal += usage.total
        row.cost += cost
        const modelKey = model || 'unknown'
        const modelRow = row.byModel[modelKey] || (row.byModel[modelKey] = { calls: 0, tokens: 0, cost: 0 })
        modelRow.calls += 1
        modelRow.tokens += usage.total
        modelRow.cost += cost

        const sessionRow = ledger.sessions[sessionId] || (ledger.sessions[sessionId] = { calls: 0, tokens: 0, cost: 0 })
        sessionRow.calls += 1
        sessionRow.tokens += usage.total
        sessionRow.cost += cost
        sessionRow.lastAt = at
        if (sessionRow.title === undefined) sessionRow.title = ''
        if (session && session.header && session.header.origin === 'subagent') sessionRow.subagent = true

        ledger.totals.calls += 1
        ledger.totals.tokensTotal += usage.total
        ledger.totals.cost += cost
        markDirty()
      } catch (error) {
        log('warn', '记账失败：' + String((error && error.message) || error))
      }
    }

    root.on('session/event', (session, event) => {
      try {
        if (isPlainObject(event) && event.type === 'session/title') {
          const sessionId = String((session && session.id) || 'default')
          const title = String(event.data && event.data.title ? event.data.title : '').trim().slice(0, 120)
          if (title) {
            const row = ledger.sessions[sessionId] || (ledger.sessions[sessionId] = { calls: 0, tokens: 0, cost: 0 })
            row.title = title
            markDirty()
          }
          return
        }
        recordCall(session, event)
      } catch {
        /* 忽略：单条事件失败不影响会话 */
      }
    })

    /* ---------------- 余额 ---------------- */

    let accountService = null
    let balanceInFlight = null
    let lastBalanceAt = 0

    /** 把官方 AccountDetails['balance'] 归一成面板使用的形状。 */
    const normalizeBalance = (raw) => {
      const at = Date.now()
      if (!isPlainObject(raw) || raw.status !== 'ready') {
        return { at, status: raw === null ? 'unavailable' : 'failed', wallets: [], bonusWallets: [], total: 0, currency: config.currency }
      }
      const wallets = Array.isArray(raw.value) ? raw.value : []
      const bonusWallets = Array.isArray(raw.bonusWallets) ? raw.bonusWallets : []
      const currency = wallets[0] && wallets[0].currency ? wallets[0].currency : (bonusWallets[0] && bonusWallets[0].currency) || config.currency
      const sum = (list) => list.reduce((acc, wallet) => acc + (Number(wallet && wallet.balance) || 0), 0)
      return {
        at,
        status: 'ready',
        currency,
        wallets: wallets.map((wallet) => ({ currency: wallet.currency, balance: Number(wallet.balance) || 0 })),
        bonusWallets: bonusWallets.map((wallet) => ({ currency: wallet.currency, balance: Number(wallet.balance) || 0 })),
        total: sum(wallets) + sum(bonusWallets),
      }
    }

    const applyBalance = (snapshot) => {
      ledger.balance = snapshot
      if (snapshot.status === 'ready' && snapshot.at > lastBalanceAt) {
        lastBalanceAt = snapshot.at
        ledger.balanceHistory.push({ at: snapshot.at, day: dayOf(snapshot.at, config.peak.offsetHours), total: snapshot.total })
        if (ledger.balanceHistory.length > MAX_BALANCE_SAMPLES) {
          ledger.balanceHistory = ledger.balanceHistory.slice(-MAX_BALANCE_SAMPLES)
        }
      }
      markDirty()
      return snapshot
    }

    const refreshBalance = async ({ force = false } = {}) => {
      if (accountService === null) {
        return applyBalance({ at: Date.now(), status: 'unavailable', wallets: [], bonusWallets: [], total: 0, currency: config.currency })
      }
      const now = Date.now()
      if (!force && now - lastBalanceAt < 30000) return ledger.balance
      if (balanceInFlight !== null) return balanceInFlight
      const metadata = {
        version: CLIENT_VERSION,
        locale: 'zh',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      balanceInFlight = (async () => {
        try {
          const raw = await accountService.getBalance(metadata)
          return applyBalance(normalizeBalance(raw))
        } catch (error) {
          log('warn', '余额读取失败：' + String((error && error.message) || error))
          return applyBalance({ at: Date.now(), status: 'failed', wallets: [], bonusWallets: [], total: 0, currency: config.currency })
        } finally {
          balanceInFlight = null
        }
      })()
      return balanceInFlight
    }

    root.inject(['deepseekAccount'], (scope) => {
      accountService = scope.deepseekAccount
      void refreshBalance({ force: true })
      const timer = setInterval(() => void refreshBalance(), config.balanceRefreshMs)
      if (typeof timer.unref === 'function') timer.unref()
      scope.effect(() => () => {
        clearInterval(timer)
        accountService = null
      })
    })

    /* ---------------- 聚合查询 ---------------- */

    const startOfToday = () => {
      const now = Date.now()
      const date = localDate(now, config.peak.offsetHours)
      const midnightLocal = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      return midnightLocal - config.peak.offsetHours * 3600000
    }

    const blankAgg = () => ({
      calls: 0,
      tokens: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
      costPeak: 0,
      costValley: 0,
      peakCalls: 0,
      byModel: {},
    })

    const addCallToAgg = (agg, call) => {
      agg.calls += 1
      agg.tokens += call.tokens
      agg.input += call.input
      agg.cacheRead += call.cacheRead
      agg.cacheWrite += call.cacheWrite
      agg.output += call.output
      agg.cost += call.cost
      if (call.peak) {
        agg.peakCalls += 1
        agg.costPeak += call.cost
      } else {
        agg.costValley += call.cost
      }
      const key = call.model || 'unknown'
      const row = agg.byModel[key] || (agg.byModel[key] = { calls: 0, tokens: 0, cost: 0 })
      row.calls += 1
      row.tokens += call.tokens
      row.cost += call.cost
      return agg
    }

    const selectCalls = (scope, sessionId) => {
      if (scope === 'session') {
        const id = String(sessionId || '')
        return id ? ledger.calls.filter((call) => call.sessionId === id) : []
      }
      if (scope === 'today') {
        const from = startOfToday()
        return ledger.calls.filter((call) => call.at >= from)
      }
      if (scope === 'month') {
        const from = startOfToday() - 29 * 86400000
        return ledger.calls.filter((call) => call.at >= from)
      }
      return ledger.calls
    }

    const aggregate = (calls) => calls.reduce((agg, call) => addCallToAgg(agg, call), blankAgg())

    /** 按日汇总（含零值填充），供热力图使用。 */
    const heatmapRows = (weeks) => {
      const count = clampInt(weeks, 4, 53, config.heatmapWeeks)
      const today = startOfToday()
      const todayLocal = localDate(today, config.peak.offsetHours)
      // 对齐到周一，保证网格是整齐的 7 行
      const dow = (todayLocal.getUTCDay() + 6) % 7
      const from = today - (dow + (count - 1) * 7) * 86400000
      const observations = new Map()
      for (const sample of ledger.balanceHistory) {
        const row = observations.get(sample.day) || { first: null, last: null }
        if (row.first === null || sample.at < row.first.at) row.first = sample
        if (row.last === null || sample.at > row.last.at) row.last = sample
        observations.set(sample.day, row)
      }
      const days = []
      for (let index = 0; index < count * 7; index += 1) {
        const at = from + index * 86400000
        const day = dayOf(at, config.peak.offsetHours)
        const row = ledger.days[day] || emptyDay(day)
        const observed = observations.get(day)
        const debit = observed && observed.first && observed.last && observed.last.total < observed.first.total
          ? observed.first.total - observed.last.total
          : 0
        days.push({
          day,
          calls: row.calls,
          tokens: row.tokensTotal,
          cost: row.cost,
          costPeak: row.costPeak,
          costValley: row.costValley,
          peakCalls: row.peakCalls,
          observedDebit: debit,
        })
      }
      const max = days.reduce((acc, row) => Math.max(acc, row.cost), 0)
      const maxTokens = days.reduce((acc, row) => Math.max(acc, row.tokens), 0)
      const totals = days.reduce(
        (acc, row) => ({
          cost: acc.cost + row.cost,
          tokens: acc.tokens + row.tokens,
          calls: acc.calls + row.calls,
          activeDays: acc.activeDays + (row.calls > 0 ? 1 : 0),
        }),
        { cost: 0, tokens: 0, calls: 0, activeDays: 0 },
      )
      return { weeks: count, from: days[0] ? days[0].day : dayOf(from, config.peak.offsetHours), to: dayOf(today, config.peak.offsetHours), max, maxTokens, days, totals }
    }

    const peakState = () => {
      const now = Date.now()
      const isPeak = isPeakAt(now, config)
      const next = nextPeakChangeAt(now, config)
      return {
        isPeak,
        nextChangeAt: next,
        multiplier: config.peak.multiplier,
        windows: config.peak.windows,
        offsetHours: config.peak.offsetHours,
        weekendValley: config.peak.weekendValley,
        holidayValley: config.peak.holidayValley,
      }
    }

    /** 当日的余额实扣（同一自然日内「首次观测 − 最近观测」，只统计净减少）。 */
    const observedDebitOfDay = (day) => {
      let first = null
      let last = null
      for (const sample of ledger.balanceHistory) {
        if (sample.day !== day) continue
        if (first === null || sample.at < first.at) first = sample
        if (last === null || sample.at > last.at) last = sample
      }
      return first && last && last.total < first.total ? first.total - last.total : 0
    }

    const snapshotPayload = (sessionId) => {
      const todayDay = dayOf(Date.now(), config.peak.offsetHours)
      const todayRow = ledger.days[todayDay] || emptyDay(todayDay)
      const sessionRow = sessionId ? ledger.sessions[String(sessionId)] : undefined
      const sessionAgg = sessionId ? aggregate(selectCalls('session', sessionId)) : blankAgg()
      const monthCalls = selectCalls('month')
      const monthAgg = aggregate(monthCalls)
      const recent = (sessionId ? selectCalls('session', sessionId) : ledger.calls).slice(-12).reverse()
      return {
        ok: true,
        now: Date.now(),
        currency: config.currency,
        peak: peakState(),
        today: {
          day: todayDay,
          cost: todayRow.cost,
          calls: todayRow.calls,
          tokens: todayRow.tokensTotal,
          costPeak: todayRow.costPeak,
          costValley: todayRow.costValley,
          observedDebit: observedDebitOfDay(todayDay),
        },
        session: sessionId
          ? {
              id: String(sessionId),
              title: (sessionRow && sessionRow.title) || '',
              cost: sessionAgg.cost,
              calls: sessionAgg.calls,
              tokens: sessionAgg.tokens,
              lastAt: (sessionRow && sessionRow.lastAt) || null,
            }
          : null,
        month: { cost: monthAgg.cost, calls: monthAgg.calls, tokens: monthAgg.tokens },
        totals: ledger.totals,
        callsToday: selectCalls('today').length,
        balance: ledger.balance,
        config: { showDock: config.showDock, heatmapWeeks: config.heatmapWeeks, callsScope: config.callsScope },
        recent,
      }
    }

    /* ---------------- HTTP 路由 ---------------- */

    const JSON_HEADERS = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }

    const isLoopbackAuthority = (authority) => {
      const host = String(authority || '')
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\[/, '')
        .replace(/\]$/, '')
      if (host === '' ) return false
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
      const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
      if (!match) return false
      if (Number(match[1]) !== 127) return false
      return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
    }

    const trustedAuthorities = String(process.env.DSH_USAGE_PANEL_TRUSTED_HOSTS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)

    /**
     * 信任栅栏：优先委托宿主的 connection 服务（含浏览器鉴权），它不可用时退回本地回环自检。
     * 任何一条不通过都直接拒绝——这是本机插件，没有理由对非回环来源放行。
     */
    const rejectionOf = (req, context) => {
      try {
        const connection = context.get('connection')
        if (connection && typeof connection.requestRejection === 'function') {
          const code = connection.requestRejection(req)
          if (code !== undefined && code !== null && code !== false) {
            return typeof code === 'number' ? code : 403
          }
          return 0
        }
      } catch (error) {
        log('warn', '信任栅栏异常，按拒绝处理：' + String((error && error.message) || error))
        return 403
      }
      const authority = String((req.headers && req.headers.host) || '').toLowerCase()
      const bare = authority.replace(/:\d+$/, '')
      if (isLoopbackAuthority(authority) || trustedAuthorities.includes(authority) || trustedAuthorities.includes(bare)) return 0
      return 403
    }

    const readBody = (req, limit = 65536) =>
      new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > limit) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })

    const send = (res, status, payload) => {
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    }

    root.inject(['webServer'], (context) => {
      const disposers = []
      const route = (suffix, handler) => {
        disposers.push(
          context.webServer.register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}${suffix}`,
            handler: async (req, res) => {
              try {
                const rejected = rejectionOf(req, context)
                if (rejected !== 0) {
                  send(res, rejected, { ok: false, error: 'rejected' })
                  return
                }
                const url = new URL(req.url || '/', 'http://localhost')
                await handler(req, res, url)
              } catch (error) {
                send(res, 200, { ok: false, error: String((error && error.message) || error) })
              }
            },
          }),
        )
      }

      route('/snapshot.json', async (req, res, url) => {
        const sessionId = url.searchParams.get('sessionId')
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        send(res, 200, snapshotPayload(sessionId))
      })

      route('/calls.json', async (req, res, url) => {
        const scope = ['session', 'today', 'month', 'all'].includes(url.searchParams.get('scope'))
          ? url.searchParams.get('scope')
          : 'all'
        const sessionId = url.searchParams.get('sessionId')
        const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100)
        const offset = clampInt(url.searchParams.get('offset'), 0, 1000000, 0)
        const calls = selectCalls(scope, sessionId)
        const ordered = calls.slice().reverse()
        send(res, 200, {
          ok: true,
          scope,
          sessionId: sessionId || null,
          total: ordered.length,
          summary: aggregate(calls),
          calls: ordered.slice(offset, offset + limit),
        })
      })

      route('/heatmap.json', async (req, res, url) => {
        const weeks = url.searchParams.get('weeks') || config.heatmapWeeks
        send(res, 200, { ok: true, balance: ledger.balance, ...heatmapRows(weeks) })
      })

      route('/balance.json', async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 200, { ok: true, balance: ledger.balance })
          return
        }
        const balance = await refreshBalance({ force: true })
        send(res, 200, { ok: true, balance })
      })

      route('/config.json', async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          send(res, 200, { ok: true, config })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readBody(req)
        const patch = body ? JSON.parse(body) : {}
        if (!isPlainObject(patch)) throw new Error('配置必须是 JSON 对象')
        const saved = saveConfig(patch)
        send(res, 200, { ok: true, config: saved })
      })

      context.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 忽略注销异常 */
          }
        }
      })
    })

    log('info', `已就绪：账本 ${LEDGER_FILE}`)
  },
}

/**
 * 纯函数出口，只给自测脚本用（Host 侧不读取它）。
 * `node test/self-test.mjs` 会先设好 DSH_HOME 再动态 import 本模块。
 */
export const __test__ = {
  DEFAULT_CONFIG,
  DEFAULT_HOLIDAYS,
  normalizeConfig,
  dayOf,
  isPeakAt,
  nextPeakChangeAt,
  priceFor,
  costOf,
  usageOf,
  emptyDay,
  emptyLedger,
  normalizeLedger,
  DATA_DIR,
  LEDGER_FILE,
  CONFIG_FILE,
}
