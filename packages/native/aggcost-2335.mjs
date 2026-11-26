/**
 * **AGGREGATES AT SCALE, GQL AGAINST GREMLIN (item 2335).**
 *
 * Items 2317-2334 covered point lookups, whole scans, hops and writes. Aggregation is the remaining
 * read shape with no per-row comparison: the serving bench has a `grouped` workload but nothing has put
 * GQL's `GROUP BY` beside Gremlin's `groupCount()` on identical work.
 *
 * **GQL's `GROUP BY` TAKES A BOUND NAME, NOT AN EXPRESSION**, so the grouped arms bind the key with
 * `LET` first — that is this engine's documented shape, and writing `GROUP BY n.k` instead silently
 * produces ONE group, which the row count below would expose.
 *
 * The row count is printed for every arm, because an aggregate that answers a DIFFERENT number of
 * groups is not a comparison — item 2317's `rows=0` trap, and the one-group failure above.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, groupCount, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const BUCKETS = Number(process.env.BUCKETS ?? 97);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'gqlGroup';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { k: i % BUCKETS, w: i % 1000 },
  });
}

/* Hoisted, per item 2325's 3.96x. */
const pGroup = traversal(V(), hasLabel('N'), groupCount({ by: 'k' }));
const pCount = traversal(V(), hasLabel('N'), count());
const pValues = traversal(V(), hasLabel('N'), values('w'));

const ARMS = {
  /* THE GROUPED COUNT, both languages. `LET` binds the key because GROUP BY needs a name. */
  gqlGroup: () => query(graph, 'MATCH (n:N) LET g = n.k RETURN g, count(*) AS c GROUP BY g').length,
  gremGroup: () => toArray(pGroup, graph).length,
  /*
   * **THE FAIR CONTROL FOR `sum`, AND MY FIRST COMPARISON LACKED IT (item 2335).** I measured
   * `sum(n.w)` against `GROUP BY count(*)` and read 2.2x — but `count(*)` reads NO PROPERTY, so most of
   * that gap was the per-row property read, not the aggregate. `count(n.w)` reads the same property and
   * HAS a streaming fold, which is item 530's own control (`count(n.age)` 10.9 against `sum` 13.6, 1.25x).
   */
  gqlCountProp: () => query(graph, 'MATCH (n:N) RETURN count(n.w) AS c').length,
  /* `avg`, the other VALUES_AGGREGATES member item 530 priced beside `sum`. */
  gqlAvg: () => query(graph, 'MATCH (n:N) RETURN avg(n.w) AS a').length,
  /* `max`, which HAS a fold — the folded twin of the same property read. */
  gqlMax: () => query(graph, 'MATCH (n:N) RETURN max(n.w) AS m').length,
  /* A SUM over a property — no grouping, so it isolates the per-row accumulate. */
  gqlSum: () => query(graph, 'MATCH (n:N) RETURN sum(n.w) AS s').length,
  /* The closed-form count, as the floor both languages should reach. */
  gqlCount: () => query(graph, 'MATCH (n:N) RETURN count(*) AS c').length,
  gremCount: () => toArray(pCount, graph).length,
  /* The projection, for what visiting every row costs before any aggregation. */
  gremValues: () => toArray(pValues, graph).length,
};

const arm = ARMS[ARM];

for (let w = 0; w < 20; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 200_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = arm();

console.log(
  `  ARM=${ARM.padEnd(11)} ${(med * 1000).toFixed(1).padStart(9)} us  ${((med * 1_000_000) / NODES).toFixed(2).padStart(7)} ns/vertex  rows=${rows}`,
);
