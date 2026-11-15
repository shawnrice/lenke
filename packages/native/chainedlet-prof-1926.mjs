// Item 1926 — A STANDING `LET` IS OFF EVERY RUNG, and `inlineTrailingLet` folds only the LAST one.
//
// `rewrites.ts` states it outright (item 1662): "a standing `LET` is OFF EVERY RUNG —
// `[match, let, return]` carries none of the twenty-one, where the folded `[match, return]` carries
// `hopAggregate`". And `inlineTrailingLet` folds exactly the binder immediately before the RETURN,
// one level. So a CHAIN of two leaves one standing:
//
//     MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x
//       -> inlineTrailingLet folds `b`, leaving [match, let(a), return]
//       -> one standing LET -> no rung at all
//
// Item 1901's coverage sweep measured `chained LET` at **88.17 ms for 200,000 rows** against the
// node projection's 9.67 — about 9x per row — and left it open.
//
// ⚠️ THE CEILING IS THE HAND-FOLDED SPELLING, not the plain projection: `(n.n + 1) * 2` still
// evaluates two operations per row where `n.n` evaluates none, so comparing the chain to
// `RETURN n.n` would price the arithmetic as if it were overhead.
//
//     SHAPE=chain2|chain3|folded|single|plain bun --cpu-prof chainedlet-prof-1926.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'chain2';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50 },
  });
}

const SHAPES = {
  // THE TARGET: two bindings, so one survives the fold.
  chain2: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x',
  // Three, to see whether the cost tracks the NUMBER of standing LETs or just "any standing LET".
  chain3: 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 LET c = b + 3 RETURN c AS x',
  // ⚠️ THE CEILING: the same arithmetic with no LET at all — what a fixpoint fold would reach.
  folded: 'MATCH (n:T) RETURN (n.n + 1) * 2 AS x',
  // ONE binding, which `inlineTrailingLet` DOES fold — so this should already be at the ceiling.
  single: 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x',
  // The floor: no arithmetic at all, so the gap to `folded` is what the two operations cost.
  plain: 'MATCH (n:T) RETURN n.n AS x',
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
  `${SHAPE.padEnd(7)} N=${N} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  rows ${rows}  first ${first}`,
);
console.log(`  ${text}`);
