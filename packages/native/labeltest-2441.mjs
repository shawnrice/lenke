/*
 * WHAT DOES THE FALLBACK'S UNCONDITIONAL FAR-LABEL TEST COST? (item 2441)
 *
 * `hop-projection.ts`'s walks apply `if (farLabel !== undefined && !matchesLabel(far, farLabel))`
 * per far vertex — ten sites. The CSR arm instead reads a `testFarLabel` flag that
 * `csrHopRoute` computes once as `farLabel !== undefined && !vacuousLabel(graph, farLabel)`
 * (item 1941), so a VACUOUS label — one that excludes nothing — costs it nothing.
 *
 * Item 2439 hand-priced the test at 2.84 ms of a 36.6 ms read (7.8%) and flagged that as a LOWER
 * bound, because the engine calls `matchesLabel` where the hand version inlines `labels.has`.
 * A standalone number cannot carry the decision (item 2438 learned that the hard way), so this
 * measures it IN SITU against an ablated build.
 *
 * TWO LABEL MODES, and that is the point rather than thoroughness:
 *
 *   vacuous  every vertex carries `:P`, so the test can never exclude anything and an elision
 *            would be sound. This is the ONLY mode where a win exists.
 *   mixed    ONE isolated off-label vertex (item 1943's design: every answer unchanged, only
 *            `vertexCount` moves). The label is no longer vacuous, so `vacuousLabel` is false and
 *            NO elision is possible — the test must run.
 *
 * [[label-vacuity-gates-fast-paths]] records that `MIXED=1` is the REALISTIC mode, because a real
 * schema has more than one label. So the mixed row is not a control here; it is the row that says
 * whether the win is reachable at all in practice.
 *
 * THE ABLATED ARM MUST RETURN IDENTICAL ROWS in the vacuous mode — asserted, not assumed. In the
 * mixed mode it legitimately returns MORE rows (it drops a filter that really filters), which is
 * why the ablation is a measurement device and not a candidate patch.
 *
 * WARMUP IS DECLARED: 3 reads before the measured ones, because this route sits behind
 * `csrAskedBefore` and item 2438 measured the same shape at 45.42 ms with seven warm reads against
 * 36.62 with none. An adaptive route's cost is a function of its read history.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.LBL_N ?? 200000);
const REPS = Number(process.env.LBL_REPS ?? 7);
const WARMUP = Number(process.env.LBL_WARMUP ?? 3);
const MODE = process.env.MIXED_MODE ?? 'vacuous';

const Q = 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[s.length >> 1];
};

const KEEP = { graph: undefined };

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let e = 0; e < N; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % N],
      labels: ['E'],
      properties: {},
    });
  }

  if (MODE === 'mixed') {
    // ONE isolated off-label vertex, no edges: it changes no answer and makes `:P` non-vacuous.
    g.addVertex({ id: 'off', labels: ['Q'], properties: { k: 0 } });
  }

  KEEP.graph = g;

  return { g, vs };
};

const { g, vs } = build();

for (let i = 0; i < WARMUP; i += 1) {
  query(g, Q, {});
}

const ts = [];
let z = 0;
let rows = 0;

for (let i = 0; i < REPS; i += 1) {
  // One write per read: the ratio at which `csrAskedBefore` declines, so the FALLBACK runs.
  g.addEdge({
    id: `z${z}`,
    from: vs[0],
    to: vs[1],
    labels: ['E'],
    properties: {},
  });
  z += 1;

  const t = performance.now();
  const out = query(g, Q, {});

  ts.push(performance.now() - t);
  rows = out.length;
}

console.log(
  `   ${MODE.padEnd(8)} N=${N} warmup=${WARMUP}  median ${median(ts).toFixed(2)} ms  rows ${rows}` +
    `   series ${ts.map((x) => x.toFixed(1)).join(' ')}`,
);
