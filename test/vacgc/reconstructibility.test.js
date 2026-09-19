/**
 * Intrinsic importance + reconstructibility (plan §13, §27) and the
 * extractFeatures() vector assembly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, intrinsicOf, sizePenaltyOf } from "../../lib/vacgc/features.js";
import { fakeMemory } from "./helpers.js";

const NOW = 1_000_000_000_000;
const dupState = () => ({ byFingerprint: new Set(), byGroup: new Map(), readMiddles: new Set() });

test("intrinsic table values (§13)", () => {
	const cases = [
		["greeting", 0.02],
		["tool-log", 0.15],
		["build-log", 0.2],
		["search-result", 0.3],
		["file-read", 0.3],
		["web-search", 0.3],
		["git-status", 0.3],
		["git-diff", 0.3],
		["test-log", 0.35],
		["user-request", 0.35],
		["assistant-reasoning", 0.55],
		["file-relation", 0.75],
		["key-fix", 0.8],
		["root-cause", 0.82],
		["benchmark", 0.85],
		["checkpoint", 0.9],
		["blocker", 0.95],
		["goal", 0.95],
		["active-decision", 0.98],
		["hard-constraint", 1.0]
	];
	for (const [type, intrinsic] of cases) {
		assert.equal(intrinsicOf({}, type, { protection: "NORMAL", reasons: [] }).intrinsic, intrinsic, type);
	}
});

test("reconstructibility X (§27): re-runnable outputs are cheap to lose", () => {
	const cases = [
		["git-status", 1.0],
		["dir-listing", 1.0],
		["greeting", 1.0],
		["injected", 1.0],
		["file-read", 0.95],
		["git-diff", 0.95],
		["search-result", 0.9],
		["build-log", 0.9],
		["tool-log", 0.9],
		["test-log", 0.85],
		["web-search", 0.7],
		["benchmark", 0.35],
		["assistant-reasoning", 0.3],
		["user-request", 0.0],
		["hard-constraint", 0.0],
		["active-decision", 0.1]
	];
	for (const [type, x] of cases) {
		const { features } = extractFeatures({ kind: "user", text: "hi", seqs: [1], tokens: 10, turnsAfter: 0, createdAt: NOW }, { now: NOW, contentType: type, protection: { protection: "NORMAL", reasons: [] }, duplicationState: dupState() });
		assert.equal(features.reconstructibility, x, type);
	}
});

test("P1 reasons raise intrinsic (decision 0.98, benchmark 0.85, config 0.75, checkpoint 0.9)", () => {
	const base = { protection: "P1", reasons: [] };
	assert.equal(intrinsicOf({}, "assistant-reasoning", { ...base, reasons: ["decision/architecture rationale"] }).intrinsic, 0.98);
	assert.equal(intrinsicOf({}, "tool-pair", { ...base, reasons: ["ACTIVE benchmark BENCH-001"] }).intrinsic, 0.85);
	assert.equal(intrinsicOf({}, "tool-pair", { ...base, reasons: ["important config read (§9)"] }).intrinsic, 0.75);
	assert.equal(intrinsicOf({}, "checkpoint", { ...base, reasons: ["compaction checkpoint (provenance: 3 shadowed nodes)"] }).intrinsic, 0.9);
	// P0 is NOT raised by intrinsic — it is pinned upstream in the scorer.
	assert.equal(intrinsicOf({}, "assistant-reasoning", { protection: "P0", reasons: ["user hard constraint/denial"] }).intrinsic, 0.55);
});

test("sizePenalty (§31): zero below 256, log2 growth, capped at 0.15, never negative", () => {
	assert.equal(sizePenaltyOf(0), 0);
	assert.equal(sizePenaltyOf(256), 0);
	assert.ok(Math.abs(sizePenaltyOf(512) - 0.02) < 1e-12);
	assert.ok(Math.abs(sizePenaltyOf(4096) - 0.08) < 1e-12);
	assert.ok(sizePenaltyOf(1_000_000) <= 0.15);
	assert.equal(sizePenaltyOf(Number.NaN), 0);
});

test("extractFeatures assembles the full vector (deterministic, no LLM)", () => {
	const unit = {
		id: "u-9", kind: "tool-pair", toolName: "grep", toolArgs: "planVacGc",
		text: "grep found planVacGc in C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js",
		terms: {
			ids: [], paths: ["c:\\users\\xiemo\\md-memory\\lib\\vacgc\\index.js"], symbols: ["planvacgc"], errors: [], models: [],
			keywords: ["planvacg"]
		},
		seqs: [9], tokens: 800, turnsAfter: 3, createdAt: NOW - 5 * 60000, open: false
	};
	const query = {
		ids: new Set(), paths: new Set(["c:\\users\\xiemo\\md-memory\\lib\\vacgc\\index.js"]), symbols: new Set(["planvacgc"]),
		errors: new Set(), models: new Set(), keywords: new Set(["planvacg"])
	};
	const { features, contentType, notes } = extractFeatures(unit, {
		now: NOW,
		query,
		memory: fakeMemory({ activeIds: [], citedByActive: [], statePaths: ["C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js"] }),
		duplicationState: dupState()
	});
	assert.equal(contentType, "search-result");
	// relevance: path +0.4, symbol +0.35, strong keyword (len>=4) +0.25 → clamp 1
	assert.equal(features.taskRelevance, 1);
	// recency: search-result τ=5, age 3 turns → 0.75·e^-0.6 + 0.25·~1
	const expectedR = 0.75 * Math.exp(-3 / 5) + 0.25 * Math.exp(-(5 / (5 * 30)));
	assert.ok(Math.abs(features.recency - expectedR) < 1e-9);
	// dependency: path in STATE-CURRENT +0.25
	assert.equal(features.dependency, 0.25);
	assert.equal(features.duplication, 0);
	assert.equal(features.intrinsic, 0.3);
	assert.ok(notes.length > 0 && notes.every((n) => typeof n === "string"));
});

test("near-duplication of the same tool group is detected", () => {
	const state = dupState();
	const base = { kind: "tool-pair", toolName: "grep", toolArgs: "foo", seqs: [1], tokens: 100, turnsAfter: 1, createdAt: NOW, open: false };
	const first = { ...base, id: "u-1", text: "alpha\nbeta\ngamma", toolArgsKey: "grep:aaaa", terms: {} };
	const second = { ...base, id: "u-2", seqs: [2], text: "alpha\nbeta\ndelta", toolArgsKey: "grep:aaaa", terms: {} };
	extractFeatures(first, { now: NOW, duplicationState: state });
	const { features, notes } = extractFeatures(second, { now: NOW, duplicationState: state });
	// line-set jaccard {alpha,beta,gamma} vs {alpha,beta,delta} = 2/4 = 0.5 → dup 0.25
	assert.ok(Math.abs(features.duplication - 0.25) < 1e-12, `dup=${features.duplication}`);
	assert.ok(notes.some((n) => n.includes("duplication")));
});
