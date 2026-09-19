/**
 * VAC-GC compaction executor (plan §63–§72) — orchestration tests with FAKE
 * dependencies.
 *
 * The executor is pure: generateSummary (the LLM) and persistToMemory (the
 * ledger write) are injected, so the full §68 retry loop, the §69 emergency
 * persist, and the §70/§71 checkpoint-recovery flow are all deterministic and
 * runnable NOW, in Phase 1, with no LLM and no mutation. The real wiring
 * (host session → unit views, real generator, real ledger) is STEPS 9–12,
 * gated by [DEC-002].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { T0, resetSeqs, userMsg, checkpointMsg } from "./helpers.js";
import { runCompaction, shrinkRegion, collectRegionFacts, isCheckpointUnit, SUMMARY_TEMPLATE } from "../../lib/vacgc/executor.js";

const H = 3600000;

/** unit view the executor consumes (raw text + protection + kind). */
const unit = (unitId, text, protection = "NORMAL", extra = {}) => ({ unitId, text, protection, kind: extra.kind ?? "assistant", sourceEventSeqs: extra.sourceEventSeqs ?? null, ...extra });

/** fake LLM: scripted responses by attempt, records every input. */
function fakeGenerate(script) {
	const calls = [];
	let i = 0;
	return {
		calls,
		fn: async (input) => {
			calls.push(input);
			const r = script[Math.min(i, script.length - 1)];
			i += 1;
			return typeof r === "function" ? r(input) : r;
		}
	};
}

/** fake ledger: records calls, returns stable refs + a text block echoing the facts. */
function fakePersist() {
	const calls = [];
	let n = 0;
	return {
		calls,
		fn: async (facts, meta) => {
			n += 1;
			calls.push({ facts: [...facts], meta, text: `PERSISTED-${n}:\n${facts.join("\n")}` });
			return { refs: facts.map((f) => `MEM:${f}`), text: `PERSISTED-${n}:\n${facts.join("\n")}` };
		}
	};
}

test("§63–§67: happy path — structured input, verbatim facts, one generation", async () => {
	const gen = fakeGenerate(["Summary keeps DEC-002 and the 12.5 ms budget."]);
	const mem = fakePersist();
	const res = await runCompaction({
		units: [
			unit("u1", "decision DEC-002: keep the 12.5 ms budget", "P1"),
			unit("u2", "noisy tool output 88888 lines", "NORMAL")
		],
		generateSummary: gen.fn,
		persistToMemory: mem.fn
	});
	assert.equal(res.status, "applied");
	assert.equal(res.attempts, 1);
	assert.equal(res.summary, "Summary keeps DEC-002 and the 12.5 ms budget.");
	assert.equal(res.missingFacts.length, 0);
	// structured generator input (§63): template + raw segment + verbatim facts
	assert.equal(gen.calls[0].template, SUMMARY_TEMPLATE, "generator receives the §64 template");
	assert.ok(gen.calls[0].segmentText.includes("DEC-002") && gen.calls[0].segmentText.includes("88888"), "raw segment text of BOTH units");
	assert.ok(gen.calls[0].exactFacts.p1.includes("DEC-002"), "P1 exact facts handed to the generator");
	assert.ok(!gen.calls[0].exactFacts.p1.includes("88888 lines") && !gen.calls[0].exactFacts.p0.includes("88888 lines"), "NORMAL-unit facts are not critical");
	// no checkpoint in the region → no pre-compaction Memory sync
	assert.equal(mem.calls.length, 0, "no sync needed for a checkpoint-free region");
	// event stream (§101 inspector feed)
	assert.deepEqual(res.events.map((e) => e.type), ["generated", "verified", "applied"]);
	assert.equal(res.events[1].pass, true);
});

test("§68: 1st FAIL → retry with missingFacts[]; 2nd generation passes", async () => {
	const gen = fakeGenerate([
		"Attempt 1 dropped the fact.",
		(input) => `Attempt 2: DEC-002 kept, ${input.missingFacts[0]} restored verbatim.`
	]);
	const res = await runCompaction({
		units: [unit("u1", "decision DEC-002 is final", "P1")],
		generateSummary: gen.fn
	});
	assert.equal(res.status, "applied");
	assert.equal(res.attempts, 2, "exactly one retry");
	// the retry input carries the §68 payload
	assert.deepEqual(gen.calls[0].missingFacts, []);
	assert.deepEqual(gen.calls[1].missingFacts, ["DEC-002"], "retry generated WITH missingFacts[]");
	assert.equal(gen.calls[1].attempt, 2);
	assert.deepEqual(
		res.events.filter((e) => e.type === "verified").map((e) => e.pass),
		[false, true]
	);
	assert.equal(res.events.find((e) => e.type === "retry").missingFacts[0], "DEC-002");
});

test("§68: 2nd FAIL → shrink the region (oldest dropped); 3rd generation on the smaller region passes", async () => {
	const gen = fakeGenerate([
		() => "fail 1",
		() => "fail 2",
		(input) => `ok: TASK-02 TASK-03 TASK-04 in ${input.segmentText}`
	]);
	const res = await runCompaction({
		units: [
			unit("u1", "task TASK-01 done", "P1"),
			unit("u2", "task TASK-02 done", "P1"),
			unit("u3", "task TASK-03 done", "P1"),
			unit("u4", "task TASK-04 done", "P1")
		],
		generateSummary: gen.fn
	});
	assert.equal(res.status, "applied");
	assert.equal(res.attempts, 3, "gen1 FAIL → retry → gen2 FAIL → shrink → gen3");
	assert.deepEqual(res.region.dropped, ["u1"], "the OLDEST unit is dropped first");
	assert.deepEqual(res.region.unitIds, ["u2", "u3", "u4"]);
	// facts are re-collected for the shrunken region: TASK-01 is no longer required
	assert.ok(!gen.calls[2].exactFacts.p1.includes("TASK-01"), "dropped unit's facts exit the contract");
	assert.ok(gen.calls[2].exactFacts.p1.includes("TASK-02") && gen.calls[2].exactFacts.p1.includes("TASK-04"));
	assert.ok(!gen.calls[2].segmentText.includes("task TASK-01 done"), "shrunken segment text excludes u1");
	const shrink = res.events.find((e) => e.type === "shrink");
	assert.deepEqual([shrink.before, shrink.after], [4, 3]);
});

test("§68: still failing after shrink → cancel (no emergency): 3 generations, nothing applied", async () => {
	const gen = fakeGenerate([() => "always drop the tasks"]);
	const res = await runCompaction({
		units: [
			unit("u1", "task TASK-11 done", "P1"),
			unit("u2", "task TASK-12 done", "P1"),
			unit("u3", "task TASK-13 done", "P1"),
			unit("u4", "task TASK-14 done", "P1")
		],
		generateSummary: gen.fn
	});
	assert.equal(res.status, "cancelled");
	assert.equal(res.summary, null, "cancelled → NO summary replaces the raw segment");
	assert.equal(res.attempts, 3);
	assert.equal(gen.calls.length, 3);
	assert.deepEqual(res.region.dropped, ["u1"], "shrink still happened at attempt 2");
	const cancel = res.events.find((e) => e.type === "cancelled");
	assert.ok(/§68/.test(cancel.reason), "cancel names the policy");
});

test("§68: a region that cannot shrink (2 units) goes straight to the terminal decision", async () => {
	const gen = fakeGenerate([() => "drop everything"]);
	const res = await runCompaction({
		units: [unit("u1", "block BLOCK-01 open", "P1"), unit("u2", "block BLOCK-02 open", "P1")],
		generateSummary: gen.fn
	});
	assert.equal(res.status, "cancelled");
	assert.equal(res.attempts, 2, "gen1 FAIL → retry → gen2 FAIL → cannot shrink → cancel");
	assert.equal(gen.calls.length, 2, "no 3rd generation against an unshrinkable region");
	assert.deepEqual(res.region.dropped, []);
});

test("§69: emergency — 3 failures end in persist: facts to Memory FIRST, pointer in summary, status degraded", async () => {
	const gen = fakeGenerate([() => "drop everything"]);
	const mem = fakePersist();
	const res = await runCompaction({
		units: [
			unit("u1", "禁止删除 REQ-018 备份。", "P0"),
			unit("u2", "决定 DEC-021 记录 52.31 tok/s。", "P1"),
			unit("u3", "task TASK-21 done", "P1"),
			unit("u4", "task TASK-22 done", "P1")
		],
		generateSummary: gen.fn,
		persistToMemory: mem.fn,
		isEmergency: true
	});
	assert.equal(res.status, "degraded", "emergency: compaction proceeds, facts live in Memory");
	assert.equal(res.attempts, 3);
	assert.equal(res.summary.startsWith("drop everything"), true, "last generated summary is the base");
	assert.ok(res.summary.includes("Persistent details:\n"), "§69 pointer line present");
	// the shrink at attempt 2 dropped the OLDEST unit — u1 (the P0) — so u1
	// stays in context RAW: REQ-018 survives by NOT being compacted, and the
	// pointer covers exactly the (re-collected) facts of the remaining region
	assert.ok(!res.region.unitIds.includes("u1"), "u1 dropped by shrink → never compacted");
	assert.ok(res.summary.includes("52.31 tok/s") && res.summary.includes("DEC-021") && res.summary.includes("TASK-22"), "pointer carries the remaining region's facts verbatim");
	assert.ok(!res.summary.includes("REQ-018"), "REQ-018 not in the pointer — its unit was never compacted");
	// the persist happened AFTER all three failures, with the shrunken region's facts
	assert.equal(mem.calls.length, 1, "exactly one persist (no pre-sync: no checkpoint in region)");
	assert.equal(mem.calls[0].meta.reason, "emergency persist (§69)");
	assert.ok(mem.calls[0].facts.includes("DEC-021") && mem.calls[0].facts.includes("52.31 tok/s"));
	assert.ok(!mem.calls[0].facts.includes("REQ-018"), "persist scoped to the compacted region");
	assert.ok(res.memoryRefs.length > 0, "memory refs recorded for the inspector");
	assert.ok(res.events.some((e) => e.type === "persist") && res.events.some((e) => e.type === "degraded"));
	// §67 contract still held on the final surface: summary + Memory covers the region's facts
	const surface = `${res.summary}\n${mem.calls[0].text}`;
	for (const f of ["DEC-021", "52.31 tok/s", "TASK-21", "TASK-22"]) assert.ok(surface.includes(f), `fact ${f} survives on summary+Memory`);
});

test("§70/§71: checkpoint region — originals are deep-recovered BEFORE generation, synced to Memory; summary may rely on Memory IDs", async () => {
	resetSeqs();
	const orig1 = userMsg("original: DEC-001 migration at 99.9 ms done.", { time: T0 });
	const orig2 = userMsg("original: wrote 3 files.", { time: T0 + H });
	const cp = checkpointMsg("checkpoint: DEC-001 recorded.", [orig1.seq, orig2.seq], { time: T0 + 10 * H });
	const eventAt = (seq) => ([orig1, orig2, cp].find((e) => e.seq === seq) ?? null);

	const gen = fakeGenerate([
		// the summary keeps only the memory ID — the 99.9 ms fact lives in Memory
		"Summary: checkpoint DEC-001 compacted; details persisted."
	]);
	const mem = fakePersist();
	const res = await runCompaction({
		units: [unit("cp", "checkpoint: DEC-001 recorded.", "P1", { kind: "checkpoint", sourceEventSeqs: [orig1.seq, orig2.seq], seq: cp.seq })],
		eventAt,
		generateSummary: gen.fn,
		persistToMemory: mem.fn
	});
	assert.equal(res.status, "applied", "summary passes coverage via the synced Memory block");
	assert.equal(res.attempts, 1, "no retry needed: depth ≈ 1 — facts were recovered from originals");
	// §71 flow: lookup compaction metadata → shadowedSeqs → critical fact recovery → Memory Sync
	assert.equal(mem.calls.length, 1, "pre-compaction Memory sync fired (region contains a checkpoint)");
	assert.equal(mem.calls[0].meta.reason, "pre-compaction checkpoint sync (§70/§71)");
	assert.ok(mem.calls[0].facts.includes("DEC-001"), "checkpoint's own fact synced");
	assert.ok(mem.calls[0].facts.includes("99.9 ms"), "fact recovered from the ORIGINAL shadowed event (depth ≈ 1)");
	assert.ok(mem.calls[0].facts.includes("3 files"), "second original's fact recovered");
	const sync = res.events.find((e) => e.type === "memory-sync");
	assert.ok(sync.facts >= 3);
	assert.ok(res.events.findIndex((e) => e.type === "memory-sync") < res.events.findIndex((e) => e.type === "generated"), "sync BEFORE generation (§71 order)");
	// the generator was told where the facts live
	assert.ok(gen.calls[0].memoryRefs.length > 0, "memoryRefs handed to the generator");
});

test("§71/§72: when the shadowed originals are GONE, recovery falls back to the checkpoint text (no crash, no false sync)", async () => {
	const gen = fakeGenerate(["Summary: DEC-009 kept."]);
	const mem = fakePersist();
	const res = await runCompaction({
		units: [unit("cp", "checkpoint: DEC-009.", "P1", { kind: "checkpoint", sourceEventSeqs: [999] })],
		eventAt: () => null, // session log no longer holds the originals
		generateSummary: gen.fn,
		persistToMemory: mem.fn
	});
	assert.equal(res.status, "applied");
	assert.equal(mem.calls.length, 1, "still synced — facts from the checkpoint text itself");
	assert.ok(mem.calls[0].facts.includes("DEC-009"));
});

test("collectRegionFacts + isCheckpointUnit: classification and recovery accounting", () => {
	assert.equal(isCheckpointUnit({ kind: "checkpoint" }), true);
	assert.equal(isCheckpointUnit({ kind: "assistant", sourceEventSeqs: [1] }), true, "provenance sourceEventSeqs also marks a checkpoint");
	assert.equal(isCheckpointUnit({ kind: "assistant" }), false);
	assert.equal(isCheckpointUnit(null), false);

	const orig = { type: "user/message", data: { role: "user", content: [{ type: "text", text: "orig fact TASK-99 done" }] } };
	const out = collectRegionFacts(
		[
			unit("a", "plain note", "NORMAL"),
			unit("b", "checkpoint: DEC-001.", "P1", { kind: "checkpoint", sourceEventSeqs: [7] }),
			unit("c", "必须保留 REQ-001。", "P0")
		],
		(seq) => (seq === 7 ? orig : null)
	);
	assert.deepEqual(out.p0Facts, ["REQ-001"], "P0 fact class");
	assert.deepEqual(out.p1Facts, ["DEC-001", "TASK-99"], "P1 = own ∪ recovered from originals (sorted)");
	assert.equal(out.hasCheckpoint, true);
	assert.equal(out.recovered.get("b"), 1, "recovery count attributed to the checkpoint unit");
	assert.equal(out.recovered.has("a"), false);
});

test("shrinkRegion: deterministic, oldest-first, keeps the most recent 75%", () => {
	assert.deepEqual(shrinkRegion(["a", "b", "c", "d"]), { unitIds: ["b", "c", "d"], dropped: ["a"], shrank: true });
	assert.deepEqual(shrinkRegion(["a", "b", "c"]), { unitIds: ["a", "b", "c"], dropped: [], shrank: false }, "3 units: ceil(2.25)=3 → nothing drops");
	assert.deepEqual(shrinkRegion(["a", "b"]), { unitIds: ["a", "b"], dropped: [], shrank: false }, "2 units: unshrinkable");
	assert.deepEqual(shrinkRegion(["a"]), { unitIds: ["a"], dropped: [], shrank: false });
	assert.deepEqual(shrinkRegion([]), { unitIds: [], dropped: [], shrank: false });
	assert.deepEqual(shrinkRegion(["a", "b", "c", "d", "e", "f", "g", "h"]), { unitIds: ["c", "d", "e", "f", "g", "h"], dropped: ["a", "b"], shrank: true }, "8 → keep 6, drop the two oldest");
});

test("§130 fail-safe: memory sync failure → cancelled BEFORE any generation (surface unchanged)", async () => {
	resetSeqs();
	const orig = userMsg("original: DEC-030 budget 4.2 ms.", { time: T0 });
	const cp = checkpointMsg("checkpoint: DEC-030 recorded.", [orig.seq], { time: T0 + H });
	const gen = fakeGenerate(["should never be called"]);
	const mem = {
		calls: 0,
		fn: async () => {
			mem.calls += 1;
			throw new Error("ledger write timed out");
		}
	};
	const res = await runCompaction({
		units: [unit("cp", "checkpoint: DEC-030 recorded.", "P1", { kind: "checkpoint", sourceEventSeqs: [orig.seq], seq: cp.seq })],
		eventAt: (seq) => (seq === orig.seq ? orig : null),
		generateSummary: gen.fn,
		persistToMemory: mem.fn
	});
	assert.equal(res.status, "cancelled", "sync failed → 不 compact");
	assert.equal(res.summary, null, "no summary exists");
	assert.equal(res.attempts, 0, "cancelled before the first generation");
	assert.equal(mem.calls, 1, "the failing sync was attempted exactly once");
	assert.equal(gen.calls.length, 0, "the LLM was never invoked");
	assert.ok(res.events.some((e) => e.type === "memory-sync-failed"), "fail-safe event for the inspector");
	assert.match(res.reason, /memory sync failed/);
});

test("§130 fail-safe: generator crash → cancelled safe no-op, never an unhandled rejection", async () => {
	const gen = {
		calls: 0,
		fn: async () => {
			gen.calls += 1;
			throw new Error("provider 503");
		}
	};
	const res = await runCompaction({
		units: [unit("u1", "decision DEC-040 is final", "P1")],
		generateSummary: gen.fn
	});
	assert.equal(res.status, "cancelled");
	assert.equal(res.summary, null);
	assert.equal(gen.calls, 1, "the crash happened on the (single) generation attempt");
	assert.equal(res.attempts, 1);
	assert.deepEqual(res.missingFacts, [], "nothing was verified, nothing is missing on record");
	assert.ok(res.events.some((e) => e.type === "generation-failed"), "fail-safe event for the inspector");
	assert.match(res.reason, /generation failed/);
});
