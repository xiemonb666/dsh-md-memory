/**
 * VAC-GC Phase 2a — manual compact guard (pure decision module).
 *
 * Decides whether a manual /compact request is worth a summarizer call at
 * all. A verbose local model cannot reliably produce a summary smaller
 * than a trivially small span, and the base engine's shrink guard turns
 * such an attempt into a "could not produce a useful summary" failure
 * with the conversation unchanged. Below the minimum, the engine's
 * compactNow returns null instead, which the command layer renders as the
 * gentle "No compactable history yet."
 *
 * Pinned by test/vacgc/purity.test.js: no imports of any kind, no host
 * services, no LLM surface — the same V1 hard constraint as the rest of
 * lib/vacgc.
 */

/**
 * Compactable spans below this many calibrated tokens are not worth
 * compacting: the summary's own overhead cannot be beaten on a span this
 * small, so the attempt is a guaranteed non-shrink (the base engine
 * refuses to commit it and surfaces a scary error for no state change).
 */
export const MIN_MANUAL_COMPACT_SPAN_TOKENS = 1024;

/**
 * Sum the calibrated tokens of the nodes whose surface seq falls inside
 * the inclusive range. Seq-based (not index-based) so spliced or pruned
 * surfaces with seq gaps price correctly.
 * @param nodes - priced surface nodes, [{seq, tokens}...].
 * @param range - inclusive {start, end} seq range.
 * @returns the span's calibrated token total (0 for null/empty input).
 */
export function spanTokens(nodes, range) {
	if (range === null || range === undefined) return 0;
	let total = 0;
	for (const node of nodes ?? []) {
		if (node.seq >= range.start && node.seq <= range.end) total += node.tokens;
	}
	return total;
}

/**
 * True when a selected span exists but is below the manual-compact
 * minimum, i.e. the summarizer call should be skipped. A null range is
 * never "skippable" here — the base engine already reports null for it.
 * @param nodes - priced surface nodes, [{seq, tokens}...].
 * @param range - selected inclusive {start, end} seq range, or null.
 * @param minTokens - span minimum (defaults to MIN_MANUAL_COMPACT_SPAN_TOKENS).
 * @returns true when the span is too small to compact usefully.
 */
export function shouldSkipManualCompact(nodes, range, minTokens = MIN_MANUAL_COMPACT_SPAN_TOKENS) {
	if (range === null || range === undefined) return false;
	return spanTokens(nodes, range) < minTokens;
}
