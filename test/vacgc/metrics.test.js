/**
 * VAC-GC Metrics tests (plan §103, §117 Phase 1 "Metrics").
 *
 * Verifies computeVacGcMetrics() — the pure, O(units), no-LLM derivation of
 * every §103 observability number from a planVacGc() result — against real
 * plans: a Z2 stale-run scenario (selected segment), the standard scenario
 * (no action), a degraded plan, and the empty-input edge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { userMsg, assistantMsg, toolPair, makeSession, pricesFor, standardScenario, deepFreeze, T0 } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";
import { computeVacGcMetrics } from "../../lib/vacgc/metrics.js";

const MIN = 60000;

// ---------------------------------------------------------------------------
// Scenario A: stale run (2 days old) + recent P1-rich working set — Z2,
// selected segment (17 candidate units, 16500 tokens).
// ---------------------------------------------------------------------------
function staleRunScenario() {
	const now = T0 + 3000 * MIN;
	const events = [userMsg("早期的探索性工作", { time: T0 })];
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
		inputTokens: 3000,
		sessionId: "metrics-stale"
	});
	return { plan, now };
}

test("§103 metrics: Z2 stale-run plan — gate census, score stats, planned token flow", () => {
	const { plan } = staleRunScenario();
	assert.equal(plan.degraded, false);
	assert.equal(plan.pressure.zone, "Z2");
	assert.ok(plan.metrics, "plan carries a metrics block");
	const m = plan.metrics;

	// unit census: 早期的 + 15 legacy pairs + 你好 + goal + decision + read pair
	// + test pair + benchmark + goal-restatement + tail assistant = 24 units
	assert.equal(m.unitCount, 24);
	assert.equal(m.P0Count, 2, "goal + goal-restatement are P0");
	assert.equal(m.P1Count, 3, "decision / config pair / benchmark are P1");

	// gate buckets — each unit counted exactly once, in hard-gate priority
	// (floor is checked before tier: the floor-protected P1 benchmark counts
	// as floor-rejected, matching isEligible's gate order)
	assert.equal(m.candidateCount, 17, "stale user + 15 legacy pairs + greeting");
	assert.equal(m.rejectedByP0, 2);
	assert.equal(m.rejectedByRecentFloor, 3, "test pair + tail assistant + floor-protected P1 benchmark");
	assert.equal(m.rejectedByBalance, 0, "shadow planner runs no balance checker");
	assert.equal(m.rejectedByTier, 2, "WARM units are zone-ineligible in Z2");
	assert.equal(m.candidateCount + m.rejectedByP0 + m.rejectedByRecentFloor + m.rejectedByBalance + m.rejectedByTier, m.unitCount, "bucket invariant");

	// score distribution — recompute from the plan's own units
	const scores = plan.units.map((u) => u.score);
	assert.equal(m.minScore, Math.min(...scores));
	assert.equal(m.maxScore, Math.max(...scores));
	// averageScore is rounded to 4dp (round4) — tolerance is half a 4dp ulp
	const exactAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
	assert.ok(Math.abs(m.averageScore - exactAvg) < 5.1e-5, `avg ${m.averageScore} vs ${exactAvg}`);

	// token flow — planned outcome (shadow: surface untouched)
	assert.equal(m.tokensBefore, plan.units.reduce((a, u) => a + u.tokens, 0), 20500);
	assert.equal(m.reclaim, plan.selected.reclaimTokens, 500 + 15 * 1000 + 500); // 16000
	assert.equal(m.tokensAfter, m.tokensBefore - m.reclaim);
	assert.equal(m.summaryTokens, 0, "Phase 1: no LLM summary");
	assert.equal(m.exactFacts, null, "shadow: verification metrics unfilled");
	assert.equal(m.coverage, null, "shadow: verification metrics unfilled");

	// pressure: before mirrors the plan, after reflects the planned reclaim
	assert.equal(m.pressureBefore.soft, plan.pressure.soft);
	assert.equal(m.pressureBefore.zone, plan.pressure.zone);
	assert.ok(m.pressureAfter, "planned pressureAfter exists");
	assert.equal(m.pressureAfter.inputTokens, Math.max(0, plan.pressure.inputTokens - m.reclaim));
	assert.ok(m.pressureAfter.soft < m.pressureBefore.soft, "planned compaction lowers soft pressure");
});

test("§103 metrics: no-action standard scenario — zero reclaim, pressure unchanged", () => {
	const { session, prices, now } = standardScenario();
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices,
		now,
		query: "继续修复影子规划器的压力区间",
		memory: null,
		contextWindow: 8192,
		inputTokens: 3000,
		sessionId: "metrics-standard"
	});
	assert.equal(plan.selected, null);
	const m = plan.metrics;
	assert.equal(m.unitCount, 8);
	assert.equal(m.reclaim, 0);
	assert.equal(m.tokensAfter, m.tokensBefore);
	// exact census of the 8-unit standard scenario (Z2): only the greeting is
	// a candidate (the pwsh test pair is TRASH but floor-protected)
	assert.equal(m.candidateCount, 1, "greeting only");
	assert.equal(m.rejectedByP0, 2);
	assert.equal(m.rejectedByRecentFloor, 3, "test pair + benchmark (P1, floor) + tail assistant");
	assert.equal(m.rejectedByTier, 2, "two non-floor WARM units");
	assert.equal(m.P0Count, 2);
	assert.equal(m.P1Count, 3);
	assert.equal(m.candidateCount + m.rejectedByP0 + m.rejectedByRecentFloor + m.rejectedByBalance + m.rejectedByTier, 8);
	// no reclaim → planned pressure identical to current
	assert.equal(m.pressureAfter.soft, m.pressureBefore.soft);
	assert.equal(m.pressureAfter.zone, m.pressureBefore.zone);
});

test("§103 metrics: degraded plan carries zero metrics without throwing", () => {
	const { session, prices } = standardScenario();
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: () => { throw new Error("surface unavailable"); },
		prices,
		now: Date.now(),
		memory: null,
		contextWindow: 8192,
		inputTokens: 3000
	});
	assert.equal(plan.degraded, true);
	assert.ok(plan.metrics, "degraded plan still carries metrics");
	const m = plan.metrics;
	assert.equal(m.unitCount, 0);
	assert.equal(m.tokensBefore, 0);
	assert.equal(m.reclaim, 0);
	assert.equal(m.candidateCount, 0);
	assert.equal(m.averageScore, 0);
	assert.equal(m.pressureBefore, null);
	assert.equal(m.pressureAfter, null);
});

test("§103 metrics: computeVacGcMetrics is pure over a frozen plan", () => {
	const { plan } = staleRunScenario();
	const frozen = deepFreeze(structuredClone(plan));
	const m = computeVacGcMetrics(frozen); // read-only — must not throw
	assert.equal(m.unitCount, 24);
	assert.equal(m.candidateCount, 17);
});

test("§103 metrics: empty input edge — all zeros, no throw", () => {
	const m = computeVacGcMetrics({});
	assert.equal(m.unitCount, 0);
	assert.equal(m.tokensBefore, 0);
	assert.equal(m.tokensAfter, 0);
	assert.equal(m.reclaim, 0);
	assert.equal(m.averageScore, 0);
	assert.equal(m.pressureBefore, null);
	assert.equal(m.pressureAfter, null);
});
