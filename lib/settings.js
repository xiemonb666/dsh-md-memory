import z from "@deepseek-ai/schemastery";

/** Durable settings namespace owned by the plugin. */
export const SETTINGS_NAMESPACE = "dsh-md-memory";

/** Conservative headroom that prevents an exact-boundary provider rejection. */
export const DEFAULT_SAFETY_MARGIN_TOKENS = 2048;
export const DEFAULT_CONTINUATION = Object.freeze({ enabled: true, maxCount: 3, prompt: "继续" });

const routeKeyPattern = /^[^/\\s]+\/[^/\\s]+$/u;

/** Settings are profile-owned; route values are partial so host defaults remain authoritative. */
export const RouteSettingsSchema = z.object({
	targetContextTokens: z.number().step(1).min(1024).required(false),
	maxOutputTokens: z.number().step(1).min(1).required(false),
	safetyMarginTokens: z.number().step(1).min(0).required(false),
	thresholdRatio: z.number().min(0.05).max(0.99).required(false),
	retainRatio: z.number().min(0.01).max(0.98).required(false),
	retainTokens: z.number().step(1).min(0).required(false),
	compactionRetries: z.number().step(1).min(0).max(10).required(false),
	maxOverflowRetries: z.number().step(1).min(0).max(10).required(false),
	continuation: z.object({
		enabled: z.boolean().required(false),
		maxCount: z.number().step(1).min(0).max(10).required(false),
		prompt: z.string().required(false)
	}).required(false)
});

export const SettingsSchema = z.object({
	version: z.number().step(1).min(1).required(false),
	routes: z.dict(RouteSettingsSchema).required(false)
});

const state = {
	value: { version: 1, routes: {} },
	scope: null,
	provider: null,
	revision: 0,
	subscribers: new Set()
};

function settingsValidationError(field, message) {
	const error = new Error(message);
	error.code = "SETTINGS_VALIDATION";
	error.field = field;
	return error;
}

function clone(value) {
	return structuredClone(value ?? {});
}

function notify() {
	for (const callback of [...state.subscribers]) {
		try { callback(); } catch { /* settings observers must never break the host */ }
	}
}

/** Register the profile namespace when the host exposes ctx.settings. */
export function installSettings(ctx) {
	ctx.inject?.(["settings"], (settingsCtx) => {
		try {
			const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, {
				base: { version: 1, routes: {} },
				applies: "live"
			});
			state.scope = scope;
			state.provider = settingsCtx.settings;
			state.value = clone(scope.get());
			state.revision = settingsCtx.settings.describe({ redactSecrets: false }).find((entry) => entry.ns === SETTINGS_NAMESPACE)?.revision ?? 0;
			const dispose = scope.watch(() => {
				state.value = clone(scope.get());
				state.revision = settingsCtx.settings.describe({ redactSecrets: false }).find((entry) => entry.ns === SETTINGS_NAMESPACE)?.revision ?? state.revision;
				notify();
			});
			ctx.effect(() => dispose, `dsh-md-memory: settings watch`);
			notify();
		} catch (error) {
			ctx.logger?.warn?.(`md-memory: settings namespace unavailable (${error?.message ?? error})`);
		}
	});
}

export function subscribeSettings(callback) {
	state.subscribers.add(callback);
	return () => state.subscribers.delete(callback);
}

export function settingsScope() {
	return state.scope;
}

export function settingsValue() {
	return clone(state.value);
}

export function settingsRevision() {
	return state.revision;
}

export function settingsDescriptor() {
	return {
		ns: SETTINGS_NAMESPACE,
		value: settingsValue(),
		revision: state.revision,
		available: state.provider !== null
	};
}

export async function updateRouteSettings(provider, model, patch, expectedRevision, caps) {
	if (!state.provider) throw new Error("DSH settings service is unavailable");
	const key = routeKey(provider, model);
	if (!key) throw new Error("provider/model route is required");
	const current = routeSettings(provider, model).configured;
	const merged = {
		...current,
		...patch,
		...(patch?.continuation === undefined ? {} : { continuation: { ...(current.continuation ?? {}), ...patch.continuation } })
	};
	validateRoutePatch(merged, caps);
	return state.provider.update(SETTINGS_NAMESPACE, { routes: { [key]: patch } }, expectedRevision);
}

export function routeKey(provider, model) {
	const key = `${String(provider ?? "")}/${String(model ?? "")}`;
	return routeKeyPattern.test(key) ? key : "";
}

export function routeSettings(provider, model) {
	const key = routeKey(provider, model);
	const configured = key ? state.value.routes?.[key] : undefined;
	return {
		key,
		configured: clone(configured ?? {}),
		safetyMarginTokens: Number.isInteger(configured?.safetyMarginTokens) ? configured.safetyMarginTokens : DEFAULT_SAFETY_MARGIN_TOKENS,
		continuation: {
			enabled: configured?.continuation?.enabled ?? DEFAULT_CONTINUATION.enabled,
			maxCount: Number.isInteger(configured?.continuation?.maxCount) ? configured.continuation.maxCount : DEFAULT_CONTINUATION.maxCount,
			prompt: typeof configured?.continuation?.prompt === "string" && configured.continuation.prompt.length > 0 ? configured.continuation.prompt : DEFAULT_CONTINUATION.prompt
		}
	};
}

/** Validate a route patch against the adapter's hard capabilities. */
export function validateRoutePatch(patch, caps = {}) {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw settingsValidationError("$", "settings patch must be an object");
	const hardContext = Number.isInteger(caps.contextWindow) && caps.contextWindow > 0 ? caps.contextWindow : Infinity;
	const routeMaxOutput = Number.isInteger(caps.maxTokens) && caps.maxTokens > 0 ? caps.maxTokens : Infinity;
	const integerFields = ["targetContextTokens", "maxOutputTokens", "safetyMarginTokens", "retainTokens", "compactionRetries", "maxOverflowRetries"];
	for (const key of integerFields) if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || patch[key] < 0)) throw settingsValidationError(key, `${key} must be a non-negative integer`);
	if (patch.targetContextTokens !== undefined && (patch.targetContextTokens < 1024 || patch.targetContextTokens > hardContext)) throw settingsValidationError("targetContextTokens", `targetContextTokens must be between 1024 and ${hardContext}`);
	if (patch.maxOutputTokens !== undefined && (patch.maxOutputTokens < 1 || patch.maxOutputTokens > routeMaxOutput)) throw settingsValidationError("maxOutputTokens", `maxOutputTokens must be between 1 and ${routeMaxOutput}`);
	const targetContext = Math.min(patch.targetContextTokens ?? hardContext, hardContext);
	const safetyMargin = patch.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
	if (safetyMargin > hardContext - 1 || safetyMargin >= targetContext) throw settingsValidationError("safetyMarginTokens", "safetyMarginTokens must leave at least one output token within targetContextTokens");
	if (patch.maxOutputTokens !== undefined && patch.maxOutputTokens > targetContext - safetyMargin) throw settingsValidationError("maxOutputTokens", `maxOutputTokens must be <= targetContextTokens - safetyMarginTokens (${targetContext - safetyMargin})`);
	if (patch.thresholdRatio !== undefined && (!Number.isFinite(patch.thresholdRatio) || patch.thresholdRatio < 0.05 || patch.thresholdRatio > 0.99)) throw settingsValidationError("thresholdRatio", "thresholdRatio must be between 0.05 and 0.99");
	if (patch.retainRatio !== undefined && (!Number.isFinite(patch.retainRatio) || patch.retainRatio < 0.01 || patch.retainRatio > 0.98)) throw settingsValidationError("retainRatio", "retainRatio must be between 0.01 and 0.98");
	if (patch.compactionRetries !== undefined && patch.compactionRetries > 10) throw settingsValidationError("compactionRetries", "compactionRetries must be between 0 and 10");
	if (patch.maxOverflowRetries !== undefined && patch.maxOverflowRetries > 10) throw settingsValidationError("maxOverflowRetries", "maxOverflowRetries must be between 0 and 10");
	if (patch.continuation !== undefined) {
		if (typeof patch.continuation !== "object" || Array.isArray(patch.continuation)) throw settingsValidationError("continuation", "continuation must be an object");
		if (patch.continuation.maxCount !== undefined && (!Number.isSafeInteger(patch.continuation.maxCount) || patch.continuation.maxCount < 0 || patch.continuation.maxCount > 10)) throw settingsValidationError("continuation.maxCount", "continuation.maxCount must be between 0 and 10");
		if (patch.continuation.prompt !== undefined && (typeof patch.continuation.prompt !== "string" || patch.continuation.prompt.trim().length === 0 || patch.continuation.prompt.length > 200)) throw settingsValidationError("continuation.prompt", "continuation.prompt must be 1-200 characters");
	}
	const thresholdRatio = patch.thresholdRatio ?? caps.defaultThresholdRatio;
	const retainTokens = patch.retainTokens ?? (patch.retainRatio !== undefined && Number.isFinite(targetContext) ? Math.floor(targetContext * patch.retainRatio) : caps.defaultRetainTokens);
	if (thresholdRatio !== undefined && retainTokens !== undefined && retainTokens >= Math.floor(targetContext * thresholdRatio)) throw settingsValidationError(patch.retainTokens !== undefined ? "retainTokens" : "retainRatio", "retain budget must be lower than the compression threshold budget");
	return true;
}

/** Add the profile route override to an engine's immutable base policy table. */
export function withRoutePolicy(baseConfig, provider, model) {
	const route = routeSettings(provider, model).configured;
	const keys = ["thresholdRatio", "retainRatio", "retainTokens", "compactionRetries", "maxOverflowRetries"];
	if (!keys.some((key) => route[key] !== undefined)) return baseConfig;
	const existing = Array.isArray(baseConfig.modelPolicies) ? baseConfig.modelPolicies : [];
	const withoutRoute = existing.filter((policy) => policy.provider !== provider || policy.model !== model);
	const policy = { provider, model };
	for (const key of keys) if (route[key] !== undefined) policy[key] = route[key];
	return { ...baseConfig, modelPolicies: [...withoutRoute, policy] };
}

/** Effective target and output defaults for the active route. */
export function budgetForRoute(provider, model, caps = {}, base = {}) {
	const route = routeSettings(provider, model).configured;
	const contextWindow = Number.isInteger(caps.contextWindow) && caps.contextWindow > 0 ? caps.contextWindow : 0;
	const adapterMax = Number.isInteger(caps.maxTokens) && caps.maxTokens > 0 ? caps.maxTokens : 0;
	return {
		contextWindow,
		targetContextTokens: Math.min(route.targetContextTokens ?? contextWindow, contextWindow || Number.MAX_SAFE_INTEGER),
		maxOutputTokens: Math.min(route.maxOutputTokens ?? adapterMax ?? base.maxTokens ?? 1, adapterMax || Number.MAX_SAFE_INTEGER),
		safetyMarginTokens: route.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS,
		thresholdRatio: route.thresholdRatio ?? base.thresholdRatio,
		retainRatio: route.retainRatio ?? base.retainRatio,
		retainTokens: route.retainTokens ?? base.retainTokens,
		compactionRetries: route.compactionRetries ?? base.compactionRetries,
		maxOverflowRetries: route.maxOverflowRetries ?? base.maxOverflowRetries,
		continuation: { ...DEFAULT_CONTINUATION, ...(route.continuation ?? {}) }
	};
}

/** Compute a request-safe output budget. */
export function safeOutputBudget({ targetContextTokens, projectedInputTokens, configuredMaxOutput, safetyMarginTokens = DEFAULT_SAFETY_MARGIN_TOKENS }) {
	const target = Math.max(1, Math.trunc(Number(targetContextTokens) || 0));
	const input = Math.max(0, Math.trunc(Number(projectedInputTokens) || 0));
	const requested = Math.max(1, Math.trunc(Number(configuredMaxOutput) || 1));
	const margin = Math.max(0, Math.trunc(Number(safetyMarginTokens) || 0));
	return Math.max(0, Math.min(requested, target - input - margin));
}

/** Whether the configured request would exceed the target before clamping. */
export function budgetNeedsCompaction({ targetContextTokens, projectedInputTokens, configuredMaxOutput, safetyMarginTokens = DEFAULT_SAFETY_MARGIN_TOKENS }) {
	const target = Math.max(1, Math.trunc(Number(targetContextTokens) || 0));
	const input = Math.max(0, Math.trunc(Number(projectedInputTokens) || 0));
	const requested = Math.max(1, Math.trunc(Number(configuredMaxOutput) || 1));
	const margin = Math.max(0, Math.trunc(Number(safetyMarginTokens) || 0));
	return input + requested + margin > target;
}

export function looksLikeContextOverflow(message) {
	return /context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)|maximum(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)|(?:input|prompt|request|messages?)\b.{0,60}\b(?:exceed(?:ed|s)?|too\s+(?:large|long))\b.{0,60}\bcontext\b/i.test(String(message ?? ""));
}

export function resetRoute(provider, model, expectedRevision) {
	if (!state.provider) throw new Error("DSH settings service is unavailable");
	return state.provider.mutate(SETTINGS_NAMESPACE, [{ op: "unset", path: ["routes", routeKey(provider, model)] }], expectedRevision);
}
