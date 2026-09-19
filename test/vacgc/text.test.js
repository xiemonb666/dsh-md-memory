/**
 * text.js primitives (plan §15–18, §26–29, §65, §13).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	projectBlocks,
	projectEvent,
	isCheckpointEvent,
	isInjectedEvent,
	normalizeForFingerprint,
	fingerprint,
	lineSetOverlap,
	extractTerms,
	extractExactFacts,
	looksLikeGreeting
} from "../../lib/vacgc/text.js";

test("projectBlocks: text + tool-call + nested tool-result string", () => {
	const { text, toolCalls } = projectBlocks([
		{ type: "text", text: "hello" },
		{ type: "tool-call", name: "read", arguments: "a.txt" },
		{ type: "tool-result", content: "line1\nline2" },
		{ type: "tool-result", content: null },
		{ type: "reasoning", text: "thinking" }
	]);
	assert.equal(text, "hello\nline1\nline2\nthinking");
	assert.deepEqual(toolCalls, [{ name: "read", arguments: "a.txt" }]);
});

test("projectEvent: the three surface event shapes", () => {
	const user = projectEvent({ seq: 1, type: "user/message", data: { role: "user", content: [{ type: "text", text: "u" }] } });
	assert.equal(user.role, "user");
	assert.equal(user.text, "u");
	const assistant = projectEvent({ seq: 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "a" }] } } });
	assert.equal(assistant.role, "assistant");
	assert.equal(assistant.text, "a");
	const tool = projectEvent({ seq: 3, type: "tool/result", data: { message: { role: "tool", content: [{ type: "tool-result", content: "r" }] } } });
	assert.equal(tool.role, "tool");
	assert.equal(tool.text, "r");
	assert.equal(projectEvent({ seq: 4, type: "turn/end", data: {} }), null);
});

test("isCheckpointEvent: provenance and compaction source", () => {
	const withSeqs = { seq: 1, type: "user/message", data: { role: "user", content: [{ type: "text", text: "summary" }] }, sourceEventSeqs: [2, 3] };
	assert.equal(isCheckpointEvent(withSeqs), true);
	const withSource = { seq: 2, type: "user/message", data: { role: "user", content: [{ type: "text", text: "s" }], source: { kind: "compaction" } } };
	assert.equal(isCheckpointEvent(withSource), true);
	const plain = { seq: 3, type: "user/message", data: { role: "user", content: [{ type: "text", text: "real user" }] } };
	assert.equal(isCheckpointEvent(plain), false);
});

test("isInjectedEvent: plugin source marker and framing text", () => {
	assert.equal(isInjectedEvent({ seq: 1, type: "user/message", data: { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }] } }), true);
	assert.equal(isInjectedEvent({ seq: 2, type: "user/message", data: { role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "plugin" } } }), true);
	assert.equal(isInjectedEvent({ seq: 3, type: "user/message", data: { role: "user", content: [{ type: "text", text: "hi" }] } }), false);
});

test("fingerprint: volatile timestamps/UUIDs do not change the fingerprint", () => {
	const a = "Build finished at 2026-09-03T10:00:00.000Z id=123e4567-e89b-12d3-a456-426614174000 ok";
	const b = "Build finished at 2027-01-01T00:00:00Z id=aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000 ok";
	assert.equal(fingerprint(a), fingerprint(b));
	const c = "Build finished ok";
	assert.notEqual(fingerprint(a), fingerprint(c));
	assert.equal(fingerprint(a).length, 16);
});

test("normalizeForFingerprint: lowercases, strips pointers, collapses whitespace", () => {
	const n = normalizeForFingerprint("  Hello   World 0xDEAD  \n\n");
	assert.equal(n, "hello world");
	assert.ok(!n.includes("dead"), "pointer stripped");
});

test("lineSetOverlap: identical→1, disjoint→0, partial→jaccard", () => {
	assert.equal(lineSetOverlap("a\nb\nc", "a\nb\nc"), 1);
	assert.equal(lineSetOverlap("a\nb", "c\nd"), 0);
	// {a,b,c} vs {c,d}: inter 1, union 4 → 0.25
	assert.equal(lineSetOverlap("a\nb\nc", "c\nd"), 0.25);
});

test("extractTerms: ids, windows paths, versions, models, errors, symbols, CJK", () => {
	const terms = extractTerms("See [DEC-004] in C:\\Users\\xiemo\\md-memory\\lib\\vacgc\\index.js (v1.2.3) model qwen38-agent, port 43120, ERROR_CODE_42 at foo_bar and 压缩 策略.");
	assert.ok(terms.ids.has("DEC-004"));
	assert.ok([...terms.paths].some((p) => p.startsWith("C:\\Users\\xiemo\\md-memory")));
	assert.ok(terms.versions.has("v1.2.3") || terms.versions.has("1.2.3"));
	assert.ok(terms.modelNames.has("qwen38-agent"));
	assert.ok(terms.errors.has("ERROR_CODE_42") || terms.errors.has("43120"));
	assert.ok(terms.symbols.has("foo_bar"));
	assert.ok(terms.keywordsZh.includes("压缩") && terms.keywordsZh.includes("策略"));
});

test("extractTerms: no false CJK words for pure ASCII", () => {
	const terms = extractTerms("plain ascii only");
	assert.equal(terms.keywordsZh.length, 0);
});

test("extractExactFacts: verbatim facts survive", () => {
	const facts = extractExactFacts("Wrote 1200 tokens in 42ms to C:\\x\\y.md, see v2.1.0, DEC-001, exit code 0, http://192.168.0.109:30000/v1 `node --test`");
	assert.ok(facts.has("42ms"));
	assert.ok(facts.has("v2.1.0"));
	assert.ok(facts.has("DEC-001"));
	assert.ok([...facts].some((f) => f.includes("192.168.0.109")));
	assert.ok(facts.has("node --test"));
	assert.ok(facts.has("exit code 0"), "exit code 0 captured");
});

test("looksLikeGreeting: short acks yes, tasks no", () => {
	assert.equal(looksLikeGreeting("你好"), true);
	assert.equal(looksLikeGreeting("好的，继续"), true);
	assert.equal(looksLikeGreeting("ok"), true);
	assert.equal(looksLikeGreeting("帮我修复压缩逻辑的问题"), false);
	assert.equal(looksLikeGreeting("继续 修复 lib/vacgc/index.js 里的 bug"), false);
	assert.equal(looksLikeGreeting("This is a 70 character message that is definitely not a greeting at all because it is long enough"), false);
});
