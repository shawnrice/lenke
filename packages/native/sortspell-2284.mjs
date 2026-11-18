/**
 * ⚠️⚠️⚠️ **DOES `ORDER BY <alias>` REACH THE TOP-K HEAP THAT `ORDER BY <var>.<prop>` REACHES? (item 2284)**
 *
 * 🔑 The ladder found `ORDER BY n LIMIT k` FLAT across a 200x range of `k` (3.0-3.7 ms at every cap, with
 * `LIMIT 200` sometimes SLOWER than `LIMIT 40000`), which says the top-K heap built at item 1064 is not
 * engaging. `topKPlan` admits a plan only when each sort key resolves through
 * `directKeys[cols.indexOf(s.col)]` — so the question is whether sorting by the projection's ALIAS resolves
 * the same way as sorting by the property itself.
 *
 * ⚠️ **This is the exact bug class `CLAUDE.md` is built around**: "the planner recognized one spelling of a
 * predicate and scanned for another that meant exactly the same thing — each cost 100-300x and each
 * returned the correct answer, so no correctness test could catch it."
 *
 * ✅ **CAP-SENSITIVITY IS THE SIGNAL, not the absolute.** A spelling on the heap gets cheaper as `cap`
 * shrinks; a spelling off it is flat, because it sorts everything either way. Both must return identical
 * rows — asserted here, so a routing difference cannot hide behind a wrong answer.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 9);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: { name: `n${String(i).padStart(7, '0')}`, seniority: i % 7 },
  });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const run = (text) => {
  const ts = [];
  let rows = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    const t = performance.now();

    rows = query(g, text, {});
    ts.push(performance.now() - t);
  }

  return [med(ts), rows];
};

/*
 * ⚠⚠ **WARM-UP FIRST.** Without this the very first cell measured in the process carries the JIT's tiering
 * cost, and that cell was `alias|cap=100` — which read 4.49 against 2.24 and looked exactly like a routing
 * difference. Every spelling and cap is exercised before anything is timed.
 */
const SPELL_ORDER = process.env.ORDER === 'rev' ? 1 : 0;

const SPELLINGS = [
  ['ORDER BY alias', (cap) => `MATCH (p:Person) RETURN p.name AS n ORDER BY n LIMIT ${cap}`],
  ['ORDER BY p.name', (cap) => `MATCH (p:Person) RETURN p.name AS n ORDER BY p.name LIMIT ${cap}`],
];

const CAPS = [100, 1000, 10_000, 60_000];

console.log(`  N=${N}, median of ${ROUNDS} (ms). Cap-sensitivity is the signal.`);
console.log(`    spelling          ${CAPS.map((c) => `cap=${c}`.padStart(10)).join('')}    flat?`);

const answers = {};

for (const [, mk] of SPELLINGS) {
  for (const cap of CAPS) {
    for (let w = 0; w < 4; w += 1) {
      query(g, mk(cap), {});
    }
  }
}

for (const [label, mk] of SPELL_ORDER === 1 ? [...SPELLINGS].reverse() : SPELLINGS) {
  const row = [];

  for (const cap of CAPS) {
    const [ms, rows] = run(mk(cap));

    row.push(ms);
    answers[`${String(label)}|${cap}`] = rows.map((r) => String(r.n)).join(',');
  }

  const spread = Math.max(...row) / Math.min(...row);

  console.log(
    `    ${String(label).padEnd(17)} ${row.map((x) => x.toFixed(2).padStart(10)).join('')}    ${spread.toFixed(2)}x spread`,
  );
}

/* Both spellings must return the SAME rows at every cap, or a timing difference is not a routing difference. */
for (const cap of CAPS) {
  const a = answers[`ORDER BY alias|${cap}`];
  const b = answers[`ORDER BY p.name|${cap}`];

  if (a !== b) {
    throw new Error(`answers differ at cap=${cap}`);
  }
}

console.log(`  ✓ both spellings return identical rows at every cap`);
