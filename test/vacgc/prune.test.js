/**
 * VAC-GC Fresh/Micro Prune (plan §43/§47–§52, §119, STEP 9) — dry-run tests.
 * All pure: reducers + planFreshPrune, no session mutation, no LLM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reduceToolResult, planFreshPrune, isPrunableToolUnit, extractExactFacts, PRUNE_MIN_LINES } from "../../lib/vacgc/prune.js";

/** A tool-pair unit text: [tool-calls] header + result body (the units.js layout). */
const pair = (tool, args, bodyLines) => `[tool-calls] ${tool} ${args}\n${bodyLines.join("\n")}`;

/** Build a large noisy body (≥ PRUNE_MIN_LINES). */
const noise = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} filler line ${String(i + 1).padStart(3, "0")} with some padding words to stretch the width`);

test("§48 bash: keep Command/Exit Code/Primary Errors/Warnings/Last lines/Raw pointer", () => {
	const body = [
		...noise(20, "stdout"),
		"error: cannot open file C:\\work\\data.md",
		"Exception: ECONNRESET connection reset",
		"error: second failure at line 42",
		"warning: deprecated flag -x",
		...noise(30, "more stdout"),
		"warning: disk almost full",
		"final summary line",
		"exit code: 2"
	];
	const text = pair("pwsh", "Get-Process", body);
	const { reduced, shrank } = reduceToolResult("pwsh", text, "Get-Process");
	assert.equal(shrank, true, "large result is reduced");
	assert.ok(reduced.length < text.length);
	// §48 keep list
	assert.ok(reduced.startsWith("[tool-calls] pwsh Get-Process"), "Command (header) preserved verbatim");
	assert.match(reduced, /Exit Code: 2/, "exit code kept");
	assert.ok(reduced.includes("error: cannot open file C:\\work\\data.md"), "primary error kept verbatim");
	assert.ok(reduced.includes("Exception: ECONNRESET connection reset"), "exception kept verbatim");
	assert.ok(reduced.includes("warning: deprecated flag -x"), "warning kept");
	assert.ok(reduced.includes("final summary line"), "last relevant line kept");
	assert.match(reduced, /raw: [0-9a-f]+ \(\d+ lines, reconstructible\)/, "raw pointer with fingerprint");
	// the noise mass is gone
	assert.ok(!reduced.includes("filler line 007"));
	// §65 spirit: the exit-code fact still extracts from the reduced text
	assert.ok([...extractExactFacts(reduced)].some((f) => /exit code: 2/i.test(f)), "exit-code fact survives reduction");
});

test("§49 tests: keep counts/first failure/stack origin/exit code; drop repeated success cases", () => {
	const body = [
		...noise(20, "out"),
		"✔ case alpha works",
		"✔ case alpha works",
		"✔ case alpha works",
		"✔ case beta works",
		"✗ case gamma fails",
		"AssertionError: expected 1 to be 2",
		"    at test/gamma.test.js:14:8",
		...noise(25, "out"),
		"42 passing (1.5s)",
		"3 failing",
		"1 skipped",
		"exit code: 1"
	];
	const text = pair("test", "npm test", body);
	const { reduced, shrank } = reduceToolResult("test", text, "npm test");
	assert.equal(shrank, true);
	assert.match(reduced, /Results: passed: 42, failed: 3, skipped: 1/, "counts kept");
	assert.match(reduced, /Exit Code: 1/, "exit code kept");
	assert.ok(reduced.includes("✗ case gamma fails"), "first failure kept");
	assert.ok(reduced.includes("at test/gamma.test.js:14:8"), "stack origin kept");
	assert.ok(reduced.includes("case alpha works"), "unique success case kept");
	assert.ok(!reduced.includes("filler line 020"), "noise dropped");
	// the repeated success line must appear exactly once in the reduced text
	const occurrences = reduced.split("case alpha works").length - 1;
	assert.equal(occurrences, 1, "repeated success cases deduplicated");
	assert.ok(reduced.includes("duplicated dropped") || reduced.includes("3"), "duplicate count reported");
});

test("§50 git diff: keep files changed/line counts/hunks/symbols; raw reconstructible", () => {
	const body = [
		"diff --git a/src/a.js b/src/a.js",
		"--- a/src/a.js",
		"+++ b/src/a.js",
		"@@ -10,7 +10,12 @@ function before()",
		"+export function addedFn(a) {",
		"+  return a + 1;",
		"+}",
		"@@ -30,5 +35,9 @@",
		"-const oldVal = 1;",
		"+const newVal = 2;",
		...noise(40, "diff"),
		"diff --git a/src/b.js b/src/b.js",
		"@@ -1,3 +1,4 @@",
		"+class Added {",
		"diff --git a/src/c.js b/src/c.js",
		"@@ -1,1 +1,1 @@",
		"-x",
		"+y",
		"3 files changed, 42 insertions(+), 7 deletions(-)"
	];
	const text = pair("git", "diff --stat", body);
	const { reduced, shrank } = reduceToolResult("git diff", text, "diff --stat");
	assert.equal(shrank, true);
	assert.ok(reduced.includes("3 files changed"), "files changed kept");
	assert.match(reduced, /line counts: \+\d+ -\d+/, "add/del line counts kept");
	assert.ok(reduced.includes("@@ -10,7 +10,12 @@ function before()"), "hunk header kept");
	assert.ok(reduced.includes("export function addedFn(a) {"), "symbol kept");
	assert.ok(reduced.includes("class Added {"), "class symbol kept");
	assert.match(reduced, /raw: [0-9a-f]+ \(\d+ lines, reconstructible\)/, "raw diff is reconstructible → pointer");
	assert.ok(!reduced.includes("filler line 030"), "hunk mass dropped");
});

test("§51 file read: keep path/hash/symbols/range; old full content can exit", () => {
	const body = [
		"import { x } from \"./x\";",
		"export function entryPoint() {",
		"  return x;",
		"}",
		...noise(50, "content"),
		"export class Service {",
		"  run() {}",
		"}",
		"export const LIMIT = 100;"
	];
	const text = pair("read", "C:\\work\\src\\index.js", body);
	const { reduced, shrank } = reduceToolResult("read", text, "C:\\work\\src\\index.js");
	assert.equal(shrank, true);
	assert.ok(reduced.includes("path: C:\\work\\src\\index.js"), "path kept");
	assert.match(reduced, /hash: [0-9a-f]+/, "content hash kept");
	assert.ok(reduced.includes("export function entryPoint() {"), "symbol kept");
	assert.ok(reduced.includes("export class Service {"), "class kept");
	assert.match(reduced, /range: lines 1-\d+/, "important range kept");
	assert.ok(!reduced.includes("content filler line 025"), "full old content exits context");
});

test("§52 search: dedupe by path:line:symbol:match — repeats dropped, uniques kept", () => {
	// 4 unique matches, each repeated 8× = 32 lines of repeated matches (the
	// realistic search shape: the mass IS the duplicates)
	const body = [];
	for (let i = 0; i < 8; i++) body.push(
		"src/a.js:10:export function foo() {",
		"src/b.js:20:call foo()",
		"src/c.js:5:foo()",
		"src/d.js:99:foo();"
	);
	const text = pair("grep", "foo src/", body);
	const { reduced, shrank } = reduceToolResult("grep", text, "foo src/");
	assert.equal(shrank, true);
	assert.match(reduced, /Matches \(4, 28 duplicates dropped\)/, "duplicate count reported");
	const matchLines = reduced.split("\n").filter((l) => l.trim().startsWith("src/"));
	assert.equal(matchLines.length, 4, "only the 4 unique matches survive");
	assert.ok(reduced.includes("src/a.js:10:export function foo() {"));
	assert.match(reduced, /raw: [0-9a-f]+/, "raw pointer present");
});

test("small results pass through unchanged — no churn (rewriteCost, §59)", () => {
	const text = pair("pwsh", "ls", noise(5, "out"));
	const { reduced, shrank } = reduceToolResult("pwsh", text, "ls");
	assert.equal(shrank, false);
	assert.equal(reduced, text, "byte-identical — nothing to rewrite");
});

test("unknown tool: generic fallback keeps exit code/errors/head/tail + pointer", () => {
	const body = [...noise(15, "raw"), "Fatal: something exploded", ...noise(30, "raw"), "exit code: 3", "done"];
	const text = pair("custom-tool", "--flag", body);
	const { reduced, shrank } = reduceToolResult("custom-tool", text, "--flag");
	assert.equal(shrank, true);
	assert.match(reduced, /Exit Code: 3/);
	assert.ok(reduced.includes("Fatal: something exploded"));
	assert.ok(reduced.includes("Head:") && reduced.includes("Last lines:"));
	assert.match(reduced, /raw: [0-9a-f]+/);
});

test("§119 planFreshPrune: TRASH-only scope, hard gate, duplicate removal, reduce — a pure dry-run diff", () => {
	const largeBash = pair("pwsh", "Get-Process", [...noise(25, "a"), "error: boom", "exit code: 2", ...noise(25, "b")]);
	const smallTool = pair("pwsh", "ls", noise(4, "tiny"));
	const dupA = pair("test", "npm test", [...noise(6, "s"), "1 passing"]);
	const units = [
		{ unitId: "u1", kind: "tool-pair", toolName: "pwsh", toolArgs: "Get-Process", text: largeBash, tier: "TRASH", protection: "NORMAL", tokens: 900 },
		{ unitId: "u2", kind: "tool-pair", toolName: "test", toolArgs: "npm test", text: dupA, tier: "TRASH", protection: "NORMAL", tokens: 60 },
		{ unitId: "u3", kind: "tool-pair", toolName: "test", toolArgs: "npm test", text: dupA, tier: "TRASH", protection: "NORMAL", tokens: 60 }, // duplicate of u2
		{ unitId: "u4", kind: "tool-pair", toolName: "pwsh", toolArgs: "ls", text: smallTool, tier: "TRASH", protection: "NORMAL", tokens: 30 },
		{ unitId: "u5", kind: "tool-pair", toolName: "pwsh", toolArgs: "big", text: largeBash, tier: "WARM", protection: "NORMAL", tokens: 900 }, // not TRASH
		{ unitId: "u6", kind: "tool-pair", toolName: "pwsh", toolArgs: "big", text: largeBash, tier: "TRASH", protection: "P1", tokens: 900 }, // hard gate
		{ unitId: "u7", kind: "tool-pair", toolName: "pwsh", toolArgs: "big", text: largeBash, tier: "TRASH", protection: "P0", tokens: 900 }, // hard gate
		{ unitId: "u8", kind: "tool-pair", open: true, toolName: "pwsh", toolArgs: "big", text: largeBash, tier: "TRASH", protection: "NORMAL", tokens: 900 }, // open-tail
		{ unitId: "u9", kind: "user", text: [...noise(40, "user")].join("\n"), tier: "TRASH", protection: "NORMAL", tokens: 400 } // not a tool unit
	];
	const plan = planFreshPrune(units);
	assert.equal(plan.mode, "fresh-prune");
	const kinds = plan.actions.map((a) => `${a.kind}:${a.unitId}`);
	assert.deepEqual(kinds, ["reduce:u1", "drop:u3"], "exactly: u1 reduced, u3 (the LATER duplicate) dropped");
	const drop = plan.actions.find((a) => a.kind === "drop");
	assert.equal(drop.reason, "duplicate of u2");
	assert.equal(drop.reclaim, 60, "dropping the whole pair reclaims its tokens");
	const red = plan.actions.find((a) => a.kind === "reduce");
	assert.equal(red.before, 900);
	assert.ok(red.after < 900 && red.reclaim > 0, "reduction reclaims tokens");
	assert.ok(red.reducedText.length < largeBash.length, "replacement text is the reduced form");
	assert.equal(plan.totalReclaim, 60 + red.reclaim);
	// untouched = u2 (kept first duplicate, small — no reduction), u4 (small),
	// u5 (WARM), u6 (P1), u7 (P0), u8 (open-tail), u9 (not a tool unit)
	assert.deepEqual(plan.stats, { scanned: 9, trashTools: 4, reduced: 1, dropped: 1, untouched: 7 });
});

test("§119 invariants: never touch non-TRASH / protected / open units — even huge duplicates", () => {
	const huge = pair("pwsh", "x", noise(120, "massive"));
	const plan = planFreshPrune([
		{ unitId: "w1", kind: "tool-pair", toolName: "pwsh", text: huge, tier: "WARM", protection: "NORMAL", tokens: 5000 },
		{ unitId: "w2", kind: "tool-pair", toolName: "pwsh", text: huge, tier: "HOT", protection: "NORMAL", tokens: 5000 },
		{ unitId: "p1", kind: "tool-pair", toolName: "pwsh", text: huge, tier: "TRASH", protection: "P0_TRANSIENT", tokens: 5000 },
		{ unitId: "o1", kind: "tool-pair", open: true, toolName: "pwsh", text: huge, tier: "TRASH", protection: "NORMAL", tokens: 5000 }
	]);
	assert.equal(plan.actions.length, 0, "Phase 2 makes NO action outside closed TRASH NORMAL tool units");
	assert.equal(plan.totalReclaim, 0);
});

test("§43 allowDrop gate: Z0 reduces but never drops — later duplicates stay (and can still be reduced)", () => {
	const body = [...noise(20, "x"), "error: e1", "exit code: 1", ...noise(20, "y")];
	const text = pair("pwsh", "cmd", body);
	const units = [
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500 },
		{ unitId: "b", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500 }
	];
	const z0 = planFreshPrune(units, { allowDrop: false });
	assert.deepEqual(z0.actions.map((a) => `${a.kind}:${a.unitId}`), ["reduce:a", "reduce:b"], "no drops; both large copies still get the fresh reduction");
	assert.equal(z0.stats.dropped, 0);
	assert.equal(z0.stats.reduced, 2);
	const z1 = planFreshPrune(units); // default allowDrop true
	assert.deepEqual(z1.actions.map((a) => `${a.kind}:${a.unitId}`), ["reduce:a", "drop:b"]);
});

test("recent-floor unit without reconstructibility is never pruned (floor default: absolute)", () => {
	const text = pair("pwsh", "cmd", noise(40, "fresh"));
	const plan = planFreshPrune([
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, inRecentFloor: true }
	]);
	assert.equal(plan.actions.length, 0, "floor-protected TRASH tool unit (X unknown → 0) is untouched");
	assert.deepEqual(plan.stats, { scanned: 1, trashTools: 1, reduced: 0, dropped: 0, untouched: 1 });
});

// --- recent-floor tool-garbage bypass (review 2026-09-12, P0) ---------------
// The floor is SEMANTIC: reconstructible (X ≥ floorBypassX) TRASH tool output
// inside the floor is reduce-only prunable ("recent ≠ valuable"); whole-unit
// removal and everything non-tool stay absolutely floor-protected.

test("floor bypass: a reconstructible TRASH tool unit inside the floor is REDUCE-ONLY", () => {
	const text = pair("pwsh", "cmd", noise(40, "fresh"));
	const plan = planFreshPrune([
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, inRecentFloor: true, reconstructibility: 0.95 }
	]);
	assert.deepEqual(plan.actions.map((a) => `${a.kind}:${a.unitId}`), ["reduce:a"], "bypassed floor unit is reduced, never dropped");
	assert.equal(plan.stats.reduced, 1);
	assert.equal(plan.stats.dropped, 0);
});

test("floor bypass: low-reconstructibility floor unit stays absolutely protected", () => {
	const text = pair("pwsh", "cmd", noise(40, "fresh"));
	const plan = planFreshPrune([
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, inRecentFloor: true, reconstructibility: 0.3 }
	]);
	assert.equal(plan.actions.length, 0, "X < floorBypassX (0.80) → the floor is absolute");
	assert.deepEqual(plan.stats, { scanned: 1, trashTools: 1, reduced: 0, dropped: 0, untouched: 1 });
});

test("floor bypass: floorBypassX=0 restores the old absolute floor", () => {
	const text = pair("pwsh", "cmd", noise(40, "fresh"));
	const plan = planFreshPrune(
		[{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, inRecentFloor: true, reconstructibility: 0.95 }],
		{ floorBypassX: 0 }
	);
	assert.equal(plan.actions.length, 0, "bypassX=0 → no bypass");
	assert.equal(plan.stats.untouched, 1);
});

test("floor bypass: a floor DUPLICATE is reduced, never dropped (drop stays absolute-floor-protected)", () => {
	const text = pair("pwsh", "cmd", noise(40, "fresh"));
	const plan = planFreshPrune([
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, reconstructibility: 0.95 },
		{ unitId: "b", kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 500, inRecentFloor: true, reconstructibility: 0.95 }
	]);
	assert.deepEqual(plan.actions.map((a) => `${a.kind}:${a.unitId}`), ["reduce:a", "reduce:b"], "the floor duplicate keeps its reduced presence");
	assert.equal(plan.stats.dropped, 0, "whole-unit removal never bypasses the floor");
});

test("isPrunableToolUnit: closed tool-pair and orphan result only", () => {
	assert.equal(isPrunableToolUnit({ kind: "tool-pair" }), true);
	assert.equal(isPrunableToolUnit({ kind: "tool-result" }), true);
	assert.equal(isPrunableToolUnit({ kind: "tool-pair", open: true }), false, "open-tail pair is P0_TRANSIENT territory");
	assert.equal(isPrunableToolUnit({ kind: "user" }), false);
	assert.equal(isPrunableToolUnit({ kind: "assistant" }), false);
	assert.equal(isPrunableToolUnit(null), false);
});

test("scale: 400-unit surface (maxUnitsInPlan) — O(surface units), correct stats, bounded time", () => {
	// 300 unique large TRASH pairs + 100 exact duplicates of the first 100.
	const units = [];
	for (let i = 0; i < 300; i += 1) {
		const text = pair("pwsh", `cmd-${i}`, Array.from({ length: 40 }, (_, j) => `log line ${i}:${j} padding padding padding`));
		units.push({ unitId: `u-${i}`, kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 1000 });
	}
	for (let i = 0; i < 100; i += 1) {
		const text = pair("pwsh", `cmd-${i}`, Array.from({ length: 40 }, (_, j) => `log line ${i}:${j} padding padding padding`));
		units.push({ unitId: `dup-${i}`, kind: "tool-pair", toolName: "pwsh", text, tier: "TRASH", protection: "NORMAL", tokens: 1000 });
	}
	const startedAt = Date.now();
	const plan = planFreshPrune(units);
	const elapsed = Date.now() - startedAt;
	assert.equal(plan.stats.scanned, 400);
	assert.equal(plan.stats.reduced, 300, "every unique large pair is reduced");
	assert.equal(plan.stats.dropped, 100, "every later duplicate is dropped whole");
	assert.equal(plan.stats.untouched, 0);
	assert.equal(plan.actions.length, 400);
	assert.ok(plan.totalReclaim > 0);
	assert.ok(elapsed < 10000, `planFreshPrune stayed bounded (took ${elapsed}ms)`);
});

test("determinism: same input → byte-identical plan (twice)", () => {
	const body = [...noise(20, "x"), "error: e1", "exit code: 1", ...noise(20, "y")];
	const units = [
		{ unitId: "a", kind: "tool-pair", toolName: "pwsh", text: pair("pwsh", "cmd", body), tier: "TRASH", protection: "NORMAL", tokens: 500 },
		{ unitId: "b", kind: "tool-pair", toolName: "pwsh", text: pair("pwsh", "cmd", body), tier: "TRASH", protection: "NORMAL", tokens: 500 }
	];
	const a = planFreshPrune(units);
	const b = planFreshPrune(units);
	assert.deepEqual(a, b, "byte-identical (incl. reducedText + fingerprints)");
});
