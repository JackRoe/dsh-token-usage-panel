/**
 * dsh-token-usage-panel —— 浏览器半（DSH 客户端插件 bundle）。
 *
 * 形态：`window.__ModuleLoader__.load({ id, factory })`，由 dsh-client-modules
 * 从 `<包名>/client.js` 路由加载。factory 内 `require("react")` 用的是平台种子模块，
 * 其余能力一律走注入的 Cordis 客户端服务（slots / locale）。
 *
 * 上屏位置：`conversation.composer.dock`（session 域 list slot，官方语义是
 * “输入卡下方的环境条目”），即对话区最下方、与官方上下文占用条同行。
 * 数据来自 Host 半的 `/dsh-usage-panel/*` JSON 路由。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-usage-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const NS = "usage-panel";
		const API = "/dsh-usage-panel";
		const POLL_MS = 4000;

		/* ------------------------------------------------------------ *
		 * 样式（自带 <style>，随插件生命周期回收）
		 * ------------------------------------------------------------ */

		const CSS = `
/* 输入卡下方的 .RlGAzG_dock 是 display:flex; justify-content:center; gap:12px 的 flex 行，
   list slot 又是 Fragment 渲染（每个注册条目都是 dock 的直接 flex 子项）。
   所以 order:1 把本状态条整体排到官方上下文占用环之后（= 环落在“本次会话”左边），
   flex:1 1 auto 让状态条吃掉剩余宽度，右端对齐容器右边（峰谷/余额/明细因此靠右）。 */
.up-root{position:relative;order:1;flex:1 1 auto;min-width:0;box-sizing:border-box;margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary, #8b8b8f)}
/* 一排到底：nowrap + 可收缩的 chip（超长时省略号而不是换行）；
   放不下的项由密度测量（见 .up-probe）提前摘掉，控制条永远不占两行。 */
.up-bar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;min-height:20px;padding:0 2px;overflow:hidden}
.up-barSpacer{flex:1 1 auto;min-width:4px}
.up-probe{position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;overflow:visible;white-space:nowrap}
/* 探针里的项不可收缩，保证量到的是“全量自然宽度” */
.up-probe .up-chip,.up-probe .up-toggle{flex:0 0 auto}
.up-chip{display:inline-flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));white-space:nowrap;font-variant-numeric:tabular-nums}
.up-chipLabel{flex:0 0 auto;color:var(--dsw-alias-label-secondary, #8b8b8f)}
.up-chipValue{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary, #e8e8ea);font-weight:500}
.up-peak{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9a441) 18%, transparent);color:var(--dsw-alias-state-warn-primary, #d9a441)}
.up-valley{background:color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fa66a) 18%, transparent);color:var(--dsw-alias-state-success-primary, #3fa66a)}
.up-toggle{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;height:20px;padding:0 9px;border:0;border-radius:999px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary, #8b8b8f);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))}
.up-toggle:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.2))}
.up-toggle[data-open="true"]{color:var(--dsw-alias-label-primary, #e8e8ea)}
.up-warn{color:var(--dsw-alias-state-error-primary, #d9534f)}

.up-panel{position:absolute;bottom:calc(100% + 8px);right:0;left:auto;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;width:min(460px,100%);max-height:min(64vh,440px);border:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));border-radius:var(--dsw-radius-lg, 12px);background:var(--dsw-alias-bg-overlay, var(--dsw-specific-menu, #1f1f21));box-shadow:var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.32));backdrop-filter:var(--dsw-menu-backdrop-filter, none);overflow:hidden;color:var(--dsw-alias-label-secondary, #8b8b8f)}
.up-head{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))}
.up-tab{border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary, #8b8b8f);padding:4px 10px;border-radius:999px;cursor:pointer}
.up-tab:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))}
.up-tab[data-active="true"]{color:var(--dsw-alias-label-primary, #e8e8ea);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16))}
.up-body{overflow:auto;padding:8px}
.up-seg{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));margin-bottom:8px}
.up-seg button{border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary, #8b8b8f);padding:3px 10px;border-radius:999px;cursor:pointer}
.up-seg button[data-active="true"]{background:var(--dsw-alias-bg-layer-1, rgba(127,127,127,.2));color:var(--dsw-alias-label-primary, #e8e8ea)}
.up-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.up-table th{position:sticky;top:-8px;background:inherit;text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary, #8b8b8f);padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18));white-space:nowrap}
.up-table th:first-child,.up-table td:first-child{text-align:left}
.up-table td{text-align:right;padding:3px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.1));white-space:nowrap;color:var(--dsw-alias-label-primary, #d8d8da)}
.up-table td.up-dim{color:var(--dsw-alias-label-secondary, #8b8b8f)}
.up-tag{display:inline-block;min-width:26px;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;text-align:center}
.up-foot{display:flex;justify-content:space-between;gap:8px;padding-top:6px;color:var(--dsw-alias-label-secondary, #8b8b8f)}
.up-btn{border:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary, #e8e8ea);font:inherit;font-size:12px;padding:3px 10px;border-radius:8px;cursor:pointer}
.up-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))}
.up-btn[disabled]{opacity:.5;cursor:default}
.up-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7, 11px);gap:3px;justify-content:start;padding:2px 0}
.up-cell{width:11px;height:11px;border-radius:2px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))}
.up-legend{display:flex;align-items:center;gap:4px;justify-content:flex-end;padding-top:6px}
.up-legend i{display:block;width:11px;height:11px;border-radius:2px}
.up-cards{display:flex;flex-wrap:wrap;gap:8px}
.up-card{flex:1 1 140px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))}
.up-cardTitle{font-size:11px;color:var(--dsw-alias-label-secondary, #8b8b8f)}
.up-cardValue{font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary, #e8e8ea);font-variant-numeric:tabular-nums}
.up-field{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.12))}
.up-field:last-child{border-bottom:0}
.up-field label{color:var(--dsw-alias-label-primary, #d8d8da)}
.up-area{box-sizing:border-box;width:100%;min-height:64px;margin-top:6px;padding:6px;border:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));border-radius:8px;background:var(--dsw-alias-bg-layer-1, rgba(0,0,0,.18));color:var(--dsw-alias-label-primary, #e8e8ea);font:11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;resize:vertical}
.up-note{font-size:11px;color:var(--dsw-alias-label-secondary, #8b8b8f);padding-top:4px}
`;

		let cssTag = null;

		const installStyles = () => {
			if (typeof document === "undefined") return;
			if (cssTag !== null) return;
			const existing = document.querySelector('style[data-plugin-css="' + NS + '"]');
			if (existing !== null) {
				cssTag = existing;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage-panel";
			tag.dataset.pluginCss = NS;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			cssTag = tag;
		};

		const removeStyles = () => {
			if (cssTag !== null && cssTag.parentNode !== null) cssTag.parentNode.removeChild(cssTag);
			cssTag = null;
		};

		/* ------------------------------------------------------------ *
		 * 词典
		 * ------------------------------------------------------------ */

		const zh = {
			barSession: "会话",
			barToday: "今日",
			barMonth: "近30天",
			barBalance: "余额",
			barPeak: "峰价",
			barValley: "谷价",
			barPeakSuffix: "×{n}",
			barToSwitch: "{t}",
			barOpen: "明细",
			barClose: "收起",
			barUnavailable: "用量服务不可用",
			barRetry: "重试",
			barTokens: "tokens",
			balanceSplit: "充值 {a} · 赠送 {b}",
			tabCalls: "逐次调用",
			tabHeatmap: "日历热力图",
			tabBalance: "余额",
			tabSettings: "设置",
			scopeSession: "本会话",
			scopeToday: "今日",
			scopeMonth: "近30天",
			scopeAll: "全部",
			colTime: "时间",
			colModel: "模型",
			colInput: "输入",
			colCache: "缓存",
			colOutput: "输出",
			colPeriod: "时段",
			colCost: "花费",
			peakShort: "峰",
			valleyShort: "谷",
			empty: "这个范围还没有记录",
			loadMore: "加载更多",
			summaryCalls: "{n} 次调用",
			summaryCost: "合计 {v}",
			heatWeeks: "周数",
			heatTotal: "区间合计 {v}",
			heatTokens: "tokens {v}",
			heatActive: "活跃 {n} 天",
			heatLess: "少",
			heatMore: "多",
			balanceTopUp: "充值余额",
			balanceBonus: "赠送余额",
			balanceUpdated: "更新于 {t}",
			balanceRefresh: "刷新",
			balanceUnavailable: "当前未登录账号，或余额接口不可用",
			balanceSignedOut: "（API Key 模式下列不出账号余额）",
			balanceTodayObserved: "今日余额实扣",
			balanceTodayEstimate: "今日表价估算",
			balanceDelta: "差额 {v}（实扣 − 估算）",
			setShowDock: "在对话区下方显示状态条",
			setWeeks: "热力图默认周数",
			setCacheWrite: "缓存写入按“未命中输入”计价",
			setRefresh: "余额刷新间隔（秒）",
			setPrices: "单价表（元/百万 token，[谷价, 峰价]）",
			setWindows: "峰时段（本地整点区间）",
			setHolidays: "法定节假日（全天谷价）",
			setSave: "保存",
			setSaved: "已保存",
			setReset: "恢复默认",
			setError: "保存失败：{v}",
			settingsNote: "单价与时段改动只影响之后的记账；已记录账目不会被重算。",
		};

		const en = {
			barSession: "Session",
			barToday: "Today",
			barMonth: "30 days",
			barBalance: "Balance",
			barPeak: "Peak",
			barValley: "Off-peak",
			barPeakSuffix: "×{n}",
			barToSwitch: "{t}",
			barOpen: "Details",
			barClose: "Collapse",
			barUnavailable: "Usage service unavailable",
			barRetry: "Retry",
			barTokens: "tokens",
			balanceSplit: "Topped-up {a} · Granted {b}",
			tabCalls: "Calls",
			tabHeatmap: "Calendar",
			tabBalance: "Balance",
			tabSettings: "Settings",
			scopeSession: "Session",
			scopeToday: "Today",
			scopeMonth: "30 days",
			scopeAll: "All",
			colTime: "Time",
			colModel: "Model",
			colInput: "In",
			colCache: "Cache",
			colOutput: "Out",
			colPeriod: "Rate",
			colCost: "Cost",
			peakShort: "P",
			valleyShort: "V",
			empty: "No records in this range yet",
			loadMore: "Load more",
			summaryCalls: "{n} calls",
			summaryCost: "Total {v}",
			heatWeeks: "Weeks",
			heatTotal: "Range total {v}",
			heatTokens: "{v} tokens",
			heatActive: "{n} active days",
			heatLess: "Less",
			heatMore: "More",
			balanceTopUp: "Topped-up",
			balanceBonus: "Granted",
			balanceUpdated: "Updated {t}",
			balanceRefresh: "Refresh",
			balanceUnavailable: "Not signed in, or the balance endpoint is unavailable",
			balanceSignedOut: "(API-key mode exposes no account balance)",
			balanceTodayObserved: "Balance debited today",
			balanceTodayEstimate: "Table estimate today",
			balanceDelta: "Delta {v} (debited − estimate)",
			setShowDock: "Show the bar under the conversation",
			setWeeks: "Default heatmap weeks",
			setCacheWrite: "Bill cache writes as uncached input",
			setRefresh: "Balance refresh interval (s)",
			setPrices: "Prices (per 1M tokens, [off-peak, peak])",
			setWindows: "Peak windows (local hours)",
			setHolidays: "Statutory holidays (all off-peak)",
			setSave: "Save",
			setSaved: "Saved",
			setReset: "Restore defaults",
			setError: "Save failed: {v}",
			settingsNote: "Price and window changes affect later records only; past entries are not recalculated.",
		};

		/* ------------------------------------------------------------ *
		 * 工具
		 * ------------------------------------------------------------ */

		const symbolOf = (currency) => (currency === "USD" ? "$" : "¥");

		/** 去掉小数末尾的 0（只用于小于 1 的花费数字：0.5610 → 0.561）。 */
		const trimZeros = (text) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);

		const fmtMoney = (value, currency) => {
			const amount = Number(value) || 0;
			const sign = amount < 0 ? "-" : "";
			const abs = Math.abs(amount);
			// 余额这类 ≥1 的金额保留两位（¥4.50）；小于 1 的花费去掉末尾 0，状态条更短
			const text = abs === 0 ? "0" : abs < 0.01 ? trimZeros(abs.toFixed(5)) : abs < 1 ? trimZeros(abs.toFixed(4)) : abs.toFixed(2);
			return sign + symbolOf(currency) + text;
		};

		const fmtTokens = (value) => {
			const n = Number(value) || 0;
			if (n < 1000) return String(n);
			if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
			return (n / 1e6).toFixed(1) + "M";
		};

		const fmtDuration = (ms) => {
			const total = Math.max(0, Math.round(Number(ms) / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (hours > 0) return hours + "h" + String(minutes).padStart(2, "0") + "m";
			if (minutes > 0) return minutes + "m";
			return total + "s";
		};

		const fmtClock = (ms) => {
			try {
				const date = new Date(Number(ms));
				return [date.getHours(), date.getMinutes(), date.getSeconds()]
					.map((part) => String(part).padStart(2, "0"))
					.join(":");
			} catch {
				return "--:--:--";
			}
		};

		const fmtDateTime = (ms) => {
			try {
				const date = new Date(Number(ms));
				return (
					date.getFullYear() +
					"-" +
					String(date.getMonth() + 1).padStart(2, "0") +
					"-" +
					String(date.getDate()).padStart(2, "0") +
					" " +
					fmtClock(ms)
				);
			} catch {
				return "-";
			}
		};

		const fill = (template, values) => {
			let out = template;
			for (const [key, value] of Object.entries(values)) out = out.split("{" + key + "}").join(String(value));
			return out;
		};

		const requestJson = async (path, options) => {
			const response = await fetch(API + path, {
				cache: "no-store",
				headers: { accept: "application/json" },
				...options,
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			const payload = await response.json();
			if (payload && payload.ok === false) throw new Error(String(payload.error || "request failed"));
			return payload;
		};

		/* ------------------------------------------------------------ *
		 * 数据订阅
		 * ------------------------------------------------------------ */

		/** 轮询 Host 快照；会话从运行变为空闲时立刻补一次。 */
		const useSnapshot = (sessionId, running) => {
			const [state, setState] = React.useState({ data: null, error: null, loading: true });
			const sessionRef = React.useRef(sessionId);
			sessionRef.current = sessionId;

			const load = React.useCallback(async () => {
				const id = sessionRef.current;
				const query = id === undefined || id === null ? "" : "?sessionId=" + encodeURIComponent(String(id));
				try {
					const data = await requestJson("/snapshot.json" + query);
					setState({ data, error: null, loading: false });
				} catch (error) {
					setState((prev) => ({ data: prev.data, error: String((error && error.message) || error), loading: false }));
				}
			}, []);

			React.useEffect(() => {
				void load();
				const timer = setInterval(() => void load(), POLL_MS);
				return () => clearInterval(timer);
			}, [load, sessionId]);

			React.useEffect(() => {
				if (running === false) void load();
			}, [load, running]);

			return { ...state, reload: load };
		};

		/* ------------------------------------------------------------ *
		 * 组件
		 * ------------------------------------------------------------ */

		const Chip = ({ label, value, tone, title }) =>
			h(
				"span",
				{ className: "up-chip" + (tone ? " " + tone : ""), title: title },
				label ? h("span", { className: "up-chipLabel" }, label) : null,
				h("span", { className: "up-chipValue" }, value),
			);

		const CallsTab = ({ t, sessionId }) => {
			const [scope, setScope] = React.useState(sessionId ? "session" : "today");
			const [state, setState] = React.useState({ calls: [], summary: null, total: 0, loading: true, error: null });

			const load = React.useCallback(
				async (nextScope, offset) => {
					setState((prev) => ({ ...prev, loading: true }));
					const params = new URLSearchParams({ scope: nextScope, limit: "100", offset: String(offset || 0) });
					if (sessionId) params.set("sessionId", String(sessionId));
					try {
						const payload = await requestJson("/calls.json?" + params.toString());
						setState((prev) => ({
							calls: offset ? prev.calls.concat(payload.calls || []) : payload.calls || [],
							summary: payload.summary || null,
							total: payload.total || 0,
							loading: false,
							error: null,
						}));
					} catch (error) {
						setState((prev) => ({ ...prev, loading: false, error: String((error && error.message) || error) }));
					}
				},
				[sessionId],
			);

			React.useEffect(() => {
				void load(scope, 0);
			}, [load, scope]);

			const scopes = [
				["session", t("scopeSession")],
				["today", t("scopeToday")],
				["month", t("scopeMonth")],
				["all", t("scopeAll")],
			];

			const rows = state.calls.map((call) =>
				h(
					"tr",
					{ key: call.id },
					h("td", { className: "up-dim" }, fmtClock(call.at)),
					h("td", { className: "up-dim" }, call.model || "-"),
					h("td", null, fmtTokens(call.input)),
					h("td", { className: "up-dim" }, fmtTokens(call.cacheRead)),
					h("td", null, fmtTokens(call.output)),
					h(
						"td",
						null,
						h("span", { className: "up-tag " + (call.peak ? "up-peak" : "up-valley") }, call.peak ? t("peakShort") : t("valleyShort")),
					),
					h("td", null, fmtMoney(call.cost, "CNY")),
				),
			);

			return h(
				"div",
				null,
				h(
					"div",
					{ className: "up-seg" },
					scopes.map(([id, label]) =>
						h("button", { key: id, type: "button", "data-active": scope === id, onClick: () => setScope(id) }, label),
					),
				),
				state.error ? h("div", { className: "up-warn" }, state.error) : null,
				state.calls.length === 0 && !state.loading
					? h("div", { className: "up-note" }, t("empty"))
					: h(
							"table",
							{ className: "up-table" },
							h(
								"thead",
								null,
								h(
									"tr",
									null,
									h("th", null, t("colTime")),
									h("th", { style: { textAlign: "left" } }, t("colModel")),
									h("th", null, t("colInput")),
									h("th", null, t("colCache")),
									h("th", null, t("colOutput")),
									h("th", null, t("colPeriod")),
									h("th", null, t("colCost")),
								),
							),
							h("tbody", null, rows),
						),
				state.summary
					? h(
							"div",
							{ className: "up-foot" },
							h("span", null, fill(t("summaryCalls"), { n: state.summary.calls }) + " · " + fmtTokens(state.summary.tokens) + " " + t("barTokens")),
							h("span", null, fill(t("summaryCost"), { v: fmtMoney(state.summary.cost, "CNY") })),
						)
					: null,
				state.total > state.calls.length
					? h(
							"div",
							{ style: { paddingTop: "6px", textAlign: "center" } },
							h(
								"button",
								{ className: "up-btn", type: "button", disabled: state.loading, onClick: () => void load(scope, state.calls.length) },
								t("loadMore"),
							),
						)
					: null,
			);
		};

		const HeatmapTab = ({ t, defaultWeeks, onWeeks }) => {
			const [weeks, setWeeks] = React.useState(defaultWeeks || 26);
			const [state, setState] = React.useState({ data: null, error: null });

			React.useEffect(() => {
				let alive = true;
				void (async () => {
					try {
						const data = await requestJson("/heatmap.json?weeks=" + String(weeks));
						if (alive) setState({ data, error: null });
					} catch (error) {
						if (alive) setState((prev) => ({ ...prev, error: String((error && error.message) || error) }));
					}
				})();
				return () => {
					alive = false;
				};
			}, [weeks]);

			const data = state.data;
			const buckets = (value, max) => {
				if (!value || !max) return 0;
				const ratio = Math.min(1, value / max);
				return ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
			};
			const opacity = [0, 0.28, 0.48, 0.7, 1];

			const cells = (data ? data.days : []).map((day) =>
				h("div", {
					key: day.day,
					className: "up-cell",
					style: day.cost > 0 ? { background: "var(--dsw-alias-brand-primary, #4c8dff)", opacity: opacity[buckets(day.cost, data.max)] } : undefined,
					title:
						day.day +
						" · " +
						fmtMoney(day.cost, "CNY") +
						" · " +
						String(day.calls) +
						" · " +
						fmtTokens(day.tokens) +
						(day.observedDebit > 0 ? " · " + t("balanceTodayObserved") + " " + fmtMoney(day.observedDebit, "CNY") : ""),
				}),
			);

			return h(
				"div",
				null,
				h(
					"div",
					{ className: "up-seg" },
					[13, 26, 39, 53].map((value) =>
						h(
							"button",
							{
								key: value,
								type: "button",
								"data-active": weeks === value,
								onClick: () => {
									setWeeks(value);
									if (onWeeks) onWeeks(value);
								},
							},
							String(value) + " " + t("heatWeeks"),
						),
					),
				),
				state.error ? h("div", { className: "up-warn" }, state.error) : null,
				h("div", { className: "up-grid" }, cells),
				h(
					"div",
					{ className: "up-legend" },
					h("span", null, t("heatLess")),
					h(
						"span",
						{ style: { display: "inline-flex", gap: "3px" } },
						[0, 1, 2, 3, 4].map((level) =>
							h("i", {
								key: level,
								style:
									level === 0
										? { background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))" }
										: { background: "var(--dsw-alias-brand-primary, #4c8dff)", opacity: opacity[level] },
							}),
						),
					),
					h("span", null, t("heatMore")),
				),
				data
					? h(
							"div",
							{ className: "up-foot" },
							h("span", null, fill(t("heatTotal"), { v: fmtMoney(data.totals.cost, "CNY") }) + " · " + fill(t("heatTokens"), { v: fmtTokens(data.totals.tokens) })),
							h("span", null, fill(t("heatActive"), { n: data.totals.activeDays })),
						)
					: null,
			);
		};

		const BalanceTab = ({ t, snapshot, onRefresh }) => {
			const [busy, setBusy] = React.useState(false);
			const balance = snapshot ? snapshot.balance : null;
			const ready = balance && balance.status === "ready";

			const refresh = async () => {
				setBusy(true);
				try {
					await requestJson("/balance.json", { method: "POST" });
					if (onRefresh) await onRefresh();
				} catch {
					/* 刷新失败保留旧值 */
				} finally {
					setBusy(false);
				}
			};

			const observed = snapshot && snapshot.today ? snapshot.today.observedDebit || 0 : 0;
			const estimate = snapshot && snapshot.today ? snapshot.today.cost : 0;

			return h(
				"div",
				null,
				ready
					? h(
							"div",
							{ className: "up-cards" },
							h(
								"div",
								{ className: "up-card" },
								h("div", { className: "up-cardTitle" }, t("balanceTopUp")),
								h(
									"div",
									{ className: "up-cardValue" },
									(balance.wallets || []).map((wallet) => fmtMoney(wallet.balance, wallet.currency)).join(" / ") || "-",
								),
							),
							h(
								"div",
								{ className: "up-card" },
								h("div", { className: "up-cardTitle" }, t("balanceBonus")),
								h(
									"div",
									{ className: "up-cardValue" },
									(balance.bonusWallets || []).map((wallet) => fmtMoney(wallet.balance, wallet.currency)).join(" / ") || "-",
								),
							),
						)
					: h("div", { className: "up-note" }, balance && balance.status === "failed" ? t("balanceUnavailable") : t("balanceUnavailable") + " " + t("balanceSignedOut")),
				h(
					"div",
					{ className: "up-foot" },
					h("span", null, balance && balance.at ? fill(t("balanceUpdated"), { t: fmtDateTime(balance.at) }) : "-"),
					h("button", { className: "up-btn", type: "button", disabled: busy, onClick: () => void refresh() }, t("balanceRefresh")),
				),
				h(
					"div",
					{ className: "up-cards", style: { marginTop: "8px" } },
					h(
						"div",
						{ className: "up-card" },
						h("div", { className: "up-cardTitle" }, t("balanceTodayObserved")),
						h("div", { className: "up-cardValue" }, fmtMoney(observed, "CNY")),
					),
					h(
						"div",
						{ className: "up-card" },
						h("div", { className: "up-cardTitle" }, t("balanceTodayEstimate")),
						h("div", { className: "up-cardValue" }, fmtMoney(estimate, "CNY")),
					),
				),
				h("div", { className: "up-note" }, fill(t("balanceDelta"), { v: fmtMoney(observed - estimate, "CNY") })),
			);
		};

		const SettingsTab = ({ t, snapshot, onSaved }) => {
			const config = (snapshot && snapshot.config) || {};
			const [draft, setDraft] = React.useState(null);
			const [status, setStatus] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				void (async () => {
					try {
						const payload = await requestJson("/config.json");
						if (alive) setDraft(payload.config);
					} catch {
						/* 读不到配置时留空，保存仍可用 */
					}
				})();
				return () => {
					alive = false;
				};
			}, []);

			const update = (patch) => setDraft((prev) => ({ ...(prev || {}), ...patch }));

			const save = async () => {
				if (!draft) return;
				try {
					const patch = {
						showDock: draft.showDock !== false,
						heatmapWeeks: Number(draft.heatmapWeeks) || 26,
						cacheWriteBilledAsMiss: draft.cacheWriteBilledAsMiss !== false,
						balanceRefreshMs: Math.max(30, Number(draft.balanceRefreshSec) || 300) * 1000,
						currency: draft.currency || "CNY",
						peak: { offsetHours: 8, windows: parseJson(draft.windowsText, [[9, 12], [14, 18]]), holidays: parseJson(draft.holidaysText, []) },
						prices: parseJson(draft.pricesText, undefined),
					};
					if (patch.prices === undefined) delete patch.prices;
					const payload = await requestJson("/config.json", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					setDraft(payload.config);
					setStatus(t("setSaved"));
					if (onSaved) await onSaved();
				} catch (error) {
					setStatus(fill(t("setError"), { v: String((error && error.message) || error) }));
				}
			};

			if (!draft) return h("div", { className: "up-note" }, "…");

			return h(
				"div",
				null,
				h(
					"div",
					{ className: "up-field" },
					h("label", null, t("setShowDock")),
					h("input", { type: "checkbox", checked: draft.showDock !== false, onChange: (event) => update({ showDock: event.target.checked }) }),
				),
				h(
					"div",
					{ className: "up-field" },
					h("label", null, t("setWeeks")),
					h("input", {
						type: "number",
						min: 4,
						max: 53,
						value: draft.heatmapWeeks || 26,
						style: { width: "64px" },
						onChange: (event) => update({ heatmapWeeks: event.target.value }),
					}),
				),
				h(
					"div",
					{ className: "up-field" },
					h("label", null, t("setCacheWrite")),
					h("input", {
						type: "checkbox",
						checked: draft.cacheWriteBilledAsMiss !== false,
						onChange: (event) => update({ cacheWriteBilledAsMiss: event.target.checked }),
					}),
				),
				h(
					"div",
					{ className: "up-field" },
					h("label", null, t("setRefresh")),
					h("input", {
						type: "number",
						min: 30,
						max: 3600,
						value: draft.balanceRefreshSec || Math.round((draft.balanceRefreshMs || 300000) / 1000),
						style: { width: "72px" },
						onChange: (event) => update({ balanceRefreshSec: event.target.value }),
					}),
				),
				h("div", { className: "up-note" }, t("setWindows")),
				h("textarea", {
					className: "up-area",
					value: draft.windowsText !== undefined ? draft.windowsText : JSON.stringify((draft.peak && draft.peak.windows) || [[9, 12], [14, 18]]),
					onChange: (event) => update({ windowsText: event.target.value }),
				}),
				h("div", { className: "up-note" }, t("setHolidays")),
				h("textarea", {
					className: "up-area",
					value: draft.holidaysText !== undefined ? draft.holidaysText : JSON.stringify((draft.peak && draft.peak.holidays) || []),
					onChange: (event) => update({ holidaysText: event.target.value }),
				}),
				h("div", { className: "up-note" }, t("setPrices")),
				h("textarea", {
					className: "up-area",
					style: { minHeight: "104px" },
					value: draft.pricesText !== undefined ? draft.pricesText : JSON.stringify(draft.prices || {}, null, 1),
					onChange: (event) => update({ pricesText: event.target.value }),
				}),
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "8px", paddingTop: "8px" } },
					h("button", { className: "up-btn", type: "button", onClick: () => void save() }, t("setSave")),
					h("span", { className: "up-note" }, status),
				),
				h("div", { className: "up-note" }, t("settingsNote")),
			);
		};

		function parseJson(text, fallback) {
			if (typeof text !== "string" || text.trim() === "") return fallback;
			try {
				return JSON.parse(text);
			} catch {
				return fallback;
			}
		}

		/** 注册进 conversation.composer.dock 的顶层组件。 */
		const UsageDock = (props) => {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const sessionId = props.sessionId;
			const useSession = props.useSession;
			const running = useSession ? useSession((state) => state.running) : undefined;
			const { data, error, reload } = useSnapshot(sessionId, running);
			const [open, setOpen] = React.useState(false);
			const [tab, setTab] = React.useState("calls");
			const [dense, setDense] = React.useState(0);
			const rootRef = React.useRef(null);
			const barRef = React.useRef(null);
			const probeRef = React.useRef(null);
			const measureRef = React.useRef(() => {});

			// 密度测量：探针量“全量内容”的宽度，与状态条实际可用宽度比。
			// 探针内容不随密度变化 ⇒ 量到的宽度稳定，配合滞回阈值不会来回抖。
			React.useEffect(() => {
				const root = rootRef.current;
				const measure = () => {
					const bar = barRef.current;
					const probe = probeRef.current;
					if (!bar || !probe) return;
					const have = bar.clientWidth;
					if (have <= 0) return;
					const kids = Array.from(probe.children);
					if (kids.length === 0) return;
					let need = 0;
					if (typeof kids[0].getBoundingClientRect === "function") {
						// 探针项不可收缩 ⇒ 每项都是自然宽度，求和即“全量所需宽度”
						for (const kid of kids) need += kid.getBoundingClientRect().width;
						need += 6 * (kids.length - 1); // .up-bar 的 gap
					} else {
						need = probe.scrollWidth;
					}
					setDense((prev) => {
						if (need > have - 4) return Math.min(2, prev + 1);
						if (prev === 2 && need <= have - 80) return 1;
						if (prev === 1 && need <= have - 80) return 0;
						return prev;
					});
				};
				measureRef.current = measure;
				let observer = null;
				if (root !== null && typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(() => measure());
					observer.observe(root);
				}
				const listenable = typeof window !== "undefined" && typeof window.addEventListener === "function";
				if (listenable) window.addEventListener("resize", measure);
				return () => {
					if (observer !== null) observer.disconnect();
					if (listenable) window.removeEventListener("resize", measure);
					measureRef.current = () => {};
				};
			}, []);

			// 每次数据/密度变化后重新量一次（等布局落定）
			React.useEffect(() => {
				const id = setTimeout(() => measureRef.current(), 0);
				return () => clearTimeout(id);
			}, [data, dense, open, sessionId]);

			if (data && data.config && data.config.showDock === false) return null;

			const currency = (data && data.currency) || "CNY";
			const peak = data ? data.peak : null;
			const today = data ? data.today : null;
			const session = data ? data.session : null;
			const balance = data && data.balance && data.balance.status === "ready" ? data.balance : null;
			// 余额 = 充值余额 + 赠送余额（DeepSeek 两种钱包都能抵扣消费；
			// 早先只统计充值钱包，只有赠送额度的账号会显示成 ¥0）。
			const sumWallets = (list) => (list || []).reduce((acc, wallet) => acc + (Number(wallet.balance) || 0), 0);
			const balancePaid = balance ? sumWallets(balance.wallets) : 0;
			const balanceBonus = balance ? sumWallets(balance.bonusWallets) : 0;
			const balanceTotal = balance ? balancePaid + balanceBonus : null;

			const countdown = peak && peak.nextChangeAt ? fmtDuration(peak.nextChangeAt - Date.now()) : "";

			/**
			 * 状态条内容。三个主项（会话 / 今日 / 余额）与峰谷倒计时**任何档位都保留**，
			 * `level` 只压缩次要数字，保证永远一排：
			 *   0 = 全量；1 = 「今日」只留金额；2 = 「会话」也只留金额。
			 */
			const barChildren = (level, interactive) => {
				const nodes = [];
				if (error !== null) {
					nodes.push(
						h(
							"span",
							{ key: "error", className: "up-chip up-warn", title: error },
							t("barUnavailable"),
							interactive
								? h("button", { className: "up-toggle", type: "button", onClick: () => void reload() }, t("barRetry"))
								: h("span", { className: "up-toggle" }, t("barRetry")),
						),
					);
				}
				if (session) {
					const tokens = level < 2 ? " · " + fmtTokens(session.tokens) : "";
					nodes.push(
						h(Chip, {
							key: "session",
							label: t("barSession"),
							value: fmtMoney(session.cost, currency) + tokens,
							title:
								(session.title ? session.title + "\n" : "") +
								fill(t("summaryCalls"), { n: session.calls }) +
								" · " +
								fmtTokens(session.tokens) +
								" " +
								t("barTokens"),
						}),
					);
				}
				if (today) {
					const tokens = level < 1 ? " · " + fmtTokens(today.tokens) : "";
					nodes.push(
						h(Chip, {
							key: "today",
							label: t("barToday"),
							value: fmtMoney(today.cost, currency) + tokens,
							title: t("barToday") + " · " + fill(t("summaryCalls"), { n: today.calls }) + " · " + fmtTokens(today.tokens) + " " + t("barTokens"),
						}),
					);
				}
				nodes.push(h("span", { key: "spacer", className: "up-barSpacer" }));
				if (balanceTotal !== null) {
					nodes.push(
						h(Chip, {
							key: "balance",
							label: t("barBalance"),
							value: fmtMoney(balanceTotal, currency),
							title: fill(t("balanceSplit"), { a: fmtMoney(balancePaid, currency), b: fmtMoney(balanceBonus, currency) }),
						}),
					);
				}
				if (peak) {
					const state = peak.isPeak ? t("barPeak") + fill(t("barPeakSuffix"), { n: peak.multiplier }) : t("barValley");
					// 峰谷倒计时任何档位都完整显示（不随密度压缩）
					const tail = countdown ? " · " + fill(t("barToSwitch"), { t: countdown }) : "";
					nodes.push(
						h(Chip, {
							key: "peak",
							value: state + tail,
							tone: peak.isPeak ? "up-peak" : "up-valley",
							title: state + (countdown ? " · " + fill(t("barToSwitch"), { t: countdown }) : "") + "\n" + t("setWindows") + ": " + JSON.stringify(peak.windows) + " (UTC+" + String(peak.offsetHours) + ")",
						}),
					);
				}
				nodes.push(
					interactive
						? h(
								"button",
								{ key: "toggle", className: "up-toggle", type: "button", "data-open": open, onClick: () => setOpen((value) => !value) },
								open ? t("barClose") : t("barOpen"),
								h("span", { "aria-hidden": true }, open ? "▾" : "▴"),
							)
						: h("span", { key: "toggle", className: "up-toggle" }, t("barOpen"), " ▴"),
				);
				return nodes;
			};

			const tabs = [
				["calls", t("tabCalls")],
				["heatmap", t("tabHeatmap")],
				["balance", t("tabBalance")],
				["settings", t("tabSettings")],
			];

			const body =
				tab === "calls"
					? h(CallsTab, { t: t, sessionId: sessionId })
					: tab === "heatmap"
						? h(HeatmapTab, { t: t, defaultWeeks: (data && data.config && data.config.heatmapWeeks) || 26 })
						: tab === "balance"
							? h(BalanceTab, { t: t, snapshot: data, onRefresh: reload })
							: h(SettingsTab, { t: t, snapshot: data, onSaved: reload });

			return h(
				"div",
				{ className: "up-root", ref: rootRef },
				// 探针跟随当前密度档：量“现在这一档”的真实宽度。
				// 升档阈值为 0 余量，降档要求 ≥80px 余量（> 相邻档位差），所以不会来回抖。
				h("div", { className: "up-bar up-probe", ref: probeRef, "aria-hidden": true }, barChildren(dense, false)),
				h("div", { className: "up-bar up-barLive", ref: barRef }, barChildren(dense, true)),
				open
					? h(
							"div",
							{ className: "up-panel" },
							h(
								"div",
								{ className: "up-head" },
								tabs.map(([id, label]) =>
									h("button", { key: id, className: "up-tab", type: "button", "data-active": tab === id, onClick: () => setTab(id) }, label),
								),
							),
							h("div", { className: "up-body" }, body),
						)
					: null,
			);
		};

		/* ------------------------------------------------------------ *
		 * 插件定义
		 * ------------------------------------------------------------ */

		const inject = ["slots", "locale"];

		function apply(ctx) {
			installStyles();
			ctx.effect(() => () => removeStyles(), "usage-panel: styles");
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						en,
						zh,
					}),
				"usage-panel: dictionaries",
			);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "usage-panel",
						order: 40,
						locale: NS,
						inject: (sessionId) => ({ sessionId }),
					},
					UsageDock,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.UsageDock = UsageDock;
		// 仅给 test/client-smoke.mjs 使用：DSH 的模块加载器只读 apply / inject。
		exports.__internals__ = {
			UsageDock,
			CallsTab,
			HeatmapTab,
			BalanceTab,
			SettingsTab,
			fmtMoney,
			fmtTokens,
			zh,
			en,
		};
		return module.exports;
	},
});
