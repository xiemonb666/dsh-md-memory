/**
 * VAC-GC Fresh/Micro Prune (plan §43/§47–§52, §119, §123 STEP 9) — pure
 * computation.
 *
 * Phase 2 scope (§119): enable FRESH TOOL PRUNE + DUPLICATE REMOVAL, keep
 * semantic compact OFF, and restrict mutation to the TRASH tier. This module
 * computes the prune plan as a DRY-RUN: reducers produce the replacement
 * text, the planner produces the action list — nothing here mutates a
 * session, calls an LLM, or touches the network. The host applies actions
 * when the STEP 9 gate opens ([DEC-002]: after STEP 8 real-session
 * observation).
 *
 * Design points:
 *   §47  fresh tool prune happens BEFORE the result's first model entry —
 *        it never rewrites an old prompt prefix (prefix-cache friendly, §59).
 *   §48–§52 per-tool reducers (bash / test / git diff / file read / search),
 *        each ending in a RAW POINTER: `raw: <fingerprint> (N lines,
 *        reconstructible)` — the reduced text is traceable back to the raw
 *        output, and the raw is re-derivable (re-run, git diff, re-read).
 *   §119 hard gates: only TRASH-tier, CLOSED tool units; P0/P0_TRANSIENT/P1
 *        and open-tail pairs are never pruned (§125 hard gate first).
 *   §128 atomicity: a "drop" removes the WHOLE tool-pair unit (call + all
 *        results together) — the pair is never split.
 *   §52 line-level dedupe (path:line:symbol:match) lives inside the search
 *        reducer; unit-level duplicate removal lives in planFreshPrune.
 */
import { extractExactFacts, fingerprint } from "./text.js";

/** Below this size a result is left untouched (churn/rewriteCost, §59). */
export const PRUNE_MIN_LINES = 32;
export const PRUNE_MIN_CHARS = 1600;

/** Keep-bounds per reducer (deterministic, small). */
const KEEP = { errors: 8, warnings: 4, tail: 8, hunks: 12, symbols: 12, preview: 3, search: 200 };

/**
 * The `[tool-calls] ...` marker line inside a tool-pair unit's text is the
 * COMMAND of §48 — it is always preserved verbatim by every reducer.
 * @param text - full tool-pair unit text.
 * @returns {header: string|null, body: string}
 */
function splitHeader(text) {
	const idx = text.indexOf("\n[tool-calls] ");
	if (idx === -1) {
		if (text.startsWith("[tool-calls] ")) {
			const nl = text.indexOf("\n");
			return { header: nl === -1 ? text : text.slice(0, nl), body: nl === -1 ? "" : text.slice(nl + 1) };
		}
		return { header: null, body: text };
	}
	return { header: text.slice(0, idx).replace(/\n$/, ""), body: text.slice(idx + 1) };
}

/** Deterministic raw pointer line (§48 "Raw pointer"). */
const rawPointer = (text) => `raw: ${fingerprint(text)} (${text.split(/\r?\n/).length} lines, reconstructible)`;

/** Unique, order-preserving line filter. */
function uniqueLines(lines) {
	const seen = new Set();
	const out = [];
	let dup = 0;
	for (const line of lines) {
		const key = line.trim();
		if (key.length === 0) continue;
		const k = key.toLowerCase();
		if (seen.has(k)) {
			dup += 1;
			continue;
		}
		seen.add(k);
		out.push(key);
	}
	return { out, dup };
}

// ---------------------------------------------------------------------------
// Per-tool reducers (§48–§52)
// ---------------------------------------------------------------------------

/**
 * §48 Bash/shell: keep Command (header), Exit Code, Primary Errors, Warnings
 * summary, Last relevant lines, Raw pointer.
 */
function bashReducer(body) {
	const lines = body.split(/\r?\n/);
	const kept = [];
	const exitMatch = [...body.matchAll(/\bexit\s*code\s*:?\s*(\d+)/gi)].pop();
	if (exitMatch) kept.push(`Exit Code: ${exitMatch[1]}`);
	const errors = lines.filter((l) => /error|exception|fatal|panic|traceback|segmentation|cannot |no such /i.test(l)).map((l) => l.trim()).filter(Boolean);
	const { out: uniqErr, dup: errDup } = uniqueLines(errors);
	if (uniqErr.length > 0) kept.push(`Primary Errors (${uniqErr.length}${errDup ? `, ${errDup} duplicated` : ""}):`, ...uniqErr.slice(0, KEEP.errors).map((l) => `  ${l}`));
	const warns = lines.filter((l) => /warning|warn:/i.test(l)).map((l) => l.trim()).filter(Boolean);
	const { out: uniqWarn } = uniqueLines(warns);
	if (uniqWarn.length > 0) kept.push(`Warnings (${uniqWarn.length}):`, ...uniqWarn.slice(0, KEEP.warnings).map((l) => `  ${l}`));
	const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
	const tail = nonEmpty.slice(-KEEP.tail);
	if (tail.length > 0) kept.push("Last lines:", ...tail.map((l) => `  ${l}`));
	return kept;
}

/**
 * §49 Tests: keep command (header), passed/failed/skipped counts, first
 * failures, stack origin, exit code; drop repeated success cases and repeated
 * tracebacks.
 */
function testReducer(body) {
	const lines = body.split(/\r?\n/);
	const kept = [];
	const count = (re) => {
		const m = [...body.matchAll(re)].pop();
		return m ? Number(m[1]) : null;
	};
	const passed = count(/\b(\d+)\s+(?:passing|passed)\b/gi);
	const failed = count(/\b(\d+)\s+(?:failing|failed)\b/gi);
	const skipped = count(/\b(\d+)\s+(?:skipped|pending)\b/gi);
	const counts = [passed !== null && `passed: ${passed}`, failed !== null && `failed: ${failed}`, skipped !== null && `skipped: ${skipped}`].filter(Boolean);
	if (counts.length > 0) kept.push(`Results: ${counts.join(", ")}`);
	const exitMatch = [...body.matchAll(/\bexit\s*code\s*:?\s*(\d+)/gi)].pop();
	if (exitMatch) kept.push(`Exit Code: ${exitMatch[1]}`);
	// first failure block: the failing marker + its stack origin (count
	// summary lines like "3 failing" are NOT failure markers)
	const failIdx = lines.findIndex((l) => /✖|✗|\bfail(ed|ure)?\b|FAIL\b|Error:/i.test(l) && !/\b\d+\s+(?:passing|passed|skipped|pending|failing|failed)\b/i.test(l));
	if (failIdx !== -1) {
		const block = lines.slice(failIdx, failIdx + 6).map((l) => l.trim()).filter(Boolean);
		const origin = block.find((l) => /at |Error:|File "|\.js:\d+:\d+|\.py:\d+|\.ts:\d+/.test(l));
		kept.push("First failure:", ...block.slice(0, 3).map((l) => `  ${l}`), ...(origin ? [`  stack origin: ${origin}`] : []));
	}
	// success cases: keep the UNIQUE names (duplicates are the droppable mass)
	const success = uniqueLines(lines.filter((l) => /✔|✓|\bpass(ed|ing)?\b|ok\b/i.test(l) && !/failing|failed/i.test(l)));
	if (success.out.length > 0) kept.push(`Success cases (${success.out.length}${success.dup ? `, ${success.dup} duplicated dropped` : ""}):`, ...success.out.slice(0, KEEP.symbols).map((l) => `  ${l}`));
	return kept;
}

/**
 * §50 Git diff: keep files changed, symbols, line counts, hunk headers. The
 * raw diff is reconstructible (re-run git diff) → raw pointer.
 */
function gitDiffReducer(body) {
	const lines = body.split(/\r?\n/);
	const kept = [];
	const files = body.match(/^diff --git /gm)?.length ?? null;
	const stat = [...body.matchAll(/(\d+)\s+files? changed/g)].pop();
	if (stat) kept.push(`${stat[1]} files changed`);
	else if (files) kept.push(`${files} files changed`);
	const adds = body.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
	const dels = body.split(/\r?\n/).filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
	kept.push(`line counts: +${adds} -${dels}`);
	const hunkHeaders = lines.filter((l) => l.startsWith("@@")).map((l) => l.trim());
	const { out: uniqHunks, dup: hunkDup } = uniqueLines(hunkHeaders);
	if (uniqHunks.length > 0) kept.push(`Hunks (${uniqHunks.length}${hunkDup ? `, ${hunkDup} duplicated` : ""}):`, ...uniqHunks.slice(0, KEEP.hunks).map((l) => `  ${l}`));
	const symbols = uniqueLines(lines.filter((l) => /^[+-]\s*(?:export\s+)?(?:function|class|const|let|def|type|interface|public|private)\b/.test(l)).map((l) => l.replace(/^[+-]\s*/, "").trim()));
	if (symbols.out.length > 0) kept.push(`Symbols (${symbols.out.length}):`, ...symbols.out.slice(0, KEEP.symbols).map((l) => `  ${l}`));
	return kept;
}

/**
 * §51 File read: if the file still exists, keep path, hash, relevant symbols,
 * important range — the old full content can exit context.
 */
function fileReadReducer(body, toolArgs) {
	const kept = [];
	const pathMatch = String(toolArgs ?? "").match(/[A-Za-z]:\\[\w\\.-]+|\/[\w./-]+|[\w][\w./-]*\.\w{1,8}/);
	if (pathMatch) kept.push(`path: ${pathMatch[0]}`);
	kept.push(`hash: ${fingerprint(body)}`);
	const symbols = uniqueLines(body.split(/\r?\n/).filter((l) => /export (?:default )?(?:async )?(?:function|class|const|let|type|interface)|^(?:function|class|def|const) [A-Za-z_$]/.test(l)).map((l) => l.trim()));
	if (symbols.out.length > 0) kept.push(`Symbols (${symbols.out.length}):`, ...symbols.out.slice(0, KEEP.symbols).map((l) => `  ${l}`));
	const total = body.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
	const head = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, KEEP.preview);
	kept.push(`range: lines 1-${total} (preview)`, ...head.map((l) => `  ${l}`));
	return kept;
}

/**
 * §52 Search (grep/glob/find/web): dedupe by path:line:symbol:match — repeated
 * matches are dropped, unique ones kept.
 */
function searchReducer(body) {
	const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const { out, dup } = uniqueLines(lines);
	const kept = [`Matches (${out.length}${dup ? `, ${dup} duplicates dropped` : ""}):`, ...out.slice(0, KEEP.search).map((l) => `  ${l}`)];
	if (out.length > KEEP.search) kept.push(`  … ${out.length - KEEP.search} more`);
	return kept;
}

/**
 * Generic fallback for unlisted tools: head + tail + raw pointer (the §48
 * shape without tool-specific knowledge).
 */
function genericReducer(body) {
	const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const kept = [];
	const exitMatch = [...body.matchAll(/\bexit\s*code\s*:?\s*(\d+)/gi)].pop();
	if (exitMatch) kept.push(`Exit Code: ${exitMatch[1]}`);
	const errors = uniqueLines(lines.filter((l) => /error|exception|fatal|traceback/i.test(l)));
	if (errors.out.length > 0) kept.push(`Primary Errors (${errors.out.length}):`, ...errors.out.slice(0, KEEP.errors).map((l) => `  ${l}`));
	kept.push("Head:", ...lines.slice(0, KEEP.preview).map((l) => `  ${l}`));
	const tail = lines.slice(-KEEP.tail);
	if (tail.length > KEEP.preview) kept.push("Last lines:", ...tail.map((l) => `  ${l}`));
	return kept;
}

/**
 * Reduce one tool result per its tool policy (§47–§52). Pure and
 * deterministic; small results pass through unchanged (no churn).
 * @param toolName - the tool-call name (e.g. "pwsh", "test", "git", "read").
 * @param text - the FULL tool-pair unit text (header + result body).
 * @param toolArgs - the tool-call arguments (path for file read, …).
 * @param opts.minLines / opts.minChars — churn thresholds.
 * @returns {reduced, shrank, linesBefore, linesAfter}
 */
export function reduceToolResult(toolName, text, toolArgs = "", opts = {}) {
	const minLines = opts.minLines ?? PRUNE_MIN_LINES;
	const minChars = opts.minChars ?? PRUNE_MIN_CHARS;
	const linesBefore = text.split(/\r?\n/).length;
	if (linesBefore < minLines && text.length < minChars) {
		return { reduced: text, shrank: false, linesBefore, linesAfter: linesBefore };
	}
	const name = String(toolName ?? "").toLowerCase();
	const { header, body } = splitHeader(text);
	let kept;
	if (/bash|shell|pwsh|powershell|cmd|sh\b/.test(name)) kept = bashReducer(body);
	else if (/\btest\b|vitest|jest|pytest|unittest/.test(name)) kept = testReducer(body);
	else if (/git/.test(name) && /diff|status|log/.test(name)) kept = gitDiffReducer(body);
	else if (/^read$|file ?read|cat|head|tail/.test(name)) kept = fileReadReducer(body, toolArgs);
	else if (/grep|search|glob|find|rg|web/.test(name)) kept = searchReducer(body);
	else kept = genericReducer(body);
	const reduced = [header ?? "", ...kept, rawPointer(text)].filter((l) => l.length > 0).join("\n");
	return { reduced, shrank: reduced.length < text.length, linesBefore, linesAfter: reduced.split(/\r?\n/).length };
}

// ---------------------------------------------------------------------------
// Prune plan (§119) — the dry-run diff the host applies at STEP 9
// ---------------------------------------------------------------------------

/**
 * Whether a unit is a prunable tool unit (closed tool-pair or orphan result).
 * @param unit - unit view.
 * @returns true for closed tool units.
 */
export function isPrunableToolUnit(unit) {
	return Boolean(unit) && (unit.kind === "tool-pair" || unit.kind === "tool-result") && unit.open !== true;
}

/**
 * Plan the Fresh/Micro Prune (§119 Phase 2 scope) as a DRY-RUN diff:
 *   - duplicate removal: later exact-duplicate tool units are dropped (the
 *     WHOLE unit — §128 atomic pair, call + results together);
 *   - fresh tool prune: large TRASH tool results are reduced to their tool
 *     policy shape (§48–§52).
 * Hard gates, always: P0/P0_TRANSIENT/P1 units, non-TRASH units, and
 * recent-floor units are never touched (§119: Phase 2 enables TRASH prune
 * only; §125: hard gate > any weight; the recent floor protects the active
 * working set — same contract as the planner's Z1 TRASH lane). No semantic
 * compact here — that is STEP 10.
 * @param units - unit views [{unitId, kind, open, toolName, toolArgs, text,
 *        tier, protection, tokens, inRecentFloor?, reconstructibility?}],
 *        surface order.
 * @param opts.estimateTokens - (text) => number; default length/4.
 * @param opts.allowDrop - (default true) gate for duplicate-removal actions.
 *        §43: Z0 does FRESH TOOL PRUNE ONLY — reducing large tool results is
 *        allowed in every zone, but dropping a whole duplicate unit needs
 *        Z1+. With allowDrop=false, a later duplicate is kept in context and
 *        still passes through the reduce path (if large enough).
 * @param opts.floorBypassX - (default 0.80) the RECENT-FLOOR TOOL GARBAGE
 *        BYPASS (review 2026-09-12, P0): the recent floor is a SEMANTIC floor
 *        — user/assistant/checkpoint content inside it is never touched —
 *        but CLOSED, NORMAL, highly reconstructible (X ≥ floorBypassX) TRASH
 *        tool units (build/test logs, git output, duplicate file reads) are
 *        still micro-prunable inside the floor. "Recent ≠ Valuable." The
 *        bypass opens REDUCE only — a floor unit is never DROPPED whole
 *        (whole-unit removal stays absolute-floor-protected, so the most
 *        recent occurrence of a command keeps its reduced presence). Set
 *        floorBypassX to 0 to restore the old absolute floor.
 * @returns {mode, actions, totalReclaim, stats} where each action is
 *          {unitId, kind: "reduce"|"drop", toolName, reason, raw,
 *           before, after?, reclaim}
 */
export function planFreshPrune(units, opts = {}) {
	const allowDrop = opts.allowDrop !== false;
	const estimateTokens = opts.estimateTokens ?? ((t) => Math.ceil(String(t ?? "").length / 4));
	const actions = [];
	const stats = { scanned: 0, trashTools: 0, reduced: 0, dropped: 0, untouched: 0 };
	const seenFingerprints = new Map(); // fingerprint → unitId of the FIRST copy

	for (const unit of units ?? []) {
		stats.scanned += 1;
		if (!isPrunableToolUnit(unit)) {
			stats.untouched += 1;
			continue;
		}
		// §125 hard gate — protection wins over any prune policy.
		if (unit.protection === "P0" || unit.protection === "P0_TRANSIENT" || unit.protection === "P1") {
			stats.untouched += 1;
			continue;
		}
		// §119 — Phase 2 mutates the TRASH tier only.
		if (unit.tier !== "TRASH") {
			stats.untouched += 1;
			continue;
		}
		stats.trashTools += 1;
		// Recent floor = SEMANTIC floor: by reaching here the unit is a
		// CLOSED, NORMAL, TRASH tool unit, so the only question is the tool
		// garbage bypass — reconstructible (X ≥ floorBypassX) tool output
		// inside the floor is still micro-prunable; everything semantic
		// (user/assistant/recent task state) never reaches this branch.
		// The bypass is REDUCE-ONLY: a floor unit is never dropped whole
		// (the floor stays absolute for whole-unit removal).
		let floorReduceOnly = false;
		if (unit.inRecentFloor === true) {
			const bypassX = Number.isFinite(opts.floorBypassX) ? opts.floorBypassX : 0.80;
			const bypass = bypassX > 0 && (unit.reconstructibility ?? 0) >= bypassX;
			if (!bypass) {
				stats.untouched += 1;
				continue;
			}
			floorReduceOnly = true;
		}
		const fp = fingerprint(unit.text);
		// duplicate removal: the FIRST copy is kept, later copies are dropped
		// whole (the atomic pair — §128). §43: only when drops are allowed.
		// A recent-floor unit (bypassed above) is reduce-only, never dropped.
		const first = seenFingerprints.get(fp);
		if (first !== undefined && allowDrop && !floorReduceOnly) {
			stats.dropped += 1;
			actions.push({
				unitId: unit.unitId,
				kind: "drop",
				toolName: unit.toolName ?? null,
				reason: `duplicate of ${first}`,
				raw: fp,
				before: unit.tokens ?? estimateTokens(unit.text),
				reclaim: unit.tokens ?? estimateTokens(unit.text)
			});
			continue;
		}
		if (first === undefined) seenFingerprints.set(fp, unit.unitId);
		// first copy (recorded), or a Z0 duplicate (kept, falls through to
		// the reduce path below)
		// fresh tool prune: reduce large results per the tool policy.
		const { reduced, shrank, linesBefore, linesAfter } = reduceToolResult(unit.toolName, unit.text, unit.toolArgs);
		if (!shrank) {
			stats.untouched += 1;
			continue;
		}
		const before = unit.tokens ?? estimateTokens(unit.text);
		const after = estimateTokens(reduced);
		stats.reduced += 1;
		actions.push({
			unitId: unit.unitId,
			kind: "reduce",
			toolName: unit.toolName ?? null,
			reason: `fresh tool prune (§48–§52): ${linesBefore} → ${linesAfter} lines`,
			raw: fp,
			before,
			after,
			reclaim: Math.max(0, before - after),
			reducedText: reduced
		});
	}
	return {
		mode: "fresh-prune",
		actions,
		totalReclaim: actions.reduce((s, a) => s + (a.reclaim ?? 0), 0),
		stats
	};
}

/**
 * Re-export for consumers that want the §65 verbatim check on a reduced
 * result (the reducer must not drop exit-code/error facts it was told to
 * keep — the tests assert this).
 */
export { extractExactFacts };
