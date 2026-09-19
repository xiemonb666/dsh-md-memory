/**
 * VAC-GC text primitives (plan §15–18, §26–29, §65).
 *
 * Pure, deterministic, LLM-free. Everything in this module operates on plain
 * strings and block arrays; nothing here touches a session, ctx, or the
 * network. These are the only lexical tools V1.0 is allowed to use (no
 * embeddings, no vector store): exact IDs / paths / symbols / errors /
 * versions plus word-segmented keywords.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

/**
 * Recursively extract all text plus tool-call metadata from content blocks.
 * Tolerates the two tool-result content shapes seen in the wild: a plain
 * string and a nested block array (pruned results carry `content: null`).
 * @param blocks - content blocks (or a string) to project.
 * @returns {text: string, toolCalls: Array<{name: string, arguments: string}>}.
 */
export function projectBlocks(blocks) {
	const text = [];
	const toolCalls = [];
	const walk = (content) => {
		if (content === null || content === undefined) return;
		if (typeof content === "string") {
			if (content.length > 0) text.push(content);
			return;
		}
		for (const block of content) {
			switch (block?.type) {
				case "text":
				case "reasoning":
					if (typeof block.text === "string" && block.text.length > 0) text.push(block.text);
					break;
				case "tool-call":
					toolCalls.push({ name: String(block.name ?? ""), arguments: String(block.arguments ?? "") });
					break;
				case "tool-result":
					walk(block.content);
					break;
				default:
					if (block !== null && typeof block === "object") {
						walk(block.content ?? block.text);
					}
			}
		}
	};
	walk(Array.isArray(blocks) ? blocks : [blocks]);
	return { text: text.join("\n"), toolCalls };
}

/**
 * Project one surface event into {role, text, toolCalls, source, sourceEventSeqs}.
 * Mirrors the per-node projection rule used by Session.deriveEventMessage and
 * the MML engine (user/message data IS the message; assistant and tool/result
 * nest it under `message`).
 * @param event - surface event.
 * @returns projected view, or null when the event carries no message.
 */
export function projectEvent(event) {
	if (!event || typeof event !== "object") return null;
	let message = null;
	switch (event.type) {
		case "user/message":
			message = event.data ?? null;
			break;
		case "assistant/message":
			message = event.data?.message ?? null;
			break;
		case "tool/result":
			message = event.data?.message ?? null;
			break;
		default:
			return null;
	}
	if (!message || !Array.isArray(message.content)) return null;
	const projected = projectBlocks(message.content);
	return {
		role: typeof message.role === "string" ? message.role : event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : "tool",
		text: projected.text,
		toolCalls: projected.toolCalls,
		source: message.source ?? event.source ?? null,
		sourceEventSeqs: event.sourceEventSeqs ?? message.sourceEventSeqs ?? null
	};
}

/**
 * Whether a surface event is a compaction checkpoint: a replacement user
 * message (carries provenance `sourceEventSeqs`) or one minted by the
 * compaction engine's `compactCheckpointSource` convention.
 * @param event - surface event to test.
 * @param projected - result of projectEvent(event), when already computed.
 * @returns true for checkpoint user messages.
 */
export function isCheckpointEvent(event, projected = null) {
	if (event?.type !== "user/message") return false;
	const view = projected ?? projectEvent(event);
	if (view?.sourceEventSeqs?.length > 0) return true;
	const source = view?.source ?? event?.data?.source ?? null;
	if (!source || typeof source !== "object") return false;
	return source.kind === "compaction" || source.kind === "plugin" && source.form === "compaction";
}

/**
 * Whether a user message looks like injected (non-user-authored) context:
 * plugin/system framing in its source marker. Genuinely typed user prompts
 * must NOT match this — they are the active task context.
 * @param event - surface user message.
 * @param projected - projectEvent(event) result.
 * @returns true for injected units.
 */
export function isInjectedEvent(event, projected = null) {
	if (event?.type !== "user/message") return false;
	const view = projected ?? projectEvent(event);
	const source = view?.source ?? event?.data?.source ?? null;
	if (source && typeof source === "object" && source.kind && source.kind !== "user") return true;
	const text = view?.text ?? "";
	// Fallback framing heuristics for injections that lack a source marker.
	return /^<(system-reminder|context|runtime-context)>/i.test(text.trim()) || /^current runtime context\b/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// Normalization / fingerprints (§29)
// ---------------------------------------------------------------------------

const VOLATILE_PATTERNS = [
	/\b\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, // ISO timestamps
	/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,                       // wall-clock times
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
	/\b0x[0-9a-f]+\b/gi,                                        // volatile pointers
	/\bat line \d+/gi,
	/\breq(?:uest)?[ _-]?id[:=] ?[^\s,]+/gi,
	/\btemp(orary)?[ _-]?(file|path)[:=] ?[^\s,]+/gi
];

/**
 * Normalize text for duplication hashing (§29): lowercase, strip volatile
 * timestamps/ids/pointers, collapse whitespace, drop trailing punctuation
 * noise. Two outputs of the same command differ only in these.
 * @param text - raw text.
 * @returns normalized string.
 */
export function normalizeForFingerprint(text) {
	let out = String(text ?? "").toLowerCase();
	for (const pattern of VOLATILE_PATTERNS) out = out.replace(pattern, " ");
	out = out.replace(/\s+/g, " ").trim();
	return out;
}

/**
 * SHA-1 fingerprint of normalized text (hex).
 * @param text - raw text.
 * @returns 16-hex-char prefix of the sha1 of normalizeForFingerprint(text).
 */
export function fingerprint(text) {
	return createHash("sha1").update(normalizeForFingerprint(text), "utf8").digest("hex").slice(0, 16);
}

/** Stable short key for a tool unit's (name, args) pair — the near-dup group. */
export function toolGroupKey(toolName, toolArgs) {
	const args = normalizeForFingerprint(toolArgs).slice(0, 200);
	const h = createHash("sha1").update(`${toolName}\x00${args}`, "utf8").digest("hex").slice(0, 8);
	return `${toolName}:${h}`;
}

/** Non-empty, trimmed lines of a text (line-set overlap units). */
export function textLines(text) {
	return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Line-set Jaccard overlap in [0,1]. Two identical outputs → 1.
 * @param a - first text.
 * @param b - second text.
 * @returns overlap of the two line sets.
 */
export function lineSetOverlap(a, b) {
	const la = new Set(textLines(a));
	const lb = new Set(textLines(b));
	if (la.size === 0 && lb.size === 0) return 1;
	if (la.size === 0 || lb.size === 0) return 0;
	let inter = 0;
	for (const line of la) if (lb.has(line)) inter += 1;
	const union = la.size + lb.size - inter;
	return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Term extraction (§15–18, §65)
// ---------------------------------------------------------------------------

/** Lazy Intl.Segmenter for zh-CN words; falls back to CJK bigrams. */
let zhSegmenter = null;
function segmentZhWords(text) {
	if (typeof Intl === "object" && Intl.Segmenter) {
		if (zhSegmenter === null) zhSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
		const words = [];
		for (const piece of zhSegmenter.segment(text)) {
			if (!piece.isWordLike) continue;
			const word = piece.segment;
			if (/[\u4e00-\u9fff]{2,}/.test(word)) words.push(word);
		}
		return words;
	}
	// Fallback: CJK bigrams.
	const words = [];
	for (const run of String(text).matchAll(/[\u4e00-\u9fff]{2,}/g)) {
		const chars = run[0];
		for (let i = 0; i + 1 < chars.length; i += 1) words.push(chars.slice(i, i + 2));
	}
	return words;
}

const RE_MEMORY_ID = /\b(?:REQ|DEC|TECH|BENCH|TASK|BLOCK|CMP|CONFLICT|STATE)-\d+\b/g;
const RE_PATH_WIN = /[A-Za-z]:\\[^\s"'`|<>]+/g;
const RE_PATH_UNIX = /(?:\/[\w.@-]+){2,}/g;
const RE_PATH_REL = /(?<![\w/])\.{1,2}\/[\w.@-]+(?:\/[\w.@-]+)*/g;
const RE_URL = /\bhttps?:\/\/[^\s"'`<>]+/g;
const RE_VERSION = /\bv?\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?\b/g;
const RE_SYMBOL = /\b[A-Za-z_$][A-Za-z0-9_$]{2,}(?:[.-][A-Za-z0-9_$]+)*\b/g;
// Error codes: SCREAMING_SNAKE (BUILD_FAILED) plus bare ALL-CAPS tokens of
// 5+ chars (ECONNRESET, ETIMEDOUT — real error codes with no underscores).
const RE_ERROR_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z][A-Z0-9]{4,}\b/g;
const RE_STATUS_CODE = /\b(?:4|5)\d{2}\b/g;
const RE_PORT = /(?::\d{2,5})\b/g;
const RE_IP = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const RE_MODEL_NAME = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g;
const RE_COMMAND = /`([^`\n]{2,160})`/g;

/** Stop words for the English keyword lane (length>=4 filter + this set). */
const EN_STOP = new Set([
	"with", "that", "this", "have", "from", "will", "your", "they", "them", "been", "were", "into", "when", "which", "their", "there", "would", "could", "should", "about", "after", "before", "while", "then", "than", "because", "where", "every", "some", "more", "most", "other", "such", "only", "also", "very", "just", "like", "over", "under", "here", "what", "how", "why", "who", "and", "the", "for", "not", "are", "was", "you", "our", "its", "out", "all", "can", "did", "get", "had", "has", "let", "may", "new", "now", "one", "see", "use", "used", "using", "via", "per", "etc", "www", "http", "https", "true", "false", "null", "undefined", "string", "number", "object", "return", "function", "const", "var", "import", "export", "async", "await", "type", "interface", "class", "error", "value", "values", "name", "names", "kind", "data", "info"
]);

/**
 * Extract the V1 lexical term set from one text (§15–18): exact memory IDs,
 * paths, URLs, symbols, error codes, versions, model names, ports/IPs,
 * commands, number+unit phrases, and word-segmented CJK/English keywords.
 * This is called for the active query AND per unit — the per-unit result is
 * what relevance matching intersects against the query terms.
 * @param text - text to analyze.
 * @returns term sets.
 */
export function extractTerms(text) {
	const src = String(text ?? "");
	const ids = uniqueMatches(src, RE_MEMORY_ID);
	const paths = [...uniqueMatches(src, RE_PATH_WIN), ...uniqueMatches(src, RE_PATH_UNIX), ...uniqueMatches(src, RE_PATH_REL)];
	const urls = uniqueMatches(src, RE_URL);
	const versions = uniqueMatches(src, RE_VERSION);
	const errors = [...uniqueMatches(src, RE_ERROR_CODE), ...uniqueMatches(src, RE_STATUS_CODE), ...uniqueMatches(src, RE_PORT)].map((m) => m.replace(/^:/, ""));
	const ports = uniqueMatches(src, RE_PORT).map((m) => m.slice(1));
	const ips = uniqueMatches(src, RE_IP);
	const commands = uniqueMatches(src, RE_COMMAND);
	// kebab compounds that carry a digit are model-name shaped (qwen38-agent,
	// gpt-4, llama-3-8b); plain English compounds (backward-compat) drop out
	const modelNames = uniqueMatches(src, RE_MODEL_NAME).filter((m) => /\d/.test(m));
	const numbers = uniqueMatches(src, /\d+(?:\.\d+)?\s?(?:ms|tokens?|chars?|lines?|files?|tests?|%|gb|mb|kb)\b/gi);

	// Symbols: ASCII identifiers — keep ones carrying identifier signal
	// (mixed case, digits, underscores, kebab) and drop English stop words.
	const symbols = uniqueMatches(src, RE_SYMBOL)
		.map((s) => s.replace(/^[.-]+|[.-]+$/, ""))
		.filter((s) => {
			if (s.length < 3 || EN_STOP.has(s.toLowerCase())) return false;
			if (/^\d+$/.test(s)) return false;
			return /[A-Z]/.test(s) || /\d/.test(s) || /[_-]/.test(s) || /^[a-z][a-z0-9]*$/.test(s) && s.length >= 5;
		});

	const keywordsZh = [...new Set(segmentZhWords(src))].filter((w) => w.length >= 2);
	const keywordsEn = uniqueMatches(src, /[a-zA-Z]{4,}/g)
		.filter((w) => !EN_STOP.has(w.toLowerCase()))
		.map((w) => w.toLowerCase());

	return {
		ids: new Set(ids),
		paths: new Set(paths),
		urls: new Set(urls),
		versions: new Set(versions),
		errors: new Set(errors),
		ports: new Set(ports),
		ips: new Set(ips),
		commands: new Set(commands),
		modelNames: new Set(modelNames),
		numbers: new Set(numbers),
		symbols: new Set(symbols),
		keywordsZh,
		keywordsEn: new Set(keywordsEn)
	};
}

function uniqueMatches(src, re) {
	const out = [];
	const seen = new Set();
	for (const match of String(src).matchAll(re)) {
		const value = match[0];
		const key = value.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(value);
		}
	}
	return out;
}

/**
 * Merge per-unit term sets into a compact comparable shape for relevance
 * scoring (§18): the scorer only needs set intersections, so everything is
 * lowercased sets.
 * @param terms - extractTerms() result.
 * @returns merged lowercase sets.
 */
export function termSet(terms) {
	const lower = (items) => new Set([...items].map((s) => String(s).toLowerCase()));
	return {
		ids: lower(terms.ids),
		paths: lower(terms.paths),
		urls: lower(terms.urls),
		versions: lower(terms.versions),
		errors: lower(terms.errors),
		models: new Set([...lower(terms.modelNames), ...lower(terms.versions)]),
		symbols: lower(terms.symbols),
		keywords: [...lower(terms.keywordsEn), ...terms.keywordsZh.map((w) => w.toLowerCase())]
	};
}

// ---------------------------------------------------------------------------
// Exact facts (§65)
// ---------------------------------------------------------------------------

/**
 * Deterministic exact-fact extractor (§65): numbers with units, paths, URLs,
 * versions, hashes, error/status codes, ports, IPs, memory entry IDs, and
 * backticked commands. These facts must survive compaction VERBATIM (no
 * number rewriting).
 * @param text - text to scan.
 * @returns Set of verbatim fact strings.
 */
export function extractExactFacts(text) {
	const src = String(text ?? "");
	const facts = new Set();
	const add = (re, group = 0) => {
		for (const match of src.matchAll(re)) facts.add(match[group] ?? match[0]);
	};
	add(RE_NUMBER_UNIT_GLOBAL);
	add(RE_PATH_WIN);
	add(RE_PATH_UNIX);
	add(RE_PATH_REL);
	add(RE_URL);
	add(RE_VERSION);
	add(/\b[0-9a-f]{8,40}\b/g); // hashes (>= 8 hex chars; shorter hex is too noisy)
	add(RE_ERROR_CODE);
	add(RE_STATUS_CODE);
	add(RE_PORT);
	add(RE_IP);
	add(RE_MEMORY_ID);
	add(RE_COMMAND, 1);
	add(/\bexit\s*code\s*:?\s*\d+/gi); // exit codes are compaction-critical facts
	return facts;
}
// Throughput forms (tok/s, tokens/s — the plan's own §65 example "52.31 tok/s")
// come FIRST so the unit is captured whole, not truncated at "tok".
const RE_NUMBER_UNIT_GLOBAL = /\d+(?:\.\d+)?\s?(?:ms|s|min|h|hours?|toks?\/s|tokens?|chars?|characters?|lines?|files?|tests?|cases?|gb|mb|kb|percent|%|k\b|m\b)/g;

/**
 * Whether a text reads like a greeting/acknowledgement (intrinsic 0.02 lane,
 * §13). Short, no imperative force, no facts.
 * @param text - user message text.
 * @returns true for greeting-like messages.
 */
export function looksLikeGreeting(text) {
	const src = String(text ?? "").trim();
	if (src.length > 60) return false;
	if (/\d|`|\/|\\/.test(src)) return false;
	return /^(你好|您好|hi|hello|hey|ok|okay|好的|嗯|嗯嗯|收到|明白|谢谢|thx|thanks|thank you|继续|继续吧|go|开始|开始吧|好的。|好|是|对|yes|no|嗯，|可以|行|done|完成|完成。|好的，继续|请继续|go ahead|proceed|continue|continue\.|ok\.?)/i.test(src);
}
