/**
 * Does the Gremlin edge-index seed reach a traversal that does not OPEN with `E()`? (item 1043)
 *
 * `seedFromIndex` destructures `const [source, ...rest] = plan.steps` and fires only when
 * `source.kind` is `'V'` or `'E'`. So `E().has('amount', 500)` seeds, and
 * `V().outE().has('amount', 500)` — the same question reached through a hop — cannot, because by
 * the time the `has` is seen the source step is `V`, whose seed looks at the VERTEX index.
 *
 * That is the defect class this repo is named for: one spelling of a question reaching an index
 * while another scans. Items 1035/1038 closed it between GQL's count and projection paths; this
 * asks it one surface over, inside Gremlin.
 *
 * Arms, all answering the same 100 edges of 100,000:
 *
 *   E().has(amount)                  — the CEILING, seeds today
 *   E().hasLabel(PAID).has(amount)   — also seeds, with a removable label filter
 *   V().outE().has(amount)           — the SUBJECT: same question through a hop
 *   V().outE().has(other)            — CONTROL: an UNINDEXED key, so nothing could seed it
 *
 *   cd packages/native && bun gremlin-hop-seed-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { E, V, count, has, hasLabel, outE, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.EDGE_N ?? 100_000);
const REPS = Number(process.env.EDGE_REPS ?? 14);
const VERTS = 200;

const g = new TsGraph();
const verts: ReturnType<TsGraph['addVertex']>[] = [];

for (let i = 0; i < VERTS; i++) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

for (let i = 0; i < N; i++) {
  g.addEdge({
    id: `e${i}`,
    from: verts[i % VERTS],
    to: verts[(i * 7 + 3) % VERTS],
    labels: ['PAID'],
    // 1,000 distinct amounts, so one value is 0.1% of the edges.
    properties: { amount: i % 1_000 },
  });
}

g.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] });
console.log(`indexed edge keys: ${g.edgePropertyIndex.indexedKeys().join(', ') || 'NONE'}`);

const time = (label: string, run: () => unknown): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();

    answer = run();
    series.push(performance.now() - t);
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? 0;

  console.log(
    `  ${label.padEnd(40)} ${median.toFixed(3).padStart(9)} ms   answer=${String(answer)}`,
  );
};

console.log(`\n# ${N} edges over ${VERTS} vertices, median of the warm reps of ${REPS}\n`);
time('CEILING  E().has(amount)', () => toArray(traversal(E(), has('amount', 500), count()), g)[0]);
time(
  'CEILING  E().hasLabel().has(amount)',
  () => toArray(traversal(E(), hasLabel('PAID'), has('amount', 500), count()), g)[0],
);
time(
  'SUBJECT  V().outE().has(amount)',
  () => toArray(traversal(V(), outE('PAID'), has('amount', 500), count()), g)[0],
);
time(
  'CONTROL  V().outE().has(UNINDEXED)',
  () => toArray(traversal(V(), outE('PAID'), has('other', 500), count()), g)[0],
);
