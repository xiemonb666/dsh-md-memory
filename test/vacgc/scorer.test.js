/**
 * Scoring (plan §32–33) + tier assignment with hysteresis (plan §14, §33).
 * Core law under test: P0 pins to 1.0, P1 floors at 0.75 — regardless of the
 * feature vector; weights only order units inside the safe set.
 *
 * Contract: the protection argument is the gate's result object
 * {protection, reasons} — the scorer never re-classifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreUnit, assignTier, TIERS, DEFAULT_TIER_THRESHOLDS } from "../../lib/vacgc/scorer.js";

const F = (over = {}) => ({
	intrinsic: 0.5, durable: 0.5, taskRelevance: 0.5, recency: 0.5, dependency: 0.25,
	reconstructibility: 0.3, duplication: 0, sizePenalty: 0, ...over
});
const P = (protection) => ({ protection, reasons: [] });

test("P0 and P0_TRANSIENT are pinned to 1.0 regardless of features", () => {
	for (const protection of ["P0", "P0_TRANSIENT"]) {
		const { score, reasons } = scoreUnit(F({ duplication: 1.0, reconstructibility: 1.0, intrinsic: 0.02, taskRelevance: 0, recency: 0 }), P(protection));
		assert.equal(score, 1);
		assert.equal(assignTier(score, P(protection), "HOT").tier, "PINNED"); // tier follows the pin
		assert.ok(reasons.some((r) => r.includes("protected")));
	}
});

test("score formula: base = max(L, ActiveValue); penalties subtract (§32)", () => {
	// L = max(.8, .8, ev) = .8; Active = .55*.5 + .3*.5 + .15*.25 = .4625 → base .8
	const { score } = scoreUnit(F({ intrinsic: 0.8, durable: 0.8, reconstructibility: 0.3, dependency: 0.25 }), P("NORMAL"));
	// score = .8 + 0.10*.25 − 0.22*.3 − 0 − 0 = .8 + .025 − .066 = .759
	assert.ok(Math.abs(score - 0.759) < 1e-9, `score=${score}`);
});

test("active value can exceed long-term value (MAX, not multiply)", () => {
	// L = .3; Active = .55*1 + .3*1 + .15*1 = 1.0 → base 1.0
	const { score } = scoreUnit(F({ intrinsic: 0.3, durable: 0.3, taskRelevance: 1, recency: 1, dependency: 1 }), P("NORMAL"));
	// score = 1 + .15 − 0 − 0 − 0 = 1.15 → clamp 1
	assert.equal(score, 1);
});

test("P1 floors at 0.75 (§8)", () => {
	// base .55, X 1.0, dup .5, size .05 → .55 − .22 − .09 − .05 = .19 → floor .75
	const { score, reasons } = scoreUnit(F({ intrinsic: 0.55, durable: 0.55, taskRelevance: 0, recency: 0, dependency: 0, reconstructibility: 1.0, duplication: 0.5, sizePenalty: 0.05 }), P("P1"));
	assert.equal(score, 0.75);
	assert.ok(reasons.some((r) => r.includes("P1 floor")));
});

test("P1 floor only lifts, never lowers (a high P1 keeps its score)", () => {
	const { score } = scoreUnit(F({ intrinsic: 0.9, durable: 0.9, taskRelevance: 0.8, recency: 0.8, dependency: 0.5, reconstructibility: 0.2 }), P("P1"));
	// base .9; score = .9 + .05 − .044 = .906 > .75
	assert.ok(Math.abs(score - 0.906) < 1e-9, `score=${score}`);
});

test("scores never leave [0,1] (clamp)", () => {
	assert.equal(scoreUnit(F({ intrinsic: 1, durable: 1, taskRelevance: 1, recency: 1, dependency: 1, reconstructibility: 0 }), P("NORMAL")).score, 1);
	assert.equal(scoreUnit(F({ intrinsic: 0.01, durable: 0.01, reconstructibility: 1, duplication: 1, sizePenalty: 0.15 }), P("NORMAL")).score, 0);
});

test("config-overridable penalties (VACGC-025)", () => {
	const base = F({ intrinsic: 0.8, durable: 0.8, reconstructibility: 0.3 });
	assert.ok(Math.abs(scoreUnit(base, P("NORMAL")).score - 0.759) < 1e-9);
	const { score } = scoreUnit(base, P("NORMAL"), { reconstructibilityPenalty: 0.0, duplicationPenalty: 0.0 });
	// .8 + .15·0.25 − 0 = .825
	assert.ok(Math.abs(score - 0.825) < 1e-9, `score=${score}`);
});

test("assignTier thresholds (enter high / leave low hysteresis, §14)", () => {
	assert.deepEqual(DEFAULT_TIER_THRESHOLDS, { hotEnter: 0.82, hotLeave: 0.7, warmEnter: 0.58, warmLeave: 0.48, trashEnter: 0.28 });
	assert.equal(assignTier(0.9, P("NORMAL"), undefined).tier, "HOT");
	assert.equal(assignTier(0.8, P("NORMAL"), undefined).tier, "WARM");
	assert.equal(assignTier(0.5, P("NORMAL"), undefined).tier, "COLD");
	assert.equal(assignTier(0.2, P("NORMAL"), undefined).tier, "TRASH");
	assert.equal(assignTier(0.5, P("P0"), undefined).tier, "PINNED");
	assert.equal(assignTier(0.9, P("P1"), undefined).tier, "HOT");
});

test("hysteresis: demotion needs the leave threshold; promotion is instant", () => {
	// 0.75 is below hotEnter (0.82) → WARM candidate; previous HOT stays HOT (≥ hotLeave 0.70)
	assert.equal(assignTier(0.75, P("NORMAL"), "HOT").tier, "HOT");
	// 0.69 < hotLeave → demote to WARM
	assert.equal(assignTier(0.69, P("NORMAL"), "HOT").tier, "WARM");
	// WARM hysteresis: 0.485 < warmEnter 0.58 → COLD candidate; ≥ warmLeave 0.48 → stays WARM
	assert.equal(assignTier(0.485, P("NORMAL"), "WARM").tier, "WARM");
	// 0.47 < warmLeave → demote to COLD
	assert.equal(assignTier(0.47, P("NORMAL"), "WARM").tier, "COLD");
	// promotion skips hysteresis: COLD → HOT directly at 0.9
	assert.equal(assignTier(0.9, P("NORMAL"), "COLD").tier, "HOT");
	// stale tier state (surface changed) is ignored
	assert.equal(assignTier(0.75, P("NORMAL"), "HOT-OLD-GEN").tier, "WARM");
});

test("COLD↔TRASH uses the plain 0.28 threshold both ways (V1, no hysteresis pair)", () => {
	assert.equal(assignTier(0.27, P("NORMAL"), "COLD").tier, "TRASH");
	assert.equal(assignTier(0.29, P("NORMAL"), "TRASH").tier, "COLD");
	assert.equal(TIERS.length, 5);
});
