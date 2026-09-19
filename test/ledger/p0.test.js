/**
 * P0 batch (reverse review 2026-09-12) — ledger-side:
 *
 * 1. Provenance: the Guardian quotes the conversation VERBATIM in a
 *    `- source:` bullet; the host (deterministic code, no LLM) resolves the
 *    quote to the original log seqs and records it in .provenance.json.
 *    VAC-GC then hard-protects those messages while the entry is ACTIVE.
 *    Verbatim only: a paraphrase or a <12-char quote resolves to nothing.
 * 2. Concurrency: the ledger-wide `revision` in .state.json — a concurrent
 *    commit during the LLM call moves it, the commit gate throws
 *    LEDGER_REVISION_CONFLICT, and sync() retries exactly once on a fresh
 *    base. Counter-only saves never clobber the revision.
 * 3. deltaEvents: the durable append-only log as {seq, text} rows
 *    (deltaText is built on top of it).
 *
 * lib/index.js imports host packages via bare specifiers; without the dev
 * checkout's node_modules junctions the import cannot succeed — those tests
 * skip cleanly (same contract as test/engine/host-contract.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mod;
let importError;
try {
	mod = await import("../../lib/index.js");
} catch (error) {
	importError = error;
}
const unavailable = importError !== undefined;

function tempDir() {
	return mkdtempSync(join(tmpdir(), "mml-p0-"));
}

/** A minimal session: an append-only log of user messages (host shape). */
function makeSession(id, texts) {
	return {
		id,
		log: texts.map((text, seq) => ({ type: "user/message", seq, data: { role: "user", content: [{ type: "text", text }] } }))
	};
}

/** A fake ctx whose LLM streams one fixed sync-JSON answer. */
function fakeCtx(answer, hooks = {}) {
	let calls = 0;
	return {
		calls: () => calls,
		llm: {
			stream: async function* () {
				calls += 1;
				hooks.onStreamStart?.(calls);
				yield { type: "text-delta", index: 0, text: answer };
				yield { type: "finish", reason: { kind: "stop" } };
				hooks.onStreamEnd?.(calls);
			}
		}
	};
}

test("resolveProvenance: a NEW entry's verbatim - source: quote maps to the log seq (quote-unique fallback)", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const oldFiles = { "DECISIONS.md": "# DECISIONS\n" };
	const nextFiles = {
		"DECISIONS.md": [
			"# DECISIONS",
			"",
			"## [DEC-001] Never enable MTP",
			"- confidence: 0.9",
			"- status: ACTIVE",
			"- Decision: keep MTP off in this project",
			"- source: 以后不要开 MTP，它会让基准变慢",
			""
		].join("\n")
	};
	const provRows = [
		{ seq: 3, text: "[user]\n以后不要开 MTP，它会让基准变慢。" },
		{ seq: 7, text: "[assistant]\n好的，已记录。" }
	];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, oldFiles, provRows);
	assert.deepEqual([...bySeq.keys()], [3], "only the event whose text contains the quote matches");
	assert.deepEqual([...bySeq.get(3)], ["DEC-001"]);
	assert.equal(unresolved.size, 0, "a unique quote binds cleanly — no degraded state");
});

test("resolveProvenance: whitespace-normalized matching (collapsed runs, case)", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const nextFiles = {
		"TECH.md": [
			"# TECH",
			"",
			"## [TECH-001] Build command",
			"- status: ACTIVE",
			"- source: The build is `npm.cmd run build` because execution policy blocks npm.ps1",
			""
		].join("\n")
	};
	const provRows = [
		// same quote, but the event text has a double space and different case
		{ seq: 11, text: "[user]\nthe build is  `npm.cmd RUN build`  because execution policy blocks npm.ps1" }
	];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, { "TECH.md": "" }, provRows);
	assert.deepEqual([...bySeq.keys()], [11]);
	assert.deepEqual([...bySeq.get(11)], ["TECH-001"]);
	assert.equal(unresolved.size, 0, "a clean normalized match is not a degraded state");
});

test("resolveProvenance: paraphrase / short quote / unchanged entry → no binding, explicit unresolved reasons", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const provRows = [{ seq: 3, text: "[user]\n以后不要开 MTP，它会让基准变慢。" }];
	// paraphrase: reworded, not verbatim → no substring match → not-found
	const paraphrase = { "DECISIONS.md": "## [DEC-002] No MTP\n- source: 用户之前提到不要启用那个多token预测选项\n" };
	const r1 = ledger.resolveProvenance(paraphrase, { "DECISIONS.md": "" }, provRows);
	assert.equal(r1.bySeq.size, 0, "a paraphrase is NOT a source quote");
	assert.equal(r1.unresolved.get("DEC-002")?.reason, "not-found");
	// short quote (<12 chars): too ambiguous to match → no-ref
	const short = { "DECISIONS.md": "## [DEC-003] x\n- source: MTP\n" };
	const r2 = ledger.resolveProvenance(short, { "DECISIONS.md": "" }, provRows);
	assert.equal(r2.bySeq.size, 0, "short quotes cannot bind");
	assert.equal(r2.unresolved.get("DEC-003")?.reason, "no-ref");
	// unchanged entry: identical raw on both sides → skipped entirely
	const same = "## [DEC-004] x\n- source: 以后不要开 MTP，它会让基准变慢\n";
	const r3 = ledger.resolveProvenance({ "DECISIONS.md": same }, { "DECISIONS.md": same }, provRows);
	assert.equal(r3.bySeq.size, 0, "unchanged entries carry no provenance row");
	assert.equal(r3.unresolved.size, 0, "unchanged entries are not flagged either");
	// changed entry (raw differs) with a verbatim quote → row
	const r4 = ledger.resolveProvenance({ "DECISIONS.md": "## [DEC-004] x\n- new fact line\n- source: 以后不要开 MTP，它会让基准变慢\n" }, { "DECISIONS.md": "## [DEC-004] x\n- old fact line\n" }, provRows);
	assert.deepEqual([...r4.bySeq.keys()], [3]);
	assert.equal(r4.unresolved.size, 0);
});

test("mergeProvenance: merges into .provenance.json (never rewrites other sessions) and caps at 100 sessions", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const ledger = new LedgerManager();
	ledger.mergeProvenance(dir, "s1", { bySeq: new Map([[3, new Set(["DEC-001"])]]) });
	let doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions.s1, { "3": ["DEC-001"] });
	assert.deepEqual(doc.unresolved, {}, "no failures → empty unresolved map");
	// a second sync for the same session MERGES (seq 3 kept, seq 5 added)
	ledger.mergeProvenance(dir, "s1", { bySeq: new Map([[5, new Set(["DEC-002"])]]) });
	doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions.s1, { "3": ["DEC-001"], "5": ["DEC-002"] });
	// idempotent re-merge of the same row
	ledger.mergeProvenance(dir, "s1", { bySeq: new Map([[3, new Set(["DEC-001"])]]) });
	doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions.s1, { "3": ["DEC-001"], "5": ["DEC-002"] });
	// P0.5 unresolved rows: added on failure, kept while unbound+ACTIVE,
	// pruned when the id is no longer ACTIVE
	ledger.mergeProvenance(dir, "s1", {
		bySeq: new Map(),
		unresolved: new Map([
			["DEC-002", { reason: "ambiguous", at: "2026-09-12T00:00:00Z" }],
			["DEC-900", { reason: "no-ref", at: "2026-09-12T00:00:00Z" }]
		])
	}, new Set(["DEC-001", "DEC-002"]));
	doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.unresolved["DEC-002"], { reason: "ambiguous", at: "2026-09-12T00:00:00Z" }, "failure row persists while unbound + ACTIVE");
	assert.equal(doc.unresolved["DEC-900"], undefined, "a non-ACTIVE id is pruned");
	// a binding THIS round clears the row (repair)
	ledger.mergeProvenance(dir, "s1", { bySeq: new Map([[5, new Set(["DEC-002"])]]) }, new Set(["DEC-001", "DEC-002"]));
	doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.equal(doc.unresolved["DEC-002"], undefined, "repair (binding this round) clears the row");
	// cap: 100 other sessions push the total to 101 → evict down to 100,
	// the current session (last writer) is always kept
	for (let i = 0; i < 100; i += 1) {
		ledger.mergeProvenance(dir, `old-${i}`, { bySeq: new Map([[1, new Set(["X"])]]) });
	}
	doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	const keys = Object.keys(doc.sessions);
	assert.equal(keys.length, 100, "sidecar capped at 100 sessions");
	assert.ok(doc.sessions.s1, "the original session is kept");
	assert.ok(doc.sessions["old-99"], "the latest session (last writer) is kept");
	assert.ok(!doc.sessions["old-98"], "the oldest other session is evicted first");
});

test("revision: readRevision defaults to 0; saveState bumps when given, preserves when absent", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const ledger = new LedgerManager();
	ledger.ensure(dir, { gitTracked: false });
	assert.equal(ledger.readRevision(dir), 0, "no .state.json yet → revision 0");
	const st = { turns: 0, lastSyncedSeq: 5, lastSyncMs: 1, lastSource: "turns" };
	ledger.saveState(dir, "s1", st, 1);
	assert.equal(ledger.readRevision(dir), 1, "commit bump persisted");
	// a counter-only save (turn listener, no revision argument) must NOT clobber it
	ledger.saveState(dir, "s1", { ...st, turns: 3 });
	assert.equal(ledger.readRevision(dir), 1, "counter-only save preserves the revision");
	// another session's commit bumps independently
	ledger.saveState(dir, "s2", { turns: 1, lastSyncedSeq: 9, lastSyncMs: 2, lastSource: "turns" }, 2);
	assert.equal(ledger.readRevision(dir), 2);
	// per-session cursors stay per-session (the reviewer's "one global cursor" concern:
	// the monotonic seq cursor was already per-sessionId; only the REVISION is global)
	assert.equal(ledger.loadState(dir, "s1").lastSyncedSeq, 5);
	assert.equal(ledger.loadState(dir, "s2").lastSyncedSeq, 9);
});

test("deltaEvents: durable-log rows with seqs; deltaText is built on top of them", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const session = {
		id: "s",
		log: [
			{ type: "user/message", seq: 0, data: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } },
			{ type: "session/event", seq: 2, data: {} } // non-message event → not projected
		]
	};
	const events = ledger.deltaEvents(session, 0);
	assert.deepEqual(events.map((e) => e.seq), [0, 1]);
	assert.match(events[0].text, /\[user\]/);
	assert.equal(events[0].text, "[user]\nhi");
	// the cursor: only what happened since the last synced position
	assert.deepEqual(ledger.deltaEvents(session, 1).map((e) => e.seq), [1]);
	assert.equal(ledger.deltaText(session, 1), "[assistant]\nhello");
	assert.equal(ledger.deltaText(session, 2), "", "nothing new after the cursor");
});

test("sync (uncontended): one LLM call, revision bumped to 1, provenance sidecar written", async () => {
	if (unavailable) return;
	const { LedgerManager, MML_DEFAULTS } = mod;
	const dir = tempDir();
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-A", ["以后不要开 MTP，它会让基准变慢。"]);
	const answer = JSON.stringify({
		operations: [
			{ op: "ADD", kind: "DEC", title: "Never enable MTP", confidence: 0.9, body: "keep MTP off", source_ref: "E1", source_quote: "以后不要开 MTP，它会让基准变慢" }
		],
		history: "ok"
	});
	const ctx = fakeCtx(answer);
	const result = await ledger.sync(ctx, mml, dir, session, { source: "turns" });
	assert.ok(result.written.includes("DECISIONS.md"), `written: ${result.written.join(", ")}`);
	assert.equal(ctx.calls(), 1, "no conflict → exactly one LLM call");
	assert.equal(ledger.readRevision(dir), 1, "the commit bumped the ledger-wide revision");
	assert.equal(ledger.loadState(dir, "sess-A").lastSyncedSeq, 1, "cursor advanced to the log length");
	const rendered = readFileSync(join(dir, "DECISIONS.md"), "utf8");
	assert.match(rendered, /^## \[DEC-001\] Never enable MTP$/m, "the HOST minted the entry id (LLM never chose it)");
	assert.match(rendered, /- source: 以后不要开 MTP，它会让基准变慢/, "the verified quote is stored with the entry");
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-A"], { "0": ["DEC-001"] }, "the validated op bound to the durable log seq");
	assert.deepEqual(doc.unresolved, {}, "clean binding → no degraded state");
});

test("sync (concurrent commit during the LLM call): LEDGER_REVISION_CONFLICT → one retry on a fresh base", async () => {
	if (unavailable) return;
	const { LedgerManager, MML_DEFAULTS } = mod;
	const dir = tempDir();
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-A", ["以后不要开 MTP，它会让基准变慢。"]);
	const answer = JSON.stringify({
		operations: [
			{ op: "ADD", kind: "DEC", title: "Never enable MTP", confidence: 0.9, body: "keep MTP off", source_ref: "E1", source_quote: "以后不要开 MTP，它会让基准变慢" }
		],
		history: "ok"
	});
	// Writer B (another session of the same project) commits while A's LLM
	// call is in flight: its revision bump is exactly what A's commit gate
	// must detect (the baseline was read BEFORE the LLM call).
	const ctx = fakeCtx(answer, {
		onStreamStart: (call) => {
			if (call === 1) {
				ledger.saveState(dir, "sess-B", { turns: 0, lastSyncedSeq: 4, lastSyncMs: Date.now(), lastSource: "turns" }, 1);
			}
		}
	});
	const result = await ledger.sync(ctx, mml, dir, session, { source: "turns" });
	assert.ok(result.written.includes("DECISIONS.md"), "the retried attempt still commits the update");
	assert.equal(ctx.calls(), 1, "the retry re-plans the SAME operations on a fresh base — the LLM is never re-invoked");
	assert.equal(ledger.readRevision(dir), 2, "B's commit + A's committed retry = revision 2");
	assert.equal(ledger.loadState(dir, "sess-A").lastSyncedSeq, 1);
	assert.equal(ledger.loadState(dir, "sess-B").lastSyncedSeq, 4, "B's per-session cursor is intact");
});

test("sync (conflict on both commit attempts): the second conflict surfaces, LLM called ONCE", async () => {
	if (unavailable) return;
	const { LedgerManager, MML_DEFAULTS } = mod;
	const dir = tempDir();
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-A", ["以后不要开 MTP，它会让基准变慢。"]);
	const answer = JSON.stringify({ operations: [{ op: "NOOP", reason: "nothing durable" }], history: "ok" });
	// A hostile writer commits during the LLM call (bump 1) AND again during
	// the retry's pre-write window (bump 2) → both commit attempts collide.
	// The retry re-plans without a second LLM call (the writeHook seam is how
	// the test interleaves the second commit deterministically).
	const ctx = fakeCtx(answer, {
		onStreamStart: (call) => {
			if (call === 1) ledger.saveState(dir, "sess-B", { turns: 0, lastSyncedSeq: 4, lastSyncMs: Date.now(), lastSource: "turns" }, 1);
		}
	});
	await assert.rejects(
		() => ledger.sync(ctx, mml, dir, session, { source: "turns", writeHook: (attempt) => { if (attempt === 1) ledger.saveState(dir, "sess-C", { turns: 0, lastSyncedSeq: 9, lastSyncMs: Date.now(), lastSource: "turns" }, 2); } }),
		(error) => error?.code === "LEDGER_REVISION_CONFLICT",
		"the exhausted retry surfaces the conflict"
	);
	assert.equal(ctx.calls(), 1, "exactly ONE LLM call — both conflicts were commit-level, not LLM-level");
	assert.equal(ledger.loadState(dir, "sess-A").lastSyncedSeq, 0, "nothing committed → cursor held (the delta is re-considered next sync)");
});
