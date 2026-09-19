/**
 * VAC-GC weighted scorer (plan §32, §86–87, §34–35).
 *
 * Runs strictly AFTER the hard protection gate. The weights only ORDER
 * compression inside the safe set:
 *
 *   activeValue  = 0.55·taskRelevance + 0.30·recency + 0.15·dependency
 *   base         = max(longTermValue, activeValue)     (§86: MAX, not product —
 *                                                      old-but-important survives)
 *   score        = base + 0.10·dependency
 *                        − 0.22·reconstructibility
 *                        − 0.18·duplication
 *                        − sizePenalty
 *   score        = clamp(score, 0, 1)
 *   P0/P0_TRANSIENT → score 1 (never ordered — they are not candidates)
 *   P1 → score = max(score, 0.75)   (§87 floor: age+reconstructibility must
 *                                    never drag a P1 fact into TRASH)
 *
 * Tiers with hysteresis (§34–35): promotion follows the enter thresholds;
 * demotion needs crossing the (lower) leave thresholds. COLD↔TRASH has no
 * hysteresis in V1 (plan defines only the HOT and WARM pairs).
 */
export const TIERS = ["PINNED", "HOT", "WARM", "COLD", "TRASH"];

/** §34/§35 default thresholds (config can override via the planner). */
export const DEFAULT_TIER_THRESHOLDS = {
	hotEnter: 0.82,
	hotLeave: 0.70,
	warmEnter: 0.58,
	warmLeave: 0.48,
	trashEnter: 0.28
};

/**
 * Score one unit (§86).
 * @param features - { intrinsic, taskRelevance, recency, dependency, reconstructibility, duplication, sizePenalty }.
 * @param protection - {protection} from the gate.
 * @param opts - { reconstructibilityPenalty = 0.22, duplicationPenalty = 0.18 }
 *              (config-overridable, §80).
 * @returns { score, longTermValue, activeValue, base, reasons: string[] }.
 */
export function scoreUnit(features, protection, opts = {}) {
	const xPenalty = Number.isFinite(opts.reconstructibilityPenalty) ? opts.reconstructibilityPenalty : 0.22;
	const dupPenalty = Number.isFinite(opts.duplicationPenalty) ? opts.duplicationPenalty : 0.18;
	const reasons = [];
	if (protection.protection === "P0" || protection.protection === "P0_TRANSIENT") {
		return { score: 1, longTermValue: 1, activeValue: 1, base: 1, reasons: [`protected ${protection.protection} — score pinned at 1 (never auto-compacted under normal pressure)`] };
	}
	const activeValue = clamp01(0.55 * features.taskRelevance + 0.30 * features.recency + 0.15 * features.dependency);
	const longTermValue = clamp01(features.intrinsic);
	const base = Math.max(longTermValue, activeValue);
	let score = base
		+ 0.10 * features.dependency
		- xPenalty * features.reconstructibility
		- dupPenalty * features.duplication
		- features.sizePenalty;
	score = clamp01(score);
	reasons.push(`base=${base.toFixed(2)} (max of intrinsic ${longTermValue.toFixed(2)}, active ${activeValue.toFixed(2)})`);
	reasons.push(`+0.10·dep=${(0.10 * features.dependency).toFixed(2)}`);
	reasons.push(`−${xPenalty}·X=${(xPenalty * features.reconstructibility).toFixed(2)}`);
	reasons.push(`−${dupPenalty}·dup=${(dupPenalty * features.duplication).toFixed(2)}`);
	reasons.push(`−size=${features.sizePenalty.toFixed(3)}`);
	if (protection.protection === "P1" && score < 0.75) {
		reasons.push(`P1 floor applied: ${score.toFixed(3)} → 0.75`);
		score = 0.75;
	}
	return { score, longTermValue, activeValue, base, reasons };
}

/**
 * Assign a tier from a score, honoring hysteresis against the previous tier.
 * @param score - unit score.
 * @param protection - {protection} (P0/P0_TRANSIENT → PINNED unconditionally).
 * @param previousTier - tier in the last plan for this unit id (or null).
 * @param thresholds - tier thresholds (defaults from §34/§35).
 * @returns { tier, demoted, promoted }.
 */
export function assignTier(score, protection, previousTier, thresholds = DEFAULT_TIER_THRESHOLDS) {
	if (protection.protection === "P0" || protection.protection === "P0_TRANSIENT") {
		return { tier: "PINNED", demoted: false, promoted: false };
	}
	const { hotEnter, hotLeave, warmEnter, warmLeave, trashEnter } = { ...DEFAULT_TIER_THRESHOLDS, ...thresholds };
	let candidate;
	if (score >= hotEnter) candidate = "HOT";
	else if (score >= warmEnter) candidate = "WARM";
	else if (score >= trashEnter) candidate = "COLD";
	else candidate = "TRASH";

	// Hysteresis guards DEMOTION only — promotion is immediate (§24: a
	// relevance re-hit lifts a COLD unit straight back to HOT). The plan
	// defines hysteresis pairs for HOT (0.82/0.70) and WARM (0.58/0.48) only;
	// COLD↔TRASH uses the plain 0.28 threshold in both directions in V1.
	let tier = candidate;
	if (previousTier === "HOT" && candidate === "WARM" && score >= hotLeave) tier = "HOT";
	if (previousTier === "WARM" && candidate === "COLD" && score >= warmLeave) tier = "WARM";

	return { tier, demoted: previousTier !== null && tierRank(tier) < tierRank(previousTier), promoted: previousTier !== null && tierRank(tier) > tierRank(previousTier) };
}

function tierRank(tier) {
	if (tier === null || tier === undefined) return -1;
	return TIERS.indexOf(tier);
}

function clamp01(x) {
	if (!Number.isFinite(x)) return 0;
	return Math.min(1, Math.max(0, x));
}
