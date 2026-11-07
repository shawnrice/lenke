/**
 * What does the TS engine's hop multi-aggregate actually cost AGAINST ITS OWN FLOOR?
 *
 * WHY THIS EXISTS. `bun run bench` carries three rows — `hop min+max over a string / dict /
 * number [wide multi-agg]` — reading 112-127 ms in TS against 2.5-3.4 ms native, a 37-49x that
 * looks like the widest unworked gap in the table. It is NOT READABLE as it stands, for two
 * reasons:
 *
 *   1. **Those rows are NATIVE watchers.** They were added at item 1184 for a specific
 *      answer-equivalent mutant in `try_frontier_multi_agg_wide`'s chain entry. The TS column
 *      came along for free and was never priced.
 *   2. **The bench has no single-aggregate hop row**, so there is no floor. Item 1187 records
 *      what picking the wrong one costs: its `count(*), count(n.k)` "control" was subject to the
 *      very hole it was measuring, and the ratio divided one unserved number by another.
 *
 * So this probe measures the PAIR against the SINGLE on one fixture, per column type. The
 * question is not "is TS slower than native" — it is "does `detectMultiHopAggregate` (item 472)
 * FIRE for this column type, or decline to the general path that materializes a `Binding` per
 * EDGE". Those have different answers and only one is a target:
 *
 *   pair / single ~= 1   -> the route fires; the residual against native is the TS walk floor,
 *                          structural, and the count family's own closure (584) applies.
 *   pair / single >> 1   -> the route declines for that type, which is item 1184's hole with a
 *                          TS twin and a real lever.
 *
 * ⚠️ The floor is `max(x.k)`, NOT `count(*)`. Item 1183: a bare `count(*)` over a hop is answered
 * by `shortcuts.ts`'s DEGREE SUM, which never enumerates an edge — it reads 0.0 ms and makes any
 * ratio against it meaningless. A per-edge floor must read a property.
 *
 * `count(x.name)` is carried as a THIRD arm: it reads a property per edge and folds the cheapest
 * possible thing over it, so it bounds how much of the pair's cost is the walk rather than the fold.
 *
 *     ARM=pair-str|single-str|pair-num|single-num|pair-dict|single-dict|countkey  N=200000
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const DEG = Number(process.env.DEG ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'pair-str';

const Q: Record<string, string> = {
  'pair-str': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.name) AS lo, max(x.name) AS hi',
  'single-str': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN max(x.name) AS hi',
  'pair-num': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.age) AS lo, max(x.age) AS hi',
  'single-num': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN max(x.age) AS hi',
  'pair-dict': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN min(x.city) AS lo, max(x.city) AS hi',
  'single-dict': 'MATCH (a:Person)-[:KNOWS]->(x) RETURN max(x.city) AS hi',
  countkey: 'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(x.name) AS n',
  // THE NULL CONTROL, and it decides what the finding IS. The DEG sweep showed `max(x.name)` over
  // a hop is FLAT IN EDGE COUNT (200k edges 89.98 ms, 2M edges 109.36) and ~linear in VERTICES, so
  // it is far-driven: an idempotent fold visits each distinct far vertex once. But "O(vertices) at
  // ~450-680ns each" is only a HOP finding if the hop is what costs it. This arm folds the same
  // property over the same label with NO hop at all. If it costs the same, the per-vertex constant
  // is the scan and the fold, the hop is free, and there is no hop target here.
  'scan-str': 'MATCH (a:Person) RETURN max(a.name) AS hi',
  // IS ITEM 1246's PER-ENDPOINT FOLD ACTUALLY FIRING ON THIS FIXTURE? That rung admits only a
  // DIRECTED, PLAIN hop with NO EDGE VARIABLE (plus a vacuous-or-absent start label, tested at run
  // time because vacuity is a property of the graph). So naming the edge is a spelling the gate
  // REFUSES, falling to the per-ROW walk. Item 1295 measured that inversion at 8.6x on the bench
  // fixture (80.5 ms accepted against 692.9 refused). If the same inversion appears here, the rung
  // is live on this fixture and the accepted arm's cost is the POST-1246/1247 state - not a new
  // lever. This is the structural check item 1183 asks for, in place of inferring from one number.
  'refused-edgevar': 'MATCH (a:Person)-[e:KNOWS]->(x) RETURN max(x.name) AS hi',
};

const gql = Q[ARM];

if (gql === undefined) {
  console.error(`unknown ARM ${ARM}; one of ${Object.keys(Q).join('|')}`);
  process.exit(2);
}

// The bench's own `hopPairDoc` shape: N Person nodes carrying a unique string, an 8-value
// dictionary and a numeric column, then DEG edges per node with scattered endpoints.
const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: { age: i % 90, name: `person${i}`, city: `city${i % 8}` },
  }),
);

for (let k = 0; k < N * DEG; k++) {
  g.addEdge({
    id: `e${k}`,
    from: vs[(k * 7919) % N],
    to: vs[((k % N) * 104_729 + Math.floor(k / N) * 977) % N],
    labels: ['KNOWS'],
    properties: {},
  });
}

const series: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = query(g, gql, {});
  series.push(performance.now() - t0);

  if (r === 0) {
    answer = JSON.stringify(rows[0]);
  }
}

// Item 1183's giveaway check: a route that never enumerates an edge reads ~0 and any ratio
// against it is meaningless. Say so loudly rather than letting a zero through as a datum.
const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

const warn = median < 1 ? '  <-- ⚠️ SUB-MILLISECOND: a closed form, not a walk; not a floor' : '';
const reps = series.map((x) => x.toFixed(1)).join(' ');

console.log(
  `ARM=${ARM}\tN=${N}\tDEG=${DEG}\tanswer=${answer}
  series ${reps}
  MEDIAN(drop ${DROP}) ${median.toFixed(4)} ms${warn}`,
);
