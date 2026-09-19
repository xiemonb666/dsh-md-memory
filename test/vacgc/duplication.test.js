/**
 * Duplication (plan §29–30): fingerprint dedup, near-dup line overlap, and
 * repeated file re-reads (keep first + newest, demote middles).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicationOf, markRepeatedReadMiddles } from "../../lib/vacgc/features.js";
import { fingerprint } from "../../lib/vacgc/text.js";

const state = () => ({ byFingerprint: new Set(), byGroup: new Map(), readMiddles: new Set() });
const unit = (over = {}) => ({
	id: "u-x", kind: "tool-pair", seqs: [1], tokens: 100, turnsAfter: 0, createdAt: 0,
	text: "", toolName: "read", toolArgs: "", toolArgsKey: "read:1", terms: {}, open: false, ...over
});

test("exact duplicate (volatile timestamps differ) scores 1.0", () => {
	const s = state();
	duplicationOf(unit({ text: "build ok at 2026-09-03T10:00:00Z id=abc" }), s);
	const { score, note } = duplicationOf(unit({ text: "build ok at 2027-01-01T00:00:00Z id=xyz" }), s);
	// same after normalization? "id=abc" vs "id=xyz" differ → NOT exact.
	assert.ok(score < 1);
	// true exact: only the volatile timestamp differs
	const s2 = state();
	duplicationOf(unit({ text: "build ok at 2026-09-03T10:00:00Z" }), s2);
	const exact = duplicationOf(unit({ text: "build ok at 2027-01-01T00:00:00Z" }), s2);
	assert.equal(exact.score, 1.0);
	assert.equal(exact.note, "exact duplicate");
	assert.equal(fingerprint("build ok at 2026-09-03T10:00:00Z"), fingerprint("build ok at 2027-01-01T00:00:00Z"));
});

test("near-dup scores 0.5 × line-set overlap of the earlier version", () => {
	const s = state();
	const first = unit({ toolArgsKey: "pwsh:k", text: "l1\nl2\nl3\nl4" });
	const near = unit({ toolArgsKey: "pwsh:k", text: "l1\nl2\nl3\nXX" });
	duplicationOf(first, s);
	const { score } = duplicationOf(near, s);
	// jaccard 3/5 = 0.6 → 0.30
	assert.ok(Math.abs(score - 0.3) < 1e-12, `score=${score}`);
});

test("distinct tool groups do not cross-contaminate", () => {
	const s = state();
	duplicationOf(unit({ toolArgsKey: "a:1", text: "l1\nl2" }), s);
	// same line-set similarity as the in-group near-dup case, but a DIFFERENT
	// group → only an exact fingerprint could still score; it must be 0
	const { score } = duplicationOf(unit({ toolArgsKey: "b:2", text: "l1\nXX" }), s);
	assert.equal(score, 0);
});

test("repeated file reads: middles get 0.8, first and newest are spared (§30)", () => {
	const path = "c:\\x\\big.js";
	const read = (n) => unit({
		id: `u-${n}`,
		toolName: "read",
		toolArgs: path,
		toolArgsKey: `read:${n}`,
		seqs: [n],
		text: `read ${n} of big.js\nline one\nline two\nversion ${n}`,
		terms: { paths: [path] }
	});
	const r1 = read(1);
	const r2 = read(2);
	const r3 = read(3);
	// pre-pass over the full unit list (the planner's order of operations)
	const s = { ...state(), readMiddles: markRepeatedReadMiddles([r1, r2, r3]) };
	const a = duplicationOf(r1, s);
	const b = duplicationOf(r2, s);
	const c = duplicationOf(r3, s);
	assert.equal(a.score, 0, "first read is never a duplicate");
	assert.equal(b.score, 0.8, `middle of 3 reads flagged (got ${b.score})`);
	assert.ok(b.note.includes("middle re-read"));
	assert.equal(c.score, 0, "newest read keeps full value");
});

test("two reads of a file are both kept (no middle exists)", () => {
	const path = "c:\\x\\two.js";
	const read = (n) => unit({
		id: `u-${n}`, toolName: "read", toolArgs: path, toolArgsKey: `read:${n}`, seqs: [n],
		text: `read ${n}\na\nb`, terms: { paths: [path] }
	});
	const r1 = read(1);
	const r2 = read(2);
	const s = { ...state(), readMiddles: markRepeatedReadMiddles([r1, r2]) };
	assert.equal(duplicationOf(r1, s).score, 0);
	assert.equal(duplicationOf(r2, s).score, 0);
});

test("markRepeatedReadMiddles: only read tools, only runs of 3+, only middles", () => {
	const path = "c:\\x\\many.js";
	const read = (n) => unit({ id: `u-r${n}`, toolName: "read", toolArgs: path, toolArgsKey: `read:${n}`, seqs: [n], text: `v${n}`, terms: { paths: [path] } });
	const grep = unit({ id: "u-g1", toolName: "grep", toolArgs: path, toolArgsKey: "grep:x", seqs: [99], text: "g", terms: { paths: [path] } });
	const other = unit({ id: "u-o1", toolName: "read", toolArgs: "c:\\x\\other.js", toolArgsKey: "read:o", seqs: [100], text: "o", terms: { paths: ["c:\\x\\other.js"] } });
	const units = [read(1), read(2), read(3), read(4), grep, other];
	const marks = markRepeatedReadMiddles(units);
	assert.deepEqual([...marks].sort(), ["u-r2", "u-r3"]);
});

test("user units are not grouped against each other", () => {
	const s = state();
	const u1 = unit({ kind: "user", text: "请帮我做一件事" });
	const u2 = unit({ kind: "user", text: "请帮我做一件事" });
	// exact text → exact fingerprint dedup applies regardless of kind
	assert.equal(duplicationOf(u1, s).score, 0);
	assert.equal(duplicationOf(u2, s).score, 1.0);
});
