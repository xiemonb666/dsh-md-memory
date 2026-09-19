/**
 * P1-④ Adaptive Lazy Injection — the resident ~6K-char `{{md_memory}}` dump
 * is replaced by a rule-first C0–C5 classifier + per-class TOKEN budgets
 * (C0 0 / C1 0 / C2 768 / C3 2048 / C4 4096 / C5 8192). Properties tested:
 *
 *   (5) C0 (and C1) inject ZERO durable memory — not even a header line;
 *   budget: every class renders within its token budget;
 *   boundaries: entries are all-or-nothing (no half-decision in the prompt);
 *   content: C2=STATE only, C3=STATE+related, C4=router+STATE+related,
 *   C5=full view (and only ACTIVE entries — SUPERSEDED never re-injects);
 *   host level: promptContext(dir, mml, session) classifies the session's
 *   latest user message; unknown intent (no message) → C4 fallback.
 *
 * The classifier/renderer/estimator are pure (no host imports) — they always
 * run; the LedgerManager.promptContext level skips cleanly without the host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mod;
let importError;
try {
	mod = await import("../../lib/index.js");
} catch (error) {
	importError = error;
}
const unavailable = importError !== undefined;
const { MEMORY_CLASS_BUDGETS, classifyMemoryNeed, estimateTokens, renderLazyContext } = mod;

function tempDir() {
	return mkdtempSync(join(tmpdir(), "mml-lazy-"));
}

/** The fixture ledger — the MTP/FP8/192k project the user's examples use. */
const FILES = {
	"PROJECT.md": ["# PROJECT — Requirements & Scope", "", "## [REQ-001] 192k context benchmark support", "- confidence: 0.9", "- status: ACTIVE", "- the sweep uses 192k context", ""].join("\n"),
	"STATE.md": ["# STATE — Current State", "", "## [STATE-CURRENT] 2026-09-12 — profiling MTP", "- task: profile MTP vs the baseline", "- next: re-run the 192k sweep", ""].join("\n"),
	"DECISIONS.md": ["# DECISIONS", "", "## [DEC-001] Use FP8 KV cache", "- confidence: 0.9", "- status: ACTIVE", "- Decision: use FP8 for the KV cache", "- Reason: quality is more stable at 192k", "", "## [DEC-002] Old: use INT8", "- confidence: 0.7", "- status: SUPERSEDED", "- replacement: DEC-001", ""].join("\n"),
	"TECH.md": ["# TECH — Technical Facts & Conventions", "", "## [TECH-001] Benchmark numbers", "- confidence: 0.95", "- status: ACTIVE", "- 52.31 tok/s at 192k context", "- the build command is npm.cmd run build", ""].join("\n"),
	"CONFLICTS.md": ["# CONFLICTS — Integrity Conflicts", ""].join("\n"),
	"INDEX.md": ["# INDEX — Memory Router", "", "## Routing", "", "| File | Entries |", "|---|---|", "| [DECISIONS.md](./DECISIONS.md) | 2 |", ""].join("\n"),
	"HISTORY.md": ["# HISTORY — Sync Log", ""].join("\n")
};

const cls = (message) => classifyMemoryNeed(message, FILES).cls;
const render = (message, clsOverride) => renderLazyContext(FILES, message, clsOverride);

// ---------------------------------------------------------------------------
// the classifier cascade
// ---------------------------------------------------------------------------

test("classifier: C0/C1 spend zero memory, C2–C5 follow the intent cascade", () => {
	// C0 — off-topic, no ledger contact
	assert.equal(cls("Tell me a joke about cats"), "C0");
	assert.equal(cls("Implement a payment gateway for a new SaaS"), "C0", "a big request with NO ledger contact stays C0 (sparsity rule; memory_search is one call away)");
	// C1 — chitchat, no ledger contact
	assert.equal(cls("谢谢"), "C1");
	assert.equal(cls("thanks!"), "C1");
	// C2 — status intent; a bare single-term nudge
	assert.equal(cls("现在什么进展？"), "C2");
	assert.equal(cls("where are we with the sweep?"), "C2");
	assert.equal(cls("FP8"), "C2", "one term, short, no question → light status view");
	// C3 — a question inside a known area / an explicit id citation
	assert.equal(cls("为什么 FP8 在 192k 下更稳定？"), "C3");
	assert.equal(cls("Is DEC-001 still valid?"), "C3");
	// C4 — planning/deciding about this project (the user's FP8→BF16 example)
	assert.equal(cls("我们决定一下，把 FP8 KV cache 换成 BF16 吗？"), "C4");
	assert.equal(cls("Plan the architecture for this project"), "C4");
	// C5 — explicit full-context requests
	assert.equal(cls("给我项目的整体状态回顾"), "C5");
	assert.equal(cls("tell me everything about this project"), "C5");
	assert.equal(cls("DEC-001 vs DEC-003 and the TECH-001 numbers"), "C5", "≥ 2 cited ids → review/handoff-level view");
	// Project scope is a first-class memory intent, even when the current
	// ledger has no REQ term to match against yet.
	assert.equal(cls("这个项目的目标是什么？"), "C3");
	assert.equal(cls("项目目标：支持 192k context benchmark"), "C4");
	assert.equal(cls("优化项目并修复 BUG"), "C4", "explicit project work should not discard durable context");
	assert.equal(cls("请检查当前项目进展"), "C2", "project status checks stay state-focused");
});

// ---------------------------------------------------------------------------
// property 5 + budgets + content
// ---------------------------------------------------------------------------

test("property 5: C0 and C1 inject exactly zero durable memory", () => {
	assert.equal(renderLazyContext(FILES, "Tell me a joke about cats", "C0"), "");
	assert.equal(renderLazyContext(FILES, "谢谢", "C1"), "");
	assert.equal(render("Tell me a joke about cats"), "", "and the auto-classified C0 message renders nothing too");
});

test("budget: every class renders within its token budget", () => {
	for (const c of ["C2", "C3", "C4", "C5"]) {
		const text = render("为什么 FP8 在 192k 下更稳定？", c);
		assert.ok(estimateTokens(text) <= MEMORY_CLASS_BUDGETS[c], `${c}: ${estimateTokens(text)} tokens > ${MEMORY_CLASS_BUDGETS[c]}`);
		assert.ok(text.length > 0, `${c}: the section is not empty`);
	}
});

test("content: C2=STATE only; C3 adds related entries; C4 adds the router; C5 is the full ACTIVE view", () => {
	const c2 = render("现在什么进展？", "C2");
	assert.match(c2, /### Current state/);
	assert.match(c2, /profile MTP/);
	assert.ok(!c2.includes("DEC-001"), "C2 must not drag in decisions");
	assert.ok(!c2.includes("Routing"), "C2 must not drag in the router");

	const c3 = render("为什么 FP8 在 192k 下更稳定？", "C3");
	assert.match(c3, /profile MTP/, "C3 keeps the state");
	assert.ok(c3.includes("## [DEC-001] Use FP8 KV cache"), "C3 includes the related decision");
	assert.ok(c3.includes("## [TECH-001] Benchmark numbers"), "C3 includes the related tech fact");
	assert.ok(!c3.includes("Routing"), "C3 has no router table");

	const c4 = render("我们决定一下，把 FP8 KV cache 换成 BF16 吗？", "C4");
	assert.match(c4, /### Router/);
	assert.match(c4, /DECISIONS\.md/);
	assert.ok(c4.includes("## [DEC-001] Use FP8 KV cache"));
	assert.match(c4, /### Current state/);

	const c5 = render("给我项目的整体状态回顾", "C5");
	assert.match(c5, /### Router/);
	assert.ok(c5.includes("## [DEC-001] Use FP8 KV cache"), "C5 carries the ACTIVE decisions");
	assert.ok(c5.includes("## [TECH-001] Benchmark numbers"), "C5 carries the ACTIVE tech entries");
	assert.ok(c5.includes("## [REQ-001] 192k context benchmark support"), "C5 carries the ACTIVE project requirements");
	assert.ok(!c5.includes("INT8"), "SUPERSEDED entries never re-enter the injection");

	const goal = render("这个项目的目标是什么？");
	assert.ok(goal.includes("## [REQ-001] 192k context benchmark support"), "a project-goal question injects PROJECT entries");
	const work = render("优化项目并修复 BUG");
	assert.ok(work.includes("## [REQ-001] 192k context benchmark support"), "explicit project work injects PROJECT entries");
});

test("entries are all-or-nothing: every injected entry appears verbatim (no half-decision)", () => {
	const c4 = render("我们决定一下，把 FP8 KV cache 换成 BF16 吗？", "C4");
	for (const id of ["DEC-001"]) {
		const entry = FILES["DECISIONS.md"].split("\n\n").find((s) => s.includes(`## [${id}]`));
		assert.ok(entry, `fixture has ${id}`);
		assert.ok(c4.includes(entry.trim()), `${id} must appear verbatim, not truncated`);
	}
});

test("STATE-CURRENT is the only truncatable section — cut at a line boundary within the C2 budget", () => {
	const big = { ...FILES };
	const lines = Array.from({ length: 200 }, (_, i) => `- fact line ${i}: the ${["alder", "basil", "cedar", "daisy"][i % 4]} measurement at ${i % 17}k context`);
	big["STATE.md"] = `# STATE — Current State\n\n## [STATE-CURRENT] 2026-09-12 — long state\n${lines.join("\n")}\n`;
	const text = renderLazyContext(big, "现在什么进展？", "C2");
	assert.ok(estimateTokens(text) <= MEMORY_CLASS_BUDGETS.C2, `C2 budget held with a huge STATE (${estimateTokens(text)})`);
	assert.match(text, /…\(STATE truncated to the C-class budget/);
	// every injected state line is a VERBATIM line of the original (line-boundary cut):
	const stateLines = text.split("\n").filter((l) => l.startsWith("- fact line"));
	for (const l of stateLines) assert.ok(lines.includes(l), `line-boundary cut: ${l.slice(0, 30)}… must be a whole original line`);
	assert.ok(stateLines.length > 0 && stateLines.length < 200);
});

// ---------------------------------------------------------------------------
// host level: promptContext(dir, mml, session)
// ---------------------------------------------------------------------------

test("host: promptContext classifies the session's latest user message (C0 joke → zero, C3 question → DEC-001, no session → C4 fallback)", async () => {
	if (unavailable) return;
	const dir = tempDir();
	const { LedgerManager, MML_DEFAULTS } = mod;
	const ledger = new LedgerManager();
	ledger.ensure(dir, MML_DEFAULTS);
	for (const [name, content] of Object.entries(FILES)) writeFileSync(join(dir, name), content);
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const session = (texts) => ({ id: "sess-LAZY", log: texts.map((text, seq) => ({ type: "user/message", seq, data: { role: "user", content: [{ type: "text", text }] } })) });

	// C0: a joke gets ZERO durable memory
	assert.equal(ledger.promptContext(dir, mml, session(["讲个关于猫的笑话"])), "", "C0 → zero injection");
	// C3: a question about a known area gets STATE + the related decision
	const c3text = ledger.promptContext(dir, mml, session(["为什么 FP8 在 192k 下更稳定？"]));
	assert.match(c3text, /class C3/);
	assert.ok(c3text.includes("## [DEC-001] Use FP8 KV cache"));
	// the LATEST user message wins (an old joke, then a real question):
	const mixed = ledger.promptContext(dir, mml, session(["讲个笑话", "为什么 FP8 在 192k 下更稳定？"]));
	assert.match(mixed, /class C3/);
	// unknown intent (no user message at all) → C4 planning fallback:
	const fallback = ledger.promptContext(dir, mml, undefined);
	assert.match(fallback, /class C4/);
	assert.match(fallback, /### Router/);
	// the opt-out still wins over everything:
	assert.equal(ledger.promptContext(dir, { ...mml, injectAlways: false }, session(["为什么 FP8 在 192k 下更稳定？"])), "");
});

test("host: mid-turn tool calls keep the original intent (the class follows the last USER message, not tool noise)", async () => {
	if (unavailable) return;
	const dir = tempDir();
	const { LedgerManager, MML_DEFAULTS } = mod;
	const ledger = new LedgerManager();
	ledger.ensure(dir, MML_DEFAULTS);
	for (const [name, content] of Object.entries(FILES)) writeFileSync(join(dir, name), content);
	const mml = { ...MML_DEFAULTS, syncProvider: "testprov", syncModel: "testmodel" };
	const session = {
		id: "sess-LAZY2",
		log: [
			{ type: "user/message", seq: 0, data: { role: "user", content: [{ type: "text", text: "为什么 FP8 在 192k 下更稳定？" }] } },
			{ type: "assistant/message", seq: 1, data: { role: "assistant", content: [{ type: "text", text: "checking the ledger" }] } },
			{ type: "tool/result", seq: 2, data: { role: "tool", content: [{ type: "text", text: "52.31 tok/s" }] } }
		]
	};
	const text = ledger.promptContext(dir, mml, session);
	assert.match(text, /class C3/, "the pending intent is still the user's FP8 question");
	assert.ok(text.includes("## [DEC-001] Use FP8 KV cache"));
});

test("estimateTokens: CJK counts ~1/char, ASCII ~1/4 (the budget unit is sane)", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("中文中文"), 4);
	assert.ok(estimateTokens("abcde") === 2, "ceil(5/4)");
});
