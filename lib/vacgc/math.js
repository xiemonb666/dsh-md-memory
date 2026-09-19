/**
 * VAC-GC shared math helpers (pure).
 */

/**
 * Clamp x into [min, max].
 * @param x - value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns clamped value.
 */
export function clamp(x, min, max) {
	const v = Number(x);
	if (!Number.isFinite(v)) return min;
	return Math.min(max, Math.max(min, v));
}

/**
 * Deep-merge a partial config over defaults (objects only, no arrays —
 * arrays are replaced wholesale, matching DSH's config-patch semantics).
 * @param defaults - default object.
 * @param override - partial override.
 * @returns merged object (new).
 */
export function mergeConfig(defaults, override) {
	if (override === null || override === undefined) return { ...defaults };
	const out = { ...defaults };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		if (value !== null && typeof value === "object" && !Array.isArray(value)
			&& out[key] !== null && typeof out[key] === "object" && !Array.isArray(out[key])) {
			out[key] = mergeConfig(out[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
}
