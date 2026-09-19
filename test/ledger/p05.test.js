/**
 * P0.5 batch (reverse review 2026-09-12) — provenance fail-safe, tested by
 * FAILURE INJECTION (the user's preferred style — no more ordinary unit
 * tests):
 *
 *  1. Ephemeral evidence handles [E#]: the host numbers the delta messages,
 *     the Guardian cites `source_ref: E#` + a verbatim quote, and the host
 *     binds the pair to EXACTLY ONE seq (the LLM never sees seqs; a quote
 *     duplicated across N messages can no longer bind all N arbitrarily).
 *  2. Degraded state: the ledger commit and the provenance commit are NOT one
 *     safe transaction. An injected sidecar write failure leaves
 *     "Ledger truth = ok / VAC-GC = conservative P1 hold" — never a ledger
 *     rollback, never a silent "normal weight scoring".
 *  3. Crash window: commit order is LEDGER → HISTORY → revision. A staged
 *     partial commit (LEDGER only, or LEDGER+HISTORY) self-heals on the next
 *     sync: the Guardian sees the surviving entry and emits NOOP (idempotent
 *     operations replanning on a fresh base) + revision-as-commit-marker +
 *     per-session cursor → no duplicate entries, one converging state.
 *  4. Repair: the sidecar's unresolved rows (and entries whose sidecar was
 *     lost) re-bind from the quote stored IN THE ENTRY over the append-only
 *     log — the stale E# no longer matters.
 *
 * lib/index.js imports host packages via bare specifiers; without the dev
 * checkout's node_modules junctions the import cannot succeed — those tests
 * skip cleanly (same contract as test/engine/host-contract.test.js). The
 * vacgc modules are pure and always run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProtection } from "../../lib/vacgc/protection.js";
import { getLedgerIndex } from "../../lib/vacgc/memory-index.js";

let mod;
let importError;
try {
	mod = await import("../../lib/index.js");
} catch (error) {
	importError = error;
}
const unavailable = importError !== undefined;

function tempDir() {
	return mkdtempSync(join(tmpdir(), "mml-p05-"));
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

function mmlDefaults() {
	return { ...mod.MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
}

// Operations-contract answers (P1-②): the LLM proposes, the host applies.
// MTP_ANSWER = the delta fact enters the ledger as a host-validated ADD.
const MTP_ANSWER = JSON.stringify({
	operations: [
		{ op: "ADD", kind: "DEC", title: "Never enable MTP", confidence: 0.9, body: "keep MTP off in this project", source_ref: "E1", source_quote: "以后不要开 MTP，它会让基准变慢" }
	],
	history: "ok"
});
// NOOP_ANSWER = "the ledger already holds what the conversation says"
// (what a Guardian correctly emits after a self-healing crash sync).
const NOOP_ANSWER = JSON.stringify({ operations: [{ op: "NOOP", reason: "already recorded" }], history: "ok" });
// The file content the ADD op renders to (host-owned format) — used to stage
// crashed partial commits.
const MTP_LEDGER = [
	"# DECISIONS",
	"",
	"## [DEC-001] Never enable MTP",
	"- confidence: 0.9",
	"- status: ACTIVE",
	"- keep MTP off in this project",
	"- source: 以后不要开 MTP，它会让基准变慢",
	""
].join("\n");

// ---------------------------------------------------------------------------
// 1 — ephemeral handles
// ---------------------------------------------------------------------------

test("handlesForRows: [E#] numbering, private E#→seq map, render truncation", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const rows = [
		{ seq: 0, text: "[user]\nfirst message" },
		{ seq: 1, text: "[assistant]\nsecond message" },
		{ seq: 5, text: "[user]\nthird message" }
	];
	const { handles, text } = ledger.handlesForRows(rows);
	assert.deepEqual([...handles.keys()], ["E1", "E2", "E3"], "handles are sequential E#");
	assert.equal(handles.get("E3").seq, 5, "E# is NOT the seq — the real seq lives only in the host map");
	assert.equal(text.split("\n\n")[0], "E1\n[user]\nfirst message", "the rendered block is [E#] + projected text");
	// render truncation caps the PROMPT text; the map stays complete
	const big = { seq: 9, text: `[user]\n${"x".repeat(200000)}` };
	const bigR = ledger.handlesForRows([big]);
	assert.ok(bigR.text.length < 200000, "rendered text is capped");
	assert.equal(bigR.handles.get("E1").text, big.text, "the map keeps the full row text");
});

// ---------------------------------------------------------------------------
// 2 — resolveProvenance validation matrix
// ---------------------------------------------------------------------------

test("resolveProvenance: source_ref + verbatim quote binds EXACTLY the referenced seq (even when the quote is duplicated in the log)", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const handles = new Map([
		["E1", { seq: 4, text: "[user]\n以后不要开 MTP，它会让基准变慢。" }],
		["E2", { seq: 5, text: "[assistant]\n好的，已记录。" }]
	]);
	const nextFiles = {
		"DECISIONS.md": "## [DEC-001] Never enable MTP\n- source_ref: E1\n- source: 以后不要开 MTP，它会让基准变慢\n"
	};
	// the SAME quote also occurs in an older message (seq 9): the quote-unique
	// fallback would call this ambiguous — the ref path must win and bind
	// exactly the referenced message.
	const provRows = [
		{ seq: 4, text: "[user]\n以后不要开 MTP，它会让基准变慢。" },
		{ seq: 5, text: "[assistant]\n好的，已记录。" },
		{ seq: 9, text: "[user]\n上次也是：以后不要开 MTP，它会让基准变慢。" }
	];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, { "DECISIONS.md": "# DECISIONS\n" }, provRows, handles);
	assert.deepEqual([...bySeq.keys()], [4], "bound to the referenced seq only — no silent multi-binding");
	assert.deepEqual([...bySeq.get(4)], ["DEC-001"]);
	assert.equal(unresolved.size, 0);
});

test("resolveProvenance: quote that does not belong to the referenced handle → quote-mismatch, NO silent fallback", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const handles = new Map([
		["E1", { seq: 4, text: "[user]\n记住，构建命令是 npm.cmd run build。" }],
		["E2", { seq: 5, text: "[assistant]\n好的，已确认。" }]
	]);
	const nextFiles = {
		"DECISIONS.md": "## [DEC-002] Build command\n- source_ref: E1\n- source: 完全虚构的一段引文啊哈\n"
	};
	// the (hallucinated) quote DOES exist elsewhere in the log (seq 7) — a
	// silent fallback would bind it there; the ref path must reject instead.
	const provRows = [
		{ seq: 4, text: "[user]\n记住，构建命令是 npm.cmd run build。" },
		{ seq: 5, text: "[assistant]\n好的，已确认。" },
		{ seq: 7, text: "[user]\n完全虚构的一段引文啊哈" }
	];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, { "DECISIONS.md": "# DECISIONS\n" }, provRows, handles);
	assert.equal(bySeq.size, 0, "a mismatched quote never binds (hallucination signal)");
	assert.equal(unresolved.get("DEC-002")?.reason, "quote-mismatch");
});

test("resolveProvenance: hallucinated handle (E9 not in this sync) → unknown-ref, no fallback", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const nextFiles = {
		"DECISIONS.md": "## [DEC-003] x\n- source_ref: E9\n- source: 以后不要开 MTP，它会让基准变慢\n"
	};
	const provRows = [{ seq: 3, text: "[user]\n以后不要开 MTP，它会让基准变慢。" }];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, { "DECISIONS.md": "# DECISIONS\n" }, provRows, new Map());
	assert.equal(bySeq.size, 0, "an unknown handle never falls through to quote-search");
	assert.equal(unresolved.get("DEC-003")?.reason, "unknown-ref");
});

test("resolveProvenance: same quote in THREE seqs, no ref → ambiguous, no silent arbitrary binding", () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const ledger = new LedgerManager();
	const nextFiles = {
		"DECISIONS.md": "## [DEC-004] y\n- source: 这句话在三个消息里都出现过\n"
	};
	const provRows = [
		{ seq: 1, text: "[user]\n这句话在三个消息里都出现过" },
		{ seq: 2, text: "[user]\n这句话在三个消息里都出现过" },
		{ seq: 3, text: "[user]\n这句话在三个消息里都出现过" }
	];
	const { bySeq, unresolved } = ledger.resolveProvenance(nextFiles, { "DECISIONS.md": "# DECISIONS\n" }, provRows, new Map());
	assert.equal(bySeq.size, 0, "ambiguity is a degraded state — never an arbitrary pick");
	assert.equal(unresolved.get("DEC-004")?.reason, "ambiguous");
});

// ---------------------------------------------------------------------------
// 3 — sync-level injections
// ---------------------------------------------------------------------------

test("sync (E# happy path): turn sync binds through the ephemeral handle; sidecar clean", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mmlDefaults());
	const session = makeSession("sess-P5", ["以后不要开 MTP，它会让基准变慢。"]);
	const result = await ledger.sync(fakeCtx(MTP_ANSWER), mmlDefaults(), dir, session, { source: "turns" });
	assert.ok(result.written.includes("DECISIONS.md"));
	const rendered = readFileSync(join(dir, "DECISIONS.md"), "utf8");
	assert.match(rendered, /^## \[DEC-001\] Never enable MTP$/m, "host-minted id in the rendered entry");
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-P5"], { "0": ["DEC-001"] }, "the validated E1 handle bound to durable seq 0");
	assert.deepEqual(doc.unresolved, {}, "clean binding → no degraded state");
});

test("sync (wrong-handle injection): the operation is evidence-gated OUT (no partial entry); a corrected citation later lands cleanly", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const mml = mmlDefaults();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-P5", ["记住，构建命令是 npm.cmd run build。", "好的，已确认。"]);
	// The Guardian cites E2 (seq 1: "好的，已确认。") but the quote actually
	// lives in E1's message → QUOTE_MISMATCH.
	const wrongAnswer = JSON.stringify({
		operations: [
			{ op: "ADD", kind: "DEC", title: "Build command", confidence: 0.9, body: "use npm.cmd run build on Windows", source_ref: "E2", source_quote: "构建命令是 npm.cmd run build" }
		],
		history: "ok"
	});
	// --- sync 1: in the operations contract a failed evidence check rejects
	// the WHOLE operation — nothing enters the ledger, the rejection is
	// audited in HISTORY, and the delta was considered (cursor advances; a
	// rejection is final for that delta, the raw evidence stays in the log).
	const r1 = await ledger.sync(fakeCtx(wrongAnswer), mml, dir, session, { source: "turns" });
	assert.ok(!r1.written.includes("DECISIONS.md"), "a rejected op changes no ledger file");
	assert.ok(!/^## \[DEC-\d+\]/m.test(readFileSync(join(dir, "DECISIONS.md"), "utf8")), "no entry minted from failed evidence");
	assert.match(readFileSync(join(dir, "HISTORY.md"), "utf8"), /rejected QUOTE_MISMATCH: ADD/, "the rejection reason is audited in HISTORY");
	assert.equal(ledger.loadState(dir, "sess-P5").lastSyncedSeq, 2, "cursor advanced — the rejection is a host decision, not a sync failure");
	const doc1 = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc1.sessions["sess-P5"], {}, "no binding, no unresolved row (there is no entry)");
	// --- sync 2: a CORRECTED citation — the quote re-appears in a new delta
	// message, cited with the handle it actually belongs to (E1 = the new
	// message). The same fact now lands with a verified binding.
	session.log.push({ type: "user/message", seq: 2, data: { role: "user", content: [{ type: "text", text: "再次确认：构建命令是 npm.cmd run build。" }] } });
	const goodAnswer = JSON.stringify({
		operations: [
			{ op: "ADD", kind: "DEC", title: "Build command", confidence: 0.9, body: "use npm.cmd run build on Windows", source_ref: "E1", source_quote: "构建命令是 npm.cmd run build" }
		],
		history: "ok"
	});
	const r2 = await ledger.sync(fakeCtx(goodAnswer), mml, dir, session, { source: "turns" });
	assert.ok(r2.written.includes("DECISIONS.md"), "the corrected citation is applied");
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-P5"], { "2": ["DEC-001"] }, "bound to the durable seq the corrected handle points at");
	assert.deepEqual(doc.unresolved, {}, "clean binding → no degraded state");
});

test("sync (provenance write FAILURE): ledger survives + degraded; VAC-GC conservatively holds P1; repair on the next sync", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const mml = mmlDefaults();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-P5", ["以后不要开 MTP，它会让基准变慢。"]);
	// Inject the failure: the sidecar write throws AFTER the ledger commit.
	const original = ledger.mergeProvenance.bind(ledger);
	ledger.mergeProvenance = () => {
		throw new Error("injected: disk full on provenance sidecar");
	};
	const r1 = await ledger.sync(fakeCtx(MTP_ANSWER), mml, dir, session, { source: "turns" });
	assert.ok(r1.written.includes("DECISIONS.md"), "the LEDGER commit stands despite the sidecar failure");
	assert.equal(ledger.readRevision(dir), 1, "the revision bump (commit point) happened");
	assert.equal(ledger.loadState(dir, "sess-P5").lastSyncedSeq, 1, "the cursor advanced");
	assert.ok(!existsSync(join(dir, ".provenance.json")), "no sidecar was written");
	ledger.mergeProvenance = original; // restore for the repair sync

	// Degraded state is SELF-COVERING: no sidecar at all → every ACTIVE entry
	// has zero bound seqs → conservative protection, never NORMAL.
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index.available, "the ledger index loads fine");
	assert.ok(index.unresolvedActiveIds.has("DEC-001"), "ACTIVE entry with no binding = unresolved (fail-safe)");
	assert.ok(index.unresolvedTerms.get("DEC-001")?.size > 0, "evidence terms extracted for the conservative lane");
	// NOTE: the text must share ≥ 2 evidence terms (enable/mtp/它会让基准变慢)
	// without tripping a genuine user-lane pattern (e.g. "never" is a real
	// hard-constraint marker — that would be a P0 for the right reason).
	const related = {
		kind: "user",
		text: "enable mtp 之后 它会让基准变慢，吞吐下降",
		terms: { ids: [] },
		seqs: [0]
	};
	const unrelated = {
		kind: "user",
		text: "今天午餐吃什么好呢，大家随意",
		terms: { ids: [] },
		seqs: [1]
	};
	const rel = classifyProtection(related, { memory: index, sessionId: "sess-P5" });
	assert.equal(rel.protection, "P1", "lexically-related unit is HELD at P1, not NORMAL");
	assert.match(rel.reasons.join(" "), /conservative P1 hold/);
	assert.ok(!rel.reasons.some((r) => r.includes("(provenance)")), "no P0 claim without a real binding");
	assert.equal(classifyProtection(unrelated, { memory: index, sessionId: "sess-P5" }).protection, "NORMAL", "no over-protection: unrelated units stay NORMAL");

	// Repair: the next successful sync (NOOP — the fact already exists, the
	// Guardian does not re-add it) runs reconciliation, which re-binds the
	// entry's stored quote over the append-only log.
	session.log.push({ type: "user/message", seq: 1, data: { role: "user", content: [{ type: "text", text: "补充：MTP 会拖慢吞吐。" }] } });
	await ledger.sync(fakeCtx(NOOP_ANSWER), mml, dir, session, { source: "turns" });
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-P5"]["0"], ["DEC-001"], "the repair sync re-established the binding (no re-ADD — still exactly one entry)");
	assert.equal(readFileSync(join(dir, "DECISIONS.md"), "utf8").match(/^## \[DEC-/gm).length, 1, "reconciliation repairs the sidecar, it does not duplicate entries");
	const index2 = getLedgerIndex(dir, new Map());
	assert.ok(!index2.unresolvedActiveIds.has("DEC-001"));
	// and the unit is now P0 through the exact-source lane (its seq 0 is bound)
	const p0 = classifyProtection(related, { memory: index2, sessionId: "sess-P5" });
	assert.equal(p0.protection, "P0", "repaired provenance upgrades the lane from P1 hold to P0 exact-source");
});

// ---------------------------------------------------------------------------
// 4 — crash windows (staged partial commits)
// ---------------------------------------------------------------------------

test("crash after LEDGER, before HISTORY: partial commit self-heals on the next sync", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const mml = mmlDefaults();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-C", ["以后不要开 MTP，它会让基准变慢。"]);
	// Stage the crashed sync's partial commit: the ledger file WAS written,
	// HISTORY.md and .state.json were NOT (crash in the write-order window).
	writeFileSync(join(dir, "DECISIONS.md"), MTP_LEDGER);
	// The next sync converges: the Guardian SEES the entry in the ledger and
	// emits NOOP (the instruction forbids re-adding existing entries) → the
	// partial commit stands as the effective state: no duplicate entry, one
	// HISTORY line, revision bumped once, cursor advanced.
	const result = await ledger.sync(fakeCtx(NOOP_ANSWER), mml, dir, session, { source: "turns" });
	assert.ok(Array.isArray(result.written), "the sync completes without throwing");
	const final = readFileSync(join(dir, "DECISIONS.md"), "utf8");
	assert.equal(final.match(/^## \[DEC-001\]/gm).length, 1, "no duplicate entry after the self-healing sync");
	const history = readFileSync(join(dir, "HISTORY.md"), "utf8");
	assert.equal(history.match(/^- \[/gm).length, 1, "exactly one history line for the surviving commit");
	assert.equal(ledger.readRevision(dir), 1, "the revision (commit marker) moved exactly once");
	assert.equal(ledger.loadState(dir, "sess-C").lastSyncedSeq, 1, "the per-session cursor advanced");
});

test("crash after HISTORY, before revision: self-heal keeps HISTORY append-only and converges the state", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const mml = mmlDefaults();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-C", ["以后不要开 MTP，它会让基准变慢。"]);
	// Stage: LEDGER + HISTORY were written, .state.json was NOT (crash right
	// before the commit point).
	writeFileSync(join(dir, "DECISIONS.md"), MTP_LEDGER);
	writeFileSync(join(dir, "HISTORY.md"), "# HISTORY\n- [2026-09-12T00:00:00.000Z] (turns) session sess-C: wrote DECISIONS.md; integrity: ok\n");
	assert.equal(ledger.readRevision(dir), 0, "no revision bump survived the crash");
	const result = await ledger.sync(fakeCtx(NOOP_ANSWER), mml, dir, session, { source: "turns" });
	assert.ok(Array.isArray(result.written));
	const final = readFileSync(join(dir, "DECISIONS.md"), "utf8");
	assert.equal(final.match(/^## \[DEC-001\]/gm).length, 1, "no duplicate entry");
	const history = readFileSync(join(dir, "HISTORY.md"), "utf8");
	assert.equal(history.match(/^- \[/gm).length, 2, "the pre-crash line stays (append-only) + the converging line");
	assert.equal(ledger.readRevision(dir), 1);
	assert.equal(ledger.loadState(dir, "sess-C").lastSyncedSeq, 1);
});

// ---------------------------------------------------------------------------
// 5 — sidecar corruption + reconciliation
// ---------------------------------------------------------------------------

test("restart with a MALFORMED sidecar: index loads, entry is conservatively protected, the next sync repairs", async () => {
	if (unavailable) return;
	const { LedgerManager } = mod;
	const dir = tempDir();
	const mml = mmlDefaults();
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	const session = makeSession("sess-M", ["以后不要开 MTP，它会让基准变慢。"]);
	// The entry (with its stored quote) is in the ledger, but the sidecar is
	// corrupt garbage — the "provenance lost" degraded state.
	writeFileSync(join(dir, "DECISIONS.md"), MTP_LEDGER);
	writeFileSync(join(dir, ".provenance.json"), "{ not valid json !!");
	const index = getLedgerIndex(dir, new Map());
	assert.ok(index.available, "a corrupt sidecar never breaks ledger loading");
	assert.equal(index.provenance.size, 0, "corrupt sidecar → no bindings (tolerant parse)");
	assert.ok(index.unresolvedActiveIds.has("DEC-001"), "unbound ACTIVE entry → degraded state → conservative hold");
	const unit = { kind: "user", text: "enable mtp 了，因为它会让基准变慢", terms: { ids: [] }, seqs: [0] };
	assert.equal(classifyProtection(unit, { memory: index, sessionId: "sess-M" }).protection, "P1");
	// The next sync (NOOP — the entry exists) re-binds from the entry's
	// stored quote (reconciliation), rewriting the corrupt sidecar.
	session.log.push({ type: "user/message", seq: 1, data: { role: "user", content: [{ type: "text", text: "补充一条上下文。" }] } });
	await ledger.sync(fakeCtx(NOOP_ANSWER), mml, dir, session, { source: "turns" });
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-M"]["0"], ["DEC-001"], "the sidecar was rewritten with the re-bound evidence");
	const index2 = getLedgerIndex(dir, new Map());
	assert.ok(!index2.unresolvedActiveIds.has("DEC-001"), "gap repaired → back to the exact-source lane");
});
