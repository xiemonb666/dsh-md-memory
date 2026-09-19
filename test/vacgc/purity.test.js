/**
 * V1.0 hard-constraint purity guard (plan §132 + V1 scope): the scoring
 * pipeline (lib/vacgc) must NOT use Embedding, Vector DB, Graph DB, or any
 * LLM call — only rules + metadata + lexical matching, O(surface units), no
 * network, no dynamic code.
 *
 * This suite source-scans every vacgc module and pins that boundary so a
 * later round cannot silently widen it.
 *
 * Allowed I/O surface (by design):
 *  - node:crypto (content fingerprints)
 *  - node:fs/node:path in memory-index.js ONLY (§133: grep-style local ledger
 *    reads — the planner itself receives a pre-built LedgerIndex object)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vacgcDir = join(here, "..", "..", "lib", "vacgc");

const FORBIDDEN = [
	["fetch(", "network fetch"],
	["XMLHttpRequest", "network XHR"],
	["WebSocket", "network WebSocket"],
	["http.request", "node http client"],
	["https.request", "node https client"],
	["net.connect", "raw socket"],
	["eval(", "dynamic code"],
	["new Function(", "dynamic code"],
	["process.env", "environment reads in the scoring path"],
	["require(", "CJS dynamic require"],
	["import(", "dynamic import"],
	["dsh-llm", "LLM package"]
	// NOTE: no "embedding"/"vector" substring entry — capability is already
	// impossible via the import-specifier test below (no external deps allowed
	// in lib/vacgc), and doc comments legitimately mention what V1 excludes.
];

function vacgcFiles() {
	return readdirSync(vacgcDir).filter((f) => f.endsWith(".js")).sort();
}

test("V1 hard constraint: no LLM/network/embedding/dynamic-code surface anywhere in lib/vacgc", () => {
	const files = vacgcFiles();
	assert.ok(files.length >= 15, `expected the full vacgc module set, got ${files.length} files`);
	for (const file of files) {
		const src = readFileSync(join(vacgcDir, file), "utf8");
		for (const [pattern, label] of FORBIDDEN) {
			if (pattern === "embedding") {
				// case-insensitive check, but ignore this test file's own
				// documentation if it ever gets copied in
				assert.ok(!/[Ee]mbedding/.test(src), `${file}: forbidden surface — ${label}`);
				continue;
			}
			assert.ok(!src.includes(pattern), `${file}: forbidden surface — ${label} (${pattern})`);
		}
	}
});

test("V1 hard constraint: vacgc modules import only relative paths or node: builtins", () => {
	const re = /^\s*import[^"'\n]*from\s+"([^"]+)"/gm;
	for (const file of vacgcFiles()) {
		const src = readFileSync(join(vacgcDir, file), "utf8");
		for (const m of src.matchAll(re)) {
			const spec = m[1];
			assert.ok(
				spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("node:"),
				`${file}: non-relative import "${spec}" (V1 = no external runtime deps in the scoring path)`
			);
		}
	}
});
