/**
 * The full read-only pipeline (plan §83–§95, §117, §130): unit building →
 * hard gate → features → score/tier → pressure/zone → segments → selection,
 * plus the fail-safe contract (never throws, never mutates, Phase 1 =
 * observation only — the plan is what a value-aware engine WOULD do).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planVacGc, buildQueryTerms, resolveVacGcConfig, VACGC_DEFAULTS, ESCALATION_LADDER } from "../../lib/vacgc/index.js";
import { standardScenario, userMsg, assistantMsg, toolPair, makeSession, pricesFor, fakeMemory, deepFreeze, T0 } from "./helpers.js";

const W_SMALL = 8192; // clamp-bound test window (minReclaim 2048, floor 2048)

function planScenario(over = {}) {
	const { session, events, prices, now } = standardScenario();
	const input = {
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices,
		now,
		query: "继续修复影子规划器的压力区间",
		memory: null,
		contextWindow: 192000,
		inputTokens: 30000,
		...over
	};
	return { plan: planVacGc(input), input, events };
}

test("Z0: below softGc → action none, no segments, score cache only", () => {
	const { plan } = planScenario();
	assert.equal(plan.degraded, false);
	assert.equal(plan.schema, "vacgc-plan-v1");
	assert.equal(plan.pressure.zone, "Z0");
	assert.equal(plan.decision.action, "none");
	assert.match(plan.decision.reason, /Z0/);
	assert.equal(plan.segments.length, 0);
	assert.equal(plan.selected, null);
	assert.equal(plan.pruneCandidates.length, 0);
	// tier stats cover every unit exactly once
	const total = Object.values(plan.tiers).reduce((s, t) => s + t.count, 0);
	assert.equal(total, plan.unitCount);
	assert.equal(plan.unitCount, plan.units.length);
	assert.ok(plan.unitCount >= 7, `expected a multi-unit scenario, got ${plan.unitCount}`);
});

test("the hard gate dominates every tier (P0 pinned 1/PINNED; P1 ≥ 0.75)", () => {
	const { plan, events } = planScenario();
	for (const row of plan.units) {
		if (row.protection === "P0" || row.protection === "P0_TRANSIENT") {
			assert.equal(row.score, 1, `${row.unitId} must be pinned`);
			assert.equal(row.tier, "PINNED");
		}
		if (row.protection === "P1") assert.ok(row.score >= 0.75, `${row.unitId} P1 floor`);
	}
	// the goal/constraint user message is P0, the decision assistant is P1
	const byKind = (kind) => plan.units.filter((u) => u.kind === kind);
	assert.ok(byKind("user").some((u) => u.protection === "P0"), "goal user message must be P0");
	assert.ok(byKind("assistant").some((u) => u.protection === "P1"), "decision assistant must be P1");
	// the config read (settings.yaml) is a P1 important-config lane
	assert.ok(plan.units.some((u) => u.kind === "tool-pair" && u.protection === "P1"), "config read must be P1");
	// no protected unit may appear inside any segment (defensive, §57)
	for (const seg of plan.segments) {
		for (const id of seg.unitIds) {
			const row = plan.units.find((u) => u.unitId === id);
			assert.ok(row.protection === "NORMAL", "segments must contain only NORMAL units");
		}
	}
	assert.ok(events.length >= 8);
});

test("deep-frozen inputs are never mutated (Phase 1 read-only contract, §130)", () => {
	const { session, events, prices, now } = standardScenario();
	// freeze everything the planner might touch: events (incl. data arrays),
	// the session object, and the price list. A mutation would throw a
	// TypeError → the planner's catch → degraded plan (the assertion below).
	for (const e of events) deepFreeze(e);
	deepFreeze(prices);
	deepFreeze(session);
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices,
		now,
		query: "继续修复影子规划器的压力区间",
		memory: null,
		contextWindow: 192000,
		inputTokens: 30000
	});
	assert.equal(plan.degraded, false, `mutation or crash detected: ${plan.error ?? ""}`);
	assert.equal(plan.unitCount, 8);
	// the input survived intact
	assert.equal(events[0].data.content[0].text, "你好");
	assert.equal(prices.length, session.nodes.length);
});

test("Z2 with an old cold/trash run: one balanced segment is selected (compact)", () => {
	// 17 stale tool-log units (8500 tokens) + a recent working set (1000).
	const now = T0 + 3000 * 60000;
	const events = [userMsg("早期的探索性工作")];
	for (let i = 0; i < 17; i += 1) {
		events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/legacy-${i}` }], [`listing ${i}\nold file ${i}.txt`], { time: T0 + i }));
	}
	events.push(userMsg("当前的问题：影子规划器为什么没有输出", { time: T0 + 2990 * 60000 }));
	events.push(assistantMsg("需要检查压力区间映射。", { time: T0 + 2991 * 60000 }));
	const session = makeSession(events);
	const prices = pricesFor(session, 500);
	const plan = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "当前的问题：影子规划器为什么没有输出", memory: null,
		contextWindow: W_SMALL, inputTokens: 3000, // soft ≈ 0.741 → Z2
		trigger: "turn-end", sessionId: "test-z2"
	});
	assert.equal(plan.degraded, false);
	assert.equal(plan.pressure.zone, "Z2", JSON.stringify(plan.pressure));
	assert.equal(plan.decision.action, "compact", plan.decision.reason);
	assert.ok(plan.selected, "a segment must be selected");
	assert.equal(plan.selected.requiresMemorySync, false);
	// Each pair is 2 nodes × 500 = 1000 tokens. Floor 2048 (W=8192): walking
	// from the tail — assistant 500, user 1000, pair 2000, pair 3000 ≥ 2048 →
	// the last 4 units are floor-protected; stale run = 1 user + 15 pairs.
	assert.equal(plan.selected.unitIds.length, 16, JSON.stringify(plan.selected.unitIds.length));
	assert.equal(plan.selected.reclaimTokens, 500 + 15 * 1000);
	assert.ok(plan.selected.reclaimTokens >= plan.minimumReclaimTokens, "above minReclaim");
	assert.ok(plan.units.slice(-4).every((u) => u.inRecentFloor === true), "recent working set is floor-protected");
	assert.ok(plan.units.slice(0, 16).every((u) => u.inRecentFloor === false));
	assert.ok(!plan.selected.unitIds.includes(plan.units[plan.units.length - 1].unitId));
});

test("Z5 emergency: P1 content becomes eligible and requires Memory Sync", () => {
	const now = T0 + 3000 * 60000;
	const events = [userMsg("早期的探索性工作")];
	events.push(assistantMsg("决定：采用纯函数模块架构，先影子后执行。", { time: T0 + 100 })); // P1, stale
	for (let i = 0; i < 10; i += 1) {
		events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/legacy-${i}` }], [`listing ${i}\nold file ${i}.txt`], { time: T0 + 100 + i }));
	}
	events.push(userMsg("当前的问题：影子规划器为什么没有输出", { time: T0 + 2990 * 60000 }));
	events.push(assistantMsg("需要检查压力区间映射。", { time: T0 + 2991 * 60000 }));
	const session = makeSession(events);
	const prices = pricesFor(session, 500);
	const plan = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "当前的问题：影子规划器为什么没有输出", memory: null,
		contextWindow: W_SMALL, inputTokens: 7000, // hard = (7000+2048+2048)/8192 > 1 → Z5
		trigger: "pre-compact"
	});
	assert.equal(plan.degraded, false);
	assert.equal(plan.pressure.zone, "Z5", JSON.stringify(plan.pressure));
	// the stale P1 decision joins the candidate set in Z5 (with sync)
	const p1Row = plan.units.find((u) => u.protection === "P1");
	assert.ok(p1Row, "the stale decision must be P1");
	assert.equal(p1Row.inRecentFloor, false);
	const selected = plan.selected;
	assert.ok(selected, "emergency selects a segment");
	assert.equal(selected.containsP1 || selected.requiresMemorySync, true);
	assert.match(plan.decision.reason, /Memory Sync/);
});

test("Z1: fresh/micro TRASH prune is the only lane — no semantic segments (§43)", () => {
	const { session, prices, now } = standardScenario({ tokensPerNode: 200 });
	// W=8192, input 2200 → soft = (2200+2048+1024)/8192 = 0.6435 → Z1
	const planZ1 = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "继续修复影子规划器的压力区间", memory: null,
		contextWindow: W_SMALL, inputTokens: 2200
	});
	assert.equal(planZ1.pressure.zone, "Z1", JSON.stringify(planZ1.pressure));
	assert.equal(planZ1.decision.action, "fresh-prune");
	assert.match(planZ1.decision.reason, /TRASH micro-prune/);
	assert.equal(planZ1.segments.length, 0, "Z1 has no semantic segments");
	assert.ok(planZ1.pruneCandidates.every((c) => typeof c.unitId === "string" && c.tokens > 0));
});

test("prune mode keeps Phase 3 enabled when a legacy DSH adapter drops the scalar flag", () => {
	assert.equal(resolveVacGcConfig({ mode: "prune" }).semantic, true);
	assert.equal(resolveVacGcConfig({ mode: "prune", semantic: false }).semantic, true);
	assert.equal(resolveVacGcConfig({ mode: "shadow" }).semantic, false);
});

test("the plan carries the STEP 9 fresh-prune dry-run (§43/§119 preview — Z0: reduce-only, Z1: +drop)", () => {
	// Z0 (standard scenario): field present, well-shaped, no actions
	// (small results, no duplicates) — drops disabled in Z0.
	const { plan } = planScenario();
	assert.ok(plan.freshPrune, "the dry-run preview is always present");
	assert.equal(plan.freshPrune.allowDrop, false, "Z0: drops disabled (§43)");
	assert.equal(plan.freshPrune.actions.length, 0);
	assert.equal(plan.freshPrune.totalReclaim, 0);
	assert.equal(plan.freshPrune.stats.scanned, plan.unitCount);

	// Z1 with two identical STALE large tool pairs + a recent duplicate in
	// the floor: first stale copy reduced, second stale copy dropped whole,
	// the floor copy REDUCE-ONLY (bypassed by X ≥ floorBypassX — "recent ≠
	// valuable" — but never stubbed out: whole-unit drop stays
	// absolute-floor-protected).
	const now = T0 + 3000 * 60000;
	// ONE result string per call (the runtime shape) — a 40-line output is a
	// single tool/result event, NOT 40 of them.
	const body = Array.from({ length: 40 }, (_, i) => `legacy log line ${String(i + 1).padStart(3, "0")} with padding words to stretch the output width`).join("\n");
	const events = [
		userMsg("早期的探索性工作"),
		...toolPair("", [{ name: "pwsh", arguments: "ls -la /tmp/legacy" }], [body], { time: T0 + 10 }),
		...toolPair("", [{ name: "pwsh", arguments: "ls -la /tmp/legacy" }], [body], { time: T0 + 20 }),
		userMsg("当前的问题：影子规划器为什么没有输出", { time: T0 + 2990 * 60000 }),
		assistantMsg("需要检查压力区间映射。", { time: T0 + 2991 * 60000 }),
		...toolPair("", [{ name: "pwsh", arguments: "ls -la /tmp/legacy" }], [body], { time: T0 + 2992 * 60000 })
	];
	const session = makeSession(events);
	const prices = pricesFor(session, 500);
	const planZ1 = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "当前的问题：影子规划器为什么没有输出", memory: null,
		contextWindow: W_SMALL, inputTokens: 2200, // soft ≈ 0.6435 → Z1
		// working-set floor tuned so it covers exactly the last recent turn
		// (user + assistant + fresh pair = 2000 tokens): minTokens 1800 →
		// the walk from the tail crosses at that user message, leaving the
		// two OLD pairs outside the floor. (0.06·8192 = 491 < 1800, so the
		// minTokens override is what binds.)
		config: { recent: { ratio: 0.06, minTokens: 1800, maxTokens: 12288 } }
	});
	assert.equal(planZ1.pressure.zone, "Z1", JSON.stringify(planZ1.pressure));
	assert.equal(planZ1.freshPrune.allowDrop, true, "Z1: drops enabled");
	const fp = planZ1.freshPrune.actions;
	const reduce = fp.filter((a) => a.kind === "reduce");
	const drop = fp.filter((a) => a.kind === "drop");
	assert.equal(reduce.length, 2, JSON.stringify(fp));
	assert.equal(drop.length, 1, JSON.stringify(fp));
	assert.equal(drop[0].reason, `duplicate of ${reduce[0].unitId}`);
	assert.ok(drop[0].reclaim > 0, "dropping the whole pair reclaims its tokens");
	assert.ok(reduce[0].reclaim > 0 && reduce[0].after < reduce[0].before);
	assert.ok(typeof reduce[0].preview === "string" && reduce[0].preview.length > 0 && reduce[0].preview.length <= 160, "bounded preview");
	assert.equal(drop[0].preview, null, "drops carry no preview");
	assert.ok(planZ1.freshPrune.totalReclaim > 0);
	assert.equal(planZ1.freshPrune.stats.scanned, planZ1.unitCount);
	assert.deepEqual(planZ1.freshPrune.stats, { scanned: 6, trashTools: 3, reduced: 2, dropped: 1, untouched: 3 });
	// the floor copy of the duplicate (last pair) is reduce-only: it appears
	// in the actions (bypassed by X ≥ floorBypassX) but is NEVER dropped
	const floorPairId = planZ1.units.filter((u) => u.kind === "tool-pair" && u.inRecentFloor)[0]?.unitId;
	assert.ok(floorPairId, "the last pair is recent-floor-marked");
	assert.equal(planZ1.units.filter((u) => u.inRecentFloor).length, 3, "floor = the last recent turn (user + assistant + fresh pair)");
	assert.ok(!fp.some((a) => a.unitId === floorPairId && a.kind === "drop"), "floor copy is never dropped (reduce-only bypass)");
	assert.ok(fp.some((a) => a.unitId === floorPairId && a.kind === "reduce"), "floor copy IS reduced (tool-garbage bypass)");
});

test("planner degrades to a no-op plan on internal errors (§130 — never throws)", () => {
	const { session, prices, now } = standardScenario();
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: (seq) => { if (seq === session.nodes[1]) throw new Error("boom"); return session.eventAt(seq); },
		prices, now, query: "q", memory: null,
		contextWindow: 192000, inputTokens: 30000
	});
	assert.equal(plan.degraded, true);
	assert.equal(plan.decision.action, "none");
	assert.match(plan.decision.reason, /degraded/);
	assert.equal(plan.unitCount, 0);
	// the contract: a caller can safely treat any plan shape as "no crash"
	assert.equal(plan.schema, "vacgc-plan-v1");
	assert.deepEqual(plan.decision.escalation, ESCALATION_LADDER, "degraded decision keeps the §131 ladder shape");
});

test("§131: every decision carries the emergency escalation ladder; Z5 documents it in the reason (P0 never deleted)", () => {
	// the ladder IS the §131 order: tool prune → TRASH → COLD → WARM → P1+Memory → reduce output
	assert.deepEqual([...ESCALATION_LADDER], ["tool-prune", "trash-prune", "cold-compact", "warm-compact", "p1-memory", "reduce-output"]);
	// Z0: the constant is present (stable plan shape), but no emergency note
	const z0 = planScenario();
	assert.deepEqual(z0.plan.decision.escalation, ESCALATION_LADDER, "Z0 decision carries the ladder");
	assert.ok(!z0.plan.decision.reason.includes("EMERGENCY"), "no emergency note below overflow");
	// Z5: true overflow (soft ≥ emergency) — the reason documents the ladder + the P0 invariant
	const { session, prices, now } = standardScenario();
	const plan = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "继续修复影子规划器的压力区间", memory: null,
		contextWindow: W_SMALL, inputTokens: 7500, expectedOutput: 800
	});
	assert.equal(plan.degraded, false);
	assert.equal(plan.pressure.zone, "Z5", `true overflow expected (soft ${plan.pressure.soft})`);
	assert.deepEqual(plan.decision.escalation, ESCALATION_LADDER);
	assert.match(plan.decision.reason, /§131 EMERGENCY/);
	assert.match(plan.decision.reason, /P0 is never deleted/);
});

test("config resolution: partials merge over defaults, never the other way (DEC contract)", () => {
	const cfg = resolveVacGcConfig({ mode: "shadow", scoring: { reconstructibilityPenalty: 0.1 } });
	assert.equal(cfg.mode, "shadow");
	assert.equal(cfg.scoring.reconstructibilityPenalty, 0.1);
	assert.equal(cfg.scoring.duplicationPenalty, 0.18, "unspecified keys keep defaults");
	assert.equal(cfg.pressure.softGc, VACGC_DEFAULTS.pressure.softGc);
	assert.equal(resolveVacGcConfig(undefined).mode, "shadow");
	assert.equal(resolveVacGcConfig(null).mode, "shadow");
});

test("buildQueryTerms merges the last user message and active memory (§16–19)", () => {
	const memory = fakeMemory({ activeIds: ["DEC-005"], stateText: "C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js planVacGc" });
	const cfg = resolveVacGcConfig({ memory: { enabled: true } });
	const q = buildQueryTerms("修复 planVacGc 的压力区间 [DEC-004]", memory, cfg);
	assert.ok(q.ids.has("dec-004"), "query ids");
	assert.ok(q.ids.has("dec-005"), "active memory ids");
	assert.ok(q.symbols.has("planvacgc"), "query symbols");
	assert.ok([...q.paths].some((p) => p.includes("lib\\vacgc\\index.js")), "STATE-CURRENT paths");
	assert.ok(q.keywords.size > 0);
	// memory disabled → only the user message counts
	const q2 = buildQueryTerms("planVacGc", memory, resolveVacGcConfig({ memory: { enabled: false } }));
	assert.ok(!q2.ids.has("dec-005"));
	assert.ok(q2.symbols.has("planvacgc"));
});

test("relevance lifts the matching unit (no embedding — lexical lanes only)", () => {
	const now = T0 + 60 * 60000;
	const events = [
		userMsg("请检查 lib/vacgc/index.js 里的 planVacGc 函数"),
		assistantMsg("好的，我看一下 planVacGc。"),
		...toolPair("", [{ name: "read", arguments: "C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js" }], ["export function planVacGc(input) {"] )
	];
	const session = makeSession(events);
	const prices = pricesFor(session, 100);
	const memory = fakeMemory({ statePaths: ["C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js"], stateText: "lib/vacgc/index.js" });
	const plan = planVacGc({
		nodes: session.nodes, eventAt: session.eventAt, prices, now,
		query: "planVacGc 的压力区间", memory,
		contextWindow: 192000, inputTokens: 30000
	});
	const readRow = plan.units.find((u) => u.kind === "tool-pair");
	assert.ok(readRow.features.taskRelevance >= 0.4, `path lane must lift relevance (got ${readRow.features.taskRelevance})`);
	assert.ok(readRow.features.dependency >= 0.25, `STATE path dependency (got ${readRow.features.dependency})`);
});

test("scale (§132): 400-unit surface (maxUnitsInPlan) through the FULL planner — O(surface units), bounded time", () => {
	const H = 3600000;
	const now = T0 + 48 * H;
	const events = [];
	// 380 stale noise pairs (the bulk of the surface) + 20 recent pairs.
	for (let i = 0; i < 380; i += 1) {
		events.push(...toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/noise-${i}` }], [`noise file ${i}.txt`], { time: T0 + i * 3600000 / 380 }));
	}
	for (let i = 0; i < 20; i += 1) {
		events.push(...toolPair("", [{ name: "pwsh", arguments: `echo ok ${i}` }], [`ok ${i}`], { time: now - (20 - i) * 60000 }));
	}
	const session = makeSession(events);
	const prices = pricesFor(session, 500);
	const startedAt = Date.now();
	const plan = planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices,
		now,
		query: "继续修复影子规划器的压力区间",
		memory: null,
		contextWindow: 192000,
		inputTokens: prices.reduce((s, p) => s + p.tokens, 0),
		sessionId: "scale-400"
	});
	const elapsed = Date.now() - startedAt;
	assert.equal(plan.degraded, false, `planner must handle a full-size surface (${plan.decision?.reason})`);
	assert.equal(plan.unitCount, 400, "all surface units are planned");
	assert.equal(plan.units.length, 400);
	assert.equal(plan.freshPrune.stats.scanned, 400, "the dry-run scans the whole surface too");
	const tierTotal = Object.values(plan.tiers).reduce((s, t) => s + t.count, 0);
	assert.equal(tierTotal, 400, "tier census covers every unit exactly once");
	assert.ok(elapsed < 10000, `full planner stayed O(surface units) — took ${elapsed}ms for 400 units`);
});
