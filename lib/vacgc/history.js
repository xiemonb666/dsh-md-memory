/**
 * VAC-GC §102 Context History — slim shadow-plan snapshots for the
 * "Context History" sparkline on the Context tab.
 *
 * The sparkline shows the context-token trajectory over time and marks:
 *   - planned history compact (action "compact" — shadow until Phase 2+)
 *   - planned fresh/micro prune (action "fresh-prune")
 *   - injection spikes (tokens carried by injected units — e.g. "你好 → 30K")
 *   - planner-degraded samples
 * In Phase 1 every marker is a PLAN, not an executed compaction — the point
 * shape already reserves the fields a real execution event will fill
 * (summaryTokens/coverage arrive with Phase 3; sync with Phase 5).
 *
 * Pure functions — no host dependency, so the host ring and the test suite
 * share one implementation.
 */

/** Ring capacity per session (≈ 240 turn-end samples). */
export const HISTORY_CAP = 240;

/**
 * A slim, JSON-serializable history point from one shadow plan.
 * @param plan - planVacGc() output (or null/undefined → null point).
 * @returns point or null when the input is not a plan.
 */
export function vacGcHistoryPoint(plan) {
	if (plan === null || plan === undefined || typeof plan !== "object") return null;
	const p = plan.pressure ?? {};
	let inj = 0;
	const units = Array.isArray(plan.units) ? plan.units : [];
	for (const row of units) {
		if (row && row.kind === "injected") inj += row.tokens ?? 0;
	}
	return {
		t: plan.generatedAt ?? null,
		in: p.inputTokens ?? null,
		win: p.contextWindow ?? null,
		soft: p.soft ?? null,
		hard: p.hard ?? null,
		zone: p.zone ?? null,
		action: plan.decision?.action ?? "none",
		reclaim: plan.selected?.reclaimTokens ?? 0,
		inj,
		degraded: plan.degraded === true
	};
}

/**
 * Append one plan's point to a bounded history (mutates `points` in place
 * and returns it).
 *
 * - Same `generatedAt` as the last point → REPLACE (turn-end bursts re-plan
 *   with the same clock tick; a history must not double-count them).
 * - Chronological order preserved; oldest points drop off at `cap`.
 * @param points - the session's history array.
 * @param plan - planVacGc() output (null/undefined → no-op).
 * @param cap - ring capacity (default HISTORY_CAP).
 */
export function appendVacGcHistory(points, plan, cap = HISTORY_CAP) {
	const point = vacGcHistoryPoint(plan);
	if (point === null) return points;
	if (points.length > 0 && points[points.length - 1]?.t === point.t) {
		points[points.length - 1] = point;
	} else {
		points.push(point);
	}
	while (points.length > cap) points.shift();
	return points;
}
