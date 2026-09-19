/**
 * P1-② Operation-based Guardian — "LLM understands state changes; host owns
 * state". The Guardian emits operations; the host validates evidence, runs
 * the Mutation Guard, applies transactionGroup atomicity, mints entry ids,
 * and renders the ledger files deterministically.
 *
 * The plan/apply pipeline is a PURE module (lib/ledger-ops.js) — these tests
 * run without the host packages. The final sync-level test uses the real
 * LedgerManager and skips cleanly when the dev node_modules junctions are
 * absent (same contract as p0.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	planOperations,
	applyOperations,
	normalizeOp,
	extractExactAtoms,
	mutationGate,
	parseLedgerFile,
	renderFile,
	normText
} from "../../lib/ledger-ops.js";

let mod;
let importError;
try {
	mod = await import("../../lib/index.js");
} catch (error) {
	importError = error;
}
const unavailable = importError !== undefined;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BASE_FILES = {
	"PROJECT.md": [
		"# PROJECT — Requirements & Scope",
		"",
		"## [REQ-001] Support MTP",
		"- confidence: 0.8",
		"- status: ACTIVE",
		"- MTP must work on the inference server",
		""
	].join("\n"),
	"STATE.md": [
		"# STATE — Current State",
		"",
		"## [STATE-CURRENT] tuning the server",
		"- task: profile MTP throughput",
		""
	].join("\n"),
	"DECISIONS.md": [
		"# DECISIONS",
		"",
		"## [DEC-001] Use FP8 KV cache",
		"- confidence: 0.9",
		"- status: ACTIVE",
		"- Decision: use FP8 KV",
		"",
		"## [DEC-002] Old: use INT8",
		"- confidence: 0.9",
		"- status: SUPERSEDED",
		"- replacement: DEC-001",
		""
	].join("\n"),
	"TECH.md": [
		"# TECH — Technical Facts & Conventions",
		"",
		"## [TECH-001] Benchmark",
		"- confidence: 0.95",
		"- status: ACTIVE",
		"- 52.31 tok/s at 192k context",
		""
	].join("\n"),
	"CONFLICTS.md": [
		"# CONFLICTS — Integrity Conflicts",
		"",
		"## [CONFLICT-001] MTP on or off",
		"- status: ACTIVE",
		"- side A: keep MTP off (old decision)",
		"- side B: enable MTP (new benchmark)",
		""
	].join("\n")
};

const E1 = { seq: 0, text: "[user]\nthe new benchmark is 53.9 tok/s at 192k, quality is more stable" };
const E2 = { seq: 1, text: "[assistant]\nnoted, switching to BF16 KV" };
const E3 = { seq: 2, text: "[user]\nalso: the build is now 12.4 GB and the error rate is error 404" };
const HANDLES = new Map([
	["E1", E1],
	["E2", E2],
	["E3", E3]
]);
const ROWS = [E1, E2, E3].map((r) => ({ seq: r.seq, text: r.text }));

const ops = (operations, files = BASE_FILES) => planOperations({ operations, history: "ok" }, { files, handles: HANDLES, rows: ROWS });

const appliedText = (plan, name) => applyOperations(BASE_FILES, plan.applied).nextFiles[name];

// ---------------------------------------------------------------------------
// schema normalization
// ---------------------------------------------------------------------------

test("ops: all seven operations normalize; unknown ops and bad kinds reject individually", () => {
	for (const name of ["ADD", "UPDATE_STATE", "AMEND", "SUPERSEDE", "CONFLICT", "RESOLVE_CONFLICT", "NOOP"]) {
		const r = normalizeOp({
			op: name.toLowerCase(),
			kind: "DEC",
			title: "t",
			body: "b",
			target_id: "DEC-001",
			topic: "t",
			resolution: "r",
			replacement: { kind: "DEC", title: "t", body: "b", source_ref: "E1", source_quote: "the new benchmark is 53.9" }
		});
		assert.ok(r.ok, `${name} normalizes (case-tolerant) — ${r.error ?? ""}`);
	}
	assert.match(normalizeOp({ op: "MUTATE" }).error, /unknown op/);
	assert.match(normalizeOp({ op: "ADD", kind: "CONFLICT", title: "t", body: "b" }).error, /use the CONFLICT op/);
	assert.match(normalizeOp({ op: "SUPERSEDE", target_id: "DEC-001" }).error, /requires replacement/);
});

// ---------------------------------------------------------------------------
// ADD: evidence gate + host-minted id
// ---------------------------------------------------------------------------

test("ops: ADD lands with a HOST-minted id and a verified binding", () => {
	const plan = ops([
		{ op: "ADD", kind: "TECH", title: "New benchmark", confidence: 0.95, body: "53.9 tok/s at 192k context", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" }
	]);
	assert.equal(plan.rejected.length, 0, plan.rejected.map((r) => r.reason).join(","));
	assert.equal(plan.applied[0].id, "TECH-002", "id = max existing (TECH-001) + 1");
	assert.equal(plan.applied[0].binding.seq, 0, "bound through the validated handle");
	const tech = appliedText(plan, "TECH.md");
	assert.match(tech, /^## \[TECH-002\] New benchmark$/m);
	assert.match(tech, /- source: the new benchmark is 53\.9 tok\/s/);
	assert.ok(!tech.includes("TECH-003"), "only one entry minted");
	assert.deepEqual(applyOperations(BASE_FILES, plan.applied).changed, ["TECH.md"], "only the target file is re-rendered");
});

test("ops: ADD evidence matrix — clean binds; unknown ref / quote mismatch / ambiguous / not-found reject the OP", () => {
	const base = { op: "ADD", kind: "DEC", title: "x", body: "a fact", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" };
	assert.equal(ops([base]).applied.length, 1, "a clean ref+quote is not rejected");
	const mk = (op) => ops([op]).rejected[0];
	assert.equal(mk({ ...base, source_ref: "E9" }).reason, "UNKNOWN_REF");
	assert.equal(mk({ ...base, source_ref: "E2", source_quote: "the new benchmark is 53.9 tok/s" }).reason, "QUOTE_MISMATCH", "the quote does not belong to E2 — no silent fallback to the row that has it");
	assert.equal(mk({ ...base, source_ref: "E1", source_quote: "totally fabricated words" }).reason, "QUOTE_MISMATCH");
	assert.equal(mk({ ...base, source_ref: "EX" }).reason, "BAD_REF");
	assert.equal(mk({ op: "ADD", kind: "DEC", title: "x", body: "a fact" }).reason, "NO_EVIDENCE");
	// quote-only: the quote is searched over the whole log — unique binds,
	// duplicated is ambiguous, absent is not-found:
	assert.equal(ops([{ ...base, source_ref: null }]).applied.length, 1, "unique quote (no ref) binds");
	assert.equal(
		planOperations(
			{ operations: [{ op: "ADD", kind: "DEC", title: "x", body: "a fact", source_quote: "这句话在两个消息里都出现过" }], history: "" },
			{ files: BASE_FILES, handles: new Map(), rows: [{ seq: 5, text: "[user]\n这句话在两个消息里都出现过" }, { seq: 6, text: "[user]\n这句话在两个消息里都出现过" }, { seq: 7, text: "[user]\n别的消息" }] }
		).rejected[0].reason,
		"AMBIGUOUS_EVIDENCE",
		"same quote in two messages → no arbitrary pick"
	);
	assert.equal(
		planOperations(
			{ operations: [{ op: "ADD", kind: "DEC", title: "x", body: "a fact", source_quote: "这句话在两个消息里都出现过" }], history: "" },
			{ files: BASE_FILES, handles: new Map(), rows: [{ seq: 7, text: "[user]\n别的消息" }] }
		).rejected[0].reason,
		"EVIDENCE_NOT_FOUND"
	);
});

// ---------------------------------------------------------------------------
// 4 valid + 1 hallucinated → 4 committed, 1 rejected (the user's scenario)
// ---------------------------------------------------------------------------

test("ops: 4 valid + 1 hallucinated → 4 applied, 1 rejected, no cross-contamination", () => {
	const plan = ops([
		{ op: "ADD", kind: "DEC", title: "A", body: "fact A", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" },
		{ op: "AMEND", target_id: "DEC-001", body: "use FP8 KV\nReason: quality is more stable at 192k", source_ref: "E1", source_quote: "quality is more stable" },
		{ op: "UPDATE_STATE", title: "after benchmark", body: "- switched to BF16 KV\n- profiled 53.9 tok/s" },
		{ op: "CONFLICT", topic: "KV format", body: "side A: the ledger says format A\nside B: the benchmark says format B", source_ref: "E1", source_quote: "53.9 tok/s at 192k" },
		{ op: "ADD", kind: "TECH", title: "Hallucinated", body: "42.0 tok/s", source_ref: "E7", source_quote: "a quote from nowhere" }
	]);
	assert.deepEqual(
		plan.applied.map((a) => `${a.op.name}${a.id ? ` ${a.id}` : a.op.targetId ? ` ${a.op.targetId}` : ""}`),
		["ADD DEC-003", "AMEND DEC-001", "UPDATE_STATE", "CONFLICT CONFLICT-002"],
		"every valid operation committed"
	);
	assert.equal(plan.rejected.length, 1);
	assert.equal(plan.rejected[0].reason, "UNKNOWN_REF", "the hallucinated handle is the single rejection");
	const next = applyOperations(BASE_FILES, plan.applied).nextFiles;
	assert.match(next["DECISIONS.md"], /## \[DEC-003\] A/);
	assert.match(next["CONFLICTS.md"], /## \[CONFLICT-002\] KV format/);
	assert.ok(!next["TECH.md"].includes("42.0"), "the rejected op touched nothing");
	assert.equal(next["STATE.md"].includes("switched to BF16 KV"), true, "the independent UPDATE_STATE landed");
});

// ---------------------------------------------------------------------------
// transactionGroup atomicity
// ---------------------------------------------------------------------------

test("ops: one invalid member rejects the WHOLE group; independent ops still commit", () => {
	const plan = ops([
		{ op: "AMEND", target_id: "DEC-001", body: "use FP8 KV\nReason: more stable at 192k", source_ref: "E1", source_quote: "quality is more stable", transactionGroup: "TX-1" },
		{ op: "ADD", kind: "DEC", title: "paired fact", body: "47.1 tok/s", source_ref: "E1", source_quote: "a quote that is not in E1", transactionGroup: "TX-1" },
		{ op: "UPDATE_STATE", title: "independent", body: "- still working" }
	]);
	const amend = plan.rejected.find((r) => r.op === "AMEND");
	assert.ok(amend, "the valid group member is rejected WITH the group");
	assert.equal(amend.reason, "GROUP_REJECTED");
	const bad = plan.rejected.find((r) => r.op === "ADD");
	assert.equal(bad.reason, "QUOTE_MISMATCH", "the root cause is recorded too");
	assert.deepEqual(plan.applied.map((a) => a.op.name), ["UPDATE_STATE"], "the independent op committed on its own");
	const next = applyOperations(BASE_FILES, plan.applied).nextFiles;
	assert.equal(next["DECISIONS.md"], BASE_FILES["DECISIONS.md"], "a failed group leaves every target byte-identical");
	assert.notEqual(next["STATE.md"], BASE_FILES["STATE.md"], "the independent op's file did change");
});

// ---------------------------------------------------------------------------
// AMEND vs SUPERSEDE (version-explosion control)
// ---------------------------------------------------------------------------

test("ops: AMEND keeps the id (added rationale); SUPERSEDE mints a new id + pointer", () => {
	// AMEND: same decision, added rationale — no new entry, no new id.
	const amend = ops([
		{ op: "AMEND", target_id: "DEC-001", body: "use FP8 KV\nReason: 192k context is more stable", source_ref: "E1", source_quote: "192k" }
	]);
	assert.equal(amend.rejected.length, 0, amend.rejected.map((r) => `${r.reason}: ${r.detail}`).join(","));
	const afterAmend = applyOperations(BASE_FILES, amend.applied).nextFiles;
	assert.equal(afterAmend["DECISIONS.md"].match(/^## \[DEC-/gm).length, 2, "AMEND mints NO new id");
	assert.match(afterAmend["DECISIONS.md"], /## \[DEC-001\] Use FP8 KV cache[\s\S]*192k context is more stable/);
	assert.match(afterAmend["DECISIONS.md"], /- status: ACTIVE/, "AMEND keeps the status");

	// SUPERSEDE: the fact changed (FP8 → BF16) — new id, old entry closed.
	const sup = ops([
		{ op: "SUPERSEDE", target_id: "DEC-001", replacement: { kind: "DEC", title: "Use BF16 KV cache", confidence: 0.95, body: "use BF16 KV instead", source_ref: "E2", source_quote: "switching to BF16 KV" } }
	]);
	assert.equal(sup.rejected.length, 0, sup.rejected.map((r) => `${r.reason}: ${r.detail}`).join(","));
	assert.equal(sup.applied[0].id, "DEC-003", "the replacement gets the next id");
	const afterSup = applyOperations(BASE_FILES, sup.applied).nextFiles;
	assert.match(afterSup["DECISIONS.md"], /## \[DEC-001\] Use FP8 KV cache[\s\S]*- status: SUPERSEDED[\s\S]*- replacement: DEC-003/);
	assert.match(afterSup["DECISIONS.md"], /## \[DEC-003\] Use BF16 KV cache[\s\S]*- status: ACTIVE/);
	assert.equal(afterSup["DECISIONS.md"].match(/^## \[DEC-/gm).length, 3, "old entry stays (closed), new entry added");
});

test("ops: AMEND/SUPERSEDE/RESOLVE on missing or closed targets reject with explicit reasons", () => {
	assert.equal(ops([{ op: "AMEND", target_id: "DEC-999", body: "x", source_ref: "E1", source_quote: "the new benchmark is 53.9" }]).rejected[0].reason, "TARGET_NOT_FOUND");
	assert.equal(ops([{ op: "AMEND", target_id: "DEC-002", body: "x", source_ref: "E1", source_quote: "the new benchmark is 53.9" }]).rejected[0].reason, "TARGET_NOT_ACTIVE", "DEC-002 is SUPERSEDED");
	assert.equal(ops([{ op: "SUPERSEDE", target_id: "DEC-002", replacement: { kind: "DEC", title: "t", body: "b", source_ref: "E1", source_quote: "the new benchmark is 53.9" } }]).rejected[0].reason, "TARGET_NOT_ACTIVE");
	assert.equal(ops([{ op: "RESOLVE_CONFLICT", target_id: "CONFLICT-001", resolution: "user chose format B", source_ref: "E2", source_quote: "switching to BF16 KV" }]).rejected.length, 0, "an ACTIVE conflict resolves fine");
});

// ---------------------------------------------------------------------------
// Mutation Guard (P1-③): exact atoms need evidence
// ---------------------------------------------------------------------------

test("atoms: the extractor catches numbers+units, versions, paths, models, hashes, urls, error codes, commands", () => {
	const text = "use npm run build (v1.2.3-beta) at C:\\proj\\lib\\core.js with qwen38-agent, hash 0123456789abcdef0123456789abcdef, see https://x.dev/a 52.31 tok/s error 42";
	const atoms = [...extractExactAtoms(text)].map(normText);
	for (const expected of ["npm run", "v1.2.3-beta", "c:\\proj\\lib\\core.js", "qwen38-agent", "0123456789abcdef0123456789abcdef", "https://x.dev/a", "52.31 tok/s", "42", "error 42"]) {
		assert.ok(atoms.some((a) => a === expected || a.includes(expected)), `atom present: ${expected} — got: ${atoms.join(" | ")}`);
	}
});

test("mutation gate: a drifted number (52.31 → 62.31) without evidence is REJECTED", () => {
	assert.match(mutationGate("52.31 tok/s at 192k", "62.31 tok/s at 192k", E1.text), /62\.31/, "the new value is not in the cited evidence");
	// the same change WITH the value in the evidence passes:
	assert.equal(mutationGate("52.31 tok/s", "62.31 tok/s", "[user]\nmeasured 62.31 tok/s after the patch"), null);
	// unchanged text never triggers:
	assert.equal(mutationGate("52.31 tok/s at 192k", "52.31 tok/s at 192k", "any evidence at all works"), null);
	// removed atoms need no evidence (a legitimate replacement):
	assert.equal(mutationGate("old 9.1 tok/s", "new 12.4 GB", "[user]\nthe new build is 12.4 GB"), null, "the dropped value is not required in evidence");
});

test("ops: AMEND that changes an exact value without backing evidence is rejected (数值不能漂)", () => {
	const plan = ops([
		{ op: "AMEND", target_id: "TECH-001", body: "62.31 tok/s at 192k context", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" }
	]);
	assert.equal(plan.rejected.length, 1);
	assert.equal(plan.rejected[0].reason, "MUTATION_WITHOUT_EVIDENCE");
	assert.match(plan.rejected[0].detail, /62\.31/);
	// …and the SAME amend with the value in the cited message lands:
	const ok = ops([
		{ op: "AMEND", target_id: "TECH-001", body: "53.9 tok/s at 192k context", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" }
	]);
	assert.equal(ok.rejected.length, 0, ok.rejected.map((r) => r.detail).join(","));
	const next = applyOperations(BASE_FILES, ok.applied).nextFiles;
	assert.match(next["TECH.md"], /53\.9 tok\/s at 192k context/);
	assert.ok(!next["TECH.md"].includes("52.31"), "the old value was replaced, not appended");
});

test("ops: ADD with an exact value that the evidence does not carry is rejected", () => {
	const plan = ops([
		{ op: "ADD", kind: "TECH", title: "Fabricated number", body: "44.4 tok/s", source_ref: "E2", source_quote: "noted, switching to BF16 KV" }
	]);
	assert.equal(plan.rejected[0].reason, "MUTATION_WITHOUT_EVIDENCE");
	assert.match(plan.rejected[0].detail, /44\.4/);
});

// ---------------------------------------------------------------------------
// CONFLICT / RESOLVE_CONFLICT lifecycle
// ---------------------------------------------------------------------------

test("ops: CONFLICT mints CONFLICT-NNN; RESOLVE_CONFLICT closes it with a resolution line", () => {
	const c = ops([{ op: "CONFLICT", topic: "KV format", body: "side A: the ledger says format A\nside B: the benchmark says format B", source_ref: "E2", source_quote: "switching to BF16 KV" }]);
	assert.equal(c.rejected.length, 0, c.rejected.map((x) => x.reason).join(","));
	assert.equal(c.applied[0].id, "CONFLICT-002");
	const conflicts = applyOperations(BASE_FILES, c.applied).nextFiles["CONFLICTS.md"];
	assert.match(conflicts, /## \[CONFLICT-002\] KV format[\s\S]*- status: ACTIVE/);

	// plan the resolution against the post-conflict ledger state:
	const after = applyOperations(BASE_FILES, c.applied).nextFiles;
	const r2 = planOperations({ operations: [{ op: "RESOLVE_CONFLICT", target_id: "CONFLICT-002", resolution: "user chose format B after review", source_ref: "E2", source_quote: "switching to BF16 KV" }], history: "" }, { files: after, handles: HANDLES, rows: ROWS });
	assert.equal(r2.rejected.length, 0, r2.rejected.map((x) => x.reason).join(","));
	const done = applyOperations(after, r2.applied).nextFiles["CONFLICTS.md"];
	assert.match(done, /## \[CONFLICT-002\] KV format[\s\S]*- status: RESOLVED[\s\S]*- resolution: user chose format B after review/);
});

// ---------------------------------------------------------------------------
// UPDATE_STATE + NOOP
// ---------------------------------------------------------------------------

test("ops: UPDATE_STATE rewrites STATE-CURRENT (evidence optional); NOOP changes nothing", () => {
	const u = ops([
		{ op: "UPDATE_STATE", title: "benchmarking done", body: "- switched to BF16 KV\n- next: re-run the 192k sweep" }
	]);
	assert.equal(u.rejected.length, 0);
	const state = applyOperations(BASE_FILES, u.applied).nextFiles["STATE.md"];
	assert.match(state, /## \[STATE-CURRENT\] benchmarking done/);
	assert.match(state, /re-run the 192k sweep/);
	assert.ok(!state.includes("profile MTP throughput"), "the old state text was replaced");

	// UPDATE_STATE with evidence offers it — and bad evidence must still reject:
	assert.equal(ops([{ op: "UPDATE_STATE", title: "x", body: "- y", source_ref: "E9", source_quote: "nope" }]).rejected[0].reason, "UNKNOWN_REF");

	const n = ops([{ op: "NOOP", reason: "small talk" }]);
	assert.deepEqual(n.applied.map((a) => a.op.name), ["NOOP"]);
	const out = applyOperations(BASE_FILES, n.applied);
	assert.deepEqual(out.changed, [], "NOOP → no file changes");
	for (const [name, content] of Object.entries(out.nextFiles)) {
		assert.equal(content, BASE_FILES[name], `${name} byte-identical after NOOP`);
	}
});

// ---------------------------------------------------------------------------
// id minting & round-trip rendering
// ---------------------------------------------------------------------------

test("ids: batch minting is sequential and collision-free (max+1 per prefix)", () => {
	const plan = ops([
		{ op: "ADD", kind: "DEC", title: "one", body: "a", source_ref: "E1", source_quote: "the new benchmark is 53.9" },
		{ op: "ADD", kind: "DEC", title: "two", body: "b", source_ref: "E1", source_quote: "the new benchmark is 53.9" },
		{ op: "ADD", kind: "REQ", title: "three", body: "c", source_ref: "E1", source_quote: "the new benchmark is 53.9" }
	]);
	assert.deepEqual(
		plan.applied.map((a) => a.id),
		["DEC-003", "DEC-004", "REQ-002"],
		"DEC continues from DEC-002; REQ from REQ-001"
	);
	const next = applyOperations(BASE_FILES, plan.applied).nextFiles;
	const ids = [...next["DECISIONS.md"].matchAll(/^## \[(DEC-\d+)\]/gm)].map((m) => m[1]);
	assert.equal(new Set(ids).size, ids.length, "no duplicate ids in the rendered file");
});

test("render round-trip: renderFile(parseLedgerFile(x)) is stable for well-formed files", () => {
	for (const [name, content] of Object.entries(BASE_FILES)) {
		const rendered = renderFile(content, parseLedgerFile(content).entries);
		assert.equal(renderFile(rendered, parseLedgerFile(rendered).entries), rendered, `${name} re-renders byte-stably`);
	}
});

// ---------------------------------------------------------------------------
// sync-level: partial commit + HISTORY audit (needs the host packages)
// ---------------------------------------------------------------------------

test("sync (ops contract): 2 valid + 1 rejected → partial commit + audited HISTORY line + sidecar bindings", async () => {
	if (unavailable) return;
	const { LedgerManager, MML_DEFAULTS } = mod;
	const dir = mkdtempSync(join(tmpdir(), "mml-ops-"));
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const ledger = new LedgerManager();
	ledger.ensure(dir, mml);
	// seed the full fixture so id minting starts from the same numbers as
	// the pure tests (ensure() left template files; overwrite them).
	for (const [name, content] of Object.entries(BASE_FILES)) writeFileSync(join(dir, name), content);
	const session = {
		id: "sess-OPS",
		log: [
			{ type: "user/message", seq: 0, data: { role: "user", content: [{ type: "text", text: "the new benchmark is 53.9 tok/s at 192k, quality is more stable" }] } }
		]
	};
	const answer = JSON.stringify({
		operations: [
			{ op: "ADD", kind: "TECH", title: "Benchmark", confidence: 0.95, body: "53.9 tok/s at 192k context", source_ref: "E1", source_quote: "the new benchmark is 53.9 tok/s" },
			{ op: "AMEND", target_id: "DEC-001", body: "use FP8 KV\nReason: quality is more stable at 192k", source_ref: "E1", source_quote: "quality is more stable" },
			{ op: "ADD", kind: "DEC", title: "hallucinated", body: "9.9 tok/s", source_ref: "E5", source_quote: "words that do not exist" }
		],
		history: "one valid add, one amend, one hallucination"
	});
	const result = await ledger.sync(
		{
			calls: () => 1,
			llm: {
				stream: async function* () {
					yield { type: "text-delta", index: 0, text: answer };
					yield { type: "finish", reason: { kind: "stop" } };
				}
			}
		},
		mml,
		dir,
		session,
		{ source: "turns" }
	);
	assert.ok(result.written.includes("DECISIONS.md"), "the valid ops still commit");
	assert.ok(result.written.includes("TECH.md"));
	const history = readFileSync(join(dir, "HISTORY.md"), "utf8");
	assert.match(history, /ops ADD TECH-002, AMEND DEC-001/, "the applied ops are recorded");
	assert.match(history, /rejected UNKNOWN_REF: ADD/, "the rejection + host reason is audited in HISTORY");
	assert.match(history, /model-note: one valid add, one amend, one hallucination/, "the LLM's note is recorded separately from applied ops");
	const tech = readFileSync(join(dir, "TECH.md"), "utf8");
	assert.match(tech, /## \[TECH-002\] Benchmark/);
	assert.ok(!tech.includes("9.9"), "the rejected op wrote nothing");
	const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
	assert.deepEqual(doc.sessions["sess-OPS"]["0"], ["TECH-002", "DEC-001"], "both valid ops bound to seq 0");
	assert.deepEqual(doc.unresolved, {}, "no degraded state");
});
