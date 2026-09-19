/**
 * Pairing/atomicity (plan §4, §53, §57, §72): a tool-call assistant message
 * and ALL of its results are ONE atomic unit; segments therefore have
 * balanced tool-pairing boundaries by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextUnits, markRecentFloor } from "../../lib/vacgc/units.js";
import {
	userMsg,
	assistantMsg,
	toolPair,
	checkpointMsg,
	injectedMsg,
	makeSession,
	pricesFor,
	pairingBalancedBefore
} from "./helpers.js";

test("one assistant message with two calls + two results = ONE atomic tool-pair unit", () => {
	const events = [
		userMsg("看一下这两个文件"),
		...toolPair("读一下。", [
			{ name: "read", arguments: "C:\\x\\a.js" },
			{ name: "read", arguments: "C:\\x\\b.js" }
		], ["content a", "content b"]),
		assistantMsg("两个文件都看完了。")
	];
	const session = makeSession(events);
	const { units, meta } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 100) });
	const pair = units.find((u) => u.kind === "tool-pair");
	assert.ok(pair, "the tool pair must exist as a unit");
	assert.equal(pair.seqs.length, 3, "assistant node + 2 result nodes are one unit");
	assert.deepEqual(pair.toolName, "read");
	assert.equal(meta.openTail, false);
	assert.ok(pair.tokens === 300, `priced across all nodes (got ${pair.tokens})`);
	// the pair's text is the projection of all three nodes
	assert.ok(pair.text.includes("读一下。"));
	assert.ok(pair.text.includes("content a") && pair.text.includes("content b"));
});

test("results arriving after an interrupting user message form an open (transient) unit", () => {
	const events = [
		userMsg("执行构建"),
		...toolPair("", [{ name: "pwsh", arguments: "pnpm build" }], ["build output"]),
		userMsg("继续"),
		...toolPair("", [{ name: "pwsh", arguments: "pnpm test" }], []) // result still pending
	];
	const session = makeSession(events);
	const { units, meta } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 50) });
	const openPair = units.find((u) => u.open === true);
	assert.ok(openPair, "the pending tool call must be an open unit");
	assert.equal(openPair.kind, "tool-pair");
	assert.equal(openPair.toolName, "pwsh");
	assert.equal(meta.openTail, true);
});

test("a result-less assistant tool call at surface end is open, never dropped", () => {
	const events = [
		userMsg("开始"),
		...toolPair("", [{ name: "grep", arguments: "foo" }], [])
	];
	const session = makeSession(events);
	const { units, meta } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 10) });
	assert.equal(units.length, 2);
	assert.equal(units[1].open, true);
	assert.equal(meta.openTail, true);
});

test("checkpoints and injected context are distinct unit kinds (scored independently, §74)", () => {
	const events = [
		userMsg("原始需求"),
		assistantMsg("原始回答"),
		checkpointMsg("压缩摘要：…", [1, 2]),
		injectedMsg("<system-reminder>注入的上下文</system-reminder>")
	];
	const session = makeSession(events);
	const { units } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 10) });
	assert.equal(units.find((u) => u.kind === "checkpoint").sourceEventSeqs.length, 2);
	assert.ok(units.some((u) => u.kind === "injected"));
	assert.equal(units.filter((u) => u.kind === "user").length, 1, "checkpoint/injected are NOT counted as user conversation");
});

test("segments over units have balanced boundaries by construction (the pairing invariant)", () => {
	const events = [
		userMsg("需求"),
		...toolPair("", [{ name: "read", arguments: "C:\\x\\1.js" }], ["one"]),
		...toolPair("", [{ name: "read", arguments: "C:\\x\\2.js" }], ["two"]),
		assistantMsg("结论"),
		...toolPair("", [{ name: "grep", arguments: "bar" }], ["hit"]),
		userMsg("收尾")
	];
	const session = makeSession(events);
	const { units } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 10) });
	// cut between the two tool pairs and after the assistant text: both
	// boundaries fall on unit edges → balanced.
	const boundaryA = units[1].seqs[0]; // start of the second tool pair
	const boundaryB = units[3].seqs[0]; // start of the grep pair
	assert.equal(pairingBalancedBefore(events, boundaryA), true, "boundary between pairs is balanced");
	assert.equal(pairingBalancedBefore(events, boundaryB), true, "boundary after assistant text is balanced");
	// a cut INSIDE a pair (at its result) would be unbalanced — unit edges never do that
	const insidePair = units[1].seqs[1];
	assert.equal(pairingBalancedBefore(events, insidePair), false, "mid-pair cut is unbalanced");
});

test("unit seqs are contiguous spans (segment = contiguous whole-unit span)", () => {
	const events = [
		userMsg("u1"),
		...toolPair("a", [{ name: "read", arguments: "p" }], ["r1", "r2"]), // two results
		userMsg("u2")
	];
	const session = makeSession(events);
	const { units } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices: pricesFor(session, 1) });
	for (const u of units) {
		for (let i = 1; i < u.seqs.length; i += 1) {
			assert.equal(u.seqs[i], u.seqs[i - 1] + 1, `unit ${u.id} seqs are contiguous`);
		}
	}
});

test("recent floor flags the trailing working set (conservative crossing unit included, §45)", () => {
	const events = [
		userMsg("很久以前的需求"),
		assistantMsg("很久以前的回答"),
		assistantMsg("中间结论"),
		assistantMsg("最近的问题"),
		assistantMsg("当前的任务")
	];
	const session = makeSession(events);
	const per = [100, 100, 100, 400, 500];
	const prices = pricesFor(session, Object.fromEntries(events.map((e, i) => [e.seq, per[i]])));
	const { units } = buildContextUnits({ nodes: session.nodes, eventAt: session.eventAt, prices });
	markRecentFloor(units, 700);
	// trailing 500+400 = 900 ≥ 700 → units 4,5 flagged; unit 3 (100) NOT (900 already ≥ 700)
	assert.deepEqual(units.map((u) => u.inRecentFloor), [false, false, false, true, true]);
	// floor larger than everything → all flagged
	markRecentFloor(units, 1200);
	assert.ok(units.every((u) => u.inRecentFloor === true));
});

test("corrupt surface nodes are skipped without killing the rest (§130 no-throw)", () => {
	const events = [userMsg("a"), assistantMsg("b")];
	const session = makeSession(events);
	const { units, meta } = buildContextUnits({
		nodes: [events[0].seq, 999, events[1].seq],
		eventAt: (seq) => seq === 999 ? undefined : session.eventAt(seq),
		prices: []
	});
	assert.equal(units.length, 2);
	assert.equal(meta.totalTokens, 0);
});
