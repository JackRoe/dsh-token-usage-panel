# dsh-token-usage-panel

DSH（DeepSeek Harness）对话区下方的**模型用量面板**：逐次调用的 token 与花费、峰谷计价、账号余额、日历热力图，全部落在输入卡下方那一条状态条里。

```
会话 ¥0.561 · 15.9M   今日 ¥0.561 · 15.9M ............ 余额 ¥3.44   谷价 · 21h02m   明细 ▴
```

条内从左到右：支出（会话 / 今日）→ 靠右组（余额 / 峰谷状态 / 明细开关）。
**三个主项（会话 / 今日 / 余额）在任何宽度下都常驻**；宽度不够时只压缩次要数字，且永远保持一排：

| 宽度 | 显示 |
|---|---|
| 宽裕 | 会话 ¥x · tokens　今日 ¥x · tokens　余额 ¥x　谷价 · 21h02m　明细 |
| 偏窄 | 会话 ¥x · tokens　今日 ¥x　余额 ¥x　谷价 · 21h02m　明细 |
| 很窄 | 会话 ¥x　今日 ¥x　余额 ¥x　谷价 · 21h02m　明细 |

峰谷倒计时任何档位都完整保留（不随密度压缩）。

判定用一条隐形探针量「当前档位」的真实宽度：放不下升一档，留出 ≥80px 余量才降档，因此不会来回抖；
更窄时由 `nowrap` + 省略号兜底，绝不会变成两排。整条状态条用 `order:1` 排在官方「上下文用量环」
**之后**（dock 本身是 `display:flex` 的 flex 行，list slot 是 Fragment 渲染），所以那枚环落在「会话」左边、
峰谷与明细靠容器右边。

点「明细」在输入卡上方展开面板，四个页签：

| 页签 | 内容 |
|---|---|
| 逐次调用 | 每一次模型调用的时间、模型、未命中输入 / 缓存命中 / 输出 token、峰或谷、按单价算出的花费；可按**本会话 / 今日 / 近 30 天 / 全部**切换，附合计行与分页加载 |
| 日历热力图 | 13 / 26 / 39 / 53 周可切的滚动格子，按当日花费分色，悬停显示 日期 · 花费 · 调用次数 · token（有余额观测时还显示当日实扣） |
| 余额 | 充值余额、赠送余额、最近观测时间、手动刷新；「今日余额实扣」与「今日表价估算」并排对账 |
| 设置 | 状态条开关、热力图默认周数、缓存写入计价口径、余额刷新间隔、单价表、峰时段、法定节假日 |

## 安装

```bash
# 从 npm（若有发布）
dsh plugin --profile desktop add dsh-token-usage-panel

# 本地开发（link 安装，改代码即时生效，见「开发」）
dsh plugin --profile desktop add link:<本目录绝对路径>
```

也可以在 **设置 → 插件** 里开关；关掉后对话区下方的状态条立即消失，已有的账本数据保留。

> 仓库：[https://github.com/JackRoe/dsh-token-usage-panel](https://github.com/JackRoe/dsh-token-usage-panel) · 许可 MIT · 版本 0.2.3

## 从 GitHub 安装

```bash
git clone https://github.com/JackRoe/dsh-token-usage-panel.git
# 然后把克隆下来的目录用 link 方式挂进 DSH（改代码即时生效）
dsh plugin --profile desktop add link:<克隆目录的绝对路径>
```

Windows 下若 `git clone` 拉不动，先确认 hosts 里没有把 `github.com` 指到 `127.0.0.1` 的残留条目。

## 数据从哪来

| 数据 | 来源 | 口径 |
|---|---|---|
| 每次调用的 token | Host 侧 `session/event` 事件流里的 `assistant/message`，其 `data.usage` 是提供方回报的真实用量 | `inputTokens` 是**未命中缓存的输入**、`cacheReadTokens` 是命中部分，两者不重叠；`outputTokens` 已含 `reasoningTokens`（dsh-token-meter 保证 reasoning ⊆ output，因此不重复计费） |
| 模型与供应商 | 同一事件的 `data.message.source.{provider,model}` | 用于查单价表，最长键优先的子串匹配，未知模型回落 `_default` |
| 计费时点 | 事件的 `time`（调用发生时刻），不是渲染时刻 | 历史账目不会随当前时段漂移 |
| 余额 | Host 服务 `deepseekAccount.getBalance(...)`（官方平台账号服务） | 只读；充值余额与赠送余额分列；定时刷新 + 手动刷新；**API Key 模式下列不出账号余额** |
| 余额实扣 | 插件自己按时间采样的余额观测（同日「首次 − 最近」，只记净减少） | 属于观测值：只在「界面开着且余额可读」时有数据，因此面板把它标注为实扣并允许与表价估算对比，而不是当成账单 |

## 峰谷计价（默认值）

默认规则与单价取自本机已装的 `dsh-whale-widget@0.3.18` 所记录的 DeepSeek 官方口径
（官方 pricing 文档，其 2026-09-19 复核过）：

- **峰时段**：工作日（北京时间）**09:00–12:00、14:00–18:00**
- **谷时段**：其余时段，含**周末全天**与**中国法定节假日全天**
- **峰价 = 谷价 × 2**

| 模型 | 缓存命中 | 未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash`（V4.1-Flash） | 谷 0.02 / 峰 0.04 | 谷 1 / 峰 2 | 谷 4 / 峰 8 |
| `deepseek-v4-pro` | 谷 0.15 / 峰 0.30 | 谷 4.5 / 峰 9 | 谷 13.5 / 峰 27 |

单位：**元 / 百万 token**。缓存写入默认按「未命中输入」计价（DeepSeek 官方口径），可在设置里关掉。

单价表、峰时段、节假日、时区偏移都能在**设置页签**里改（JSON 编辑，保存即生效）。
改单价与时段**只影响之后的记账**，已记录的账目不会重算——这样历史数字始终可复现。
`holidays` 默认内置 2026 年法定节假日；次年安排公布后请在设置里补日期。

## 本地文件

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/usage-panel/ledger.json` | 账本：逐次调用明细（默认保留 400 天，上限 5 万条）+ 按日聚合（永久保留，热力图不会出现空洞）+ 会话标题/汇总 + 余额快照与观测点 |
| `$DSH_HOME/usage-panel/config.json` | 配置（设置页保存的就是它） |

`$DSH_HOME` 默认是 `~/.dsh`。写盘用「tmp + rename」原子替换，并做 1.5 秒合并写，不会因为高频记账而反复落盘。

## HTTP 路由（排查用）

Host 半注册了 5 条只读为主的 JSON 路由：

| 路由 | 说明 |
|---|---|
| `GET /dsh-usage-panel/snapshot.json?sessionId=` | 状态条需要的全部数据（今日/本会话/近 30 天/总计/峰谷状态/余额/配置） |
| `GET /dsh-usage-panel/calls.json?scope=&sessionId=&limit=&offset=` | 逐次调用明细与合计 |
| `GET /dsh-usage-panel/heatmap.json?weeks=` | 按日聚合（含零值填充）与区间合计 |
| `GET/POST /dsh-usage-panel/config.json` | 读 / 改配置 |
| `GET/POST /dsh-usage-panel/balance.json` | 读 / 强制刷新余额 |

这些路由走 DSH 自己的信任栅栏：优先委托 `ctx.connection.requestRejection(req)`（含浏览器会话鉴权）；
宿主栅栏不可用时退回本插件自带的回环 `Host` 校验，非回环来源一律 403（可用环境变量
`DSH_USAGE_PANEL_TRUSTED_HOSTS` 声明额外的可信 authority）。浏览器里打开时带会话 cookie 才会拿到 200。

## 开发

浏览器半是**手写的 `__ModuleLoader__.load` bundle**（不需要 tsdown 构建）：改 `lib/client.js`
后，`dsh-client-hmr` 的 stat 监听会推到 `clientModules.rebuilt()`，页面热重载即可看到效果。
Host 半是零依赖 ESM（只用 node: 内置模块）——第三方插件安装目录解析不到 `@deepseek-ai/*` 依赖，
所以凡是需要 DSH 能力的地方都走 Cordis 服务注入。

```bash
# Host 半 + 计价/峰谷/路由/落盘（假 Cordis root 跑真实 apply）
node test/self-test.mjs

# 浏览器半（迷你 hooks 运行时真渲染四个页签，fetch 换成本地假数据）
node test/client-smoke.mjs

# 对正在运行的 DSH 做只读验证：从活动 graph 取真实 bundle URL 并拉取
node test/verify-live.mjs [http://127.0.0.1:19387]
```

## 已知限制

- **估算 ≠ 账单**：表价估算受缓存命中判定、赠送额度、优惠活动影响；面板把「余额实扣」并列展示供对账，但不替代平台账单。
- **余额只在账号登录模式下可用**：用 API Key 直连时账号服务返回空，面板会显示未登录/不可用。
- **热力图按日 86400000 毫秒推进**：对 UTC+8 无影响；若把时区偏移改成有夏令时的地区，跨 DST 的边界日可能偏一天。
- **节假日表需要人工维护**：默认只含 2026 年。
- **依赖未公开契约**：手写 bundle 依赖 `__ModuleLoader__`、slot props 组成（`t` / `useSession` / `inject(sessionId)`）与 `conversation.composer.dock` 的存在；这些是官方客户端插件的现行契约但不是给第三方的稳定 API，DSH 升级后若失效需要跟着修。
- 子代理 / fork 会话的调用同样计入总量与热力图，会话维度按各自 sessionId 分开。
- 账本只从**安装之后**开始记录；安装前的历史调用不会回填。

## 变更记录

| 版本 | 变更 |
|---|---|
| 0.1.0 | 首版：逐次调用明细、峰谷计价、余额查询、日历热力图，注册进 `conversation.composer.dock`。（0.1.0 的备份留在开发机的本地工作区里，不随仓库发布；需要回退时覆盖回插件目录即可，link 安装无需重装。） |
| 0.2.0 | ① 状态条改 `order:1` + `flex:1 1 auto`，整条排到官方上下文用量环之后（环落在「本次会话」左边），支出在左、余额 / 峰谷 / 明细靠右；② 余额改为**充值 + 赠送**合计（此前只算充值，纯赠送账号会显示 ¥0），悬停给出「充值 / 赠送」拆分；③ 状态条内的 chip 与开关设 `flex:0 0 auto`，空间紧张时换行而不是被压成零宽。 |
| 0.2.1 | ① 收紧一排：间距 8→6px、chip 高 22→20px、内边距 8→7px，「本次会话」→「会话」、「谷价 · 距切换 21h02m」→「谷价 · 21h02m」（完整说明移到悬停提示），小于 1 元的花费去掉末尾 0（¥0.5610 → ¥0.561）；② 状态条改 `flex-wrap:nowrap` + 可收缩 chip（超长省略号），并加**隐形探针 + 密度测量**。 |
| 0.2.2 | 密度策略改为「**三项常驻、只压次要数字**」：0.2.1 会在窄时整块摘掉「今日」「余额」，导致状态条变得太窄；现在会话 / 今日 / 余额在任何宽度都保留，只在放不下时去掉 token 数字。同时探针改为量当前档位（升档无余量、降档需 ≥80px 余量），token 的 M 档小数从 2 位收到 1 位（15.92M → 15.9M）。 |
| 0.2.3 | 峰谷倒计时改为**任何档位都完整显示**（此前最窄档会去掉倒计时）：会话 / 今日 / 余额 / 峰谷倒计时四项常驻，密度只压缩 token 数字。其余不变。 |

## 许可

MIT。默认单价表与峰谷规则来自 `dsh-whale-widget` 记录的 DeepSeek 官方价格口径（仅数据引用，代码独立实现）。
