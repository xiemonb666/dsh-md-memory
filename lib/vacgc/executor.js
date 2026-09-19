/**
 * VAC-GC compaction executor (plan §63–§72) — pure orchestration.
 *
 * This module coordinates the EXECUTING phase of compaction but performs no
 * I/O, no mutation, and no LLM call itself: the two capabilities that WOULD
 * cross that boundary are INJECTED, which is what makes the whole loop
 * unit-testable in Phase 1 (shadow) with fakes:
 *
 *   generateSummary(input) -> string   the ONE LLM call (§63–§65)
 *   persistToMemory(facts, meta) -> {refs, text}   the Memory write (§69/§71)
 *
 * Flow (plan §68/§69/§70/§71/§72):
 *   1. §70/§71 RECOVERY  — for every checkpoint unit (compactCheckpointSource /
 *      provenance sourceEventSeqs), resolve the ORIGINAL shadowed events and
 *      extract their exact facts. Compression depth stays ≈ 1 at the critical-
 *      fact level: facts are recovered from the originals, never from a
 *      summary-of-summary.
 *   2. §70/§71 MEMORY SYNC — when the region contains a checkpoint, persist the
 *      recovered P0/P1 facts to Memory BEFORE any summary is generated. The
 *      persisted block joins the effective memory surface, so the summary is
 *      allowed to carry the memory IDs instead of repeating the facts (§72:
 *      old checkpoint + Memory IDs is enough).
 *   3. §63–§67 GENERATE + VERIFY — the generator gets the §64 template, the raw
 *      segment text, and the verbatim exactFacts; the result is verified
 *      against summary + Memory (P0 100%, P1 ≥ 99%).
 *   4. §68 RETRY POLICY — 1st FAIL: retry with missingFacts[]; 2nd FAIL: shrink
 *      the compact region (deterministic: drop the OLDEST units, keep the most
 *      recent 75%, re-collect facts for the remaining region); still failing:
 *      cancel — unless context-overflow emergency.
 *   5. §69 EMERGENCY — never silently drop facts: persist the region's critical
 *      facts to Memory, append the "Persistent details:" pointer to the last
 *      generated summary, and finish "degraded" (facts live in Memory).
 *
 * Every step emits an event (onEvent) — the raw material for the §101
 * Compaction Inspector (CMP-#### cards: Before/After/Saved/Exact Facts/
 * coverage/Memory Sync).
 */
import { extractExactFacts, projectEvent } from "./text.js";
import {
	SUMMARY_TEMPLATE,
	criticalFactsBefore,
	verifySummaryCoverage,
	retryDecision,
	persistentDetailsPointer
} from "./coverage.js";

/**
 * §68 — deterministic region shrink: keep the most recent 75% of the units
 * (drop the OLDEST first — they contribute least to the upcoming context).
 * @param unitIds - region units in surface (chronological) order.
 * @returns {unitIds, dropped, shrank} — shrank=false when nothing can drop.
 */
export function shrinkRegion(unitIds) {
	const ids = [...(unitIds ?? [])];
	if (ids.length < 2) return { unitIds: ids, dropped: [], shrank: false };
	const keep = Math.max(1, Math.ceil(ids.length * 0.75));
	const dropped = ids.slice(0, ids.length - keep);
	return { unitIds: ids.slice(dropped.length), dropped, shrank: dropped.length > 0 };
}

/**
 * Whether a unit is a (re)compaction checkpoint: planner kind "checkpoint" or
 * provenance sourceEventSeqs (plan §70 compactCheckpointSource recognition).
 * @param unit - executor unit view.
 * @returns true for checkpoint units.
 */
export function isCheckpointUnit(unit) {
	return Boolean(unit) && (unit.kind === "checkpoint" || (unit.sourceEventSeqs?.length ?? 0) > 0);
}

/**
 * Collect the critical facts of a region (§66/§67), with §71 checkpoint
 * recovery: a checkpoint unit's fact set is the union of its own text's
 * facts and the exact facts of its ORIGINAL shadowed events (resolved via
 * eventAt). When the originals resolve, that is the "critical fact recovery"
 * step of the §71 flow — depth ≈ 1.
 * @param units - region units in surface order, each
 *        {unitId, protection, kind, text, sourceEventSeqs}.
 * @param eventAt - (seq) => surface event (for §71 original recovery).
 * @returns {p0Facts, p1Facts, hasCheckpoint, recovered: Map<unitId, number>}
 *          recovered maps a checkpoint unitId to the fact count gained from
 *          its shadowed originals.
 */
export function collectRegionFacts(units, eventAt = () => null) {
	const p0 = new Set();
	const p1 = new Set();
	const recovered = new Map();
	let hasCheckpoint = false;
	for (const unit of units ?? []) {
		const own = extractExactFacts(unit?.text);
		let facts = own;
		if (isCheckpointUnit(unit)) {
			hasCheckpoint = true;
			const originals = (unit.sourceEventSeqs ?? []).map((s) => eventAt?.(s) ?? null).filter(Boolean);
			const fromOriginals = new Set();
			for (const e of originals) {
				const view = projectEvent(e);
				if (view?.text) for (const f of extractExactFacts(view.text)) fromOriginals.add(f);
			}
			if (fromOriginals.size > 0) {
				facts = new Set([...own, ...fromOriginals]);
				recovered.set(unit.unitId, [...fromOriginals].length);
			}
		}
		for (const f of facts) {
			if (unit.protection === "P0" || unit.protection === "P0_TRANSIENT") p0.add(f);
			else if (unit.protection === "P1") p1.add(f);
		}
	}
	return { p0Facts: [...p0].sort(), p1Facts: [...p1].sort(), hasCheckpoint, recovered };
}

/**
 * Run the compaction loop (§63–§72). Pure: all side effects arrive through
 * the injected dependencies.
 * @param opts.units — region units in surface order (the host maps
 *        plan.selected.unitIds onto raw unit views; the executor is
 *        plan-agnostic on purpose).
 * @param opts.eventAt — (seq) => surface event (§71 original recovery).
 * @param opts.generateSummary — async ({template, segmentText, exactFacts,
 *        missingFacts, memoryRefs, attempt}) => summary string (the LLM call).
 * @param opts.persistToMemory — async (facts, meta) => {refs, text}; default
 *        no-op ({refs:[], text:""}) for regions that need no sync.
 * @param opts.memoryText — standing memory surface (pre-compaction).
 * @param opts.isEmergency — context-overflow emergency (§69).
 * @param opts.onEvent — (evt) => void observer (§101 inspector feed).
 * @returns {status: "applied"|"cancelled"|"degraded", summary, attempts,
 *          events, missingFacts, memoryRefs, region: {unitIds, dropped}}
 */
export async function runCompaction(opts) {
	const {
		units,
		eventAt = () => null,
		generateSummary,
		persistToMemory = async () => ({ refs: [], text: "" }),
		memoryText = "",
		isEmergency = false,
		onEvent = () => {}
	} = opts ?? {};
	const base = units ?? [];
	const events = [];
	const push = (evt) => {
		events.push(evt);
		onEvent(evt);
		return evt;
	};

	// §70/§71 — recovery + Memory Sync BEFORE the first generation: a region
	// containing a checkpoint syncs its recovered P0/P1 facts into Memory so
	// the new summary may reference them by ID instead of re-summarizing.
	let { p0Facts, p1Facts, hasCheckpoint } = collectRegionFacts(base, eventAt);
	let memoryRefs = [];
	let syncedText = "";

	let region = [...base];
	let dropped = [];
	let failed = 0;
	let missing = [];
	let lastSummary = null;
	let attempts = 0;
	// §130 fail-safe contract: runCompaction ALWAYS settles to a terminal
	// status (applied / cancelled / degraded) and NEVER rejects — a failed
	// dependency is a cancellation, not an unhandled rejection, so the host
	// can rely on "surface unchanged" from the return value alone.
	const finish = (status, summary = null, reason) => {
		const out = {
			status,
			summary,
			attempts,
			events,
			missingFacts: missing,
			memoryRefs,
			region: { unitIds: region.map((u) => u.unitId), dropped }
		};
		if (reason) out.reason = reason;
		return out;
	};

	if (hasCheckpoint && (p0Facts.length > 0 || p1Facts.length > 0)) {
		const all = [...p0Facts, ...p1Facts];
		let res;
		try {
			res = await persistToMemory(all, { reason: "pre-compaction checkpoint sync (§70/§71)" });
		} catch (err) {
			// §130: memory sync failed → 不 compact — cancel BEFORE any
			// generation; the surface stays exactly as it was.
			const msg = String(err?.message ?? err);
			push({ type: "memory-sync-failed", reason: msg });
			return finish("cancelled", null, `memory sync failed — no compaction (§130): ${msg}`);
		}
		memoryRefs = res?.refs ?? [];
		syncedText = res?.text ?? persistentDetailsPointer(all);
		push({ type: "memory-sync", facts: all.length, refs: [...memoryRefs] });
	}
	const effectiveMemory = `${memoryText}\n${syncedText}`.trim();

	for (;;) {
		let decision = retryDecision(failed, { isEmergency });
		if (decision === "shrink-region") {
			const shrunk = shrinkRegion(region.map((u) => u.unitId));
			if (!shrunk.shrank) {
				// §68: "still failing" is immediate when the region cannot
				// shrink — go to the terminal decision without another generation.
				decision = isEmergency ? "persist" : "cancel";
			} else {
				const kept = new Set(shrunk.unitIds);
				const before = region.length;
				region = region.filter((u) => kept.has(u.unitId));
				dropped = [...dropped, ...shrunk.dropped];
				// the dropped units stay in context raw: their facts are no
				// longer required in the summary → re-collect for the region.
				const recollected = collectRegionFacts(region, eventAt);
				p0Facts = recollected.p0Facts;
				p1Facts = recollected.p1Facts;
				push({ type: "shrink", before, after: region.length, dropped: [...shrunk.dropped] });
			}
		}
		if (decision === "cancel") {
			push({ type: "cancelled", reason: "coverage verification failed after max attempts (§68)" });
			return finish("cancelled", null, "coverage verification failed after max attempts (§68)");
		}
		if (decision === "persist") {
			// §69 — never silently drop facts: persist the region's critical
			// facts to Memory FIRST, then the summary carries the pointer.
			const all = [...p0Facts, ...p1Facts];
			let res;
			try {
				res = await persistToMemory(all, { reason: "emergency persist (§69)" });
			} catch (err) {
				// §130: the emergency persist itself failed — there is no
				// degraded path that is safe (facts would be dropped), so
				// cancel with the surface untouched.
				const msg = String(err?.message ?? err);
				push({ type: "persist-failed", reason: msg });
				return finish("cancelled", null, `emergency persist failed — no safe fallback, surface unchanged (§130): ${msg}`);
			}
			const refs = res?.refs ?? [];
			const pointer = persistentDetailsPointer(all);
			const summary = `${lastSummary ?? ""}\n\n${pointer}`.trim();
			memoryRefs = [...memoryRefs, ...refs];
			push({ type: "persist", facts: all.length, refs: [...refs] });
			push({ type: "degraded", refs: [...refs] });
			return finish("degraded", summary);
		}
		// "generate" | "retry"
		attempts += 1;
		push({ type: decision === "retry" ? "retry" : "generated", attempt: attempts, missingFacts: [...missing] });
		let summary;
		try {
			summary = await generateSummary({
				template: SUMMARY_TEMPLATE,
				segmentText: region.map((u) => u.text).join("\n\n"),
				exactFacts: { p0: p0Facts, p1: p1Facts },
				missingFacts: [...missing],
				memoryRefs: [...memoryRefs],
				attempt: attempts
			});
		} catch (err) {
			// §130: the generator (LLM) crashed — safe no-op. No summary is
			// produced, nothing is applied, the surface stays unchanged.
			const msg = String(err?.message ?? err);
			push({ type: "generation-failed", attempt: attempts, reason: msg });
			return finish("cancelled", null, `summary generation failed — safe no-op, surface unchanged (§130): ${msg}`);
		}
		const verdict = verifySummaryCoverage({ p0Facts, p1Facts, summaryText: summary, memoryText: effectiveMemory });
		push({
			type: "verified",
			attempt: attempts,
			pass: verdict.pass,
			p0: verdict.p0.coverage,
			p1: verdict.p1.coverage,
			missing: [...verdict.missingFacts]
		});
		lastSummary = summary;
		if (verdict.pass) {
			push({ type: "applied" });
			missing = []; // coverage passed — the report carries no missing facts
			return finish("applied", summary);
		}
		failed += 1;
		missing = [...verdict.missingFacts];
	}
}

/**
 * Convenience re-export so the executor's public surface is the whole
 * §63–§72 contract in one import.
 */
export { SUMMARY_TEMPLATE, criticalFactsBefore, verifySummaryCoverage, retryDecision, persistentDetailsPointer };
