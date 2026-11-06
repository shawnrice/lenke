/**
 * The REVERSE-ORDER conjunct lift (item 1544), using the fixture `executor.ts`'s own note names.
 *
 * `directEqProps` lifts a PREFIX of the `AND` chain: the scan stops at the first conjunct it cannot
 * read, and everything from there on is the residual. So a liftable conjunct placed AFTER an
 * unliftable one does not lift, and its siblings' lifts are forfeited with it. That file prices the
 * forfeit and then declines the fix:
 *
 * ```text
 *   a=50 alone, lifts                 4.160 ms   20.8 ns a vertex
 *   a=50 AND b=0, both lift           4.083      20.4
 *   a=50 AND <unliftable>             8.072      40.4            1.94x
 *   a=50 AND b=0 AND <unliftable>    10.686      53.4            2.62x
 *   [CTL] <unliftable> alone         12.496      62.5            nothing lifts either way
 *
 *   ⚠️ THE REVERSE ORDER IS DELIBERATELY NOT DONE. `<unliftable> AND a=50` measured 13.750 and a
 *   lift would take it to ~4.3 (3.2x), but only by running `a = 50` FIRST — which is observable
 *   when the unliftable conjunct can RAISE.
 * ```
 *
 * That observability is now sanctioned (the owner's decision at item 1543: evaluation order is
 * chosen for SPEED per engine). This probe re-measures the table before anything is built, because
 * CLAUDE.md says to verify a heading's number against the source rather than trust it — items 1283
 * and 1287 each moved the arm an earlier figure was taken against.
 *
 *   node conjunct-lift-order-probe.mjs
 *   ONLY=reverse NODES=200000 REPS=12 node conjunct-lift-order-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 12);
const DROP = Number(process.env.DROP ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    // `a` is 1-in-100 selective at 50, `b` is 1-in-2. Both numeric, so every conjunct below is a
    // clean comparison and no arm can win by raising early.
    properties: { a: i % 100, b: i % 2, n: i },
  });
}

/**
 * `n.a >= n.a` is the unliftable conjunct the note uses: TRUE for every row (so every arm answers
 * identically) and it cannot raise, which keeps this measurement about ROUTING rather than about
 * error behaviour.
 */
const UNLIFTABLE = 'n.a >= n.a';

const ARMS = {
  alone: `MATCH (n:P) WHERE n.a = 50 RETURN count(*) AS c`,
  both: `MATCH (n:P) WHERE n.a = 50 AND n.b = 0 RETURN count(*) AS c`,
  'lift-then-unliftable': `MATCH (n:P) WHERE n.a = 50 AND ${UNLIFTABLE} RETURN count(*) AS c`,
  'two-then-unliftable': `MATCH (n:P) WHERE n.a = 50 AND n.b = 0 AND ${UNLIFTABLE} RETURN count(*) AS c`,
  // THE TARGET: the unliftable conjunct FIRST, so the prefix rule forfeits the lift entirely.
  reverse: `MATCH (n:P) WHERE ${UNLIFTABLE} AND n.a = 50 RETURN count(*) AS c`,
  'reverse-two': `MATCH (n:P) WHERE ${UNLIFTABLE} AND n.a = 50 AND n.b = 0 RETURN count(*) AS c`,
  // CONTROL: nothing lifts either way, so the change cannot reach it.
  'unliftable-alone': `MATCH (n:P) WHERE ${UNLIFTABLE} RETURN count(*) AS c`,
  // CONTROL: no AND at all.
  'no-and': `MATCH (n:P) WHERE n.a = 50 RETURN count(*) AS c`,

  // ⚠️ THE SECOND GUARD (item 1545). `residualOf` declines the WHOLE lift when a RAISE-CAPABLE
  // family — `cmp`, `truth`, `notTruth`, `path` — would lift ahead of a residual, because an
  // ordering comparison throws on a cross-type pair where the generic chain would have settled the
  // row FALSE first. `eq`/`nulls`/`member` are exempt (equality is total).
  //
  // Selectivity is matched to the `eq` arms on purpose: `n.a < 1` keeps 1 row in 100, exactly as
  // `n.a = 50` does, so the pair differs only in which FAMILY the conjunct lands in.
  'cmp-alone': `MATCH (n:P) WHERE n.a < 1 RETURN count(*) AS c`,
  'cmp-then-unliftable': `MATCH (n:P) WHERE n.a < 1 AND ${UNLIFTABLE} RETURN count(*) AS c`,
  'cmp-reverse': `MATCH (n:P) WHERE ${UNLIFTABLE} AND n.a < 1 RETURN count(*) AS c`,
  // A null test is EXEMPT, so this one should already lift beside a residual — the control that
  // says the guard is about the family and not about residuals in general.
  'null-then-unliftable': `MATCH (n:P) WHERE n.a IS NOT NULL AND ${UNLIFTABLE} RETURN count(*) AS c`,
};

const only = process.env.ONLY;
const rows = [];

for (const [name, text] of Object.entries(ARMS)) {
  if (only !== undefined && !name.includes(only)) {
    continue;
  }

  // Warm the parse cache (admitted on the second sighting) and record the answer, so an arm that
  // silently returns something else cannot read as fast.
  let answer;

  for (let w = 0; w < 3; w += 1) {
    answer = JSON.stringify(query(g, text));
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, text);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  rows.push({ name, ms: kept[Math.floor(kept.length * 0.25)], answer });
}

console.log(`conjunct lift order — NODES=${NODES} REPS=${REPS} DROP=${DROP} (p25 ms)\n`);

for (const r of rows) {
  console.log(
    `${r.name.padEnd(22)} ${r.ms.toFixed(3).padStart(9)} ms   ${((r.ms * 1e6) / NODES).toFixed(1).padStart(6)} ns/vertex   ${r.answer}`,
  );
}

console.log(JSON.stringify({ rows }));
