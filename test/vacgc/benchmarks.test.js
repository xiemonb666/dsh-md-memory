/**
 * VAC-GC Benchmarks A–G (plan §104–§112) — Phase 1 (shadow) versions.
 *
 * §104: the most important quality metric is Information Retention, not
 * compression ratio. These tests measure retention/reclaim through the
 * SHADOW planner (planVacGc) — no surface is mutated, so every "survival"
 * assertion means "the planner would never select this unit", and every
 * "reclaim" assertion is about the PLANNED segment (metrics.reclaim).
 *
 * Interpretation notes (documented per plan section):
 *  - §105/106: facts must survive at the NORMAL zones (Z2). P1 compaction in
 *    Z4/Z5 (with Memory Sync + exact coverage) is a Phase 5 concern, so the
 *    100%-recall gate is asserted for Z2 where P1 is zone-ineligible.
 *  - §107: "reclaim ≥ 70%" is measured as the share of surface tokens the
 *    planner classifies as zone-eligible candidates (single plans are capped
 *    by maxReclaimTokens); the critical-error unit must stay out of the plan.
 *  - §110: the Phase-1 observable of "COLD → grep → promoted" is the scorer's
 *    relevance lane: a query re-hit must lift the unit OUT of TRASH (out of
 *    the Z1 fresh-prune set). Under current weights an old, high-X unit
 *    caps at COLD (0.55·rel < warmEnter); full WARM promotion +
 *    retrieve-then-answer is Phase 3.
 *  - §111: supersession DETECTION ("current = C") is Phase 3 (Memory Sync);
 *    the Phase-1 sentinel is that the whole A→B→C chain stays intact (no
 *    partial compaction of the chain).
 *  - §112: "injection = 0" is asserted as "a trivial query promotes nothing
 *    and leaves every non-greeting unit's score/tier unchanged".
 *
 * Fixture scale: 500 tokens/node (pairs = 1000). "8K repeated build log"
 * = 8 pairs, "2K important" = decision + verified pair (1500 tokens),
 * "100K tool logs" = 100 pairs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { userMsg, assistantMsg, toolPair, makeSession, pricesFor, T0 } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";

const H = 3600000;
const MIN = 60000;
const W = 8192; // test window: minReclaim 2048, recent floor 2048
const NOISE = "C:\\Users\\xiemo\\md-memory\\test\\vacgc\\noise.txt";

/** Old low-value noise pair (NORMAL tool-log). */
function noisePair(i, time) {
	return toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/noise-${i}` }], [`noise file ${i}.txt`], { time });
}

/** Recent plain pair used to fill the recent floor. */
function freshPair(i, time) {
	return toolPair("", [{ name: "pwsh", arguments: `echo ok ${i}` }], [`ok ${i}`], { time });
}

function runPlan(events, { now, query = null, inputTokens = 3000, sessionId = "bench" }) {
	const session = makeSession(events);
	return planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices: pricesFor(session, 500),
		now,
		query,
		memory: null,
		contextWindow: W,
		inputTokens,
		sessionId
	});
}

// ---------------------------------------------------------------------------
// Benchmark A — Critical Fact Survival (§105/§106): 175 planted facts
// (25 requirements + 25 decisions + 25 rejections + 25 paths + 25 numbers +
// 25 benchmarks + 25 tasks) must survive compaction: 100% at the normal
// zone (Z2), where neither P0 nor P1 units are selectable.
// ---------------------------------------------------------------------------
test("Benchmark A (§105/106): 175 critical facts survive — P0 100%, P1 100% at Z2", () => {
	const now = T0 + 48 * H;
	const events = [];
	// 25 legacy noise pairs — one contiguous old block (the only eligible run)
	for (let i = 0; i < 25; i += 1) events.push(...noisePair(i, T0 + i * H));
	// 175 facts, planted old (T0+26h .. T0+45h)
	for (let i = 1; i <= 25; i += 1) {
		const n = String(i).padStart(3, "0");
		events.push(userMsg(`需求：REQ-${n} 必须支持特性 ${n}。`, { time: T0 + 26 * H + i * 10 * MIN }));
		events.push(assistantMsg(`决定 DEC-${n}：采用新架构方案 ${n}。`, { time: T0 + 27 * H + i * 10 * MIN }));
		events.push(userMsg(`不要采用旧方案 ${n}，该方案被否决。`, { time: T0 + 28 * H + i * 10 * MIN }));
		events.push(...toolPair(`读取配置 ${n}。`, [{ name: "read", arguments: `C:\\bench\\cfg${n}\\app.yaml` }], [`cfg${n}: value-${n}`], { time: T0 + 30 * H + i * 10 * MIN }));
		events.push(assistantMsg(`基准结果：p95 延迟 ${i * 4}ms，吞吐 ${1000 + i} tokens/s。`, { time: T0 + 33 * H + i * 10 * MIN }));
		events.push(assistantMsg(`已验证 benchmark ${n}：全部通过，exit code: 0。`, { time: T0 + 36 * H + i * 10 * MIN }));
		events.push(userMsg(`任务：继续执行模块 ${n} 的压测。`, { time: T0 + 40 * H + i * 10 * MIN }));
	}
	for (let i = 0; i < 4; i += 1) events.push(...freshPair(i, T0 + 47 * H + i * MIN));

	const plan = runPlan(events, { now, sessionId: "bench-A" });
	assert.equal(plan.pressure.zone, "Z2");

	// census: 25 req + 25 rejection + 25 task = 75 P0; 25 decision + 25 path + 25 number + 25 bench = 100 P1
	assert.equal(plan.metrics.P0Count, 75, "75 P0 facts (reqs + rejections + tasks)");
	assert.equal(plan.metrics.P1Count, 100, "100 P1 facts (decisions + paths + numbers + benchmarks)");

	// the plan DOES compact — and only the noise block
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	assert.ok(plan.selected, "noise block is the eligible run");
	assert.ok(plan.selected.reclaimTokens >= 25 * 1000, "reclaims the noise block");

	// §106: 100% of every fact category stays out of the selected segment.
	// Plan rows carry no unit text (by design — slim rows), so the facts are
	// identified positionally: 25 noise units, then 175 fact units (7 per i,
	// in planted order), then 4 fresh units.
	assert.equal(plan.units.length, 25 + 175 + 4, "unit census");
	const factUnits = plan.units.slice(25, 25 + 175);
	const noiseUnits = plan.units.slice(0, 25);
	const selected = new Set(plan.selected.unitIds);
	const lost = factUnits.filter((u) => selected.has(u.unitId));
	assert.equal(lost.length, 0, `no fact selected — lost: ${lost.map((u) => u.unitId).join(", ")}`);
	// and every fact is protected, none is a candidate
	assert.ok(factUnits.every((u) => u.protection === "P0" || u.protection === "P1"), "every fact is P0/P1");
	// 25 noise + the OLDEST fresh pair (the 2048-token floor covers only the
	// 3 newest fresh pairs) — all of them TRASH, none of them a fact
	assert.equal(plan.metrics.candidateCount, 26, "25 noise pairs + 1 fresh pair outside the floor");
	assert.ok(noiseUnits.every((u) => u.tier === "TRASH"), "noise block is TRASH (old, low value)");
	assert.ok(plan.selected.unitIds.every((id) => !factUnits.some((u) => u.unitId === id)), "selected segment contains no fact");
});

// ---------------------------------------------------------------------------
// Benchmark B — Low-value Reclaim (§107): 100K tool logs, 90%+ reconstructible.
// Phase-1 reading: the planner must classify ≥70% of the surface as
// zone-eligible reclaim candidates while the critical error (P1) stays out.
// ---------------------------------------------------------------------------
test("Benchmark B (§107): ≥70% of 100K tool logs classified reclaimable, critical error 100% kept", () => {
	const now = T0 + 120 * H;
	const events = [];
	// 100 tool-log pairs (100K tokens): 45 + 54 old noise pairs split by an old
	// P0 goal statement (PINNED — breaks the eligible run so each side stays
	// under the maxReclaimTokens cap, like real sessions interleave facts)
	for (let i = 0; i < 45; i += 1) events.push(...noisePair(i, T0 + (i + 1) * H));
	events.push(assistantMsg("目标：完成 bulk 日志系统的重构。", { time: T0 + 46 * H }));
	for (let i = 0; i < 54; i += 1) events.push(...noisePair(100 + i, T0 + (47 + i) * H));
	// the one critical error — recent, root-cause → P1
	events.push(...toolPair("部署。", [{ name: "pwsh", arguments: "bash deploy.sh" }], ["deploy failed: 根因是 config.yaml 缺少 timeout 字段，exit code: 1"], { time: T0 + 119 * H }));

	const plan = runPlan(events, { now, inputTokens: 7200, sessionId: "bench-B" }); // Z5
	assert.equal(plan.pressure.zone, "Z5");

	const m = plan.metrics;
	assert.equal(m.P0Count, 1, "the goal statement is P0");
	assert.equal(m.P1Count, 1, "exactly one P1 unit — the critical error");
	const critical = plan.units.find((u) => u.protection === "P1");
	assert.ok(critical && critical.inRecentFloor, "critical error is the floor-protected P1");

	// ≥70% of the surface tokens are zone-eligible candidates
	const candidateTokens = plan.units.filter((u) => !u.inRecentFloor && u.protection !== "P0" && u.protection !== "P0_TRANSIENT" && ["TRASH", "COLD", "WARM", "HOT"].includes(u.tier)).reduce((a, u) => a + u.tokens, 0);
	const total = plan.units.reduce((a, u) => a + u.tokens, 0);
	assert.ok(total >= 100000, `100K fixture (${total})`);
	assert.ok(candidateTokens / total >= 0.70, `reclaimable ratio ${candidateTokens / total} ≥ 0.70`);
	assert.equal(m.rejectedByP0, 1);
	assert.equal(m.rejectedByRecentFloor, 3, "critical P1 + 2 tail pairs under the floor");

	// a real compaction is planned (≥ minReclaim, ≤ cap), and the critical error is out
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	assert.ok(plan.selected.reclaimTokens >= 2048, "planned reclaim ≥ minReclaim");
	assert.ok(plan.selected.reclaimTokens <= 65536, "planned reclaim within the single-transaction cap");
	const selected = new Set(plan.selected.unitIds);
	assert.ok(!selected.has(critical.unitId), "critical error is NOT in the planned segment");
});

// ---------------------------------------------------------------------------
// Benchmark C — Recent Garbage (§108): the newest 10K is 8K repeated build
// log + 2K important. The planner must prune the 8K (it is recent, but it is
// garbage — duplication + low intrinsic sink it to TRASH) and keep the 2K.
// ---------------------------------------------------------------------------
test("Benchmark C (§108): 8K repeated recent build log is pruned, 2K important kept", () => {
	const now = T0 + 49 * H;
	const events = [];
	const BUILD_OUT = "build ok chunk-1 chunk-2 chunk-3 chunk-4 asset-hashed";
	for (let i = 0; i < 8; i += 1) events.push(...toolPair("构建。", [{ name: "pwsh", arguments: "pnpm build" }], [BUILD_OUT], { time: T0 + 47 * H + i * 10 * MIN }));
	const importantDecision = assistantMsg("决定：采用新部署流水线，旧流水线弃用。", { time: T0 + 48 * H });
	events.push(importantDecision);
	events.push(...toolPair("跑测试。", [{ name: "pwsh", arguments: "node --test test/deploy/" }], ["  passing 12\n  failing 0\nexit code: 0 全部通过"], { time: T0 + 48 * H + 5 * MIN }));

	const plan = runPlan(events, { now, sessionId: "bench-C" }); // Z2
	assert.equal(plan.pressure.zone, "Z2");

	// plan rows carry no unit text — positional: 8 build pairs, decision, verified pair
	assert.equal(plan.units.length, 10, "unit census");
	const builds = plan.units.slice(0, 8);
	// recent is NOT the same as valuable: duplication + low intrinsic keep them TRASH
	assert.ok(builds.slice(1).every((u) => u.features.duplication === 1), "pairs 2–8 are exact duplicates");
	assert.ok(builds.every((u) => u.tier === "TRASH"), "all 8 recent garbage pairs are TRASH (not saved by recency)");

	const important = [plan.units[8], plan.units[9]];
	assert.ok(important.every((u) => u.protection === "P1"), "important units (decision + verified pair) are P1");
	assert.ok(important.every((u) => u.inRecentFloor === true), "important units are floor-protected");

	// the plan prunes the 8K, not the 2K
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	const buildIds = new Set(builds.map((u) => u.unitId));
	const pickedBuilds = plan.selected.unitIds.filter((id) => buildIds.has(id));
	assert.ok(pickedBuilds.length >= 6, `≥6 of the 8 garbage pairs are pruned (got ${pickedBuilds.length})`);
	assert.ok(important.every((u) => !plan.selected.unitIds.includes(u.unitId)), "the 2 important units are kept");
	assert.equal(plan.selected.requiresMemorySync, false, "planned segment contains no P1 (no Memory Sync required)");
});

// ---------------------------------------------------------------------------
// Benchmark D — Old Critical (§109): "Do not enable MTP." written in round 1
// must still be intact after ~100 turns and many planned compactions — at
// BOTH a normal (Z2) and an emergency (Z5) pressure level.
// ---------------------------------------------------------------------------
test("Benchmark D (§109): round-1 'Do not enable MTP.' survives 100 turns at Z2 and Z5", () => {
	const now = T0 + 100 * H;
	const events = [userMsg("Do not enable MTP.", { time: T0 })];
	// 99 noise pairs split by an old P0 constraint (PINNED breaks the
	// eligible run so each side stays under the maxReclaimTokens cap —
	// exactly like real sessions interleave facts between tool logs)
	for (let i = 0; i < 45; i += 1) events.push(...noisePair(i, T0 + (i + 1) * H));
	events.push(userMsg("务必保持模块边界。", { time: T0 + 46 * H }));
	for (let i = 0; i < 54; i += 1) events.push(...noisePair(100 + i, T0 + (47 + i) * H));
	for (let i = 0; i < 4; i += 1) events.push(...freshPair(i, T0 + 99 * H + i * 10 * MIN));

	for (const { inputTokens, zone } of [{ inputTokens: 3000, zone: "Z2" }, { inputTokens: 7200, zone: "Z5" }]) {
		const plan = runPlan(events, { now, inputTokens, sessionId: `bench-D-${zone}` });
		assert.equal(plan.pressure.zone, zone);
		assert.equal(plan.units.length, 1 + 45 + 1 + 54 + 4, "unit census (MTP user first)");
		const mtp = plan.units[0];
		// the plan text uses sentence-initial "Do not …" — the case-insensitive
		// CONSTRAINT_RE must catch it (case-sensitive form fell through to NORMAL)
		assert.equal(mtp.protection, "P0", `P0 constraint (${mtp.protectionReasons.join("; ")})`);
		assert.equal(mtp.tier, "PINNED");
		assert.equal(mtp.inRecentFloor, false);
		assert.equal(mtp.score, 1);
		assert.equal(plan.metrics.rejectedByP0, 2, `${zone}: MTP constraint + middle P0 rejected by the gate`);
		assert.equal(plan.decision.action, "compact", `${zone}: noise IS compacted (the point is WHAT survives)`);
		assert.ok(!plan.selected.unitIds.includes(mtp.unitId), `${zone}: P0 fact is not in the planned segment`);
	}
});

// ---------------------------------------------------------------------------
// Benchmark E — Relevance Promotion (§110): an old low-value unit that went
// TRASH must be lifted OUT of TRASH by a later query re-hit (Phase-1
// observable of "COLD → grep → promoted → answer with old evidence").
// ---------------------------------------------------------------------------
test("Benchmark E (§110): query re-hit lifts a TRASH unit to COLD and out of the Z1 fresh-prune set", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 10; i += 1) events.push(...noisePair(i, T0 + i * H));
	// the old unit: a plain tool log (intrinsic 0.15, X 0.9) → TRASH when cold
	events.push(...toolPair("跑 MTP-PROBE。", [{ name: "pwsh", arguments: "node eval.mjs MTP-PROBE" }], ["MTP-PROBE ERROR_TIMEOUT timeout 平均 42ms 完成"], { time: T0 + 40 * H }));
	for (let i = 0; i < 4; i += 1) events.push(...freshPair(i, T0 + 48 * H + i * 10 * MIN));

	// Part 1 (Z2): the relevance lift — TRASH → COLD, measurable on the row.
	// COLD IS the Z2 target tier (coldCompact), so at Z2 the promoted unit can
	// still be selected; its guaranteed Phase-1 safety comes from Part 2.
	const noQuery = runPlan(events, { now, query: null, inputTokens: 3000, sessionId: "bench-E-0" });
	const withQuery = runPlan(events, { now, query: "MTP-PROBE ERROR_TIMEOUT timeout 延迟", inputTokens: 3000, sessionId: "bench-E-1" });
	assert.equal(noQuery.pressure.zone, "Z2");
	assert.equal(withQuery.pressure.zone, "Z2");

	// positional: 10 noise units, then the MTP-PROBE pair, then 4 fresh units
	assert.equal(noQuery.units.length, 15, "unit census");
	assert.equal(withQuery.units.length, 15, "unit census");
	const u0 = noQuery.units[10];
	const u1 = withQuery.units[10];
	assert.equal(u0.protection, "NORMAL", "the unit itself is not P1 — only relevance lifts it");
	assert.equal(u0.tier, "TRASH", "cold unit sits in TRASH without a query");
	assert.equal(u0.features.taskRelevance, 0);
	assert.ok(u1.features.taskRelevance >= 0.9, `relevance lanes hit (symbol + error + strong keyword): ${u1.features.taskRelevance}`);
	assert.equal(u1.tier, "COLD", "query re-hit lifts exactly one tier: TRASH → COLD (0.55·rel < warmEnter 0.58 for old + X 0.9)");
	assert.ok(u1.score > u0.score + 0.05, `score ${u0.score} → ${u1.score}`);

	// Part 2 (Z1): the deterministic consequence — the Z1 fresh-prune targets
	// TRASH units only; the promoted unit leaves the prune set.
	const z1no = runPlan(events, { now, query: null, inputTokens: 2000, sessionId: "bench-E-z1-0" });
	const z1yes = runPlan(events, { now, query: "MTP-PROBE ERROR_TIMEOUT timeout 延迟", inputTokens: 2000, sessionId: "bench-E-z1-1" });
	assert.equal(z1no.pressure.zone, "Z1");
	assert.equal(z1yes.pressure.zone, "Z1");
	assert.equal(z1no.decision.action, "fresh-prune", z1no.decision.reason);
	assert.equal(z1yes.decision.action, "fresh-prune", z1yes.decision.reason);
	const pruneCount = (p) => Number(p.decision.reason.match(/micro-prune of (\d+) unit/)?.[1] ?? -1);
	// TRASH census: 10 noise + MTP + 4 fresh = 15 without the query (the 3
	// fresh pairs under the 2048-token floor are bypass-eligible at
	// X ≥ floorBypassX — recent ≠ valuable; they stay REDUCE-ONLY at apply
	// time, never dropped whole), 14 with the query (MTP lifted to COLD)
	assert.equal(pruneCount(z1no), 15, z1no.decision.reason);
	assert.equal(pruneCount(z1yes), 14, z1yes.decision.reason);
	const e0 = z1no.units[10];
	const e1 = z1yes.units[10];
	assert.equal(e0.tier, "TRASH");
	assert.equal(e1.tier, "COLD");
	assert.ok(!e1.inRecentFloor, "lift is not floor-driven");
	// and the promoted unit's evidence would be re-surfaced, not pruned:
	// retrieve-then-answer with the old evidence itself is Phase 3 (§110 full).
});

// ---------------------------------------------------------------------------
// Benchmark F — Decision Supersession (§111): the A→B→C chain must stay
// intact under the shadow planner (no partial compaction of the chain).
// Detecting "current = C" and answering with it is Phase 3 (Memory Sync +
// exact coverage); this test is the Phase-1 sentinel for that.
// ---------------------------------------------------------------------------
test("Benchmark F (§111): supersession chain A→B→C stays intact (no partial compaction)", () => {
	const now = T0 + 49 * H;
	const events = [];
	events.push(assistantMsg("决定：采用方案A（缓存策略）。", { time: T0 + 20 * H }));
	events.push(assistantMsg("决定：采用方案B，取代方案A（方案A 弃用）。", { time: T0 + 21 * H }));
	events.push(assistantMsg("决定：采用方案C，取代方案B（方案B 弃用）。", { time: T0 + 22 * H }));
	for (let i = 0; i < 12; i += 1) events.push(...noisePair(i, T0 + i * H));
	for (let i = 0; i < 4; i += 1) events.push(...freshPair(i, T0 + 48 * H + i * 10 * MIN));

	const plan = runPlan(events, { now, sessionId: "bench-F" });
	assert.equal(plan.pressure.zone, "Z2");
	// positional: 3 decision units first, then 12 noise, then 4 fresh
	assert.equal(plan.units.length, 3 + 12 + 4, "unit census");
	const chain = plan.units.slice(0, 3);
	assert.ok(chain.every((u) => u.protection === "P1"), "all three decisions are P1");
	// the chain is a contiguous run in the surface (slice order = surface
	// order) — compaction must not split it
	assert.ok(chain.every((u) => u.tier !== "TRASH"), "P1 floor keeps the chain out of TRASH (WARM+)");
	assert.equal(plan.decision.action, "compact", "noise around the chain IS compacted");
	assert.ok(chain.every((u) => !plan.selected.unitIds.includes(u.unitId)), "no part of the chain is in the planned segment");
});

// ---------------------------------------------------------------------------
// Benchmark G — Context Injection Spike (§112): a trivial query ("你好") must
// not cause any promotion/injection: every non-greeting unit keeps its exact
// score and tier, and the plan is identical.
// ---------------------------------------------------------------------------
test("Benchmark G (§112): trivial query '你好' promotes nothing and changes no plan", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 10; i += 1) events.push(...noisePair(i, T0 + i * H));
	events.push(userMsg("你好", { time: T0 + 48 * H }));
	for (let i = 0; i < 3; i += 1) events.push(...freshPair(i, T0 + 48 * H + (i + 1) * 10 * MIN));

	const base = runPlan(events, { now, query: null, sessionId: "bench-G-0" });
	const hello = runPlan(events, { now, query: "你好", sessionId: "bench-G-1" });
	assert.equal(base.pressure.zone, hello.pressure.zone);

	// plan-level identity
	assert.equal(base.decision.action, hello.decision.action);
	assert.deepEqual([...(base.selected?.unitIds ?? [])], [...(hello.selected?.unitIds ?? [])], "same planned segment");

	// per-unit: no non-greeting unit may gain relevance from the trivial query
	// positional: 10 noise, then the greeting, then 3 fresh
	assert.equal(hello.units.length, 10 + 1 + 3, "unit census");
	const greeting = hello.units[10];
	const baseGreeting = base.units[10];
	// The greeting unit literally CONTAINS the query text ("你好" segments as a
	// 2-char zh word, length ≥2 → weak keyword lane). A query matching the unit
	// that contains it is correct lexical behavior — §112's invariant is that
	// this self-match does NOT promote the unit or leak into any other one.
	assert.equal(greeting.features.taskRelevance, 0.1, "greeting self-matches the trivial query via the weak CJK keyword lane");
	assert.equal(greeting.tier, "TRASH", "greeting stays TRASH — no promotion");
	assert.equal(greeting.tier, baseGreeting.tier, "greeting tier unchanged by the trivial query");
	assert.ok(Math.abs(greeting.score - baseGreeting.score - 0.055) < 1e-9, "score delta is exactly 0.55·0.10 (weak lane) — nothing else moved");
	for (const u of hello.units) {
		if (u.unitId === greeting.unitId) continue;
		assert.equal(u.features.taskRelevance, 0, `no relevance leak into ${u.unitId}`);
		const b = base.units.find((x) => x.unitId === u.unitId);
		assert.equal(u.score, b.score, `score unchanged for ${u.unitId}`);
		assert.equal(u.tier, b.tier, `tier unchanged for ${u.unitId}`);
	}
});
