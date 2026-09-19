/**
 * P1-② Operation contract — PROPERTY / FUZZ tests (the user's preferred style
 * over hand-written case piles): thousands of random state transitions through
 * planOperations + applyOperations, asserting invariants that must hold for
 * EVERY possible operation mix — not just the 230 hand-picked cases:
 *
 *   (1) no valid or invalid operation can silently erase an existing entry;
 *   (2) no exact atom may enter/replace an entry without verbatim support in
 *       the cited evidence (Mutation Guard);
 *   (3) a failed independent operation cannot invalidate unrelated valid ops;
 *   (4) a failed transactionGroup leaves every target byte-identical;
 *   plus: full coverage (every op is exactly once applied-or-rejected), id
 *   minting (unique, correct format, no collision with the base), entry-count
 *   accounting, and determinism (same seed → byte-identical evolution).
 *
 * Pure module under test (lib/ledger-ops.js) — runs without host packages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planOperations, applyOperations, parseLedgerFile, extractExactAtoms, normText } from "../../lib/ledger-ops.js";

// ---------------------------------------------------------------------------
// seeded PRNG (mulberry32) — deterministic across runs and platforms
// ---------------------------------------------------------------------------

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

// controlled vocab: shares NO substring with any protection/constraint regex
// (irrelevant here — the ops module has no NER — but keeps row text clean of
// accidental "evidence" for atom checks)
const WORDS = ["alder", "basil", "cedar", "daisy", "elm", "fig", "gourd", "hazel", "iris", "jasmine", "kiwi", "larch", "mallow", "nutmeg", "olive", "poppy", "quince", "rowan", "sorrel", "thistle"];

// ---------------------------------------------------------------------------
// random world generators
// ---------------------------------------------------------------------------

/** Random row text that carries one controlled atom. */
function randomRow(rng, tag) {
	const num = (ri(rng, 3, 99)).toFixed(2);
	return `${pick(rng, WORDS)} ${pick(rng, WORDS)} trial ${tag}: measured ${num} tok/s at ${ri(rng, 10, 40)}k context`;
}

/** The round's durable log: 3 base rows + a DUPLICATE pair (for the
 *  ambiguous-quote variant) + the per-round atom rows the ops may cite. */
function makeRows(rng, round) {
	const a1 = (ri(rng, 3, 99)).toFixed(2);
	const a2 = (ri(rng, 3, 99)).toFixed(2);
	const r1 = randomRow(rng, "A");
	const rows = [
		{ seq: 0, text: `[user]\n${r1}` },
		{ seq: 1, text: `[user]\n${randomRow(rng, "B")}` },
		{ seq: 2, text: `[user]\n${r1}` }, // exact duplicate of seq 0
		{ seq: 3, text: `[user]\npatch round: measured ${a1} tok/s done` },
		{ seq: 4, text: `[user]\npatch round two: measured ${a2} tok/s done` }
	];
	return { rows, atoms: { a1, a2 } };
}

const handlesOf = (rows) => new Map(rows.map((row, i) => [`E${i + 1}`, row]));

/** A 12+ char verbatim substring of a row (quote evidence). */
function quoteOf(rng, row) {
	const t = row.text;
	const start = ri(rng, 0, Math.max(0, t.length - 13));
	return t.slice(start, Math.min(t.length, start + ri(rng, 13, 24)));
}

/** Random initial ledger (the "before" world). */
function randomInitialLedger(rng) {
	const files = {
		"PROJECT.md": "# PROJECT — Requirements & Scope\n",
		"STATE.md": "# STATE — Current State\n\n## [STATE-CURRENT] (no sync yet)\n",
		"DECISIONS.md": "# DECISIONS\n",
		"TECH.md": "# TECH — Technical Facts & Conventions\n",
		"CONFLICTS.md": "# CONFLICTS — Integrity Conflicts\n"
	};
	const counters = { REQ: 0, DEC: 0, TECH: 0, CONFLICT: 0 };
	const mkEntry = (prefix, title, extra = "") => {
		counters[prefix] += 1;
		const id = `${prefix}-${String(counters[prefix]).padStart(3, "0")}`;
		const facts = Array.from({ length: ri(rng, 1, 3) }, () => `- ${pick(rng, WORDS)} ${pick(rng, WORDS)}`);
		return { id, text: `## [${id}] ${title}\n- confidence: ${(0.5 + rng() * 0.5).toFixed(2)}\n- status: ACTIVE\n${facts.join("\n")}\n${extra}` };
	};
	for (let i = 0; i < ri(rng, 0, 3); i += 1) {
		const e = mkEntry("REQ", `${pick(rng, WORDS)} support`);
		files["PROJECT.md"] += `\n${e.text}\n`;
	}
	let firstDec = null;
	for (let i = 0; i < ri(rng, 1, 3); i += 1) {
		const e = mkEntry("DEC", `${pick(rng, WORDS)} choice`);
		if (!firstDec && rng() < 0.4) firstDec = e.id; // a candidate for SUPERSEDED siblings
		files["DECISIONS.md"] += `\n${e.text}\n`;
	}
	if (firstDec) {
		counters.DEC += 1;
		const id = `DEC-${String(counters.DEC).padStart(3, "0")}`;
		files["DECISIONS.md"] += `\n## [${id}] closed sibling\n- confidence: 0.7\n- status: SUPERSEDED\n- replacement: ${firstDec}\n`;
	}
	for (let i = 0; i < ri(rng, 0, 3); i += 1) {
		const e = mkEntry("TECH", `${pick(rng, WORDS)} fact`);
		files["TECH.md"] += `\n${e.text}\n`;
	}
	if (rng() < 0.7) {
		const e = mkEntry("CONFLICT", `${pick(rng, WORDS)} disagreement`);
		files["CONFLICTS.md"] += `\n${e.text}\n`;
	}
	return files;
}

const entryIds = (files) => {
	const ids = new Map(); // id -> file
	for (const [name, content] of Object.entries(files)) {
		for (const e of parseLedgerFile(content).entries) ids.set(e.id, name);
	}
	return ids;
};

const activeEntry = (rng, files) => {
	const cands = [];
	for (const [name, content] of Object.entries(files)) {
		for (const e of parseLedgerFile(content).entries) {
			if (e.id === "STATE-CURRENT") continue;
			if ((e.status ?? "ACTIVE") === "ACTIVE") cands.push(e);
		}
	}
	return cands.length ? pick(rng, cands) : null;
};

// ---------------------------------------------------------------------------
// random operation generation
// ---------------------------------------------------------------------------

/**
 * Generate one random operation (plus the bookkeeping the invariant checks
 * need: the expected evidence text, the target, the group).
 */
function randomOp(rng, files, rows, handles, round, slot) {
	const { a1, a2 } = makeAtoms(rng);
	const group = rng() < 0.4 ? `G${round}` : null;
	const kind = rng();
	const mk = { evidenceText: null, targetId: null, addedAtom: null };
	let op;
	if (kind < 0.22) {
		// ADD
		const addKind = pick(rng, ["REQ", "DEC", "TECH"]);
		const bodyLine = () => {
			const atom = mk.addedAtom ? ` ${mk.addedAtom}` : "";
			return `${pick(rng, WORDS)} ${pick(rng, WORDS)}${atom}`;
		};
		op = { op: "ADD", kind: addKind, title: `${pick(rng, WORDS)} ${pick(rng, WORDS)}`, confidence: 0.5 + rng() * 0.5, body: Array.from({ length: ri(rng, 1, 2) }, bodyLine).join("\n") };
		// evidence mix
		const v = rng();
		if (v < 0.45) {
			// valid ref; the body's atom (if any) is taken FROM that row
			const row = pick(rng, rows);
			if (rng() < 0.4) mk.addedAtom = (extractExactAtoms(row.text) ? [...extractExactAtoms(row.text)].find((t) => t.includes("tok/s")) : null) ?? a1;
			op.body = Array.from({ length: ri(rng, 1, 2) }, bodyLine).join("\n");
			op.source_ref = `E${[...handles.values()].indexOf(row) + 1}`;
			op.source_quote = quoteOf(rng, row);
			mk.evidenceText = row.text;
			mk.kind = "valid";
		} else if (v < 0.6) {
			// drift: a NEW atom not present in the cited row
			mk.addedAtom = a2;
			op.body = `drifted value ${a2} tok/s`;
			const row = rows[0];
			op.source_ref = "E1";
			op.source_quote = quoteOf(rng, row);
			mk.evidenceText = row.text;
			mk.kind = "drift";
		} else if (v < 0.72) {
			// wrong handle: the quote belongs to another row
			op.body = `${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
			op.source_ref = "E2";
			op.source_quote = quoteOf(rng, rows[0]);
			mk.evidenceText = rows[1]?.text ?? null;
			mk.kind = "wrong";
		} else if (v < 0.82) {
			op.body = `${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
			op.source_ref = "E99";
			op.source_quote = "words from nowhere at all";
			mk.kind = "unknown";
		} else if (v < 0.9) {
			// ambiguous: the duplicate row pair (seq 0 & 2 share the text)
			op.body = `${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
			op.source_quote = quoteOf(rng, rows[0]);
			mk.kind = "ambiguous";
		} else {
			op.body = `${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
			mk.kind = "none";
		}
	} else if (kind < 0.37) {
		// AMEND
		const target = activeEntry(rng, files);
		op = { op: "AMEND", target_id: target?.id ?? (rng() < 0.5 ? "DEC-999" : "DEC-000"), body: `${pick(rng, WORDS)} ${pick(rng, WORDS)}` };
		mk.targetId = op.target_id;
		const v = rng();
		if (v < 0.5 && target) {
			const row = pick(rng, rows);
			op.source_ref = `E${[...handles.values()].indexOf(row) + 1}`;
			op.source_quote = quoteOf(rng, row);
			mk.evidenceText = row.text;
			mk.kind = "valid";
		} else if (v < 0.7 && target) {
			mk.addedAtom = a2;
			op.body = `updated to ${a2} tok/s`;
			op.source_ref = "E3";
			op.source_quote = quoteOf(rng, rows[2]);
			mk.evidenceText = rows[2].text;
			mk.kind = "drift";
		} else {
			op.source_ref = "E99";
			op.source_quote = "absent evidence text";
			mk.kind = "unknown";
		}
	} else if (kind < 0.48) {
		// SUPERSEDE
		const target = activeEntry(rng, files);
		const rep = { kind: target ? (target.id.startsWith("TECH") ? "TECH" : target.id.slice(0, 3)) : "DEC", title: `${pick(rng, WORDS)} v2`, body: `${pick(rng, WORDS)} ${pick(rng, WORDS)}`, source_ref: "E1", source_quote: quoteOf(rng, rows[0]) };
		op = { op: "SUPERSEDE", target_id: target?.id ?? "DEC-999", replacement: rep };
		mk.targetId = op.target_id;
		mk.evidenceText = rows[0].text;
		mk.kind = target ? "valid" : "unknown";
	} else if (kind < 0.58) {
		// CONFLICT
		op = { op: "CONFLICT", topic: `${pick(rng, WORDS)} ${pick(rng, WORDS)}`, body: `side A: ${pick(rng, WORDS)}\nside B: ${pick(rng, WORDS)}`, source_ref: "E1", source_quote: quoteOf(rng, rows[0]) };
		mk.evidenceText = rows[0].text;
		mk.kind = "valid";
	} else if (kind < 0.66) {
		// RESOLVE_CONFLICT — targets the BASE ledger only (same-batch entries
		// are invisible to validation — that is asserted as an invariant too).
		const conflicts = Object.entries(files).flatMap(([name, content]) => parseLedgerFile(content).entries.filter((e) => e.id.startsWith("CONFLICT-") && (e.status ?? "ACTIVE") === "ACTIVE"));
		op = { op: "RESOLVE_CONFLICT", target_id: conflicts.length ? pick(rng, conflicts).id : "CONFLICT-999", resolution: `user chose ${pick(rng, WORDS)}`, source_ref: "E1", source_quote: quoteOf(rng, rows[0]) };
		mk.targetId = op.target_id;
		mk.evidenceText = rows[0].text;
		mk.kind = conflicts.length ? "valid" : "unknown";
	} else if (kind < 0.76) {
		// UPDATE_STATE
		op = { op: "UPDATE_STATE", title: `round ${round}`, body: `- still ${pick(rng, WORDS)}` };
		if (rng() < 0.2) {
			op.source_ref = "E1";
			op.source_quote = quoteOf(rng, rows[0]);
			mk.evidenceText = rows[0].text;
		}
		mk.kind = "valid";
	} else if (kind < 0.86) {
		op = { op: "NOOP", reason: `${pick(rng, WORDS)} only` };
		mk.kind = "noop";
	} else {
		// structurally bad op (BAD_OPERATION)
		op = rng() < 0.5 ? { op: "MUTATE", body: "x" } : { op: "ADD", kind: "DEC", title: "no body" };
		mk.kind = "bad";
	}
	if (group) op.transactionGroup = group;
	return { op, mk };
}

const makeAtoms = (rng) => ({ a1: `${ri(rng, 3, 99)}.${ri(rng, 10, 99)}`, a2: `${ri(rng, 3, 99)}.${ri(rng, 10, 99)}` });

// ---------------------------------------------------------------------------
// the fuzz loop
// ---------------------------------------------------------------------------

function runFuzz(seed, rounds) {
	const rng = mulberry32(seed);
	let files = randomInitialLedger(rng);
	const stats = { ops: 0, applied: 0, rejected: 0, groupRejects: 0, rounds: 0 };

	for (let round = 0; round < rounds; round += 1) {
		const { rows, atoms } = makeRows(rng, round);
		const handles = handlesOf(rows);
		const n = ri(rng, 0, 7);
		const batch = Array.from({ length: n }, (_, slot) => randomOp(rng, files, rows, handles, round, slot));

		const plan = planOperations({ operations: batch.map((b) => b.op), history: `fuzz r${round}` }, { files, handles, rows });
		assert.ok(plan.ok, `r${round}: structural plan failure: ${plan.error}`);
		stats.rounds += 1;

		// coverage: every op is exactly once in applied ∪ rejected
		const seen = new Set();
		for (const r of plan.rejected) {
			assert.ok(!seen.has(r.index), `r${round}: index ${r.index} rejected twice`);
			seen.add(r.index);
			stats.rejected += 1;
		}
		for (const p of plan.applied) {
			assert.ok(!seen.has(p.index), `r${round}: index ${p.index} in applied AND rejected`);
			seen.add(p.index);
			stats.applied += 1;
		}
		assert.equal(seen.size, n, `r${round}: ${n} ops, ${seen.size} accounted`);

		const { nextFiles } = applyOperations(files, plan.applied);

		// (1) no silent erasure: every base entry id survives (closed entries
		// stay present — nothing is ever deleted)
		for (const id of entryIds(files).keys()) {
			assert.ok(entryIds(nextFiles).has(id), `r${round}: entry ${id} silently erased`);
		}

		// id minting: unique, correct format, no collision with the base
		const baseIds = entryIds(files);
		const minted = [];
		for (const p of plan.applied) {
			if (!p.id) continue;
			minted.push(p.id);
			assert.match(p.id, /^(REQ|DEC|TECH|CONFLICT)-\d{3}$/, `r${round}: bad minted id ${p.id}`);
			assert.ok(!baseIds.has(p.id), `r${round}: minted ${p.id} collides with the base`);
		}
		assert.equal(new Set(minted).size, minted.length, `r${round}: duplicate minted ids in one batch`);

		// entry-count accounting
		const count = (f) => Object.values(f).reduce((sum, c) => sum + parseLedgerFile(c).entries.length, 0);
		const added = plan.applied.filter((p) => p.op.name === "ADD" || p.op.name === "SUPERSEDE" || p.op.name === "CONFLICT").length;
		assert.equal(count(nextFiles), count(files) + added, `r${round}: entry count ${count(files)} + ${added} != ${count(nextFiles)}`);

		// (3)+(4) group atomicity: a failed group rejects ALL its members and
		// leaves every target byte-identical; independent valid ops commit.
		const failedGroups = new Set(plan.rejected.filter((r) => r.group).map((r) => r.group));
		for (const r of plan.rejected) {
			if (r.reason === "GROUP_REJECTED") {
				stats.groupRejects += 1;
				const batchGroup = batch.filter((b) => b.op.transactionGroup === r.group);
				assert.ok(batchGroup.length >= 2, `r${round}: GROUP_REJECTED without a group`);
				for (const b of batchGroup) {
					assert.ok(plan.rejected.some((x) => x.index === batch.indexOf(b)), `r${round}: group member ${JSON.stringify(b.op)} escaped the group rejection`);
				}
				// the targets of the rejected members are untouched — unless
				// ANOTHER (legitimately applied, independent) op edited the
				// same entry in the same batch, in which case the net change
				// is that other op's and is legitimate.
				for (const b of batchGroup) {
					const tid = b.mk.targetId;
					if (tid && baseIds.has(tid) && !plan.applied.some((p) => p.op.targetId === tid)) {
						const before = parseLedgerFile(files[baseIds.get(tid)]).entries.find((e) => e.id === tid);
						const after = parseLedgerFile(nextFiles[baseIds.get(tid)]).entries.find((e) => e.id === tid);
						assert.deepEqual(after, before, `r${round}: failed group mutated target ${tid}`);
					}
				}
			}
		}
		for (const p of plan.applied) {
			assert.ok(!p.op.transactionGroup || !failedGroups.has(p.op.transactionGroup), `r${round}: applied op from a failed group`);
		}

		// (2) Mutation Guard re-check: every APPLIED gated op's added atoms are
		// verbatim in its cited evidence (independent re-derivation).
		for (const p of plan.applied) {
			const b = batch[p.index];
			if (!b.mk.evidenceText) continue; // rejected-evidence ops are not applied; UPDATE_STATE is not gated
			const ev = normText(b.mk.evidenceText);
			const oldText = p.op.name === "AMEND" || p.op.name === "SUPERSEDE" ? entryTextOf(files, b.mk.targetId) : "";
			const newText = p.op.name === "SUPERSEDE" ? p.op.replacement.body : p.op.body;
			const oldAtoms = extractExactAtoms(oldText);
			for (const atom of extractExactAtoms(newText)) {
				assert.ok(oldAtoms.has(atom) || ev.includes(atom), `r${round}: ${p.op.name} ${p.id ?? b.mk.targetId} atom "${atom}" not in cited evidence`);
			}
		}

		// the same round's rejections for a group are explainable: every
		// GROUP_REJECTED op's group had at least one ROOT-CAUSE rejection.
		for (const g of failedGroups) {
			assert.ok(plan.rejected.some((r) => r.group === g && r.reason !== "GROUP_REJECTED"), `r${round}: group ${g} failed with no root cause`);
		}

		files = nextFiles;
		stats.ops += n;
	}
	return stats;
}

function entryTextOf(files, id) {
	for (const [name, content] of Object.entries(files)) {
		const e = parseLedgerFile(content).entries.find((x) => x.id === id);
		if (e) return [e.title, ...(e.facts ?? []), e.source].filter(Boolean).join("\n");
	}
	return "";
}

test("fuzz: 150 random rounds / ~600 ops hold every invariant (seed 1)", () => {
	const stats = runFuzz(1, 150);
	assert.ok(stats.ops >= 400, `generated ${stats.ops} ops`);
	assert.ok(stats.applied > 0 && stats.rejected > 0, `mix: ${stats.applied} applied / ${stats.rejected} rejected`);
	assert.ok(stats.groupRejects > 0, "group atomicity actually exercised");
});

test("fuzz: a second seed exercises a different branch mix (seed 777)", () => {
	const stats = runFuzz(777, 150);
	assert.ok(stats.ops >= 400);
	assert.ok(stats.groupRejects > 0, "group atomicity exercised under seed 777");
});

test("fuzz: determinism — same seed → byte-identical ledger evolution", () => {
	const evolve = (seed) => {
		const rng = mulberry32(seed);
		let files = randomInitialLedger(rng);
		for (let round = 0; round < 40; round += 1) {
			const { rows } = makeRows(rng, round);
			const handles = handlesOf(rows);
			const batch = Array.from({ length: ri(rng, 0, 6) }, () => randomOp(rng, files, rows, handles, round, round));
			const plan = planOperations({ operations: batch.map((b) => b.op), history: "" }, { files, handles, rows });
			files = applyOperations(files, plan.applied).nextFiles;
		}
		return Object.entries(files).map(([k, v]) => `${k}:${v.length}:${normText(v).slice(0, 40)}`).join("|");
	};
	assert.equal(evolve(42), evolve(42), "identical seed → identical evolution");
});
