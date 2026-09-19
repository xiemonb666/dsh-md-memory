/**
 * VAC-GC segment builder, ranking, and hard gates (plan §53–§59, §88–89).
 *
 * A compaction candidate MUST be a contiguous span of surface units — never
 * a discrete set of scattered messages (§54). Units are already atomic
 * (tool-call/result pairs are one unit), so a contiguous run of whole units
 * has balanced tool-pairing boundaries by construction; the planner double-
 * checks against the real session's toolPairingBalancedBefore/After when one
 * is supplied (defensive gate, §57).
 *
 * Ranking (§56/§88): lossDensity = Σ(score·tokens)/Σtokens over the segment;
 * segmentPriority = reclaimTokens × (1 − lossDensity).
 *
 * Gates (§57/§89, hard — no weight may pass them):
 *   1. segment contains a P0/P0_TRANSIENT unit → reject;
 *   2. unbalanced tool-pairing boundary (when checkable) → reject;
 *   3. segment intersects the recent floor → reject (floor protects the
 *      semantic working set, §45);
 *   4. P1 content → only in Z4/Z5, and requires Memory Sync (planner flag);
 *   5. normal pressure: reclaim < minimumReclaim → reject (Emergency exempt);
 *   6. cache-aware cost gate (§59): low pressure + small reclaim → the
 *      planner prefers fresh/micro pruning over a prefix rewrite.
 */

/** Tiers eligible for a semantic segment per zone (Z0/Z1: none — pruning lane). */
export const ZONE_ELIGIBLE = {
	Z0: [],
	Z1: [],
	Z2: ["TRASH", "COLD"],
	Z3: ["TRASH", "COLD", "WARM"],
	Z4: ["TRASH", "COLD", "WARM"],
	Z5: ["TRASH", "COLD", "WARM", "HOT"]
};

/** §57: P1 units enter the candidate set only in Z4/Z5 (with sync). */
const P1_ZONES = new Set(["Z4", "Z5"]);

/**
 * Build balanced segments from scored units.
 * @param scoredUnits - array of { unit, protection, score, tier } in surface
 *                      order (the planner's per-unit row).
 * @param opts - { zone, minReclaimTokens, maxReclaimTokens, requireSyncForP1,
 *                balancedBefore?, balancedAfter? } — the optional
 *                (firstSeq)/→(lastSeq) balancers for the live session.
 * @returns [{
 *   id, unitIds: string[], firstSeq, lastSeq, tokens,
 *   lossDensity, priority, containsP1, gates: {p0, unbalanced, recentFloor,
 *   minReclaim, zoneP1} (all booleans), eligible
 * }].
 */
export function buildSegments(scoredUnits, opts = {}) {
	const zone = opts.zone ?? "Z2";
	const eligibleTiers = new Set(ZONE_ELIGIBLE[zone] ?? []);
	const segments = [];

	let run = [];
	const flush = () => {
		if (run.length === 0) return;
		segments.push(finalizeRun(run, opts));
		run = [];
	};

	for (const row of scoredUnits) {
		const eligible = isEligible(row, eligibleTiers, zone, opts);
		if (eligible) {
			run.push(row);
		} else {
			flush();
		}
	}
	flush();
	return segments;
}

function isEligible(row, eligibleTiers, zone, opts) {
	if (row.protection === "P0" || row.protection === "P0_TRANSIENT") return false; // §57 gate 1
	if (row.inRecentFloor === true) return false; // §45 floor protection
	const tierOk = eligibleTiers.has(row.tier);
	const p1Ok = row.protection === "P1" ? P1_ZONES.has(zone) : true;
	return tierOk && p1Ok;
}

function finalizeRun(rows, opts) {
	const first = rows[0];
	const last = rows[rows.length - 1];
	const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
	const lossWeighted = rows.reduce((sum, row) => sum + row.score * row.tokens, 0);
	const lossDensity = tokens > 0 ? lossWeighted / tokens : 0;
	const priority = tokens * (1 - lossDensity);
	const containsP1 = rows.some((row) => row.protection === "P1");

	const gates = { p0: false, unbalanced: false, recentFloor: false, minReclaim: false, overCap: false, zoneP1: false, cacheCost: false };
	if (rows.some((row) => row.protection === "P0" || row.protection === "P0_TRANSIENT")) gates.p0 = true;
	if (rows.some((row) => row.inRecentFloor === true)) gates.recentFloor = true;
	if (containsP1 && !P1_ZONES.has(opts.zone ?? "Z2")) gates.zoneP1 = true;
	if (typeof opts.balancedBefore === "function" && !opts.balancedBefore(first.firstSeq)) gates.unbalanced = true;
	if (typeof opts.balancedAfter === "function" && !opts.balancedAfter(last.lastSeq)) gates.unbalanced = true;
	if (Number.isFinite(opts.minReclaimTokens) && tokens < opts.minReclaimTokens && (opts.zone ?? "Z2") !== "Z5") gates.minReclaim = true;
	if (Number.isFinite(opts.maxReclaimTokens) && tokens > opts.maxReclaimTokens) gates.overCap = true; // over-cap: not a valid single transaction in V1

	return {
		id: `SEG-${first.firstSeq}-${last.lastSeq}`,
		unitIds: rows.map((row) => row.unitId),
		firstSeq: first.firstSeq,
		lastSeq: last.lastSeq,
		tokens,
		reclaimTokens: tokens,
		lossDensity: round4(lossDensity),
		priority: round2(priority),
		containsP1,
		gates,
		eligible: !gates.p0 && !gates.unbalanced && !gates.recentFloor && !gates.minReclaim && !gates.overCap && !gates.zoneP1 && !gates.cacheCost
	};
}

/**
 * Rank gate-passing segments by priority (§88) descending.
 * @param segments - buildSegments() output.
 * @returns the eligible segments, sorted.
 */
export function rankSegments(segments) {
	return segments
		.filter((s) => s.eligible)
		.sort((a, b) => b.priority - a.priority || b.tokens - a.tokens);
}

/**
 * Select the best segment (§89): the top-ranked gate-passing one, or null
 * when nothing qualifies (the planner then leaves the surface untouched).
 * @param ranked - rankSegments() output.
 * @returns segment or null.
 */
export function selectBestSegment(ranked) {
	return ranked[0] ?? null;
}

function round4(x) {
	return Math.round(x * 10000) / 10000;
}
function round2(x) {
	return Math.round(x * 100) / 100;
}
