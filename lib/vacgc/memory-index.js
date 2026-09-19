/**
 * VAC-GC ledger index (plan §19, §25, §85).
 *
 * Parses the project's Markdown memory ledger into an in-memory relevance
 * index the protection gate and scorer consume: entry IDs with status,
 * cross-citations between entries, ACTIVE sets, STATE current-file paths.
 *
 * Performance contract (§132): the index is cached per directory and only
 * re-reads files whose mtime changed. HISTORY.md is deliberately NOT indexed
 * per round (it grows with every sync) — it stays available to the model's
 * memory_search tool and to on-demand grep, exactly as the plan requires.
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { extractTerms } from "./text.js";

/** Ledger files that feed the VAC-GC index (HISTORY.md excluded by design). */
export const INDEXED_LEDGER_FILES = ["INDEX.md", "PROJECT.md", "STATE.md", "DECISIONS.md", "TECH.md", "CONFLICTS.md"];

// ID shapes: REQ-001 / DEC-001 / TECH-032 / CONFLICT-001 (numeric suffix)
// and STATE-CURRENT (LETTER suffix). Both must match — the old \d+-only
// regex silently never parsed STATE-CURRENT, which made the §19 standing
// task context (stateText/statePaths) and its special handling dead code.
const ENTRY_RE = /^## \[([A-Z]+-[A-Z0-9]+)\]\s*(.*)$/;
const STATUS_RE = /^\s*[-*]?\s*(?:status|状态)\s*[:：]\s*([A-Za-z]+)/i;
const STATE_CURRENT_ID = "STATE-CURRENT";

/** English function words too common to identify evidence (kept small on
 *  purpose — a missed stopword only widens the conservative hold, which is
 *  the safe direction). */
const EVIDENCE_STOPWORDS = new Set([
	"the", "and", "for", "with", "from", "this", "that", "are", "was", "were", "not", "but", "all", "any", "can", "had", "has", "have",
	"one", "its", "our", "you", "your", "will", "would", "then", "than", "when", "what", "which", "who", "into", "over", "under",
	"about", "after", "before", "because", "while", "such", "each", "some", "more", "most", "other", "these", "those", "there",
	"here", "now", "yes", "use", "used", "using", "via", "per", "etc", "they", "them", "their", "him", "her", "his", "she", "he",
	"it", "be", "to", "in", "on", "at", "by", "or", "if", "so", "no", "do", "did", "as", "of", "an", "am", "is", "were", "may",
]);

/**
 * Lexical evidence terms for one entry: its title plus the stored
 * `- source:` quote (the verbatim evidence text the host persisted).
 * Lowercase tokens: CJK runs ≥ 3 chars, latin/digit runs ≥ 3 chars minus
 * stopwords — CJK function words (的/了/是/在…) are single-char and fall
 * out of the length filter automatically.
 * @param entry - parsed entry ({title, text}).
 * @returns Set<string> (empty when nothing usable — no hold, no noise).
 */
export function evidenceTerms(entry) {
	const lines = (entry.text ?? "").split(/\r?\n/);
	const sourceLine = lines.find((l) => /^\s*[-*]?\s*source\s*[:：]/i.test(l));
	const source = sourceLine ? sourceLine.replace(/^\s*[-*]?\s*source\s*[:：]\s*/i, "").trim() : "";
	const pool = `${entry.title ?? ""} ${source}`.toLowerCase();
	const out = new Set();
	for (const tok of pool.split(/[^0-9a-z\u4e00-\u9fff]+/)) {
		if (tok.length < 3) continue;
		if (EVIDENCE_STOPWORDS.has(tok)) continue;
		out.add(tok);
		if (out.size >= 12) break;
	}
	return out;
}

/**
 * Parsed ledger index for one project directory.
 *
 * Entry shape: {id, title, file, status, active, cites:Set<string>,
 * terms: termSet, text}. `status` is the normalized uppercase status
 * (default ACTIVE when the entry carries no explicit status line — an
 * un-marked ledger entry is live until it says otherwise).
 */
export class LedgerIndex {
	/**
	 * @param dir - ledger directory (e.g. <projectRoot>/.dsh-memory).
	 */
	constructor(dir) {
		this.dir = dir;
		this.entries = new Map();
		this.activeIds = new Set();
		/** IDs cited by at least one ACTIVE entry (dependency lane, §25). */
		this.citedByActive = new Set();
		/** File paths mentioned by the STATE-CURRENT entry (§25). */
		this.statePaths = new Set();
		/** Raw STATE-CURRENT text — the standing task context (§19). */
		this.stateText = "";
		/** Provenance (review 2026-09-12, P0): Map<sessionId, Map<seq, Set<entryId>>>
		 *  from .provenance.json — which ACTIVE ledger entries were EXTRACTED
		 *  from which conversation events. Feeds the protection gate's
		 *  activeSourceIds() lane. */
		this.provenance = new Map();
		/** Provenance DEGRADED state (P0.5): ACTIVE entry ids that currently
		 *  have NO resolved evidence binding — either flagged in the sidecar's
		 *  `unresolved` map (last resolution failed: ambiguous/quote-mismatch/…)
		 *  or simply absent from every binding row (sidecar missing/corrupt/
		 *  never written). These hold lexically-related units at P1 in the
		 *  conservative lane — "keep more, never delete wrongly". */
		this.unresolvedActiveIds = new Set();
		/** Lexical evidence terms (title + stored `- source:` quote) per
		 *  unresolved ACTIVE entry — the conservative lane's match surface. */
		this.unresolvedTerms = new Map();
		/** Sidecar-stated failure reasons (id → reason string) for the
		 *  unresolved set — observability/repair surface (memory/provenance RPC). */
		this.unresolvedReasons = new Map();
		this.available = false;
		this.signature = null;
	}

	/** Max mtime across indexed files + the provenance sidecar. */
	#signature() {
		let max = 0;
		for (const name of [...INDEXED_LEDGER_FILES, ".provenance.json"]) {
			try {
				const m = statSync(join(this.dir, name)).mtimeMs;
				if (m > max) max = m;
			} catch {
				// absent file — fine
			}
		}
		return max || null;
	}

	/**
	 * Load (or re-load when stale). Safe to call every round: a fresh index
	 * is a no-op when no ledger file changed.
	 * @returns this.
	 */
	refreshIfStale() {
		if (!existsSync(this.dir)) {
			this.available = false;
			this.entries.clear();
			this.activeIds.clear();
			this.citedByActive.clear();
			this.statePaths.clear();
			this.stateText = "";
			this.provenance.clear();
			this.unresolvedActiveIds.clear();
			this.unresolvedTerms.clear();
			this.unresolvedReasons.clear();
			this.signature = null;
			return this;
		}
		const sig = this.#signature();
		if (this.available && this.signature === sig) return this;
		this.load();
		this.signature = sig;
		return this;
	}

	/** Full re-parse of the indexed ledger files. @returns this. */
	load() {
		this.entries.clear();
		this.provenance.clear();
		this.unresolvedActiveIds.clear();
		this.unresolvedTerms.clear();
		this.unresolvedReasons.clear();
		this.available = existsSync(this.dir);
		if (!this.available) return this;
		for (const name of INDEXED_LEDGER_FILES) {
			let raw;
			try {
				raw = readFileSync(join(this.dir, name), "utf8");
			} catch {
				continue;
			}
			this.#parseFile(basename(name), raw);
		}
		this.#loadProvenance();
		this.#recomputeDerived();
		this.#recomputeUnresolved();
		return this;
	}

	/**
	 * Parse the provenance sidecar: { sessions: { <sessionId>: { <seq>:
	 * [entryId, ...] } } }. Written by the engine at sync time (host-side
	 * resolution of the Guardian's `source:` quotes to log seqs — the LLM
	 * never sees seq numbers). Tolerant of any malformed shape.
	 */
	#loadProvenance() {
		let raw;
		try {
			raw = readFileSync(join(this.dir, ".provenance.json"), "utf8");
		} catch {
			return; // absent — no provenance yet
		}
		let doc;
		try {
			doc = JSON.parse(raw);
		} catch {
			return;
		}
		const sessions = doc?.sessions;
		if (typeof sessions === "object" && sessions !== null) {
			for (const [sessionId, bySeq] of Object.entries(sessions)) {
				if (typeof bySeq !== "object" || bySeq === null) continue;
				const seqMap = new Map();
				for (const [seqStr, ids] of Object.entries(bySeq)) {
					if (!Array.isArray(ids)) continue;
					seqMap.set(Number(seqStr), new Set(ids.filter((id) => typeof id === "string")));
				}
				if (seqMap.size > 0) this.provenance.set(sessionId, seqMap);
			}
		}
		const unresolved = doc?.unresolved;
		if (typeof unresolved === "object" && unresolved !== null) {
			for (const [id, info] of Object.entries(unresolved)) {
				if (typeof id !== "string") continue;
				this.unresolvedReasons.set(id, typeof info?.reason === "string" ? info.reason : "unknown");
			}
		}
	}

	/**
	 * P0.5 degraded state: an ACTIVE entry is UNRESOLVED when the sidecar
	 * flags its last resolution as failed (unresolvedReasons) OR it has no
	 * binding row at all (sidecar absent/corrupt — the fail-safe default).
	 * For each unresolved entry we also extract lexical evidence terms
	 * (title + stored `- source:` quote) that the protection gate's
	 * conservative lane matches against unit text. Entries with no usable
	 * terms contribute nothing (nothing to match — no false holds).
	 */
	#recomputeUnresolved() {
		this.unresolvedActiveIds.clear();
		this.unresolvedTerms.clear();
		const boundIds = new Set();
		for (const seqMap of this.provenance.values()) {
			for (const ids of seqMap.values()) for (const id of ids) boundIds.add(id);
		}
		for (const id of this.activeIds) {
			if (this.unresolvedReasons.has(id) || !boundIds.has(id)) {
				this.unresolvedActiveIds.add(id);
				const entry = this.entries.get(id);
				const terms = entry ? evidenceTerms(entry) : new Set();
				if (terms.size > 0) this.unresolvedTerms.set(id, terms);
			}
		}
	}

	/**
	 * ACTIVE ledger ids whose provenance covers any of the given seqs of the
	 * given session (the protection gate's provenance lane). seqs are
	 * session-local. @returns Set<string> (empty when nothing matches).
	 */
	activeSourceIds(sessionId, seqs) {
		const out = new Set();
		if (!this.available || typeof sessionId !== "string") return out;
		const seqMap = this.provenance.get(sessionId);
		if (seqMap === undefined) return out;
		for (const seq of seqs) {
			const ids = seqMap.get(Number(seq));
			if (ids === undefined) continue;
			for (const id of ids) if (this.activeIds.has(id)) out.add(id);
		}
		return out;
	}

	#parseFile(file, raw) {
		const lines = raw.split(/\r?\n/);
		let current = null;
		let inStateCurrent = false;
		for (const line of lines) {
			const entryMatch = line.match(ENTRY_RE);
			if (entryMatch) {
				const id = entryMatch[1];
				current = {
					id,
					title: entryMatch[2].trim(),
					file,
					status: "ACTIVE",
					text: "",
					cites: new Set()
				};
				this.entries.set(id, current);
				inStateCurrent = id === STATE_CURRENT_ID;
				continue;
			}
			if (current === null) continue;
			current.text += `${line}\n`;
			const statusMatch = line.match(STATUS_RE);
			if (statusMatch) current.status = statusMatch[1].toUpperCase();
		}
		// Cross-citations: entry A cites entry B when B's id appears in A's text.
		for (const entry of this.entries.values()) {
			for (const id of this.entries.keys()) {
				if (id !== entry.id && new RegExp(`\\b${id}\\b`).test(entry.text)) entry.cites.add(id);
			}
			// STATE-CURRENT special: keep its text + paths for the scorer.
			if (entry.id === STATE_CURRENT_ID) {
				this.stateText = entry.text;
				const terms = extractTerms(entry.text);
				this.statePaths = terms.paths;
			}
		}
	}

	#recomputeDerived() {
		this.activeIds.clear();
		this.citedByActive.clear();
		for (const entry of this.entries.values()) {
			if (entry.id === STATE_CURRENT_ID) continue;
			if (entry.status === "ACTIVE") {
				this.activeIds.add(entry.id);
				for (const cited of entry.cites) this.citedByActive.add(cited);
			}
		}
	}

	/**
	 * Term set of the standing task context (STATE-CURRENT), precomputed for
	 * relevance matching. The ACTIVE query terms (last user message) are
	 * merged in by the planner.
	 * @returns termSet() shape.
	 */
	stateTerms() {
		return extractTerms(this.stateText);
	}
}

/**
 * Build a LedgerIndex for the session's project ledger, or null when there
 * is no ledger yet / memory indexing is disabled. Never throws.
 * @param dir - ledger directory.
 * @param cache - Map<dir, LedgerIndex> for reuse across rounds.
 * @returns LedgerIndex or null.
 */
export function getLedgerIndex(dir, cache) {
	try {
		if (typeof dir !== "string" || dir.length === 0) return null;
		let index = cache.get(dir);
		if (index === undefined) {
			index = new LedgerIndex(dir);
			cache.set(dir, index);
		}
		index.refreshIfStale();
		return index.available ? index : null;
	} catch {
		return null;
	}
}

/** Directory listing of a ledger dir (for diagnostics); never throws. */
export function ledgerFiles(dir) {
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".md"));
	} catch {
		return [];
	}
}
