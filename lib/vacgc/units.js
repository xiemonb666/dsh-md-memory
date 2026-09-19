/**
 * VAC-GC ContextUnit builder (plan §3–§5, §53–§54, §73–§76).
 *
 * Turns the session's model-visible surface into atomic, ordered context
 * units:
 *   - surface POSITIONS (not log seqs) define order (§93);
 *   - a tool-call assistant message and ALL of its results are ONE unit
 *     (§4: atomic pair — compaction must never split them);
 *   - compaction checkpoints and injected context are distinct kinds,
 *     scored independently of user conversation (§74);
 *   - per-unit tokens come from the meter's per-node pricing (§73: lazy
 *     injection must sit inside the budget, so every node is priced).
 *
 * Pure: input is a plain session-shaped object ({nodes, eventAt}) plus a
 * price list; no ctx, no LLM, no mutation of the input.
 */
import { projectEvent, isCheckpointEvent, isInjectedEvent, extractTerms, toolGroupKey } from "./text.js";

/** Cap on text retained per unit for feature extraction (tokens stay exact). */
export const UNIT_TEXT_CAP = 12000;

/**
 * Build context units over one surface snapshot.
 * @param input - {
 *   nodes: number[]                 surface seqs in positional order,
 *   eventAt: (seq) => event|undefined,
 *   prices?: Array<{seq: number, tokens: number}>,  per-node pricing (aligned
 *                                             with nodes or sparse)
 *   now?: number                     (wall clock ms; for createdAt bookkeeping)
 * }
 * @returns {
 *   units: ContextUnit[],
 *   meta: { totalTokens: number, userTurns: number, openTail: boolean }
 * } where a ContextUnit is:
 *   {
 *     id: string, seqs: number[], kind: "user"|"assistant"|"tool-pair"|
 *     "tool-result"|"checkpoint"|"injected",
 *     turn: number,            // user-turn ordinal the unit belongs to
 *     turnsAfter: number,      // user turns strictly after this unit (§21)
 *     createdAt: number,       // first node's event time (ms)
 *     tokens: number,          // priced tokens across all unit nodes
 *     open: boolean,           // tool-pair whose results are not all on surface
 *     toolName?: string, toolArgs?: string, toolArgsKey?: string,
 *     sourceEventSeqs?: number[],   // checkpoint provenance (§71)
 *     text: string,            // projected text (capped)
 *     terms: termSet,          // lexical terms (paths/symbols/ids/errors/…)
 *   }
 */
export function buildContextUnits(input) {
	const { nodes, eventAt, prices } = input;
	const priceBySeq = new Map();
	if (Array.isArray(prices)) for (const p of prices) if (p && Number.isFinite(p.tokens)) priceBySeq.set(p.seq, p.tokens);

	const units = [];
	let open = null;            // in-progress tool-pair accumulator
	let openExpected = 0;
	let userTurns = 0;          // user messages seen (turn counter)
	let totalTokens = 0;
	let openTail = false;

	const close = (unit, openFlag) => {
		if (unit.tokens > 0 || unit.text.length > 0) {
			// Tool-pair text GROWS after makeUnit (results + [tool-calls] line
			// are appended), so its terms must be re-extracted over the final
			// text — otherwise paths/symbols from results never reach scoring.
			if (unit.toolArgsKey !== undefined) unit.terms = unitTerms(unit.text);
			units.push(unit);
		}
		if (openFlag) openTail = true;
	};

	for (const seq of nodes) {
		const event = eventAt(seq);
		if (event === undefined || event === null) continue; // corrupt surface — skip, planner is a no-op on the rest
		const tokens = priceBySeq.get(seq) ?? 0;
		totalTokens += tokens;
		const projected = projectEvent(event);
		if (projected === null) continue; // surface node without a message (structural)

		// Finish an open tool-pair: complete when all results land, otherwise
		// the pair is open-tailed (P0_TRANSIENT lane, §5).
		const flushOpen = () => {
			if (open === null) return;
			const unit = open;
			open = null;
			openExpected = 0;
			close(unit, unit.open);
		};

		if (event.type === "tool/result") {
			if (open !== null) {
				open.seqs.push(seq);
				open.tokens += tokens;
				if (open.text.length < UNIT_TEXT_CAP) open.text += `\n${projected.text}`;
				openExpected -= 1;
				if (openExpected <= 0) {
					open.open = false;
					flushOpen("complete");
				}
				continue;
			}
			// Orphan tool result (defensive): standalone unit.
			units.push(makeUnit({ seqs: [seq], kind: "tool-result", turn: userTurns, createdAt: event.time, tokens, text: projected.text, now: input.now }));
			continue;
		}

		if (event.type === "user/message") {
			flushOpen("user-interrupted");
			userTurns += 1;
			const kind = isCheckpointEvent(event, projected) ? "checkpoint" : isInjectedEvent(event, projected) ? "injected" : "user";
			const unit = makeUnit({
				seqs: [seq],
				kind,
				turn: userTurns,
				createdAt: event.time,
				tokens,
				text: projected.text,
				sourceEventSeqs: projected.sourceEventSeqs ?? undefined,
				now: input.now
			});
			close(unit, false);
			continue;
		}

		// assistant/message
		flushOpen("assistant-interrupted");
		const toolCalls = projected.toolCalls ?? [];
		if (toolCalls.length > 0) {
			open = makeUnit({
				seqs: [seq],
				kind: "tool-pair",
				turn: userTurns,
				createdAt: event.time,
				tokens,
				text: projected.text,
				toolName: toolCalls[0].name,
				toolArgs: toolCalls.map((tc) => tc.arguments).join("\n"),
				now: input.now
			});
			open.open = true;
			openExpected = toolCalls.length;
			if (open.text.length < UNIT_TEXT_CAP) open.text += `\n[tool-calls] ${toolCalls.map((tc) => `${tc.name} ${tc.arguments}`).slice(0, 1).join("")}`;
			// Multi-call batches: mark expected, unit closes when all results land.
			if (openExpected === 0) { open.open = false; flushOpen("complete"); }
			continue;
		}
		const unit = makeUnit({ seqs: [seq], kind: "assistant", turn: userTurns, createdAt: event.time, tokens, text: projected.text, now: input.now });
		close(unit, false);
	}
	if (open !== null) {
		open.open = true;
		open.turnsAfter = userTurns - open.turn;
		close(open, true);
	}
	// Finalize turnsAfter for units closed with a stale value: recompute from
	// their own turn ordinal — a unit in turn T has (userTurns - T) turns after.
	for (const unit of units) unit.turnsAfter = Math.max(0, userTurns - unit.turn);

	return { units, meta: { totalTokens, userTurns, openTail: openTail || open !== null } };
}

/**
 * Build one unit record with its id, terms, and derived keys.
 * @param spec - unit fields (see buildContextUnits).
 * @returns the unit.
 */
function makeUnit(spec) {
	const unit = {
		id: `u-${spec.seqs[0]}`,
		seqs: [...spec.seqs],
		kind: spec.kind,
		turn: spec.turn,
		turnsAfter: 0,
		createdAt: Number.isFinite(spec.createdAt) ? spec.createdAt : spec.now ?? Date.now(),
		tokens: spec.tokens ?? 0,
		open: false,
		text: (spec.text ?? "").slice(0, UNIT_TEXT_CAP),
		toolName: spec.toolName,
		toolArgs: spec.toolArgs
	};
	if (spec.sourceEventSeqs !== undefined && Array.isArray(spec.sourceEventSeqs)) unit.sourceEventSeqs = [...spec.sourceEventSeqs];
	if (unit.toolName !== undefined && unit.toolArgs !== undefined) unit.toolArgsKey = toolGroupKey(unit.toolName, unit.toolArgs);
	unit.terms = unitTerms(unit.text);
	return unit;
}

/** Compact lowercase term view of a unit's text (for relevance intersections). */
function unitTerms(text) {
	const terms = extractTerms(text);
	return {
		ids: [...terms.ids].map((s) => s.toLowerCase()),
		paths: [...terms.paths].map((s) => s.toLowerCase()),
		urls: [...terms.urls].map((s) => s.toLowerCase()),
		versions: [...terms.versions].map((s) => s.toLowerCase()),
		errors: [...terms.errors].map((s) => s.toLowerCase()),
		models: [...new Set([...terms.modelNames, ...terms.versions])].map((s) => s.toLowerCase()),
		symbols: [...terms.symbols].map((s) => s.toLowerCase()),
		// NOTE: new Set(iterable) takes ONE argument — a second iterable
		// passed alongside the spread is silently ignored by the constructor,
		// which previously dropped every CJK keyword from unit relevance.
		keywords: [...new Set([...[...terms.keywordsEn].map((w) => w.toLowerCase()), ...terms.keywordsZh.map((w) => w.toLowerCase())])]
	};
}

/**
 * Mark the recent-floor tail (§45): walk units from the surface tail,
 * accumulating priced tokens until the floor is met; every unit fully inside
 * the accumulated tail (plus the crossing unit — conservative V1) is flagged
 * `inRecentFloor = true`. The floor protects the semantic working set, NOT
 * garbage: flagged units stay eligible for fresh/micro tool pruning.
 * @param units - buildContextUnits() output (in surface order).
 * @param recentFloorTokens - floor size in tokens.
 * @returns the same units array (mutated flags).
 */
export function markRecentFloor(units, recentFloorTokens) {
	if (!Number.isFinite(recentFloorTokens) || recentFloorTokens <= 0) {
		for (const unit of units) unit.inRecentFloor = false;
		return units;
	}
	let acc = 0;
	let start = units.length;
	for (let i = units.length - 1; i >= 0; i -= 1) {
		acc += units[i].tokens;
		start = i;
		if (acc >= recentFloorTokens) break;
	}
	for (const unit of units) unit.inRecentFloor = unit.seqs[0] >= (units[start] ? units[start].seqs[0] : Number.MAX_SAFE_INTEGER);
	return units;
}
