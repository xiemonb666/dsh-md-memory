/**
 * Test fixtures for the VAC-GC suites (plan §124–129).
 *
 * Plain session-shaped surfaces with the EXACT event/message shapes the
 * runtime produces (verified against the compiled dsh-session package —
 * TECH-018): user/message carries the Message as `data`; assistant/message
 * and tool/result nest it under `data.message`. The suites are hermetic:
 * only the vacgc modules + node builtins are imported.
 */

export const T0 = Date.parse("2026-09-03T10:00:00.000Z");
const MIN = 60000;

let seqCounter = 0;

export function resetSeqs() {
	seqCounter = 0;
}

/** One surface event with the runtime envelope shape. */
export function ev(type, data, opts = {}) {
	seqCounter += 1;
	const { time, ...rest } = opts;
	return {
		seq: seqCounter,
		time: time ?? T0 + seqCounter * MIN,
		type,
		data,
		...rest
	};
}

/** A live user message (the data IS the message). */
export function userMsg(text, opts = {}) {
	return ev("user/message", { role: "user", content: [{ type: "text", text }] }, opts);
}

/** An assistant text message (message nested under data.message). */
export function assistantMsg(text, opts = {}) {
	return ev("assistant/message", { message: { role: "assistant", content: [{ type: "text", text }] } }, opts);
}

/**
 * An assistant message with tool-call blocks, optionally followed by its
 * tool/result events. All events are returned in surface order.
 * @param text - assistant text (may be "").
 * @param calls - [{name, arguments}] (arguments as the string the runtime stores).
 * @param results - result content strings, aligned with calls (may be shorter
 *                  → open tail; may be null → pruned result).
 */
export function toolPair(text, calls, results = [], opts = {}) {
	const content = [
		...text.length > 0 ? [{ type: "text", text }] : [],
		...calls.map((c) => ({ type: "tool-call", name: c.name, arguments: c.arguments }))
	];
	const events = [ev("assistant/message", { message: { role: "assistant", content } }, opts)];
	for (let i = 0; i < results.length; i += 1) {
		const r = results[i];
		events.push(ev("tool/result", { message: { role: "tool", content: r === null ? [] : [{ type: "tool-result", content: r }] } }, { ...opts, time: (opts.time ?? 0) + i }));
	}
	return events;
}

/** A compaction checkpoint user message (provenance sourceEventSeqs). */
export function checkpointMsg(text, shadowedSeqs, opts = {}) {
	return ev("user/message", { role: "user", content: [{ type: "text", text }] }, { sourceEventSeqs: shadowedSeqs, ...opts });
}

/** An injected (plugin/system) user message. */
export function injectedMsg(text, opts = {}) {
	return ev("user/message", { role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } }, opts);
}

/**
 * A fake session in the shape planVacGc consumes.
 * @param events - ordered surface events.
 * @returns {nodes, eventAt}.
 */
export function makeSession(events) {
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	return {
		nodes: events.map((e) => e.seq),
		eventAt: (seq) => bySeq.get(seq) ?? undefined
	};
}

/**
 * Per-node prices aligned with the session nodes.
 * @param session - makeSession() output.
 * @param tokens - uniform tokens per node (or a sparse map seq→tokens).
 * @returns prices array.
 */
export function pricesFor(session, tokens) {
	if (typeof tokens === "object" && tokens !== null) {
		return session.nodes.map((seq) => ({ seq, tokens: tokens[seq] ?? 0 }));
	}
	return session.nodes.map((seq) => ({ seq, tokens }));
}

/**
 * A pairing-balance checker mirroring the dsh-compaction definition
 * (delta = +1 per assistant tool-call block, −1 per tool/result; a boundary
 * is balanced when no call before it is unanswered at it).
 * @param events - ordered surface events.
 * @param seq - boundary (position of the first event AFTER the boundary).
 * @returns true when balanced.
 */
export function pairingBalancedBefore(events, seq) {
	let delta = 0;
	for (const e of events) {
		if (e.seq >= seq) break;
		if (e.type === "assistant/message") {
			for (const b of e.data.message.content) if (b.type === "tool-call") delta += 1;
		}
		if (e.type === "tool/result") delta -= 1;
	}
	return delta === 0;
}

/** Deep-freeze (tests assert the planner never mutates its inputs, §130). */
export function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}

/**
 * A fake LedgerIndex in the exact shape memory-index.js produces (plain
 * object — classifyProtection/dependencyOf only read these fields).
 */
export function fakeMemory({ activeIds = [], citedByActive = [], statePaths = [], stateText = "" } = {}) {
	return {
		available: true,
		activeIds: new Set(activeIds),
		citedByActive: new Set(citedByActive),
		statePaths: new Set(statePaths),
		stateText
	};
}

/**
 * A standard VAC-GC test surface: greeting → request → assistant reasoning
 * → two tool pairs (read + shell) → benchmark text → second request →
 * current work. Times advance one minute per event (T0-based).
 * @returns {session, events, prices} with 500 tokens per node.
 */
export function standardScenario(opts = {}) {
	resetSeqs();
	const now = opts.now ?? T0 + 40 * MIN;
	const events = [
		userMsg("你好"), // greeting — intrinsic 0.02 lane
		userMsg("目标：实现 VAC-GC 影子规划器，不能破坏现有压缩行为"), // P0 goal + constraint
		assistantMsg("好的。决定：采用纯函数模块，先做只读影子模式。"), // P1 decision
		...toolPair("读取配置。", [{ name: "read", arguments: "C:\\Users\\xiemo\\.dsh\\settings.yaml" }], ["enabled: true\ndirName: .dsh-memory"]),
		...toolPair("", [{ name: "pwsh", arguments: "node --test test/vacgc/ 2>&1 | Select-Object -First 40" }], ["  passing 42\n  failing 0"]),
		assistantMsg("基准结果：p95 延迟 42ms，吞吐 1200 tokens/s。"), // P1 benchmark
		userMsg("继续修复影子规划器的压力区间"), // query-ish second request
		assistantMsg("接下来继续处理 segments 模块。") // current work
	];
	const session = makeSession(events);
	const prices = pricesFor(session, opts.tokensPerNode ?? 500);
	return { session, events, prices, now };
}
