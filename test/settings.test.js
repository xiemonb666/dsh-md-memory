import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONTINUATION,
	DEFAULT_SAFETY_MARGIN_TOKENS,
	budgetNeedsCompaction,
	budgetForRoute,
	looksLikeContextOverflow,
	routeKey,
	safeOutputBudget,
	validateRoutePatch
} from "../lib/settings.js";

test("safe output budget prevents the exact 200016+1 overflow", () => {
	const safe = safeOutputBudget({
		targetContextTokens: 200016,
		projectedInputTokens: 134481,
		configuredMaxOutput: 65536,
		safetyMarginTokens: 2048
	});
	assert.equal(safe, 63487);
	assert.ok(134481 + safe + 2048 <= 200016);
});

test("safe output budget returns zero when compaction cannot leave one token", () => {
	assert.equal(safeOutputBudget({ targetContextTokens: 8192, projectedInputTokens: 8192, configuredMaxOutput: 1024 }), 0);
});

test("budget preflight compacts before clamping a request that only partly fits", () => {
	assert.equal(budgetNeedsCompaction({ targetContextTokens: 200016, projectedInputTokens: 134481, configuredMaxOutput: 65536, safetyMarginTokens: 2048 }), true);
	assert.equal(budgetNeedsCompaction({ targetContextTokens: 200016, projectedInputTokens: 100000, configuredMaxOutput: 65536, safetyMarginTokens: 2048 }), false);
});

test("route budget defaults preserve adapter capabilities and continuation defaults", () => {
	const budget = budgetForRoute("vllm", "qwen38-agent", { contextWindow: 200016, maxTokens: 65536 }, {});
	assert.equal(budget.targetContextTokens, 200016);
	assert.equal(budget.maxOutputTokens, 65536);
	assert.equal(budget.safetyMarginTokens, DEFAULT_SAFETY_MARGIN_TOKENS);
	assert.deepEqual(budget.continuation, DEFAULT_CONTINUATION);
});

test("unknown adapter output limit does not become a zero-token request", () => {
	const budget = budgetForRoute("vllm", "qwen38-agent", { contextWindow: 262144, maxTokens: 0 }, { maxTokens: 65536 });
	assert.equal(budget.maxOutputTokens, 65536);
	assert.equal(safeOutputBudget({ targetContextTokens: budget.targetContextTokens, projectedInputTokens: 741, configuredMaxOutput: budget.maxOutputTokens, safetyMarginTokens: budget.safetyMarginTokens }), 65536);
});

test("settings validation rejects values above model hard limits", () => {
	assert.throws(() => validateRoutePatch({ targetContextTokens: 200017 }, { contextWindow: 200016, maxTokens: 65536 }), (error) => error.code === "SETTINGS_VALIDATION" && error.field === "targetContextTokens");
	assert.throws(() => validateRoutePatch({ maxOutputTokens: 65537 }, { contextWindow: 200016, maxTokens: 65536 }), /maxOutputTokens/);
	assert.throws(() => validateRoutePatch({ continuation: { maxCount: 11 } }, { contextWindow: 200016, maxTokens: 65536 }), /maxCount/);
});

test("legacy context overflow wording is recognized", () => {
	assert.equal(looksLikeContextOverflow("This model's maximum context length is 200016. However, you requested 65536 output tokens"), true);
	assert.equal(looksLikeContextOverflow("rate limit exceeded"), false);
	assert.equal(routeKey("vllm", "qwen38-agent"), "vllm/qwen38-agent");
});

test("settings validation keeps output and retention inside the selected target", () => {
	assert.throws(() => validateRoutePatch({ targetContextTokens: 8192, maxOutputTokens: 7000, safetyMarginTokens: 2048 }, { contextWindow: 200016, maxTokens: 65536 }), /maxOutputTokens/);
	assert.throws(() => validateRoutePatch({ targetContextTokens: 10000, thresholdRatio: 0.5, retainTokens: 5000 }, { contextWindow: 200016, maxTokens: 65536 }), /retain budget/);
	assert.equal(validateRoutePatch({ targetContextTokens: 10000, maxOutputTokens: 7000, safetyMarginTokens: 1024, thresholdRatio: 0.8, retainTokens: 2000 }, { contextWindow: 200016, maxTokens: 65536 }), true);
});
