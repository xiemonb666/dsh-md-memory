/**
 * Pressure measurement & zone mapping (plan §34–36, §101).
 * Derived values for the deployment window W = 192000 (qwen38-agent):
 * safetyMargin 7680, injectionReserve 4800, expectedOutput fallback 9600,
 * recentFloor 11520, minReclaim 5760.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	measurePressure,
	zoneOf,
	recentFloorTokens,
	minimumReclaim,
	DEFAULT_PRESSURE
} from "../../lib/vacgc/pressure.js";

const W = 192000;

test("derived clamps for W = 192000 (deployment window)", () => {
	const m = measurePressure({ inputTokens: 0, contextWindow: W });
	assert.equal(m.safetyMargin, 7680);
	assert.equal(m.injectionReserve, 4800);
	assert.equal(m.expectedOutput, 9600);
	assert.equal(recentFloorTokens(W, {}), 11520);
	assert.equal(minimumReclaim(W, {}), 5760);
});

test("clamps bind on small windows", () => {
	const m = measurePressure({ inputTokens: 0, contextWindow: 8192 });
	assert.equal(m.safetyMargin, 2048);
	assert.equal(m.injectionReserve, 1024);
	assert.equal(m.expectedOutput, 2048);
	assert.equal(recentFloorTokens(8192, {}), 2048);
	assert.equal(minimumReclaim(8192, {}), 2048);
});

test("explicit expectedOutput is respected (no fallback)", () => {
	const m = measurePressure({ inputTokens: 100000, contextWindow: W, expectedOutput: 4096 });
	assert.equal(m.expectedOutput, 4096);
	assert.ok(Math.abs(m.soft - (100000 + 4096 + 4800) / W) < 1e-4);
});

test("requestedMaxOutput defaults to expectedOutput and drives the hard ratio", () => {
	const m = measurePressure({ inputTokens: 100000, contextWindow: W });
	assert.equal(m.requestedMaxOutput, m.expectedOutput);
	const h = measurePressure({ inputTokens: 100000, contextWindow: W, requestedMaxOutput: 32768 });
	assert.ok(Math.abs(h.hard - (100000 + 32768 + 7680) / W) < 1e-4);
	assert.ok(h.hard > h.soft);
});

test("invalid window throws (the planner maps that to a degraded no-op)", () => {
	assert.throws(() => measurePressure({ inputTokens: 100, contextWindow: 0 }));
	assert.throws(() => measurePressure({ inputTokens: 100, contextWindow: -5 }));
});

test("soft ratio + zone mapping (the V1 zone table, §36)", () => {
	const z = (input, extra = {}) => {
		const m = measurePressure({ inputTokens: input, contextWindow: W, ...extra });
		return { m, zone: zoneOf(m.soft, m.hard, DEFAULT_PRESSURE) };
	};
	// expectedOutput 9600 + injection 4800 = 14400 overhead
	assert.equal(z(30000).zone, "Z0"); // 0.25
	assert.equal(z(100000).zone, "Z1"); // 0.5938
	assert.equal(z(120000).zone, "Z2"); // 0.70
	assert.equal(z(140000).zone, "Z3"); // 0.804
	assert.equal(z(160000).zone, "Z4"); // 0.908
	assert.equal(z(175000).zone, "Z5"); // 0.986
});

test("hard ratio forces emergency (Z5) even when soft is below the Z5 line", () => {
	const m = measurePressure({ inputTokens: 150000, contextWindow: W, requestedMaxOutput: 32768 });
	// soft = (150000 + 14400) / W ≈ 0.856 → Z3; hard = (150000 + 32768 + 7680) / W ≈ 0.992 → < 1, not yet
	assert.equal(zoneOf(m.soft, m.hard, DEFAULT_PRESSURE), "Z3");
	const m2 = measurePressure({ inputTokens: 158000, contextWindow: W, requestedMaxOutput: 32768 });
	// hard = (158000 + 40448) / W ≈ 1.034 ≥ 1 → emergency
	assert.ok(m2.hard >= 1, `hard=${m2.hard}`);
	assert.equal(zoneOf(m2.soft, m2.hard, DEFAULT_PRESSURE), "Z5");
});

test("zone thresholds are overridable (the §43 named boundaries)", () => {
	const cfg = { softGc: 0.9, coldCompact: 0.95, warmCompact: 0.99, aggressive: 1.5, emergency: 1.99 };
	assert.equal(zoneOf(0.93, 0.5, cfg), "Z1");
	assert.equal(zoneOf(0.5, 0.5, cfg), "Z0");
	assert.equal(zoneOf(1.99, 1.99, cfg), "Z5");
	assert.equal(zoneOf(1.5, 0.99, cfg), "Z4"); // soft ≥ aggressive, hard < 1
	assert.equal(zoneOf(0.5, 1.0, cfg), "Z5"); // hard ≥ 1 always forces emergency
});

test("zoneOf honors the explicit config object contract (defaults merged)", () => {
	assert.equal(zoneOf(0.4, 0.4, null), "Z0");
	assert.equal(zoneOf(0.56, 0.56, undefined), "Z1");
});
