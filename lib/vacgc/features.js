/**
 * VAC-GC feature extraction (plan §11–§31).
 *
 * Three dimensions, NOT one linear score: long-term value (intrinsic ×
 * decay × dependency), active value (relevance × recency × dependency), and
 * compression cost (reconstructibility, duplication, size). Weights ORDER
 * compression inside the safe set — they can never raise or lower protection
 * (that is protection.js's job, done first).
 *
 * Deterministic and LLM-free. Every constant below is the plan's table; V1
 * assumptions are marked.
 */
import { fingerprint, lineSetOverlap, looksLikeGreeting } from "./text.js";

// §13 intrinsic importance (NORMAL lane; P0/P1 are handled pre-scoring).
// §22 per-content-type turn decay constant τturn.
// §27 reconstructibility X.
const CONTENT_TYPES = {
	"hard-constraint": { intrinsic: 1.0, tau: Infinity, x: 0.0 },
	"active-decision": { intrinsic: 0.98, tau: 40, x: 0.1 },
	"blocker": { intrinsic: 0.95, tau: 40, x: 0.2 },
	"goal": { intrinsic: 0.95, tau: 40, x: 0.0 },
	"benchmark": { intrinsic: 0.85, tau: 80, x: 0.35 },
	"root-cause": { intrinsic: 0.82, tau: 40, x: 0.2 },
	"key-fix": { intrinsic: 0.80, tau: 40, x: 0.2 },
	"file-relation": { intrinsic: 0.75, tau: 16, x: 0.95 },
	"assistant-reasoning": { intrinsic: 0.55, tau: 16, x: 0.3 },
	"search-result": { intrinsic: 0.30, tau: 5, x: 0.9 },
	"file-read": { intrinsic: 0.30, tau: 8, x: 0.95 },
	"git-status": { intrinsic: 0.30, tau: 3, x: 1.0 },
	"git-diff": { intrinsic: 0.30, tau: 3, x: 0.95 },
	"dir-listing": { intrinsic: 0.30, tau: 3, x: 1.0 },
	"web-search": { intrinsic: 0.30, tau: 5, x: 0.7 },
	"test-log": { intrinsic: 0.35, tau: 10, x: 0.85 },
	"build-log": { intrinsic: 0.20, tau: 3, x: 0.9 },
	"tool-log": { intrinsic: 0.15, tau: 3, x: 0.9 },
	"repeated-tool-output": { intrinsic: 0.10, tau: 3, x: 0.9 },
	"user-request": { intrinsic: 0.35, tau: 24, x: 0.0 },
	"greeting": { intrinsic: 0.02, tau: 3, x: 1.0 },
	"checkpoint": { intrinsic: 0.90, tau: 40, x: 0.2 },
	"injected": { intrinsic: 0.15, tau: 8, x: 1.0 }
};

const BUILD_RE = /(?:error|warning|fail|build|compile|bundling|vite|webpack|tsc|esbuild|pnpm|npm)/i;
const TEST_RE = /\btest(?:s|ing)?\b|vitest|jest|mocha|pytest|node --test|passing|failing|\bpass\b|\bfail\b/i;
const GIT_STATUS_RE = /\bgit\s+status\b|\bOn branch\b|\bnothing to commit\b|\bChanges to be committed\b/;
const GIT_DIFF_RE = /\bgit\s+diff\b|\bdiff --git\b|\bindex [0-9a-f]+\.\./;
const BENCH_RE = /benchmark|\bbench\b|基准|耗时|throughput|latency|p95|p50|tokens\/s|tok\/s/i;

/**
 * Map a unit to its content type (§13/§22/§27 table key).
 * @param unit - ContextUnit.
 * @returns content type string.
 */
export function contentTypeOf(unit) {
	switch (unit.kind) {
		case "checkpoint":
			return "checkpoint";
		case "injected":
			return "injected";
		case "user":
			return looksLikeGreeting(unit.text) ? "greeting" : "user-request";
		case "assistant":
			return "assistant-reasoning";
		case "tool-pair": {
			const args = unit.toolArgs ?? "";
			const text = unit.text ?? "";
			// Deterministic tool names first (a `read` of test.js is a file
			// read, not a test log).
			switch ((unit.toolName ?? "").toLowerCase()) {
				case "read":
				case "read_file":
				case "cat":
					return "file-read";
				case "glob":
				case "ls":
					return "dir-listing";
				case "grep":
				case "find":
				case "search":
					return "search-result";
				case "web_search":
				case "search_web":
				case "web_fetch":
					return "web-search";
			}
			// Then content lanes for the shell/exec-style tools.
			if (GIT_STATUS_RE.test(args) || GIT_STATUS_RE.test(text)) return "git-status";
			if (GIT_DIFF_RE.test(args) || GIT_DIFF_RE.test(text)) return "git-diff";
			if (BENCH_RE.test(text) || unit.terms?.ids?.some((id) => id.startsWith("bench-"))) return "benchmark";
			if (TEST_RE.test(args) || /\bpass(?:ing|ed)?\b|\bfail(?:ing|ed)?\b/i.test(text)) return "test-log";
			if (BUILD_RE.test(text) && text.length > 400) return "build-log";
			return "tool-log";
		}
		default:
			return "tool-log";
	}
}

/**
 * Recency R (§21–23): R = 0.75·exp(-ageTurns/τturn) + 0.25·exp(-ageMinutes/τtime).
 * Time acts ONLY on recency — never on intrinsic importance (the P0/P1 floor
 * lives in the scorer). V1: τtime = 30 × τturn minutes (≈ one turn per 30
 * min of active work; plan leaves τtime to implementation).
 * @param unit - unit with turnsAfter.
 * @param contentType - content type (τ source).
 * @param now - wall clock ms.
 * @returns {R, ageTurns, ageMinutes, tauTurns, turnDecay, timeDecay}.
 */
export function recencyOf(unit, contentType, now) {
	const { tau } = CONTENT_TYPES[contentType] ?? CONTENT_TYPES["tool-log"];
	const ageTurns = Math.max(0, unit.turnsAfter ?? 0);
	const ageMinutes = Math.max(0, (now - unit.createdAt) / 60000);
	const turnDecay = Math.exp(-ageTurns / tau); // τ = ∞ → exp(−0) = exactly 1
	const timeDecay = Math.exp(-ageMinutes / (tau * 30));
	const R = 0.75 * turnDecay + 0.25 * timeDecay;
	return { R, ageTurns, ageMinutes, tauTurns: tau, turnDecay, timeDecay };
}

/**
 * Task relevance (§15–18): lexical intersection of the unit's terms with the
 * active query terms. Weights: exact memory ID +0.50, path +0.40, symbol
 * +0.35, error +0.35, model/version +0.30, strong keyword +0.25, weak
 * keyword +0.10; each lane counted once; clamp(0,1).
 * @param unit - unit with a lowercase `terms` view.
 * @param query - { ids:Set, paths:Set, symbols:Set, errors:Set, models:Set, keywords:[] } (lowercase).
 * @returns {score, hits: string[]}.
 */
export function relevanceOf(unit, query) {
	if (!query) return { score: 0, hits: [] };
	const u = unit.terms ?? {};
	const hits = [];
	let score = 0;
	if (query.ids && u.ids?.length > 0) {
		for (const id of u.ids) if (query.ids.has(id)) { score += 0.5; hits.push(`memory-id ${id}`); break; }
	}
	if (query.paths && u.paths?.length > 0) {
		for (const p of u.paths) if (query.paths.has(p)) { score += 0.4; hits.push(`path ${p}`); break; }
	}
	if (query.symbols && u.symbols?.length > 0) {
		for (const s of u.symbols) if (query.symbols.has(s)) { score += 0.35; hits.push(`symbol ${s}`); break; }
	}
	if (query.errors && u.errors?.length > 0) {
		for (const e of u.errors) if (query.errors.has(e)) { score += 0.35; hits.push(`error ${e}`); break; }
	}
	if (query.models && u.models?.length > 0) {
		for (const m of u.models) if (query.models.has(m)) { score += 0.3; hits.push(`model/version ${m}`); break; }
	}
	// query.keywords is a Set from buildQueryTerms (or an array in tests)
	const queryKw = Array.isArray(query.keywords) ? query.keywords : [...(query.keywords ?? [])];
	if (queryKw.length > 0 && u.keywords?.length > 0) {
		const unitKw = new Set(u.keywords);
		let strong = false;
		let weak = false;
		for (const kw of queryKw) {
			if (unitKw.has(kw)) {
				if (kw.length >= 4) strong = true;
				else weak = true;
			}
			if (strong) break;
		}
		if (strong) { score += 0.25; hits.push("strong keyword"); }
		else if (weak) { score += 0.1; hits.push("weak keyword"); }
	}
	return { score: Math.min(1, Math.max(0, score)), hits };
}

/**
 * Dependency (§25): referenced-by / cited-by / current-file signals.
 * @param unit - unit.
 * @param memory - LedgerIndex or null.
 * @returns {score, reasons: string[]}.
 */
export function dependencyOf(unit, memory) {
	let score = 0;
	const reasons = [];
	const ids = (unit.terms?.ids ?? []).map((s) => s.toUpperCase());
	if (memory?.available && ids.length > 0) {
		for (const id of ids) {
			if (memory.activeIds.has(id)) { score += 0.5; reasons.push(`references ACTIVE ${id}`); break; }
		}
		for (const id of ids) {
			if (memory.citedByActive.has(id)) { score += 0.25; reasons.push(`cited by ACTIVE entry ${id}`); break; }
		}
	}
	const paths = unit.terms?.paths ?? [];
	if (memory?.statePaths?.size > 0 && paths.length > 0) {
		for (const p of paths) {
			const hit = [...memory.statePaths].find((sp) => sp.toLowerCase() === p.toLowerCase());
			if (hit) { score += 0.25; reasons.push(`current file in STATE: ${hit}`); break; }
		}
	}
	return { score: Math.min(1, score), reasons };
}

/**
 * Size penalty (§31): min(0.15, 0.02·log2(max(tokens,256)/256)); P0-immune
 * (the scorer simply does not apply it to protected units).
 * @param tokens - unit tokens.
 * @returns penalty in [0, 0.15].
 */
export function sizePenaltyOf(tokens) {
	if (!Number.isFinite(tokens) || tokens <= 256) return 0;
	return Math.min(0.15, 0.02 * Math.log2(Math.max(tokens, 256) / 256));
}

/**
 * Pre-pass for §30 repeated file re-reads: keep the FIRST read (context of
 * the initial state) and the NEWEST read (current state); every middle
 * version is a duplicate. Returns a Set of unit ids to mark (the planner
 * builds it once over the whole unit list, because the middle status of a
 * unit is only known when the LAST read of the run is seen).
 * @param units - ContextUnits in surface order.
 * @returns Set of middle-read unit ids.
 */
export function markRepeatedReadMiddles(units) {
	const runs = new Map();
	for (const unit of units) {
		if (unit.kind !== "tool-pair" || (unit.toolName ?? "").toLowerCase() !== "read") continue;
		const path = (unit.terms?.paths ?? [])[0]?.toLowerCase();
		if (!path) continue;
		const run = runs.get(path) ?? [];
		run.push(unit.id);
		runs.set(path, run);
	}
	const middles = new Set();
	for (const run of runs.values()) {
		if (run.length < 3) continue;
		for (let i = 1; i < run.length - 1; i++) middles.add(run[i]);
	}
	return middles;
}

/**
 * Duplication (§29–30): exact fingerprint → 1.0; near-dup via line-set
 * overlap against the FIRST version of the same group (tool name+args);
 * middle versions of a repeated file read → 0.8 (§30, via state.readMiddles
 * from markRepeatedReadMiddles).
 * @param unit - current unit.
 * @param state - { byFingerprint: Set, byGroup: Map, readMiddles?: Set } accumulator (mutated).
 * @returns {score, note}.
 */
export function duplicationOf(unit, state) {
	let score = 0;
	let note = "";
	if (state.readMiddles?.has(unit.id)) {
		score = 0.8;
		note = "middle re-read (§30: keep first + newest)";
	}
	const fp = fingerprint(unit.text);
	if (state.byFingerprint.has(fp)) {
		return { score: 1.0, note: "exact duplicate" };
	}
	state.byFingerprint.add(fp);

	const key = unit.toolArgsKey ?? (unit.kind === "user" ? "user" : unit.kind);
	const group = state.byGroup.get(key);
	if (group && unit.kind !== "user" && unit.kind !== "assistant") {
		const overlap = lineSetOverlap(group.text, unit.text);
		const near = Math.min(1, overlap * 0.5);
		if (near > score) {
			score = near;
			note = note ? `${note}; near-dup of earlier ${key}` : `near-dup of earlier ${key} (${Math.round(overlap * 100)}% line overlap)`;
		}
	}
	state.byGroup.set(key, { text: unit.text, seq: unit.seqs[0] });
	return { score, note };
}

/**
 * Intrinsic importance from the §13 table, with content overrides for P1
 * signal-bearing units (decisions 0.98, benchmarks 0.85, root cause 0.82,
 * fixes 0.80 — matching the protection reasons).
 * @param unit - unit.
 * @param contentType - content type.
 * @param protection - {protection, reasons} from the gate (P0 short-circuits
 *                      in the scorer; here only P1 overrides apply).
 * @returns {intrinsic, contentType}.
 */
export function intrinsicOf(unit, contentType, protection) {
	let intrinsic = CONTENT_TYPES[contentType]?.intrinsic ?? 0.2;
	if (protection.protection === "P1") {
		for (const reason of protection.reasons) {
			if (/decision|rationale/.test(reason)) intrinsic = Math.max(intrinsic, 0.98);
			else if (/benchmark|experiment/.test(reason)) intrinsic = Math.max(intrinsic, 0.85);
			else if (/root cause/.test(reason)) intrinsic = Math.max(intrinsic, 0.82);
			else if (/key fix/.test(reason)) intrinsic = Math.max(intrinsic, 0.8);
			else if (/config/.test(reason)) intrinsic = Math.max(intrinsic, 0.75);
			else if (/checkpoint/.test(reason)) intrinsic = Math.max(intrinsic, 0.9);
		}
	}
	return { intrinsic, contentType };
}

/**
 * Full feature vector for one unit (§77 WeightFeatures + contentType).
 * @param unit - unit.
 * @param opts - { query, memory, now, contentType?, duplicationState? }.
 * @returns { features, contentType, notes: string[] }.
 */
export function extractFeatures(unit, opts = {}) {
	const contentType = opts.contentType ?? contentTypeOf(unit);
	const protection = opts.protection ?? { protection: "NORMAL", reasons: [] };
	const intrinsicInfo = intrinsicOf(unit, contentType, protection);
	const recency = recencyOf(unit, contentType, opts.now ?? Date.now());
	const relevance = relevanceOf(unit, opts.query ?? null);
	const dependency = dependencyOf(unit, opts.memory ?? null);
	const duplication = duplicationOf(unit, opts.duplicationState ?? { byFingerprint: new Set(), byGroup: new Map() });
	const sizePenalty = sizePenaltyOf(unit.tokens);
	const notes = [
		`intrinsic ${intrinsicInfo.intrinsic.toFixed(2)} (${contentType})`,
		`relevance ${relevance.score.toFixed(2)}${relevance.hits.length ? ` [${relevance.hits.join(", ")}]` : ""}`,
		`recency ${recency.R.toFixed(2)} (age ${recency.ageTurns} turns / ${Math.round(recency.ageMinutes)} min, τ=${Number.isFinite(recency.tauTurns) ? recency.tauTurns : "∞"})`,
		`dependency ${dependency.score.toFixed(2)}`,
		`reconstructibility ${(CONTENT_TYPES[contentType]?.x ?? 0.3).toFixed(2)}`,
		`duplication ${duplication.score.toFixed(2)}${duplication.note ? ` (${duplication.note})` : ""}`,
		`size penalty ${sizePenalty.toFixed(3)}`
	];
	return {
		contentType,
		features: {
			intrinsic: intrinsicInfo.intrinsic,
			taskRelevance: relevance.score,
			recency: recency.R,
			ageTurns: recency.ageTurns,
			ageMinutes: recency.ageMinutes,
			dependency: dependency.score,
			reconstructibility: CONTENT_TYPES[contentType]?.x ?? 0.3,
			duplication: duplication.score,
			sizePenalty
		},
		notes
	};
}
