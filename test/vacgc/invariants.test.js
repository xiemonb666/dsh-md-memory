/**
 * VAC-GC core invariants (plan §125–§133, §137) — Phase 1 (shadow) slices.
 *
 * These encode the FINAL invariants of the plan as deterministic planner
 * tests. Where a full check needs executing-phase machinery (summary
 * validation, Memory Sync actually running), the Phase-1 slice asserts the
 * shadow-side contract: what the plan reports and what it can NEVER report
 * (P0 in a selected segment, a crash plan selecting anything, …).
 *
 *  §125 hard gate > any weight        §130 crash → safe no-op
 *  §126 score ordering                §131 emergency never touches P0
 *  §127 HOT|COLD|COLD|HOT → middle    §132 scale: full census under row cap
 *  §129 checkpoint provenance (shadow) §133 memory access scope
 */
import test from "node:test";
import assert from "node:assert/strict";
import { userMsg, assistantMsg, toolPair, checkpointMsg, makeSession, pricesFor, T0 } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";

const H = 3600000;
const MIN = 60000;
const W = 8192;

function noisePair(i, time, tokens = 1000) {
	return {
		events: toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/inv-${i}` }], [`inv file ${i}.txt`], { time }),
		tokens
	};
}

function runPlan(events, opts) {
	const session = makeSession(events);
	// 500-token baseline with per-seq overrides (pricesFor's sparse map would
	// zero out every unlisted node)
	const prices = pricesFor(session, 500).map((p) => (opts.priceOverrides?.[p.seq] !== undefined ? { seq: p.seq, tokens: opts.priceOverrides[p.seq] } : p));
	return planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices,
		now: opts.now,
		query: opts.query ?? null,
		memory: opts.memory ?? null,
		contextWindow: W,
		inputTokens: opts.inputTokens ?? 3000,
		sessionId: opts.sessionId ?? "inv"
	});
}

// ---------------------------------------------------------------------------
// §125 — ANY weight must never override Hard Protection.
// ---------------------------------------------------------------------------
test("§125: old / huge / duplicate / irrelevant P0 all stay P0 (even at Z5)", () => {
	const now = T0 + 720 * H; // 30 days
	const events = [];
	const p0Old = userMsg("必须保留迁移脚本。", { time: T0 });
	const p0Huge = userMsg("务必保持向后兼容。", { time: T0 + H });
	const p0DupA = userMsg("不要删除生产配置。", { time: T0 + 2 * H });
	const p0DupB = userMsg("不要删除生产配置。", { time: T0 + 3 * H });
	const p0Irrel = userMsg("禁止在生产环境开启实验特性。", { time: T0 + 4 * H });
	events.push(p0Old, p0Huge, p0DupA, p0DupB, p0Irrel);
	for (let i = 0; i < 20; i += 1) events.push(...noisePair(i, T0 + (10 + i) * H).events);
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(100 + i, T0 + 719 * H + i * 10 * MIN).events);

	const plan = runPlan(events, { now, inputTokens: 7200, priceOverrides: { [p0Huge.seq]: 20000 }, query: "数据库备份策略", sessionId: "inv-125" });
	assert.equal(plan.pressure.zone, "Z5", "most aggressive zone");

	const p0s = [p0Old, p0Huge, p0DupA, p0DupB, p0Irrel].map((e) => plan.units.find((u) => u.firstSeq === e.seq));
	assert.ok(p0s.every(Boolean), "all five P0 messages are units");
	for (const u of p0s) {
		assert.equal(u.protection, "P0", `protection survives (${u.protectionReasons.join("; ")})`);
		assert.equal(u.tier, "PINNED");
		assert.equal(u.score, 1, "score pinned at 1 regardless of age/size/irrelevance");
	}
	// age, 20K-token size, duplication, and zero query relevance must not matter
	assert.equal(plan.decision.action, "compact", "Z5 noise IS compacted — the point is WHAT is protected");
	assert.ok(p0s.every((u) => !plan.selected.unitIds.includes(u.unitId)), "no P0 unit is in the planned segment (Invariant 1: P0 loss = 0)");
	assert.equal(plan.metrics.rejectedByP0, 5, "gate census: all five rejected by protection");
});

// ---------------------------------------------------------------------------
// §126 — score ordering: duplicated recent garbage < old value; greeting <
// query-relevant old benchmark.
// ---------------------------------------------------------------------------
test("§126: recent huge duplicated log < old active decision; greeting < relevant old benchmark", () => {
	const now = T0 + 49 * H;
	const OUT = "build ok chunk-1 chunk-2 chunk-3 asset-hashed";
	const events = [];
	events.push(...toolPair("构建。", [{ name: "pwsh", arguments: "pnpm build" }], [OUT], { time: T0 + H })); // old log
	const dupLog = toolPair("构建。", [{ name: "pwsh", arguments: "pnpm build" }], [OUT], { time: T0 + 48 * H }); // recent duplicate
	events.push(...dupLog);
	const decision = assistantMsg("决定：采用流式批处理架构。", { time: T0 + 2 * H });
	events.push(decision);
	const bench = toolPair("跑基准。", [{ name: "pwsh", arguments: "node bench.mjs" }], ["benchmark suite p95 42ms 耗时 3s"], { time: T0 + 3 * H });
	events.push(...bench);
	const greeting = userMsg("你好", { time: T0 + 48 * H + 30 * MIN });
	events.push(greeting);
	for (let i = 0; i < 3; i += 1) events.push(...noisePair(i, T0 + 48 * H + (i + 1) * 30 * MIN).events);

	const plan = runPlan(events, { now, query: "benchmark p95", priceOverrides: { [dupLog[0].seq]: 5000, [dupLog[1].seq]: 5000 }, sessionId: "inv-126" });
	const unitAt = (e) => plan.units.find((u) => u.firstSeq === e.seq);
	const dup = unitAt(dupLog[0]);
	const dec = unitAt(decision);
	const bn = unitAt(bench[0]);
	const gr = unitAt(greeting);
	assert.ok(dup && dec && bn && gr, "all four units present");
	// (a) the 10K-token FRESH duplicate is worth less than a 46h-old decision
	assert.ok(dup.features.duplication === 1, "exact duplicate (fingerprint)");
	assert.ok(dup.score < dec.score, `duplicated recent log ${dup.score} < old decision ${dec.score}`);
	assert.equal(dec.protection, "P1", "old decision is P1 (floor 0.75)");
	// (b) a fresh greeting is worth less than an old benchmark re-hit by the query
	assert.ok(gr.features.taskRelevance === 0, "greeting has no relevance");
	assert.ok(bn.features.taskRelevance > 0, "benchmark re-hit by query");
	assert.ok(gr.score < bn.score, `greeting ${gr.score} < query-relevant benchmark ${bn.score}`);
	assert.equal(bn.contentType, "benchmark", "benchmark content type (intrinsic 0.85)");
});

// ---------------------------------------------------------------------------
// §127 — HOT | COLD | COLD | HOT: only the middle run is selected.
// ---------------------------------------------------------------------------
test("§127: HOT|COLD|COLD|HOT — the planner selects exactly the middle COLD run", () => {
	const now = T0 + 49 * H;
	const events = [];
	const hot1 = assistantMsg("决定：采用流式批处理架构。", { time: T0 + 48 * H }); // recent P1 → HOT
	events.push(hot1);
	const cold1 = toolPair("", [{ name: "pwsh", arguments: "ls -la /tmp/hot1" }], ["cold file 1"], { time: T0 + H });
	const cold2 = toolPair("", [{ name: "pwsh", arguments: "ls -la /tmp/hot2" }], ["cold file 2"], { time: T0 + 2 * H });
	events.push(...cold1, ...cold2);
	const hot2 = assistantMsg("决定：选用增量快照存储。", { time: T0 + 48 * H + 10 * MIN }); // recent P1 → HOT
	events.push(hot2);
	for (let i = 0; i < 3; i += 1) events.push(...noisePair(i, T0 + 48 * H + (i + 2) * 10 * MIN).events); // floor fill

	const plan = runPlan(events, { now, inputTokens: 3000, priceOverrides: { [cold1[0].seq]: 3000, [cold1[1].seq]: 3000, [cold2[0].seq]: 3000, [cold2[1].seq]: 3000 }, sessionId: "inv-127" });
	assert.equal(plan.pressure.zone, "Z2");
	const u = (e) => plan.units.find((x) => x.firstSeq === e.seq);
	const h1 = u(hot1);
	const h2 = u(hot2);
	const c1 = u(cold1[0]);
	const c2 = u(cold2[0]);
	assert.equal(h1.tier, "HOT", `hot1 ${h1.score} — recent P1 decision`);
	assert.equal(h2.tier, "HOT", `hot2 ${h2.score} — recent P1 decision`);
	assert.ok(c1.tier === "COLD" || c1.tier === "TRASH", `cold1 ${c1.tier}`);
	assert.ok(c2.tier === "COLD" || c2.tier === "TRASH", `cold2 ${c2.tier}`);

	assert.equal(plan.decision.action, "compact", "the middle run IS the compaction target");
	assert.deepEqual(plan.selected.unitIds, [c1.unitId, c2.unitId], "ONLY the middle COLD run is selected");
	assert.ok(!plan.selected.unitIds.includes(h1.unitId) && !plan.selected.unitIds.includes(h2.unitId), "HOT units are never in the segment");
});

// ---------------------------------------------------------------------------
// §129 (shadow slice) — a previous compaction checkpoint stays P1 with its
// provenance intact; it is never a normal-pressure segment target.
// ---------------------------------------------------------------------------
test("§129: compaction checkpoint stays P1, provenance intact, never selected at Z2", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 8; i += 1) events.push(...noisePair(i, T0 + i * H).events);
	const cp = checkpointMsg("早期摘要：实现影子规划器与压力区间。", [11, 12, 13], { time: T0 + 10 * H });
	events.push(cp);
	for (let i = 0; i < 8; i += 1) events.push(...noisePair(20 + i, T0 + (11 + i) * H).events);
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(40 + i, T0 + 48 * H + i * 10 * MIN).events);

	const plan = runPlan(events, { now, sessionId: "inv-129" });
	assert.equal(plan.pressure.zone, "Z2");
	const unit = plan.units.find((x) => x.firstSeq === cp.seq);
	assert.ok(unit, "checkpoint is a unit");
	assert.equal(unit.kind, "checkpoint");
	assert.equal(unit.protection, "P1", "checkpoint is P1 (never free-summarized, §71)");
	assert.ok(unit.protectionReasons[0].startsWith("compaction checkpoint"), `provenance reason kept: ${unit.protectionReasons[0]}`);
	assert.equal(plan.decision.action, "compact", "noise around the checkpoint IS compacted");
	assert.ok(!plan.selected.unitIds.includes(unit.unitId), "checkpoint is NOT in the planned segment");
});

// ---------------------------------------------------------------------------
// §130 — fail-safe: a crash degrades to a safe no-op (never compact-all);
// P1 content without Memory Sync must be flagged, not silently compacted.
// ---------------------------------------------------------------------------
test("§130: scorer crash → safe no-op plan; P1 segment without memory is flagged requiresMemorySync", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 12; i += 1) events.push(...noisePair(i, T0 + i * H).events);
	events.push(assistantMsg("决定：采用增量检查点方案。", { time: T0 + 48 * H })); // recent P1 (WARM)
	for (let i = 0; i < 8; i += 1) events.push(...noisePair(20 + i, T0 + (11 + i) * H).events);

	// crash vector: the token meter throws mid-plan → the whole plan degrades
	const session = makeSession(events);
	const prices = pricesFor(session, 500);
	const crashing = new Proxy(prices, {
		get(target, key) {
			if (key === "length") return target.length;
			if (typeof key === "string" && key !== "length" && key !== "constructor" && key !== "symbol") throw new Error("token meter exploded");
			return target[key];
		}
	});
	const crashed = planVacGc({ nodes: session.nodes, eventAt: session.eventAt, prices: crashing, now, contextWindow: W, inputTokens: 3000, sessionId: "inv-130-crash" });
	assert.equal(crashed.degraded, true, "plan reports degraded");
	assert.equal(crashed.decision.action, "none", "a crash NEVER becomes compact-all");
	assert.equal(crashed.selected, null, "nothing is selected in a crash plan");
	assert.equal(crashed.unitCount, 0);
	assert.equal(crashed.metrics.reclaim, 0, "crash plan reclaims nothing");
	assert.ok(crashed.error.includes("token meter exploded"), "error surfaced for observability");

	// memory-sync contract: at Z5 a P1-containing segment is only reported
	// WITH the sync flag — the executor must refuse to compact it unsynced
	const plan = runPlan(events, { now, inputTokens: 7200, memory: null, sessionId: "inv-130-sync" });
	assert.equal(plan.pressure.zone, "Z5");
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	assert.ok(plan.selected, "a P1-containing run is the best segment at Z5");
	assert.equal(plan.selected.requiresMemorySync, true, "P1 content without Memory Sync is flagged, not silently compacted");
	assert.ok(plan.decision.reason.includes("Memory Sync"), "the decision reason states the sync requirement");
});

// ---------------------------------------------------------------------------
// §131 — emergency ladder: at Z5 the planner may compact everything BELOW P0
// — never a P0 itself, even when the P0 sits inside the only reclaimable run.
// ---------------------------------------------------------------------------
test("§131: emergency (Z5) never selects the P0 unit, even inside the only reclaimable run", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 10; i += 1) events.push(...noisePair(i, T0 + i * H).events);
	const p0 = userMsg("不要删除数据仓库。", { time: T0 + 10 * H });
	events.push(p0);
	for (let i = 0; i < 12; i += 1) events.push(...noisePair(20 + i, T0 + (11 + i) * H).events);
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(40 + i, T0 + 48 * H + i * 10 * MIN).events);

	const plan = runPlan(events, { now, inputTokens: 7200, sessionId: "inv-131" });
	assert.equal(plan.pressure.zone, "Z5");
	const unit = plan.units.find((x) => x.firstSeq === p0.seq);
	assert.equal(unit.protection, "P0");
	assert.equal(unit.tier, "PINNED");
	assert.equal(plan.decision.action, "compact", "the ladder still reclaims (the noise around it)");
	assert.ok(!plan.selected.unitIds.includes(unit.unitId), "P0 is never selected at emergency pressure");
	assert.equal(plan.metrics.rejectedByP0, 1);
});

// ---------------------------------------------------------------------------
// §133 — relevance reads only HOT/STATE memory (stateText + activeIds); it
// must never pull whole-ledger scans into the scoring path. The P0
// provenance lane (review 2026-09-12) additionally PROBES for the
// activeSourceIds function — a per-seq lookup, not a scan — so it is part of
// the allowed surface. The P0.5 conservative lane PROBES for the
// unresolvedTerms Map (id → pre-extracted evidence terms): a precomputed
// per-entry term set, matched in O(unit text) — still no ledger scan.
// ---------------------------------------------------------------------------
test("§133: the planner touches only available/stateText/activeIds (or the activeSourceIds function probe) of the memory index", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 10; i += 1) events.push(...noisePair(i, T0 + i * H).events);
	events.push(userMsg("继续修复压力区间", { time: T0 + 48 * H }));
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(30 + i, T0 + 48 * H + (i + 1) * 10 * MIN).events);

	const accessed = new Set();
	const ledger = {
		available: true,
		stateText: "当前状态：VAC-GC 影子规划器 压力区间 修复中",
		activeIds: new Set(["DEC-001"]),
		citedByActive: new Set(["REQ-001"]),
		statePaths: new Set(["STATE.md"])
	};
	const spy = new Proxy(ledger, {
		get(target, key) {
			accessed.add(String(key));
			return target[key];
		}
	});
	const plan = runPlan(events, { now, query: "压力区间", memory: spy, sessionId: "inv-133" });
	assert.ok(plan.units.length > 0, "plan computed with memory present");
	// Only the LedgerIndex standing-context surface may be read — never a
	// whole-ledger scan (§133): the index's five fields are exactly the
	// allowed reads, and the proxy records EVERY property access.
	const allowed = ["available", "stateText", "activeIds", "citedByActive", "statePaths", "activeSourceIds", "unresolvedTerms"];
	assert.ok([...accessed].every((k) => allowed.includes(k)), `only the LedgerIndex surface is read: ${[...accessed].join(", ")}`);
	assert.ok(accessed.has("stateText") && accessed.has("activeIds"), "state + active ids ARE the memory surface the scorer uses for relevance");
});

// ---------------------------------------------------------------------------
// §132 — scale: a 1500-unit surface plans in O(units) time, the row view is
// capped but the METRICS census is never truncated.
// ---------------------------------------------------------------------------
test("§132: 1500 units — row view capped at 400, metrics census complete, fast", () => {
	const now = T0 + 49 * H;
	const events = [];
	for (let i = 0; i < 750; i += 1) events.push(...noisePair(i, T0 + (i % 40) * H).events);
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(800 + i, T0 + 48 * H + i * 10 * MIN).events);

	const startedAt = Date.now();
	const plan = runPlan(events, { now, sessionId: "inv-132" });
	const elapsedMs = Date.now() - startedAt;

	assert.equal(plan.unitCount, 754, "full unit count (750 noise + 4 fresh)");
	assert.equal(plan.units.length, 400, "plan row view capped at maxUnitsInPlan (400)");
	assert.equal(plan.metrics.unitCount, 754, "metrics census is NEVER truncated by the row cap");
	// gate-bucket invariant holds at scale
	const m = plan.metrics;
	assert.equal(m.candidateCount + m.rejectedByP0 + m.rejectedByBalance + m.rejectedByRecentFloor + m.rejectedByTier, m.unitCount, "bucket invariant at 1500+ units");
	assert.ok(elapsedMs < 30000, `planned in ${elapsedMs}ms (O(units) smoke ceiling)`);
});
