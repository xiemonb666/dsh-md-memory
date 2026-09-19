/**
 * VAC-GC hard protection gate (plan §6–§9, §85).
 *
 * THE core law: Hard Rules > Weight Score. Classification runs BEFORE any
 * scoring and no weight feature (age, size, duplication, irrelevance) can
 * ever override it — the scorer receives the class and only orders
 * compression INSIDE the safe set. P0/P0_TRANSIENT units are never
 * auto-semantic-compacted under normal pressure; P1 units are compactable
 * only with Memory Sync + exact-fact coverage (enforced by the planner).
 *
 * Provenance lane (review 2026-09-12, P0): besides the §85 ID cross-check
 * (the unit TEXT mentions an ACTIVE ledger id), a unit is P0 when its SOURCE
 * SEQS back an ACTIVE ledger entry — the original "以后不要开 MTP" message
 * predates the DEC-006 id, so the ID text can never appear in it. The
 * host-side Guardian provenance (LedgerIndex.activeSourceIds: seq → ACTIVE
 * ids) supplies the mapping; see memory-index.js (.provenance.json).
 *
 * Provenance-UNRESOLVED conservative hold (review 2026-09-12, P0.5): while an
 * ACTIVE entry's evidence has NO resolved binding (sidecar missing/corrupt/
 * write-failed/ambiguous — the degraded state the engine must NOT silently
 * treat as "no provenance"), any unit LEXICALLY RELATED to that entry (≥ 2
 * shared evidence terms, or 1 term of ≥ 8 chars) is held at P1. Never
 * ordinary NORMAL scoring: a bad sidecar may cost extra retention, never a
 * wrongful deletion. The hold clears automatically once a later sync
 * repairs the binding (the entry then enters the P0 exact-source lane).
 *
 * Classes:
 *   P0           user hard constraints/denials, corrections, current goal,
 *                ACTIVE decision/requirement/blocker content, safety limits,
 *                provenance source of an ACTIVE ledger entry.
 *   P0_TRANSIENT current open tool chain / in-progress step (§5) — re-scored
 *                after the turn ends (the planner runs at turn boundaries).
 *   P1           benchmarks, error root causes, key fixes, important
 *                config/paths/architecture rationale, verified experiment
 *                results, compaction checkpoints (§71), lexically-related
 *                units of ACTIVE entries with UNRESOLVED provenance (P0.5).
 *   NORMAL       everything else — the only class the weighted scorer may
 *                compact.
 *
 * Pure: (unit, {memory}) → class + reasons. No ctx, no LLM.
 */

// --- user-intent patterns --------------------------------------------------

/**
 * Hard constraints and denials the user imposed (never auto-compact).
 * Case-insensitive: sentence-initial "Do not …" is as binding as
 * "do not …" (benchmark D, plan §109 — the original case-sensitive form
 * let "Do not enable MTP." fall through to NORMAL).
 */
const CONSTRAINT_RE = /必须|不能|不要|禁止|务必|只能|不允许|不得|保持|沿用|保留|只(能|用|可以)|do\s+not|don'?t|never|always|must\s+not|must\s+use|only\s+(use|keep)|keep\s+it\s|exactly|别改|不要改/i;

/** User corrections of assistant behavior or content (case-insensitive). */
const CORRECTION_RE = /不对|错了|纠正|改一下|实际上是|应该是|应该用|改成|换成|no,\s|that'?s\s+not|wrong,|wrong\.|actually,|in\s+fact,|you\s+(said|assumed)|我(说|强调|要求)过/i;

/** Current goal / task statements. */
const GOAL_RE = /目标[:：]?|goal[:：]?|objective|本轮(要|目标)|接下来(要|需要|做)|执行.*方案|现在(要|开始|继续)|任务[:：]?|task[:：]?|需求[:：]?|继续修复|继续执行/i;

/** Safety / compatibility limits (case-insensitive). */
const SAFETY_RE = /安全|兼容|不能破坏|不能(再)?丢|不得丢失|safety|compat|backward-?compat|must\s+not\s+break|cannot\s+lose/i;

/** Assistant-side P1 signals. */
const DECISION_RE = /决定|决策|采用|选用|弃用|架构(决定|选择|决策)|decided|decision:|we\s+will|going\s+to\s+(use|adopt|drop)|选择使用/i;
const ROOT_CAUSE_RE = /根因|根本原因|root\s+cause|原因是|问题出在|caused\s+by|the\s+cause\s+is|导致.*的(原因|根源)/i;
const VERIFIED_RE = /验证(通过|成功)|已验证|verified|passed\b|全部通过|all\s+(tests\s+)?pass|exit\s*code\s*:?\s*0\b|测试通过|基准(结果|数据)|benchmark/i;
const KEY_FIX_RE = /修复(了|成功)|已修复|fixed\b|patch(?:es)?\s*[:：]|hotfix|补丁|hot\s*fix/i;

/** Tool units whose payload is important configuration (§9: P1). */
const CONFIG_PATH_RE = /(?:^|[\s'"`=(\[{\\:])(?:[A-Za-z]:\\[\w./\\-]*\.(?:ya?ml|toml|json)|[\w./\\-]*\.(?:ya?ml|toml|json)|package\.json|settings\.[\w.]+|cordis[\w.-]*\.yml|\.env[\w.-]*|config[\w./-]*)/i;

/**
 * Classify one context unit's protection class.
 * @param unit - ContextUnit from the unit builder (needs kind, text, open,
 *               memoryRefs/ids via unit.terms, sourceEventSeqs, seqs).
 * @param opts - { memory?: LedgerIndex|null, sessionId?: string|null } —
 *               memory for the §85 + provenance + conservative lanes;
 *               sessionId keys the provenance lane (seqs are session-local).
 * @returns { protection: "P0"|"P0_TRANSIENT"|"P1"|"NORMAL", reasons: string[] }.
 */
export function classifyProtection(unit, opts = {}) {
	const memory = opts.memory ?? null;
	const sessionId = opts.sessionId ?? null;
	const text = unit.text ?? "";

	// §5: the in-progress step is P0_TRANSIENT — the open tool chain, its
	// error chain, and its step are never cut mid-flight. Re-scored once the
	// turn ends (planner runs at turn boundaries, so an open unit here IS the
	// current step).
	if (unit.open === true) {
		return { protection: "P0_TRANSIENT", reasons: ["open tool chain (in-progress step, §5)"] };
	}

	const reasons = [];
	const p0Reasons = [];
	const p1Reasons = [];

	if (unit.kind === "user") {
		if (CONSTRAINT_RE.test(text)) p0Reasons.push("user hard constraint/denial");
		if (CORRECTION_RE.test(text)) p0Reasons.push("user correction");
		if (GOAL_RE.test(text)) p0Reasons.push("current goal/task statement");
		if (SAFETY_RE.test(text)) p0Reasons.push("safety/compatibility limit");
	}

	if (unit.kind === "checkpoint") {
		// §71: a previous checkpoint is compactable only after its shadowed
		// facts are recovered from Memory — treat as P1 (never free-summarized).
		const n = unit.sourceEventSeqs?.length ?? 0;
		p1Reasons.push(`compaction checkpoint (provenance: ${n} shadowed node${n === 1 ? "" : "s"})`);
	}

	if (unit.kind === "assistant") {
		if (DECISION_RE.test(text)) p1Reasons.push("decision/architecture rationale");
		// (A DEC-id mention alone is NOT a decision rationale — the §85 ledger
		// lane below handles id references with the correct active/inactive split.)
		if (ROOT_CAUSE_RE.test(text)) p1Reasons.push("error root cause");
		if (VERIFIED_RE.test(text)) p1Reasons.push("verified result/benchmark");
		if (KEY_FIX_RE.test(text)) p1Reasons.push("key fix");
		// A goal statement inside assistant text is the current objective (§7).
		if (GOAL_RE.test(text) && /目标|goal|objective|task[:：]/i.test(text)) p0Reasons.push("current goal (assistant restatement)");
	}

	if (unit.kind === "tool-pair") {
		if (unit.terms?.paths?.length > 0 && CONFIG_PATH_RE.test(unit.toolArgs ?? "")) p1Reasons.push("important config read (§9)");
		if (VERIFIED_RE.test(text) && /exit\s*code\s*:?\s*0|passed|通过/i.test(text)) p1Reasons.push("verified experiment result");
		if (ROOT_CAUSE_RE.test(text)) p1Reasons.push("error root cause (tool evidence)");
	}

	// Provenance lane: the unit is the SOURCE of an ACTIVE ledger entry.
	// (Runs for ANY unit kind with seqs — not only id-bearing text.)
	if (memory !== null && memory.available && sessionId !== null && Array.isArray(unit.seqs) && unit.seqs.length > 0 && typeof memory.activeSourceIds === "function") {
		const sourceIds = memory.activeSourceIds(sessionId, unit.seqs);
		for (const id of sourceIds) p0Reasons.push(`original evidence of ACTIVE ledger entry ${id} (provenance)`);
	}

	// §85: ledger cross-checks — ACTIVE decisions/requirements/blockers in
	// context are P0; ACTIVE benchmarks are P1.
	if (memory !== null && memory.available && unit.terms?.ids?.length > 0) {
		for (const id of unit.terms.ids) {
			const upper = id.toUpperCase();
			if (!memory.activeIds.has(upper)) continue;
			if (upper.startsWith("DEC-") || upper.startsWith("REQ-") || upper.startsWith("BLOCK-")) {
				p0Reasons.push(`ACTIVE ledger entry ${upper} (§85)`);
			} else if (upper.startsWith("BENCH-")) {
				p1Reasons.push(`ACTIVE benchmark ${upper}`);
			}
		}
	}

	// Provenance-UNRESOLVED conservative hold (P0.5): the entry is ACTIVE but
	// its original evidence was never bound (degraded provenance state). The
	// unit is LEXICALLY related when it shares ≥ 2 of the entry's evidence
	// terms (title + stored source quote), or one very distinctive term
	// (≥ 8 chars). This runs for every unit kind — including tool output —
	// and yields P1 (never pruned by fresh-prune; deprioritized by segment
	// selection), never NORMAL.
	if (memory !== null && memory.available && memory.unresolvedTerms instanceof Map) {
		const low = text.toLowerCase();
		for (const [id, terms] of memory.unresolvedTerms) {
			let hits = 0;
			let longHit = false;
			for (const term of terms) {
				if (!low.includes(term)) continue;
				hits += 1;
				if (term.length >= 8) longHit = true;
			}
			if (hits >= 2 || longHit) p1Reasons.push(`evidence of ACTIVE entry ${id} — provenance unresolved (conservative P1 hold, P0.5)`);
		}
	}

	if (p0Reasons.length > 0) return { protection: "P0", reasons: p0Reasons };
	if (p1Reasons.length > 0) return { protection: "P1", reasons: p1Reasons };
	if (unit.kind === "user" && text.length > 0) {
		// Plain user discussion: NORMAL (the scorer's intrinsic table decides
		// value; greetings get 0.02 there).
		reasons.push("ordinary user message");
	}
	return { protection: "NORMAL", reasons };
}
