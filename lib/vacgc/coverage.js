/**
 * VAC-GC summary contract (plan §63–§70) — the pure, deterministic half.
 *
 * What lands here (Phase-1 testable, LLM-free):
 *   - criticalFactsBefore      §66/§67 — critical facts of the units about to
 *                              be compacted, split by protection level
 *   - verifySummaryCoverage    §67 — compare criticalBefore against
 *                              summary + Memory; P0 coverage must be 100%,
 *                              P1 exact coverage ≥ 99%, else reject
 *   - retryDecision            §68 — the retry / shrink / cancel / persist
 *                              state machine
 *   - persistentDetailsPointer §69 — the "Persistent details:" block placed
 *                              when facts are saved to Memory (never silently
 *                              drop facts, even in emergency)
 *
 * What this module does NOT do: summary generation (the LLM step — Phase 3),
 * Memory writes, region shrinking. The executing compactor (STEPS 9–12)
 * orchestrates these calls; this file pins the contract it must satisfy.
 */
import { extractExactFacts } from "./text.js";

/** §67 — P0 facts must be 100% covered by summary + Memory. */
export const P0_COVERAGE_REQUIRED = 1.0;
/** §67 — P1 exact-coverage threshold (>= 99%). */
export const P1_COVERAGE_REQUIRED = 0.99;

/**
 * §63/§64 — the summary is NOT a free-form "Summarize this conversation":
 * the generator receives this structured template and must fill it. Exact
 * Facts and Memory References are where the verbatim facts (§65) live.
 */
export const SUMMARY_TEMPLATE = `# Compacted Segment

## Objective
...

## Completed Work
...

## Decisions
...

## Rejected Approaches
...

## Unresolved
...

## Exact Facts
- path:
- version:
- number:
- command:
- error:

## Files
...

## Memory References
DEC-...
TASK-...
ERR-...
BENCH-...

## Discarded Detail
Repeated logs and reconstructible outputs were removed.`;

/**
 * §66/§67 — collect the critical facts of the units about to be compacted,
 * split by protection level. Facts from NORMAL units are NOT critical: they
 * are reconstructible/discardable by definition of their tier.
 * @param units - [{protection, text}] — RAW unit text from the surface
 *        (plan rows are slim by design and carry no text).
 * @returns {p0Facts: string[], p1Facts: string[]}
 */
export function criticalFactsBefore(units) {
	const p0 = new Set();
	const p1 = new Set();
	for (const unit of units ?? []) {
		if (!unit || typeof unit.text !== "string") continue;
		const facts = extractExactFacts(unit.text);
		if (unit.protection === "P0" || unit.protection === "P0_TRANSIENT") {
			for (const f of facts) p0.add(f);
		} else if (unit.protection === "P1") {
			for (const f of facts) p1.add(f);
		}
	}
	return { p0Facts: [...p0], p1Facts: [...p1] };
}

/**
 * §67 — coverage verification: criticalBefore vs `summaryText` + `memoryText`.
 * A fact is covered only if it appears VERBATIM (§65: the model may not
 * rewrite numbers) in the summary OR in Memory — a fact persisted to the
 * ledger counts, which is exactly the §69 emergency mechanism.
 * @param p0Facts - exact fact strings from P0/P0_TRANSIENT units.
 * @param p1Facts - exact fact strings from P1 units.
 * @param summaryText - the generated summary.
 * @param memoryText - the standing memory surface text (state/ledger).
 * @returns {pass, p0, p1, missingFacts} where p0/p1 = {total, covered,
 *          missing: string[], coverage: number}
 */
export function verifySummaryCoverage({ p0Facts = [], p1Facts = [], summaryText = "", memoryText = "" }) {
	const haystack = `${String(summaryText ?? "")}\n${String(memoryText ?? "")}`;
	const audit = (facts) => {
		const list = [...new Set(facts ?? [])];
		const missing = list.filter((f) => !haystack.includes(f));
		const covered = list.length - missing.length;
		return {
			total: list.length,
			covered,
			missing,
			coverage: list.length === 0 ? 1 : covered / list.length
		};
	};
	const p0 = audit(p0Facts);
	const p1 = audit(p1Facts);
	return {
		pass: p0.coverage >= P0_COVERAGE_REQUIRED && p1.coverage >= P1_COVERAGE_REQUIRED,
		p0,
		p1,
		missingFacts: [...p0.missing, ...p1.missing]
	};
}

/**
 * §68 — retry policy state machine.
 * @param failedAttempts - generations already verified as FAIL (0 = fresh).
 * @param opts.isEmergency - context-overflow emergency (§69): the terminal
 *        decision becomes persist-to-memory instead of cancel.
 * @returns "generate" | "retry" (with missingFacts[]) | "shrink-region" |
 *          "cancel" | "persist"
 */
export function retryDecision(failedAttempts, { isEmergency = false } = {}) {
	if (failedAttempts <= 0) return "generate";
	if (failedAttempts === 1) return "retry";
	if (failedAttempts === 2) return "shrink-region";
	return isEmergency ? "persist" : "cancel";
}

/**
 * §69 — the "Persistent details:" pointer a summary must carry when exact
 * facts were saved to Memory (emergency or otherwise — never silently drop
 * facts). Format per the plan's example:
 *
 *   Persistent details:
 *   REQ-018
 *   DEC-021
 *   BENCH-031
 *
 * @param facts - fact strings to persist.
 * @returns the pointer block, or "" when there is nothing to persist.
 */
export function persistentDetailsPointer(facts) {
	const lines = [...new Set((facts ?? []).filter((f) => typeof f === "string" && f.length > 0))];
	if (lines.length === 0) return "";
	return `Persistent details:\n${lines.join("\n")}`;
}
