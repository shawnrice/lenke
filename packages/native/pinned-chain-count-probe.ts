/**
 * Item 1329's A/B instrument: does a 3+-segment `count(*)` with an id-pinned START avoid the
 * whole-graph sweep? Pair it with `enumeration-surface-probe.ts`, which answers WHICH surface a
 * route enumerates when the timing says they differ.
 *
 * ONE SHAPE PER PROCESS. Times a single query shape so the A/B for the guard cannot be
 * confounded by dispatch-site polymorphism from other shapes in the same process (the trap item
 * 1320 and the repo's "one shape per PROCESS" rule record).
 *
 * SHAPE=pinned3|pinned4|pinned5|pinnedIn3|endgate3|bare3   N=200000   REPS=14
 *
 * 14 reps, first 3 dropped as warm-up (visibly the JIT tiering up), MEDIAN of the rest — the
 * estimator the repo prescribes for the TS per-row path, because `min` reports a rare fast rep and
 * estimates the two arms differently.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const SHAPE = process.env.SHAPE ?? 'pinned3';

const chain = (hops: number): string =>
  Array.from({ length: hops }, (_, i) => `-[:E]->(n${i})`).join('');

const SHAPES: Record<string, { q: string; p: Record<string, unknown> }> = {
  pinned3: {
    q: `MATCH (a:P)${chain(3)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
  pinned4: {
    q: `MATCH (a:P)${chain(4)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
  pinned5: {
    q: `MATCH (a:P)${chain(5)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
  pinnedIn3: {
    q: `MATCH (a:P)${chain(3)} WHERE element_id(a) IN $ids RETURN count(*) AS c`,
    p: { ids: ['v7', 'v11'] },
  },
  endgate3: { q: `MATCH (a:P)${chain(3)} WHERE n2.k = 7 RETURN count(*) AS c`, p: {} },
  bare3: { q: `MATCH (a:P)${chain(3)} RETURN count(*) AS c`, p: {} },
  // Item 1330's question: the START is pinned by a PROPERTY equality, which item 1329's guard
  // deliberately does not admit ("a property predicate carries no hint that says few"). With
  // IDX=1 an index on `k` exists, so the hint CAN be priced - does the chain-count rung use it?
  prop3: { q: `MATCH (a:P)${chain(3)} WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  prop5: { q: `MATCH (a:P)${chain(5)} WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  propParam3: {
    q: `MATCH (a:P)${chain(3)} WHERE a.k = $k RETURN count(*) AS c`,
    p: { k: 7 },
  },
  // The DEPTH LADDER. Item 1329 found its two routes by asking which rung fires at each depth
  // rather than assuming one guard covered the family; the same ladder locates where an indexed
  // property start stops being seeded.
  prop0: { q: `MATCH (a:P) WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  prop1: { q: `MATCH (a:P)${chain(1)} WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  prop2: { q: `MATCH (a:P)${chain(2)} WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  prop4: { q: `MATCH (a:P)${chain(4)} WHERE a.k = 7 RETURN count(*) AS c`, p: {} },
  // The id twin at each depth, so the ladder has a per-depth control rather than one baseline.
  pinned1: {
    q: `MATCH (a:P)${chain(1)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
  pinned2: {
    q: `MATCH (a:P)${chain(2)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
};

const shape = SHAPES[SHAPE];

if (!shape) {
  console.log(`arms: ${Object.keys(SHAPES).join(' ')}`);
  process.exit(2);
}

const g = new Graph();

// Built BEFORE the rows, so the index is populated by the writes rather than backfilled - the
// seeding question is about a warm index, and a backfilled one has a different cost profile.
if (process.env.IDX === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
);

for (let i = 0; i < N; i++) {
  g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i * 7 + 1) % N], labels: ['E'], properties: {} });
}

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = query(g, shape.q, shape.p);

  series.push(performance.now() - t0);
  answer = Number(rows[0]?.c);
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(`SHAPE=${SHAPE} N=${N} IDX=${process.env.IDX ?? '0'} answer=${answer}`);
console.log(`series ${series.map((x) => x.toFixed(2)).join(' ')}`);
console.log(`MEDIAN ${median.toFixed(4)} ms`);
