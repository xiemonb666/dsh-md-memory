/**
 * VAC-GC pressure model (plan §36–§43, §45, §58).
 *
 * Two gauges per model window W:
 *   soft = (input + expectedOutput + injectionReserve) / W
 *   hard = (input + requestedMaxOutput + safetyMargin) / W
 * expectedOutput    = rolling P95 of the last 20 outputs, else
 *                     clamp(0.05·W, 2048, 16384)          (V1: the fallback —
 *                     no per-output usage ring exists in the session log yet)
 * injectionReserve  = clamp(0.025·W, 1024, 6144)          (§39)
 * safetyMargin      = clamp(0.04·W, 2048, 8192)           (§40)
 *
 * Zones (§43): Z0 < softGc … Z5 ≥ emergency (or hard ≥ 1 → forced Z5).
 * Ratio + clamp — no per-window hardcoded profiles (§81: 32K–262K).
 */
import { clamp } from "./math.js";

/** §43 default zone boundaries (config-overridable). */
export const DEFAULT_PRESSURE = {
	softGc: 0.55,
	coldCompact: 0.68,
	warmCompact: 0.78,
	aggressive: 0.88,
	emergency: 0.94,
	safetyRatio: 0.04,
	injectionReserveRatio: 0.025
};

/**
 * Measure pressure for one request about to go out.
 * @param input - {
 *   inputTokens: number,           total priced request (header + surface)
 *   contextWindow: number,         model capacity W
 *   requestedMaxOutput?: number,   max output the route allows
 *   expectedOutput?: number,       rolling P95 (optional; V1 passes none)
 *   config?: object                pressure overrides
 * }
 * @returns the full pressure breakdown.
 */
export function measurePressure(input) {
	const W = Math.floor(input.contextWindow);
	if (!Number.isFinite(W) || W <= 0) throw new Error("measurePressure: contextWindow must be a positive integer");
	const cfg = { ...DEFAULT_PRESSURE, ...(input.config?.pressure ?? {}) };
	const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));

	const expectedOutput = Number.isFinite(input.expectedOutput) && input.expectedOutput > 0
		? Math.round(input.expectedOutput)
		: clamp(0.05 * W, 2048, 16384);
	const injectionReserve = clamp(0.025 * W, 1024, 6144) | 0;
	const safetyMargin = clamp(cfg.safetyRatio * W, 2048, 8192) | 0;
	const requestedMaxOutput = Number.isFinite(input.requestedMaxOutput) && input.requestedMaxOutput > 0
		? Math.round(input.requestedMaxOutput)
		: expectedOutput; // conservative fallback: price the hard gauge like the soft gauge

	const soft = (inputTokens + expectedOutput + injectionReserve) / W;
	const hard = (inputTokens + requestedMaxOutput + safetyMargin) / W;
	const zone = zoneOf(soft, hard, cfg);

	return {
		contextWindow: W,
		inputTokens,
		expectedOutput,
		injectionReserve,
		safetyMargin,
		requestedMaxOutput,
		soft: round4(soft),
		hard: round4(hard),
		zone,
		config: cfg
	};
}

/**
 * Zone from the two gauges (§43). hard ≥ 1 means the request cannot fit even
 * with a minimal output — force emergency.
 * @param soft - soft gauge.
 * @param hard - hard gauge.
 * @param cfg - pressure config.
 * @returns "Z0".."Z5".
 */
export function zoneOf(soft, hard, cfg = DEFAULT_PRESSURE) {
	if (!cfg) cfg = DEFAULT_PRESSURE; // null-safe: callers may pass an absent config
	if (hard >= 1 || soft >= cfg.emergency) return "Z5";
	if (soft >= cfg.aggressive) return "Z4";
	if (soft >= cfg.warmCompact) return "Z3";
	if (soft >= cfg.coldCompact) return "Z2";
	if (soft >= cfg.softGc) return "Z1";
	return "Z0";
}

/**
 * Recent floor size (§45): clamp(0.06·W, 2048, 12288) by default.
 * @param W - context window.
 * @param config - {recent?: {ratio, minTokens, maxTokens}}.
 * @returns floor in tokens.
 */
export function recentFloorTokens(W, config) {
	const { ratio = 0.06, minTokens = 2048, maxTokens = 12288 } = config?.recent ?? {};
	return clamp(ratio * W, minTokens, maxTokens) | 0;
}

/**
 * Minimum reclaim for a history-rewrite transaction (§58):
 * clamp(0.03·W, 2048, 8192). Below it under normal pressure → no rewrite
 * (fresh/micro tool pruning is the cheaper lever); Emergency is exempt.
 * @param W - context window.
 * @param config - {compaction?: {minReclaimRatio, minReclaimTokens}}.
 * @returns minimum reclaim in tokens.
 */
export function minimumReclaim(W, config) {
	const { minReclaimRatio = 0.03, minReclaimTokens = 2048 } = config?.compaction ?? {};
	return clamp(minReclaimRatio * W, minReclaimTokens, 8192) | 0;
}

function round4(x) {
	return Math.round(x * 10000) / 10000;
}
