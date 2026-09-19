/**
 * §133 — 避免每轮扫描全部 HISTORY.md.
 *
 * The relevance index is tiered: normal relevance reads the small standing
 * files (INDEX/STATE/…), while HISTORY.md (which grows on every sync) is
 * NEVER indexed — it stays available to memory_search / on-demand grep.
 * These tests pin that contract at both the constant level and the
 * behavior level (HISTORY.md changes must not invalidate the index).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLedgerIndex, INDEXED_LEDGER_FILES } from "../../lib/vacgc/memory-index.js";

function makeLedgerDir() {
	const dir = mkdtempSync(join(tmpdir(), "vacgc-ledger-"));
	writeFileSync(join(dir, "INDEX.md"), "# INDEX — Memory Router\n\n## Routing\n");
	writeFileSync(join(dir, "STATE.md"), "## [STATE-CURRENT] Current state\n- task: fix the pressure zone mapping\n- file: C:\\proj\\lib\\core.js\n");
	writeFileSync(join(dir, "HISTORY.md"), "- [2026-01-01T00:00:00Z] first line\n");
	return dir;
}

test("§133: HISTORY.md is excluded from the indexed files (HISTORY/STATE/INDEX tiering)", () => {
	assert.ok(!INDEXED_LEDGER_FILES.includes("HISTORY.md"), "HISTORY.md must never be part of the per-round index");
	for (const f of ["INDEX.md", "STATE.md"]) {
		assert.ok(INDEXED_LEDGER_FILES.includes(f), `${f} is a standing relevance source`);
	}
});

test("§133: changing ONLY HISTORY.md does not invalidate the index (no re-read of the standing files)", () => {
	const dir = makeLedgerDir();
	const cache = new Map();
	const index = getLedgerIndex(dir, cache);
	assert.ok(index, "ledger index available");
	assert.ok(index.entries.has("STATE-CURRENT"), "STATE-CURRENT parsed");
	assert.ok(index.stateText.includes("pressure zone"), "standing task text captured");

	const sigBefore = index.signature;
	const entriesBefore = index.entries.size;
	// Append to HISTORY.md only — mtime changes there, nowhere else.
	appendFileSync(join(dir, "HISTORY.md"), "- [2026-01-02T00:00:00Z] second line\n");
	const same = index.refreshIfStale();
	assert.equal(same, index, "cached instance reused");
	assert.equal(index.signature, sigBefore, "HISTORY.md mtime is NOT part of the staleness signature");
	assert.equal(index.entries.size, entriesBefore, "no re-parse happened");

	// Sanity of the gate itself: a STATE.md change (with a forced newer mtime
	// so the test is deterministic) MUST invalidate the signature.
	const statePath = join(dir, "STATE.md");
	utimesSync(statePath, Date.now() / 1000, (Date.now() + 60000) / 1000);
	appendFileSync(statePath, "\n## [STATE-EXTRA] Added later\n- new standing task line\n");
	index.refreshIfStale();
	assert.notEqual(index.signature, sigBefore, "a standing-file change does invalidate");
	assert.ok(index.entries.has("STATE-EXTRA"), "re-parse picked up the new entry");
});

test("§133: no-op refresh when nothing changed is stable (cheap per-round contract)", () => {
	const dir = makeLedgerDir();
	const cache = new Map();
	const index = getLedgerIndex(dir, cache);
	const first = index.refreshIfStale();
	assert.equal(first, index, "second refresh returns the same instance");
	assert.equal(index.available, true);
	assert.equal(cache.get(dir), index, "the directory-level cache holds the one instance");
	assert.equal(first.signature, index.signature, "signature unchanged across no-op refreshes");
});

// ---------------------------------------------------------------------------
// Provenance sidecar (review 2026-09-12, P0): .provenance.json maps
// session-local log seqs → the ledger entries EXTRACTED from them; the
// protection gate's activeSourceIds lane hard-protects those seqs while the
// entry is ACTIVE. The mtime of the sidecar participates in the staleness
// signature (a fresh sidecar must be picked up without touching the md files).
// ---------------------------------------------------------------------------
test("provenance: .provenance.json is parsed and feeds activeSourceIds (ACTIVE ids only)", () => {
	const dir = makeLedgerDir();
	writeFileSync(join(dir, "DECISIONS.md"), [
		"# DECISIONS",
		"",
		"## [DEC-001] Never enable MTP",
		"- status: ACTIVE",
		"- Decision: keep MTP off",
		"",
		"## [DEC-002] Old fact",
		"- status: SUPERSEDED",
		"- Replacement: DEC-001",
		""
	].join("\n"));
	// give the sidecar a FUTURE mtime so it alone moves the signature
	const sidecar = { sessions: { "s1": { "3": ["DEC-001", "DEC-002"], "9": ["DEC-001"] } } };
	const future = (Date.now() + 120000) / 1000;
	utimesSync(join(dir, "DECISIONS.md"), future, future);
	// write the sidecar, then force its mtime newest
	const p = join(dir, ".provenance.json");
	writeFileSync(p, JSON.stringify(sidecar, null, 2));
	utimesSync(p, future + 60, future + 60);
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index, "ledger index available");
	// DEC-002 is SUPERSEDED → filtered out; STATE-CURRENT never pins
	assert.deepEqual([...index.activeSourceIds("s1", [3])].sort(), ["DEC-001"]);
	assert.deepEqual([...index.activeSourceIds("s1", [9, 42])].sort(), ["DEC-001"], "unknown seqs simply don't match");
	assert.equal(index.activeSourceIds("s2", [3]).size, 0, "seqs are session-local");
	assert.equal(index.activeSourceIds("s1", []).size, 0);
});

test("provenance: a changed .provenance.json alone invalidates the index signature", () => {
	const dir = makeLedgerDir();
	const cache = new Map();
	const index = getLedgerIndex(dir, cache);
	const sigBefore = index.signature;
	const p = join(dir, ".provenance.json");
	const future = (Date.now() + 120000) / 1000;
	writeFileSync(p, JSON.stringify({ sessions: { "s1": { "7": ["REQ-001"] } } }));
	utimesSync(p, future, future);
	index.refreshIfStale();
	assert.notEqual(index.signature, sigBefore, "the sidecar's mtime is part of the staleness signature");
	assert.ok(index.provenance.has("s1"), "re-load picked up the sidecar");
});

test("provenance: a malformed sidecar is tolerated (no crash, empty map)", () => {
	const dir = makeLedgerDir();
	writeFileSync(join(dir, ".provenance.json"), "{ not valid json !!!");
	const future = (Date.now() + 120000) / 1000;
	utimesSync(join(dir, ".provenance.json"), future, future);
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index, "a broken sidecar must not take the index down");
	assert.equal(index.provenance.size, 0);
});

// ---------------------------------------------------------------------------
// Provenance DEGRADED state (review 2026-09-12, P0.5): an ACTIVE entry with
// no resolved binding (sidecar missing/corrupt/failed, or the last
// resolution failed) is UNRESOLVED — it feeds the protection gate's
// conservative P1 hold. A bad sidecar may cost extra retention, never a
// wrongful deletion.
// ---------------------------------------------------------------------------

test("degraded state: ACTIVE entry with no binding row → unresolved + evidence terms", () => {
	const dir = makeLedgerDir();
	writeFileSync(join(dir, "DECISIONS.md"), [
		"# DECISIONS",
		"",
		"## [DEC-001] Never enable MTP",
		"- status: ACTIVE",
		"- Decision: keep MTP off",
		"- source: 以后不要开 MTP，它会让基准变慢",
		""
	].join("\n"));
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index);
	assert.ok(index.unresolvedActiveIds.has("DEC-001"), "no sidecar at all → zero bindings → unresolved (fail-safe default)");
	const terms = index.unresolvedTerms.get("DEC-001");
	assert.ok(terms, "evidence terms extracted for the conservative lane");
	assert.ok(terms.has("never") && terms.has("enable") && terms.has("mtp"), "title terms included");
	assert.ok([...terms].some((t) => t.includes("基准")), "the stored source quote feeds the terms too");
});

test("degraded state: a PARTIAL entry (old binding + fresh failure row) stays unresolved", () => {
	const dir = makeLedgerDir();
	writeFileSync(join(dir, "DECISIONS.md"), [
		"# DECISIONS",
		"",
		"## [DEC-001] Never enable MTP",
		"- status: ACTIVE",
		"- source: 以后不要开 MTP，它会让基准变慢",
		""
	].join("\n"));
	// the sidecar holds a binding for the OLD fact AND a failure row for the
	// CURRENT change (its new evidence never resolved): the entry must stay
	// in the conservative set even though it is not "zero bindings".
	const sidecar = {
		sessions: { "s1": { "3": ["DEC-001"] } },
		unresolved: { "DEC-001": { reason: "quote-mismatch", at: "2026-09-12T00:00:00Z" } }
	};
	writeFileSync(join(dir, ".provenance.json"), JSON.stringify(sidecar, null, 2));
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index);
	assert.ok(index.activeSourceIds("s1", [3]).has("DEC-001"), "the old binding still pins the old evidence");
	assert.ok(index.unresolvedActiveIds.has("DEC-001"), "PARTIAL state: the current change's evidence is unverified");
	assert.equal(index.unresolvedReasons.get("DEC-001"), "quote-mismatch");
});

test("degraded state: a fully bound ACTIVE entry leaves the conservative set", () => {
	const dir = makeLedgerDir();
	writeFileSync(join(dir, "DECISIONS.md"), [
		"# DECISIONS",
		"",
		"## [DEC-001] Never enable MTP",
		"- status: ACTIVE",
		"- source: 以后不要开 MTP，它会让基准变慢",
		""
	].join("\n"));
	writeFileSync(join(dir, ".provenance.json"), JSON.stringify({ sessions: { "s1": { "3": ["DEC-001"] } }, unresolved: {} }));
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index);
	assert.ok(!index.unresolvedActiveIds.has("DEC-001"), "bound + no failure → resolved (exact-source lane only)");
});
