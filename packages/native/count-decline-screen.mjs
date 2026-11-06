/**
 * A DECLINE SCREEN over the Gremlin count shortcuts (item 1547).
 *
 * `count-shortcut.ts` is 2,771 lines with ~50 guard-level declines. Reading all fifty is the wrong
 * instrument: what matters is which SHAPES fall off, and the cheapest way to find that is to time
 * a batch and look for order-of-magnitude outliers against structural twins. A closed-form count
 * is sub-millisecond; anything that materialises traversers is tens to hundreds.
 *
 * ⚠️ MANY ARMS IN ONE PROCESS ON PURPOSE, which item 762 warns against — but that warning is about
 * attributing a ~10% change, and this screen is looking for 10x. A shape that declines is not
 * 10% slower, it is a different algorithm. Anything this flags gets re-measured one-shape-per-
 * process in `isolated-gremlin-bench.mjs` before a single line is written.
 *
 * ✅ IT EARNED ITS PLACE ON THE FIRST RUN. `V().hasLabel(P, Q).out(E).count()` read 9.268 ms against
 * `V().hasLabel(P).out(E).count()`'s 0.005 for the SAME answer — `dropVacuousLabels` required
 * `labels.length === 1`, so a vacuous disjunction stayed in the plan and the plan left the
 * closed-form route. Fixed at item 1547, 908x one-arm-per-process.
 *
 * Two things it also corrected, both worth not re-deriving:
 *
 *   * `isolated-gremlin-bench.mjs`'s `hopcount2` comment claims "answered by the degree inner
 *     product with no edge walk". It measures **68 ms**. Two-hop counts are a slot sweep in BOTH
 *     directions (`out.out` 52.8, `both.both` 61.1) — the inner product in `bothChainCount` is
 *     gated on `unfiltered && hops.length === 2`, and this is what that path actually costs.
 *   * multi-type edges in the graph do NOT disable the single-type closed form. `out(E).count()`
 *     is 0.005 ms either way; only the MULTI-label hops change (`out(E,F)` 0.315 with them, 0.001
 *     without), which is `bucketsFor`'s documented soundness condition working correctly.
 */
import { Graph } from '@lenke/core';
import {
  V,
  both,
  count,
  dedupe,
  gt,
  has,
  hasLabel,
  limit,
  out,
  outE,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i % 97, n: i },
    }),
  );
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: vs[i],
    to: vs[(i * 104_729 + 1) % NODES],
    labels: i % Number(process.env.MULTI ?? 7) === 0 ? ['E', 'F'] : ['E'],
    properties: { w: i % 13 },
  });
}

const ARMS = {
  // KNOWN ADMITTED, as the yardstick: a closed-form degree sum.
  'out(E).count': () => traversal(V(), out('E'), count()),
  'hasLabel.out(E).count': () => traversal(V(), hasLabel('P'), out('E'), count()),
  'out(E).out(E).count': () => traversal(V(), out('E'), out('E'), count()),
  'outE(E).count': () => traversal(V(), outE('E'), count()),
  'hasLabel(P).count': () => traversal(V(), hasLabel('P'), count()),
  'has(k,gt).count': () => traversal(V(), has('k', gt(44)), count()),
  // CANDIDATE DECLINES, each with a reason to suspect it.
  'both(E).count': () => traversal(V(), both('E'), count()),
  'both(E,F).count': () => traversal(V(), both('E', 'F'), count()),
  'out(E,F).count': () => traversal(V(), out('E', 'F'), count()),
  'hasLabel(P,Q).out(E).count': () => traversal(V(), hasLabel('P', 'Q'), out('E'), count()),
  // A FAR-SIDE filter after the hop — the shape item 1302 worked on the count side.
  'out(E).hasLabel(Q).count': () => traversal(V(), out('E'), hasLabel('Q'), count()),
  'out(E).has(k,gt).count': () => traversal(V(), out('E'), has('k', gt(44)), count()),
  // Steps that cannot be a degree sum at all.
  'out(E).dedupe().count': () => traversal(V(), out('E'), dedupe(), count()),
  'out(E).limit(1e9).count': () => traversal(V(), out('E'), limit(1_000_000_000), count()),
  'out(E).values(k).count': () => traversal(V(), out('E'), values('k'), count()),
  // ⚠️ DIRECTED vs UNDIRECTED two-hop. `bothChainCount` has a documented degree INNER PRODUCT for
  // `unfiltered && hops.length === 2` (item 590's reason, item 1374's prize: both.both 6241 -> 82
  // ms). Does the directed chain get one?
  'both(E).both(E).count': () => traversal(V(), both('E'), both('E'), count()),
  'both(E).both(E).both(E).count': () => traversal(V(), both('E'), both('E'), both('E'), count()),
  'in(E).in(E).count': () => traversal(V(), out('E'), out('E'), count()),
  'out.out.out.count': () => traversal(V(), out('E'), out('E'), out('E'), count()),
  // ⚠️ IS IT THE MULTI-LABEL HOP, OR AN UNDROPPED VACUOUS LABEL? `P` is on every vertex, so BOTH
  // `hasLabel(P)` and `hasLabel(P,Q)` are vacuous (ANY match). If `dropVacuousLabels` handles the
  // single-label case and not the multi, the gap is the DROP and not the hop. `Q` is on half and
  // `R` on none, so `hasLabel(Q)` and `hasLabel(Q,R)` are the non-vacuous pair.
  'lbl Q .out(E).count': () => traversal(V(), hasLabel('Q'), out('E'), count()),
  'lbl Q,R .out(E).count': () => traversal(V(), hasLabel('Q', 'R'), out('E'), count()),
  'lbl P .count': () => traversal(V(), hasLabel('P'), count()),
  'lbl P,Q .count': () => traversal(V(), hasLabel('P', 'Q'), count()),
  'lbl Q .count': () => traversal(V(), hasLabel('Q'), count()),
  'lbl Q,R .count': () => traversal(V(), hasLabel('Q', 'R'), count()),

  // ⚠️ THE EMPTY-LABEL FAMILY ON THE GREMLIN SIDE (item 1553). Item 1552 took this on the GQL side
  // for ~146,000x: a label carried by NO vertex makes the whole chain empty, decidable in O(1) from
  // the same bucket read `dropVacuousLabels` already does. `R` is on nobody here.
  'empty: hasLabel(R).count': () => traversal(V(), hasLabel('R'), count()),
  'empty: R.out(E).count': () => traversal(V(), hasLabel('R'), out('E'), count()),
  'empty: R.out.out.count': () => traversal(V(), hasLabel('R'), out('E'), out('E'), count()),
  'empty: R.out.out.out.count': () =>
    traversal(V(), hasLabel('R'), out('E'), out('E'), out('E'), count()),
  'empty: out(E).hasLabel(R).count': () => traversal(V(), out('E'), hasLabel('R'), count()),
  'empty: out(E).values(k) R': () => traversal(V(), hasLabel('R'), out('E'), values('k')),
  // CONTROLS: the same chains with a label that DOES match, for scale.
  'ctl: Q.out.out.count': () => traversal(V(), hasLabel('Q'), out('E'), out('E'), count()),
  'ctl: out.out.count': () => traversal(V(), out('E'), out('E'), count()),

  // ⚠️ THE LIMIT FAMILY (item 1549). `out(T).limit(n).count()` is `min(n, degree_sum)` — a closed
  // form — yet it measured 68.681 ms against `out(T).count()`'s 0.005 for the SAME answer. Does the
  // cost track `n` (an early-exit walk) or the row count (full materialisation)?
  'lim 10': () => traversal(V(), out('E'), limit(10), count()),
  'lim 1000': () => traversal(V(), out('E'), limit(1000), count()),
  'lim 100000': () => traversal(V(), out('E'), limit(100_000), count()),
  'lim 199999': () => traversal(V(), out('E'), limit(199_999), count()),
  'lim 200000': () => traversal(V(), out('E'), limit(200_000), count()),
  'lim 1e9': () => traversal(V(), out('E'), limit(1_000_000_000), count()),
};

const only = process.env.ONLY;
const rows = [];

for (const [name, make] of Object.entries(ARMS)) {
  if (only !== undefined && !name.includes(only)) {
    continue;
  }

  const plan = make();
  let answer;

  for (let w = 0; w < 2; w += 1) {
    answer = JSON.stringify(toArray(plan, g));
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    toArray(plan, g);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  rows.push({ name, ms: kept[Math.floor(kept.length * 0.25)], answer });
}

console.log(`count decline screen — NODES=${NODES} REPS=${REPS}\n`);

for (const r of rows) {
  console.log(`${r.name.padEnd(30)} ${r.ms.toFixed(3).padStart(10)} ms   ${r.answer}`);
}
