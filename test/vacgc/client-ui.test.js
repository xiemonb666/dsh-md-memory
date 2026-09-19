/**
 * Hermetic smoke test for the client bundle (lib/client.js) — VAC-GC STEP 7
 * "Context Weight View" (plan §96–§101): module load, slot registration,
 * locale keys, and ContextView rendering over a REAL planVacGc plan (no
 * browser, no host — plain React-element tree inspection).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { userMsg, assistantMsg, toolPair, makeSession, pricesFor, T0 } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// window.__ModuleLoader__ capture (client.js registers itself at load time)
// ---------------------------------------------------------------------------
let moduleDef = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { moduleDef = def; } } };
await import(pathToFileURL(path.join(here, "..", "..", "lib", "client.js")).href);

// ---------------------------------------------------------------------------
// React / jsx-runtime stubs (plain element objects)
// ---------------------------------------------------------------------------
const el = (type, props, ...rest) => ({ type, props: props ?? {}, children: rest.length ? rest : (props?.children ?? []) });

function createHarness() {
	const store = new Map(); // component fn → { states, effects, idx }
	const hookState = () => (store.has(harness.React.__current) ? store.get(harness.React.__current) : store.set(harness.React.__current, { states: [], effects: [], idx: 0 }).get(harness.React.__current));
	const React = {
		__current: null,
		memo: (comp) => comp,
		useState(init) {
			const h = hookState();
			const i = h.idx++;
			if (!(i in h.states)) h.states[i] = typeof init === "function" ? init() : init;
			return [h.states[i], (v) => { h.states[i] = typeof v === "function" ? v(h.states[i]) : v; }];
		},
		useEffect(fn) {
			hookState().effects.push(fn);
		},
		useMemo(fn) {
			return fn();
		}
	};
	const harness = { React, store };
	const jsx = { jsxs: el, jsx: el };
	const requireStub = (name) => {
		if (name === "react") return React;
		if (name === "react/jsx-runtime") return jsx;
		throw new Error(`unexpected require in client bundle: ${name}`);
	};
	return { React, store, requireStub };
}

function renderHarness(harness, Comp, props, { keepTimers = false } = {}) {
	harness.React.__current = Comp;
	const existing = harness.store.get(Comp);
	if (existing) existing.idx = 0; // hook list restarts at each render (React semantics)
	const tree = Comp(props);
	const h = harness.store.get(Comp);
	const pending = h.effects.splice(0, h.effects.length);
	for (const fn of pending) {
		const cleanup = fn();
		if (!keepTimers && typeof cleanup === "function") cleanup();
	}
	return tree;
}

function collectText(node, out = []) {
	if (node === null || node === undefined) return out;
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out; }
	if (typeof node === "object" && typeof node.type === "string") {
		for (const [k, v] of Object.entries(node.props ?? {})) if (typeof v === "string") out.push(v);
		collectText(node.children, out);
	}
	return out;
}

function findNode(node, pred, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) { for (const n of node) findNode(n, pred, out); return out; }
	if (typeof node === "object" && typeof node.type === "string") {
		if (pred(node)) out.push(node);
		findNode(node.children, pred, out);
	}
	return out;
}

function fakeConnection(handlers = {}) {
	const calls = [];
	return {
		calls,
		rpc: {
			call: (channel, endpoint, payload) => {
				calls.push([channel, endpoint, payload]);
				const value = handlers[`${channel}:${endpoint}`] ? handlers[`${channel}:${endpoint}`](payload) : null;
				return Promise.resolve({ ok: true, value });
			}
		}
	};
}

function createContextStub(connection) {
	const registrations = [];
	let localeTables = null;
	const ctx = {
		registrations,
		get localeTables() { return localeTables; },
		connection,
		effect: (fn) => { fn(); },
		locale: {
			register: (ns, tables) => { localeTables = { ns, tables }; },
			bind: () => (key, vars) => {
				const tables = localeTables?.tables ?? {};
				let s = tables.zh?.[key] ?? tables.en?.[key] ?? key;
				if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
				return s;
			}
		},
		slots: {
			inject: (_slot, registerFn) => { registerFn(); },
			register: (def, comp) => {
				registrations.push({ slot: def.name, id: def.id, def, comp });
				return () => {
					const i = registrations.findIndex((r) => r.id === def.id && r.comp === comp);
					if (i >= 0) registrations.splice(i, 1);
				};
			}
		}
	};
	return ctx;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// same formatting as the client bundle
function fmtTokens(n) {
	if (n === null || n === undefined || Number.isNaN(n)) return "-";
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}K`;
}

// substring match over collected text elements
const has = (arr, s) => arr.some((x) => x.includes(s));

// mirrors unitLabel() in lib/client.js
function unitLabel(row) {
	if (row.kind === "tool-pair") return `#${row.firstSeq} ${row.toolName ?? "tool"}`;
	if (row.kind === "checkpoint") return `CP #${row.firstSeq}`;
	if (row.kind === "injected") return `INJ #${row.firstSeq}`;
	return `#${row.firstSeq} ${row.kind}`;
}

// ---------------------------------------------------------------------------
// Real planner plan — stale legacy run (forces a selected segment, like the
// Z2 planner test) + the standard P1-rich recent working set.
// ---------------------------------------------------------------------------
const MIN = 60000;
const now = T0 + 3000 * MIN; // 2 days after the legacy run (recency ≈ 0 there)
const events = [userMsg("早期的探索性工作", { time: T0 })];
// NOTE: toolPair() returns an event ARRAY — spread per pair, do not nest.
for (let i = 0; i < 15; i += 1) {
	events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/legacy-${i}` }], [`listing ${i}\nold file ${i}.txt`], { time: T0 + i }));
}
events.push(
	userMsg("你好", { time: T0 + 2990 * MIN }),
	userMsg("目标：实现 VAC-GC 影子规划器，不能破坏现有压缩行为", { time: T0 + 2990 * MIN }),
	assistantMsg("好的。决定：采用纯函数模块，先做只读影子模式。", { time: T0 + 2991 * MIN }),
	...toolPair("读取配置。", [{ name: "read", arguments: "C:\\Users\\xiemo\\.dsh\\settings.yaml" }], ["enabled: true\ndirName: .dsh-memory"], { time: T0 + 2991 * MIN }),
	...toolPair("", [{ name: "pwsh", arguments: "node --test test/vacgc/ 2>&1 | Select-Object -First 40" }], ["  passing 42\n  failing 0"], { time: T0 + 2992 * MIN }),
	assistantMsg("基准结果：p95 延迟 42ms，吞吐 1200 tokens/s。", { time: T0 + 2992 * MIN }),
	userMsg("继续修复影子规划器的压力区间", { time: T0 + 2993 * MIN }),
	assistantMsg("接下来继续处理 segments 模块。", { time: T0 + 2994 * MIN })
);
const session = makeSession(events);
const prices = pricesFor(session, 500);
const plan = planVacGc({
	nodes: session.nodes,
	eventAt: session.eventAt,
	prices,
	now,
	query: "继续修复影子规划器的压力区间",
	memory: null,
	contextWindow: 8192,
	inputTokens: 3000, // soft ≈ 0.741 → Z2
	sessionId: "test-session"
});

test("client module registers with window.__ModuleLoader__", () => {
	assert.ok(moduleDef, "client.js must call window.__ModuleLoader__.load");
	assert.equal(moduleDef.id, "dsh-md-memory");
	const exports = moduleDef.factory(createHarness().requireStub);
	assert.equal(typeof exports.apply, "function");
	assert.ok(exports.inject.includes("slots") && exports.inject.includes("connection") && exports.inject.includes("locale"));
});

test("apply() registers Memory + Context views, action button, and locale", () => {
	const harness = createHarness();
	const ctx = createContextStub(fakeConnection());
	moduleDef.factory(harness.requireStub).apply(ctx);
	const ids = ctx.registrations.map((r) => `${r.slot}:${r.id}`);
	assert.ok(ids.includes("conversation.view:mdMemory"), "Memory view still registered (regression)");
	assert.ok(ids.includes("conversation.view:mdMemoryCtx"), "Context view registered (STEP 7)");
	assert.ok(ids.includes("conversation.chat.assistant-actions:md-memory"), "composer button registered");
	const tables = ctx.localeTables?.tables;
	assert.ok(tables, "locale registered");
	for (const key of ["ctx.tab", "ctx.title", "ctx.window", "ctx.noPlan", "ctx.f.intrinsic", "ctx.why", "ctx.decision.line", "ctx.executed.title", "ctx.executed.plan", "ctx.executed.official", "ctx.executed.prune", "ctx.executed.note", "ctx.provenance.gap"]) {
		assert.ok(tables.zh[key], `zh key ${key}`);
		assert.ok(tables.en[key], `en key ${key}`);
	}
});

test("ContextView renders the real plan: pressure, tiers, unit table, decision", async () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: {} }),
		"/dsh-md-memory:vacgc/history": () => ({ points: [] }),
		"/dsh-md-memory:vacgc/executed": () => ({ executions: { prune: { count: 2, at: "2026-09-12T07:00:00Z" }, official: { count: 1, at: "2026-09-12T06:30:00Z" } } })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemoryCtx");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };

	// 1st render: empty state → loading hint; effect fires the RPC
	const tree1 = renderHarness(harness, reg.comp, props);
	const text1 = collectText(tree1);
	assert.ok(has(text1, ctx.localeTables.tables.zh["ctx.title"]), "title rendered");
	assert.ok(has(text1, ctx.localeTables.tables.zh["loading"]), "loading hint before RPC");
	assert.deepEqual(connection.calls[0], ["/dsh-md-memory", "vacgc/plan", { sessionId: "test-session" }]);

	await flush(); // RPC promise resolves → state set
	const tree2 = renderHarness(harness, reg.comp, props);
	const text2 = collectText(tree2);
	// §97 pressure
	assert.ok(has(text2, plan.pressure.zone), `zone ${plan.pressure.zone} shown`);
	assert.ok(has(text2, "500"), "token values shown");
	// §98 tiers
	assert.ok(has(text2, "PINNED") && has(text2, "TRASH"), "tier labels shown");
	assert.ok(has(text2, `${plan.tiers.PINNED.count} · ${fmtTokens(plan.tiers.PINNED.tokens)}`), "tier count + tokens shown");
	// §99 unit table rows
	const readRow = plan.units.find((u) => u.kind === "tool-pair" && u.toolName === "read");
	assert.ok(has(text2, `#${readRow.firstSeq} read`), "tool-pair unit label");
	assert.ok(has(text2, readRow.score.toFixed(2)), "score shown");
	const zhTooltips = ctx.localeTables.tables.zh;
	assert.ok(findNode(tree2, (n) => n.type === "span" && n.props?.title === zhTooltips["ctx.unit.tooltip"]).length > 0, "unit header tooltip");
	assert.ok(findNode(tree2, (n) => n.type === "span" && n.props?.title === zhTooltips["ctx.tokens.tooltip"]).length > 0, "tokens header tooltip");
	assert.ok(findNode(tree2, (n) => n.type === "span" && String(n.props?.title ?? "").startsWith(zhTooltips["ctx.tokens.tooltip"])).length > 0, "unit tokens tooltip");
	assert.ok(findNode(tree2, (n) => n.type === "span" && String(n.props?.title ?? "").startsWith(zhTooltips["ctx.tier.tooltip"])).length > 0, "unit tier tooltip");
	assert.ok(findNode(tree2, (n) => n.type === "span" && String(n.props?.title ?? "").startsWith(zhTooltips["ctx.score.tooltip"])).length > 0, "unit score tooltip");
	assert.ok(findNode(tree2, (n) => n.type === "span" && String(n.props?.title ?? "").startsWith(zhTooltips["ctx.reason.tooltip"])).length > 0, "unit reason tooltip");
	// §99/§101 selection — Z2 → compact of the stale run
	assert.equal(plan.pressure.zone, "Z2");
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	assert.ok(plan.selected, "stale run must produce a selected segment");
	// stale run = 早期的 user + 15 legacy pairs + adjacent 你好 user (the P0 goal
	// message breaks the candidate run); the last 4 units are floor-protected.
	assert.equal(plan.selected.unitIds.length, 17);
	assert.equal(plan.selected.reclaimTokens, 500 + 15 * 1000 + 500);
	assert.ok(plan.units.slice(-4).every((u) => u.inRecentFloor === true), "recent working set is floor-protected");
	assert.ok(plan.tiers.TRASH.count > 0, "legacy pairs land in TRASH");
	// decision line
	assert.ok(has(text2, `决策 ${plan.decision.action}`), "decision action interpolated");
	assert.ok(has(text2, `可回收 ${fmtTokens(plan.selected.reclaimTokens)}`), "selected segment reclaim shown");
	// PLAN vs EXECUTED (review 2026-09-12 P0): the plan is advisory — the
	// executed block shows what actually ran (official compactions + landed prunes)
	assert.ok(has(text2, "计划 vs 执行"), "PLAN vs EXECUTED box rendered");
	assert.ok(has(text2, "已执行 · VAC-GC 剪枝（TRASH 微剪）：2 项"), "executed prune count shown");
	assert.ok(has(text2, "已执行 · 官方压缩（前缀摘要）：1 次"), "executed official count shown");
	// §103 metrics lines (planned outcome + gate census + protection census)
	const m = plan.metrics;
	assert.ok(m, "plan carries a metrics block");
	assert.ok(has(text2, `Before ${fmtTokens(m.tokensBefore)}`), "metrics Before tokens");
	assert.ok(has(text2, `候选 ${m.candidateCount}`), "metrics candidate count");
	assert.ok(has(text2, `P0 ${m.P0Count} / P1 ${m.P1Count}`), "metrics protection census");

	// §100 click a P1 row → score breakdown
	const p1Row = plan.units.find((u) => u.protection === "P1");
	assert.ok(p1Row, "scenario has a P1 unit");
	const rowEl = findNode(tree2, (n) => n.props?.key === p1Row.unitId && typeof n.props.onClick === "function")[0];
	assert.ok(rowEl, "unit row element found");
	rowEl.props.onClick();
	const tree3 = renderHarness(harness, reg.comp, props);
	const text3 = collectText(tree3);
	const zh = ctx.localeTables.tables.zh;
	assert.ok(has(text3, `${zh["ctx.why"].split(" {")[0]} ${unitLabel(p1Row)}`), "breakdown header with unit label");
	assert.ok(has(text3, zh["ctx.f.intrinsic"]) && has(text3, zh["ctx.f.reconstruct"]) && has(text3, zh["ctx.final"]), "breakdown lanes");
	assert.ok(has(text3, p1Row.score.toFixed(2)), "final score value");
	assert.ok(has(text3, zh["ctx.decision"]), "decision label");
});

test("§102 ContextView renders the Context History sparkline with markers", async () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: { ui: { enabled: true, showPerRequest: false } } }),
		"/dsh-md-memory:vacgc/history": () => ({
			points: [
				{ t: T0, in: 3000, win: 8192, soft: 0.66, hard: 0.75, zone: "Z2", action: "compact", reclaim: 15500, inj: 0, degraded: false },
				{ t: T0 + 60000, in: 4200, win: 8192, soft: 0.79, hard: 0.88, zone: "Z3", action: "none", reclaim: 0, inj: 3000, degraded: false },
				{ t: T0 + 120000, in: 2000, win: 8192, soft: 0.55, hard: 0.62, zone: "Z1", action: "fresh-prune", reclaim: 1500, inj: 0, degraded: true }
			],
			cap: 240
		})
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemoryCtx");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };
	renderHarness(harness, reg.comp, props);
	assert.deepEqual(
		connection.calls.map((c) => c[1]),
		["vacgc/plan", "vacgc/history", "vacgc/executed", "memory/provenance", "settings/get", "settings/status"],
		"load() fetches plan + history + executed + provenance gap + budget settings in one pass"
	);
	await flush();
	const tree = renderHarness(harness, reg.comp, props);
	const zh = ctx.localeTables.tables.zh;
	const text = collectText(tree);
	// history box + sparkline
	assert.ok(has(text, zh["ctx.hist"]), "§102 history section header");
	const svg = findNode(tree, (n) => n.type === "svg")[0];
	assert.ok(svg, "sparkline SVG rendered");
	const polyline = findNode(tree, (n) => n.type === "polyline")[0];
	assert.ok(polyline, "token polyline present");
	assert.equal(String(polyline.props.points).split(" ").length, 3, "one vertex per history point");
	// markers: compact(1) + injection(1) + fresh-prune(1) + degraded(1)
	const circles = findNode(tree, (n) => n.type === "circle");
	assert.equal(circles.length, 4, "four markers across the three samples");
	// legend counts
	assert.ok(has(text, zh["ctx.hist.legend"].split("{")[0]), "legend label shown");
	assert.ok(has(text, "紧凑(计划) 1 · 修剪(计划) 1 · 注入 1 · 降级 1"), "legend counts interpolated");
});

test("§102 empty history shows the collecting hint; ui.enabled=false disables the view", async () => {
	// empty history ring (fresh session, single plan not yet recorded as a
	// history point — host records the plan AFTER the RPC pair resolves)
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: {} }),
		"/dsh-md-memory:vacgc/history": () => ({ points: [] })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemoryCtx");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };
	renderHarness(harness, reg.comp, props);
	await flush();
	const zh = ctx.localeTables.tables.zh;
	const text = collectText(renderHarness(harness, reg.comp, props));
	assert.ok(has(text, zh["ctx.hist.empty"]), "empty history hint (no sparkline yet)");
	const emptyTree = renderHarness(harness, reg.comp, props);
	assert.equal(findNode(emptyTree, (n) => n.type === "svg").length, 0, "no sparkline with < 2 points");

	// ui.enabled=false → the whole VAC-GC surface is replaced by one line
	const harness2 = createHarness();
	const connection2 = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: { ui: { enabled: false } } }),
		"/dsh-md-memory:vacgc/history": () => ({ points: [] })
	});
	const ctx2 = createContextStub(connection2);
	moduleDef.factory(harness2.requireStub).apply(ctx2);
	const reg2 = ctx2.registrations.find((r) => r.id === "mdMemoryCtx");
	const props2 = { sessionId: "test-session", connection: connection2, t: makeT(ctx2) };
	renderHarness(harness2, reg2.comp, props2);
	await flush();
	const tree2 = renderHarness(harness2, reg2.comp, props2);
	const text2 = collectText(tree2);
	assert.ok(has(text2, "VAC-GC UI 已禁用"), "disabled notice shown");
	assert.ok(!has(text2, "PINNED"), "tier distribution skipped");
	assert.ok(!has(text2, "决策 compact"), "decision line skipped");
	assert.ok(findNode(tree2, (n) => n.type === "svg").length === 0, "no sparkline when disabled");
});

test("P0.5 provenance gap: unresolved ACTIVE entries render the conservative-hold notice", async () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: {} }),
		"/dsh-md-memory:vacgc/history": () => ({ points: [] }),
		"/dsh-md-memory:vacgc/executed": () => ({ executions: { prune: { count: 0, at: null }, official: { count: 0, at: null } } }),
		"/dsh-md-memory:memory/provenance": () => ({ unresolvedActive: ["DEC-021", "TECH-014"], reasons: { "DEC-021": "ambiguous", "TECH-014": "quote-mismatch" } })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemoryCtx");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };
	renderHarness(harness, reg.comp, props);
	await flush();
	const zh = ctx.localeTables.tables.zh;
	const text = collectText(renderHarness(harness, reg.comp, props));
	// the interpolated gap line (count + first ids)
	assert.ok(has(text, "证据缺口：2 条 ACTIVE 条目暂无已解析的原始证据绑定（DEC-021, TECH-014）"), "provenance gap line rendered with ids");
	assert.ok(has(text, "P1 保守保护"), "the conservative-hold semantics are stated");
	// no gap data → no notice (the nice-to-have failure path)
	const harness2 = createHarness();
	const connection2 = fakeConnection({
		"/dsh-md-memory:vacgc/plan": () => ({ mode: "shadow", plan, config: {} }),
		"/dsh-md-memory:vacgc/history": () => ({ points: [] }),
		"/dsh-md-memory:memory/provenance": () => ({ unresolvedActive: [], reasons: {} })
	});
	const ctx2 = createContextStub(connection2);
	moduleDef.factory(harness2.requireStub).apply(ctx2);
	const reg2 = ctx2.registrations.find((r) => r.id === "mdMemoryCtx");
	const props2 = { sessionId: "test-session", connection: connection2, t: makeT(ctx2) };
	renderHarness(harness2, reg2.comp, props2);
	await flush();
	const text2 = collectText(renderHarness(harness2, reg2.comp, props2));
	assert.ok(!has(text2, "证据缺口"), "no notice when every entry is resolved");
});

test("MemoryView still renders (regression)", async () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:status": () => ({ exists: true, ledgerDir: ".dsh-memory", files: [{ name: "INDEX.md", size: 10 }], state: { lastSyncMs: now } })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemory");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };
	const tree1 = renderHarness(harness, reg.comp, props);
	assert.ok(has(collectText(tree1), "加载中…"), "loading hint before status RPC");
	await flush();
	const text2 = collectText(renderHarness(harness, reg.comp, props));
	assert.ok(has(text2, "Markdown Memory Ledger"), "Memory header after status RPC");
	assert.ok(has(text2, "已初始化"), "status badge after RPC");
	const indexTip = "INDEX：项目记忆路由索引，说明每份记忆文件的用途、条目数量和读取入口。";
	assert.ok(findNode(renderHarness(harness, reg.comp, props), (n) => n.type === "div" && n.props?.title === indexTip).length > 0, "INDEX file tooltip");
});

test("MemoryView displays search hits from the engine's { results } response", async () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:status": () => ({ exists: true, ledgerDir: ".dsh-memory", files: [], state: {} }),
		"/dsh-md-memory:search": () => ({ results: [{ file: "PROJECT.md", line: 8, text: "MML-LIVE-001" }] })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemory");
	const props = { sessionId: "test-session", connection, t: makeT(ctx) };
	const first = renderHarness(harness, reg.comp, props);
	const input = findNode(first, (n) => n.type === "input" && n.props.placeholder === "搜索台账…")[0];
	input.props.onChange({ target: { value: "MML-LIVE-001" } });
	renderHarness(harness, reg.comp, props, { keepTimers: true });
	await new Promise((resolve) => setTimeout(resolve, 350));
	await flush();
	const rendered = collectText(renderHarness(harness, reg.comp, props));
	assert.ok(has(rendered, "PROJECT.md:8"));
	assert.ok(has(rendered, "MML-LIVE-001"));
	const projectTip = "PROJECT：项目目标、需求和范围，说明这项工作要完成什么。";
	assert.ok(findNode(renderHarness(harness, reg.comp, props), (n) => n.type === "div" && n.props?.title === projectTip).length > 0, "PROJECT search tooltip");
});

test("MemoryView resolves the active session before requesting its ledger", () => {
	const harness = createHarness();
	const connection = fakeConnection({
		"/dsh-md-memory:status": () => ({ exists: false, files: [], state: {} })
	});
	const ctx = createContextStub(connection);
	moduleDef.factory(harness.requireStub).apply(ctx);
	const reg = ctx.registrations.find((r) => r.id === "mdMemory");
	const sessions = { list: { getSnapshot: () => ({ current: "active-session" }), subscribe: () => () => {} } };
	renderHarness(harness, reg.comp, { sessionId: "stale-session", sessions, connection, t: makeT(ctx) });
	assert.deepEqual(connection.calls[0], ["/dsh-md-memory", "status", { sessionId: "active-session" }]);
});

// t() bound to the ctx locale (the bind closure resolves tables lazily,
// so binding after apply() sees the registered zh/en tables)
function makeT(ctx) {
	return ctx.locale.bind("mdMemory");
}
