/**
 * VAC-GC summary contract (plan §63–§70) — the pure, deterministic half:
 * exact-fact extraction (§65/§66), coverage verification (§67), the retry
 * state machine (§68), and the emergency persistent-details pointer (§69).
 *
 * Phase-1 status: the LLM summary generator and the executing compactor are
 * Phase 3 (STEPS 9–12, gated by [DEC-002]); these tests pin the CONTRACT the
 * executor must satisfy and are fully runnable now (no LLM, no mutation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractExactFacts } from "../../lib/vacgc/text.js";
import {
	criticalFactsBefore,
	verifySummaryCoverage,
	retryDecision,
	persistentDetailsPointer,
	P0_COVERAGE_REQUIRED,
	P1_COVERAGE_REQUIRED
} from "../../lib/vacgc/coverage.js";

test("§65: exact facts are extracted verbatim — numbers with units are never rewritten", () => {
	const text = "Benchmark: p95 latency 12.5 ms, throughput 52.31 tok/s, 2048 tokens cached.";
	const facts = extractExactFacts(text);
	assert.ok(facts.has("12.5 ms"), "latency fact verbatim");
	assert.ok(facts.has("52.31 tok/s"), "throughput fact verbatim (the plan's own §65 example)");
	assert.ok(facts.has("2048 tokens"), "token count verbatim");
});

test("§65/§67: a summary that REWRITES a number is rejected (no 约 52 tok/s)", () => {
	const fact = "52.31 tok/s";
	const good = verifySummaryCoverage({ p0Facts: [fact], summaryText: `Measured ${fact}.` });
	assert.equal(good.pass, true, "verbatim in summary → pass");
	const rewritten = verifySummaryCoverage({ p0Facts: [fact], summaryText: "约 52 tok/s, fast." });
	assert.equal(rewritten.pass, false, "rewritten number → reject");
	assert.deepEqual(rewritten.missingFacts, [fact], "retry payload names the exact missing fact");
});

test("§66: every deterministic lane extracts its fact verbatim", () => {
	const text = [
		"Windows path C:\\Users\\xiemo\\md-memory\\lib",
		"unix path /tmp/vacgc/out.json and relative ../src/index.js",
		"url https://example.com/v1/compact?x=1",
		"version v2.1.0 and 1.2.3-beta.1",
		"hash 9f86d081884c7d659a2feaa0c55ad015",
		"error ECONNRESET then SCREAMING_SNAKE, status 404, port :30000, ip 192.168.0.109",
		"ledger DEC-001 REQ-002 BENCH-010",
		"run `node --test test/vacgc` and expect exit code 1"
	].join("\n");
	const facts = extractExactFacts(text);
	for (const expected of [
		"C:\\Users\\xiemo\\md-memory\\lib",
		"/tmp/vacgc/out.json",
		"../src/index.js",
		"https://example.com/v1/compact?x=1",
		"v2.1.0",
		"1.2.3-beta.1",
		"9f86d081884c7d659a2feaa0c55ad015",
		"ECONNRESET",
		"SCREAMING_SNAKE",
		"404",
		":30000",
		"192.168.0.109",
		"DEC-001",
		"REQ-002",
		"BENCH-010",
		"node --test test/vacgc",
		"exit code 1"
	]) {
		assert.ok(facts.has(expected), `lane fact present: ${expected}`);
	}
	assert.equal([...extractExactFacts("")].length, 0, "empty text → no facts");
});

test("§67: P0 must be 100% covered; P1 exact coverage >= 99% (boundary inclusive)", () => {
	assert.equal(P0_COVERAGE_REQUIRED, 1.0);
	assert.equal(P1_COVERAGE_REQUIRED, 0.99);

	// P0: any single loss → reject
	const p0ok = verifySummaryCoverage({ p0Facts: ["REQ-001", "DEC-001"], summaryText: "kept REQ-001 and DEC-001" });
	assert.equal(p0ok.pass, true);
	assert.equal(p0ok.p0.coverage, 1);
	const p0miss = verifySummaryCoverage({ p0Facts: ["REQ-001", "DEC-001"], summaryText: "kept REQ-001" });
	assert.equal(p0miss.pass, false, "P0 at 50% → reject");
	assert.equal(p0miss.p0.coverage, 0.5);
	assert.deepEqual(p0miss.missingFacts, ["DEC-001"]);

	// P1 boundary: 99/100 = exactly the threshold → pass; 98/100 → fail.
	// fixed-width names avoid substring false-positives (P1F007 ⊄ P1F070)
	const p1Facts = Array.from({ length: 100 }, (_, i) => `P1F${String(i).padStart(3, "0")}`);
	const atThreshold = verifySummaryCoverage({ p1Facts, summaryText: p1Facts.filter((f) => f !== "P1F007").join(" ") });
	assert.equal(atThreshold.p1.coverage, 0.99);
	assert.equal(atThreshold.pass, true, "exactly 99% passes (>=, not >)");
	const below = verifySummaryCoverage({ p1Facts, summaryText: p1Facts.filter((f) => f !== "P1F007" && f !== "P1F008").join(" ") });
	assert.equal(below.p1.coverage, 0.98);
	assert.equal(below.pass, false, "98% fails");
	assert.deepEqual(below.missingFacts, ["P1F007", "P1F008"], "missingFacts = the retry payload");

	// empty fact set → vacuous pass (nothing critical in the segment)
	assert.equal(verifySummaryCoverage({ summaryText: "" }).pass, true);
});

test("§67: a fact persisted to Memory counts as covered (summary + Memory comparison)", () => {
	const fact = "BENCH-010";
	const dropped = verifySummaryCoverage({ p1Facts: [fact], summaryText: "Segment compressed.", memoryText: "" });
	assert.equal(dropped.pass, false, "neither summary nor memory has it → reject");
	const rescued = verifySummaryCoverage({
		p1Facts: [fact],
		summaryText: "Segment compressed.",
		memoryText: `TECH note: ${fact} throughput verified.`
	});
	assert.equal(rescued.pass, true, "absent from summary but present in Memory → covered");
	assert.equal(rescued.p1.coverage, 1);
	assert.equal(rescued.missingFacts.length, 0);
});

test("§66/§67: criticalFactsBefore splits raw unit text by protection level", () => {
	const { p0Facts, p1Facts } = criticalFactsBefore([
		{ protection: "P0", text: "必须保留 REQ-001 迁移脚本。" },
		{ protection: "P0_TRANSIENT", text: "open tool call editing C:\\x\\y.js in flight" },
		{ protection: "P1", text: "decision DEC-002: keep the 12.5 ms budget" },
		{ protection: "NORMAL", text: "noisy log 99999 tokens will be dropped" }
	]);
	assert.ok(p0Facts.includes("REQ-001"), "P0 fact extracted from zh text");
	assert.ok(p0Facts.includes("C:\\x\\y.js"), "P0_TRANSIENT fact extracted");
	assert.equal(p0Facts.length, 2, "exactly the two P0-side facts");
	assert.ok(p1Facts.includes("DEC-002"), "P1 fact: ledger ID");
	assert.ok(p1Facts.includes("12.5 ms"), "P1 fact: number + unit");
	// "12.5" is a version-lane byproduct (a substring of "12.5 ms" — always
	// co-covered in a verbatim check, so harmless)
	assert.deepEqual([...p1Facts].sort(), ["12.5", "12.5 ms", "DEC-002"].sort(), "exactly the P1-side facts");
	assert.ok(!p0Facts.includes("99999 tokens") && !p1Facts.includes("99999 tokens"), "NORMAL-unit facts are not critical");
	assert.deepEqual(criticalFactsBefore([]), { p0Facts: [], p1Facts: [] }, "empty input → empty");
});

test("§68: retry → shrink-region → cancel; an emergency ends in persist, never cancel", () => {
	assert.equal(retryDecision(0), "generate");
	assert.equal(retryDecision(1), "retry", "first FAIL → regenerate with missingFacts[]");
	assert.equal(retryDecision(2), "shrink-region", "second FAIL → shrink the compact region");
	assert.equal(retryDecision(3), "cancel", "still failing → cancel the compaction");
	assert.equal(retryDecision(3, { isEmergency: true }), "persist", "emergency: persist facts to memory instead of cancel");
	assert.equal(retryDecision(9, { isEmergency: true }), "persist", "emergency overrides at any depth");
});

test("§69: persistentDetailsPointer uses the plan's exact format", () => {
	assert.equal(
		persistentDetailsPointer(["REQ-018", "DEC-021", "BENCH-031"]),
		"Persistent details:\nREQ-018\nDEC-021\nBENCH-031"
	);
	assert.equal(persistentDetailsPointer([]), "", "nothing to persist → empty");
	assert.equal(persistentDetailsPointer(["A-1", "", null, "A-1"]), "Persistent details:\nA-1", "dedup + non-string/empty filtered");
});
