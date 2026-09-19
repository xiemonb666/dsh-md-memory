/**
 * VAC-GC Phase 2a — manual compact guard (pure decision module).
 * spanTokens prices an inclusive seq range; shouldSkipManualCompact decides
 * whether a manual /compact summarizer call is worth making at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_MANUAL_COMPACT_SPAN_TOKENS, spanTokens, shouldSkipManualCompact } from "../../lib/vacgc/manual-compact.js";

const nodes = [
	{ seq: 1, tokens: 100 },
	{ seq: 2, tokens: 200 },
	{ seq: 5, tokens: 400 }, // gapped surface — spliced/pruned seqs are legal
	{ seq: 9, tokens: 1000 }
];

test("spanTokens: sums only nodes inside the inclusive range (seq-based, gaps ok)", () => {
	assert.equal(spanTokens(nodes, { start: 1, end: 9 }), 1700);
	assert.equal(spanTokens(nodes, { start: 1, end: 2 }), 300);
	assert.equal(spanTokens(nodes, { start: 5, end: 9 }), 1400);
	assert.equal(spanTokens(nodes, { start: 2, end: 4 }), 200); // gap inside the range
	assert.equal(spanTokens(nodes, { start: 3, end: 4 }), 0); // range over a gap
	assert.equal(spanTokens([], { start: 1, end: 9 }), 0);
	assert.equal(spanTokens(nodes, null), 0);
	assert.equal(spanTokens(nodes, undefined), 0);
});

test("shouldSkipManualCompact: a null range is never skippable (base reports it)", () => {
	assert.equal(shouldSkipManualCompact(nodes, null), false);
	assert.equal(shouldSkipManualCompact(nodes, undefined), false);
});

test("shouldSkipManualCompact: spans below the minimum skip, at/above proceed", () => {
	assert.equal(MIN_MANUAL_COMPACT_SPAN_TOKENS, 1024);
	assert.equal(shouldSkipManualCompact(nodes, { start: 1, end: 2 }), true); // 300 < 1024
	assert.equal(shouldSkipManualCompact(nodes, { start: 1, end: 9 }), false); // 1700 >= 1024
	// exactly the minimum is worth compacting (strict <)
	assert.equal(shouldSkipManualCompact([{ seq: 1, tokens: 1024 }], { start: 1, end: 1 }), false);
	assert.equal(shouldSkipManualCompact([{ seq: 1, tokens: 1023 }], { start: 1, end: 1 }), true);
	// a zero-sum span (range over a gap) is skippable — nothing to summarize
	assert.equal(shouldSkipManualCompact(nodes, { start: 3, end: 4 }), true);
	// the user's real-world case: a 3-message session, ~235-token span
	assert.equal(shouldSkipManualCompact([{ seq: 1, tokens: 235 }], { start: 1, end: 1 }), true);
});

test("shouldSkipManualCompact: custom minimum honored (strict <)", () => {
	assert.equal(shouldSkipManualCompact(nodes, { start: 1, end: 2 }, 350), true); // 300 < 350
	assert.equal(shouldSkipManualCompact(nodes, { start: 1, end: 2 }, 300), false); // 300 == 300
	assert.equal(shouldSkipManualCompact(nodes, { start: 1, end: 2 }, 250), false); // 300 > 250
});
