/**
 * VAC-GC §102 Context History — pure history-ring logic (lib/vacgc/history.js).
 *
 * The host keeps a bounded point ring per session (vacgcRecordPlan →
 * appendVacGcHistory) and the Context tab renders it as a sparkline. These
 * tests cover the shared pure functions: point shape from a REAL plan,
 * injection-token aggregation, same-generatedAt replacement, ring cap, and
 * no-ops on non-plan input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { T0, resetSeqs, userMsg, assistantMsg, toolPair, injectedMsg, makeSession, pricesFor } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";
import { vacGcHistoryPoint, appendVacGcHistory, HISTORY_CAP } from "../../lib/vacgc/history.js";

const H = 3600000;

function runPlan(events, opts) {
	const session = makeSession(events);
	return planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices: pricesFor(session, 500),
		now: opts.now,
		query: opts.query ?? null,
		contextWindow: 8192,
		inputTokens: opts.inputTokens ?? 3000,
		sessionId: opts.sessionId ?? "hist"
	});
}

test("§102: vacGcHistoryPoint extracts the slim sample from a real plan", () => {
	resetSeqs();
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 12; i += 1) events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/h-${i}` }], [`h file ${i}`], { time: T0 + i * H }));
	events.push(userMsg("继续修复压力区间", { time: T0 + 48 * H }));
	for (let i = 0; i < 3; i += 1) events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/f-${i}` }], [`f file ${i}`], { time: T0 + 48 * H + (i + 1) * 60000 }));

	const plan = runPlan(events, { now, inputTokens: 3000, sessionId: "hist-1" });
	const point = vacGcHistoryPoint(plan);
	assert.ok(point, "a plan yields a point");
	assert.equal(point.t, plan.generatedAt, "timestamp = plan.generatedAt");
	assert.equal(point.in, plan.pressure.inputTokens);
	assert.equal(point.win, plan.pressure.contextWindow);
	assert.equal(point.soft, plan.pressure.soft);
	assert.equal(point.hard, plan.pressure.hard);
	assert.equal(point.zone, plan.pressure.zone);
	assert.equal(point.action, plan.decision.action);
	assert.equal(point.reclaim, plan.selected?.reclaimTokens ?? 0);
	assert.equal(point.inj, 0, "no injected units in this session");
	assert.equal(point.degraded, false);
	// JSON-serializable (it crosses the RPC boundary)
	assert.deepEqual(JSON.parse(JSON.stringify(point)), point);
});

test("§102: injected units aggregate into the injection-spike field", () => {
	resetSeqs();
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 8; i += 1) events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/g-${i}` }], [`g file ${i}`], { time: T0 + i * H }));
	events.push(injectedMsg("插件注入的一段上下文。", { time: T0 + 48 * H })); // one injected unit (500 tok)
	events.push(injectedMsg("第二段注入。", { time: T0 + 48 * H + 60000 }));
	events.push(assistantMsg("接下来继续处理 segments 模块。", { time: T0 + 48 * H + 120000 }));

	const plan = runPlan(events, { now, sessionId: "hist-2" });
	const point = vacGcHistoryPoint(plan);
	const injectedUnits = plan.units.filter((u) => u.kind === "injected");
	assert.equal(injectedUnits.length, 2, "two injected units present");
	assert.equal(point.inj, injectedUnits.reduce((sum, u) => sum + u.tokens, 0), "inj = sum of injected unit tokens (spike magnitude)");
	assert.ok(point.inj > 0, "the sparkline will draw an injection marker");
});

test("§102: appendVacGcHistory replaces same-generatedAt points (turn-end bursts)", () => {
	resetSeqs();
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 6; i += 1) events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/b-${i}` }], [`b file ${i}`], { time: T0 + i * H }));

	const points = [];
	const planA = runPlan(events, { now, inputTokens: 3000, sessionId: "hist-3" });
	const planB = runPlan(events, { now, inputTokens: 3500, sessionId: "hist-3" }); // same generatedAt (same now)
	appendVacGcHistory(points, planA);
	appendVacGcHistory(points, planB);
	assert.equal(points.length, 1, "same generatedAt → one sample (replace, not double-count)");
	assert.equal(points[0].in, 3500, "the LATEST plan wins");

	// a later tick appends chronologically
	const planC = runPlan(events, { now: now + H, inputTokens: 4000, sessionId: "hist-3" });
	appendVacGcHistory(points, planC);
	assert.equal(points.length, 2);
	assert.ok(points[0].t < points[1].t, "chronological order");
});

test("§102: ring cap evicts the oldest samples; non-plan input is a no-op", () => {
	const points = [];
	const base = {
		schema: "vacgc-plan-v1",
		generatedAt: 0,
		degraded: false,
		pressure: { inputTokens: 1000, contextWindow: 8192, soft: 0.5, hard: 0.6, zone: "Z1" },
		units: [],
		decision: { action: "none" },
		selected: null
	};
	appendVacGcHistory(points, null);
	appendVacGcHistory(points, undefined);
	appendVacGcHistory(points, "not a plan");
	assert.equal(points.length, 0, "null/undefined/non-object plans are no-ops");

	for (let i = 0; i < HISTORY_CAP + 40; i += 1) {
		appendVacGcHistory(points, { ...base, generatedAt: i * 1000 });
	}
	assert.equal(points.length, HISTORY_CAP, "ring capped at HISTORY_CAP");
	assert.equal(points[0].t, 40 * 1000, "oldest samples evicted first");
	assert.equal(points[points.length - 1].t, (HISTORY_CAP + 39) * 1000, "newest kept");
});
