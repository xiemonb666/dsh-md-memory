/**
 * VAC-GC PROPERTY tests — the protection classifier must satisfy, for ALL
 * inputs (not just hand-picked units):
 *
 *   (6) for any ACTIVE unresolved ledger fact, VAC-GC can never classify a
 *       lexically-related unit below P1 — the conservative hold (P0.5) is a
 *       sound lower bound, not a heuristic that random inputs can slip past;
 *       and a unit that is NOT lexically related is not held (no blanket
 *       over-protection).
 *   (7) repeated classification of a bound ACTIVE decision's evidence is
 *       STABLE (idempotent — N compaction passes see the same class), and the
 *       P0 lane releases exactly when the entry stops being ACTIVE
 *       (SUPERSEDED/STALE) — never before, never after.
 *
 * Pure (protection.js + a synthetic memory index — no files, no host).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProtection } from "../../lib/vacgc/protection.js";

// Seeded PRNG (same algorithm as the ops fuzz — determinism across runs).
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// Vocab that shares NO substring with any user-intent/decision regex — the
// ONLY lane that may fire for these units is the provenance lane under test.
const SAFE = ["alder", "basil", "cedar", "daisy", "fig", "gourd", "hazel", "iris", "jasmine", "kiwi", "larch", "mallow", "nutmeg", "olive", "poppy", "quince", "rowan", "sorrel", "thistle", "wisteria", "zinnia"];

const memoryWith = (unresolvedTerms, activeSourceIds = new Map()) => ({
	available: true,
	activeIds: new Set([...unresolvedTerms.keys(), ...activeSourceIds.keys()].map((k) => k)),
	unresolvedTerms,
	activeSourceIds: (sessionId, seqs) => {
		const out = new Set();
		for (const [id, seqsForId] of activeSourceIds) {
			for (const s of seqs) if (seqsForId.has(s)) out.add(id);
		}
		return [...out];
	}
});

const unit = (text, seqs = []) => ({ kind: "assistant", text, open: false, terms: { ids: [] }, seqs });

test("property 6: lexically-related units of an ACTIVE unresolved entry are NEVER below P1 (3000 random cases)", () => {
	const rng = mulberry32(2026);
	let held = 0;
	let passed = 0;
	for (let i = 0; i < 3000; i += 1) {
		// random entry "evidence" terms: 2-5 UNIQUE words, 0-2 of them long
		// (≥8 chars) — uniqueness is enforced, otherwise "≥ 2 shared terms"
		// cases could collapse to one term and the expectation would lie.
		const nLong = ri(rng, 0, 2);
		const termCount = ri(rng, 2, 5);
		const terms = [];
		while (terms.length < termCount) {
			const t = terms.length < nLong ? `${pick(rng, SAFE)}-${ri(rng, 100, 999)}` : pick(rng, SAFE);
			if (!terms.includes(t)) terms.push(t);
		}
		const uniqueTerms = terms;
		const memory = memoryWith(new Map([["DEC-042", uniqueTerms]]));
		// filler words come from the pool MINUS the entry's terms, so the
		// unit's lexical overlap with the entry is EXACTLY `included`:
		const fillerPool = SAFE.filter((w) => !uniqueTerms.includes(w) && !uniqueTerms.some((t) => t.startsWith(w + "-")));
		const shuffled = [...uniqueTerms].sort(() => rng() - 0.5);
		const style = rng();
		let included;
		let expectHold;
		if (style < 0.4) {
			included = shuffled.slice(0, 2); // ≥ 2 shared → hold
			expectHold = true;
		} else if (style < 0.6) {
			const long = uniqueTerms.find((t) => t.length >= 8);
			if (long) {
				included = [long]; // one distinctive term → hold
				expectHold = true;
			} else {
				included = shuffled.slice(0, 1);
				expectHold = false;
			}
		} else {
			included = shuffled.slice(0, 1); // one short shared term → no hold
			expectHold = included[0]?.length >= 8;
		}
		const text = `${pick(rng, fillerPool)} ${included.join(" ")} ${pick(rng, fillerPool)}`.trim();
		const res = classifyProtection(unit(text), { memory, sessionId: "s" });
		if (expectHold) {
			assert.ok(res.protection === "P1" || res.protection === "P0", `case ${i}: hold expected for "${text}" (terms ${uniqueTerms.join(",")}) but got ${res.protection}`);
			assert.match(res.reasons.join(" "), /conservative P1 hold/, `case ${i}: the conservative reason must be present`);
			held += 1;
		} else {
			assert.equal(res.protection, "NORMAL", `case ${i}: no lexical relation → no over-protection (got ${res.protection} for "${text}")`);
		}
		passed += 1;
	}
	assert.ok(held > 500, `the hold branch was actually exercised (${held} held cases)`);
	assert.equal(passed, 3000);
});

test("property 7: bound ACTIVE decision evidence is P0 across repeated compaction passes, and releases exactly when the entry closes", () => {
	const memory = memoryWith(new Map(), new Map([["DEC-007", new Set([0])]]));
	// unit text is drawn from the SAFE vocab — no other lane may fire, so the
	// protection class is a pure function of the provenance state:
	const u = unit("the alder basil row from quince", [0]);
	// repeated passes (compaction may classify the same unit many times):
	const first = classifyProtection(u, { memory, sessionId: "s" });
	assert.equal(first.protection, "P0");
	assert.match(first.reasons.join(" "), /original evidence of ACTIVE ledger entry DEC-007/);
	for (let pass = 0; pass < 10; pass += 1) {
		const again = classifyProtection(u, { memory, sessionId: "s" });
		assert.equal(again.protection, "P0", `pass ${pass}: an ACTIVE bound evidence line must stay P0 (got ${again.protection})`);
		assert.deepEqual(again.reasons, first.reasons, "classification is idempotent (no drift across passes)");
	}
	// unit NOT at the evidence seq → no P0 claim (the lane is seq-exact):
	assert.equal(classifyProtection(unit("the alder basil row from quince", [5]), { memory, sessionId: "s" }).protection, "NORMAL");
	// the entry closes (SUPERSEDED/STALE → no longer an active source) → the
	// P0 lane releases, and NOTHING else revives it (the entry was clean):
	const closed = memoryWith(new Map(), new Map());
	const afterClose = classifyProtection(u, { memory: closed, sessionId: "s" });
	assert.equal(afterClose.protection, "NORMAL", "a closed entry's evidence stops being P0");
	assert.ok(!afterClose.reasons.some((r) => r.includes("DEC-007")));
	// …and an ACTIVE entry with UNRESOLVED provenance (the degraded state)
	// still holds its lexical neighborhood at P1 while the P0 lane is absent:
	const degraded = memoryWith(new Map([["DEC-007", ["alder", "quince", "sorrel"]]]));
	const deg = classifyProtection(unit("the alder quince sorrel row"), { memory: degraded, sessionId: "s" });
	assert.equal(deg.protection, "P1");
	assert.match(deg.reasons.join(" "), /conservative P1 hold/);
});

test("property 7 (fuzz): 200 random bound/unbound mixes — P0 iff (seq bound AND entry ACTIVE)", () => {
	const rng = mulberry32(99);
	for (let i = 0; i < 200; i += 1) {
		const nEntries = ri(rng, 1, 4);
		const activeSources = new Map();
		const seqs = [ri(rng, 0, 20)];
		for (let e = 0; e < nEntries; e += 1) {
			if (rng() < 0.7) activeSources.set(`DEC-${String(e + 1).padStart(3, "0")}`, new Set([ri(rng, 0, 20)]));
		}
		const memory = memoryWith(new Map(), activeSources);
		const u = unit(`${pick(rng, SAFE)} ${pick(rng, SAFE)} row`, seqs);
		const bound = [...activeSources.values()].some((s) => s.has(seqs[0]));
		const res = classifyProtection(u, { memory, sessionId: "s" });
		if (bound) {
			assert.equal(res.protection, "P0", `case ${i}: seq ${seqs[0]} backs an ACTIVE entry → P0 (got ${res.protection})`);
			assert.match(res.reasons.join(" "), /original evidence of ACTIVE ledger entry DEC-\d{3} \(provenance\)/);
		} else {
			assert.equal(res.protection, "NORMAL", `case ${i}: unbound seq → no P0 provenance claim (got ${res.protection})`);
		}
	}
});
