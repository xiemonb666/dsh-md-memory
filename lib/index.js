/**
 * dsh-md-memory — Markdown Memory Ledger for DeepSeek Harness.
 *
 * Host-side plugin. Replaces the base compaction engine
 * (@deepseek-ai/dsh-compaction-basic) with MarkdownMemoryCompactionEngine,
 * which adds a file-based project memory ledger at <projectRoot>/.dsh-memory:
 *
 *   INDEX.md     engine-owned memory router (rebuilt deterministically)
 *   PROJECT.md   requirements & scope      [REQ-xxx]
 *   STATE.md     current mutable state     [STATE-CURRENT]
 *   DECISIONS.md decisions with rationale  [DEC-xxx]
 *   TECH.md      technical facts/rules     [TECH-xxx]
 *   HISTORY.md   append-only sync log
 *   CONFLICTS.md integrity conflicts       [CONFLICT-xxx]
 *
 * The ledger syncs (a) every N turns (default 20) and (b) right before every
 * compaction, through a Memory-Guardian LLM call that maintains the ledger
 * files under strict integrity rules (never silently delete, never silently
 * resolve conflicts; atomic writes). The compaction summary call itself stays
 * byte-identical to the base engine — the ledger rules reach the summarizer
 * through the always-injected project memory system-prompt section, which is
 * replayed into the summarization request (the "bridge").
 *
 * Model-facing tools: memory_search / memory_read.
 * Web UI surface: host RPC channel /dsh-md-memory (status/read/search/sync)
 * consumed by lib/client.js.
 *
 * Plug-and-play (DEC-018): this plugin needs ZERO host-file modifications.
 * The two behaviors that used to live in host patches are implemented
 * natively here:
 *   - Calibrated pressure pre-check: a CJK/code-density-aware estimator
 *     runs inside the `compactIfNeeded` override so CJK-heavy, code-heavy
 *     sessions trip compaction before the provider's hard 400 line (the
 *     host's flat 4-chars/token meter under-prices them ~2x).
 *   - max-tokens auto-continuation: a `turn/end` session-event listener
 *     queues a visible "继续" user message via the public `agent.followup`
 *     (up to three consecutive, reset by any other end reason).
 * Boot-time preset provisioning derives the standard-mml / minimal-mml
 * presets from the host's own builtin presets (zero version drift).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { BlockAssembler, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { planVacGc, resolveVacGcConfig, VACGC_DEFAULTS } from "./vacgc/index.js";
import { planOperations, applyOperations } from "./ledger-ops.js";
import { getLedgerIndex } from "./vacgc/memory-index.js";
import { appendVacGcHistory, HISTORY_CAP } from "./vacgc/history.js";
import { planNodePrunes, landNodePrunes, pickShadowPrice } from "./vacgc/apply.js";
import { MIN_MANUAL_COMPACT_SPAN_TOKENS, spanTokens, shouldSkipManualCompact } from "./vacgc/manual-compact.js";
import { buildContextUnits } from "./vacgc/units.js";
import { runCompaction } from "./vacgc/executor.js";
import {
	DEFAULT_CONTINUATION,
	budgetNeedsCompaction,
	budgetForRoute,
	looksLikeContextOverflow,
	resetRoute,
	routeSettings,
	safeOutputBudget,
	settingsDescriptor,
	settingsValue,
	updateRouteSettings
} from "./settings.js";

//#region configuration

/** MML configuration keys. They must carry in-code defaults: profile patches
 * for node id `compaction-basic` replace the node config wholesale, so keys
 * only present in this package's patch layer would be lost. */
const MML_CONFIG_KEYS = Object.freeze([
	"enabled",
	"dirName",
	"syncEveryNTurns",
	"syncBeforeCompaction",
	"gitTracked",
	"injectAlways",
	"syncProvider",
	"syncModel",
	"syncMaxTokens"
]);

const MML_DEFAULTS = Object.freeze({
	enabled: true,
	dirName: ".dsh-memory",
	syncEveryNTurns: 20,
	syncBeforeCompaction: true,
	gitTracked: false,
	injectAlways: true,
	syncProvider: "",
	syncModel: "",
	syncMaxTokens: 16384
});

/**
 * Resolve the exact Session requested by the Web UI.
 *
 * DSH keeps only active sessions in ctx.sessions. After a Desktop restart the
 * selected conversation can be visible in the browser before its host Agent is
 * resumed, so an exact id may be absent from the live store. Falling back to
 * an unrelated live session in that case leaks the wrong project/status into
 * the panel. Prefer an exact live hit; otherwise use sessionQuery's validated
 * cold observation and rebuild a detached Session for the duration of the RPC.
 *
 * The no-id fallback remains for older clients that predate session-aware view
 * injection. It may choose only from the live store because those clients do
 * not provide a durable identity to query.
 */
async function resolveRpcSession(ctx, payload) {
	const store = ctx.sessions;
	const id = typeof payload?.sessionId === "string" && payload.sessionId.length > 0 ? payload.sessionId : null;
	if (id !== null) {
		const live = store.get?.(id);
		if (live !== undefined) return { session: live, source: "live", dispose() {} };

		const query = ctx.get?.("sessionQuery");
		if (typeof query?.observeSession !== "function") {
			throw new Error(`session "${id}" is not live and cold session queries are unavailable`);
		}
		const observation = await query.observeSession(id, { projectionMode: "none" });
		try {
			const session = Session.create(id, observation.events, observation.header, observation.inheritedEventCount);
			return {
				session,
				source: "cold",
				dispose() { observation[Symbol.dispose]?.(); }
			};
		} catch (error) {
			observation[Symbol.dispose]?.();
			throw error;
		}
	}

	const values = typeof store.list === "function"
		? [...store.list()]
		: store?.store?.values ? [...store.store.values()] : [];
	if (values.length === 0) throw new Error("no session available");
	const withCwd = values.filter((session) => typeof session.header?.cwd === "string" && session.header.cwd.length > 0);
	const pool = withCwd.length > 0 ? withCwd : values;
	return { session: pool[pool.length - 1], source: "legacy-live", dispose() {} };
}

/** VAC-GC (Value-Aware Context GC) configuration keys — same contract as
 * MML_CONFIG_KEYS: in-code defaults (VACGC_DEFAULTS in ./vacgc/index.js)
 * apply in the constructor, because profile patches replace node config
 * wholesale. The default is `vacgcMode: "shadow"` (observe + report, never
 * mutate — V1.0's safe posture); the provisioned MML presets set
 * `vacgcMode: "prune"` to enable the Phase 2 TRASH fresh-prune execution. */
const VACGC_CONFIG_KEYS = Object.freeze([
	"vacgcMode",
	"vacgcSemantic",
	"vacgcPressureSoftGc",
	"vacgcPressureColdCompact",
	"vacgcPressureWarmCompact",
	"vacgcPressureAggressive",
	"vacgcPressureEmergency",
	"vacgcPressureSafetyRatio",
	"vacgcPressureInjectionReserveRatio",
	"vacgcRecentRatio",
	"vacgcRecentMinTokens",
	"vacgcRecentMaxTokens",
	"vacgcReconstructibilityPenalty",
	"vacgcDuplicationPenalty",
	"vacgcHotEnter",
	"vacgcHotLeave",
	"vacgcWarmEnter",
	"vacgcWarmLeave",
	"vacgcMinReclaimRatio",
	"vacgcMinReclaimTokens",
	"vacgcMaxReclaimTokens",
	"vacgcSummaryMaxTokens",
	"vacgcRetryOnCoverageFailure",
	"vacgcMemoryEnabled",
	"vacgcRequireSyncForP1",
	"vacgcUiEnabled",
	"vacgcUiShowPerRequest",
	"vacgcMaxUnitsInPlan"
]);

/** Ledger files the Guardian may (re)write. HISTORY.md is engine-managed. */
const LEDGER_FILES = Object.freeze([
	"INDEX.md",
	"PROJECT.md",
	"STATE.md",
	"DECISIONS.md",
	"TECH.md",
	"HISTORY.md",
	"CONFLICTS.md"
]);

/** Files the Guardian LLM may update on a sync (INDEX/HISTORY are engine-owned). */
const GUARDIAN_FILES = Object.freeze(["PROJECT.md", "STATE.md", "DECISIONS.md", "TECH.md", "CONFLICTS.md"]);

const FILE_TEMPLATES = Object.freeze({
	"INDEX.md": [
		"# INDEX — Memory Router",
		"",
		"> Auto-generated by dsh-md-memory. Do not edit by hand — the routing table rebuilds on every sync.",
		""
	].join("\n"),
	"PROJECT.md": [
		"# PROJECT — Requirements & Scope",
		"",
		"<!-- Entries: ## [REQ-NNN] Title, then bullets. The Guardian maintains this file. -->",
		""
	].join("\n"),
	"STATE.md": [
		"# STATE — Current State",
		"",
		"## [STATE-CURRENT] (no sync yet)",
		""
	].join("\n"),
	"DECISIONS.md": [
		"# DECISIONS",
		"",
		"<!-- Entries: ## [DEC-NNN] Title, then Decision / Reason / Alternatives / Rejected Because / Impact bullets. -->",
		""
	].join("\n"),
	"TECH.md": [
		"# TECH — Technical Facts & Conventions",
		"",
		"<!-- Entries: ## [TECH-NNN] Title, then bullet facts. -->",
		""
	].join("\n"),
	"HISTORY.md": [
		"# HISTORY — Sync Log",
		"",
		"<!-- Append-only: one line per sync. Managed by dsh-md-memory. -->",
		""
	].join("\n"),
	"CONFLICTS.md": [
		"# CONFLICTS — Integrity Conflicts",
		"",
		"<!-- Entries: ## [CONFLICT-NNN] Title, then type / sides / Action. Never resolved silently. -->",
		""
	].join("\n")
});

/** Cap for each ledger file rendered into the sync prompt (chars). */
const LEDGER_CONTEXT_FILE_CAP = 24000;
/** Cap for the turn-delta transcript rendered into the sync prompt (chars). */
const DELTA_CAP = 160000;
/** Skip the compaction-time sync when a turn sync already ran within this window (ms). */
const SYNC_DEDUP_WINDOW_MS = 120000;

//#endregion
//#region helpers

function errMsg(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Atomic write: tmp file in the same directory, then rename. */
function atomicWrite(file, content) {
	const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

/** Parse `## [ID] Title` entry sections out of a ledger file. */
function parseEntries(content) {
	const lines = String(content ?? "").split("\n");
	const raws = [];
	let current = null;
	for (let i = 0; i < lines.length; i += 1) {
		const heading = lines[i].match(/^##\s+\[([A-Z]+-\d+|STATE-CURRENT)\]\s*(.*)$/);
		if (heading) {
			if (current) {
				current.end = i; // the previous entry stops HERE — otherwise its
				// raw would swallow the next entry's bullets (a stale `- source:`
				// line would then be attributed to the wrong entry)
				raws.push(current);
			}
			current = { id: heading[1], title: heading[2].trim(), start: i, end: lines.length, confidence: null, status: null };
			continue;
		}
		if (current) {
			if (/^##\s/.test(lines[i])) {
				current.end = i;
				raws.push(current);
				current = null;
				continue;
			}
			const conf = lines[i].match(/^- confidence:\s*([0-9.]+)\s*$/);
			if (conf) current.confidence = Number(conf[1]);
			const status = lines[i].match(/^- status:\s*([A-Za-z]+)\s*$/);
			if (status) current.status = status[1];
		}
	}
	if (current) raws.push(current);
	return raws.map((entry) => ({ ...entry, raw: lines.slice(entry.start, entry.end).join("\n").trimEnd() + "\n" }));
}

/** Extract one `## [ID]` section (or null). */
function extractSection(content, id) {
	const lines = String(content ?? "").split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const m = lines[i].match(/^##\s+\[([^\]]+)\]/);
		if (!m || m[1] !== id) continue;
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j += 1) {
			if (/^##\s/.test(lines[j])) {
				end = j;
				break;
			}
		}
		return lines.slice(i, end).join("\n").trimEnd() + "\n";
	}
	return null;
}

/** Nearest preceding entry id for a matched line (null when outside entries). */
function nearestEntryId(lines, index) {
	for (let i = index; i >= 0; i -= 1) {
		const m = lines[i].match(/^##\s+\[([^\]]+)\]/);
		if (m) return m[1];
		if (/^#\s/.test(lines[i])) return null;
	}
	return null;
}

/**
 * Pull the first balanced JSON object out of raw model output.
 * Returns null when the output is not usable.
 */
function parseSyncJson(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/** Project a derived message to compact text for the turn-delta transcript. */
function projectMessageText(message) {
	if (!message || !Array.isArray(message.content)) return "";
	const parts = [];
	for (const block of message.content) {
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	const text = parts.join("\n").trim();
	if (!text) return "";
	return `[${message.role ?? "message"}]\n${text}`;
}

/** Render the five Guardian-managed files into the sync prompt context. */
function renderLedgerContext(files) {
	const sections = GUARDIAN_FILES.map((name) => {
		let content = files[name] ?? FILE_TEMPLATES[name];
		if (content.length > LEDGER_CONTEXT_FILE_CAP) content = `${content.slice(0, LEDGER_CONTEXT_FILE_CAP)}\n…(truncated)`;
		return `## [${name}]\n${content}`;
	});
	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// P1-④ ADAPTIVE LAZY INJECTION — rule-first C0–C5 (no LLM classifier in v1).
// The old design injected ~6K chars of router + STATE + last-10 decisions on
// EVERY prompt — "一边往 context 里灌水，一边努力排水". Now the pending user
// message is classified against the ledger vocabulary and ONLY the class
// budget is injected. C0/C1 spend zero durable memory; the ledger remains
// reachable through memory_search and the 项目记忆 UI (sparsity, not loss).
// ---------------------------------------------------------------------------

/** Per-class injection budget in ESTIMATED tokens (the user's contract). */
const MEMORY_CLASS_BUDGETS = Object.freeze({ C0: 0, C1: 0, C2: 768, C3: 2048, C4: 4096, C5: 8192 });

/** Cheap token estimate: 1 token per CJK char, ~4 ASCII chars per token. */
function estimateTokens(text) {
	const s = String(text ?? "");
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk += 1;
		else other += 1;
	}
	return cjk + Math.ceil(other / 4);
}

const TERM_STOPWORDS = new Set([
	"the", "and", "for", "are", "was", "were", "with", "from", "that", "this", "have", "has", "had", "will", "would", "can", "could", "should", "not", "but", "all", "any", "each", "its", "into", "over", "under", "about", "after", "before", "between", "during", "without", "within", "then", "than", "them", "they", "their", "there", "these", "those", "very", "just", "also", "only", "both", "some", "such", "more", "most", "other", "others", "new", "old", "one", "two", "see", "says", "said", "via", "per", "etc", "use", "used", "using", "make", "made", "makes", "way", "ways", "part", "parts", "case", "cases", "entry", "entries", "file", "files", "test", "tests", "code", "data", "value", "values", "config", "default", "defaults", "current", "state", "note", "notes", "line", "lines", "text", "word", "words",
	"的", "了", "在", "是", "我", "你", "他", "她", "它", "我们", "你们", "他们", "这个", "那个", "什么", "怎么", "可以", "可能", "应该", "需要", "一个", "以及", "或者", "如果", "但是", "而且", "因为", "所以", "然后", "之后", "之前", "现在", "目前", "最近", "开始", "完成", "结束", "进行", "使用", "还有", "就是", "也是", "已经", "还是"
]);

/** Distinctive terms of a ledger text: ASCII tokens (≥3) + CJK runs/4-grams. */
function extractLedgerTerms(text) {
	const low = String(text ?? "").toLowerCase();
	const terms = new Set();
	for (const m of low.matchAll(/[a-z0-9][a-z0-9+#._-]{2,}/g)) {
		const t = m[0].replace(/^[.+_-]+|[.+_-]+$/g, "");
		if (t.length >= 3 && !TERM_STOPWORDS.has(t)) terms.add(t);
	}
	for (const m of low.matchAll(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g)) {
		const run = m[0];
		if (run.length <= 8) terms.add(run);
		else for (let i = 0; i + 4 <= run.length; i += 1) terms.add(run.slice(i, i + 4));
	}
	return terms;
}

/** Vocabulary the classifier matches against: ACTIVE-entry terms + all ids. */
function ledgerVocabulary(files) {
	const ids = new Set();
	const terms = new Set();
	for (const name of GUARDIAN_FILES) {
		for (const m of String(files[name] ?? "").matchAll(/\b([A-Z]{2,10}-\d{3})\b/g)) ids.add(m[1]);
	}
	for (const name of GUARDIAN_FILES) {
		for (const e of parseEntries(files[name] ?? "")) {
			if (e.id === "STATE-CURRENT") continue;
			if ((e.status ?? "ACTIVE") !== "ACTIVE") continue;
			for (const t of extractLedgerTerms(`${e.title}\n${e.raw}`)) terms.add(t);
		}
	}
	return { ids, terms };
}

const MEMORY_INTENT = {
	// C5 — an explicit full-context request (handoff, review, restart)
	full: /tell\s+me\s+(everything|the\s+whole|all)|full\s+(state|context|picture)|整体(回顾|状态|情况)|项目(全貌|总览|全部)|handoff|hand-off|交接|重启(后)?(继续|状态)|after\s+(the\s+)?(restart|compaction)|summarize\s+(the\s+)?(project|ledger)|给我(项目|全部|整体)/i,
	// Explicit project scope signals need stronger treatment than a generic
	// project mention. They also trigger an early sync on turn end so a
	// first-turn goal is not lost in a short-lived session.
	projectGoal: /(?:项目|project|本(?:项|次)工作|任务)(?:的)?\s*(?:目标|目的|需求|要求|范围|要做什么|要完成什么)|(?:目标|目的|需求|要求|范围)\s*[:：]|(?:目标是|任务是|必须(?:支持|实现|保留|完成)|需要(?:支持|实现|完成)|要实现|要完成|we\s+need\s+to|the\s+goal\s+is|requirements?\s*[:：]|scope\s*[:：])/i,
	projectWork: /(?:(?:项目|project|仓库|repo|代码库|worktree).*(?:优化|修复|实现|继续|修改|检查|评估|开发|部署|测试|完成|维护|改进|fix|implement|review|debug|test|continue)|(?:优化|修复|实现|继续|修改|检查|评估|开发|部署|测试|完成|维护|改进|fix|implement|review|debug|test|continue).*(?:项目|project|仓库|repo|代码库|worktree))/i,
	// C4 — planning / deciding / redesigning about THIS project
	decide: /decide|decided|decision|plan|design|architect|refactor|rewrite|决定|决策|改成|换成|切换|替换|弃用|选用|重写|迁移|migrat|重构|方案|架构|选型|规划|tradeoff|trade-off|取舍/i,
	// C2 — status checks
	status: /where\s+(are|is)\s+(we|it|this)|current\s+(state|status)|status\s+update|现在(什么)?(状态|进展|进度)|当前(?:项目|工程|仓库)?(状态|进展|进度)|(?:项目|工程|仓库).*(状态|进展|进度)|什么(进展|进度)/i,
	question: /(^|[\s?？])\s*(what|why|how|which|when|where)\b|怎么|为什么|如何|哪个|何时|是否|能不能|可不可以|是什么|有哪些/i,
	chat: /^(hi|hiya|hello|hey|yo|thanks|thank\s+you|thank\s+u|thx|ty|谢谢|多谢|辛苦|好的|好滴|嗯+|ok+|okay|可以|没问题|收到|明白|👍|silly|joke|笑话|无聊)\.?[!！。.]*$/i
};

/**
 * Classify the pending user message against the ledger. Rule-first cascade
 * (first match wins): C5 > C4 > C3 > C2 > C1 > C0. Pure — no host, no LLM.
 * @returns {{cls: string, termHits: string[], idCites: string[]}}
 */
function classifyMemoryNeed(message, files) {
	const low = String(message ?? "").toLowerCase();
	const { ids, terms } = ledgerVocabulary(files);
	const termHits = [...terms].filter((t) => low.includes(t));
	const idCites = [...ids].filter((id) => new RegExp(`\\b${id.toLowerCase()}\\b`).test(low));
	const out = { termHits, idCites };
	// ≥2 cited ids = a comparison/review across entries → full view
	// (a single id citation is a targeted question — C3).
	if (MEMORY_INTENT.full.test(low) || idCites.length >= 2 || termHits.length >= 6) return { cls: "C5", ...out };
	if (MEMORY_INTENT.projectGoal.test(low)) {
		// A question asks for the stored project scope; a declarative goal is
		// planning context and gets the wider C4 view.
		return { cls: MEMORY_INTENT.question.test(low) ? "C3" : "C4", ...out };
	}
	if (MEMORY_INTENT.decide.test(low) && (termHits.length >= 1 || idCites.length >= 1 || /project|项目|ledger|账本/.test(low))) return { cls: "C4", ...out };
	// Status intent ranks BEFORE the term-based C3: "where are we with the
	// sweep?" asks for the CURRENT STATE, not for related entries (C2 ≈ STATE).
	if (MEMORY_INTENT.status.test(low)) return { cls: "C2", ...out };
	if (MEMORY_INTENT.projectWork.test(low)) return { cls: "C4", ...out };
	if (termHits.length >= 2 || idCites.length >= 1 || (termHits.length >= 1 && MEMORY_INTENT.question.test(low))) return { cls: "C3", ...out };
	if (termHits.length === 1 && low.length <= 80) return { cls: "C2", ...out };
	if (termHits.length === 0 && idCites.length === 0 && MEMORY_INTENT.chat.test(low.trim())) return { cls: "C1", ...out };
	return { cls: "C0", ...out };
}

/** ACTIVE ledger entries related to the message, by hit count (desc). */
function matchedEntries(files, message, kind) {
	const low = String(message ?? "").toLowerCase();
	const kindFile = { DEC: "DECISIONS.md", TECH: "TECH.md", REQ: "PROJECT.md" }[kind];
	const names = kindFile ? [kindFile] : ["DECISIONS.md", "TECH.md", "PROJECT.md", "CONFLICTS.md"];
	const out = [];
	for (const name of names) {
		for (const e of parseEntries(files[name] ?? "")) {
			if (e.id === "STATE-CURRENT" || (e.status ?? "ACTIVE") !== "ACTIVE") continue;
			const eTerms = extractLedgerTerms(`${e.title}\n${e.raw}`);
			const hits = [...eTerms].filter((t) => low.includes(t)).length;
			if (hits > 0) out.push({ ...e, hits });
		}
	}
	return out.sort((a, b) => b.hits - a.hits);
}

/**
 * Render the budgeted memory section for a class. Entries are all-or-nothing
 * (never cut mid-entry — the agent must not see a half-decision); the one
 * exception is STATE-CURRENT, which may be cut at a LINE boundary when it
 * alone exceeds the budget.
 * @param {string} message - the pending user message
 * @param {string} [clsOverride] - skip classification (tests / explicit)
 */
function renderLazyContext(files, message, clsOverride) {
	const cls = clsOverride ?? classifyMemoryNeed(message, files).cls;
	const budget = MEMORY_CLASS_BUDGETS[cls];
	if (!budget) return "";
	const state = (extractSection(files["STATE.md"], "STATE-CURRENT") ?? "").trim() || "(unknown)";
	const active = (name) => parseEntries(files[name] ?? "").filter((e) => e.id !== "STATE-CURRENT" && (e.status ?? "ACTIVE") === "ACTIVE");
	const messageLow = String(message ?? "").toLowerCase();
	const projectContext = MEMORY_INTENT.projectGoal.test(messageLow) || MEMORY_INTENT.projectWork.test(messageLow);
	const router = (files["INDEX.md"] ?? "").trim();
	const out = [];
	const used = () => estimateTokens(out.join("\n\n"));
	const fits = (block) => used() + estimateTokens(block) <= budget;
	const add = (heading, body) => {
		const s = String(body ?? "").trim();
		if (!s) return;
		const block = heading ? `### ${heading}\n${s}` : s;
		if (fits(block)) out.push(block);
	};
	const addStateTruncated = () => {
		const s = state;
		const MARKER = "\n…(STATE truncated to the C-class budget — full text in .dsh-memory/STATE.md)";
		const full = `### Current state\n${s}`;
		if (fits(full)) {
			out.push(full);
			return;
		}
		// Accumulate whole lines, reserving room for the marker from the
		// start — otherwise the final marker push could exceed the budget.
		let acc = "### Current state\n";
		for (const line of s.split("\n")) {
			const block = `${acc}${line}\n`;
			if (estimateTokens((out.length ? out.join("\n\n") + "\n\n" : "") + block + MARKER) > budget) break;
			acc = block;
		}
		const block = `${acc.trimEnd()}${MARKER}`;
		if (estimateTokens((out.length ? out.join("\n\n") + "\n\n" : "") + block) <= budget) out.push(block);
	};
	add("", `## Project Memory (Markdown Memory Ledger, class ${cls})\nPersistent memory: \`.dsh-memory/\` — use memory_search for anything beyond this view.`);
	if (cls === "C2") {
		addStateTruncated();
	} else if (cls === "C3") {
		addStateTruncated();
		const related = projectContext ? active("PROJECT.md") : matchedEntries(files, message, null);
		for (const e of related.slice(0, 4)) add(`${e.id} — ${e.title}`, e.raw);
	} else if (cls === "C4") {
		add("Router", router || "(empty ledger)");
		addStateTruncated();
		for (const e of (projectContext ? active("PROJECT.md") : matchedEntries(files, message, "REQ")).slice(0, 4)) add(`${e.id} — ${e.title}`, e.raw);
		for (const e of matchedEntries(files, message, "DEC").slice(0, 4)) add(`${e.id} — ${e.title}`, e.raw);
		for (const e of matchedEntries(files, message, "TECH").slice(0, 3)) add(`${e.id} — ${e.title}`, e.raw);
	} else {
		add("Router", router || "(empty ledger)");
		addStateTruncated();
		for (const e of active("PROJECT.md").slice(-8)) add(`${e.id} — ${e.title}`, e.raw);
		for (const e of active("DECISIONS.md").slice(-12)) add(`${e.id} — ${e.title}`, e.raw);
		for (const e of active("TECH.md").slice(-8)) add(`${e.id} — ${e.title}`, e.raw);
		const conf = active("CONFLICTS.md");
		if (conf.length) add("Open conflicts (need user confirmation)", conf.map((e) => `- [${e.id}] ${e.title}`).join("\n"));
	}
	return out.join("\n\n");
}

/** The latest user message in the session log ("" when none). */
function lastUserText(session) {
	const log = session?.log;
	if (!Array.isArray(log)) return "";
	for (let i = log.length - 1; i >= 0; i -= 1) {
		const ev = log[i];
		if (ev?.type !== "user/message") continue;
		const text = (Array.isArray(ev.data?.content) ? ev.data.content : [])
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

const GUARDIAN_INSTRUCTION = [
	"You are the Memory Guardian of a long-running autonomous coding agent.",
	"Your responsibility is maintaining engineering continuity. You are NOT summarizing the conversation — you are maintaining the project's persistent Markdown memory ledger.",
	"",
	"The ledger is the set of Markdown files shown below. Durable project facts — goals, requirements, architecture, decisions, technical constraints, failures, current state — live THERE, not in the conversation. The conversation is raw \"recent\" context; the ledger is long-term memory.",
	"",
	"## How you write to the ledger: operations",
	"You do NOT write ledger files. You propose OPERATIONS; the host validates each one against the conversation, assigns entry ids, and applies them deterministically. You never mint ids — you may only TARGET the existing ids listed in the current ledger section. HISTORY.md and INDEX.md are engine-managed and cannot be targeted.",
	"",
	"## Operations",
	'{"op":"ADD","kind":"REQ|DEC|TECH","title":"short","confidence":0.9,"body":"fact lines, one per line","source_ref":"E7","source_quote":"verbatim ≤160 chars"}',
	"  Mint a new durable fact. kind maps to the file: REQ→PROJECT.md, DEC→DECISIONS.md, TECH→TECH.md.",
	'{"op":"UPDATE_STATE","title":"short status line","body":"complete new STATE-CURRENT text"}',
	"  Rewrite the working-state section (NOT a durable fact; evidence optional).",
	'{"op":"AMEND","target_id":"DEC-004","body":"COMPLETE new fact lines for the entry","source_ref":"E7","source_quote":"..."}',
	"  Update an existing ACTIVE entry IN PLACE (same id, same status). body = the entry's complete new fact section: keep every still-true line, add or correct the rest.",
	'{"op":"SUPERSEDE","target_id":"DEC-004","replacement":{"kind":"DEC","title":"...","confidence":0.95,"body":"...","source_ref":"E11","source_quote":"..."}}',
	"  The fact itself changed: the old entry becomes SUPERSEDED; the host mints a NEW id for the replacement.",
	'{"op":"CONFLICT","topic":"...","body":"both sides of the disagreement, one per line","source_ref":"E#","source_quote":"..."}',
	"  Old ledger fact and conversation disagree and the USER must decide. The host mints CONFLICT-NNN. Never resolve a conflict yourself.",
	'{"op":"RESOLVE_CONFLICT","target_id":"CONFLICT-001","resolution":"...","source_ref":"E#","source_quote":"..."}',
	"  A previously reported conflict was settled (user decided / decisive new evidence).",
	'{"op":"NOOP","reason":"..."}',
	"  Nothing durable changed this sync.",
	"",
	"## AMEND vs SUPERSEDE (do not mint a replacement for a clarification)",
	"- DEC-018 \"Use FP8 KV\" + the conversation adds \"because quality is more stable at 192K\" → AMEND DEC-018 (same decision, added rationale).",
	"- \"Use FP8 KV\" → \"switch to BF16 KV\" → SUPERSEDE (the fact changed; the new entry carries it).",
	"  Wrongly SUPERSEDEing a clarification causes version explosion; wrongly AMENDing a real change corrupts the old decision.",
	"",
	"## Evidence rules (host-enforced — a failed check rejects THAT operation only)",
	"- ADD, AMEND, SUPERSEDE.replacement, CONFLICT and RESOLVE_CONFLICT REQUIRE evidence:",
	"  - source_quote: an EXACT verbatim quote (max 160 chars — no paraphrase, no ellipses) from the conversation.",
	"  - source_ref: the [E#] handle of the message the quote comes from. Handles are printed before the conversation text; they are ephemeral and NOT log numbers. If the conversation section carries NO [E#] handles (structured transcript), omit source_ref and just quote the transcript.",
	"- The host verifies the handle exists AND the quote belongs to that message, then binds the entry to the original message (hard-protected while the entry is ACTIVE). If no message supports the fact, do NOT emit the operation — omitting is always better than a bad bind.",
	"- Exact values (numbers, numbers with units, versions, paths, model names, commands, ports, error codes) must appear VERBATIM in the cited message. The host rejects value changes that the evidence does not contain — quote the message that actually carries the new value.",
	"",
	"## transactionGroup (atomic groups)",
	"Related operations that must land together share the SAME \"transactionGroup\" string (e.g. \"TX-1\"). If any member of a group is rejected, the whole group is rejected; independent operations commit on their own.",
	"",
	"## Judgment rules",
	"- Extract durable project facts only: goals, requirements, architecture, decisions, technical constraints, measured results, current state. Discard small talk, raw logs, chain-of-thought, process noise.",
	"- Score each candidate fact (importance + future impact + repeat prevention, 0-10); keep >= 5.",
	"- Prefer the FEWEST operations. Nothing durable changed → exactly one NOOP. Never emit an operation for an unchanged fact; never re-ADD an entry that already exists (AMEND or SUPERSEDE it instead).",
	"- Project-goal bootstrap: when the conversation contains a stable project goal, requirement, scope, or explicit must-have and PROJECT.md has no ACTIVE REQ that covers it, emit an ADD with kind REQ in addition to any UPDATE_STATE. Use the user's exact source_quote; do not reduce a durable goal to STATE only. If there is no verifiable quote, do not invent a requirement.",
	"- Keep entries compact: short titles, a few fact lines. DECISIONS bodies use lines like: Decision: … / Reason: … / Alternatives: … / Impact: ….",
	"",
	"## Current ledger (existing entries — the only valid target_ids)",
	"",
	"## Output contract",
	'Respond with EXACTLY one JSON object and nothing else — no markdown fences, no commentary. Escape newlines as \\n inside JSON strings.',
	'{"operations": [ <operation>, ... ], "history": "one line: what was written or changed (or \\"(none)\\")"}'
].join("\n");

//#endregion
//#region calibrated pressure (DEC-018)

/**
 * Calibrated density constants — ported verbatim from the 09-03 calibration
 * against vLLM qwen38-agent server usage (session c2cf9454: 168,111 code
 * chars carried ~93K of a 143,346-token prompt): the flat 4-chars/token
 * heuristic under-prices CJK text and dense code/JSON by ~2x, which kept
 * pressure compaction below its trigger while the server crossed the 400
 * line. These constants keep the plugin's decision math equal to what the
 * server actually charges.
 */
const CAL_CHARS_PER_TOKEN = 4;
const CAL_CODE_CHARS_PER_TOKEN = 1.8;
/** CJK chars tokenize ~1.5 chars/token vs ~4 for latin; price at 8/3 weight. */
const CAL_CJK_WEIGHT = 8 / 3;
/** Per-block structural overhead for JSON framing and type tags. */
const CAL_BLOCK_OVERHEAD = 4;

/** Count one text unit per char, weighting CJK chars at CAL_CJK_WEIGHT. */
function calTextUnits(text) {
	let units = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		units += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? CAL_CJK_WEIGHT : 1;
	}
	return units;
}

/**
 * Price content blocks recursively under the calibrated density heuristic.
 * `code` prices text at the dense code/JSON rate (tool-call arguments and
 * everything inside a tool-result).
 * @param blocks - content blocks to price without mutation.
 * @param code - dense (code/JSON) pricing flag.
 * @returns calibrated tokens including per-block structural overhead.
 */
function calEstimateContent(blocks, code) {
	let tokens = 0;
	for (const block of blocks ?? []) switch (block?.type) {
		case "text":
		case "reasoning":
			tokens += Math.ceil(calTextUnits(block.text ?? "") / (code ? CAL_CODE_CHARS_PER_TOKEN : CAL_CHARS_PER_TOKEN)) + CAL_BLOCK_OVERHEAD;
			break;
		case "tool-call":
			tokens += Math.ceil(calTextUnits(block.name ?? "") / CAL_CHARS_PER_TOKEN) + Math.ceil(calTextUnits(block.arguments ?? "") / CAL_CODE_CHARS_PER_TOKEN) + CAL_BLOCK_OVERHEAD;
			break;
		case "tool-result":
			tokens += calEstimateContent(block.content, true) + CAL_BLOCK_OVERHEAD;
			break;
		default:
			tokens += CAL_BLOCK_OVERHEAD + Math.ceil(calTextUnits(JSON.stringify(block) ?? "{}") / CAL_CHARS_PER_TOKEN);
	}
	return tokens;
}

/** Heuristically price one model-visible message (content + role framing). */
function calEstimateMessage(message) {
	return calEstimateContent(message.content) + 4;
}

/** Price the non-surface request envelope (system prompt + tool schemas). */
function calEstimateHeader(header) {
	if (header === void 0) return 0;
	let tokens = 0;
	if (typeof header.system === "string") tokens += Math.ceil(calTextUnits(header.system) / CAL_CHARS_PER_TOKEN) + 4;
	if (Array.isArray(header.tools) && header.tools.length > 0) tokens += Math.ceil(calTextUnits(JSON.stringify(header.tools)) / CAL_CHARS_PER_TOKEN) + CAL_BLOCK_OVERHEAD;
	return tokens;
}

/**
 * Calibrated whole-session measurement in the host meter's node shape
 * (`{nodes: [{seq, tokens}], totalTokens}`): the same surface seqs, priced
 * with the calibrated densities so CJK-heavy, code-heavy sessions trip the
 * threshold where the provider's 400 line actually is. Structural (non
 * message) surface events are priced by their serialized JSON size.
 * @param session - session whose current surface is measured.
 * @returns {nodes, totalTokens} measurement.
 */
function calMeasureSession(session) {
	// Full log (including a fork's inherited prefix): the surface can span
	// inherited nodes, which ownEvents() would miss and price at zero.
	const events = new Map();
	for (const event of session.snapshotEvents()) {
		if (Number.isSafeInteger(event?.seq)) events.set(event.seq, event);
	}
	const nodes = session.surface?.nodes ?? [];
	const priced = [];
	let total = calEstimateHeader(session.requestHeader?.());
	for (const seq of nodes) {
		const event = events.get(seq);
		let tokens;
		if (event === undefined) tokens = 0;
		else {
			const message = deriveEventMessage(event);
			tokens = message === null
				? CAL_BLOCK_OVERHEAD + Math.ceil(calTextUnits(JSON.stringify(event.data ?? "")) / CAL_CHARS_PER_TOKEN)
				: calEstimateMessage(message);
		}
		total += tokens;
		priced.push({ seq, tokens });
	}
	return { nodes: priced, totalTokens: total };
}

/**
 * Port of dsh-compaction-basic's private `selectCompactableRange`: head
 * anchored, tail-accumulate the retention budget, then slide the boundary
 * back to a tool-pairing-balanced cut (the public dsh-compaction export).
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - calibrated measurement in the host meter's node shape.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
function selectCalibratedRange(session, measurement, retainTokens) {
	const pricedNodes = measurement.nodes;
	if (pricedNodes.length === 0) return null;
	const surfaceNodes = session.surface.nodes;
	if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) throw new Error("md-memory: calibrated surface does not match the session surface");
	// Mirror the native selector: the system prompt is held at surface node 0
	// and may not be rewritten as part of a user-history summary. Starting the
	// calibrated range at node 0 made every pre-compact attempt fail the native
	// transaction's system-head guard, forcing an avoidable official fallback.
	const head = session.eventAt(surfaceNodes[0]);
	const firstIdx = head?.type === "system/message" ? 1 : 0;
	let accumulated = 0;
	let keepFromIdx = pricedNodes.length;
	for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
		accumulated += pricedNodes[index].tokens;
		keepFromIdx = index;
		if (accumulated >= retainTokens) break;
	}
	if (keepFromIdx <= firstIdx) return null;
	while (keepFromIdx > firstIdx) {
		if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
		keepFromIdx -= 1;
	}
	if (keepFromIdx <= firstIdx) return null;
	return {
		start: surfaceNodes[firstIdx],
		end: surfaceNodes[keepFromIdx - 1]
	};
}

/** Port of the base's `routedTarget`: the exact durably routed provider/model. */
function calRoutedTarget(session) {
	const config = session.requestHeader?.()?.config;
	if (config === void 0 || config.provider.length === 0 || config.model.length === 0) return undefined;
	return {
		provider: config.provider,
		model: config.model
	};
}

/** Flat vacgc* config keys → partial nested VAC-GC config (absent keys keep
 * their VACGC_DEFAULTS via resolveVacGcConfig). */
function vacgcPartialFromConfig(raw) {
	const p = {};
	if (raw.vacgcMode !== undefined) p.mode = raw.vacgcMode;
	if (raw.vacgcSemantic !== undefined) p.semantic = raw.vacgcSemantic;
	const pressure = {};
	if (raw.vacgcPressureSoftGc !== undefined) pressure.softGc = raw.vacgcPressureSoftGc;
	if (raw.vacgcPressureColdCompact !== undefined) pressure.coldCompact = raw.vacgcPressureColdCompact;
	if (raw.vacgcPressureWarmCompact !== undefined) pressure.warmCompact = raw.vacgcPressureWarmCompact;
	if (raw.vacgcPressureAggressive !== undefined) pressure.aggressive = raw.vacgcPressureAggressive;
	if (raw.vacgcPressureEmergency !== undefined) pressure.emergency = raw.vacgcPressureEmergency;
	if (raw.vacgcPressureSafetyRatio !== undefined) pressure.safetyRatio = raw.vacgcPressureSafetyRatio;
	if (raw.vacgcPressureInjectionReserveRatio !== undefined) pressure.injectionReserveRatio = raw.vacgcPressureInjectionReserveRatio;
	if (Object.keys(pressure).length > 0) p.pressure = pressure;
	const recent = {};
	if (raw.vacgcRecentRatio !== undefined) recent.ratio = raw.vacgcRecentRatio;
	if (raw.vacgcRecentMinTokens !== undefined) recent.minTokens = raw.vacgcRecentMinTokens;
	if (raw.vacgcRecentMaxTokens !== undefined) recent.maxTokens = raw.vacgcRecentMaxTokens;
	if (Object.keys(recent).length > 0) p.recent = recent;
	const scoring = {};
	if (raw.vacgcReconstructibilityPenalty !== undefined) scoring.reconstructibilityPenalty = raw.vacgcReconstructibilityPenalty;
	if (raw.vacgcDuplicationPenalty !== undefined) scoring.duplicationPenalty = raw.vacgcDuplicationPenalty;
	if (raw.vacgcHotEnter !== undefined) scoring.hotEnter = raw.vacgcHotEnter;
	if (raw.vacgcHotLeave !== undefined) scoring.hotLeave = raw.vacgcHotLeave;
	if (raw.vacgcWarmEnter !== undefined) scoring.warmEnter = raw.vacgcWarmEnter;
	if (raw.vacgcWarmLeave !== undefined) scoring.warmLeave = raw.vacgcWarmLeave;
	if (Object.keys(scoring).length > 0) p.scoring = scoring;
	const compaction = {};
	if (raw.vacgcMinReclaimRatio !== undefined) compaction.minReclaimRatio = raw.vacgcMinReclaimRatio;
	if (raw.vacgcMinReclaimTokens !== undefined) compaction.minReclaimTokens = raw.vacgcMinReclaimTokens;
	if (raw.vacgcMaxReclaimTokens !== undefined) compaction.maxReclaimTokens = raw.vacgcMaxReclaimTokens;
	if (raw.vacgcSummaryMaxTokens !== undefined) compaction.summaryMaxTokens = raw.vacgcSummaryMaxTokens;
	if (raw.vacgcRetryOnCoverageFailure !== undefined) compaction.retryOnCoverageFailure = raw.vacgcRetryOnCoverageFailure;
	if (Object.keys(compaction).length > 0) p.compaction = compaction;
	const memory = {};
	if (raw.vacgcMemoryEnabled !== undefined) memory.enabled = raw.vacgcMemoryEnabled;
	if (raw.vacgcRequireSyncForP1 !== undefined) memory.requireSyncForP1 = raw.vacgcRequireSyncForP1;
	if (Object.keys(memory).length > 0) p.memory = memory;
	const ui = {};
	if (raw.vacgcUiEnabled !== undefined) ui.enabled = raw.vacgcUiEnabled;
	if (raw.vacgcUiShowPerRequest !== undefined) ui.showPerRequest = raw.vacgcUiShowPerRequest;
	if (Object.keys(ui).length > 0) p.ui = ui;
	if (raw.vacgcMaxUnitsInPlan !== undefined) p.maxUnitsInPlan = raw.vacgcMaxUnitsInPlan;
	return p;
}

/**
 * Port of dsh-session's per-node projection (inlined so this plugin's bare
 * import set stays limited to the packages it mounts against).
 * @param event - session event to project.
 * @returns the derived message, or null when the event produces none.
 */
function deriveEventMessage(event) {
	switch (event?.type) {
		case "user/message": return event.data ?? null;
		case "assistant/message":
			if (event.data?.message?.content?.length === 0) return null;
			return event.data?.message ?? null;
		case "tool/result": return event.data?.message ?? null;
		default: return null;
	}
}

//#endregion
//#region LedgerManager

/** File-based project memory ledger: deterministic integrity, atomic writes. */
class LedgerManager {
	/**
	 * Ensure the ledger directory exists, seed missing files, and reconcile
	 * the self-contained .gitignore (unless the user chose git tracking).
	 */
	ensure(dir, mml) {
		mkdirSync(dir, { recursive: true });
		const gitignore = join(dir, ".gitignore");
		if (mml.gitTracked) rmSync(gitignore, { force: true });
		else if (!existsSync(gitignore)) atomicWrite(gitignore, "*\n");
		for (const name of LEDGER_FILES) {
			const file = join(dir, name);
			if (!existsSync(file)) atomicWrite(file, FILE_TEMPLATES[name]);
		}
	}

	/** Read all ledger files; missing files fall back to their template. */
	readAll(dir) {
		const out = {};
		for (const name of LEDGER_FILES) {
			try {
				out[name] = readFileSync(join(dir, name), "utf8");
			} catch {
				out[name] = FILE_TEMPLATES[name];
			}
		}
		return out;
	}

	/**
	 * Enforce deterministic integrity between the old and next file set.
	 * Mutates nextFiles (restores silently-removed entries) and returns the
	 * issue list. Silent deletion is the failure this plugin exists to prevent.
	 */
	checkIntegrity(oldFiles, nextFiles) {
		const issues = [];
		const allNext = Object.values(nextFiles).join("\n");
		for (const name of ["PROJECT.md", "DECISIONS.md", "TECH.md", "CONFLICTS.md"]) {
			const oldEntries = parseEntries(oldFiles[name]);
			const nextEntries = parseEntries(nextFiles[name]);
			const nextById = new Map(nextEntries.map((entry) => [entry.id, entry]));
			for (const old of oldEntries) {
				const next = nextById.get(old.id);
				if (!next) {
					// Missing unless it was visibly relocated/renumbered in any next file.
					if (!allNext.includes(old.id)) {
						nextFiles[name] = `${String(nextFiles[name]).replace(/\s+$/, "")}\n\n${old.raw}`;
						issues.push({ file: name, id: old.id, type: "SILENT_REMOVAL", detail: "entry missing from sync output; previous version restored" });
					}
					continue;
				}
				if ((old.status ?? "ACTIVE") !== "CONFLICT" && (next.status === "SUPERSEDED" || next.status === "CONFLICT")) {
					issues.push({ file: name, id: old.id, type: next.status === "CONFLICT" ? "CONFLICT_MARKED" : "SUPERSEDED", detail: `status ${old.status ?? "ACTIVE"} -> ${next.status}` });
				}
			}
			const seen = new Set();
			for (const entry of nextEntries) {
				if (seen.has(entry.id)) issues.push({ file: name, id: entry.id, type: "DUPLICATE_ID", detail: "duplicate entry id in sync output" });
				seen.add(entry.id);
			}
		}
		if (!/\[STATE-CURRENT\]/.test(nextFiles["STATE.md"] ?? "")) {
			nextFiles["STATE.md"] = `${String(nextFiles["STATE.md"]).replace(/\s+$/, "")}\n\n## [STATE-CURRENT] (unknown — sync did not produce a state section)\n`;
			issues.push({ file: "STATE.md", type: "STATE_MISSING", detail: "STATE-CURRENT section missing; placeholder restored" });
		}
		return { issues };
	}

	/** Engine-owned router: deterministic rebuild of INDEX.md. */
	rebuildIndex(files, meta) {
		const row = (name, purpose, prefix) => {
			const entries = prefix ? parseEntries(files[name]).filter((entry) => entry.id.startsWith(`${prefix}-`)) : [];
			const head = entries.slice(0, 8).map((entry) => entry.id).join(", ");
			const more = entries.length > 8 ? ` (+${entries.length - 8} more)` : "";
			const count = name === "STATE.md" ? (/\[STATE-CURRENT\]/.test(files[name]) ? "1" : "0") : entries.length;
			return `| [${name}](./${name}) | ${purpose} | ${count} (${head}${more}) |`;
		};
		const conflicts = parseEntries(files["CONFLICTS.md"]).filter((entry) => (entry.status ?? "ACTIVE") === "ACTIVE").length;
		const lines = [
			"# INDEX — Memory Router",
			"",
			"> Auto-generated by dsh-md-memory. Do not edit by hand — the routing table rebuilds on every sync.",
			"",
			"## Routing",
			"",
			"| File | Purpose | Entries |",
			"|---|---|---|",
			row("PROJECT.md", "Requirements & scope", "REQ"),
			row("STATE.md", "Current state (mutable)", "STATE-CURRENT"),
			row("DECISIONS.md", "Decisions with rationale", "DEC"),
			row("TECH.md", "Technical facts & conventions", "TECH"),
			`| [HISTORY.md](./HISTORY.md) | Append-only sync log | ${String(files["HISTORY.md"]).trim().split("\n").filter((l) => l.startsWith("- [")).length} |`,
			row("CONFLICTS.md", "Integrity conflicts (never resolved silently)", "CONFLICT"),
			"",
			"## Status",
			``,
			`- Last sync: ${meta.at} (${meta.source}, session ${meta.session})`,
			`- Active conflicts: ${conflicts}`,
			"",
			"Agent rules: (1) before major decisions, memory_search the ledger (PROJECT / DECISIONS / TECH / HISTORY / CONFLICTS). (2) In compaction checkpoints cite entry ids (e.g. [DEC-001]) instead of restating ledger facts. (3) Unresolved CONFLICTS.md entries need user confirmation before acting on either side."
		];
		return lines.join("\n");
	}

	/**
	 * Per-session sync state, persisted in .state.json so host restarts do
	 * not lose the monotonic log cursor.
	 */
	loadState(dir, sessionId) {
		try {
			const all = JSON.parse(readFileSync(join(dir, ".state.json"), "utf8"));
			const entry = all?.sessions?.[sessionId];
			return {
				turns: typeof entry?.turns === "number" ? entry.turns : 0,
				lastSyncedSeq: typeof entry?.lastSyncedSeq === "number" ? entry.lastSyncedSeq : 0,
				lastSyncMs: typeof entry?.lastSyncMs === "number" ? entry.lastSyncMs : 0,
				lastSource: typeof entry?.lastSource === "string" ? entry.lastSource : null
			};
		} catch {
			return { turns: 0, lastSyncedSeq: 0, lastSyncMs: 0, lastSource: null };
		}
	}

	/**
	 * Ledger-wide monotonic revision (top-level `revision` in .state.json).
	 * Each committed sync bumps it by exactly one; a concurrent writer whose
	 * commit lands while this one's LLM call is in flight moves the revision,
	 * which the commit check detects (LEDGER_REVISION_CONFLICT).
	 */
	readRevision(dir) {
		try {
			const all = JSON.parse(readFileSync(join(dir, ".state.json"), "utf8"));
			return typeof all?.revision === "number" ? all.revision : 0;
		} catch {
			return 0;
		}
	}

	saveState(dir, sessionId, state, revision) {
		let all = {};
		try {
			all = JSON.parse(readFileSync(join(dir, ".state.json"), "utf8"));
		} catch {
			all = {};
		}
		all.sessions = all.sessions && typeof all.sessions === "object" ? all.sessions : {};
		all.sessions[sessionId] = state;
		if (revision !== undefined) all.revision = revision;
		atomicWrite(join(dir, ".state.json"), `${JSON.stringify(all, null, 2)}\n`);
	}

	/**
	 * Monotonic cursor: raw events after the last synced log position, each
	 * with its durable seq. session.log IS the append-only log — the surface
	 * the model sees is a separate projection, so compaction/shadowing never
	 * loses events: shadowed content stays in the log, addressable by seq.
	 */
	deltaEvents(session, fromSeq) {
		const log = Array.isArray(session.log) ? session.log : [];
		const out = [];
		for (const event of log.slice(fromSeq)) {
			let message = null;
			try {
				message = deriveEventMessage(event);
			} catch {
				continue;
			}
			const text = projectMessageText(message);
			if (!text) continue;
			const seq = typeof event?.seq === "number" ? event.seq : fromSeq + out.length;
			out.push({ seq, text });
		}
		return out;
	}

	/** Monotonic cursor: events after the last synced log position, joined for the LLM. */
	deltaText(session, fromSeq) {
		const parts = this.deltaEvents(session, fromSeq).map((event) => event.text);
		let out = parts.join("\n\n");
		if (out.length > DELTA_CAP) out = out.slice(-DELTA_CAP);
		return out;
	}

	/**
	 * Ephemeral evidence handles (P0.5): number the projected conversation
	 * messages [E1]…[En] in the Guardian prompt. E# is NOT the durable log
	 * seq — it is a per-sync-call alias that dies with the call; the host
	 * keeps the private E# → {seq, text} map, so the LLM never sees seqs and
	 * a cited handle can only bind to the exact message it was printed for
	 * (no multi-seq ambiguity — the failure mode of whole-log substring
	 * search, where the same quote in N messages bound all N arbitrarily).
	 * @returns {{ handles: Map<string, {seq: number, text: string}>, text: string }}
	 */
	handlesForRows(rows) {
		const handles = new Map();
		const parts = [];
		for (let i = 0; i < rows.length; i += 1) {
			const handle = `E${i + 1}`;
			handles.set(handle, rows[i]);
			parts.push(`${handle}\n${rows[i].text}`);
		}
		let text = parts.join("\n\n");
		if (text.length > DELTA_CAP) text = text.slice(-DELTA_CAP);
		return { handles, text };
	}

	/**
	 * Ledger provenance (P0/P0.5): the Guardian supports new/changed entries
	 * with `- source_ref: E#` (the ephemeral handle of the supporting message,
	 * see handlesForRows) + `- source: <verbatim quote>`. Binding rules
	 * (deterministic, host-side — the LLM never sees seqs):
	 *   - source_ref present + mapped + quote (normalized) ⊆ that message's
	 *     text → bind to that message's seq — exactly one, never ambiguous.
	 *   - source_ref present but the quote fails validation → UNRESOLVED
	 *     (quote-mismatch / unknown-ref / unmapped-ref): a mismatched quote is
	 *     a hallucination signal — no silent fallback.
	 *   - no source_ref: the quote is substring-searched over the whole
	 *     durable log — bound ONLY on a UNIQUE match; multiple matches are
	 *     ambiguous (no silent arbitrary binding), zero matches → not-found.
	 * Unresolved entries are persisted in the sidecar (reason + time); the
	 * VAC-GC conservative lane (protection.js) then holds lexically-related
	 * units at P1 until a later sync repairs the binding — fail-safe: a bad
	 * sidecar may cost extra retention, never a wrongful deletion.
	 * @param handles - Map<E#, {seq, text}> for THIS sync's conversation
	 *                  (empty map for structured-transcript syncs).
	 * @returns {{ bySeq: Map<number, Set<string>>, unresolved: Map<string, {reason: string, at: string}> }}
	 */
	resolveProvenance(nextFiles, oldFiles, provRows, handles) {
		const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ");
		const hay = provRows.map((row) => [row.seq, norm(row.text)]);
		const bySeq = new Map();
		const unresolved = new Map();
		const at = new Date().toISOString();
		const add = (seq, id) => {
			let set = bySeq.get(seq);
			if (!set) {
				set = new Set();
				bySeq.set(seq, set);
			}
			set.add(id);
		};
		for (const name of GUARDIAN_FILES) {
			const nextEntries = parseEntries(nextFiles[name] ?? "");
			const oldById = new Map(parseEntries(oldFiles[name] ?? "").map((entry) => [entry.id, entry]));
			for (const entry of nextEntries) {
				const old = oldById.get(entry.id);
				if (old && old.raw === entry.raw) continue; // unchanged entry: no source bullets expected
				const refM = entry.raw.match(/^\s*[-*]?\s*source_ref\s*[:：]\s*(E\d+)\s*$/im);
				const srcM = entry.raw.match(/^\s*[-*]?\s*source\s*[:：]\s*(.+)$/im);
				const nq = norm((srcM?.[1] ?? "").trim());
				const ref = refM?.[1];
				if (ref) {
					const row = handles?.get(ref);
					if (row && typeof row.seq === "number" && nq.length >= 2 && norm(row.text).includes(nq)) {
						add(row.seq, entry.id);
					} else {
						// valid ref shape but unverifiable: the quote does not
						// belong to the referenced message (hallucination
						// signal) or the host could not map the ref to a seq.
						unresolved.set(entry.id, { reason: row ? (row.seq !== undefined ? "quote-mismatch" : "unmapped-ref") : "unknown-ref", at });
					}
					continue;
				}
				if (nq.length >= 12) {
					const matches = hay.filter(([, nt]) => nt.includes(nq)).map(([seq]) => seq);
					if (matches.length === 1) add(matches[0], entry.id);
					else if (matches.length > 1) unresolved.set(entry.id, { reason: "ambiguous", at });
					else unresolved.set(entry.id, { reason: "not-found", at });
				} else {
					unresolved.set(entry.id, { reason: "no-ref", at });
				}
			}
		}
		return { bySeq, unresolved };
	}

	/**
	 * Provenance reconciliation (P0.5): any ACTIVE entry that carries a
	 * stored `- source:` quote but ends this sync UNBOUND (no fresh binding
	 * and no sidecar binding) gets the quote re-searched over the whole
	 * durable log — append-only means old evidence is still addressable.
	 * Repairs the degraded state of entries that are UNCHANGED this round
	 * (their bullets come from an earlier sync, so this is repair, not a
	 * same-sync fallback):
	 *  - sidecar never written / lost / corrupt → every quoted entry re-binds;
	 *  - a previous round's failed resolution (the row is gone or the sidecar
	 *    was lost) → the quote lives IN THE ENTRY, the stale E# no longer
	 *    matters;
	 *  - wrong-handle citation from an earlier sync → the quote is found in
	 *    the message it actually belongs to (the host re-decides the binding).
	 * Entries rejected THIS round (base.unresolved) are deliberately EXCLUDED:
	 * a same-sync re-search would be the silent fallback the validation
	 * exists to prevent — the rejection stands until a LATER sync repairs it.
	 * Unique match → bind; ambiguous/not-found → stays unresolved.
	 * @param rejected - Map<entryId, reason> of this round's rejections.
	 * @param sidecarBound - Set<entryId> already bound in the sidecar (skips re-work).
	 * @returns Map<number, Set<string>> — fresh bindings only.
	 */
	repairProvenance(nextFiles, activeIds, freshBySeq, sidecarBound, rejected, provRows) {
		const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ");
		const hay = provRows.map((row) => [row.seq, norm(row.text)]);
		const out = new Map();
		const add = (seq, id) => {
			let set = out.get(seq);
			if (!set) {
				set = new Set();
				out.set(seq, set);
			}
			set.add(id);
		};
		for (const name of GUARDIAN_FILES) {
			for (const entry of parseEntries(nextFiles[name] ?? "")) {
				if (!activeIds.has(entry.id)) continue;
				if (rejected.has(entry.id)) continue; // this round's rejection stands — no silent fallback
				if (sidecarBound.has(entry.id)) continue;
				let freshBound = false;
				for (const ids of freshBySeq.values()) {
					if (ids.has(entry.id)) {
						freshBound = true;
						break;
					}
				}
				if (freshBound) continue;
				const m = entry.raw.match(/^\s*[-*]?\s*source\s*[:：]\s*(.+)$/im);
				const nq = norm((m?.[1] ?? "").trim());
				if (nq.length < 12) continue; // no quotable evidence stored — cannot repair
				const matches = hay.filter(([, nt]) => nt.includes(nq)).map(([seq]) => seq);
				if (matches.length === 1) add(matches[0], entry.id);
			}
		}
		return out;
	}

	/** Entry ids bound anywhere in the sidecar (any session); tolerant. */
	readBoundIds(dir) {
		const ids = new Set();
		try {
			const doc = JSON.parse(readFileSync(join(dir, ".provenance.json"), "utf8"));
			for (const bySeq of Object.values(doc?.sessions ?? {})) {
				for (const list of Object.values(bySeq ?? {})) {
					if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
				}
			}
		} catch {
			// corrupt/missing sidecar → nothing bound (the reconciliation re-binds)
		}
		return ids;
	}

	/** ACTIVE entry ids in a post-sync file set (for unresolved-row pruning). */
	activeIdsOfFiles(files) {
		const out = new Set();
		for (const name of GUARDIAN_FILES) {
			for (const entry of parseEntries(files[name] ?? "")) {
				if ((entry.status ?? "ACTIVE").toUpperCase() === "ACTIVE") out.add(entry.id);
			}
		}
		return out;
	}

	/**
	 * Persist per-session seq→ids provenance + the unresolved map in
	 * .provenance.json (merged, never rewritten wholesale). Shape:
	 * { sessions: {<sessionId>: {<seq>: [ids]}}, unresolved: {<entryId>: {reason, at}} }.
	 * `result` = resolveProvenance()/repairProvenance() output {bySeq,
	 * unresolved}. `activeIds` = ACTIVE ids of the post-sync ledger:
	 * unresolved rows are dropped once the entry got a binding THIS round or
	 * is no longer ACTIVE. Capped at 100 sessions (current always kept) and
	 * 200 unresolved rows (newest kept).
	 */
	mergeProvenance(dir, sessionId, result, activeIds) {
		const file = join(dir, ".provenance.json");
		let all = { sessions: {}, unresolved: {} };
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			if (parsed && typeof parsed === "object") {
				if (parsed.sessions && typeof parsed.sessions === "object") all.sessions = parsed.sessions;
				if (parsed.unresolved && typeof parsed.unresolved === "object") all.unresolved = parsed.unresolved;
			}
		} catch {
			all = { sessions: {}, unresolved: {} };
		}
		const bySeq = result?.bySeq ?? new Map();
		const mine = all.sessions[sessionId] && typeof all.sessions[sessionId] === "object" ? all.sessions[sessionId] : {};
		for (const [seq, ids] of bySeq) {
			for (const id of ids) {
				const list = Array.isArray(mine[seq]) ? mine[seq] : [];
				if (!list.includes(id)) list.push(id);
				mine[seq] = list;
			}
		}
		all.sessions[sessionId] = mine;
		const keys = Object.keys(all.sessions);
		if (keys.length > 100) {
			const keep = new Set([sessionId, ...keys.slice(0, 99)]);
			for (const key of keys) if (!keep.has(key)) delete all.sessions[key];
		}
		// Unresolved merge: keep prior rows, add this round's failures, drop
		// entries repaired this round or no longer ACTIVE.
		const unresolved = new Map();
		for (const [id, info] of Object.entries(all.unresolved ?? {})) {
			unresolved.set(id, info && typeof info === "object" ? info : { reason: "unknown", at: "" });
		}
		for (const [id, info] of result?.unresolved ?? []) unresolved.set(id, info);
		const boundThisRound = new Set();
		for (const ids of bySeq.values()) for (const id of ids) boundThisRound.add(id);
		for (const id of [...unresolved.keys()]) {
			if (boundThisRound.has(id)) unresolved.delete(id);
			else if (activeIds !== undefined && !activeIds.has(id)) unresolved.delete(id);
		}
		if (unresolved.size > 200) {
			const rows = [...unresolved.entries()].sort((a, b) => String(b[1].at ?? "").localeCompare(String(a[1].at ?? "")));
			unresolved.clear();
			for (const [id, info] of rows.slice(0, 200)) unresolved.set(id, info);
		}
		all.unresolved = Object.fromEntries(unresolved);
		atomicWrite(file, `${JSON.stringify(all, null, 2)}\n`);
	}

	/** Line-based keyword search across ledger files (AND over terms). */
	search(dir, query, fileFilter, limit) {
		if (!existsSync(dir)) return { results: [], note: `no ledger at ${dir} yet (it is created on the first sync)` };
		const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
		const names = fileFilter && LEDGER_FILES.includes(fileFilter) ? [fileFilter] : [...LEDGER_FILES];
		const results = [];
		for (const name of names) {
			let content;
			try {
				content = readFileSync(join(dir, name), "utf8");
			} catch {
				continue;
			}
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i += 1) {
				if (results.length >= limit) break;
				if (!terms.length) continue;
				const hay = lines[i].toLowerCase();
				if (!terms.every((term) => hay.includes(term))) continue;
				results.push({ file: name, line: i + 1, entryId: nearestEntryId(lines, i) ?? "", text: lines[i].trim() });
			}
		}
		return { results };
	}

	/** Read one ledger file (whole) or one entry section. */
	read(dir, file, entryId) {
		if (!LEDGER_FILES.includes(file)) throw new Error(`unknown ledger file: ${file} (expected one of ${LEDGER_FILES.join(", ")})`);
		if (!existsSync(join(dir, file))) throw new Error(`no ledger at ${dir} yet`);
		const content = readFileSync(join(dir, file), "utf8");
		if (!entryId) return { file, content };
		const section = extractSection(content, entryId);
		if (section === null) throw new Error(`entry [${entryId}] not found in ${file}`);
		return { file, entryId, content: section };
	}

	/**
	 * System-prompt memory section — ADAPTIVE LAZY INJECTION (P1-④). The
	 * pending user message is classified rule-first (classifyMemoryNeed,
	 * C0–C5) and only the class budget is injected (MEMORY_CLASS_BUDGETS
	 * tokens): C0/C1 spend ZERO durable memory, C2 = STATE, C3 = STATE +
	 * related entries, C4 = router + STATE + related ACTIVE decisions/TECH,
	 * C5 = the full ledger view. The old ~6K-char resident dump (router +
	 * STATE + last-10 decisions on every single prompt) is gone — the ledger
	 * stays reachable through memory_search and the 项目记忆 UI. Also
	 * replayed into the compaction summary call via the persona variable.
	 * Unknown intent (no user message visible) falls back to C4 — when the
	 * need is unclear, over-inject at planning level rather than lose it.
	 */
	promptContext(dir, mml, session) {
		if (mml.injectAlways === false) return "";
		// First contact with this project: seed the ledger so the section —
		// and the tools — operate on real files from the first turn, not only
		// after the first sync (DEC-014).
		if (!existsSync(dir)) this.ensure(dir, mml);
		const files = this.readAll(dir);
		const message = lastUserText(session);
		const cls = message ? classifyMemoryNeed(message, files).cls : "C4";
		const text = renderLazyContext(files, message, cls);
		if (process.env.MML_DBG) console.error(`[mml] lazy injection ${cls}: ${estimateTokens(text)} tok — "${String(message).replace(/\n/g, " ").slice(0, 60)}"`);
		return text;
	}

	/**
	 * Run one Guardian sync. Returns {written, issues, historyLine} or
	 * {skipped}. Throws only on hard failures (caller decides severity).
	 *
	 * Concurrency (explicit guarantee levels, review 2026-09-12 P0.5):
	 *  - SINGLE host process (the DSH Desktop deployment) = STRONG: the
	 *    engine's per-dir lock serializes every sync path (turn / pre-compact
	 *    / manual), so no two of our own writers overlap.
	 *  - MULTIPLE host processes on the same project dir = BEST EFFORT. The
	 *    revision check is optimistic, not a CAS: a writer that crashes after
	 *    writing the ledger files but before bumping the revision leaves a
	 *    window in which another process reads the old revision and commits
	 *    over it. That is acceptable by design because the sync is IDEMPOTENT
	 *    — the Guardian re-emits OPERATIONS that the host re-validates and
	 *    re-applies against a FRESH base (entry ids are re-minted from the
	 *    newer files, cursors are per-session), and a crashed partial commit
	 *    simply means the pre-crash state stays effective (the revision is
	 *    the commit marker); the next sync of the losing session converges.
	 *    An OS-level .lock (exclusive handle) or a versioned snapshot +
	 *    atomic pointer is the future hardening IF two hosts ever write one
	 *    workspace — not worth the complexity today.
	 * Within a process, a concurrent commit moves the revision →
	 * LEDGER_REVISION_CONFLICT → exactly one COMMIT retry on a fresh base
	 * WITHOUT re-invoking the LLM (the operations are a pure function of the
	 * delta + the ledger; only validation/apply re-runs — one LLM call per
	 * sync, always). Idempotence note (operations contract): the retry replans
	 * the SAME batch against the newer ledger — the instruction forbids
	 * re-adding entries that already exist, and host-side any operation
	 * targeting an already-closed entry is rejected (TARGET_NOT_ACTIVE)
	 * rather than double-applied. A conflict that exhausts the retry surfaces
	 * as the sync error: the cursor is HELD, so the next sync re-derives the
	 * operations from the newest ledger (the effective delayed retry).
	 */
	async sync(ctx, mml, dir, session, opts) {
		// No LLM-level retry loop here (legacy of the full-file contract):
		// #syncOnce owns the single commit-level retry.
		return await this.#syncOnce(ctx, mml, dir, session, opts);
	}

	async #syncOnce(ctx, mml, dir, session, { source, input, signal, agentTarget, planHook, writeHook }) {
		this.ensure(dir, mml);
		const state = this.loadState(dir, session.id);
		const files = this.readAll(dir);
		// Revision baseline BEFORE the LLM call: a concurrent commit while the
		// model is thinking must be detected by the first commit attempt.
		const revBefore = this.readRevision(dir);
		const hooks = { planHook, writeHook }; // test seams (no-ops in production)

		let messages;
		// Ephemeral evidence handles for THIS sync (P0.5): turn syncs number
		// the delta rows [E1]…[En] in the prompt; structured-transcript
		// (compaction) syncs keep the prefix byte-identical for cache
		// mirroring and carry no handles — their entries bind through the
		// quote-unique fallback instead.
		let handles = new Map();
		if (input && Array.isArray(input.messages) && input.messages.length > 0) {
			// Compaction-time sync: append the Guardian instruction to the
			// compactable prefix VERBATIM (prefix-first, cache-friendly — if
			// the provider caches prefixes, the shared prefix is byte-identical
			// to the compaction call) and extract exactly the content about to
			// be shadowed. A cache HIT is deliberately not claimed here: it is
			// only measurable when the provider reports cached tokens.
			messages = [
				...input.messages,
				createUserMessage({
					content: [{ type: "text", text: `${GUARDIAN_INSTRUCTION}\n\n${renderLedgerContext(files)}` }],
					source: { kind: "plugin", plugin: "dsh-md-memory" }
				})
			];
		} else {
			// Turn-based sync: only what happened since the last sync, with
			// ephemeral evidence handles (P0.5): the Guardian cites [E#] + a
			// verbatim quote, and the host binds the pair to exactly one
			// message (the private E#→seq map dies with this call).
			const { handles: syncHandles, text: delta } = this.handlesForRows(this.deltaEvents(session, state.lastSyncedSeq));
			handles = syncHandles;
			if (!delta.trim()) return { skipped: "no new content since last sync" };
			messages = [
				createUserMessage({
					content: [{ type: "text", text: `${GUARDIAN_INSTRUCTION}\n\n${renderLedgerContext(files)}\n\n## Conversation since last sync\n${delta}` }],
					source: { kind: "plugin", plugin: "dsh-md-memory" }
				})
			];
		}

		// Resolve the LLM target: explicit MML config > routed session header > agent options.
		const latest = session.requestHeader?.()?.config;
		const configured = mml.syncProvider.length > 0 ? { provider: mml.syncProvider, model: mml.syncModel } : undefined;
		const target = configured ?? (latest?.provider && latest?.model ? { provider: latest.provider, model: latest.model } : undefined) ?? (agentTarget?.provider && agentTarget?.model ? { provider: agentTarget.provider, model: agentTarget.model } : undefined);
		if (!target) throw new Error("no provider/model available for memory sync (set mdMemory.syncProvider/syncModel or route a request first)");

		const options = {
			provider: target.provider,
			model: target.model,
			messages,
			...input?.system === undefined ? {} : { system: input.system },
			...input?.tools === undefined ? {} : { tools: [...input.tools] },
			maxTokens: mml.syncMaxTokens,
			sessionId: session.id,
			purpose: "compaction",
			...signal === undefined ? {} : { signal }
		};

		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
		const finish = assembler.finish;
		if (finish.kind === "error" || finish.kind === "aborted") throw new Error(finish.failure.message);
		if (finish.kind === "max-tokens") throw new Error(`memory sync truncated at the token cap (${mml.syncMaxTokens})`);
		const blocks = assembler.blocks();
		if (contentHasImage(blocks)) throw new Error("memory sync produced image output");
		const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
		const parsed = parseSyncJson(text);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.operations)) throw new Error("memory sync output was not a usable operations JSON object");
		const note = typeof parsed.history === "string" ? parsed.history.trim().slice(0, 300) : "";

		// Operations contract (P1-②): the LLM proposes, the host disposes.
		// Validation + application re-run on a FRESH base for the
		// revision-conflict retry — the LLM call itself is never repeated.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return this.#commitOps(dir, session, source, parsed, handles, note, attempt === 0 ? revBefore : undefined, attempt, hooks);
			} catch (error) {
				if (error?.code === "LEDGER_REVISION_CONFLICT" && attempt === 0) continue;
				throw error;
			}
		}
	}

	/**
	 * Validate + apply + persist one operation batch against a FRESH ledger
	 * base. No LLM here — planning is a pure function of (operations, base,
	 * handles, log), so a revision-conflict retry re-plans the SAME batch on
	 * the newer base (ids re-minted from the newer files) and converges.
	 * `revBefore` (attempt 0) is the pre-LLM baseline: if a concurrent writer
	 * committed while the model was thinking, the base moved → conflict.
	 * On the retry (revBefore undefined) the baseline is whatever the fresh
	 * re-read observes; a further concurrent commit is caught by the pre-write
	 * re-check. `hooks` = optional test seams (planHook/writeHook), no-ops in
	 * production.
	 */
	#commitOps(dir, session, source, parsed, handles, note, revBefore, attempt, hooks) {
		hooks?.planHook?.(attempt);
		const files = this.readAll(dir);
		const revAtRead = this.readRevision(dir);
		if (revBefore !== undefined && revAtRead !== revBefore) {
			const error = new Error(`ledger revision moved during memory sync (${revBefore} -> ${revAtRead}); another writer committed first`);
			error.code = "LEDGER_REVISION_CONFLICT";
			throw error;
		}
		const baseline = revAtRead;
		const rows = this.deltaEvents(session, 0); // whole durable log (quote-unique fallback + reconciliation)

		const plan = planOperations(parsed, { files, handles, rows });
		if (!plan.ok) throw new Error(`memory sync operations rejected: ${plan.error}`);
		const { nextFiles, notes } = applyOperations(files, plan.applied);

		// Deterministic integrity enforcement (defense in depth: operations
		// cannot silently delete, this still catches render anomalies).
		const { issues } = this.checkIntegrity(files, nextFiles);

		// INDEX.md is engine-owned: always rebuilt from the enforced set.
		const at = new Date().toISOString();
		nextFiles["INDEX.md"] = this.rebuildIndex(nextFiles, { at, source, session: session.id });

		// Concurrency gate (re-check before touching disk): if a concurrent
		// writer committed after our base read, bail — the retry re-plans this
		// same batch on the newer base.
		hooks?.writeHook?.(attempt);
		const revNow = this.readRevision(dir);
		if (revNow !== baseline) {
			const error = new Error(`ledger revision moved during memory sync (${baseline} -> ${revNow}); another writer committed first`);
			error.code = "LEDGER_REVISION_CONFLICT";
			throw error;
		}

		// Persist changed files atomically (INDEX always; it is deterministic).
		const written = [];
		for (const name of LEDGER_FILES) {
			if (name === "HISTORY.md") continue;
			if (nextFiles[name] !== files[name]) {
				atomicWrite(join(dir, name), nextFiles[name]);
				written.push(name);
			}
		}

		// Append-only history line: what landed, what was rejected (the host's
		// reason is the audit trail of every rejected operation), the LLM's note.
		const rejectedNote = plan.rejected.map((r) => `${r.reason}: ${r.op}${r.detail ? ` (${r.detail})` : ""}`).join("; ");
		// Keep the model's prose visibly separate from validated operations:
		// a note can claim "Added REQ" even when the host rejected that ADD.
		const historyLine = `- [${at}] (${source}) session ${session.id}: ops ${notes.length ? notes.join(", ") : "(none)"}${plan.rejected.length ? `; rejected ${rejectedNote}` : ""}${note ? `; model-note: ${note}` : ""}; integrity: ${issues.length ? issues.map((issue) => `${issue.type}${issue.id ? `(${issue.id})` : ""}`).join(", ") : "ok"}`;
		nextFiles["HISTORY.md"] = `${String(files["HISTORY.md"]).replace(/\s+$/, "")}\n${historyLine}\n`;
		atomicWrite(join(dir, "HISTORY.md"), nextFiles["HISTORY.md"]);

		// Commit point: advance the monotonic cursor, bump the ledger-wide
		// revision, and persist session state in one atomic write. Even an
		// all-rejected batch commits: the delta was considered and the host's
		// rejection is final for it — the raw evidence stays in the append-only
		// log, and a later sync may re-extract the fact (with good evidence).
		const state = this.loadState(dir, session.id);
		state.turns = 0;
		state.lastSyncedSeq = Array.isArray(session.log) ? session.log.length : state.lastSyncedSeq;
		state.lastSyncMs = Date.now();
		state.lastSource = source;
		this.saveState(dir, session.id, state, baseline + 1);

		// Provenance commit (P0.5 fail-safe, P1-② direct bindings). Bindings
		// come from the VALIDATED operations (authoritative — the host already
		// checked handle+quote; no re-parsing), then reconciliation repairs
		// legacy/unbound entries from their stored `- source:` quotes. This is
		// NOT part of the ledger commit point on purpose: a sidecar failure
		// must never roll back a good ledger write (memory availability wins)
		// — the price is paid by the VAC-GC conservative lane ("keep more,
		// never delete wrongly") until the next sync repairs the sidecar.
		try {
			const bySeq = new Map();
			for (const p of plan.applied) {
				const id = p.id ?? p.op.targetId ?? null;
				// `seq` may legitimately be 0 (first message of the log) —
				// test the binding OBJECT, never the seq value.
				if (!p.binding || p.binding.seq == null || !id || id === "STATE-CURRENT") continue;
				let set = bySeq.get(p.binding.seq);
				if (!set) {
					set = new Set();
					bySeq.set(p.binding.seq, set);
				}
				set.add(id);
			}
			const active = this.activeIdsOfFiles(nextFiles);
			const repaired = this.repairProvenance(nextFiles, active, bySeq, this.readBoundIds(dir), new Map(), rows);
			for (const [seq, ids] of repaired) {
				let set = bySeq.get(seq);
				if (!set) {
					set = new Set();
					bySeq.set(seq, set);
				}
				for (const id of ids) set.add(id);
			}
			// `unresolved: []` — mergeProvenance carries the sidecar's prior
			// rows forward and drops any entry bound this round or no longer
			// ACTIVE. Rejected ops never touch the ledger, so they add no rows.
			this.mergeProvenance(dir, session.id, { bySeq, unresolved: new Map() }, active);
		} catch (error) {
			console.warn(`[dsh-md-memory] provenance commit degraded: ${error?.message ?? error} — the ledger commit stands; ACTIVE entries without resolved evidence are conservatively protected (P1 hold) until the next sync repairs the sidecar`);
		}

		return { written, issues, historyLine };
	}
}

//#endregion
//#region preset provisioning (DEC-018)

/**
 * Boot-time preset provisioning: makes the install story "drop the package
 * into the profile's node_modules and restart". The MML presets are derived
 * from the host's OWN builtin presets (`dsh-agent-presets/presets/*`), so
 * they track host upgrades with zero drift:
 *
 *   standard-mml = builtin `standard` + the compaction-basic row swapped to
 *                  load dsh-md-memory/engine (preserving host policy config)
 *                  — the subpath keeps the main export free
 *                  for the root bundle entry (lib/root.js);
 *   minimal-mml  = builtin `minimal` + the persona text gains the
 *                  `{{md_memory}}` variable (the only channel that survives
 *                  a `complete: true` persona — DEC-015) + the host's own
 *                  compaction group with the engine row swapped.
 *
 * Idempotence: a `.mml-version` stamp (host package version + sha256 of the
 * generated composition) is written beside each preset. Absent presets are
 * generated; stamped, unedited presets on an unchanged host are left alone;
 * stamped but user-edited presets are never touched; unstamped (user-
 * authored) presets are never touched.
 */
/**
 * Preset generator version. Bumping this forces re-derivation of provisioned
 * presets on next boot (only when the user has NOT edited them since the last
 * provisioning — the stamp sha check still protects user edits). v2 (2026-09-05):
 * compaction row specifiers moved to the `dsh-md-memory/engine` subpath export
 * because the package main export became the root bundle entry (lib/root.js)
 * that makes the `dsh.client` half visible to the host boot-manifest scan.
 * v3 (2026-09-05): Phase 2 (§119) — provisioned presets set `vacgcMode: prune`
 * so the TRASH fresh-prune execution path lands in the live session (turn-end
 * on a `fresh-prune` decision; always at pre-compact).
 * v4 (2026-09-05): modelPolicies provider id corrected to `vllm` (the
 * settings.yaml provider id) — `qwen38-agent` is a MODEL id, not a provider,
 * so the policies previously never matched the session route.
 * v5: accept `prefix` and older `text` personas, copy the installed host's
 * compaction group, and stop injecting one deployment's hard-coded models.
 * v6: enable VAC-GC Phase 3 semantic verification/execution in the two
 * provisioned MML presets (the base engine remains shadow by default).
 */
const MML_GEN_VERSION = 6;

const MML_PRESETS = Object.freeze([
	{
		id: "standard-mml",
		base: "standard",
		meta: [
			"name: 标准模式 + 项目记忆",
			"description: 与标准模式相同，压缩引擎替换为 dsh-md-memory（Markdown Memory Ledger）：压缩前自动同步项目记忆账本，VAC-GC Phase 3 对语义摘要做精确事实校验，新增 memory_search / memory_read 工具，Web 界面提供「项目记忆」面板。",
			"order: 2"
		].join("\n") + "\n"
	},
	{
		id: "minimal-mml",
		base: "minimal",
		meta: [
			"name: 极简模式 + 项目记忆",
			"description: >-",
			"  与极简模式相同（持久 shell + str_replace_editor 双工具、固定 persona），",
			"  压缩引擎替换为 dsh-md-memory（Markdown Memory Ledger）：压缩前自动同步",
			"  项目记忆账本，新增 memory_search / memory_read 工具，Web 界面提供",
			"  「项目记忆」面板；VAC-GC Phase 3 对语义摘要做精确事实校验并安全回退。",
			"  「项目记忆」面板。persona 通过 {{md_memory}} 变量按 C0–C5 分级按需注入账本视图（P1-④ 惰性注入：C0/C1 零注入）",
			"  （complete persona 会丢弃其余 section/context，变量插值仍可存活）。",
			"order: 4"
		].join("\n") + "\n"
	}
]);

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** Derive one preset's composition from the host's builtin preset files. */
export function generateMmlComposition(preset, builtinRoot) {
	const src = readFileSync(join(builtinRoot, preset.base, "agent.cordis.yml"), "utf8");
	if (preset.id === "standard-mml") {
		return replaceBuiltinCompaction(src);
	}
	const withMemory = injectMinimalPersonaVariable(src);
	const standard = readFileSync(join(builtinRoot, "standard", "agent.cordis.yml"), "utf8");
	const group = extractBuiltinCompactionGroup(standard);
	return `${withMemory.replace(/\s+$/, "")}\n\n${replaceBuiltinCompaction(group).trimEnd()}\n`;
}

/** Keep the installed host's compaction group and settings when changing its engine. */
function replaceBuiltinCompaction(source) {
	const lines = source.split("\n");
	const nameIndex = lines.findIndex((line) => /^\s*name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?\s*$/.test(line));
	if (nameIndex < 0) throw new Error("builtin standard preset structure changed (dsh-compaction-basic row not found)");
	const indent = lines[nameIndex].match(/^\s*/)[0];
	lines[nameIndex] = `${indent}name: dsh-md-memory/engine`;
	let nextIndex = nameIndex + 1;
	while (nextIndex < lines.length && lines[nextIndex].trim() === "") nextIndex += 1;
	const next = lines[nextIndex] ?? "";
	if (next.trim() === "config:" && next.match(/^\s*/)[0] === indent) {
		lines.splice(nextIndex + 1, 0, `${indent}  vacgcMode: prune`, `${indent}  vacgcSemantic: true`);
	} else {
		lines.splice(nameIndex + 1, 0, `${indent}config:`, `${indent}  vacgcMode: prune`, `${indent}  vacgcSemantic: true`);
	}
	return lines.join("\n");
}

/** Both older `text` and newer `prefix` complete personas need the variable. */
function injectMinimalPersonaVariable(source) {
	const lines = source.split("\n");
	const index = lines.findIndex((line) => /^\s*(?:prefix|text):\s*/.test(line));
	if (index < 0) throw new Error("builtin minimal preset structure changed (persona prefix/text not found)");
	const match = lines[index].match(/^(\s*)(prefix|text):\s*(.*)$/);
	const [, indent, key, value] = match;
	if (/^[>|][-+]?\s*$/.test(value)) {
		let end = index + 1;
		while (end < lines.length && (lines[end].trim() === "" || lines[end].match(/^\s*/)[0].length > indent.length)) end += 1;
		lines.splice(end, 0, `${indent}  {{md_memory}}`);
	} else if (value && !/^['"]/.test(value)) {
		lines.splice(index, 1, `${indent}${key}: >-`, `${indent}  ${value}`, `${indent}  {{md_memory}}`);
	} else {
		throw new Error("builtin minimal preset persona uses an unsupported YAML value");
	}
	return lines.join("\n");
}

function extractBuiltinCompactionGroup(source) {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => /^- id: compaction\s*$/.test(line));
	if (start < 0) throw new Error("builtin standard preset structure changed (compaction group not found)");
	let end = start + 1;
	while (end < lines.length && !/^- id: |^# ──/.test(lines[end])) end += 1;
	return lines.slice(start, end).join("\n");
}

/**
 * Resolve the DSH home directory (the folder that contains `profiles/`,
 * `.agent-presets/` and `settings.yaml` — normally `~/.dsh`).
 *
 * Primary: the host exports `DSH_HOME` (verified in the production process
 * environment). Fallback 1: walk up from this package's lib directory to the
 * first ancestor that looks like a home — this is layout-independent, so it
 * works whether the package sits in `<profile>/node_modules/…`,
 * `<profile>/vendor/…`, or anywhere else under the home. Fallback 2: the
 * conventional `~/.dsh` — needed when the package loads from OUTSIDE the
 * home (a junction into a source workspace: import.meta.url is the REAL,
 * junction-resolved path, so the walk-up can never reach the home).
 * @returns {string|undefined} the home path, or undefined when unresolvable.
 */
function resolveDshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.length > 0 && existsSync(env)) return env;
	const looksLikeHome = (dir) => existsSync(join(dir, "profiles")) && (existsSync(join(dir, ".agent-presets")) || existsSync(join(dir, "settings.yaml")));
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i += 1) {
		if (looksLikeHome(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	const conventional = join(homedir(), ".dsh");
	if (looksLikeHome(conventional)) return conventional;
	return undefined;
}

/**
 * Provision the MML presets once per host
 * version. Never throws: every failure is logged and the boot continues
 * (a pre-existing user preset or a host upgrade that changed the builtin
 * layout simply means the user manages the presets by hand).
 * @returns the number of presets generated this call.
 */
function provisionMmlPresets(ctx) {
	try {
		const require = createRequire(import.meta.url);
		const presetsPkg = require.resolve("@deepseek-ai/dsh-agent-presets/package.json");
		const builtinRoot = join(dirname(presetsPkg), "presets");
		let hostVersion = "unknown";
		try {
			hostVersion = JSON.parse(readFileSync(presetsPkg, "utf8")).version ?? "unknown";
		} catch {
			// version is a stamp token only; "unknown" still works
		}
		// DSH home: the host exports DSH_HOME; fall back to a layout-independent
		// upward search (works for node_modules, vendor, or any ancestor layout).
		const home = resolveDshHome();
		if (home === undefined) {
			ctx.logger.warn("md-memory: could not resolve the DSH home (no DSH_HOME env, no profiles/.agent-presets ancestor); skipping preset provisioning");
			return 0;
		}
		const presetRoot = join(home, ".agent-presets");
		let provisioned = 0;
		for (const preset of MML_PRESETS) {
			try {
				const dir = join(presetRoot, preset.id);
				const compFile = join(dir, "agent.cordis.yml");
				const metaFile = join(dir, "preset.yml");
				const stampFile = join(dir, ".mml-version");
				if (existsSync(compFile) && existsSync(metaFile)) {
					let stamp = null;
					try {
						stamp = JSON.parse(readFileSync(stampFile, "utf8"));
					} catch {
						stamp = null;
					}
					if (stamp === null || typeof stamp.sha !== "string") {
						ctx.logger.info(`md-memory: preset ${preset.id} exists without an MML stamp — leaving it to the user`);
						continue;
					}
					if (sha256(readFileSync(compFile, "utf8")) !== stamp.sha) {
						ctx.logger.info(`md-memory: preset ${preset.id} was edited after provisioning — leaving it to the user`);
						continue;
					}
					if (stamp.gen !== MML_GEN_VERSION) {
						// Generator moved (row specifiers changed): re-derive — the
						// sha check above proved the user did not edit after provisioning.
						ctx.logger.info(`md-memory: preset ${preset.id} predates generator v${MML_GEN_VERSION} (gen ${stamp.gen ?? "n/a"}); re-deriving`);
					} else if (stamp.version === hostVersion) continue; // healthy
					// Unedited by the user, but the host moved: re-derive.
					else ctx.logger.info(`md-memory: preset ${preset.id} is stale (host ${stamp.version} → ${hostVersion}); re-deriving`);
				}
				const composition = generateMmlComposition(preset, builtinRoot);
				mkdirSync(dir, { recursive: true });
				atomicWrite(compFile, composition);
				atomicWrite(metaFile, preset.meta);
				atomicWrite(stampFile, `${JSON.stringify({ version: hostVersion, gen: MML_GEN_VERSION, sha: sha256(composition) }, null, 2)}\n`);
				provisioned += 1;
				ctx.logger.info(`md-memory: provisioned preset ${preset.id} (host ${hostVersion})`);
			} catch (error) {
				ctx.logger.warn(`md-memory: preset provisioning failed for ${preset.id} (${errMsg(error)})`);
			}
		}
		return provisioned;
	} catch (error) {
		ctx.logger.warn(`md-memory: preset provisioning skipped (${errMsg(error)})`);
		return 0;
	}
}

//#endregion
//#region engine

/**
 * Compaction engine that carries the Markdown Memory Ledger.
 *
 * Base behavior is inherited (pressure/overflow compaction, per-target
 * policies). Two guarded overrides: `summarize` first syncs the ledger
 * with the compactable prefix (non-fatal) and then delegates to the base
 * summary call untouched; `compactNow` skips the summarizer call when the
 * selected span is below MIN_MANUAL_COMPACT_SPAN_TOKENS (the shrink guard
 * cannot win a useful reduction on a span that small, and the base would
 * surface it as a scary no-op failure). The user's compaction tuning
 * (thresholdRatio/retainRatio/maxTokens/modelPolicies) is forwarded
 * verbatim to the parent constructor and stays authoritative.
 */
/** Version-tolerance host contract (deliverability audit 2026-09-12): every
 * host surface this engine relies on at runtime, in one frozen place. It is
 * probed once per mount (constructor, before `super`) so a DSH upgrade that
 * changes the compaction host API fails LOUD at session mount with an
 * actionable message — instead of a cryptic error deep mid-turn. Keep this
 * list in sync when the engine starts using a new host service.
 * - `baseMethods`: stock-engine prototype methods we override AND call via
 *   super (a renamed/removed method would otherwise throw deep in
 *   compactIfNeeded/compactNow).
 * - `requiredServices`: ctx services the engine unconditionally needs.
 * - `optionalServices`: the engine degrades without them (warn only). */
const HOST_CONTRACT = Object.freeze({
	baseMethods: Object.freeze(["compactNow", "compactIfNeeded"]),
	requiredServices: Object.freeze(["on", "llm", "tokenMeter"]),
	optionalServices: Object.freeze(["sessions", "tools", "agents"])
});

/**
 * Check the live host against {@link HOST_CONTRACT}.
 * @param {object} ctx - the per-session ctx the engine is mounted with.
 * @param {object} baseProto - the stock engine prototype (BasicCompactionEngine.prototype).
 * @returns {string[]} human-readable violations; empty = compatible.
 */
export function hostContractProblems(ctx, baseProto) {
	const problems = [];
	for (const method of HOST_CONTRACT.baseMethods) {
		if (typeof baseProto?.[method] !== "function") problems.push(`BasicCompactionEngine.prototype.${method} is not a function`);
	}
	for (const service of HOST_CONTRACT.requiredServices) {
		if (ctx?.[service] === undefined || ctx?.[service] === null) problems.push(`ctx.${service} is missing`);
	}
	if (ctx?.tokenMeter && typeof ctx.tokenMeter.estimateMessage !== "function") {
		problems.push("ctx.tokenMeter.estimateMessage is not a function (shadow-price contract)");
	}
	return problems;
}

/** One-shot, actionable diagnostic for a broken contract. */
export function hostContractMismatchError(problems) {
	return new Error(
		`dsh-md-memory: host contract mismatch — ${problems.join("; ")}. `
		+ "A DSH upgrade likely changed the compaction host API. Recovery: point the "
		+ "agent-preset compaction row (id compaction-basic) back to the stock engine "
		+ "(name: dsh-compaction-basic) and restart; this plugin is incompatible with "
		+ "that host build until updated."
	);
}

/** Mirror the base engine's exact-target retention precedence. */
export function resolveCalibratedSpec(config, target, contextWindow) {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new Error(`contextWindow (${contextWindow}) must be a positive integer`);
	const override = (config.modelPolicies ?? []).find((policy) => policy.provider === target.provider && policy.model === target.model);
	const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio;
	const thresholdTokens = Math.floor(contextWindow * thresholdRatio);
	const tokens = override?.retainTokens !== undefined ? override.retainTokens
		: override?.retainRatio !== undefined ? Math.floor(contextWindow * override.retainRatio)
		: config.retainTokens !== undefined ? config.retainTokens
		: Math.floor(contextWindow * config.retainRatio);
	if (tokens >= thresholdTokens) throw new Error(`retainTokens (${tokens}) must be less than threshold tokens ${thresholdTokens}`);
	return {
		targetKey: `${target.provider}/${target.model}`,
		thresholdRatio,
		thresholdTokens,
		retainTokens: tokens,
		compactionRetries: override?.compactionRetries ?? config.compactionRetries
	};
}

export function shouldSyncBeforeCompaction(state, session, now = Date.now()) {
	const unsynced = Array.isArray(session?.log) && session.log.length > state.lastSyncedSeq;
	return unsynced || now - state.lastSyncMs >= SYNC_DEDUP_WINDOW_MS;
}

// Presets create separate engine instances in the same host process. Ledger
// commits still need one queue per project directory across those instances.
const sharedDirLocks = new Map();
const sharedRuntime = {
	syncing: new Set(),
	executed: new Map(),
	semanticState: new Map(),
	plans: new Map(),
	tierState: new Map(),
	inflight: new Set(),
	ledgerCache: new Map(),
	modelInfo: new Map(),
	degradedLogged: new Set(),
	history: new Map(),
	continuation: new Map(),
	budget: new Map()
};

class MarkdownMemoryCompactionEngine extends BasicCompactionEngine {
	static inject = [
		"llm",
		"tokenMeter",
		"sessions",
		"tools",
		"agents",
		"webServer"
	];
	static Config = z.object({
		// Base compaction keys — forwarded untouched; the base resolves and
		// validates them authoritatively in its constructor.
		thresholdRatio: z.number(),
		retainRatio: z.number(),
		retainTokens: z.number().step(1).min(0),
		summarizationProvider: z.string(),
		summarizationModel: z.string(),
		maxTokens: z.number().step(1).min(1),
		compactionRetries: z.number().step(1).min(0),
		maxOverflowRetries: z.number().step(1).min(0),
		modelPolicies: z.array(z.object({
			provider: z.string().required(),
			model: z.string().required(),
			thresholdRatio: z.number(),
			retainRatio: z.number(),
			retainTokens: z.number().step(1).min(0),
			summarizationProvider: z.string(),
			summarizationModel: z.string(),
			maxTokens: z.number().step(1).min(1),
			compactionRetries: z.number().step(1).min(0),
			maxOverflowRetries: z.number().step(1).min(0)
		})),
		auto: z.boolean(),
		// MML keys — optional by schemastery default (no .required()); in-code
		// defaults (MML_DEFAULTS) are applied in the constructor.
		enabled: z.boolean(),
		dirName: z.string(),
		syncEveryNTurns: z.number(),
		syncBeforeCompaction: z.boolean(),
		gitTracked: z.boolean(),
		injectAlways: z.boolean(),
		syncProvider: z.string(),
		syncModel: z.string(),
		syncMaxTokens: z.number(),
		// VAC-GC keys — flat (profile-safe), all optional; in-code defaults in
		// VACGC_DEFAULTS are applied in the constructor (§79–81, DEC-005).
		// "shadow" (default; read-only) | "prune" (Phase 2: lands TRASH fresh
		// prune). Any other value degrades to shadow (fail-safe).
		vacgcMode: z.string(),
		vacgcSemantic: z.boolean(),
		vacgcPressureSoftGc: z.number(),
		vacgcPressureColdCompact: z.number(),
		vacgcPressureWarmCompact: z.number(),
		vacgcPressureAggressive: z.number(),
		vacgcPressureEmergency: z.number(),
		vacgcPressureSafetyRatio: z.number(),
		vacgcPressureInjectionReserveRatio: z.number(),
		vacgcRecentRatio: z.number(),
		vacgcRecentMinTokens: z.number(),
		vacgcRecentMaxTokens: z.number(),
		vacgcReconstructibilityPenalty: z.number(),
		vacgcDuplicationPenalty: z.number(),
		vacgcHotEnter: z.number(),
		vacgcHotLeave: z.number(),
		vacgcWarmEnter: z.number(),
		vacgcWarmLeave: z.number(),
		vacgcMinReclaimRatio: z.number(),
		vacgcMinReclaimTokens: z.number(),
		vacgcMaxReclaimTokens: z.number(),
		vacgcSummaryMaxTokens: z.number(),
		vacgcRetryOnCoverageFailure: z.number(),
		vacgcMemoryEnabled: z.boolean(),
		vacgcRequireSyncForP1: z.boolean(),
		vacgcUiEnabled: z.boolean(),
		vacgcUiShowPerRequest: z.boolean(),
		vacgcMaxUnitsInPlan: z.number()
	});
	/** Resolved MML configuration (defaults applied). */
	mdMemory;
	/** Resolved VAC-GC configuration (defaults applied) — Phase 1 shadow. */
	vacgc;
	/** File-based ledger manager (shared across sessions). */
	ledger;
	/** In-flight sync keys (dir/sessionId) for deduplication. */
	syncing;
	/** Per-project-dir ledger write lock: Map<dir, settled Promise> (P0 concurrency). */
	#dirLocks;
	/** Official VAC-GC executions per session id for the UI (PLAN vs EXECUTED): {prune:{count,at}, official:{count,at}}. */
	#vacgcExecuted;
	/** Consecutive max-tokens turn-end count per session id (DEC-018). */
	#continueCounts;
	/** Latest shadow plan per session id (bounded; oldest evicted). */
	#vacgcPlans;
	/** Per-session tier state {generation, Map(unitId → tier)} for hysteresis. */
	#vacgcTierState;
	/** Session ids with a shadow plan in flight (dedupe turn-end bursts). */
	#vacgcInflight;
	/** Per-project-dir LedgerIndex cache (max-mtime signature, self-refreshing). */
	#vacgcLedgerCache;
	/** Resolved model info per "provider/model" (contextWindow/maxTokens). */
	#vacgcModelInfo;
	/** Session ids whose shadow planner degraded (logged once). */
	#vacgcDegradedLogged;
	/** §102 Context History: bounded shadow-plan point ring per session id. */
	#vacgcHistory;
	/** One-shot native summary cache used by the Phase 3 verifier. */
	#semanticSummary;
	/** Latest Phase 3 attempt diagnostics per session (bounded with executions). */
	#vacgcSemanticState;
	/** Reserved for host effect cleanup; native route policies are session snapshots. */
	#settingsDispose;
	/** Host-resolved policy table before profile route overlays. */
	#baseConfig;

	constructor(ctx, config = {}) {
		// Mount-time host-contract probe (deliverability audit 2026-09-12):
		// fail loud + actionable BEFORE super, so a host-API change surfaces
		// at session mount, not mid-turn. Compatible hosts pay 5 property
		// reads and never see this error.
		const problems = hostContractProblems(ctx, BasicCompactionEngine.prototype);
		if (problems.length) throw hostContractMismatchError(problems);
		const raw = { ...config };
		const mml = { ...MML_DEFAULTS };
		for (const key of MML_CONFIG_KEYS) {
			if (raw[key] !== undefined) mml[key] = raw[key];
			delete raw[key];
		}
		const vacgcPartial = vacgcPartialFromConfig(raw);
		for (const key of VACGC_CONFIG_KEYS) delete raw[key];
		super(ctx, raw);
		this.#baseConfig = this.config;
		// Cordis exposes plugin methods through a proxy on some hosts. A call
		// through that proxy has a different receiver and cannot access this
		// class's private locks/planner state. Bind the three host entry points
		// to the real instance before the host starts invoking them.
		this.compactNow = this.compactNow.bind(this);
		this.compactIfNeeded = this.compactIfNeeded.bind(this);
		this.summarize = this.summarize.bind(this);
		this.mdMemory = mml;
		this.vacgc = resolveVacGcConfig(vacgcPartial);
		this.ledger = new LedgerManager();
		this.syncing = sharedRuntime.syncing;
		this.#dirLocks = sharedDirLocks;
		this.#vacgcExecuted = sharedRuntime.executed;
		this.#vacgcSemanticState = sharedRuntime.semanticState;
		this.#continueCounts = new Map();
		this.#vacgcPlans = sharedRuntime.plans;
		this.#vacgcTierState = sharedRuntime.tierState;
		this.#vacgcInflight = sharedRuntime.inflight;
		this.#vacgcLedgerCache = sharedRuntime.ledgerCache;
		this.#vacgcModelInfo = sharedRuntime.modelInfo;
		this.#vacgcDegradedLogged = sharedRuntime.degradedLogged;
		this.#vacgcHistory = sharedRuntime.history;
		this.#semanticSummary = new WeakMap();
		// Native compaction policy fields are intentionally snapshotted when a
		// session engine is created.  Request-budget and continuation helpers read
		// the profile route live, so those controls take effect immediately while
		// native threshold/retention changes wait for a new session as advertised.
		this.#settingsDispose = undefined;
		this.#refreshSettingsPolicies();
		this.#provisionPresets();
		if (!mml.enabled) {
			this.ctx.logger.info("md-memory: disabled via config — running as plain BasicCompactionEngine");
			return;
		}
		this.#mountTools();
		this.#mountPrompt();
		this.#mountListeners();
		this.#mountAutoContinue();
		this.#mountBudgetGuards();
		this.#mountVacgcShadow();
		this.#mountRpc();
		this.ctx.logger.info(`md-memory: enabled (dirName=${mml.dirName}, syncEveryNTurns=${mml.syncEveryNTurns}, syncBeforeCompaction=${mml.syncBeforeCompaction}, vacgc=${this.vacgc.mode})`);
	}

	/** DEC-018: idempotent, failure-tolerant boot-time preset provisioning. */
	#provisionPresets() {
		provisionMmlPresets(this.ctx);
	}

	/**
	 * Per-project-dir ledger write lock (P0 concurrency): serializes every
	 * in-process ledger writer (turn sync, pre-compaction sync, manual sync)
	 * for the same dir. Only the settled tail is kept, so a finished lock
	 * retains nothing after its chain; a writer's rejection is reported to the
	 * caller without poisoning the next writer. Cross-process writers on the
	 * same project dir are covered by the revision check in LedgerManager.sync
	 * (LEDGER_REVISION_CONFLICT → one retry on a fresh base).
	 */
	#withDirLock(dir, fn) {
		const prev = this.#dirLocks.get(dir) ?? Promise.resolve();
		const run = prev.then(fn);
		const tail = run.catch(() => {});
		this.#dirLocks.set(dir, tail);
		tail.then(() => {
			if (this.#dirLocks.get(dir) === tail) this.#dirLocks.delete(dir);
		});
		return run;
	}

	/** Record an official VAC-GC execution for the UI (PLAN vs EXECUTED view). */
	#vacgcRecordExecuted(sid, kind, count) {
		const rec = this.#vacgcExecuted.get(sid) ?? { prune: { count: 0, at: null }, semantic: { count: 0, at: null }, official: { count: 0, at: null } };
		if (rec.semantic === undefined) rec.semantic = { count: 0, at: null };
		rec[kind].count += count;
		rec[kind].at = new Date().toISOString();
		this.#vacgcExecuted.set(sid, rec);
	}

	/** Keep the last Phase 3 gate/result visible when native fallback is used. */
	#vacgcRecordSemanticState(sid, state) {
		if (typeof sid !== "string" || sid.length === 0) return;
		this.#vacgcSemanticState.delete(sid);
		this.#vacgcSemanticState.set(sid, { ...state, at: new Date().toISOString() });
		while (this.#vacgcSemanticState.size > 32) this.#vacgcSemanticState.delete(this.#vacgcSemanticState.keys().next().value);
	}

	/**
	 * DEC-018 plugin-native max-tokens auto-continuation (replaces the
	 * dsh-agent-loop host patch). The turn loop appends a `turn/end` session
	 * event whose `reason.kind` is the terminal cause; when a turn ends at
	 * max-tokens we queue a visible "继续" user message on the agent's next
	 * turn — up to three consecutive, then the max-tokens end stands. Any
	 * other end kind resets the counter. `agent.followup` is the public API
	 * equivalent of the patched internal inbox splice: send(input,
	 * "next-turn", true) — inbox splice plus driver wake.
	 */
	#refreshSettingsPolicies() {
		const base = this.#baseConfig;
		if (base === undefined) return;
		const configured = settingsValue().routes ?? {};
		const native = ["thresholdRatio", "retainRatio", "retainTokens", "compactionRetries", "maxOverflowRetries"];
		const policies = (base.modelPolicies ?? []).filter((policy) => !Object.prototype.hasOwnProperty.call(configured, `${policy.provider}/${policy.model}`));
		for (const [key, route] of Object.entries(configured)) {
			const slash = key.indexOf("/");
			if (slash <= 0 || slash === key.length - 1 || route === null || typeof route !== "object") continue;
			const policy = { provider: key.slice(0, slash), model: key.slice(slash + 1) };
			let hasNative = false;
			for (const field of native) if (route[field] !== undefined) {
				policy[field] = route[field];
				hasNative = true;
			}
			if (hasNative) policies.push(policy);
		}
		this.config = { ...base, modelPolicies: policies };
	}

	/**
	 * Request-budget guards.  The stock compaction engine already owns the
	 * standard CONTEXT_WINDOW_EXCEEDED retry.  These listeners add projected
	 * input accounting (including the pending user batch), a safe maxTokens
	 * proposal, and a text-based compatibility fallback for older adapters.
	 */
	#mountBudgetGuards() {
		const pendingTokens = (messages) => {
			if (!Array.isArray(messages)) return 0;
			return messages.reduce((sum, message) => {
				try {
					const value = this.ctx.tokenMeter?.estimateMessage?.(message);
					if (Number.isFinite(value) && value >= 0) return sum + Math.ceil(value);
				} catch { /* fallback below */ }
				return sum + Math.ceil(JSON.stringify(message ?? "").length / 4);
			}, 0);
		};
		this.ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
			if (signal?.aborted) return next();
			const target = this.#agentTargetFor(agent.session);
			if (!target) return next();
			const caps = await this.#vacgcModelInfoCached(target);
			if (!caps) return next();
			const budget = budgetForRoute(target.provider, target.model, caps, this.config);
			let projected = 0;
			try { projected = this.ctx.tokenMeter.measure(agent.session).totalTokens + pendingTokens(messages); } catch { projected = pendingTokens(messages); }
			let safe = safeOutputBudget({
				targetContextTokens: budget.targetContextTokens,
				projectedInputTokens: projected,
				configuredMaxOutput: budget.maxOutputTokens,
				safetyMarginTokens: budget.safetyMarginTokens
			});
			let compactions = 0;
			const maxCompactions = Math.max(0, Math.trunc(Number(budget.compactionRetries ?? 0)));
			while (budgetNeedsCompaction({
				targetContextTokens: budget.targetContextTokens,
				projectedInputTokens: projected,
				configuredMaxOutput: budget.maxOutputTokens,
				safetyMarginTokens: budget.safetyMarginTokens
			}) && compactions < maxCompactions && !signal?.aborted) {
				const before = agent.session.surface?.replaceGeneration ?? 0;
				try { await this.compactIfNeeded(agent, "context-overflow", signal); } catch (error) {
					this.ctx.logger.warn(`md-memory: budget preflight compaction failed (${errMsg(error)})`);
					break;
				}
				const after = agent.session.surface?.replaceGeneration ?? 0;
				compactions += 1;
				if (after <= before) break;
				try { projected = this.ctx.tokenMeter.measure(agent.session).totalTokens + pendingTokens(messages); } catch { /* retain last estimate */ }
				safe = safeOutputBudget({ targetContextTokens: budget.targetContextTokens, projectedInputTokens: projected, configuredMaxOutput: budget.maxOutputTokens, safetyMarginTokens: budget.safetyMarginTokens });
			}
			const key = `${agent.session.id}:${turn}:${step}`;
			// A retry re-enters pre-step with the same request key. Preserve the
			// overflow counter so maxOverflowRetries cannot be reset by the
			// second budget measurement.
			const prior = sharedRuntime.budget.get(key);
			const record = { provider: target.provider, model: target.model, projectedInputTokens: projected, targetContextTokens: budget.targetContextTokens, configuredMaxOutput: budget.maxOutputTokens, safetyMarginTokens: budget.safetyMarginTokens, safeMaxOutput: safe, compactions, at: new Date().toISOString(), overflowRetries: prior?.overflowRetries ?? 0 };
			sharedRuntime.budget.set(key, record);
			while (sharedRuntime.budget.size > 128) sharedRuntime.budget.delete(sharedRuntime.budget.keys().next().value);
			if (safe <= 0) throw new Error(`context budget exhausted before model request: input=${projected}, target=${budget.targetContextTokens}, safety=${budget.safetyMarginTokens}; lower the prompt or target context`);
			return next();
		}, { prepend: true });

		this.ctx.on("agent/request", async ({ agent, turn, step }, next) => {
			const config = await next();
			if (config?.purpose === "compaction" || config?.purpose === "session-title") return config;
			const key = `${agent.session.id}:${turn}:${step}`;
			const record = sharedRuntime.budget.get(key);
			if (!record || !Number.isInteger(record.safeMaxOutput)) return config;
			const requested = Number.isInteger(config.maxTokens) ? config.maxTokens : record.configuredMaxOutput;
			const maxTokens = Math.min(requested, record.safeMaxOutput);
			if (maxTokens < 1) throw new Error(`context budget leaves no output token (input=${record.projectedInputTokens}, target=${record.targetContextTokens})`);
			if (maxTokens !== requested) this.ctx.logger.info(`md-memory: request budget clamped ${requested} → ${maxTokens} for ${record.provider}/${record.model}`);
			return { ...config, maxTokens };
		});

		this.ctx.on("agent/request-error", async ({ agent, failure, turn, step, signal }, next) => {
			const standardOverflow = failure?.code === "CONTEXT_WINDOW_EXCEEDED";
			// Older adapters disagree on the transport/error code (INVALID_REQUEST,
			// BAD_REQUEST, or no code), but preserve the useful text fallback.
			const legacyOverflow = looksLikeContextOverflow(failure?.message);
			if (signal?.aborted || (!standardOverflow && !legacyOverflow)) return next();
			const target = this.#agentTargetFor(agent.session);
			if (!target) return next();
			const caps = await this.#vacgcModelInfoCached(target);
			const budget = budgetForRoute(target.provider, target.model, caps ?? {}, this.config);
			const exactKey = `${agent.session.id}:${turn}:${step}`;
			// Keep the retry budget scoped to the current request. Falling back to
			// an unrelated latest session record can both consume the wrong retry
			// allowance and leave this request unbounded on older adapters.
			let existing = sharedRuntime.budget.has(exactKey)
				? [exactKey, sharedRuntime.budget.get(exactKey)]
				: null;
			if (existing === null) {
				const fallback = { provider: target.provider, model: target.model, projectedInputTokens: null, targetContextTokens: budget.targetContextTokens, configuredMaxOutput: budget.maxOutputTokens, safetyMarginTokens: budget.safetyMarginTokens, safeMaxOutput: null, compactions: 0, overflowRetries: 0, at: new Date().toISOString() };
				sharedRuntime.budget.set(exactKey, fallback);
				existing = [exactKey, fallback];
			}
			const retries = existing?.[1]?.overflowRetries ?? 0;
			if (retries >= (budget.maxOverflowRetries ?? 1)) return next();
			const before = agent.session.surface?.replaceGeneration ?? 0;
			try { await this.compactIfNeeded(agent, "context-overflow", signal); } catch (error) {
				this.ctx.logger.warn(`md-memory: legacy overflow recovery failed (${errMsg(error)})`);
				return next();
			}
			const after = agent.session.surface?.replaceGeneration ?? 0;
			if (after <= before) return next();
			if (existing) existing[1].overflowRetries = retries + 1;
			return { kind: "retry" };
		}, { prepend: true });
	}

	#mountAutoContinue() {
		this.ctx.on("session/event", (session, event) => {
			if (event?.type === "user/message") {
				// A real user message starts a new continuation series. The plugin's
				// own follow-up carries a source form so it does not clear its count.
				if (event.data?.source?.form !== "continuation") {
					this.#continueCounts.delete(session.id);
					sharedRuntime.continuation.delete(session.id);
				}
				return;
			}
			if (event?.type !== "turn/end") return;
			const kind = event?.data?.reason?.kind;
			if (kind !== "max-tokens") {
				this.#continueCounts.delete(session.id);
				sharedRuntime.continuation.delete(session.id);
				return;
			}
			const target = this.#agentTargetFor(session);
			const continuation = target ? routeSettings(target.provider, target.model).continuation : DEFAULT_CONTINUATION;
			const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null;
			// Some older hosts omit data.turn. The session event sequence is still
			// stable there and is the correct idempotency key for duplicate delivery.
			const eventSeq = Number.isSafeInteger(event?.seq) ? event.seq : null;
			const previous = sharedRuntime.continuation.get(session.id);
			if (previous?.reason === "max-tokens" && ((eventSeq !== null && previous.eventSeq === eventSeq) || (turn !== null && previous.turn === turn))) return;
			const count = (this.#continueCounts.get(session.id) ?? 0) + 1;
			const status = { enabled: continuation.enabled, count, maxCount: continuation.maxCount, prompt: continuation.prompt, reason: "max-tokens", queued: false, turn, eventSeq, at: new Date().toISOString() };
			sharedRuntime.continuation.set(session.id, status);
			if (!continuation.enabled || count > continuation.maxCount) {
				sharedRuntime.continuation.set(session.id, { ...status, reason: continuation.enabled ? "limit" : "disabled" });
				return;
			}
			this.#continueCounts.set(session.id, count);
			let agent;
			try {
				agent = this.ctx.agents?.get?.(session.id);
			} catch {
				return;
			}
			if (!agent || typeof agent.followup !== "function") {
				sharedRuntime.continuation.set(session.id, { ...status, reason: "host-followup-unavailable" });
				this.#continueCounts.delete(session.id);
				return;
			}
			try {
				agent.followup(createUserMessage({
					content: [{ type: "text", text: continuation.prompt }],
					source: { kind: "plugin", plugin: "dsh-md-memory", form: "continuation", summary: `max-tokens 自动续写 ${count}/${continuation.maxCount}` }
				}));
				sharedRuntime.continuation.set(session.id, { ...status, queued: true });
				this.ctx.logger.info(`md-memory: auto-continuation queued for ${session.id} (${count}/${continuation.maxCount})`);
			} catch (error) {
				this.ctx.logger.warn(`md-memory: auto-continuation failed (${errMsg(error)}); stopping continuation`);
				this.#continueCounts.delete(session.id);
				sharedRuntime.continuation.set(session.id, { ...status, reason: "queue-failed" });
			}
		});
	}

	/**
	 * VAC-GC observer/executor hook (DEC-002, DEC-005; Phase 2 application
	 * per §119): at each turn end, compute the value-aware plan for the
	 * session surface, cache it (tier hysteresis state + latest plan for the
	 * UI/RPC) and log a one-line summary. In `mode: "shadow"` (the V1.0
	 * default) the pass is READ-ONLY — the live calibrated compaction stays
	 * the behavior; the plan is the A/B record of what a value-aware engine
	 * WOULD have done. In `mode: "prune"` the pass additionally LANDS the
	 * TRASH fresh-prune replacements (turn-end only on a `fresh-prune`
	 * decision — §43/§119). §130: any internal failure degrades to a logged
	 * no-op (never blocks the turn, never mutates on error).
	 */
	#mountVacgcShadow() {
		this.ctx.on("session/event", (session, event) => {
			if (event?.type === "compaction/summary") {
				// Official base compaction: the EXECUTED counter behind the UI's
				// PLAN vs EXECUTED block (the shadow plan is advisory — the
				// official path still compacts the oldest prefix).
				if (session?.id) this.#vacgcRecordExecuted(session.id, "official", 1);
				return;
			}
			if (event?.type !== "turn/end") return;
			this.#runVacGc(session, "turn-end").catch(() => {});
		});
	}

	/**
	 * Execute one planner-selected semantic segment through the native durable
	 * compaction transaction. The native transaction still owns all surface
	 * validation, lifecycle markers, pairing checks, and persistence; this
	 * bridge only verifies the exact-fact contract before handing its already
	 * generated summary to the transaction through the one-shot cache below.
	 * Any verifier, memory, or surface error returns null so the caller can use
	 * the host compactor as the fail-safe path.
	 */
	async #executeSemantic(agent, session, plan, signal, isEmergency = false) {
		const sid = session?.id;
		if (this.vacgc?.semantic !== true) {
			this.#vacgcRecordSemanticState(sid, { status: "disabled", reason: "resolved config semantic=false", selected: plan?.selected?.id ?? null });
			return null;
		}
		if (plan?.decision?.action !== "compact" || plan.selected === null) {
			this.#vacgcRecordSemanticState(sid, { status: "not-selected", reason: `planner action=${plan?.decision?.action ?? "none"}`, selected: plan?.selected?.id ?? null });
			return null;
		}
		const selected = plan.selected;
		const measurement = calMeasureSession(session);
		const built = buildContextUnits({
			nodes: session.surface.nodes,
			eventAt: (seq) => session.eventAt(seq),
			prices: measurement.nodes,
			now: Date.now()
		});
		const selectedIds = new Set(selected.unitIds ?? []);
		const planRows = new Map((plan.units ?? []).map((row) => [row.unitId, row]));
		const units = built.units.filter((unit) => selectedIds.has(unit.id)).map((unit) => ({
			...unit,
			protection: planRows.get(unit.id)?.protection ?? "NORMAL"
		}));
		if (units.length === 0 || units.length !== selected.unitIds.length) {
			this.#vacgcRecordSemanticState(sid, { status: "skipped", reason: `selected units changed (${units.length}/${selected.unitIds.length})`, selected: selected.id });
			return null;
		}
		const seqs = units.flatMap((unit) => unit.seqs);
		if (seqs.length === 0 || seqs[0] !== selected.firstSeq || seqs[seqs.length - 1] !== selected.lastSeq) {
			this.#vacgcRecordSemanticState(sid, { status: "skipped", reason: `selected boundary changed (${seqs[0]}-${seqs[seqs.length - 1]})`, selected: selected.id });
			return null;
		}
		const input = this.#semanticInput(session, seqs);
		const dir = typeof session.header?.cwd === "string" && session.header.cwd.length > 0
			? join(session.header.cwd, this.mdMemory.dirName) : null;
		if (dir !== null) this.ledger.ensure(dir, this.mdMemory);
		const memoryText = dir === null ? "" : Object.values(this.ledger.readAll(dir)).join("\n");
		let generated;
		const events = [];
		let result;
		try {
			result = await runCompaction({
			units,
			eventAt: (seq) => session.eventAt(seq),
			memoryText,
			isEmergency,
			generateSummary: async () => {
				generated = await super.summarize(input, agent, signal);
				return (generated.summary ?? []).map((block) => block?.text ?? "").join("");
			},
			// The ordinary pre-compaction ledger sync runs before this verifier.
			// Emergency persistence is therefore represented in the verification
			// surface as an exact-fact pointer and never silently discarded.
			persistToMemory: async (facts, meta) => {
				if (dir !== null) this.ledger.ensure(dir, this.mdMemory);
				const refs = [...new Set(facts.filter((fact) => /^(?:REQ|STATE|DEC|TECH|ERR|BENCH|TASK)-[A-Z0-9_-]+/i.test(fact)))];
				this.ctx.logger.warn(`md-memory: VAC-GC semantic memory ${meta?.reason ?? "sync"}; facts=${facts.length} refs=${refs.length}`);
				return { refs, text: facts.join("\n") };
			},
			onEvent: (event) => events.push(event)
			});
		} catch (error) {
			this.#vacgcRecordSemanticState(sid, { status: "error", reason: errMsg(error), selected: selected.id });
			this.ctx.logger.warn(`md-memory: VAC-GC semantic executor failed for ${sid} (${errMsg(error)}); native compaction fallback`);
			return null;
		}
		if ((result.status !== "applied" && result.status !== "degraded") || generated === undefined) {
			this.#vacgcRecordSemanticState(sid, { status: result.status, reason: result.reason ?? "verification did not commit", selected: selected.id, attempts: result.attempts, events: events.map((event) => event.type) });
			this.ctx.logger.warn(`md-memory: VAC-GC semantic verification ${result.status} — native compaction fallback`);
			return null;
		}
		this.#semanticSummary.set(session, generated);
		try {
			const committed = await this.compactRegion(selected.firstSeq, selected.lastSeq, agent, signal);
			this.#vacgcRecordExecuted(session.id, "semantic", 1);
			this.#vacgcRecordSemanticState(sid, { status: "committed", selected: selected.id, attempts: result.attempts, events: events.map((event) => event.type), verification: result.status });
			this.ctx.logger.info(`md-memory: VAC-GC semantic committed ${session.id.slice(0, 8)} ${selected.id} status=${result.status} attempts=${result.attempts} events=${events.length}`);
			return { ...committed, semantic: true, verification: { status: result.status, attempts: result.attempts, events } };
		} finally {
			this.#semanticSummary.delete(session);
		}
	}

	/** Reconstruct the same replay input used by dsh-compaction-basic. */
	#semanticInput(session, seqs) {
		const header = session.requestHeader?.() ?? {};
		const first = session.surface?.nodes?.[0];
		const head = first === undefined ? null : session.eventAt(first);
		const system = head?.type === "system/message" ? session.deriveEventMessage(head) : null;
		const messages = seqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
		return {
			...(header.tools === undefined ? {} : { tools: header.tools }),
			messages: system === null ? messages : [system, ...messages]
		};
	}

	/**
	 * One value-aware planning pass for a session. Shadow mode: read-only.
	 * Prune mode: also lands the surviving TRASH fresh-prune actions.
	 * @param session - session to plan.
	 * @param trigger - "turn-end" | "pre-compact".
	 * @returns the landed-replacement summary ({landed, charsSaved}) or null
	 *          when nothing was (or could be) applied.
	 */
	async #runVacGc(session, trigger, ownerAgent = null, signal = undefined) {
		const mode = this.vacgc?.mode;
		const sid = session?.id;
		if (typeof sid !== "string" || sid.length === 0) return null;
		if (this.#vacgcInflight.has(sid)) return null; // dedupe turn-end bursts
		this.#vacgcInflight.add(sid);
		try {
			const target = calRoutedTarget(session);
			if (target === undefined) return null;
			const info = await this.#vacgcModelInfoCached(target);
			if (info === null) return null; // unresolvable model: skip this pass
			const budget = budgetForRoute(target.provider, target.model, info, this.config);
			const effectiveWindow = budget.targetContextTokens || info.contextWindow;
			const effectiveOutput = budget.maxOutputTokens || info.maxTokens;
			const measurement = calMeasureSession(session);
			const plan = planVacGc({
				nodes: session.surface.nodes,
				eventAt: (seq) => session.eventAt(seq),
				prices: measurement.nodes,
				now: Date.now(),
				query: this.#vacgcQueryText(session),
				memory: this.vacgc.memory.enabled && typeof session.header?.cwd === "string" && session.header.cwd.length > 0
					? getLedgerIndex(join(session.header.cwd, this.mdMemory.dirName), this.#vacgcLedgerCache)
					: null,
				contextWindow: effectiveWindow,
				inputTokens: measurement.totalTokens,
				requestedMaxOutput: effectiveOutput,
				previousTiers: this.#vacgcPreviousTiers(session),
				config: this.vacgc,
				trigger,
				sessionId: sid
			});
			this.#vacgcRecordPlan(session, plan);
			const tierCounts = plan.tiers ? Object.entries(plan.tiers).map(([tier, s]) => `${tier}:${s.count}`).join(" ") : "";
			this.ctx.logger.info(`md-memory: vacgc ${mode} ${sid.slice(0, 8)} ${trigger} zone=${plan.pressure?.zone} soft=${plan.pressure?.soft} hard=${plan.pressure?.hard} in=${plan.pressure?.inputTokens}/${effectiveWindow} tiers=[${tierCounts}] selected=${plan.selected?.id ?? "none"} action=${plan.decision?.action} (${plan.meta?.elapsedMs}ms)`);
			// Phase 3 semantic execution is only safe inside the automatic
			// open-turn transaction. turn-end remains an observation point;
			// context-overflow is marked emergency so the executor can persist
			// exact facts before allowing a degraded replacement.
			if ((trigger === "pre-compact" || trigger === "context-overflow") && plan.decision?.action === "compact") {
				this.#vacgcRecordSemanticState(sid, {
					status: "gated",
					reason: `trigger=${trigger}; semantic=${this.vacgc?.semantic === true}; owner=${ownerAgent !== null ? "provided" : "lookup"}`,
					selected: plan.selected?.id ?? null
				});
				if (this.vacgc?.semantic !== true) {
					this.#vacgcRecordSemanticState(sid, { status: "disabled", reason: "resolved config semantic=false", selected: plan.selected?.id ?? null });
				} else {
					const semanticAgent = ownerAgent ?? this.#agentFor(session);
					if (semanticAgent !== undefined && semanticAgent !== null) {
						const semantic = await this.#executeSemantic(semanticAgent, session, plan, signal, trigger === "context-overflow");
						if (semantic !== null) return semantic;
					} else {
						this.#vacgcRecordSemanticState(sid, { status: "skipped", reason: "automatic compaction has no owning agent", selected: plan.selected?.id ?? null });
					}
				}
			}
			// Phase 2 application (§119): TRASH fresh prune only. Only the
			// known mutating mode "prune" lands actions — "shadow" (and any
			// future/unknown value such as "full" before its phase lands)
			// stays read-only (fail-safe). A turn-end pass applies only on a
			// "fresh-prune" decision (Z1 — §43); a pre-compact pass always
			// applies (we are already above the calibrated threshold).
			if (mode === "prune" && plan.freshPrune?.actions?.length > 0
				&& (trigger === "pre-compact" || plan.decision?.action === "fresh-prune")) {
				try {
					const priceBySeq = new Map(measurement.nodes.map((n) => [n.seq, n.tokens]));
					const nodes = planNodePrunes(plan, {
						surfaceSeqs: session.surface.nodes,
						eventAt: (seq) => session.eventAt(seq)
					});
					if (nodes.length > 0) {
						// SHADOW-PRICE CONTRACT (dsh-token-meter/surface-projection):
						// the claim must be the host meter's FIXED heuristic price
						// of the replaced node — the fold consumes it against its
						// own estimator and the contextBreakdown stateSchema
						// forbids negative messageTokens. A calibrated claim
						// (denser for CJK/code) would drain the fold below zero
						// at the next compaction → gateway/internal on history
						// load. pickShadowPrice picks the meter's estimator
						// (a required BasicCompactionEngine dependency in the
						// live host); the calibrated price is the no-meter
						// fallback only (landNodePrunes clamps bad values to
						// the flat 4-chars/token rate).
						const meter = this.ctx.tokenMeter;
						const summary = landNodePrunes(session, nodes, (event) => pickShadowPrice(meter, event, (e) => priceBySeq.get(e.seq) ?? 0));
						this.ctx.logger.info(`md-memory: vacgc prune ${sid.slice(0, 8)} ${trigger} landed=${summary.landed.length} charsSaved=${summary.charsSaved}`);
						this.#vacgcRecordExecuted(sid, "prune", summary.landed.length);
						return summary;
					}
				} catch (error) {
					// §130: a failed apply degrades to shadow until the next
					// trigger (earlier landings in the pass stay durable).
					this.ctx.logger.warn(`md-memory: vacgc prune apply failed for ${sid.slice(0, 8)} (${errMsg(error)}); shadow-only until next trigger`);
				}
			}
			return null;
		} catch (error) {
			if (!this.#vacgcDegradedLogged.has(sid)) {
				this.#vacgcDegradedLogged.add(sid);
				this.ctx.logger.warn(`md-memory: vacgc planner degraded for ${sid} (${errMsg(error)}); no-op until next trigger`);
			}
			return null;
		} finally {
			this.#vacgcInflight.delete(sid);
		}
	}

	/** Resolved model capacity per "provider/model" (cache; failures retry). */
	async #vacgcModelInfoCached(target) {
		const key = `${target.provider}/${target.model}`;
		const hit = this.#vacgcModelInfo.get(key);
		if (hit !== undefined) return hit;
		let resolved;
		try {
			const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, AbortSignal.timeout(5000));
			resolved = { contextWindow: info.context?.contextWindow ?? 0, maxTokens: info.defaultMaxTokens ?? 0 };
		} catch {
			return null; // shadow skip — never block a turn on model metadata
		}
		if (!Number.isInteger(resolved.contextWindow) || resolved.contextWindow <= 0) return null;
		this.#vacgcModelInfo.set(key, resolved);
		return resolved;
	}

	/** §16–19 active query: last live user message (not a checkpoint). */
	#vacgcQueryText(session) {
		const nodes = session.surface?.nodes ?? [];
		for (let i = nodes.length - 1; i >= 0; i -= 1) {
			const event = session.eventAt?.(nodes[i]);
			if (event?.type !== "user/message") continue;
			if (Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0) continue; // checkpoint
			const content = event.data?.content;
			let text;
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
			else text = "";
			if (text.trim().length > 0) return text.slice(0, 2000);
		}
		return "";
	}

	/** Tier map for hysteresis — only valid for the current surface generation. */
	#vacgcPreviousTiers(session) {
		const state = this.#vacgcTierState.get(session.id);
		if (state === undefined) return null;
		const generation = session.surface?.replaceGeneration ?? null;
		return state.generation === generation ? state.tiers : null;
	}

	/** Store the latest plan (bounded LRU) + the next plan's tier state. */
	#vacgcRecordPlan(session, plan) {
		if (plan === null || plan === undefined) return;
		const plans = this.#vacgcPlans;
		plans.delete(session.id);
		plans.set(session.id, plan);
		// §102 Context History: one slim point per plan (same generatedAt
		// replaces; ring capped at HISTORY_CAP).
		const points = this.#vacgcHistory.get(session.id) ?? [];
		appendVacGcHistory(points, plan, HISTORY_CAP);
		this.#vacgcHistory.set(session.id, points);
		while (plans.size > 32) {
			const oldest = plans.keys().next().value;
			if (oldest === undefined) break;
			plans.delete(oldest);
			this.#vacgcHistory.delete(oldest);
		}
		const tiers = new Map((plan.units ?? []).map((row) => [row.unitId, row.tier]));
		this.#vacgcTierState.set(session.id, { generation: session.surface?.replaceGeneration ?? null, tiers });
	}

	/**
	 * Manual /compact guard (Phase 2a): when the selected compactable span
	 * is below MIN_MANUAL_COMPACT_SPAN_TOKENS calibrated tokens, return
	 * null without calling the summarizer — the command layer renders null
	 * as the gentle "No compactable history yet." instead of spending an
	 * LLM call on a span a verbose model cannot shrink (the base engine's
	 * shrink guard would refuse the summary and surface "could not produce
	 * a useful summary" with the conversation unchanged — the exact
	 * failure a manual /compact on a fresh session used to hit). The
	 * pre-check is read-only and calibrated (calMeasureSession, the
	 * engine's authoritative price for this deployment); any failure falls
	 * through to the untouched base selection, which stays authoritative.
	 * @param agent - idle agent whose next-turn admission this call reserves.
	 * @param signal - cancellation scoped to this compaction request.
	 * @param sourceCommandId - initiating command identity for presentation correlation.
	 * @returns the committed result, or `null` when no useful range exists.
	 */
	compactNow(agent, signal, sourceCommandId) {
		signal.throwIfAborted();
		try {
			const measurement = calMeasureSession(agent.session);
			const range = selectCalibratedRange(agent.session, measurement, 0);
			if (range !== null && shouldSkipManualCompact(measurement.nodes, range)) {
				this.ctx.logger.info(`md-memory: manual compact skipped: compactable span ${spanTokens(measurement.nodes, range)} tokens < ${MIN_MANUAL_COMPACT_SPAN_TOKENS} minimum`);
				return null;
			}
		} catch (error) {
			this.ctx.logger.warn(`md-memory: manual compact pre-check failed (${errMsg(error)}); using the base selection`);
		}
		return super.compactNow(agent, signal, sourceCommandId);
	}

	/**
	 * DEC-018 calibrated pressure pre-check (replaces the host meter patch).
	 * The host's flat 4-chars/token meter under-prices CJK text and dense
	 * code/JSON by ~2x on this deployment's workload, so its pressure trigger
	 * sat below the provider's 400 line. On the "pressure" trigger only, the
	 * engine first prices the whole session with the calibrated densities;
	 * when the calibrated total crosses the target's threshold it runs the
	 * same retry loop the base runs — with the calibrated range selection —
	 * through the public `compactRegion`. Everything else (the
	 * context-overflow recovery trigger, or a session below threshold even
	 * calibrated) falls through to the untouched base path, which still
	 * carries the host's native overflow recovery as the safety net.
	 * @param agent - agent whose latest durable routed request is measured.
	 * @param trigger - normal step-boundary pressure or context-overflow recovery.
	 * @param signal - live turn cancellation signal forwarded to summarization.
	 * @returns the latest summary compaction result, or `null`.
	 */
	async compactIfNeeded(agent, trigger, signal) {
		if (this.mdMemory?.enabled !== true) return super.compactIfNeeded(agent, trigger, signal);
		if (trigger === "context-overflow" && this.vacgc?.semantic === true) {
			try {
				const semantic = await this.#runVacGc(agent.session, "context-overflow", agent, signal);
				if (semantic !== null) return semantic;
			} catch {
				// The native overflow path remains the final recovery guard.
			}
			return super.compactIfNeeded(agent, trigger, signal);
		}
		if (trigger !== "pressure") return super.compactIfNeeded(agent, trigger, signal);
		let spec;
		let measurement;
		try {
			const target = calRoutedTarget(agent.session);
			if (target === undefined) return super.compactIfNeeded(agent, trigger, signal);
			const modelInfo = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
			const context = modelInfo.context;
			if (context === undefined || context.contextWindow === undefined) return super.compactIfNeeded(agent, trigger, signal); // base throws its TargetPressureConfigError as usual
			const caps = { contextWindow: context.contextWindow, maxTokens: modelInfo.defaultMaxTokens ?? 0 };
			const budget = budgetForRoute(target.provider, target.model, caps, this.config);
			spec = this.#calibratedSpec(target, budget.targetContextTokens || context.contextWindow);
			measurement = calMeasureSession(agent.session);
		} catch (error) {
			// Calibration must never block a turn: fall back to the host path.
			this.ctx.logger.warn(`md-memory: calibrated pressure check failed (${errMsg(error)}); using the host meter path`);
			return super.compactIfNeeded(agent, trigger, signal);
		}
		if (measurement.totalTokens < spec.thresholdTokens) return super.compactIfNeeded(agent, trigger, signal);
		// Above the calibrated threshold: run the base's retry loop shape with
		// the calibrated measurement and range selection.
		try {
			this.ctx.logger.info(`md-memory: calibrated pressure ${measurement.totalTokens} >= ${spec.thresholdTokens} (${spec.targetKey}); preemptive compaction`);
			const prune = this.ctx.get("toolResultPruner");
			if (prune !== undefined) {
				prune.pruneSession(agent.session);
				measurement = calMeasureSession(agent.session);
			}
			if (this.vacgc?.mode !== "prune") {
				// VAC-GC shadow (default): record what a value-aware engine
				// WOULD have done on this exact surface (A/B data; read-only,
				// DEC-002). Unknown/future modes also stay non-blocking.
				this.#runVacGc(agent.session, "pre-compact", agent, signal).catch(() => {});
			} else {
				// Phase 2 (§119): land the TRASH fresh prune on the
				// POST-official-prune surface — the plan must not see nodes
				// the official pruner already rewrote — then re-measure so
				// the compaction range selection below uses the post-
				// application size.
				try {
					const summary = await this.#runVacGc(agent.session, "pre-compact", agent, signal);
					if (summary?.semantic === true) return summary;
					if (summary !== null && summary.landed?.length > 0) measurement = calMeasureSession(agent.session);
				} catch {
					// §130: #runVacGc already logged; the base path proceeds.
				}
			}
			let result = null;
			for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
				const range = selectCalibratedRange(agent.session, measurement, spec.retainTokens);
				if (range === null) {
					if (result === null) return null;
					break;
				}
				result = await this.compactRegion(range.start, range.end, agent, signal);
				measurement = calMeasureSession(agent.session);
				if (measurement.totalTokens < spec.thresholdTokens) return result;
			}
			throw new Error(`compaction still above calibrated threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
		} catch (error) {
			this.ctx.logger.warn(`md-memory: calibrated compaction failed (${errMsg(error)}); falling back to the host meter path`);
			return super.compactIfNeeded(agent, trigger, signal);
		}
	}

	/**
	 * Mirror of the base's per-target policy resolution (find an exact
	 * provider/model override, else the engine defaults) without reaching
	 * into private base helpers.
	 * @param target - exact routed provider/model.
	 * @param contextWindow - adapter-owned capacity for that target.
	 * @returns {targetKey, thresholdTokens, retainTokens, compactionRetries}.
	 */
	#calibratedSpec(target, contextWindow) {
		return resolveCalibratedSpec(this.config, target, contextWindow);
	}

	/** Sole base subclass hook: sync the ledger, then base summarization. */
	async summarize(input, agent, signal) {
		const cached = agent?.session === undefined ? undefined : this.#semanticSummary.get(agent.session);
		if (cached !== undefined) {
			this.#semanticSummary.delete(agent.session);
			return cached;
		}
		const mml = this.mdMemory;
		if (mml.enabled && mml.syncBeforeCompaction) {
			const session = agent?.session;
			const cwd = session?.header?.cwd;
			if (typeof cwd === "string" && cwd.length > 0) {
				const dir = join(cwd, mml.dirName);
				const key = `${dir}/${session.id}`;
				const state = this.ledger.loadState(dir, session.id);
				if (shouldSyncBeforeCompaction(state, session) && !this.syncing.has(key)) {
					this.syncing.add(key);
					try {
						const agentTarget = agent?.options?.provider && agent?.options?.model ? { provider: agent.options.provider, model: agent.options.model } : undefined;
						const result = await this.#withDirLock(dir, () => this.ledger.sync(this.ctx, mml, dir, session, { source: "compaction", input, agentTarget }));
						this.ctx.logger.info(`md-memory: pre-compaction sync ${result.skipped ? `skipped (${result.skipped})` : `wrote ${result.written.length ? result.written.join(", ") : "INDEX.md"}${result.issues.length ? `, integrity: ${result.issues.length} issue(s)` : ""}`}`);
					} catch (error) {
						this.ctx.logger.warn(`md-memory: pre-compaction sync failed (${errMsg(error)}); continuing with base compaction`);
					} finally {
						this.syncing.delete(key);
					}
				}
			}
		}
		return super.summarize(input, agent, signal);
	}

	/** memory_search / memory_read model-facing tools. */
	#mountTools() {
		const mml = this.mdMemory;
		const rootOf = (exec) => {
			const cwd = exec?.agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) throw new Error("memory tools require an agent session with a working directory");
			const dir = join(cwd, mml.dirName);
			if (!existsSync(dir)) this.ledger.ensure(dir, mml); // DEC-014: seed on first tool use too
			return dir;
		};
		this.ctx.tools.register(defineTool({
			name: "memory_search",
			description: "Search this project's persistent Markdown memory ledger (.dsh-memory/*.md: PROJECT/STATE/DECISIONS/TECH/HISTORY/CONFLICTS). Use before major decisions, when choosing a technical approach, or when a topic was likely covered in an earlier (possibly compacted) conversation. Line-based keyword search; all space-separated terms must match on the same line.",
			// dsh-tools `parameters` is an implicit property MAP (name → value
			// schema object), not a JSON-Schema document: per-property
			// `required: true`, no top-level type/properties/required array.
			parameters: {
				query: { type: "string", required: true, description: "Space-separated keywords (case-insensitive substring match)." },
				file: { type: "string", enum: [...LEDGER_FILES], description: "Optional: restrict to one ledger file." },
				limit: { type: "integer", description: "Maximum results (default 10, cap 50)." }
			},
			output: {
				schema: { type: "object", additionalProperties: true },
				render: (_args, value) => [{ type: "text", text: value.results.length ? value.results.map((r) => `- ${r.file}:${r.line}${r.entryId ? ` [${r.entryId}]` : ""} ${r.text.slice(0, 240)}`).join("\n") : value.note ?? "No matches in the project memory ledger." }]
			},
			execute: (args, exec) => {
				const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 10)), 50);
				return this.ledger.search(rootOf(exec), String(args.query), typeof args.file === "string" ? args.file : undefined, limit);
			},
			presentCall: () => ({ card: "generic", title: "Search project memory", kind: "search" }),
			presentResult: () => ({ card: "generic", title: "Project memory search" })
		}));
		this.ctx.tools.register(defineTool({
			name: "memory_read",
			description: "Read one ledger file from this project's persistent Markdown memory (.dsh-memory) — whole file, or a single entry by id (e.g. DEC-001). Use after memory_search to get the full entry context.",
			parameters: {
				file: { type: "string", required: true, enum: [...LEDGER_FILES], description: "Which ledger file to read." },
				entry: { type: "string", description: "Optional entry id (e.g. DEC-001, REQ-002, CONFLICT-001, or STATE-CURRENT). Omit to read the whole file." }
			},
			output: {
				schema: { type: "object", additionalProperties: true },
				render: (_args, value) => [{ type: "text", text: `# ${value.file}${value.entryId ? ` — [${value.entryId}]` : ""}\n\n${value.content}` }]
			},
			execute: (args, exec) => this.ledger.read(rootOf(exec), String(args.file), typeof args.entry === "string" ? args.entry : undefined),
			presentCall: () => ({ card: "generic", title: "Read project memory", kind: "search" }),
			presentResult: () => ({ card: "generic", title: "Project memory" })
		}));
	}

	/**
	 * Per-agent project-memory prompt contribution. Register in this preset
	 * row's scope at mount time, before a complete persona is rendered. Each
	 * assembly supplies its agent, so the content still follows that agent's
	 * latest user message and working directory.
	 */
	#mountPrompt() {
		try {
			const scope = this.ctx.get("systemPrompt");
			if (!scope || typeof scope.context !== "function") {
				this.ctx.logger.warn("md-memory: systemPrompt service unavailable; memory context not installed");
				return;
			}
			// Install at preset mount, before the first prompt is assembled.
			// agent/created can be dispatched outside this row's child scope on
			// DSH 2.0.9, leaving a complete minimal persona's {{md_memory}}
			// unresolved. The provider receives the actual agent at assembly time.
			const text = ({ agent } = {}) => {
				const session = agent?.session;
				const cwd = session?.header?.cwd;
				if (typeof cwd !== "string" || cwd.length === 0) return "";
				return this.ledger.promptContext(join(cwd, this.mdMemory.dirName), this.mdMemory, session);
			};
			this.ctx.effect(() => {
				const disposers = [scope.context({ name: "mdMemory:project", order: 20, text })];
				if (typeof scope.variable === "function") disposers.push(scope.variable("md_memory", text));
				return () => {
					for (const dispose of disposers) dispose?.();
				};
			}, "dsh-md-memory.prompt()");
		} catch (error) {
			this.ctx.logger.warn(`md-memory: prompt context install failed (${errMsg(error)})`);
		}
	}

	/** Turn counter: every syncEveryNTurns turns, sync the delta. */
	#mountListeners() {
		const every = Math.max(1, Math.trunc(this.mdMemory.syncEveryNTurns) || 1);
		this.ctx.on("session/event", (session, event) => {
			if (event?.type !== "turn/end") return;
			// DEC-017: session/event is scope-filtered (carrier keyed to the
			// session's agent scope), so this listener only ever receives this
			// realm's sessions; #agentFor's session-id match is a backstop.
			if (this.#agentFor(session) === undefined) return;
			const cwd = session.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return;
			const dir = join(cwd, this.mdMemory.dirName);
			const key = `${dir}/${session.id}`;
			if (this.syncing.has(key)) return;
			const state = this.ledger.loadState(dir, session.id);
			state.turns += 1;
			// A clear project goal/requirement is durable evidence, not ordinary
			// turn noise. Sync it immediately so short sessions do not lose the
			// only message that can seed PROJECT.md.
			const goalSignal = MEMORY_INTENT.projectGoal.test(lastUserText(session));
			const due = state.turns >= every || goalSignal;
			if (!due) {
				// Persist the counter periodically so restarts do not reset it
				// before the threshold.
				if (state.turns % 5 === 0) this.ledger.saveState(dir, session.id, state);
				return;
			}
			this.syncing.add(key);
			state.turns = 0;
			this.ledger.saveState(dir, session.id, state);
			const agentTarget = this.#agentTargetFor(session);
			void this.#withDirLock(dir, () => this.ledger.sync(this.ctx, this.mdMemory, dir, session, { source: goalSignal ? "goal" : "turns", agentTarget }))
				.then((result) => {
					this.ctx.logger.info(`md-memory: turn sync ${result.skipped ? `skipped (${result.skipped})` : `wrote ${result.written.length} file(s)`}`);
				})
				.catch((error) => {
					this.ctx.logger.warn(`md-memory: turn sync failed (${errMsg(error)})`);
				})
				.finally(() => {
					this.syncing.delete(key);
				});
		});
	}

	/**
	 * The live runtime agent for a session, or undefined.
	 *
	 * Session ids are globally unique and each live session has exactly one
	 * runtime agent, and the registry indexes live agents by that same id
	 * (agent.id === agent.session.id), so `agents.get(session.id)` is a
	 * complete direct lookup — no roots() scan, no identity predicate. (Cordis
	 * `ctx.get()` wraps services in a fresh traceable proxy per call, so any
	 * `=== engine` test on a service read is always false — FAIL-009 — but a
	 * method call on the injected registry is safe.)
	 */
	#agentFor(session) {
		try {
			return this.ctx.agents?.get?.(session.id) ?? undefined;
		} catch {
			// agent registry not ready
		}
		return undefined;
	}

	/** Best-effort agent options target for turn-based sync LLM routing. */
	#agentTargetFor(session) {
		const agent = this.#agentFor(session);
		return agent?.options?.provider && agent?.options?.model ? { provider: agent.options.provider, model: agent.options.model } : undefined;
	}

	/** Report the live host surfaces used by the budget enhancements. */
	#budgetCapabilities() {
		const hasEvents = typeof this.ctx.on === "function";
		const hasMeter = typeof this.ctx.tokenMeter?.measure === "function" && typeof this.ctx.tokenMeter?.estimateMessage === "function";
		const hasModelInfo = typeof this.ctx.llm?.resolveModelInfo === "function";
		const hasAgents = typeof this.ctx.agents?.get === "function";
		return {
			settings: settingsDescriptor().available,
			budgetPreflight: hasEvents && hasMeter && hasModelInfo,
			requestClamp: hasEvents,
			overflowRecovery: hasEvents && typeof this.compactIfNeeded === "function",
			autoContinuation: hasEvents && hasAgents
		};
	}

	/** Web UI surface: status/read/search/sync/vacgc.* over the host RPC channel. */
	#mountRpc() {
		// connection.rpc.handle registers through the caller's webServer service.
		// Both must be injected into this callback's Cordis context.
		this.ctx.inject?.(["connection", "webServer"], (webCtx) => {
			if (webCtx?.connection === undefined) {
				this.ctx.logger.warn("md-memory: no 'connection' service in this realm; /dsh-md-memory RPC route NOT registered (Web UI panels will be empty)");
				return;
			}
			const ok = (value) => ({ ok: true, value });
			const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });
			try {
				const handleRpc = async (endpoint, payload) => {
				let resolved;
				try {
					resolved = await resolveRpcSession(this.ctx, payload);
					const session = resolved.session;
					switch (endpoint) {
					case "status": {
						const cwd = session.header?.cwd;
							const dir = typeof cwd === "string" && cwd ? join(cwd, this.mdMemory.dirName) : null;
							// List ONLY the known ledger files (internal files
							// like .gitignore/.state.json are not viewer
							// content — reading them through /read throws).
							const files = dir && existsSync(dir) ? LEDGER_FILES.filter((name) => existsSync(join(dir, name))).map((name) => {
								const st = statSync(join(dir, name));
								return { name, size: st.size, mtime: st.mtime.toISOString() };
							}) : [];
							const state = dir ? this.ledger.loadState(dir, session.id) : null;
							const all = dir && existsSync(dir) ? this.ledger.readAll(dir) : null;
							const activeConflicts = all
								? parseEntries(all["CONFLICTS.md"]).filter((entry) => (entry.status ?? "ACTIVE") === "ACTIVE").map((entry) => ({ id: entry.id, title: entry.title }))
								: [];
							return ok({
								enabled: this.mdMemory.enabled,
								config: this.mdMemory,
								ledgerDir: dir,
								exists: Boolean(dir && existsSync(dir)),
								files,
								state,
								activeConflicts
							});
						}
					case "settings/get": {
						const configuredTarget = this.#agentTargetFor(session);
						const headerTarget = session.requestHeader?.()?.config;
						const target = configuredTarget ?? (headerTarget?.provider && headerTarget?.model ? { provider: headerTarget.provider, model: headerTarget.model } : null);
						if (!target) return fail("NO_ROUTE", "the session has no provider/model route");
						const caps = await this.#vacgcModelInfoCached(target) ?? { contextWindow: 0, maxTokens: 0 };
						const effective = budgetForRoute(target.provider, target.model, caps, this.config);
						const descriptor = settingsDescriptor();
						return ok({
							route: target,
							capabilities: this.#budgetCapabilities(),
							hard: caps,
							configured: routeSettings(target.provider, target.model).configured,
							effective,
							revision: descriptor.revision,
							// Budget guards read these values at every pre-step.  Only
							// native compaction policy fields wait for a fresh session;
							// the UI can therefore tell the user exactly what takes effect
							// immediately after saving.
							pendingRestart: ["thresholdRatio", "retainRatio", "retainTokens", "compactionRetries", "maxOverflowRetries"]
						});
					}
					case "settings/set": {
						const configuredTarget = this.#agentTargetFor(session);
						const headerTarget = session.requestHeader?.()?.config;
						const target = configuredTarget ?? (headerTarget?.provider && headerTarget?.model ? { provider: headerTarget.provider, model: headerTarget.model } : null);
						if (!target) return fail("NO_ROUTE", "the session has no provider/model route");
						const caps = await this.#vacgcModelInfoCached(target) ?? { contextWindow: 0, maxTokens: 0 };
						const settingsCaps = { ...caps, defaultThresholdRatio: this.config.thresholdRatio, defaultRetainRatio: this.config.retainRatio, defaultRetainTokens: this.config.retainTokens };
						const patch = payload?.patch && typeof payload.patch === "object" ? payload.patch : (() => {
							const { sessionId: _sessionId, expectedRevision: _expectedRevision, ...rest } = payload ?? {};
							return rest;
						})();
						const expectedRevision = payload?.expectedRevision === undefined ? undefined : Number(payload.expectedRevision);
						await updateRouteSettings(target.provider, target.model, patch, Number.isInteger(expectedRevision) ? expectedRevision : undefined, settingsCaps);
						return ok({ saved: true, route: target, revision: settingsDescriptor().revision, configured: routeSettings(target.provider, target.model).configured });
					}
					case "settings/reset": {
						const configuredTarget = this.#agentTargetFor(session);
						const headerTarget = session.requestHeader?.()?.config;
						const target = configuredTarget ?? (headerTarget?.provider && headerTarget?.model ? { provider: headerTarget.provider, model: headerTarget.model } : null);
						if (!target) return fail("NO_ROUTE", "the session has no provider/model route");
						const expectedRevision = payload?.expectedRevision === undefined ? undefined : Number(payload.expectedRevision);
						await resetRoute(target.provider, target.model, Number.isInteger(expectedRevision) ? expectedRevision : undefined);
						return ok({ saved: true, route: target, revision: settingsDescriptor().revision, configured: {} });
					}
					case "settings/status": {
						const continuation = sharedRuntime.continuation.get(session.id) ?? null;
						const budgets = [...sharedRuntime.budget.entries()].filter(([key]) => key.startsWith(`${session.id}:`)).slice(-4).map(([, value]) => value);
						return ok({ continuation, budgets });
					}
					case "read": {
						const cwd = session.header?.cwd;
							const dir = join(cwd, this.mdMemory.dirName);
							return ok(this.ledger.read(dir, String(payload?.file ?? ""), typeof payload?.entry === "string" ? payload.entry : undefined));
						}
					case "search": {
						const cwd = session.header?.cwd;
							const dir = join(cwd, this.mdMemory.dirName);
							const limit = Math.min(Math.max(1, Math.trunc(Number(payload?.limit) || 10)), 50);
							return ok(this.ledger.search(dir, String(payload?.query ?? ""), typeof payload?.file === "string" ? payload.file : undefined, limit));
						}
					case "sync": {
						const cwd = session.header?.cwd;
							if (typeof cwd !== "string" || !cwd) return fail("NO_SESSION", "no session working directory");
							const dir = join(cwd, this.mdMemory.dirName);
							const key = `${dir}/${session.id}`;
							if (this.syncing.has(key)) return fail("BUSY", "a memory sync is already running for this session");
							this.syncing.add(key);
							try {
								const result = await this.#withDirLock(dir, () => this.ledger.sync(this.ctx, this.mdMemory, dir, session, { source: "manual", agentTarget: this.#agentTargetFor(session) }));
								return ok(result);
							} finally {
								this.syncing.delete(key);
							}
						}
					case "vacgc/plan": {
						// VAC-GC Phase 1: latest shadow plan for a session
						// (unit table + pressure + tiers + selection). Read-only.
						const plan = this.#vacgcPlans.get(session.id) ?? null;
							return ok({ mode: this.vacgc?.mode ?? "shadow", plan, config: this.vacgc ?? VACGC_DEFAULTS });
						}
					case "vacgc/tiers": {
						// Tier distribution for the session's last shadow plan.
						const plan = this.#vacgcPlans.get(session.id) ?? null;
							return ok({ tiers: plan?.tiers ?? null, unitCount: plan?.unitCount ?? 0, generatedAt: plan?.generatedAt ?? null });
						}
					case "vacgc/history": {
						// §102 Context History: the session's shadow-plan
						// point ring (sparkline data: tokens over time +
						// planned-action / injection / degraded markers).
						return ok({ points: this.#vacgcHistory.get(session.id) ?? [], cap: HISTORY_CAP });
						}
					case "vacgc/executed": {
						// Official VAC-GC executions (vs the advisory PLAN):
						// official = base-prefix compaction/summary events,
						// prune = VAC-GC TRASH fresh-prune actions landed.
						return ok({ executions: this.#vacgcExecuted.get(session.id) ?? { prune: { count: 0, at: null }, semantic: { count: 0, at: null }, official: { count: 0, at: null } }, semantic: this.#vacgcSemanticState.get(session.id) ?? null });
						}
						case "memory/provenance": {
							// P0.5 observability: which ACTIVE ledger entries
							// currently have NO resolved evidence binding
						// (sidecar missing/corrupt/failed/ambiguous) — those
						// hold lexically-related context units at P1 in
						// VAC-GC until a sync repairs the binding.
						const cwd = session.header?.cwd;
							const dir = typeof cwd === "string" && cwd ? join(cwd, this.mdMemory.dirName) : null;
							const index = dir ? getLedgerIndex(dir, this.#vacgcLedgerCache) : null;
							const ids = index ? [...index.unresolvedActiveIds].sort() : [];
							const reasons = {};
							if (index) for (const id of ids) reasons[id] = index.unresolvedReasons.get(id) ?? "unbound";
							return ok({ unresolvedActive: ids, reasons });
						}
						default:
							return fail("BAD_REQUEST", `unknown endpoint: ${endpoint}`);
					}
				} catch (error) {
					const code = error?.code === "SETTINGS_VALIDATION" ? error.code : "ERROR";
					const details = error?.code === "SETTINGS_VALIDATION" && error.field ? { field: error.field } : {};
					return { ok: false, error: { code, message: errMsg(error), details } };
				} finally {
					resolved?.dispose();
				}
				};
				// DSH 2.0.9's rpc.handle() binds its registration effect to the
				// connection service's original context, which has no webServer
				// inject. Pass our injected context as the explicit owner instead.
				if (typeof webCtx.connection.register === "function") {
					webCtx.connection.register(webCtx, "/dsh-md-memory", handleRpc);
				} else {
					webCtx.connection.rpc.handle("/dsh-md-memory", handleRpc, { authority: "loopback" });
				}
			this.ctx.logger.info("md-memory: RPC route /dsh-md-memory registered (status, read, search, sync, settings.*, vacgc/plan, vacgc/tiers, vacgc/history, vacgc/executed, memory/provenance)");
			} catch (error) {
				// FAIL-008: a second MML engine instance (another preset realm in
				// the same process) already owns the process-global route; the
				// first handler stays live and keeps serving the Web UI.
				this.ctx.logger.warn(`md-memory: RPC route not registered (${errMsg(error)}); reusing existing /dsh-md-memory handler`);
			}
		});
	}
}

export { MEMORY_CLASS_BUDGETS, MarkdownMemoryCompactionEngine, LedgerManager, LEDGER_FILES, MML_DEFAULTS, classifyMemoryNeed, estimateTokens, renderLazyContext, provisionMmlPresets, resolveRpcSession, selectCalibratedRange };
export default MarkdownMemoryCompactionEngine;
