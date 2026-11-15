// Item 1929 — WHAT IS THE EXPRESSION-SORT-KEY RESIDUAL ACTUALLY MADE OF?
//
// The GQL screen's largest remaining FAMILY is one equivalent-spelling shape, four rows of it: an
// EXPRESSION sort/page key against the ALIAS spelling of the same key.
//
//     HOP expr key, OFFSET no LIMIT  457.59  vs  alias key 281.20  = 1.63x   (~176 ms)
//     HOP order by EXPRESSION        456.92  vs  alias     271.72  = 1.68x   (~185 ms)
//     order by expr, two terms        64.18  vs  bound name 19.50  = 3.29x
//     order by EXPRESSION             53.92  vs  bound name 19.50  = 2.77x
//     NODE expr key, OFFSET no LIMIT  55.20  vs  alias key  21.12  = 2.61x
//
// ⚠️ IT IS ALREADY PRICED, AND THE PRICE IS AN ATTRIBUTION, NOT A MEASUREMENT. Item 1902 recorded
// the cause as "per-row compiled-key evaluation plus a `KeyRow` allocation against the plain arm's
// direct column read" and left it. [[frame-attribution-trap]]: a frame is attribution until a
// DELETION TEST WITH A CONTROL says otherwise — this repo has been wrong about exactly this four
// times, and at item 1667 the control moved 7.5x.
//
// 🔑 SO THIS SPLITS THE RESIDUAL INTO ITS TWO CLAIMED HALVES, by arms that differ in ONE of them:
//
//     alias       ORDER BY x          the rung. No key eval, no KeyRow.
//     exprId      ORDER BY n.n        an EXPRESSION that is the identity of the projected column —
//                                     so a compiled key IS evaluated, but it is the cheapest
//                                     possible one. Isolates the KeyRow/route cost from the
//                                     ARITHMETIC cost.
//     expr1       ORDER BY n.n + 1    + one operation.
//     expr2       ORDER BY n.n + 1, n.k   + a second term.
//     exprOther   ORDER BY n.k        an expression over a column the projection does NOT read,
//                                     which no monotone rewrite could ever elide.
//
// If `exprId` is already near `expr1`, the cost is the ROUTE (KeyRow + the deferred arm), and the
// arithmetic is noise — which would mean a monotone-key rewrite is aiming at the wrong half.
// If `exprId` sits near `alias`, the cost really is per-row evaluation.
//
//     SHAPE=alias|exprId|expr1|expr2|exprOther bun exprsort-prof-1929.mjs
//     SHAPE=expr1 bun --cpu-prof exprsort-prof-1929.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'expr1';

// ⚠️ DISTINCT KEYS, because item 1903 established that a tie-heavy fixture lets a WRONG ORDER share
// its first rows with the right one — and the screen's own fixture gives eight distinct `n` over
// 200,000 vertices, where a broken sort measured 7.6x faster and looked like a win.
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: (i * 2_654_435_761) % N, k: `s${String((i * 7919) % N)}` },
  });
}

for (let e = 0; e < N; e += 1) {
  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(e + 1)),
    to: g.getVertexById(String(((e * 7 + 3) % N) + 1)),
    labels: ['E'],
    properties: { w: e % 7 },
  });
}

const SHAPES = {
  alias: 'MATCH (n:T) RETURN n.n AS x ORDER BY x',
  exprId: 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n',
  expr1: 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1',
  expr2: 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1, n.k',
  exprOther: 'MATCH (n:T) RETURN n.n AS x ORDER BY n.k',
  // The floor: the same projection with no ordering at all.
  none: 'MATCH (n:T) RETURN n.n AS x',
  /*
   * 🔑 THE CEILING FOR THE SAFE REWRITE. The row ALREADY holds `x = n.n`, so a sort key spelled
   * `n.n + 1` could read the projected COLUMN instead of re-reading the vertex — same property,
   * same value, same faults, so answer-identical by construction and needing no monotonicity
   * assumption (which `n.n + 1` could not support anyway: on a string column `+` may fault, and
   * eliding the computation would elide the fault).
   *
   * This is exactly what such a rewrite would PRODUCE, and it is writable today — so it prices the
   * lever before any code is written.
   */
  aliasExpr: 'MATCH (n:T) RETURN n.n AS x ORDER BY x + 1',
  aliasExpr2: 'MATCH (n:T) RETURN n.n AS x ORDER BY x + 1, x',
  /*
   * ⚠️ THE HOP TWIN, where the absolute numbers are largest. `hopAliasEx` reaches NO RUNG either
   * (`sortroute-1929.ts`), so this is the same gap on the most common shape in the language.
   */
  hopAlias: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x',
  hopExpr: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n + 1',
  hopAliasEx: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x + 1',
};

const text = SHAPES[SHAPE];
const ser = [];
let rows = 0;
let first = '';

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out = query(g, text, {});
  const ms = performance.now() - t0;

  rows = out.length;
  first = JSON.stringify(out[0]);

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(9)} N=${N} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  rows ${rows}  first ${first}`,
);
console.log(`  ${text}`);
