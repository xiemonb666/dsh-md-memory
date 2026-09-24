import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_FORMAT_VERSION, Session } from "@deepseek-ai/dsh-session";

let engine;
try { engine = await import("../../lib/index.js"); } catch { /* host packages are unavailable in a plain checkout */ }

const standard = `- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.72
        retainTokens: 1200
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

# ── next section ──
- id: other
  name: other
`;

function withPresets(minimal, run) {
	const root = mkdtempSync(join(tmpdir(), "mml-compat-"));
	try {
		for (const [name, content] of [["standard", standard], ["minimal", minimal]]) {
			const dir = join(root, name);
			mkdirSync(dir);
			writeFileSync(join(dir, "agent.cordis.yml"), content);
		}
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("preset generator adapts to the current prefix persona and preserves host compaction settings", { skip: !engine }, () => {
	withPresets(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful software engineer assistant.
    complete: true
`, (root) => {
		const { generateMmlComposition } = engine;
		const s = generateMmlComposition({ id: "standard-mml", base: "standard" }, root);
		const m = generateMmlComposition({ id: "minimal-mml", base: "minimal" }, root);
		for (const content of [s, m]) {
			assert.match(content, /name: dsh-md-memory\/engine/);
			assert.match(content, /maxTokens: 32768/);
			assert.match(content, /syncMaxTokens: 32768/);
			assert.match(content, /thresholdRatio: 0\.72/);
			assert.match(content, /retainTokens: 1200/);
			assert.match(content, /vacgcMode: prune/);
			assert.match(content, /vacgcSemantic: true/);
			assert.doesNotMatch(content, /qwen38|vllm/);
		}
		assert.match(m, /prefix: >-\n\s+You are a helpful software engineer assistant\.\n\s+\{\{md_memory\}\}/);
		assert.doesNotMatch(m, /- id: other/);
	});
});

test("long-session MML sync default has room for a complete operation batch", { skip: !engine }, () => {
	assert.equal(engine.MML_DEFAULTS.syncMaxTokens, 32768);
});

test("preset generator accepts the older text persona field", { skip: !engine }, () => {
	withPresets(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
`, (root) => {
		const result = engine.generateMmlComposition({ id: "minimal-mml", base: "minimal" }, root);
		assert.match(result, /text: >-\n\s+You are a helpful software engineer assistant\.\n\s+\{\{md_memory\}\}/);
	});
});

test("calibrated retention follows the base engine's exact-model override precedence", { skip: !engine }, () => {
	const config = { thresholdRatio: 0.8, retainRatio: 0.16, retainTokens: 1200, compactionRetries: 1,
		modelPolicies: [{ provider: "p", model: "m", retainRatio: 0.25, thresholdRatio: 0.7 }] };
	const spec = engine.resolveCalibratedSpec(config, { provider: "p", model: "m" }, 10000);
	assert.equal(spec.retainTokens, 2500);
	assert.equal(spec.thresholdTokens, 7000);
	assert.equal(engine.resolveCalibratedSpec(config, { provider: "p", model: "other" }, 10000).retainTokens, 1200);
});

test("calibrated range never includes the system prompt node", { skip: !engine }, () => {
	const events = new Map([
		[0, { seq: 0, type: "system/message" }],
		[1, { seq: 1, type: "user/message", data: { content: "old" } }],
		[2, { seq: 2, type: "user/message", data: { content: "recent" } }]
	]);
	const session = {
		surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
		eventAt: (seq) => events.get(seq)
	};
	const measurement = { nodes: [{ seq: 0, tokens: 100 }, { seq: 1, tokens: 100 }, { seq: 2, tokens: 100 }] };
	const range = engine.selectCalibratedRange(session, measurement, 0);
	assert.deepEqual(range, { start: 1, end: 1 });
});

test("pre-compaction dedup never skips newly logged messages", { skip: !engine }, () => {
	const now = 1000000;
	const state = { lastSyncedSeq: 2, lastSyncMs: now - 1000 };
	assert.equal(engine.shouldSyncBeforeCompaction(state, { log: [1, 2] }, now), false);
	assert.equal(engine.shouldSyncBeforeCompaction(state, { log: [1, 2, 3] }, now), true);
	assert.equal(engine.shouldSyncBeforeCompaction(state, { log: [1, 2] }, now + 120000), true);
});

test("RPC exact-session resolution never falls through to an unrelated live session", { skip: !engine }, async () => {
	const unrelated = { id: "other", header: { cwd: "C:\\other" } };
	const ctx = {
		sessions: { get: () => undefined, list: () => [unrelated] },
		get: () => undefined
	};
	await assert.rejects(
		engine.resolveRpcSession(ctx, { sessionId: "wanted" }),
		/session "wanted" is not live/
	);
	const legacy = await engine.resolveRpcSession(ctx, {});
	assert.equal(legacy.session, unrelated);
});

test("RPC exact-session resolution reconstructs a validated cold session", { skip: !engine }, async () => {
	const original = Session.create("cold-session", [], {
		version: SESSION_FORMAT_VERSION,
		id: "cold-session",
		createdAt: 1,
		cwd: "C:\\cold-project",
		isSeeded: false
	}, 0);
	let disposed = false;
	const observation = {
		header: original.header,
		inheritedEventCount: original.inheritedEventCount,
		events: original.snapshotEvents(),
		[Symbol.dispose]() { disposed = true; }
	};
	const ctx = {
		sessions: { get: () => undefined, list: () => [] },
		get: (name) => name === "sessionQuery"
			? { observeSession: async (id, options) => {
				assert.equal(id, "cold-session");
				assert.deepEqual(options, { projectionMode: "none" });
				return observation;
			} }
			: undefined
	};
	const resolved = await engine.resolveRpcSession(ctx, { sessionId: "cold-session" });
	assert.equal(resolved.source, "cold");
	assert.equal(resolved.session.id, "cold-session");
	assert.equal(resolved.session.header.cwd, "C:\\cold-project");
	resolved.dispose();
	assert.equal(disposed, true);
});
