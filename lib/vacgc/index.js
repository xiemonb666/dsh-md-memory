/**
 * VAC-GC shadow planner (plan STEP 2–6, §83–§95, §117).
 *
 * `planVacGc()` runs the full V1 read-only pipeline over one session surface:
 *
 *   units → hard protection gate → features → weighted score + tier
 *   → pressure/zones → balanced segments → ranking → selection
 *
 * The planner itself NEVER mutates the session surface (§130: read-only,
 * fail-safe to a degraded no-op plan). `freshPrune.actions` carry Phase 2
 * application data (`apply.resultSeqs/toolArgs`, §119) so the ENGINE can
 * land TRASH fresh-prune replacements when `mode !== "shadow"` — the
 * planner only computes; the engine decides (its gate: pre-compact always,
 * turn-end only on a `fresh-prune` decision). In `mode: "shadow"` (the V1.0
 * default) nothing is ever applied: the plan is the A/B record of what a
 * value-aware engine WOULD have done (DEC-002).
 *
 * Fail-safe contract (§130): any internal error degrades to a no-op plan
 * (the surface is never touched); the caller treats a thrown planner as
 * "nothing to do".
 */
import { buildContextUnits, markRecentFloor } from "./units.js";
import { classifyProtection } from "./protection.js";
import { extractFeatures, markRepeatedReadMiddles } from "./features.js";
import { scoreUnit, assignTier, TIERS, DEFAULT_TIER_THRESHOLDS } from "./scorer.js";
import { measurePressure, recentFloorTokens, minimumReclaim, DEFAULT_PRESSURE } from "./pressure.js";
import { buildSegments, rankSegments, selectBestSegment } from "./segments.js";
import { planFreshPrune } from "./prune.js";
import { computeVacGcMetrics } from "./metrics.js";
import { mergeConfig } from "./math.js";
import { extractTerms } from "./text.js";

/**
 * VAC-GC configuration with in-code defaults (§79–81).
 *
 * IMPORTANT (same contract as MML_DEFAULTS): profile patches replace node
 * config WHOLESALE, so every key must carry a default here — the engine
 * merges the config row over this object, never the other way round.
 */
export const VACGC_DEFAULTS = {
	mode: "shadow", // "shadow" | "prune" | "full" — V1.0 implements shadow only
	// Phase 3 semantic execution is opt-in at the engine level. Provisioned
	// MML presets enable it explicitly; shadow/default installs remain
	// read-only until the host has a mutating VAC-GC mode.
	semantic: false,
	observeOnTurnEnd: true,
	pressure: {
		softGc: 0.55,
		coldCompact: 0.68,
		warmCompact: 0.78,
		aggressive: 0.88,
		emergency: 0.94,
		safetyRatio: 0.04,
		injectionReserveRatio: 0.025
	},
	recent: { ratio: 0.06, minTokens: 2048, maxTokens: 12288, floorBypassX: 0.80 },
	scoring: {
		reconstructibilityPenalty: 0.22,
		duplicationPenalty: 0.18,
		hotEnter: DEFAULT_TIER_THRESHOLDS.hotEnter,
		hotLeave: DEFAULT_TIER_THRESHOLDS.hotLeave,
		warmEnter: DEFAULT_TIER_THRESHOLDS.warmEnter,
		warmLeave: DEFAULT_TIER_THRESHOLDS.warmLeave
	},
	compaction: {
		minReclaimRatio: 0.03,
		minReclaimTokens: 2048,
		maxReclaimTokens: 65536,
		summaryMaxTokens: 4096,
		retryOnCoverageFailure: 1
	},
	memory: { enabled: true, requireSyncForP1: true },
	ui: { enabled: true, showPerRequest: true },
	maxUnitsInPlan: 400
};

/**
 * Resolve a partial VAC-GC config over the defaults.
 * @param raw - partial config (e.g. from the engine config row).
 * @returns fully-resolved config.
 */
export function resolveVacGcConfig(raw) {
	const source = raw ?? {};
	const resolved = mergeConfig(VACGC_DEFAULTS, source);
	// Older DSH schema adapters may drop newly-added scalar keys (or inject a
	// schema default of `false`) while still forwarding the established
	// `vacgcMode`.  `prune` is the explicit opt-in mutating lane, so it always
	// carries Phase 3; shadow/default installs remain read-only.  This keeps
	// the MML preset behavior stable across host schema versions.
	if (resolved.mode === "prune") resolved.semantic = true;
	return resolved;
}

/**
 * Run one read-only planning pass.
 * @param input - {
 *   nodes: number[],                    surface seqs in positional order
 *   eventAt: (seq) => event|undefined,
 *   prices?: Array<{seq, tokens}>,
 *   now?: number,
 *   query?: string,                      active query (last user message)
 *   memory?: LedgerIndex|null,
 *   contextWindow: number,
 *   inputTokens: number,                 priced total (header + surface)
 *   requestedMaxOutput?: number,
 *   expectedOutput?: number,
 *   previousTiers?: Map<string, string>, unitId → last tier (hysteresis)
 *   config?: object,                     partial vacgc config
 *   trigger?: string,
 *   sessionId?: string,
 *   balancedBefore?: (seq) => boolean,
 *   balancedAfter?: (seq) => boolean,
 *   maxUnitsInPlan?: number
 * }
 * @returns the plan (see below). Never throws for planner-internal errors —
 *          it returns a degraded {degraded: true} plan instead (§130).
 */
export function planVacGc(input) {
	const config = resolveVacGcConfig(input.config);
	const startedAt = Date.now();
	const previousTiers = input.previousTiers ?? null;
	try {
		const now = Number.isFinite(input.now) ? input.now : Date.now();

		// §83: build units (positional surface order, atomic pairs).
		const { units, meta } = buildContextUnits({ nodes: input.nodes, eventAt: input.eventAt, prices: input.prices, now });
		const floorTokens = recentFloorTokens(input.contextWindow, config);
		markRecentFloor(units, floorTokens);

		// §83: hard protection gate FIRST (Hard Rules > Weight Score).
		// §84/§19: active query = last user message terms ∪ STATE-CURRENT terms.
		const query = buildQueryTerms(input.query, input.memory, config);

		// Score every unit (O(units), no LLM). §30 middle-read marks need the
		// FULL unit list first (a middle is only known once the last read of
		// its run is seen) — a pure pre-pass over the same units.
		const duplicationState = { byFingerprint: new Set(), byGroup: new Map(), readMiddles: markRepeatedReadMiddles(units) };
		const rows = [];
		const tierStats = new Map(TIERS.map((t) => [t, { count: 0, tokens: 0 }]));
		for (const unit of units) {
			// Provenance lane (review 2026-09-12, P0): a unit whose source
			// seqs back an ACTIVE ledger entry is P0 even when the entry's
			// ID never appears in the unit's text (the original "不要开 MTP"
			// message predates the DEC-006 id).
			const protection = classifyProtection(unit, { memory: input.memory ?? null, sessionId: input.sessionId ?? null });
			// The P1 intrinsic overrides (decision 0.98, benchmark 0.85, …) live
			// in extractFeatures — the gate result must reach it or they never
			// apply (plan §127: a recent P1 decision is HOT, not the raw 0.55).
			const { features, contentType, notes } = extractFeatures(unit, { query, memory: input.memory ?? null, now, duplicationState, protection });
			const { score } = scoreUnit(features, protection, config.scoring);
			const { tier } = assignTier(score, protection, previousTiers?.get(unit.id) ?? null, config.scoring);
			const stat = tierStats.get(tier);
			stat.count += 1;
			stat.tokens += unit.tokens;
			rows.push({
				unitId: unit.id,
				firstSeq: unit.seqs[0],
				lastSeq: unit.seqs[unit.seqs.length - 1],
				kind: unit.kind,
				toolName: unit.toolName,
				tokens: unit.tokens,
				protection: protection.protection,
				protectionReasons: protection.reasons,
				score: Math.round(score * 10000) / 10000,
				tier,
				inRecentFloor: unit.inRecentFloor === true,
				features,
				contentType,
				notes,
				open: unit.open === true
			});
		}

		// §84: pressure and zone.
		const pressure = measurePressure({
			inputTokens: input.inputTokens,
			contextWindow: input.contextWindow,
			requestedMaxOutput: input.requestedMaxOutput,
			expectedOutput: input.expectedOutput,
			config: { pressure: config.pressure }
		});

		// §43/§119 STEP 9 preview: the FRESH/MICRO PRUNE dry-run diff — what
		// the first mutating phase WOULD do on this exact surface right now
		// (TRASH tier only; §43: Z0 may reduce large tool results but may
		// NOT drop duplicates — drops need Z1+). Pure: no mutation, no LLM.
		const rowById = new Map(rows.map((r) => [r.unitId, r]));
		const allowDrop = pressure.zone !== "Z0";
		const freshPruneRaw = planFreshPrune(
			units.map((u) => {
				const r = rowById.get(u.id);
				return {
					unitId: u.id,
					kind: u.kind,
					open: u.open === true,
					toolName: u.toolName,
					toolArgs: u.toolArgs,
					text: u.text,
					tier: r ? r.tier : null,
					protection: r ? r.protection : null,
					tokens: u.tokens,
					inRecentFloor: u.inRecentFloor === true,
					reconstructibility: r ? r.features.reconstructibility : null
				};
			}),
			{ allowDrop, floorBypassX: config.recent.floorBypassX }
		);
		const unitById = new Map(units.map((u) => [u.id, u]));
		const freshPrune = {
			allowDrop,
			actions: freshPruneRaw.actions.map((a) => {
				const u = unitById.get(a.unitId);
				const resultSeqs = u ? u.seqs.filter((seq) => input.eventAt(seq)?.type === "tool/result") : [];
				return {
					unitId: a.unitId,
					kind: a.kind,
					toolName: a.toolName,
					reason: a.reason,
					raw: a.raw,
					before: a.before,
					after: a.after,
					reclaim: a.reclaim,
					preview: a.kind === "reduce" ? a.reducedText.slice(0, 160) : null,
					// Phase 2 application data (§119): which RESULT nodes the
					// action covers (the assistant-message call node is never
					// touched — the surface layer cannot delete it) and the
					// tool args the reducer needs. Absent units (defensive)
					// carry null — the apply step skips them.
					apply: u ? { resultSeqs, toolArgs: u.toolArgs ?? "" } : null
				};
			}),
			totalReclaim: freshPruneRaw.totalReclaim,
			stats: freshPruneRaw.stats
		};

		// §89: zones adjust the candidate set.
		const minReclaim = minimumReclaim(input.contextWindow, config);
		const segments = buildSegments(rows, {
			zone: pressure.zone,
			minReclaimTokens: minReclaim,
			maxReclaimTokens: config.compaction.maxReclaimTokens,
			balancedBefore: input.balancedBefore,
			balancedAfter: input.balancedAfter
		});
		const ranked = rankSegments(segments);
		const selected = selectBestSegment(ranked);

		// §59 cache-aware cost gate: low pressure + small reclaim → prefer
		// fresh/micro tool pruning over a prefix rewrite.
		let decision = decideAction(pressure, selected, rows, minReclaim, config);

		// TRASH lane candidates (Z1 fresh/micro pruning; Z0 score cache only).
		// Floor units count when the tool garbage bypass admits them (same
		// condition planFreshPrune applies) — the SEMANTIC floor still holds
		// for segment compaction (buildSegments keeps excluding them).
		const bypassX = Number.isFinite(config.recent.floorBypassX) ? config.recent.floorBypassX : 0.80;
		const floorBypassEligible = (r) => r.inRecentFloor !== true
			|| (bypassX > 0 && (r.features.reconstructibility ?? 0) >= bypassX);
		const pruneCandidates = pressure.zone === "Z1"
			? rows.filter((r) => r.tier === "TRASH" && r.protection === "NORMAL" && floorBypassEligible(r)).map((r) => ({ unitId: r.unitId, firstSeq: r.firstSeq, lastSeq: r.lastSeq, tokens: r.tokens, score: r.score }))
			: [];

		const plan = {
			schema: "vacgc-plan-v1",
			sessionId: input.sessionId ?? null,
			trigger: input.trigger ?? "turn-end",
			generatedAt: now,
			degraded: false,
			// §103/§117: Phase 1 observability (pure derivation, no LLM).
			metrics: computeVacGcMetrics({ pressure, units: rows, selected: selected ? { reclaimTokens: selected.reclaimTokens } : null }),
			mode: config.mode,
			pressure,
			recentFloorTokens: floorTokens,
			minimumReclaimTokens: minReclaim,
			tiers: Object.fromEntries([...tierStats].map(([tier, s]) => [tier, s])),
			units: rows.slice(0, input.maxUnitsInPlan ?? config.maxUnitsInPlan),
			unitCount: rows.length,
			segments: segments.map((s) => ({ id: s.id, unitIds: s.unitIds, firstSeq: s.firstSeq, lastSeq: s.lastSeq, tokens: s.tokens, lossDensity: s.lossDensity, priority: s.priority, containsP1: s.containsP1, gates: s.gates, eligible: s.eligible })),
			rankedSegments: ranked.map((s) => s.id),
			selected: selected ? { id: selected.id, unitIds: selected.unitIds, firstSeq: selected.firstSeq, lastSeq: selected.lastSeq, reclaimTokens: selected.reclaimTokens, lossDensity: selected.lossDensity, priority: selected.priority, requiresMemorySync: selected.containsP1 && config.memory.requireSyncForP1 } : null,
			pruneCandidates,
			freshPrune,
			decision,
			meta: { ...meta, elapsedMs: Date.now() - startedAt }
		};
		return plan;
	} catch (error) {
		// §130 fail-safe: a scorer/planner crash is a safe no-op — never a
		// compact-all, never a mutation.
		const degraded = {
			schema: "vacgc-plan-v1",
			sessionId: input.sessionId ?? null,
			trigger: input.trigger ?? "turn-end",
			generatedAt: Date.now(),
			degraded: true,
			mode: config.mode,
			error: String(error?.message ?? error),
			decision: { action: "none", reason: `planner degraded to no-op: ${String(error?.message ?? error)}`, escalation: ESCALATION_LADDER },
			tiers: Object.fromEntries(TIERS.map((t) => [t, { count: 0, tokens: 0 }])),
			units: [],
			unitCount: 0,
			segments: [],
			rankedSegments: [],
			selected: null,
			pruneCandidates: [],
			freshPrune: { allowDrop: null, actions: [], totalReclaim: 0, stats: { scanned: 0, trashTools: 0, reduced: 0, dropped: 0, untouched: 0 } },
			meta: { elapsedMs: Date.now() - startedAt }
		};
		degraded.metrics = computeVacGcMetrics(degraded);
		return degraded;
	}
}

/**
 * Active query terms (§16–19): last user message ∪ STATE-CURRENT standing
 * context. Lexical only.
 * @param queryText - last user message text.
 * @param memory - LedgerIndex or null.
 * @param config - resolved config.
 * @returns merged lowercase term view.
 */
export function buildQueryTerms(queryText, memory, config) {
	const merged = { ids: new Set(), paths: new Set(), symbols: new Set(), errors: new Set(), models: new Set(), keywords: new Set() };
	const fold = (terms) => {
		for (const id of terms.ids) merged.ids.add(id.toLowerCase());
		for (const p of terms.paths) merged.paths.add(p.toLowerCase());
		for (const s of terms.symbols) merged.symbols.add(s.toLowerCase());
		for (const e of terms.errors) merged.errors.add(e.toLowerCase());
		for (const m of new Set([...terms.modelNames, ...terms.versions])) merged.models.add(m.toLowerCase());
		for (const kw of terms.keywordsEn) merged.keywords.add(kw.toLowerCase());
		for (const kw of terms.keywordsZh) merged.keywords.add(kw.toLowerCase());
	};
	if (typeof queryText === "string" && queryText.length > 0) fold(extractTerms(queryText));
	if (config?.memory?.enabled && memory?.available) {
		const stateTerms = extractTerms(memory.stateText);
		fold(stateTerms);
		// Active entry IDs themselves are query-relevant (§85).
		for (const id of memory.activeIds) merged.ids.add(id.toLowerCase());
	}
	return merged;
}

/**
 * §131 — the emergency escalation ladder for TRUE overflow (zone Z5):
 * tool prune → TRASH → COLD → WARM → P1+Memory → reduce requested output.
 * P0 is NEVER deleted. Carried on every decision (constant) so the plan
 * itself documents the contract a future executing engine must follow.
 */
export const ESCALATION_LADDER = ["tool-prune", "trash-prune", "cold-compact", "warm-compact", "p1-memory", "reduce-output"];

/**
 * Decide what a value-aware engine WOULD do this round (shadow: reported,
 * never executed).
 * @returns {action: "none"|"fresh-prune"|"compact", reason: string,
 *          escalation: string[] (§131 ladder, constant)}.
 */
function decideAction(pressure, selected, rows, minReclaim, config) {
	const zone = pressure.zone;
	// §131: Z5 is a true overflow — the decision documents the ladder it must
	// follow when executed, in order, and that P0 is never deleted.
	const emergencyNote = zone === "Z5"
		? `; §131 EMERGENCY overflow — escalate in ladder order ${ESCALATION_LADDER.join(" → ")} (P0 is never deleted)`
		: "";
	if (zone === "Z0") {
		return { action: "none", reason: `Z0 (${pressure.soft}) — below softGc; only the score cache is refreshed (no history rewrite, §43)`, escalation: ESCALATION_LADDER };
	}
	if (zone === "Z1") {
		const bx = Number.isFinite(config.recent.floorBypassX) ? config.recent.floorBypassX : 0.80;
		const n = rows.filter((r) => r.tier === "TRASH" && (r.inRecentFloor !== true || (bx > 0 && (r.features.reconstructibility ?? 0) >= bx))).length;
		return { action: "fresh-prune", reason: `Z1 (${pressure.soft}) — TRASH micro-prune of ${n} unit(s), no LLM summary (§43); recent floor is semantic — reconstructible tool garbage bypasses it (reduce-only)`, escalation: ESCALATION_LADDER };
	}
	if (selected) {
		return { action: "compact", reason: `Z${zone.slice(1)} (${pressure.soft}) — would compact ${selected.id} (reclaim ${selected.reclaimTokens} tokens, lossDensity ${selected.lossDensity}${selected.containsP1 ? "; P1 content: Memory Sync + exact-fact coverage required before execution" : ""})${emergencyNote}`, escalation: ESCALATION_LADDER };
	}
	return { action: "none", reason: `Z${zone.slice(1)} (${pressure.soft}) — no segment passes the hard gates (minReclaim ${minReclaim} tokens, recent floor, pairing balance)${emergencyNote}`, escalation: ESCALATION_LADDER };
}
