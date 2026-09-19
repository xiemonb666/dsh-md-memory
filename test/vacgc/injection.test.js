/**
 * §73/§74 — Lazy Injection coupling and injected units as first-class citizens.
 *
 * §73: "压缩得再好，如果『你好 → Inject 30K』系统仍然失败" — the token
 * budget MUST contain injected context. Phase-1 observables: the injected
 * unit is a priced plan row, soft pressure moves with it, and the history
 * point carries the spike magnitude.
 *
 * §74: injection is an independent unit kind. "如果当前 request 不需要 →
 * TRASH / do not inject" — a plugin calling its context "important" must not
 * automatically keep it in the main context (no protection class from the
 * source marker). Conversely, an injection the active request DOES need gets
 * the relevance lift like any other unit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { userMsg, assistantMsg, injectedMsg, makeSession, pricesFor, T0 } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";
import { vacGcHistoryPoint } from "../../lib/vacgc/history.js";

const H = 3600000;
const MIN = 60000;

function run(events, { now, query = null, inputTokens, prices, contextWindow = 8192, sessionId = "inj", config }) {
	const session = makeSession(events);
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices: prices ?? pricesFor(session, 500),
		now,
		query,
		memory: null,
		contextWindow,
		inputTokens,
		sessionId,
		config
	});
	return { plan, session };
}

test("§73: injected context sits INSIDE the token budget ('你好 → Inject 30K')", () => {
	const now = T0 + 48 * H;
	const W = 192000; // the real deployment window
	const big = "plugin context ".repeat(200);
	const withInj = [
		userMsg("你好", { time: T0 + 47 * H }),
		injectedMsg(big, { time: T0 + 47 * H + 120000 }), // the 30K arrives in the same turn
		userMsg("现在帮我查一下压力区间", { time: T0 + 48 * H })
	];
	const session = makeSession(withInj);
	const injSeq = withInj[1].seq;
	const prices = session.nodes.map((seq) => ({ seq, tokens: seq === injSeq ? 30000 : 500 }));
	const inputTokens = prices.reduce((s, p) => s + p.tokens, 0); // 31000
	const { plan } = run(withInj, { now, query: "现在帮我查一下压力区间", inputTokens, prices, contextWindow: W, sessionId: "inj-73" });

	// 1) the injected unit is a first-class, PRICED plan row
	const row = plan.units.find((u) => u.kind === "injected");
	assert.ok(row, "the injected unit is a plan row (kind 'injected')");
	assert.equal(row.tokens, 30000, "the planner prices it into the budget");

	// 2) the soft-pressure formula contains it — recomputed from the plan's
	//    own reported overhead fields (no assumption about fallbacks)
	const expected = (inputTokens + plan.pressure.expectedOutput + plan.pressure.injectionReserve) / W;
	assert.ok(Math.abs(plan.pressure.soft - expected) < 1e-3, `soft ${plan.pressure.soft} ≈ (input+expectedOutput+reserve)/W ${expected}`);

	// 3) same session WITHOUT the injection → strictly lower soft
	const control = [
		userMsg("你好", { time: T0 + 47 * H }),
		userMsg("现在帮我查一下压力区间", { time: T0 + 48 * H })
	];
	const { plan: controlPlan } = run(control, { now, query: "现在帮我查一下压力区间", inputTokens: 1000, contextWindow: W, sessionId: "inj-73-control" });
	assert.ok(plan.pressure.soft > controlPlan.pressure.soft, "the 30K injection moves soft pressure");
	assert.ok(plan.pressure.soft - controlPlan.pressure.soft > 0.1, "the spike is material, not rounding");

	// 4) the history point carries the spike (the sparkline's inj marker)
	assert.equal(vacGcHistoryPoint(plan).inj, 30000, "sparkline injection spike = injected unit tokens");
});

test("§74: an injected unit the request does not need decays to TRASH — plugin claims are not protection", () => {
	const now = T0 + 48 * H;
	const events = [
		injectedMsg("旧插件注入的无关上下文：某天气 API 的文档摘要与示例。", { time: T0 + 24 * H }),
		userMsg("当前问题：影子规划器的压力区间映射为什么不对。", { time: T0 + 47 * H }),
		assistantMsg("需要检查 Z0 到 Z5 的阈值映射。", { time: T0 + 48 * H })
	];
	// 3 × 500-token units < the default 2048 floor → the whole session would be
	// floor-protected; shrink the floor so it covers exactly the last unit and
	// the stale injection is judgeable (fixture isolation, not a semantics change).
	const { plan } = run(events, {
		now,
		query: "当前问题：影子规划器的压力区间映射为什么不对。",
		inputTokens: 1500,
		sessionId: "inj-74-no",
		config: { recent: { ratio: 0.06, minTokens: 500, maxTokens: 12288 } }
	});
	const inj = plan.units.find((u) => u.kind === "injected");
	assert.ok(inj, "injected unit present");
	assert.equal(inj.protection, "NORMAL", "a plugin 'important' claim is NOT a protection class");
	assert.equal(inj.features.taskRelevance, 0, "zero lexical overlap with the active query");
	assert.equal(inj.tier, "TRASH", "unneeded + 24h stale → TRASH / do not inject");
	assert.ok(!inj.inRecentFloor, "and it is outside the working-set floor");
});

test("§74: an injected unit the request DOES need is kept — relevance, not plugin claims, earns the place", () => {
	const now = T0 + 48 * H;
	// The §73/§74 same-turn case: the query asks about the pressure-zone mapping,
	// and the plugin injects exactly the reference the request needs (shared
	// symbol softGc + shared segmented CJK words).
	const query = "当前问题：影子规划器的压力区间映射为什么不对，请核对 softGc 阈值。";
	const events = [
		userMsg("你好", { time: T0 + 47 * H }),
		userMsg(query, { time: T0 + 48 * H }),
		injectedMsg("参考注入：影子规划器的压力区间映射定义，softGc=0.55，coldCompact=0.68。", { time: T0 + 48 * H + 60000 }),
		assistantMsg("需要检查 Z0 到 Z5 的阈值映射。", { time: T0 + 48 * H + 120000 })
	];
	const { plan } = run(events, { now, query, inputTokens: 2000, sessionId: "inj-74-yes" });
	const inj = plan.units.find((u) => u.kind === "injected");
	assert.ok(inj, "injected unit present");
	assert.ok(inj.features.taskRelevance > 0, "the query re-hits the injection's terms (symbol + CJK keyword lanes)");
	assert.equal(inj.tier, "COLD", "needed + fresh → kept in context (above TRASH, below WARM)");
	assert.equal(inj.protection, "NORMAL", "it is kept by RELEVANCE, not by a protection class");
});
