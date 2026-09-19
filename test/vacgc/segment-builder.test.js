/**
 * Segment builder, ranking, hard gates (plan §53–59, §88–89).
 * Contiguity is structural; the gates are hard — no weight may pass them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSegments, rankSegments, selectBestSegment } from "../../lib/vacgc/segments.js";

const row = (over = {}) => ({
	unitId: "u-x", firstSeq: 1, lastSeq: 1, tokens: 1000, protection: "NORMAL",
	score: 0.3, tier: "COLD", inRecentFloor: false, ...over
});

const OPTS = (over = {}) => ({ zone: "Z2", minReclaimTokens: 5760, maxReclaimTokens: 65536, ...over });

test("a contiguous run of eligible units becomes one segment", () => {
	const rows = [
		row({ unitId: "a", firstSeq: 1, lastSeq: 1, tokens: 2000, score: 0.2 }),
		row({ unitId: "b", firstSeq: 2, lastSeq: 2, tokens: 2000, score: 0.3 }),
		row({ unitId: "c", firstSeq: 3, lastSeq: 3, tokens: 2000, score: 0.4 })
	];
	const segs = buildSegments(rows, OPTS());
	assert.equal(segs.length, 1);
	const s = segs[0];
	assert.deepEqual(s.unitIds, ["a", "b", "c"]);
	assert.equal(s.firstSeq, 1);
	assert.equal(s.lastSeq, 3);
	assert.equal(s.tokens, 6000);
	assert.equal(s.eligible, true, JSON.stringify(s.gates));
});

test("P0 / P0_TRANSIENT / recent-floor units split runs and are never inside a segment (§57)", () => {
	const rows = [
		row({ unitId: "a", firstSeq: 1, lastSeq: 1 }),
		row({ unitId: "p0", firstSeq: 2, lastSeq: 2, protection: "P0", tier: "PINNED", score: 1 }),
		row({ unitId: "b", firstSeq: 3, lastSeq: 3 }),
		row({ unitId: "t", firstSeq: 4, lastSeq: 4, protection: "P0_TRANSIENT", tier: "PINNED", score: 1 }),
		row({ unitId: "c", firstSeq: 5, lastSeq: 5 }),
		row({ unitId: "floor", firstSeq: 6, lastSeq: 6, inRecentFloor: true }),
		row({ unitId: "d", firstSeq: 7, lastSeq: 7 })
	];
	const segs = buildSegments(rows, OPTS());
	// runs: [a] [b] [c] [d] — the P0, transient, and floor units are walls
	assert.equal(segs.length, 4);
	for (const s of segs) {
		assert.ok(!s.unitIds.includes("p0") && !s.unitIds.includes("t") && !s.unitIds.includes("floor"));
		assert.equal(s.gates.p0, false);
	}
});

test("zone gates tier eligibility (Z2: TRASH+COLD only; Z3 adds WARM; Z5 adds HOT)", () => {
	const rows = (tier) => [row({ unitId: "w", tier: "WARM", score: 0.6 })];
	assert.equal(buildSegments(rows("WARM"), OPTS({ zone: "Z2" })).length, 0);
	assert.equal(buildSegments(rows("WARM"), OPTS({ zone: "Z3" })).length, 1);
	assert.equal(buildSegments([row({ unitId: "h", tier: "HOT", score: 0.9 })], OPTS({ zone: "Z3" })).length, 0);
	assert.equal(buildSegments([row({ unitId: "h", tier: "HOT", score: 0.9 })], OPTS({ zone: "Z5" })).length, 1);
	// Z0/Z1: nothing is segment-eligible (fresh/micro pruning lane only)
	assert.equal(buildSegments([row()], OPTS({ zone: "Z0" })).length, 0);
	assert.equal(buildSegments([row()], OPTS({ zone: "Z1" })).length, 0);
});

test("P1 content is zone-gated: excluded in Z2–Z3, included in Z4/Z5 (§57/§85)", () => {
	const p1 = [row({ unitId: "p", protection: "P1", tier: "WARM", score: 0.75 })];
	const z2 = buildSegments(p1, OPTS({ zone: "Z2" }));
	assert.equal(z2.length, 0, "P1 row is not eligible in Z2");
	const z4 = buildSegments(p1, OPTS({ zone: "Z4" }));
	assert.equal(z4.length, 1);
	assert.equal(z4[0].containsP1, true);
	assert.equal(z4[0].gates.zoneP1, false);
});

test("minReclaim gate (normal pressure) and the Z5 emergency exemption", () => {
	const small = [row({ unitId: "s", tokens: 1000 })];
	const z2 = buildSegments(small, OPTS({ zone: "Z2" }));
	assert.equal(z2[0].gates.minReclaim, true);
	assert.equal(z2[0].eligible, false);
	const z5 = buildSegments(small, OPTS({ zone: "Z5" }));
	assert.equal(z5[0].gates.minReclaim, false, "emergency is exempt from minReclaim");
	assert.equal(z5[0].eligible, true);
});

test("overCap gate for reclaim beyond the single-transaction cap", () => {
	const big = [row({ unitId: "b", tokens: 70000 })];
	const seg = buildSegments(big, OPTS())[0];
	assert.equal(seg.gates.overCap, true);
	assert.equal(seg.eligible, false);
});

test("unbalanced pairing boundary rejects the segment (defensive live check)", () => {
	const rows = [row({ unitId: "a", firstSeq: 5, lastSeq: 6, tokens: 6000 })];
	const bad = buildSegments(rows, OPTS({ balancedBefore: (seq) => seq !== 5 }));
	assert.equal(bad[0].gates.unbalanced, true);
	assert.equal(bad[0].eligible, false);
	const good = buildSegments(rows, OPTS({ balancedBefore: () => true, balancedAfter: () => true }));
	assert.equal(good[0].gates.unbalanced, false);
	assert.equal(good[0].eligible, true);
});

test("lossDensity is the token-weighted mean score; priority = reclaim × (1 − lossDensity)", () => {
	const rows = [
		row({ unitId: "a", firstSeq: 1, lastSeq: 1, tokens: 1000, score: 0.2 }),
		row({ unitId: "b", firstSeq: 2, lastSeq: 2, tokens: 3000, score: 0.4 })
	];
	const s = buildSegments(rows, OPTS())[0];
	// (1000·0.2 + 3000·0.4)/4000 = 1.4/4 = 0.35
	assert.ok(Math.abs(s.lossDensity - 0.35) < 1e-9);
	assert.ok(Math.abs(s.priority - 4000 * 0.65) < 1e-9);
});

test("ranking: higher priority first; ties broken by more tokens", () => {
	const wall = (n, seq) => row({ unitId: `wall-${n}`, firstSeq: seq, lastSeq: seq, protection: "P0", tier: "PINNED", score: 1, tokens: 100 });
	const rows = [
		row({ unitId: "cold-garbage", firstSeq: 1, lastSeq: 2, tokens: 8000, score: 0.1 }), // priority 7200
		wall(1, 3),
		row({ unitId: "warm-useful", firstSeq: 4, lastSeq: 4, tokens: 8000, score: 0.6 }), // priority 3200
		wall(2, 5),
		row({ unitId: "cold-garbage2", firstSeq: 6, lastSeq: 7, tokens: 9000, score: 0.1 }) // priority 8100
	];
	const ranked = rankSegments(buildSegments(rows, OPTS({ zone: "Z2" })));
	assert.deepEqual(ranked.map((s) => s.unitIds[0]), ["cold-garbage2", "cold-garbage", "warm-useful"]);
	assert.equal(selectBestSegment(ranked).unitIds[0], "cold-garbage2");
	assert.equal(selectBestSegment([]), null);
});

test("nothing eligible → empty ranked list → selectBestSegment(null) (surface untouched)", () => {
	const rows = [
		row({ unitId: "p0", protection: "P0", tier: "PINNED" }),
		row({ unitId: "hot", tier: "HOT", score: 0.9 })
	];
	const segs = buildSegments(rows, OPTS({ zone: "Z2" }));
	assert.equal(segs.length, 0);
	assert.equal(selectBestSegment(rankSegments(segs)), null);
});
