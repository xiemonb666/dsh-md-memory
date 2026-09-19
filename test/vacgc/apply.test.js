/**
 * VAC-GC Phase 2 application (§119) — landing tests.
 * planNodePrunes is pure (no session); landNodePrunes runs against a
 * fake session that enforces the dsh-session replace contract
 * (one current node, content-only, shadow provenance).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planNodePrunes, landNodePrunes, pickShadowPrice } from "../../lib/vacgc/apply.js";
import { T0 } from "./helpers.js";

/** Large bash-ish result body (result-node text — NO [tool-calls] header). */
const largeBash = [
	...Array.from({ length: 25 }, (_, i) => `stdout filler line ${String(i + 1).padStart(3, "0")} with padding words`),
	"error: cannot open file C:\\work\\data.md",
	"Exception: ECONNRESET connection reset",
	"warning: deprecated flag -x",
	...Array.from({ length: 25 }, (_, i) => `more stdout filler ${String(i + 1).padStart(3, "0")} padding`),
	"final summary line",
	"exit code: 2"
].join("\n");

/** A tool/result surface event in the runtime block shape. */
function toolResultEvent(seq, text, opts = {}) {
	return {
		seq,
		time: opts.time ?? T0 + seq * 60000,
		type: "tool/result",
		data: {
			message: {
				role: "tool",
				source: { callId: opts.callId ?? `call-${seq}` },
				content: [{ type: "tool-result", content: [{ type: "text", text }] }]
			}
		}
	};
}

const userEvent = (seq) => ({ seq, time: T0 + seq * 60000, type: "user/message", data: { role: "user", content: [{ type: "text", text: `u${seq}` }] } });

/** A plan wrapper with the apply-relevant fields only. */
const plan = (actions, extra = {}) => ({ degraded: false, freshPrune: { actions }, ...extra });

test("planNodePrunes: degraded plan and missing/empty actions → no-op (§130)", () => {
	const env = { surfaceSeqs: [1], eventAt: () => toolResultEvent(1, largeBash) };
	assert.deepEqual(planNodePrunes({ degraded: true, freshPrune: { actions: [{ kind: "reduce", apply: { resultSeqs: [1] } }] } }, env), []);
	assert.deepEqual(planNodePrunes({ degraded: false, freshPrune: { actions: [] } }, env), []);
	assert.deepEqual(planNodePrunes({ degraded: false }, env), []);
	assert.deepEqual(planNodePrunes(null, env), []);
});

test("planNodePrunes: legacy action without apply data is skipped (never crashes)", () => {
	const env = { surfaceSeqs: [1], eventAt: (s) => toolResultEvent(s, largeBash) };
	assert.deepEqual(planNodePrunes(plan([{ kind: "reduce", toolName: "pwsh", reason: "old" }]), env), []);
	assert.deepEqual(planNodePrunes(plan([{ kind: "reduce", toolName: "pwsh", apply: null }]), env), []);
});

test("planNodePrunes: surface/type/content gates — off-surface, non-tool-result and mixed blocks are skipped", () => {
	const mixed = {
		seq: 3,
		type: "tool/result",
		data: { message: { role: "tool", content: [{ type: "tool-result", content: [{ type: "text", text: "x" }, { type: "image", url: "data:…" }] }] } }
	};
	const empty = {
		seq: 6,
		type: "tool/result",
		data: { message: { role: "tool", content: [{ type: "tool-result", content: [] }] } }
	};
	const events = {
		1: toolResultEvent(1, largeBash),
		2: toolResultEvent(2, "tiny"),
		3: mixed,
		4: { seq: 4, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } },
		5: toolResultEvent(5, largeBash), // off-surface
		6: empty
	};
	const env = { surfaceSeqs: [1, 2, 3, 4, 6], eventAt: (s) => events[s] };
	const out = planNodePrunes(plan([
		{ kind: "reduce", toolName: "pwsh", apply: { resultSeqs: [1, 2] }, reason: "reduce lane" },
		{ kind: "reduce", toolName: "pwsh", apply: { resultSeqs: [3, 4] }, reason: "skip lane" },
		{ kind: "reduce", toolName: "pwsh", apply: { resultSeqs: [5, 6] }, reason: "off-surface / empty" }
	]), env);
	assert.equal(out.length, 1, "only the large all-text on-surface result qualifies");
	assert.equal(out[0].seq, 1);
	assert.equal(out[0].kind, "reduce");
	assert.ok(out[0].newContent.includes("raw: "), "reduced text ends in a raw pointer");
	assert.ok(out[0].newContent.length < largeBash.length);
	assert.equal(out[0].beforeChars, largeBash.length);
});

test("planNodePrunes: reduce runs the per-tool reducer on the NODE's own text (churn gate)", () => {
	const small = "ls done\n3 files";
	const env = { surfaceSeqs: [1, 2], eventAt: (s) => toolResultEvent(s, s === 1 ? largeBash : small) };
	const out = planNodePrunes(plan([
		{ kind: "reduce", toolName: "pwsh", apply: { resultSeqs: [1, 2] }, reason: "r" }
	]), env);
	assert.equal(out.length, 1, "small result: no shrink → no churn (§59)");
	assert.equal(out[0].seq, 1);
	assert.ok(out[0].newContent.includes("Exit Code: 2"), "bash reducer keeps the exit code");
	assert.ok(out[0].newContent.includes("error: cannot open file"), "primary error kept");
	assert.ok(!out[0].newContent.includes("filler line 007"), "noise mass is gone");
});

test("planNodePrunes: drop lands a raw-pointer stub only when strictly smaller; duplicate seqs land once", () => {
	const tiny = "ok";
	const env = { surfaceSeqs: [1, 2, 3], eventAt: (s) => toolResultEvent(s, s === 1 ? largeBash : tiny) };
	const out = planNodePrunes(plan([
		{ kind: "drop", toolName: "test", raw: "ab12cd34ef56ab12", apply: { resultSeqs: [1, 2] }, reason: "duplicate of u1" },
		{ kind: "drop", toolName: "test", raw: "ab12cd34ef56ab12", apply: { resultSeqs: [1, 3] }, reason: "duplicate of u1 (again)" }
	]), env);
	assert.equal(out.length, 1, "tiny result is shorter than the stub → skipped; seq 1 lands exactly once");
	assert.equal(out[0].seq, 1);
	assert.equal(out[0].kind, "drop");
	assert.equal(out[0].newContent, "[pruned: duplicate tool result — raw: ab12cd34ef56ab12 (reconstructible)]");
	assert.ok(out[0].afterChars < out[0].beforeChars);
});

// ---------------------------------------------------------------------------
// landNodePrunes — the fake session enforces the dsh-session replace contract
// ---------------------------------------------------------------------------

/**
 * Fake session: append-only log, current-surface projection, and the
 * assertToolResultRewrite contract (a tool/result replace rewrites exactly
 * one current node, content-only, provenance required).
 */
function makeLandingSession(events, opts = {}) {
	const log = [...events];
	let surface = events.map((e) => e.seq);
	const bySeq = new Map(log.map((e) => [e.seq, e]));
	const appended = [];
	let nextSeq = Math.max(0, ...events.map((e) => e.seq)) + 1;
	return {
		surface: { get nodes() { return surface; } },
		log,
		appended,
		eventAt: (seq) => bySeq.get(seq),
		append(type, data, meta = {}) {
			if (opts.rejectSeq !== undefined && meta.surfaceOp?.op === "replace" && meta.surfaceOp.startSeq === opts.rejectSeq) {
				throw new Error(`fake session rejects the replace of ${opts.rejectSeq} (assertToolResultRewrite)`);
			}
			const event = { seq: nextSeq++, time: T0, type, data };
			const op = meta.surfaceOp;
			if (op?.op === "replace") {
				if (Object.keys(op).length !== 3 || !Object.hasOwn(op, "startSeq") || !Object.hasOwn(op, "endSeq")) {
					throw new Error("fake: replace must use DSH startSeq/endSeq surfaceOp keys");
				}
				if (op.startSeq !== op.endSeq) throw new Error("fake: replace must target exactly one current node");
				const target = surface.indexOf(op.startSeq);
				if (target === -1) throw new Error(`fake: replace target ${op.startSeq} is not a current surface node`);
				const original = bySeq.get(op.startSeq);
				if (original.type !== type) throw new Error("fake: replace changes the node type");
				if (!Array.isArray(meta.sourceEventSeqs) || meta.sourceEventSeqs.length === 0) throw new Error("fake: replace requires sourceEventSeqs provenance");
				for (const key of Object.keys(original.data)) {
					if (key === "message") continue;
					if (JSON.stringify(original.data[key]) !== JSON.stringify(data[key])) throw new Error(`fake: replace rewrote non-content data key "${key}"`);
				}
				surface = surface.map((s) => (s === op.startSeq ? event.seq : s)); // shadowed node leaves the surface
			} else {
				surface.push(event.seq);
			}
			log.push(event);
			bySeq.set(event.seq, event);
			appended.push({ seq: event.seq, type, data, meta });
			return event;
		}
	};
}

test("landNodePrunes: shadow event + provenance-carrying replace; content-only; surface swaps the node", () => {
	const events = [
		userEvent(1),
		{ seq: 2, time: T0, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", name: "pwsh", arguments: "Get-Process" }] } } },
		toolResultEvent(3, largeBash),
		userEvent(4)
	];
	const session = makeLandingSession(events);
	const env = { surfaceSeqs: [...session.surface.nodes], eventAt: (s) => session.eventAt(s) };
	const reps = planNodePrunes(plan([{ kind: "reduce", toolName: "pwsh", apply: { resultSeqs: [3], toolArgs: "Get-Process" }, reason: "fresh tool prune" }]), env);
	assert.equal(reps.length, 1);
	const { landed, charsSaved } = landNodePrunes(session, reps, (e) => 123);
	// transaction shape: shadow-price event immediately before the replace
	assert.deepEqual(session.appended.map((a) => a.type), ["compaction/prune", "tool/result"]);
	const shadow = session.appended[0];
	assert.deepEqual(shadow.data, { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 123 });
	const replace = session.appended[1];
	assert.deepEqual(replace.meta, { surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] });
	// the replacement is the SAME message with ONLY the text block swapped
	const newMessage = replace.data.message;
	assert.equal(newMessage.role, "tool");
	assert.equal(newMessage.source.callId, "call-3", "call identity preserved (pairing stays valid)");
	const block = newMessage.content[0];
	assert.equal(block.type, "tool-result");
	assert.deepEqual(block.content, [{ type: "text", text: reps[0].newContent }]);
	assert.ok(reps[0].newContent.includes("raw: "));
	// surface: original node shadowed out, replacement spliced into the same
	// slot (dsh-session: replace splices, plain append pushes to the tail —
	// the shadow-price node lands at the tail, where meter consumers read it)
	assert.ok(!session.surface.nodes.includes(3), "shadowed original left the surface");
	assert.deepEqual(session.surface.nodes, [1, 2, landed[0].replacementSeq, 4, shadow.seq]);
	// provenance: the original event stays in the log (replay can recover it)
	assert.equal(session.eventAt(3).data.message.content[0].content[0].text, largeBash, "log still carries the raw original");
	// accounting
	assert.deepEqual(landed, [{ originalSeq: 3, replacementSeq: landed[0].replacementSeq, kind: "reduce" }]);
	assert.equal(charsSaved, reps[0].beforeChars - reps[0].afterChars);
	assert.ok(charsSaved > 0);
	// (the real session's append detaches + deep-freezes every event — the
	// freeze contract is the session layer's, not apply.js's)
});

test("landNodePrunes: stale seqs (unresolvable or non-tool-result) are skipped", () => {
	const events = [
		userEvent(1),
		toolResultEvent(2, largeBash),
		userEvent(99)
	];
	const session = makeLandingSession(events);
	const { landed, charsSaved } = landNodePrunes(session, [
		{ seq: 2, kind: "reduce", newContent: "reduced", reason: "r", beforeChars: largeBash.length, afterChars: 7 },
		{ seq: 777, kind: "reduce", newContent: "reduced", reason: "r", beforeChars: 100, afterChars: 7 }, // never existed
		{ seq: 99, kind: "reduce", newContent: "reduced", reason: "r", beforeChars: 100, afterChars: 7 } // user message
	], () => 5);
	assert.equal(landed.length, 1, "only the live tool/result lands");
	assert.equal(landed[0].originalSeq, 2);
	assert.equal(charsSaved, largeBash.length - 7);
});

test("landNodePrunes: estimate fallback — NaN/negative estimates fall back to ceil(chars/4)", () => {
	const events = [userEvent(1), toolResultEvent(2, "x".repeat(80))];
	const session = makeLandingSession(events);
	const { landed } = landNodePrunes(session, [{ seq: 2, kind: "drop", newContent: "stub", reason: "r", beforeChars: 80, afterChars: 4 }], () => NaN);
	assert.equal(landed.length, 1);
	const shadow = session.appended[0];
	assert.equal(shadow.data.shadowedTokenCount, 20, "ceil(80/4) fallback price");
});

test("landNodePrunes: a rejected replace propagates; earlier landings stay durable (§130)", () => {
	const events = [
		userEvent(1),
		toolResultEvent(2, largeBash),
		toolResultEvent(3, "other " + "y".repeat(200)),
		userEvent(4)
	];
	const session = makeLandingSession(events, { rejectSeq: 3 });
	const reps = [
		{ seq: 2, kind: "reduce", newContent: "reduced-2", reason: "r", beforeChars: largeBash.length, afterChars: 11 },
		{ seq: 3, kind: "reduce", newContent: "reduced-3", reason: "r", beforeChars: 206, afterChars: 11 }
	];
	assert.throws(() => landNodePrunes(session, reps, () => 1), /rejects the replace of 3/);
	// the FIRST landing is durable: shadow + replace in the log, surface swapped
	const seq2 = session.log.find((e) => e.type === "tool/result" && e.data.message.content[0].content[0].text === "reduced-2");
	assert.ok(seq2 !== undefined, "earlier landing committed");
	assert.ok(!session.surface.nodes.includes(2));
	assert.ok(session.surface.nodes.includes(seq2.seq));
	// the rejected node is untouched (still the full original on the surface)
	assert.equal(session.eventAt(3).data.message.content[0].content[0].text, "other " + "y".repeat(200));
	assert.ok(session.surface.nodes.includes(3));
});

test("landNodePrunes: end-to-end drop — the duplicate result exits the surface as a stub", () => {
	const events = [
		userEvent(1),
		toolResultEvent(2, largeBash), // first copy: kept (not in this plan)
		toolResultEvent(3, largeBash) // duplicate
	];
	const session = makeLandingSession(events);
	const env = { surfaceSeqs: [...session.surface.nodes], eventAt: (s) => session.eventAt(s) };
	const reps = planNodePrunes(plan([{ kind: "drop", toolName: "pwsh", raw: "cafebabe12345678", apply: { resultSeqs: [3] }, reason: "duplicate of u1" }]), env);
	assert.equal(reps.length, 1);
	const { landed, charsSaved } = landNodePrunes(session, reps, () => 0);
	assert.equal(landed.length, 1);
	const onSurface = session.log.find((e) => e.seq === landed[0].replacementSeq);
	assert.equal(onSurface.data.message.content[0].content[0].text, "[pruned: duplicate tool result — raw: cafebabe12345678 (reconstructible)]");
	assert.ok(charsSaved > 0);
	// surface: duplicate's slot holds the stub node; shadow-price node at the
	// tail; the first copy and everything else are untouched (§128 pairing)
	assert.deepEqual(session.surface.nodes, [1, 2, landed[0].replacementSeq, session.appended[0].seq]);
	assert.ok(session.surface.nodes.includes(2), "first copy untouched");
});

	// ---------------------------------------------------------------------------
	// Shadow-price contract (dsh-token-meter/surface-projection) — regression
	// for the 2026-09-12 incident: VAC-GC landings priced their shadow event
	// with the calibrated estimator (1.8 chars/token code, 8/3 CJK), the host
	// meter consumed the claim against its FIXED 4-chars/token estimator, and
	// the contextBreakdown state (zod nonnegative on messageTokens) went
	// negative at the next compaction → "历史加载失败 (gateway/internal)".
	// ---------------------------------------------------------------------------

	/** Fixed-density heuristic, mirroring dsh-token-meter/estimate exactly. */
	function fixedPriceBlocks(blocks) {
		let tokens = 0;
		for (const block of blocks) switch (block?.type) {
			case "text":
			case "reasoning":
				tokens += Math.ceil(block.text.length / 4) + 4;
				break;
			case "tool-call":
				tokens += Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4;
				break;
			case "tool-result":
				tokens += fixedPriceBlocks(block.content) + 4;
				break;
			default:
				tokens += 4 + Math.ceil(JSON.stringify(block).length / 4);
		}
		return tokens;
	}
	const fixedPriceMessage = (message) => fixedPriceBlocks(message.content) + 4;
	/** The plugin's calibrated pricing (denser for CJK/code) — the old bug. */
	function calibratedPriceBlocks(blocks, code) {
		let tokens = 0;
		const units = (t) => [...(t ?? "")].reduce((n, c) => n + (c.charCodeAt(0) >= 0x2e80 ? 8 / 3 : 1), 0);
		for (const block of blocks ?? []) switch (block?.type) {
			case "text":
			case "reasoning":
				tokens += Math.ceil(units(block.text) / (code ? 1.8 : 4)) + 4;
				break;
			case "tool-call":
				tokens += Math.ceil(units(block.name) / 4) + Math.ceil(units(block.arguments) / 1.8) + 4;
				break;
			case "tool-result":
				tokens += calibratedPriceBlocks(block.content, true) + 4;
				break;
			default:
				tokens += 4 + Math.ceil(units(JSON.stringify(block)) / 4);
		}
		return tokens;
	}
	const calibratedPriceMessage = (message) => calibratedPriceBlocks(message.content) + 4;

	/**
	 * A faithful mini-replay of the host meter's contextBreakdown fold
	 * (shadow event arms a claim; append adds the fixed price; replace
	 * consumes the claim for its exact range; the stateSchema's
	 * nonnegativity is what history load validates). surfaceOp is the string
	 * "append" or a replace object, exactly as dsh-session persists it.
	 */
	function foldMeterState(events) {
		let messageTokens = 0;
		let claim = null;
		for (const event of events) {
			if (event.type === "compaction/summary" || event.type === "compaction/prune") {
				claim = { start: event.data.shadowedRange.start, end: event.data.shadowedRange.end, tokens: event.data.shadowedTokenCount };
				continue;
			}
			const message = event.type === "user/message" ? event.data : event.type === "tool/result" || (event.type === "assistant/message" && event.data.message.content.length > 0) ? event.data.message : null;
			if (message === null) { claim = null; continue; }
			const tokens = fixedPriceMessage(message);
			const op = event.surfaceOp;
			if (op === "append") { messageTokens += tokens; claim = null; continue; }
			if (claim === null) continue; // replace without claim: zero delta (host-tolerated drift)
			if (claim.start !== op.startSeq || claim.end !== op.endSeq) throw new Error(`claim ${claim.start}-${claim.end} != op ${op.startSeq}-${op.endSeq}`);
			messageTokens += tokens - claim.tokens;
			claim = null;
		}
		return messageTokens;
	}

	test("pickShadowPrice: the host meter's fixed price wins; fallback only without a usable meter price", () => {
		const event = toolResultEvent(1, largeBash);
		const fallback = () => 777;
		const meter = { estimateMessage: (m) => fixedPriceMessage(m) };
		assert.equal(pickShadowPrice(meter, event, fallback), fixedPriceMessage(event.data.message), "meter price used");
		assert.notEqual(pickShadowPrice(meter, event, fallback), 777);
		assert.equal(pickShadowPrice(null, event, fallback), 777, "no meter → fallback");
		assert.equal(pickShadowPrice({}, event, fallback), 777, "meter without estimateMessage → fallback");
		assert.equal(pickShadowPrice({ estimateMessage: () => NaN }, event, fallback), 777, "non-finite meter price → fallback");
		assert.equal(pickShadowPrice({ estimateMessage: () => -5 }, event, fallback), 777, "negative meter price → fallback");
		assert.equal(pickShadowPrice({ estimateMessage: () => { throw new Error("boom"); } }, event, fallback), 777, "throwing meter → fallback");
	});

	test("shadow-price contract: a calibrated claim drives the meter fold negative; a fixed claim never does", () => {
		// CJK-heavy tool results: the calibrated price is ~6x the fixed one —
		// exactly the shape that broke the live session.
		const cjk = "日志检查完毕：发现连接超时与端口占用异常，已记录到问题清单，等待人工确认后再执行重启操作。"; // 48 CJK chars
		const baseEvents = [
			{ seq: 1, type: "user/message", surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "检查系统日志" }] } },
			{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { role: "assistant", content: [{ type: "tool-call", name: "pwsh", arguments: "Get-EventLog" }] } } },
			{ seq: 3, type: "tool/result", surfaceOp: "append", data: { message: { role: "tool", source: { callId: "a" }, content: [{ type: "tool-result", content: [{ type: "text", text: cjk.repeat(8) }] }] } } },
			{ seq: 4, type: "tool/result", surfaceOp: "append", data: { message: { role: "tool", source: { callId: "b" }, content: [{ type: "tool-result", content: [{ type: "text", text: cjk.repeat(8) }] }] } } },
			{ seq: 5, type: "user/message", surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "继续" }] } }
		];
		const stub = "[pruned: stale — raw: 0123456789abcdef (reconstructible)]";
		const textOf = (e) => e.data.message.content[0].content[0].text;
		// Land two prunes through the REAL landing path — once calibrated (the
		// 2026-09-12 bug), once with the meter's fixed price (the contract).
		const land = (est) => {
			const session = makeLandingSession(baseEvents);
			const reps = [3, 4].map((seq) => ({ seq, kind: "reduce", newContent: stub, reason: "r", beforeChars: textOf(baseEvents.find((e) => e.seq === seq)), afterChars: stub.length }));
			landNodePrunes(session, reps, (e) => est(e.data.message));
			return session;
		};
		// Then the host compacts the remaining surface: shadow = fixed price of
		// the range, replacement = the checkpoint summary message.
		const finish = (session) => {
			// The log in seq order; landed shadow/replace events carry the
			// surfaceOp their append meta recorded (seeded events are plain
			// appends, as dsh-session persists them).
			const metaBySeq = new Map(session.appended.map((a) => [a.seq, a.meta]));
			const all = session.log.map((e) => ({ ...e, surfaceOp: metaBySeq.get(e.seq)?.surfaceOp ?? "append" }));
			const bySeq = new Map(all.map((e) => [e.seq, e]));
			// the host's compaction shadows the current message nodes only
			// (metering events like compaction/prune are not surface events)
			const surface = [...session.surface.nodes].map((s) => bySeq.get(s)).filter((e) => e.type === "user/message" || e.type === "tool/result" || (e.type === "assistant/message" && e.data.message.content.length > 0));
			const fixedRange = surface.reduce((n, e) => n + fixedPriceMessage(e.type === "user/message" ? e.data : e.data.message), 0);
			all.push({ seq: 1000, type: "compaction/summary", data: { shadowedRange: { start: 1, end: 5 }, shadowedSeqs: surface.map((e) => e.seq), shadowedTokenCount: fixedRange } });
			all.push({ seq: 1001, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 5 }, data: { role: "user", content: [{ type: "text", text: "（压缩摘要）此前完成日志检查，存在两项超时问题待确认。" }] } });
			return foldMeterState(all);
		};
		const buggy = finish(land(calibratedPriceMessage));
		assert.ok(buggy < 0, `calibrated claims drive the fold negative (got ${buggy}) — the 2026-09-12 failure mode`);
		const good = finish(land(fixedPriceMessage));
		assert.ok(good >= 0, `fixed claims keep the fold nonnegative (got ${good})`);
	});
