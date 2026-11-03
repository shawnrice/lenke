/**
 * Does the TS engine have item 1145's `outE(T).inV()` gap, and at which shapes?
 *
 * ⚠️ WHY THIS EXISTS. Item 1145 priced `outE(T).inV()` against `out(T)` — the SAME hop, confirmed
 * identical in a real TinkerPop 3.7.3 console before anything was measured — at **29x to 3120x**,
 * the largest gap of its session. Item 1146 then shipped **2944x** for it. But that fix was in the
 * NATIVE engine: a stray `bind_edge: true` kept the chain three slots wide so `try_scan_count`
 * declined a shape it answered for `out()` in 0.2us. **Nothing in that arc touched the TS engine.**
 *
 * And the TS twin is INVISIBLE to the instruments that exist:
 *
 *   - `bun run spelling:gremlin` HAS the group `hop: out(T) vs outE(T).inV()`, but reports it among
 *     the "groups under 1ms, not compared" — both spellings are answered by a count shortcut at
 *     that size, so the probe cannot see a gap on the COUNT shape however large it is elsewhere.
 *   - `bun run bench:gremlin` has `V().out().values(age)` and `V().out().count()` but **no
 *     `outE().inV()` row at any shape**, so the edge spelling is unmeasured there.
 *
 * Item 1145's own numbers say where to look: its count row was 3120x while its `has` and `values`
 * rows were ~29-30x. A count shortcut hides the count row and says nothing about the others, which
 * is exactly the trap item 1183 records — `count(*)` over a hop is answered without walking an
 * edge, so it is not a floor for anything that walks.
 *
 * SHAPES, matching item 1145's table so the two are comparable:
 *
 *     ARM=count|hasFilter|values   SPELL=plain|edge   N=200000  DEG=5
 *
 * `plain` is `out(T)`; `edge` is `outE(T).inV()`. Equivalence is TinkerPop-confirmed (1145), and
 * each run prints its answer so a divergence cannot be mistaken for a speed difference.
 */
import { Graph } from '@lenke/core';
import {
  count,
  has,
  hasLabel,
  inV,
  out,
  outE,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const DEG = Number(process.env.DEG ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'count';
const SPELL = process.env.SPELL ?? 'plain';

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } }),
);

for (let k = 0; k < N * DEG; k++) {
  g.addEdge({
    id: `e${k}`,
    from: vs[(k * 7919) % N],
    to: vs[(k * 104_729) % N],
    labels: ['T'],
    properties: {},
  });
}

// The hop, in whichever spelling. `outE(T).inV()` lands on the same vertices as `out(T)` — verified
// in a TinkerPop console at item 1145, NOT assumed. (`outV()` would be the SOURCE, a different
// question, and conflating the two is how that item nearly measured nothing.)
const hop = SPELL === 'edge' ? [outE('T'), inV()] : [out('T')];

const TAIL: Record<string, unknown[]> = {
  count: [count()],
  // A per-element predicate after the hop, so the walk is not answerable by a shortcut.
  hasFilter: [has('age', 44), count()],
  // Projection, which must touch every landed vertex.
  values: [values('age'), count()],
};

const tail = TAIL[ARM];

if (tail === undefined) {
  console.error(`unknown ARM ${ARM}; one of ${Object.keys(TAIL).join('|')}`);
  process.exit(2);
}

const plan = traversal(
  V(),
  hasLabel('P'),
  ...(hop as Parameters<typeof traversal>),
  ...(tail as Parameters<typeof traversal>),
);
const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  answer = Number(toArray(plan, g)[0]);
  series.push(performance.now() - t0);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];
const reps = series.map((x) => x.toFixed(1)).join(' ');
// Item 1183's giveaway: a sub-millisecond median means a closed form answered it without walking,
// so it is not a floor and a ratio against it means nothing.
const warn = median < 1 ? '  <-- ⚠️ SUB-MS: a shortcut, not a walk; not comparable as a floor' : '';

console.log(
  `SPELL=${SPELL}\tARM=${ARM}\tN=${N}\tDEG=${DEG}\tanswer=${answer}
  series ${reps}
  MEDIAN(drop ${DROP}) ${median.toFixed(4)} ms${warn}`,
);
