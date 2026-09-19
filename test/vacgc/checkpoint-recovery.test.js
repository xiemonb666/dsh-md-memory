/**
 * VAC-GC checkpoint recovery (plan §69/§70) — the shadow-side contract.
 *
 * §70: compacting an OLD compaction checkpoint is the "summary of summary"
 * information-loss sink. Phase-1 (shadow) contract:
 *   (a) RECOGNIZE — the planner tags the unit kind "checkpoint" with P1
 *       provenance, at any age;
 *   (b) NEVER SILENTLY DROP — at Z5 a planned segment containing the
 *       checkpoint must carry requiresMemorySync (the executor syncs the
 *       facts to Memory before compacting); at Z2 the P1 checkpoint is
 *       zone-ineligible and splits the candidate run around it;
 *   (c) RECOVERABLE — the checkpoint's exact facts are deterministic
 *       (extractExactFacts), so the Phase 3 executor can verify a
 *       re-emission with verifySummaryCoverage: a degraded summary-of-
 *       summary that drops facts FAILS and names the missing facts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { T0, resetSeqs, userMsg, toolPair, checkpointMsg, makeSession, pricesFor } from "./helpers.js";
import { planVacGc } from "../../lib/vacgc/index.js";
import { extractExactFacts } from "../../lib/vacgc/text.js";
import { criticalFactsBefore, verifySummaryCoverage, persistentDetailsPointer } from "../../lib/vacgc/coverage.js";

const H = 3600000;
const MIN = 60000;
const W = 8192;

// The checkpoint's text carries two exact facts — one ledger ID, one
// §65-form number+unit (the plan's own example shape).
const CP_TEXT = "Compaction checkpoint — DEC-001 migration completed, 52.31 tok/s verified.";

function noisePair(i, time) {
	return toolPair("", [{ name: "pwsh", arguments: `ls -la /tmp/cp-${i}` }], [`cp file ${i}.txt`], { time });
}

function runPlan(events, opts) {
	const session = makeSession(events);
	return planVacGc({
		nodes: session.nodes,
		eventAt: session.eventAt,
		prices: pricesFor(session, 500),
		now: opts.now,
		query: opts.query ?? null,
		contextWindow: W,
		inputTokens: opts.inputTokens,
		sessionId: opts.sessionId
	});
}

/** 8 old pairs → checkpoint (10h mark, provenance on the first two pairs) →
 * 10 more old pairs → 4 fresh pairs (recent floor). */
function buildFixture() {
	resetSeqs();
	const events = [];
	for (let i = 0; i < 8; i += 1) events.push(...noisePair(i, T0 + i * H));
	const cp = checkpointMsg(CP_TEXT, events.slice(0, 2).map((e) => e.seq), { time: T0 + 10 * H });
	events.push(cp);
	for (let i = 0; i < 10; i += 1) events.push(...noisePair(30 + i, T0 + (11 + i) * H));
	for (let i = 0; i < 4; i += 1) events.push(...noisePair(50 + i, T0 + 48 * H + i * 10 * MIN));
	return { events, cp };
}

test("§70: an old checkpoint is RECOGNIZED — kind, P1 provenance, age-proof tier", () => {
	const { events, cp } = buildFixture();
	const now = T0 + 49 * H;
	const plan = runPlan(events, { now, inputTokens: 3000, sessionId: "cp-70a" });

	const unit = plan.units.find((u) => u.firstSeq === cp.seq);
	assert.ok(unit, "the checkpoint message is a unit");
	assert.equal(unit.kind, "checkpoint", "recognized as a compaction checkpoint");
	assert.equal(unit.protection, "P1");
	assert.ok(unit.protectionReasons.some((r) => /checkpoint/i.test(r)), `P1 provenance names the checkpoint (${unit.protectionReasons.join("; ")})`);
	assert.ok(unit.score >= 0.75, `P1 floor held (score ${unit.score})`);
	assert.ok(["HOT", "WARM"].includes(unit.tier), `checkpoint tier not demoted by age (${unit.tier})`);

	// Z2: P1 units are zone-ineligible — the surrounding old noise IS
	// compacted, but the run is split AROUND the checkpoint, never through it
	assert.equal(plan.pressure.zone, "Z2");
	assert.equal(plan.decision.action, "compact", "the old noise is reclaimed at Z2");
	assert.ok(plan.selected, "a segment was planned");
	assert.ok(!plan.selected.unitIds.includes(unit.unitId), "P1 checkpoint ∉ planned segment at Z2");
});

test("§70: at Z5 (emergency) a segment containing the checkpoint demands Memory Sync", () => {
	const { events, cp } = buildFixture();
	const now = T0 + 49 * H;
	const plan = runPlan(events, { now, inputTokens: 7200, sessionId: "cp-70b" });
	assert.equal(plan.pressure.zone, "Z5");
	assert.equal(plan.decision.action, "compact", "the emergency ladder reclaims the old noise");

	const unit = plan.units.find((u) => u.firstSeq === cp.seq);
	assert.equal(unit.protection, "P1", "still P1 under emergency pressure");
	const selected = plan.selected;
	assert.ok(selected, "a segment is planned at Z5");
	assert.ok(selected.unitIds.includes(unit.unitId), "the old P1 checkpoint sits inside the reclaimable run at Z5");
	assert.equal(selected.requiresMemorySync, true, "no silent summary-of-summary: a P1-bearing segment MUST sync Memory first (§70 guard)");
});

test("§70: the checkpoint's exact facts are recoverable — coverage check catches summary-of-summary loss", () => {
	const facts = [...extractExactFacts(CP_TEXT)];
	assert.ok(facts.includes("DEC-001"), "ledger ID fact");
	assert.ok(facts.includes("52.31 tok/s"), "benchmark fact in the §65 number+unit form");

	// a re-emission that keeps the facts passes coverage verification…
	const good = verifySummaryCoverage({ p1Facts: facts, summaryText: `Checkpoint restored: ${CP_TEXT}` });
	assert.equal(good.pass, true, "full re-emission covers every fact");

	// …while a degraded summary-of-summary that drops them fails and names them
	const bad = verifySummaryCoverage({ p1Facts: facts, summaryText: "Old checkpoint summarized." });
	assert.equal(bad.pass, false, "summary-of-summary without the facts is rejected");
	assert.ok(bad.missingFacts.includes("DEC-001") && bad.missingFacts.includes("52.31 tok/s"), `missing facts named (${bad.missingFacts.join(", ")})`);
});

test("§69: emergency persist — critical facts are collected and pointer-carried, never silently dropped", () => {
	const units = [
		{ protection: "P0", text: "禁止删除 REQ-018 备份。服务监听 192.168.0.109:30000。" },
		{ protection: "P1", text: "决定 DEC-021：吞吐 52.31 tok/s。" }
	];
	const { p0Facts, p1Facts } = criticalFactsBefore(units);
	assert.ok(p0Facts.includes("REQ-018"), "P0 fact collected from zh text");
	assert.ok(p0Facts.includes("192.168.0.109") && p0Facts.includes(":30000"), "endpoint facts collected (ip + port lanes)");
	assert.ok(p1Facts.includes("DEC-021") && p1Facts.includes("52.31 tok/s"), "P1 facts collected");

	// the emergency executor: P0 facts → Memory, pointer → summary
	const pointer = persistentDetailsPointer(p0Facts);
	assert.ok(pointer.startsWith("Persistent details:\n"), "exact §69 header");
	for (const f of p0Facts) assert.ok(pointer.includes(f), `pointer carries ${f} verbatim`);

	// coverage against summary + memory now passes — nothing was lost
	const res = verifySummaryCoverage({
		p0Facts,
		p1Facts,
		summaryText: `Emergency compaction.\n${pointer}`,
		memoryText: p1Facts.join("\n")
	});
	assert.equal(res.pass, true, "P0 pointer in summary + P1 facts in memory → coverage passes");
	assert.equal(res.missingFacts.length, 0);
});
