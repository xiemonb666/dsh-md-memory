/**
 * VAC-GC Phase 2 application (§119) — landing the FRESH/MICRO PRUNE on the
 * session surface.
 *
 * Phase 2 scope (§119/§125): TRASH tier only; P0/P0_TRANSIENT/P1 and
 * recent-floor units are never touched; no semantic compact (that is Phase
 * 3+). The planner already enforces those gates when it builds
 * `plan.freshPrune.actions`; this module only turns the surviving actions
 * into surface replacements.
 *
 * SURFACE CONSTRAINTS (dsh-session/surface): there is NO "remove" op —
 * surfaceOp is `append` or `replace` only, and a `tool/result` replacement
 * must rewrite EXACTLY ONE current node and may change ONLY its content
 * (`assertToolResultRewrite`). Every Phase 2 action therefore lands as a
 * CONTENT replacement:
 *
 *   - "reduce": the node's text is replaced with the per-tool reducer
 *     output (§48–§52 shape, always ending in a RAW POINTER, so the raw
 *     output stays re-derivable);
 *   - "drop" (duplicate unit): the node's text is replaced with a raw-pointer
 *     STUB. The atomic tool CALL lives in the assistant message (§128 pair)
 *     and the surface layer cannot delete it — leaving it intact keeps
 *     call/result pairing valid while the duplicate's token mass exits the
 *     model surface.
 *
 * Landing mirrors the official ToolResultPruner transaction shape: a
 * `compaction/prune` shadow-price event immediately followed by the
 * `tool/result` replace with provenance (`surfaceOp` + `sourceEventSeqs`).
 * If the session rejects a replacement, earlier landings stay durable
 * (same contract as the official pruner) and the engine catches the throw
 * (fail-safe: §130 — a prune failure degrades to shadow, never to a loss).
 *
 * Purity note: the official pruner pre-freezes the replacement message with
 * the host's message-freeze helper — but the session's `append` already
 * detaches (JSON snapshot) and deep-freezes every event data it publishes,
 * so the message is handed over plain. Keeping this module free of
 * host-package imports preserves the V1.0 purity guard on `lib/vacgc`
 * (the session layer owns the freeze contract).
 *
 * Planning (`planNodePrunes`) is pure and fake-session-testable; landing
 * (`landNodePrunes`) needs the real session's `append`/`eventAt`.
 */
import { reduceToolResult } from "./prune.js";

/**
 * The all-text content view of one tool/result node, or null when the node
 * is ineligible for Phase 2 v1 (empty content, or any non-text block — mixed
 * rich results stay with the official pruner, which preserves block order).
 * @param event - tool/result surface event.
 * @returns {blocks, result, text} or null.
 */
function textContent(event) {
	const message = event?.data?.message;
	const content = message?.content;
	if (!Array.isArray(content) || content.length === 0) return null;
	const result = content[0];
	const blocks = result?.content;
	if (!Array.isArray(blocks) || blocks.length === 0) return null;
	if (!blocks.every((b) => b?.type === "text" && typeof b.text === "string")) return null;
	return { blocks, result, text: blocks.map((b) => b.text).join("\n") };
}

/**
 * Compute node-level replacements for one plan's freshPrune actions.
 *
 * Per action (TRASH-tier unit, already gated by the planner):
 *   - every RESULT node of the unit currently on the surface is considered
 *     (the assistant-message call node is never touched);
 *   - "reduce": the §48–§52 reducer runs on the NODE's own text; the node is
 *     replaced only when the reducer actually shrinks it (churn gate);
 *   - "drop": the node is replaced with a raw-pointer stub — applied only
 *     when the stub is strictly smaller than the current text.
 *
 * @param plan - planVacGc() output (degraded plans produce no actions).
 * @param env - {
 *   surfaceSeqs: number[],                current surface nodes,
 *   eventAt: (seq) => event|undefined
 * }
 * @returns Array of {seq, kind, newContent, reason, beforeChars, afterChars}
 *          in plan order; a seq appears at most once.
 */
export function planNodePrunes(plan, env) {
	const out = [];
	if (plan === null || plan === undefined || plan.degraded !== false) return out; // §130: degraded = no-op
	const actions = plan.freshPrune?.actions;
	if (!Array.isArray(actions) || actions.length === 0) return out;
	const onSurface = new Set(env.surfaceSeqs);
	const done = new Set();
	for (const action of actions) {
		const apply = action.apply;
		if (apply === null || apply === undefined) continue; // plan predates apply data
		const resultSeqs = Array.isArray(apply.resultSeqs) ? apply.resultSeqs : [];
		for (const seq of resultSeqs) {
			if (!onSurface.has(seq) || done.has(seq)) continue;
			const event = env.eventAt(seq);
			if (event?.type !== "tool/result") continue;
			const view = textContent(event);
			if (view === null) continue; // mixed/empty content: official pruner's domain
			const before = view.text;
			let newContent;
			if (action.kind === "drop") {
				newContent = `[pruned: duplicate tool result — raw: ${action.raw} (reconstructible)]`;
				if (newContent.length >= before.length) continue; // no shrink, no churn
			} else {
				const { reduced, shrank } = reduceToolResult(action.toolName, before, apply.toolArgs ?? "");
				if (!shrank) continue;
				newContent = reduced;
			}
			done.add(seq);
			out.push({
				seq,
				kind: action.kind,
				newContent,
				reason: action.reason ?? action.kind,
				beforeChars: before.length,
				afterChars: newContent.length
			});
		}
	}
	return out;
}

/**
 * Land node replacements on the session, mirroring the official pruner's
 * transaction: shadow-price event, then provenance-carrying replace.
 *
 * SHADOW-PRICE CONTRACT (dsh-token-meter/surface-projection): the
 * `compaction/prune` event's `shadowedTokenCount` must be the host meter's
 * FIXED-density heuristic price of the replaced node (`tokenMeter.
 * estimateMessage`, flat 4 chars/token + role/block overhead) — "producers
 * derive them from the same fixed estimator this module prices appends
 * with". The meter's contextBreakdown fold replaces the node's heuristic
 * price with `newPrice − shadowedTokenCount`; if the shadow is priced with
 * any denser estimator (e.g. the plugin's calibrated 1.8 chars/token code /
 * 8/3 CJK pricing), the fold under-counts by the over-charge and goes
 * negative at the next compaction — the persisted stateSchema (zod
 * nonnegative on messageTokens) then rejects history loads with
 * gateway/internal. The engine therefore passes the meter's estimator as
 * `estimate`; a non-finite or negative estimate is clamped here to the flat
 * 4-chars/token rate (the fixed heuristic's density) as the last resort.
 *
 * @param session - dsh session (append/eventAt/surface).
 * @param replacements - planNodePrunes() output.
 * @param estimate - (event) => number; MUST be the host meter's fixed
 *          heuristic price of the event's message (see contract above).
 * @returns {landed: [{originalSeq, replacementSeq, kind}], charsSaved}.
 * @throws when the session rejects a replacement; earlier landings remain
 *         durable (caller catches and degrades to shadow — §130).
 */
export function landNodePrunes(session, replacements, estimate) {
	const landed = [];
	let charsSaved = 0;
	for (const rep of replacements ?? []) {
		const event = session.eventAt(rep.seq);
		if (event?.type !== "tool/result") continue; // surface moved since planning: skip stale
		const message = event.data.message;
		const result = message.content[0];
		const newContent = rep.newContent.length > 0 ? [{ type: "text", text: rep.newContent }] : null;
		if (newContent === null) continue;
		let priced;
		try {
			priced = typeof estimate === "function" ? estimate(event) : 0;
		} catch {
			priced = 0;
		}
		if (!Number.isFinite(priced) || priced < 0) priced = Math.ceil(rep.beforeChars / 4);
		session.append("compaction/prune", {
			shadowedRange: { start: rep.seq, end: rep.seq },
			shadowedSeqs: [rep.seq],
			shadowedTokenCount: priced
		});
		const replacement = session.append("tool/result", {
			...event.data,
			// The session's append detaches (JSON snapshot) and deep-freezes
			// every event it publishes, so the replacement message is handed
			// over plain — the freeze contract is the session layer's.
			message: {
				...message,
				content: [{ ...result, content: newContent }]
			}
		}, {
			// DSH session's canonical replacement shape is startSeq/endSeq.
			// The older start/end spelling is rejected by the real host even
			// though early test doubles accepted it.
			surfaceOp: { op: "replace", startSeq: rep.seq, endSeq: rep.seq },
			sourceEventSeqs: [rep.seq]
		});
		landed.push({ originalSeq: rep.seq, replacementSeq: replacement.seq, kind: rep.kind });
		charsSaved += Math.max(0, rep.beforeChars - rep.afterChars);
	}
	return { landed, charsSaved };
}

/**
 * Pick the shadow price for one replacement (SHADOW-PRICE CONTRACT): the
 * host meter's fixed heuristic price of the event's message when the meter
 * is available — the token-meter's surface fold consumes the claim against
 * exactly this estimator, so any denser price (e.g. the plugin's calibrated
 * one) drains its contextBreakdown state below zero at the next compaction
 * and the nonnegative stateSchema rejects history loads. Without a meter
 * (test harnesses) the fallback stands; landNodePrunes clamps a
 * non-finite/negative result to the flat 4-chars/token rate.
 * @param meter - dsh token meter service (ctx.tokenMeter) or null/undefined.
 * @param event - the ORIGINAL node's session event (pre-replacement).
 * @param fallback - (event) => number; price when no meter price is usable.
 * @returns the shadowedTokenCount for this node's compaction/prune event.
 */
export function pickShadowPrice(meter, event, fallback) {
	if (meter && typeof meter.estimateMessage === "function") {
		try {
			const priced = meter.estimateMessage(event.data.message);
			if (Number.isFinite(priced) && priced >= 0) return priced;
		} catch {
			// meter failed on this node: fall through to the fallback
		}
	}
	return fallback(event);
}

export { textContent as textContentView };
