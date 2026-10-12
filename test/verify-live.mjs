/**
 * 对「正在运行的 DSH」做一次只读验证：`node test/verify-live.mjs [origin]`
 *
 * 步骤：
 *   1. 订阅 /plugins/events（client-modules 的 SSE 图/重建通道），取当前活动 graph；
 *   2. 在 graph.entries 里找本插件行，拿到它真实的 bundle URL 与 rev；
 *   3. 取该 bundle，确认内容就是我们在对话区下方注册的那份客户端代码；
 *   4. 顺带打印 Host 账本摘要与余额快照。
 *
 * 只读：不写任何文件、不改任何配置。Host 的 JSON 路由需要浏览器会话 cookie，
 * 所以这里只验公开静态资源与账本落盘（401 属正常，见 dsh-client-connection 的鉴权说明）。
 */
import fs from 'node:fs'
import path from 'node:path'

const origin = process.argv[2] || 'http://127.0.0.1:19387'
const ID = 'dsh-token-usage-panel'

/** 抓一小段 SSE 流，返回拼起来的文本。 */
const readEventStream = async (url, ms) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  let text = ''
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
    if (!response.ok) return { status: response.status, text: '' }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(`"id":"${ID}"`)) break
    }
  } catch {
    /* abort 是正常收尾 */
  } finally {
    clearTimeout(timer)
  }
  return { status: 200, text }
}

const stream = await readEventStream(`${origin}/plugins/events`, 5000)
if (stream.status !== 200) {
  console.log(`✗ /plugins/events 不可用（HTTP ${String(stream.status)}）；请确认 DSH 正在运行。`)
  process.exit(1)
}

/** SSE 的 data: 行里是 JSON。 */
const frames = stream.text
  .split(/\r?\n/)
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6))
    } catch {
      return null
    }
  })
  .filter(Boolean)

const graph = frames.map((frame) => frame.graph).filter(Boolean).pop()
if (!graph) {
  console.log('✗ SSE 里没有 graph 帧。')
  process.exit(1)
}

const entry = (graph.entries || []).find((row) => row.id === ID)
console.log('图 rev      : ' + graph.rev)
console.log('图内条目数  : ' + String((graph.entries || []).length))

if (!entry) {
  console.log(`\n✗ 活动 graph 里没有 ${ID}：检查 bundle patch 是否插入、浏览器半是否声明 dsh.client。`)
  process.exit(1)
}

const batch = (graph.batches || []).find((item) => (item.entries || []).includes(ID))
console.log('插件行      : ' + JSON.stringify(entry))
console.log('所在批次    : ' + (batch ? `${batch.phase} · ${batch.url.slice(0, 96)}…` : '(未在任何批次中)'))

const bundleUrl = `${origin}/${entry.url.replace(/^\/+/, '')}`
const response = await fetch(bundleUrl)
const body = await response.text()
console.log('bundle      : HTTP ' + String(response.status) + ' · ' + String(body.length) + ' bytes · ' + bundleUrl)

const checks = [
  ['包含 __ModuleLoader__.load', 'window.__ModuleLoader__.load'],
  ['id 与本插件一致', `id: "${ID}"`],
  ['注册进 conversation.composer.dock', 'conversation.composer.dock'],
  ['带峰谷计价展示', 'barPeak'],
]
let ok = response.status === 200
for (const [label, needle] of checks) {
  const hit = body.includes(needle)
  ok = ok && hit
  console.log((hit ? '  ✓ ' : '  ✗ ') + label)
}

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const ledgerFile = path.join(home, 'usage-panel', 'ledger.json')
if (fs.existsSync(ledgerFile)) {
  const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  const days = Object.keys(data.days || {}).sort()
  console.log('\nHost 账本   : ' + String(data.calls.length) + ' 条明细 · ¥' + data.totals.cost.toFixed(6) + ' · 日 ' + days.join(','))
  if (data.balance) {
    console.log(
      '余额        : ' +
        String(data.balance.status) +
        ' · 充值 ' +
        JSON.stringify((data.balance.wallets || []).map((w) => w.balance)) +
        ' · 赠送 ' +
        JSON.stringify((data.balance.bonusWallets || []).map((w) => w.balance)),
    )
  } else {
    console.log('余额        : 尚未取到')
  }
} else {
  console.log('\nHost 账本   : 还没有（尚未发生模型调用）')
}

console.log(ok ? '\n✓ 客户端半已在活动 graph 中、可被页面加载：刷新页面即可在对话区下方看到状态条。' : '\n✗ bundle 未如期提供。')
process.exit(ok ? 0 : 1)
