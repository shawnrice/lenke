// Item 1918 — `V().out(T).values(k).min()` costs MORE than materializing every value it folds.
//
// The Gremlin workload screen at 200,000 vertices / 1,000,000 edges:
//   agg: hop values min   60.88 ms   (1 row)
//   hop1: values          45.06      (600,000 rows)
//
// ⚠️ THAT IS BACKWARDS AND IT IS NOT A ROUTE GAP. `gremlin-route-screen.mjs` reports `hop1: min` as
// a SHORTCUT with 0 `applyStep` calls, so the fold IS fused — it walks the same adjacency and
// builds no array, yet loses to the arm that allocates 600,000 slots. Item 1892 recorded the gap as
// "~17 ms for an order-invariant fold … not a route gap" and left it; the route screen confirms the
// second half, which makes the first half a per-ELEMENT question.
//
// 🔑 THE SUSPECT IS `compareTotal` PER ELEMENT. `foldProjectedMinMax` calls it once per value so
// that a mixed stream has a total order (strings lexicographic, NaN greatest, type rank between
// kinds) — a contract item 1712 established is not optional. `sort-key-specialize.ts` already
// eliminates that chain's dead branches for `order()` over a one-type column.
//
// ⚠️⚠️ AND A NUMERIC ARM FOR `order()` WAS BUILT AND REFUTED — read that module's note before
// believing anything here. Measured six times at 0.93x-1.18x, straddling 1.0, and dropped: the
// reduction IS worth ~25% on numbers but the O(n) CLASSIFICATION SCAN eats it. Its note names the
// open question as "a cheaper classification, not a numeric arm".
//
// 🔑 WHICH IS WHY A FOLD IS A DIFFERENT QUESTION FROM A SORT: a fold can classify AS IT FOLDS, for
// free, because it already visits every element once in order. A sort must classify BEFORE it can
// sort, which is the O(n) scan that killed the other arm. This probe measures whether that
// difference is worth anything.
//
//     SHAPE=min|max|values|sum|mean|bare|strmin bun --cpu-prof minmax-prof-1918.mjs
import { Graph } from '@lenke/core';
import { V, max, mean, min, out, sum, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'min';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['P'],
    // `k` is numeric and `s` a string, so the fold can be measured over each type.
    properties: { k: i % 50, n: i % 8, s: `s${i % 7}` },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const SHAPES = {
  // THE TARGET and its twin.
  min: traversal(V(), out('E'), values('k'), min()),
  max: traversal(V(), out('E'), values('k'), max()),
  // ⚠️ THE FLOOR THAT MAKES THE GAP A FINDING: the same walk MATERIALIZING every value it folds.
  // A fold that builds no array should beat this, and does not.
  values: traversal(V(), out('E'), values('k')),
  // The numeric terminals that are NOT `compareTotal`-based — they add, they do not compare. If
  // these sit at the `values` floor and `min`/`max` do not, the comparator is the difference.
  sum: traversal(V(), out('E'), values('k'), sum()),
  mean: traversal(V(), out('E'), values('k'), mean()),
  // A STRING key, which no numeric arm can reach — the control for a numeric specialization.
  strmin: traversal(V(), out('E'), values('s'), min()),
  // CONTROL: the walk with no projection and no terminal at all.
  bare: traversal(V(), out('E')),
};

const plan = SHAPES[SHAPE];
const ser = [];
let rows = 0;
let answer = '';

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out_ = toArray(plan, g);
  const ms = performance.now() - t0;

  rows = out_.length;
  answer = rows <= 2 ? JSON.stringify(out_) : `${rows} rows`;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(7)} N=${N} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  answer ${answer}`,
);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
