/**
 * VAC-GC Metrics (plan §103, §117 — Phase 1 deliverable "Metrics").
 *
 * Pure derivation over a planVacGc() result: every observability number the
 * plan requires is computed from data the plan already carries. No LLM, no
 * re-scoring, O(units).
 *
 * Shadow-mode semantics (Phase 1 = DO NOT COMPACT, §117):
 *   - `tokensAfter` / `pressureAfter` are the PLANNED outcome — what the
 *     selected compaction WOULD do. The surface is untouched, so real
 *     post-compact numbers only exist once a mutating phase executes;
 *   - `summaryTokens` is 0 (no LLM summary is ever produced in Phase 1);
 *   - `exactFacts` / `coverage` are mutation-verification metrics (§101
 *     inspector) — null in shadow, filled by the executing phases.
 *
 * Gate buckets follow the hard-gate priority (§57: Hard Rules > Weight
 * Score): a unit is counted exactly once, in the first gate that rejects
 * it:  P0/P0_TRANSIENT → recent floor → tier not zone-eligible.
 */
import { zoneOf } from "./pressure.js";
import { ZONE_ELIGIBLE } from "./segments.js";

const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Compute §103 metrics for one plan.
 * @param plan - planVacGc() output (normal or degraded).
 * @returns metrics object (see plan doc §103 for the field list).
 */
export function computeVacGcMetrics(plan) {
	const units = plan?.units ?? [];
	const zone = plan?.pressure?.zone ?? "Z0";
	const eligibleTiers = new Set(ZONE_ELIGIBLE[zone] ?? []);

	let rejectedByP0 = 0;
	let rejectedByRecentFloor = 0;
	let rejectedByTier = 0;
	let candidateCount = 0;
	let p0Count = 0;
	let p0TransientCount = 0;
	let p1Count = 0;
	let tokensBefore = 0;
	let scoreSum = 0;
	let scoreMin = Number.POSITIVE_INFINITY;
	let scoreMax = Number.NEGATIVE_INFINITY;

	for (const u of units) {
		tokensBefore += u.tokens ?? 0;
		const s = u.score ?? 0;
		scoreSum += s;
		if (s < scoreMin) scoreMin = s;
		if (s > scoreMax) scoreMax = s;
		if (u.protection === "P0") { p0Count += 1; rejectedByP0 += 1; continue; }
		if (u.protection === "P0_TRANSIENT") { p0TransientCount += 1; rejectedByP0 += 1; continue; }
		if (u.protection === "P1") p1Count += 1;
		// Gate priority: floor before tier (a floor unit is floor-rejected
		// even if its tier is also ineligible).
		if (u.inRecentFloor === true) { rejectedByRecentFloor += 1; continue; }
		if (!eligibleTiers.has(u.tier)) { rejectedByTier += 1; continue; }
		// P1 units in zones without P1 eligibility (Z2/Z3) are tier-gated out.
		candidateCount += 1;
	}

	const reclaim = plan?.selected?.reclaimTokens ?? 0;
	const pressure = plan?.pressure ?? null;

	// Planned pressure after the selected segment is reclaimed.
	let pressureAfter = null;
	if (pressure && Number.isFinite(pressure.contextWindow) && pressure.contextWindow > 0) {
		const inputAfter = Math.max(0, (pressure.inputTokens ?? 0) - reclaim);
		const softAfter = (inputAfter + (pressure.expectedOutput ?? 0) + (pressure.injectionReserve ?? 0)) / pressure.contextWindow;
		const hardAfter = (inputAfter + (pressure.expectedOutput ?? 0) + (pressure.safetyMargin ?? 0)) / pressure.contextWindow;
		pressureAfter = {
			inputTokens: inputAfter,
			soft: round4(softAfter),
			hard: round4(hardAfter),
			zone: zoneOf(softAfter, hardAfter, pressure.config ?? undefined)
		};
	}

	return {
		// §103 — token flow
		tokensBefore,
		tokensAfter: tokensBefore - reclaim,
		reclaim,
		summaryTokens: 0, // Phase 1: no LLM summary is ever produced
		// §103 — pressure (planned outcome in shadow)
		pressureBefore: pressure ? { soft: pressure.soft, hard: pressure.hard, zone: pressure.zone } : null,
		pressureAfter,
		// §103 — protection census
		P0Count: p0Count,
		P1Count: p1Count,
		p0TransientCount,
		// §103 — verification (filled by executing phases; shadow = null)
		exactFacts: null,
		coverage: null,
		// §103 — score distribution over ALL scored units
		averageScore: units.length > 0 ? round4(scoreSum / units.length) : 0,
		minScore: units.length > 0 ? scoreMin : 0,
		maxScore: units.length > 0 ? scoreMax : 0,
		// §103 — gate census (each unit counted exactly once)
		candidateCount,
		rejectedByP0,
		rejectedByBalance: 0, // shadow planner runs no pairing-balance checker
		rejectedByRecentFloor,
		// beyond "at least" (§103): tier-gated exclusions — the key STEP 8
		// false-COLD/false-TRASH observation signal.
		rejectedByTier,
		unitCount: units.length
	};
}
