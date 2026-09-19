/**
 * Hard protection gate (plan §5–9, §85, §131; DEC-001).
 * THE core law: classification runs before any scoring and no weight can
 * override it — these tests pin the class + reason for every lane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProtection } from "../../lib/vacgc/protection.js";
import { fakeMemory } from "./helpers.js";

const U = (over = {}) => ({ id: "u-1", seqs: [1], kind: "assistant", text: "", terms: {}, ...over });

test("open tool chain is P0_TRANSIENT (the in-progress step, §5)", () => {
	const { protection, reasons } = classifyProtection(U({ kind: "tool-pair", open: true, text: "reading…" }));
	assert.equal(protection, "P0_TRANSIENT");
	assert.ok(reasons.some((r) => r.includes("open tool chain")));
});

test("user hard constraints/denials are P0 (§6)", () => {
	const { protection } = classifyProtection(U({ kind: "user", text: "注意：不能修改 core 目录下的文件，必须保持向后兼容" }));
	assert.equal(protection, "P0");
	const { protection: p2 } = classifyProtection(U({ kind: "user", text: "do not delete the test suite, keep it exactly as is" }));
	assert.equal(p2, "P0");
});

test("user corrections are P0 (§6)", () => {
	const { protection } = classifyProtection(U({ kind: "user", text: "不对，实际的路径是 C:\\x\\y，你记错了" }));
	assert.equal(protection, "P0");
	const { protection: p2 } = classifyProtection(U({ kind: "user", text: "that's not right, actually the module lives in lib/vacgc" }));
	assert.equal(p2, "P0");
});

test("current goal statements are P0 (§7)", () => {
	const { protection } = classifyProtection(U({ kind: "user", text: "目标：实现 VAC-GC 影子规划器" }));
	assert.equal(protection, "P0");
	const { protection: p2 } = classifyProtection(U({ kind: "user", text: "Goal: ship the shadow planner this round" }));
	assert.equal(p2, "P0");
});

test("assistant decisions / root causes / verified results / key fixes are P1 (§8)", () => {
	assert.equal(classifyProtection(U({ text: "决定：采用纯函数模块架构" })).protection, "P1");
	assert.equal(classifyProtection(U({ text: "根因是 node_modules 的 junction 缺失，导致模块解析失败" })).protection, "P1");
	assert.equal(classifyProtection(U({ text: "验证通过：42 个测试全部通过，exit code: 0" })).protection, "P1");
	assert.equal(classifyProtection(U({ text: "已修复 pairing 失衡问题，补丁见 lib/vacgc/segments.js" })).protection, "P1");
	assert.equal(classifyProtection(U({ text: "Decided to adopt the ledger index over per-round full scans" })).protection, "P1");
});

test("assistant restated goal is P0", () => {
	const { protection } = classifyProtection(U({ text: "目标：继续修复 segments 模块的门槛" }));
	assert.equal(protection, "P0");
});

test("compaction checkpoints are P1 with provenance (§71)", () => {
	const { protection, reasons } = classifyProtection(U({ kind: "checkpoint", sourceEventSeqs: [2, 3, 4] }));
	assert.equal(protection, "P1");
	assert.ok(reasons.some((r) => r.includes("3 shadowed node")));
});

test("important config reads are P1 (§9)", () => {
	const { protection } = classifyProtection(U({ kind: "tool-pair", toolArgs: "C:\\Users\\xiemo\\.dsh\\settings.yaml", text: "enabled: true", terms: { paths: ["C:\\Users\\xiemo\\.dsh\\settings.yaml"], ids: [] } }));
	assert.equal(protection, "P1");
	const { protection: p2 } = classifyProtection(U({ kind: "tool-pair", toolArgs: "lib/vacgc/index.js", text: "code", terms: { paths: ["lib/vacgc/index.js"], ids: [] } }));
	assert.equal(p2, "NORMAL");
});

test("ledger ACTIVE DEC/REQ/BLOCK references are P0 (§85)", () => {
	const memory = fakeMemory({ activeIds: ["DEC-005", "REQ-001", "BENCH-001"] });
	const { protection, reasons } = classifyProtection(U({ text: "按照 [DEC-005] 执行影子模式", terms: { ids: ["dec-005"] } }), { memory });
	assert.equal(protection, "P0");
	assert.ok(reasons.some((r) => r.includes("DEC-005")));
});

test("ledger ACTIVE benchmark references are P1 (§85)", () => {
	const memory = fakeMemory({ activeIds: ["BENCH-001"] });
	const { protection } = classifyProtection(U({ text: "基准 [BENCH-001] 的数据", terms: { ids: ["bench-001"] } }), { memory });
	assert.equal(protection, "P1");
});

test("inactive ledger references are not protected", () => {
	const memory = fakeMemory({ activeIds: ["DEC-005"] });
	const { protection } = classifyProtection(U({ text: "历史条目 [DEC-999] 已失效", terms: { ids: ["dec-999"] } }), { memory });
	assert.equal(protection, "NORMAL");
});

test("ordinary user discussion is NORMAL (the scorer's lane)", () => {
	const { protection } = classifyProtection(U({ kind: "user", text: "帮我看看这个报错是什么原因" }));
	assert.equal(protection, "NORMAL");
	const { protection: p2 } = classifyProtection(U({ kind: "assistant", text: "好的，我先看一下日志。" }));
	assert.equal(p2, "NORMAL");
});

test("P0 wins over P1 signals in the same unit (gate order)", () => {
	const { protection } = classifyProtection(U({ kind: "user", text: "目标：修复这个问题，而且必须不能丢数据" }));
	assert.equal(protection, "P0");
});

// --- provenance lane (review 2026-09-12, P0) --------------------------------
// A unit is P0 when its SOURCE SEQS back an ACTIVE ledger entry — the original
// "以后不要开 MTP" message predates the DEC id, so the §85 id-text lane can
// never see it. The host-side mapping (LedgerIndex.activeSourceIds) supplies
// seq → ACTIVE ids; the LLM never sees seq numbers.

function provenanceMemory({ activeIds = [], sources = {} } = {}) {
	// sources: { <sessionId>: { <seq>: [ids] } } — the .provenance.json shape
	const active = new Set(activeIds);
	const bySeq = new Map(Object.entries(sources["s1"] ?? {}).map(([seq, ids]) => [Number(seq), new Set(ids)]));
	return {
		available: true,
		activeIds: active,
		citedByActive: new Set(),
		statePaths: new Set(),
		stateText: "",
		activeSourceIds: (sessionId, seqs) => {
			const out = new Set();
			if (sessionId !== "s1") return out;
			for (const seq of seqs) {
				const ids = bySeq.get(Number(seq));
				if (ids === undefined) continue;
				for (const id of ids) if (active.has(id)) out.add(id);
			}
			return out;
		}
	};
}

test("provenance lane: a unit whose seqs back an ACTIVE entry is P0", () => {
	const memory = provenanceMemory({ activeIds: ["DEC-006"], sources: { "s1": { 7: ["DEC-006"] } } });
	const { protection, reasons } = classifyProtection(
		U({ kind: "tool-pair", seqs: [7], text: "node eval.mjs MTP-PROBE 输出 平均 42ms" }),
		{ memory, sessionId: "s1" }
	);
	assert.equal(protection, "P0");
	assert.ok(reasons.some((r) => r.includes("provenance") && r.includes("DEC-006")));
});

test("provenance lane: the unit's seqs must intersect the entry's source seqs", () => {
	const memory = provenanceMemory({ activeIds: ["DEC-006"], sources: { "s1": { 7: ["DEC-006"] } } });
	// different seqs → no intersection
	const { protection } = classifyProtection(U({ kind: "tool-pair", seqs: [99], text: "unrelated log" }), { memory, sessionId: "s1" });
	assert.equal(protection, "NORMAL");
	// different session → seqs are session-local
	const { protection: p2 } = classifyProtection(U({ kind: "tool-pair", seqs: [7], text: "unrelated log" }), { memory, sessionId: "other" });
	assert.equal(p2, "NORMAL");
	// no sessionId at all → the lane is off
	const { protection: p3 } = classifyProtection(U({ kind: "tool-pair", seqs: [7], text: "unrelated log" }), { memory });
	assert.equal(p3, "NORMAL");
});

test("provenance lane: a SUPERSEDED entry's source is NOT pinned (ACTIVE ids only)", () => {
	// the entry exists in provenance but is no longer ACTIVE → filtered out
	const memory = provenanceMemory({ activeIds: ["REQ-001"], sources: { "s1": { 7: ["DEC-006"] } } });
	const { protection } = classifyProtection(U({ kind: "tool-pair", seqs: [7], text: "stale evidence" }), { memory, sessionId: "s1" });
	assert.equal(protection, "NORMAL");
});

// --- conservative hold lane (review 2026-09-12, P0.5) ------------------------
// An ACTIVE entry whose evidence has NO resolved binding (degraded provenance
// state) holds lexically-related units at P1 — never ordinary NORMAL scoring.
// "Keep more, never delete wrongly."

function degradedMemory({ activeIds = [], sources = {}, unresolved = {} } = {}) {
	// unresolved: { <entryId>: [term, …] } — the pre-extracted evidence terms
	return {
		...provenanceMemory({ activeIds, sources }),
		unresolvedTerms: new Map(Object.entries(unresolved).map(([id, terms]) => [id, new Set(terms)]))
	};
}

test("conservative lane: ≥ 2 shared evidence terms → P1 hold (not NORMAL scoring)", () => {
	const memory = degradedMemory({
		activeIds: ["DEC-099"],
		unresolved: { "DEC-099": ["never", "enable", "mtp", "基准"] }
	});
	const { protection, reasons } = classifyProtection(
		U({ kind: "tool-pair", seqs: [3], text: "我们决定 never enable mtp 了，因为基准变慢" }),
		{ memory, sessionId: "s1" }
	);
	assert.equal(protection, "P1", "degraded provenance never yields a NORMAL unit");
	assert.match(reasons.join(" "), /DEC-099/);
	assert.match(reasons.join(" "), /conservative P1 hold/);
});

test("conservative lane: ONE very distinctive term (≥ 8 chars) is enough for the hold", () => {
	const memory = degradedMemory({
		activeIds: ["TECH-014"],
		unresolved: { "TECH-014": ["pickshadowprice"] }
	});
	const { protection } = classifyProtection(
		U({ kind: "tool-pair", seqs: [3], text: "we use pickShadowPrice for shadow token pricing" }),
		{ memory, sessionId: "s1" }
	);
	assert.equal(protection, "P1");
});

test("conservative lane: a single short shared term does NOT over-hold (stays NORMAL)", () => {
	const memory = degradedMemory({
		activeIds: ["DEC-099"],
		unresolved: { "DEC-099": ["mtp", "benchmark"] }
	});
	const { protection } = classifyProtection(
		U({ kind: "tool-pair", seqs: [3], text: "tuning notes about mtp latency" }),
		{ memory, sessionId: "s1" }
	);
	assert.equal(protection, "NORMAL", "one short term = coincidence, not evidence");
});

test("conservative lane: a repaired (bound) entry exits the hold — the exact-source P0 lane takes over", () => {
	// the entry has BOTH a binding (seq 7) and stale unresolved terms
	const memory = degradedMemory({
		activeIds: ["DEC-099"],
		sources: { "s1": { 7: ["DEC-099"] } },
		unresolved: { "DEC-099": ["never", "enable", "mtp"] }
	});
	const { protection, reasons } = classifyProtection(
		U({ kind: "tool-pair", seqs: [7], text: "never enable mtp 输出" }),
		{ memory, sessionId: "s1" }
	);
	assert.equal(protection, "P0", "a real binding outranks the conservative hold");
	assert.ok(reasons.some((r) => r.includes("(provenance)")));
});
