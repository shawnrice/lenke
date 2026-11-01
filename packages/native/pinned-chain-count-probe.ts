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
};

const shape = SHAPES[SHAPE];

if (!shape) {
  console.log(`arms: ${Object.keys(SHAPES).join(' ')}`);
  process.exit(2);
}

const g = new Graph();
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

console.log(`SHAPE=${SHAPE} N=${N} answer=${answer}`);
console.log(`series ${series.map((x) => x.toFixed(2)).join(' ')}`);
console.log(`MEDIAN ${median.toFixed(4)} ms`);
