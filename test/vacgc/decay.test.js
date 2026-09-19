/**
 * Recency / turn decay (plan §21–23).
 * R = 0.75·exp(−ageTurns/τturn) + 0.25·exp(−ageMinutes/τtime); V1 τtime = 30·τturn.
 * Time acts ONLY on recency — never on intrinsic importance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recencyOf, contentTypeOf } from "../../lib/vacgc/features.js";

const NOW = 1_000_000_000_000;
const unit = (over = {}) => ({ createdAt: NOW, turnsAfter: 0, text: "", kind: "assistant", ...over });

test("fresh unit (0 turns, 0 min) has R = 1", () => {
	const { R } = recencyOf(unit(), "assistant-reasoning", NOW);
	assert.equal(R, 1);
});

test("one τ of turn age: turn component is e^-1 (≈0.3679)", () => {
	// assistant-reasoning τturn = 16; ageTurns 16, ageMinutes 0.
	const { R, turnDecay, timeDecay } = recencyOf(unit({ turnsAfter: 16 }), "assistant-reasoning", NOW);
	assert.ok(Math.abs(turnDecay - Math.exp(-1)) < 1e-12);
	assert.equal(timeDecay, 1);
	assert.ok(Math.abs(R - (0.75 * Math.exp(-1) + 0.25)) < 1e-12);
});

test("recency decays monotonically with turn age", () => {
	const at = (turns) => recencyOf(unit({ turnsAfter: turns }), "assistant-reasoning", NOW).R;
	assert.ok(at(0) > at(4));
	assert.ok(at(4) > at(16));
	assert.ok(at(16) > at(64));
});

test("time decay bites on stale wall clock even with 0 turn age", () => {
	// τtime = 16 turns × 30 min = 480 min. Age 480 min, 0 turns.
	const aged = unit({ createdAt: NOW - 480 * 60000, turnsAfter: 0 });
	const { R } = recencyOf(aged, "assistant-reasoning", NOW);
	assert.ok(Math.abs(R - (0.75 + 0.25 * Math.exp(-1))) < 1e-12);
});

test("τ = ∞ (hard-constraint) never decays by turns", () => {
	const { R, turnDecay } = recencyOf(unit({ turnsAfter: 10_000 }), "hard-constraint", NOW);
	assert.equal(turnDecay, 1);
	assert.ok(R > 0.99);
});

test("benchmark content type decays much slower (τ=80)", () => {
	const at = (turns) => recencyOf(unit({ turnsAfter: turns }), "benchmark", NOW).R;
	// 40 turns: assistant is e^-2.5 ≈ 0.082; benchmark is e^-0.5 ≈ 0.607.
	assert.ok(at(40) > recencyOf(unit({ turnsAfter: 40 }), "assistant-reasoning", NOW).R * 2);
	assert.ok(at(80) > 0.5);
});

test("contentTypeOf: the §13/§22/§27 table lanes", () => {
	assert.equal(contentTypeOf({ kind: "user", text: "你好" }), "greeting");
	assert.equal(contentTypeOf({ kind: "user", text: "帮我修一下" }), "user-request");
	assert.equal(contentTypeOf({ kind: "assistant", text: "thinking" }), "assistant-reasoning");
	assert.equal(contentTypeOf({ kind: "checkpoint", text: "s" }), "checkpoint");
	assert.equal(contentTypeOf({ kind: "injected", text: "s" }), "injected");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "read", toolArgs: "C:\\x\\test.js", text: "contents" }), "file-read");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "glob", toolArgs: "**/*.js", text: "files" }), "dir-listing");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "grep", toolArgs: "foo", text: "hits" }), "search-result");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "web_search", toolArgs: "q", text: "results" }), "web-search");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "git status", text: "On branch main\nnothing to commit" }), "git-status");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "git diff", text: "diff --git a/x b/x" }), "git-diff");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "node --test test/", text: "passing 42" }), "test-log");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "bench", text: "基准 p95 延迟 42ms 吞吐 1200 tokens/s" }), "benchmark");
	const bigBuild = ("error TS2345: argument of type 'x' is not assignable\n").repeat(20);
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "pnpm build", text: bigBuild }), "build-log");
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "pwsh", toolArgs: "ls", text: "short" }), "tool-log");
	// a `read` of test.js is still a file read (name lanes win)
	assert.equal(contentTypeOf({ kind: "tool-pair", toolName: "read", toolArgs: "C:\\x\\test.js", text: "passing 42" }), "file-read");
});
