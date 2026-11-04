/**
 * What do DELETES cost the dense-ordinal variant? Item 1369's gap #2, and the last disqualifier.
 *
 * Item 1357 flagged deletes as "the real cost and a design sub-decision rather than a throughput
 * one" and did not measure them. Item 1369 narrowed the question to one concrete consequence: slots
 * come from a monotonic `Graph.vtxSeq` and are NEVER REUSED, so a query's per-pass arrays must be
 * sized by total-ever-created rather than by live count. `slotChainCount` allocates three such
 * arrays per pass, so a long-lived graph that has churned should degrade even though its LIVE
 * working set has not grown at all.
 *
 * THE ISOLATION, which is the whole point: the queried graph is built FIRST and never touched again;
 * the churn is a separate population added and immediately removed, which moves `vtxSeq` and leaves
 * `vertexCount` alone. So the two arms answer the identical question over the identical live graph
 * and differ only in how large the ordinal space has grown.
 *
 *     LIVE=2000 CHURN=200000 node ordinal-churn-probe.mjs
 *
 * ⚠️ LIVE must stay above 1024, or `slotChainCount` is declined (the seed-width cut is
 * `max(vertexCount >> 4, 1024)`) and the probe measures the generic route in both arms — green,
 * identical, and meaningless. Asserted below rather than assumed, which is item 1371's lesson.
 */
import { Graph } from '@lenke/core';
import { V, count, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const LIVE = Number(process.env.LIVE ?? 2000);
const CHURN = Number(process.env.CHURN ?? 0);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const FANOUT = 2;

if (LIVE <= 1024) {
  throw new Error(
    `LIVE=${LIVE} is at or under the dense-route cut of 1024 — the route is declined`,
  );
}

/**
 * ⚠️ INTERLEAVE IS THE DEFAULT, and the first version of this probe got it wrong in the flattering
 * direction. It added every live vertex FIRST and then churned, so the live slots were 0..LIVE-1 —
 * contiguous at the very start of the ordinal space. The walk then touched LIVE adjacent cache lines
 * however big the arrays were, and churn measured free. A real churning graph has its live vertices
 * SCATTERED across the ordinal space, so the walk touches LIVE cache lines spread over the whole
 * allocation. That is the cost the ordinal's never-reused slots actually impose, and only the
 * interleaved fixture exposes it.
 *
 * `SPREAD=0` restores the old contiguous layout, kept so the difference between the two is visible
 * rather than taken on trust.
 */
const SPREAD = process.env.SPREAD !== '0';
const g = new Graph();
const live = [];
const perLive = SPREAD && LIVE > 0 ? Math.floor(CHURN / LIVE) : 0;
let churned = 0;

for (let i = 0; i < LIVE; i += 1) {
  live.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 7 } }));

  // Churn BETWEEN live insertions, so consecutive live vertices are `perLive` slots apart.
  for (let j = 0; j < perLive; j += 1) {
    const tmp = g.addVertex({ id: `s${churned}`, labels: ['Z'] });

    churned += 1;
    g.removeVertex(tmp);
  }
}

for (let k = 0; k < LIVE * FANOUT; k += 1) {
  g.addEdge({
    id: `e${k}`,
    from: live[(k * 7) % LIVE],
    to: live[(k * 13 + 3) % LIVE],
    labels: ['T'],
    properties: {},
  });
}

// Any churn the interleave did not place (the remainder, or all of it when SPREAD=0) goes here.
// Added and removed at once, so it moves the ordinal space without changing what the query sees;
// no edges, so removal cannot touch a live adjacency.
for (let c = churned; c < CHURN; c += 1) {
  const tmp = g.addVertex({ id: `c${c}`, labels: ['Z'] });

  g.removeVertex(tmp);
}

if (g.vertexCount !== LIVE) {
  throw new Error(`churn leaked: vertexCount ${g.vertexCount} != LIVE ${LIVE}`);
}

const plan = traversal(V(), hasLabel('P'), out('T'), out('T'), out('T'), count());

const series = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const rows = toArray(plan, g);

  series.push(performance.now() - t0);
  [answer] = rows;
}

if (answer === undefined || answer === 0) {
  throw new Error('no count — measuring nothing');
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    live: LIVE,
    churn: CHURN,
    vertexCount: g.vertexCount,
    answer,
    median: Number(at(0.5).toFixed(4)),
    p25: Number(at(0.25).toFixed(4)),
    min: Number(kept[0].toFixed(4)),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
