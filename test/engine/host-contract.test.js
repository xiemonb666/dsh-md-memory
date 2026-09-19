// Version-tolerance contract probe (deliverability audit 2026-09-12).
//
// The engine probes the live host once at mount (constructor, before super)
// and fails loud + actionable when a DSH upgrade breaks the compaction host
// API. These tests pin that behavior.
//
// lib/index.js imports host packages via bare specifiers; in a dev checkout
// those resolve through the project-level node_modules junctions. On a fresh
// clone without those junctions the import cannot succeed — the whole file
// skips cleanly instead of failing.
import { test, skip } from "node:test";
import assert from "node:assert/strict";

let mod;
let importError;
try {
	mod = await import("../../lib/index.js");
} catch (error) {
	importError = error;
}
const unavailable = importError !== undefined;

/** A ctx that satisfies the full HOST_CONTRACT. */
function fullCtx(overrides = {}) {
	return {
		on: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		llm: { resolveModelInfo: async () => null },
		tokenMeter: { estimateMessage: () => 0 },
		sessions: {},
		tools: {},
		agents: { get: () => undefined },
		...overrides
	};
}

if (unavailable) {
	test.skip(`lib/index.js not importable in this checkout (${importError?.message ?? "unknown"}) — engine contract tests skipped`);
}

test("compatible host: real base proto + full ctx → no problems", () => {
	if (unavailable) return;
	const { hostContractProblems, MarkdownMemoryCompactionEngine } = mod;
	const baseProto = Object.getPrototypeOf(MarkdownMemoryCompactionEngine.prototype);
	assert.equal(typeof hostContractProblems, "function");
	assert.deepEqual(hostContractProblems(fullCtx(), baseProto), []);
});

test("base proto missing a super-called method → reported", () => {
	if (unavailable) return;
	const { hostContractProblems } = mod;
	const baseProto = { compactNow: () => {} }; // compactIfNeeded gone
	const problems = hostContractProblems(fullCtx(), baseProto);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /compactIfNeeded/);
});

test("ctx missing a required service → reported", () => {
	if (unavailable) return;
	const { hostContractProblems, MarkdownMemoryCompactionEngine } = mod;
	const baseProto = Object.getPrototypeOf(MarkdownMemoryCompactionEngine.prototype);
	assert.deepEqual(hostContractProblems(fullCtx({ tokenMeter: undefined }), baseProto), ["ctx.tokenMeter is missing"]);
});

test("tokenMeter without estimateMessage → shadow-price contract violation reported", () => {
	if (unavailable) return;
	const { hostContractProblems, MarkdownMemoryCompactionEngine } = mod;
	const baseProto = Object.getPrototypeOf(MarkdownMemoryCompactionEngine.prototype);
	const problems = hostContractProblems(fullCtx({ tokenMeter: {} }), baseProto);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /estimateMessage/);
});

test("mismatch error is actionable (points at the stock engine recovery)", () => {
	if (unavailable) return;
	const { hostContractMismatchError } = mod;
	const error = hostContractMismatchError(["ctx.tokenMeter is missing"]);
	assert.ok(error instanceof Error);
	assert.match(error.message, /host contract mismatch/);
	assert.match(error.message, /dsh-compaction-basic/);
});

test("constructor throws on a broken contract, BEFORE the stock engine constructor runs", () => {
	if (unavailable) return;
	const { MarkdownMemoryCompactionEngine } = mod;
	// The probe runs before super(); a ctx missing tokenMeter must throw at the
	// probe — the stock BasicCompactionEngine constructor (which would throw on
	// a fake ctx) is never reached, so no config/base-side error can mask it.
	try {
		new MarkdownMemoryCompactionEngine(fullCtx({ tokenMeter: undefined }), {});
		assert.fail("expected the contract probe to throw");
	} catch (error) {
		assert.match(String(error.message), /host contract mismatch/);
		assert.match(String(error.message), /dsh-compaction-basic/);
	}
	// Sanity: the probe is the gate — with the same ctx plus tokenMeter the
	// constructor gets PAST the probe (enabled: false stops it right after
	// preset provisioning, before any mount side effects; a failure, if any,
	// must not be the contract error).
	try {
		new MarkdownMemoryCompactionEngine(fullCtx(), { enabled: false });
	} catch (error) {
		assert.doesNotMatch(String(error.message), /host contract mismatch/);
	}
});
