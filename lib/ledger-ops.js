/**
 * Operation-based Guardian contract (P1-②, "LLM understands state changes;
 * host owns state").
 *
 * The Guardian LLM no longer emits full ledger files. It emits OPERATIONS:
 *
 *   ADD | UPDATE_STATE | AMEND | SUPERSEDE | CONFLICT | RESOLVE_CONFLICT | NOOP
 *
 * The host (this module + the LedgerManager commit path) then:
 *   1. normalizes each operation (strict schema — unknown ops are rejected
 *      individually, never the whole sync);
 *   2. validates evidence (E# handle + verbatim quote, reusing the P0.5
 *      ephemeral-handle machinery) — a failed check rejects THAT operation;
 *   3. runs the Mutation Guard: an exact atom (number / number+unit /
 *      version / path / url / hash / model name / error code / command)
 *      that is NEW in the operation's text must appear verbatim in the
 *      cited evidence — otherwise MUTATION_WITHOUT_EVIDENCE (stops "数值
 *      慢慢漂");
 *   4. applies transactionGroup atomicity: one invalid member rejects the
 *      whole group; independent operations commit regardless;
 *   5. mints entry IDs (PREFIX-(max+1), host-owned — the LLM never sees a
 *      new id before it exists) and renders the file contents
 *      deterministically.
 *
 * AMEND vs SUPERSEDE (version-explosion control):
 *   AMEND     — update an ACTIVE entry in place (same id, same status):
 *               added rationale, clarifications, detail corrections.
 *   SUPERSEDE — the fact itself changed: the old entry becomes
 *               SUPERSEDED with a `replacement:` pointer; a NEW entry
 *               (host-minted id) carries the new fact.
 *
 * Pure module: no host imports, no fs — everything takes and returns plain
 * data, so the whole pipeline is fuzz-testable in isolation.
 */

export const GUARDIAN_FILES = Object.freeze(["PROJECT.md", "STATE.md", "DECISIONS.md", "TECH.md", "CONFLICTS.md"]);
export const OPS = Object.freeze(["ADD", "UPDATE_STATE", "AMEND", "SUPERSEDE", "CONFLICT", "RESOLVE_CONFLICT", "NOOP"]);
/** kind → file the entry lives in. */
export const OP_KINDS = Object.freeze({ REQ: "PROJECT.md", DEC: "DECISIONS.md", TECH: "TECH.md", CONFLICT: "CONFLICTS.md" });

const KIND_ALIASES = Object.freeze({ REQUIREMENT: "REQ", DECISION: "DEC", TECHNICAL: "TECH", TECH: "TECH", CONFLICT: "CONFLICT" });
/** Operations that cannot enter the ledger without resolved evidence. */
const EVIDENCE_GATED = new Set(["ADD", "AMEND", "CONFLICT", "RESOLVE_CONFLICT"]);

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercase + collapse whitespace (the normalization both sides are matched under). */
export function normText(text) {
	return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Entry model (the host's own entry format — parse + deterministic render)
// ---------------------------------------------------------------------------

const ENTRY_RE = /^##\s+\[([A-Z]+-\d+|STATE-CURRENT)\]\s*(.*)$/;

/**
 * Parse one ledger file into { header, entries }.
 * Entry = { id, title, confidence|null, status|null, facts: string[],
 *           source|null, replacement|null, resolution|null,
 *           verbatim: string|null (STATE-CURRENT free text) }.
 * Structural bullets (confidence/status/source/replacement/resolution) are
 * extracted; every other non-blank line is a fact line.
 */
export function parseLedgerFile(content) {
	const lines = String(content ?? "").split("\n");
	const entries = [];
	let firstEntryStart = lines.length;
	let i = 0;
	while (i < lines.length) {
		const h = lines[i].match(ENTRY_RE);
		if (!h) {
			i += 1;
			continue;
		}
		if (entries.length === 0) firstEntryStart = i;
		let j = i + 1;
		while (j < lines.length && !/^##\s/.test(lines[j])) j += 1;
		entries.push(parseEntryBody(h[1], h[2].trim(), lines.slice(i + 1, j)));
		i = j;
	}
	return { header: lines.slice(0, firstEntryStart).join("\n"), entries };
}

function parseEntryBody(id, title, bodyLines) {
	const entry = {
		id,
		title,
		confidence: null,
		status: null,
		facts: [],
		source: null,
		replacement: null,
		resolution: null,
		verbatim: id === "STATE-CURRENT" ? bodyLines.join("\n").trim() : null
	};
	if (id === "STATE-CURRENT") return entry;
	for (const raw of bodyLines) {
		const line = raw.trim();
		if (!line) continue;
		let m;
		if ((m = line.match(/^- confidence:\s*([0-9.]+)\s*$/i))) {
			entry.confidence = Number(m[1]);
			continue;
		}
		if ((m = line.match(/^- status:\s*([A-Za-z]+)\s*$/i))) {
			entry.status = m[1].toUpperCase();
			continue;
		}
		if ((m = line.match(/^- source:\s*(.*)$/i))) {
			entry.source = m[1].trim();
			continue;
		}
		if ((m = line.match(/^- replacement:\s*(\S+)\s*$/i))) {
			entry.replacement = m[1].toUpperCase();
			continue;
		}
		if ((m = line.match(/^- resolution:\s*(.*)$/i))) {
			entry.resolution = m[1].trim();
			continue;
		}
		entry.facts.push(line.startsWith("- ") ? line.slice(2) : line);
	}
	return entry;
}

/** Render one entry deterministically (host-owned format). */
export function renderEntry(entry) {
	const lines = [`## [${entry.id}] ${entry.title}`];
	if (entry.id === "STATE-CURRENT") {
		for (const line of String(entry.verbatim ?? "").split("\n")) lines.push(line);
		return lines.join("\n") + "\n";
	}
	if (entry.confidence != null) lines.push(`- confidence: ${entry.confidence}`);
	if (entry.status) lines.push(`- status: ${entry.status}`);
	for (const fact of entry.facts) lines.push(`- ${fact}`);
	if (entry.source != null) lines.push(`- source: ${entry.source}`);
	if (entry.replacement != null) lines.push(`- replacement: ${entry.replacement}`);
	if (entry.resolution != null) lines.push(`- resolution: ${entry.resolution}`);
	return lines.join("\n") + "\n";
}

/** Reassemble a file from its header + entry list. */
export function renderFile(baseContent, entries) {
	if (!entries.length) {
		const parsed = parseLedgerFile(baseContent);
		return parsed.header.trimEnd() + "\n";
	}
	const header = parseLedgerFile(baseContent).header.trimEnd();
	return `${header}\n\n${entries.map(renderEntry).join("\n")}`;
}

/** Split an operation body into fact lines (one per non-blank line). */
export function bodyToFacts(body) {
	return String(body ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function makeEntry(id, title, body, { confidence, source, status }) {
	return {
		id,
		title,
		confidence: confidence ?? 0.8,
		status: status ?? "ACTIVE",
		facts: bodyToFacts(body),
		source: source ?? null,
		replacement: null,
		resolution: null,
		verbatim: null
	};
}

// ---------------------------------------------------------------------------
// ID minting (host-owned)
// ---------------------------------------------------------------------------

/**
 * Mints PREFIX-NNN ids, max+1 over the CURRENT file contents, then
 * sequentially within the batch. The LLM never sees a minted id before the
 * commit — so it can never target, collide, or "reserve" one.
 */
export function makeIdMinter(files) {
	const counters = new Map();
	for (const prefix of ["REQ", "DEC", "TECH", "CONFLICT"]) {
		let max = 0;
		for (const name of GUARDIAN_FILES) {
			const re = new RegExp(`\\b${prefix}-(\\d+)\\b`, "g");
			let m;
			while ((m = re.exec(String(files[name] ?? "")))) max = Math.max(max, Number(m[1]));
		}
		counters.set(prefix, max);
	}
	return (prefix) => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}-${String(next).padStart(3, "0")}`;
	};
}

// ---------------------------------------------------------------------------
// Evidence resolution (P0.5 machinery: E# handle first, quote-unique fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve an operation's evidence to exactly one log seq.
 *  - source_ref present  → the handle must exist (this sync's conversation)
 *    and the quote must be a substring of that message: quote-mismatch is a
 *    hallucination signal and is REJECTED — never a silent fallback.
 *  - source_ref absent   → the quote is searched over the whole durable log:
 *    exactly one match binds; zero → EVIDENCE_NOT_FOUND; several →
 *    AMBIGUOUS_EVIDENCE (cite the handle instead).
 * @returns {{ok: boolean, reason?: string, detail?: string, binding?: {seq: number}, evidenceText?: string}}
 */
export function resolveEvidence({ ref, quote }, { handles, rows }) {
	const nq = normText(quote);
	if (ref) {
		if (!/^E\d+$/.test(ref)) return { ok: false, reason: "BAD_REF", detail: `malformed source_ref "${ref}"` };
		const row = handles.get(ref);
		if (!row) return { ok: false, reason: "UNKNOWN_REF", detail: `handle ${ref} was not presented in this sync` };
		if (!quote) return { ok: false, reason: "NO_EVIDENCE", detail: `handle ${ref} cited without a source_quote` };
		if (!normText(row.text).includes(nq)) return { ok: false, reason: "QUOTE_MISMATCH", detail: `the quote does not appear in message ${ref}` };
		return { ok: true, binding: { seq: row.seq }, evidenceText: row.text };
	}
	if (!quote) return { ok: false, reason: "NO_EVIDENCE", detail: "no source_ref and no source_quote" };
	if (nq.length < 12) return { ok: false, reason: "EVIDENCE_NOT_FOUND", detail: "quote too short to bind (<12 chars)" };
	const hits = [];
	for (const row of rows) if (normText(row.text).includes(nq)) hits.push(row);
	if (hits.length === 0) return { ok: false, reason: "EVIDENCE_NOT_FOUND", detail: "the quote matches no message in the log" };
	if (hits.length > 1) return { ok: false, reason: "AMBIGUOUS_EVIDENCE", detail: `the quote matches ${hits.length} messages — cite the [E#] handle instead` };
	return { ok: true, binding: { seq: hits[0].seq }, evidenceText: hits[0].text };
}

// ---------------------------------------------------------------------------
// Mutation Guard (P1-③): exact atoms must be evidence-backed
// ---------------------------------------------------------------------------

const ATOM_PATTERNS = [
	/\bhttps?:\/\/[^\s"'`),;]+/g, // url
	/[a-z]:\\(?:[^\\\s/]+\\)*[^\\\s/]+/g, // windows path
	/(?:^|[\s"'`=:(<])((?:\.\.?\/|\/)[^\s"'`),;]+)/g, // unix path
	/\b[0-9a-f]{16,40}\b/g, // hash
	/\b\d+(?:\.\d+)?\s*(?:tok\/s|tokens?\/s|ms|us|gb|mb|tb|kb|ghz|mhz|hz|watts?|k|%)\b/g, // number + unit (incl. "192k", "52.31 tok/s")
	/\bv?\d+(?:\.\d+)+(?:[-.][a-z0-9]+)*\b/g, // version (1.2.3, v2.0, 0.30-beta)
	/\b[a-z]+\d+(?:-[a-z0-9]+)*\b/g, // model name (qwen38-agent, llama3)
	/\b[a-z]+-\d+[a-z]*(?:-\d+[a-z]*)*\b/g, // model name (gpt-4o)
	/\b\d+(?:\.\d+)?\b/g, // bare number (last: subsumed fragments pass the substring check)
	/\b(?:error|err|exit\s*code|errno|code)[:\s=#-]*\d{1,6}\b/g, // error code
	/`[^`\n]{3,}`/g, // command (backtick span)
	/\b(?:npm|pnpm|node|npx|git|docker|kubectl|cargo|make|pytest|python3?|go|bash|sh)\s+[a-z@][^\s"'`)]+/g // command (binary-first)
];

/**
 * Extract the EXACT ATOMS from a text: values that must never drift silently
 * (numbers, numbers with units, versions, paths, model names, hashes, urls,
 * error codes, commands). v1 is deliberately conservative — the pattern set
 * is extensible; a missed class only weakens the guard, a false positive
 * rejects loudly (observable, fixable by citing a better message).
 * @returns {Set<string>} normalized atom strings
 */
export function extractExactAtoms(text) {
	const t = normText(text);
	const atoms = new Set();
	for (const re of ATOM_PATTERNS) {
		let m;
		while ((m = re.exec(t))) {
			atoms.add(normText(m[1] ?? m[0]));
			if (m[0] === "") re.lastIndex += 1; // never spin on a zero-length match
		}
	}
	return atoms;
}

/**
 * The guard itself: every atom present in the NEW text but absent from the
 * OLD text must appear verbatim in the cited evidence. (Removed atoms need
 * no evidence — a replacement legitimately drops the old value; the NEW
 * value is what must be backed.) Returns null when clean, else a detail
 * string for the rejection.
 */
export function mutationGate(oldText, newText, evidenceText) {
	const ev = normText(evidenceText ?? "");
	if (!ev) return "no evidence text available to back the exact atoms";
	const oldAtoms = extractExactAtoms(oldText);
	const missing = [];
	for (const atom of extractExactAtoms(newText)) {
		if (!oldAtoms.has(atom) && !ev.includes(atom)) missing.push(atom);
	}
	return missing.length ? `atoms absent from the cited evidence: ${missing.slice(0, 5).join(", ")}` : null;
}

// ---------------------------------------------------------------------------
// Operation normalization + validation
// ---------------------------------------------------------------------------

function str(v) {
	return typeof v === "string" ? v.trim() : "";
}

function clampConfidence(v) {
	return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

function normRef(v) {
	return typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null;
}

function normKind(v) {
	const k = String(v ?? "").trim().toUpperCase().replace(/[\s-]+/g, "");
	return KIND_ALIASES[k] ?? (OP_KINDS[k] ? k : null);
}

/** Normalize one raw operation. Returns {ok, op?, error?}. */
export function normalizeOp(item) {
	if (!item || typeof item !== "object") return { ok: false, error: "operation is not an object" };
	const name = String(item.op ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
	if (!OPS.includes(name)) return { ok: false, error: `unknown op "${item.op}"` };
	const op = {
		name,
		transactionGroup: typeof item.transactionGroup === "string" && item.transactionGroup.trim() ? item.transactionGroup.trim() : null,
		sourceRef: normRef(item.source_ref),
		sourceQuote: str(item.source_quote) || null,
		confidence: clampConfidence(item.confidence)
	};
	switch (name) {
		case "ADD": {
			const kind = normKind(item.kind);
			if (!kind || kind === "CONFLICT") return { ok: false, error: "ADD kind must be REQ | DEC | TECH (conflicts use the CONFLICT op)" };
			op.kind = kind;
			op.title = str(item.title);
			op.body = str(item.body);
			if (!op.title) return { ok: false, error: "ADD requires title" };
			if (!op.body) return { ok: false, error: "ADD requires body" };
			break;
		}
		case "UPDATE_STATE":
			op.title = str(item.title);
			op.body = str(item.body);
			if (!op.body) return { ok: false, error: "UPDATE_STATE requires body (the complete new STATE-CURRENT text)" };
			break;
		case "AMEND":
			op.targetId = str(item.target_id);
			op.title = str(item.title);
			op.body = str(item.body);
			if (!op.targetId) return { ok: false, error: "AMEND requires target_id (an existing entry id)" };
			if (!op.body) return { ok: false, error: "AMEND requires body (the entry's COMPLETE new fact lines)" };
			break;
		case "SUPERSEDE": {
			op.targetId = str(item.target_id);
			const rep = item.replacement;
			if (!op.targetId) return { ok: false, error: "SUPERSEDE requires target_id (an existing entry id)" };
			if (!rep || typeof rep !== "object") return { ok: false, error: "SUPERSEDE requires replacement" };
			const kind = normKind(rep.kind);
			if (!kind || kind === "CONFLICT") return { ok: false, error: "SUPERSEDE.replacement.kind must be REQ | DEC | TECH" };
			op.replacement = {
				kind,
				title: str(rep.title),
				body: str(rep.body),
				confidence: clampConfidence(rep.confidence),
				sourceRef: normRef(rep.source_ref),
				sourceQuote: str(rep.source_quote) || null
			};
			if (!op.replacement.title) return { ok: false, error: "SUPERSEDE.replacement requires title" };
			if (!op.replacement.body) return { ok: false, error: "SUPERSEDE.replacement requires body" };
			break;
		}
		case "CONFLICT":
			op.topic = str(item.topic);
			op.body = str(item.body);
			if (!op.topic) return { ok: false, error: "CONFLICT requires topic" };
			if (!op.body) return { ok: false, error: "CONFLICT requires body (both sides of the disagreement)" };
			break;
		case "RESOLVE_CONFLICT":
			op.targetId = str(item.target_id);
			op.resolution = str(item.resolution);
			if (!op.targetId) return { ok: false, error: "RESOLVE_CONFLICT requires target_id (a CONFLICT-NNN id)" };
			if (!op.resolution) return { ok: false, error: "RESOLVE_CONFLICT requires resolution" };
			break;
		case "NOOP":
			break;
	}
	return { ok: true, op };
}

function entryText(entry) {
	return [entry.title, ...(entry.facts ?? []), entry.source].filter(Boolean).join("\n");
}

/**
 * Validate one normalized operation against the current ledger + evidence.
 * @returns {{ok: true, result: {binding, evidenceText, target}} | {ok: false, reason, detail}}
 */
export function validateOp(op, { entryById, handles, rows }) {
	let target = null;
	if (op.name === "AMEND" || op.name === "SUPERSEDE") {
		target = entryById.get(op.targetId) ?? null;
		if (!target) return { ok: false, reason: "TARGET_NOT_FOUND", detail: `${op.targetId} is not in the ledger` };
		if ((target.status ?? "ACTIVE") !== "ACTIVE") return { ok: false, reason: "TARGET_NOT_ACTIVE", detail: `${op.targetId} is ${target.status ?? "ACTIVE"}` };
	}
	if (op.name === "RESOLVE_CONFLICT") {
		target = entryById.get(op.targetId) ?? null;
		if (!target) return { ok: false, reason: "TARGET_NOT_FOUND", detail: `${op.targetId} is not in the ledger` };
		if ((target.status ?? "ACTIVE") !== "ACTIVE") return { ok: false, reason: "TARGET_NOT_ACTIVE", detail: `${op.targetId} is ${target.status ?? "ACTIVE"}` };
	}

	let binding = null;
	let evidenceText = null;
	const gated = EVIDENCE_GATED.has(op.name);
	const top = resolveEvidence({ ref: op.sourceRef, quote: op.sourceQuote }, { handles, rows });
	if (gated) {
		if (!top.ok) return { ok: false, reason: top.reason, detail: top.detail };
		binding = top.binding;
		evidenceText = top.evidenceText;
	} else if (op.sourceRef || op.sourceQuote) {
		// optional evidence (UPDATE_STATE) — if offered it must still be valid
		if (!top.ok) return { ok: false, reason: top.reason, detail: top.detail };
		binding = top.binding;
		evidenceText = top.evidenceText;
	}
	if (op.name === "SUPERSEDE") {
		const rep = resolveEvidence({ ref: op.replacement.sourceRef, quote: op.replacement.sourceQuote }, { handles, rows });
		if (!rep.ok) return { ok: false, reason: rep.reason, detail: `replacement: ${rep.detail}` };
		binding = rep.binding; // the sidecar binds the NEW entry's evidence
		evidenceText = rep.evidenceText;
	}

	if (op.name === "AMEND" || op.name === "SUPERSEDE" || op.name === "ADD" || op.name === "CONFLICT") {
		const oldText = op.name === "AMEND" || op.name === "SUPERSEDE" ? entryText(target) : "";
		const newText = op.name === "SUPERSEDE" ? op.replacement.body : op.body;
		const bad = mutationGate(oldText, newText, evidenceText);
		if (bad) return { ok: false, reason: "MUTATION_WITHOUT_EVIDENCE", detail: bad };
	}
	return { ok: true, result: { binding, evidenceText, target } };
}

// ---------------------------------------------------------------------------
// Plan (validate + group atomicity + id minting)
// ---------------------------------------------------------------------------

/**
 * Plan a raw Guardian response against a ledger snapshot.
 * @param raw  {operations: [...], history?: string} (already JSON-parsed)
 * @param ctx  { files: Record<string,string>, handles: Map<E#,{seq,text}>, rows: [{seq,text}] }
 * @returns {{ok: false, error} | {ok: true, applied: [...], rejected: [{index, op, reason, detail, group}]}}
 * Applied items: { index, op, id?, target?, binding? } in original array order
 * (ids are minted here so SUPERSEDE knows its replacement id).
 */
export function planOperations(raw, ctx) {
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.operations)) return { ok: false, error: "no operations array in the Guardian response" };
	const files = ctx.files ?? {};
	const entryById = new Map();
	for (const name of GUARDIAN_FILES) for (const entry of parseLedgerFile(files[name]).entries) entryById.set(entry.id, entry);

	const planned = [];
	const rejected = [];
	for (let i = 0; i < raw.operations.length; i += 1) {
		const item = raw.operations[i];
		const norm = normalizeOp(item);
		if (!norm.ok) {
			rejected.push({ index: i, op: String(item?.op ?? "?"), reason: "BAD_OPERATION", detail: norm.error, group: typeof item?.transactionGroup === "string" ? item.transactionGroup.trim() : "" });
			continue;
		}
		const op = norm.op;
		const check = validateOp(op, { entryById, handles: ctx.handles ?? new Map(), rows: ctx.rows ?? [] });
		if (!check.ok) {
			rejected.push({ index: i, op: op.name, reason: check.reason, detail: check.detail, group: op.transactionGroup ?? "" });
			continue;
		}
		planned.push({ index: i, op, target: check.result.target, binding: check.result.binding });
	}

	// transactionGroup atomicity: one invalid member rejects the whole group;
	// independent operations commit on their own.
	const failedGroups = new Set(rejected.filter((r) => r.group).map((r) => r.group));
	const applied = [];
	for (const p of planned) {
		const g = p.op.transactionGroup;
		if (g && failedGroups.has(g)) {
			rejected.push({ index: p.index, op: p.op.name, reason: "GROUP_REJECTED", detail: `transactionGroup ${g} was rejected atomically`, group: g });
			continue;
		}
		applied.push(p);
	}

	// Host-owned id minting, in original array order.
	const mint = makeIdMinter(files);
	for (const p of applied) {
		if (p.op.name === "ADD") p.id = mint(p.op.kind);
		else if (p.op.name === "SUPERSEDE") p.id = mint(p.op.replacement.kind);
		else if (p.op.name === "CONFLICT") p.id = mint("CONFLICT");
	}
	return { ok: true, applied, rejected };
}

// ---------------------------------------------------------------------------
// Apply (deterministic file rendering)
// ---------------------------------------------------------------------------

function findEntryWork(work, id) {
	for (const name of GUARDIAN_FILES) {
		const entry = work[name].entries.find((e) => e.id === id);
		if (entry) return { name, entry };
	}
	return null;
}

/**
 * Apply planned operations to a file snapshot.
 * @param files   Record<string,string> current contents
 * @param applied planOperations() applied list
 * @returns {{nextFiles: Record<string,string>, changed: string[], notes: string[]}}
 */
export function applyOperations(files, applied) {
	const work = {};
	for (const name of GUARDIAN_FILES) work[name] = parseLedgerFile(files[name]);
	const touched = new Set(); // only files an applied op actually wrote are re-rendered
	const changed = new Set();
	const notes = [];

	for (const p of applied) {
		const op = p.op;
		if (op.name === "NOOP") continue;
		if (op.name === "ADD") {
			const file = OP_KINDS[op.kind];
			work[file].entries.push(makeEntry(p.id, op.title, op.body, { confidence: op.confidence, source: op.sourceQuote, status: "ACTIVE" }));
			touched.add(file);
			notes.push(`ADD ${p.id}`);
		} else if (op.name === "UPDATE_STATE") {
			let entry = work["STATE.md"].entries.find((e) => e.id === "STATE-CURRENT");
			if (!entry) {
				entry = { id: "STATE-CURRENT", title: "Current state", confidence: null, status: null, facts: [], source: null, replacement: null, resolution: null, verbatim: "" };
				work["STATE.md"].entries.push(entry);
			}
			if (op.title) entry.title = op.title;
			entry.verbatim = op.body;
			touched.add("STATE.md");
			notes.push("UPDATE_STATE");
		} else if (op.name === "AMEND") {
			const hit = findEntryWork(work, op.targetId);
			if (!hit) continue; // cannot happen after validation — defensive
			hit.entry.facts = bodyToFacts(op.body);
			if (op.title) hit.entry.title = op.title;
			if (op.sourceQuote) hit.entry.source = op.sourceQuote;
			touched.add(hit.name);
			notes.push(`AMEND ${op.targetId}`);
		} else if (op.name === "SUPERSEDE") {
			const hit = findEntryWork(work, op.targetId);
			if (!hit) continue; // defensive
			hit.entry.status = "SUPERSEDED";
			hit.entry.replacement = p.id;
			const file = OP_KINDS[op.replacement.kind];
			work[file].entries.push(makeEntry(p.id, op.replacement.title, op.replacement.body, { confidence: op.replacement.confidence, source: op.replacement.sourceQuote, status: "ACTIVE" }));
			touched.add(hit.name);
			touched.add(file);
			notes.push(`SUPERSEDE ${op.targetId}->${p.id}`);
		} else if (op.name === "CONFLICT") {
			work["CONFLICTS.md"].entries.push(makeEntry(p.id, op.topic, op.body, { confidence: op.confidence, source: op.sourceQuote, status: "ACTIVE" }));
			touched.add("CONFLICTS.md");
			notes.push(`CONFLICT ${p.id}`);
		} else if (op.name === "RESOLVE_CONFLICT") {
			const hit = findEntryWork(work, op.targetId);
			if (!hit) continue; // defensive
			hit.entry.status = "RESOLVED";
			hit.entry.resolution = op.resolution;
			if (op.sourceQuote) hit.entry.source = op.sourceQuote;
			touched.add(hit.name);
			notes.push(`RESOLVE_CONFLICT ${op.targetId}`);
		}
	}

	// Untouched files keep their EXACT original bytes (a NOOP batch — or the
	// members of a rejected group — cannot perturb a file it did not write).
	const nextFiles = { ...files };
	for (const name of touched) {
		const rendered = renderFile(files[name], work[name].entries);
		if (rendered !== (files[name] ?? "")) {
			nextFiles[name] = rendered;
			changed.add(name);
		}
	}
	return { nextFiles, changed: [...changed], notes };
}
