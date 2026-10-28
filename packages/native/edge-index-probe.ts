/**
 * Does an EDGE property index reach the GQL surface? (item 1031)
 *
 * Everything in items 1023-1030 was about VERTEX key seeding. Grepping the pattern elsewhere:
 * `graph.edgePropertyIndex` exists and `@lenke/gremlin`'s `executor/index-seed.ts` seeds from it —
 * but nothing in `@lenke/gql` references it. So in the TS engine the same question may seed
 * through one surface and scan through the other.
 *
 * The two spellings below are one question. The Gremlin arm is the control that says the index is
 * reachable at all; the GQL arms are the subject. `type` names the edge label so neither spelling
 * is doing extra work the other skips.
 *
 *   cd packages/native && bun edge-index-probe.ts
 *   EDGE_N=200000 EDGE_REPS=9 bun edge-index-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { E, count, has, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.EDGE_N ?? 100_000);
const REPS = Number(process.env.EDGE_REPS ?? 9);

const g = new TsGraph();
const verts: ReturnType<TsGraph['addVertex']>[] = [];

for (let i = 0; i < 200; i++) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

for (let i = 0; i < N; i++) {
  g.addEdge({
    from: verts[i % 200],
    to: verts[(i * 7 + 3) % 200],
    labels: ['PAID'],
    // 1,000 distinct amounts, so one value is 0.1% of the edges.
    properties: { amount: i % 1_000 },
  });
}

g.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] });
console.log(
  `indexed edge keys: ${g.edgePropertyIndex.indexedKeys().join(', ') || 'NONE — these groups measure SCANS'}`,
);

const time = (label: string, run: () => unknown): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();

    answer = run();
    series.push(performance.now() - t);
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? series[0] ?? 0;

  console.log(
    `  ${label.padEnd(46)} ${median.toFixed(3).padStart(9)} ms   answer=${String(answer).padStart(7)}`,
  );
};

const gqlCount = (q: string) => tsQuery(g, q)[0]?.c;

console.log(`\n# ${N} edges over 200 vertices, median of the warm reps of ${REPS}\n`);
// The CONTROL: Gremlin seeds `edgePropertyIndex` (executor/index-seed.ts), so this arm says
// whether the index is reachable at all.
time('CONTROL gremlin E().has(amount)', () =>
  toArray(traversal(E(), has('amount', 500), count()), g),
);
// The SUBJECT: the same question in GQL, both spellings.
time('GQL inline  -[e:PAID {amount: 500}]->', () =>
  gqlCount('MATCH ()-[e:PAID {amount: 500}]->() RETURN count(*) AS c'),
);
time('GQL clause  WHERE e.amount = 500', () =>
  gqlCount('MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN count(*) AS c'),
);
// THE SAME TWO SPELLINGS AS A PROJECTION rather than a count (item 1032). Item 447 built a walk
// that CARRIES a rel-reading clause `WHERE` (`relBoundFilteredHopWalk`), and it lives in
// `hop-projection.ts` — so it may serve a projection and not a bare `count(*)`. If the clause arm
// is fast here and slow above, the gap belongs to the COUNT shape, not to clause position.
time(
  'GQL inline  -> projection',
  () =>
    (tsQuery(g, 'MATCH ()-[e:PAID {amount: 500}]->() RETURN e.amount AS a') as unknown[]).length,
);
time(
  'GQL clause  -> projection',
  () =>
    (tsQuery(g, 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN e.amount AS a') as unknown[])
      .length,
);
// A second CONTROL: the same shape on an UNINDEXED edge key, so the figure above can be read as
// "reaches the index" rather than "edge filters are just fast".
time('CONTROL GQL on an unindexed edge key', () =>
  gqlCount('MATCH ()-[e:PAID]->() WHERE e.other = 500 RETURN count(*) AS c'),
);
