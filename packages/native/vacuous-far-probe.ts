/**
 * ONE SHAPE PER PROCESS: what does a VACUOUS far label cost a hop walk?
 *
 * Item 1066's subject. `matchesLabel(far, farLabel)` dereferences the far vertex to read its
 * labels, and that deref is the dominant cost of a hop once the far set is too wide to be
 * cache-resident. A label every vertex carries cannot reject anything, so the test is pure cost.
 *
 *   cd packages/native && SHAPE=start-only-labelled bun vacuous-far-probe.ts
 *
 * `reached: false` rows are CONTROLS: shapes where the far label is SELECTIVE (so the test must
 * still run), or where the far end is dereferenced anyway, or that are not hops at all.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const V = Number(process.env.VF_V ?? 50_000);
const E = Number(process.env.VF_E ?? 50_000);
const REPS = Number(process.env.VF_REPS ?? 14);

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // THE SUBJECT: reads only the START, so the far deref exists solely for the label test.
  'start-only-labelled': {
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN min(a.k) AS c',
    reached: true,
  },
  // Its SPELLING TWIN, which never had the test. The two must converge — that is the check this
  // item is really making, not the raw number.
  'start-only-bare': { q: 'MATCH (a:P)-[:E]->(b) RETURN min(a.k) AS c', reached: false },
  // A projection of the start, same shape as the aggregate.
  'start-proj-labelled': { q: 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS c', reached: true },
  'start-proj-bare': { q: 'MATCH (a:P)-[:E]->(b) RETURN a.k AS c', reached: false },

  // CONTROLS the change cannot help: the far end is dereferenced anyway to read `b.k`, so
  // dropping the label test saves only the `labels` lookup.
  'far-read': { q: 'MATCH (a:P)-[:E]->(b:P) RETURN min(b.k) AS c', reached: false },
  'far-rows': { q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c', reached: false },
  // A SELECTIVE far label: `Q` is on a tenth of the vertices, so the test must still run and this
  // arm is the one that would show a correctness shortcut as a speed-up.
  'selective-far': { q: 'MATCH (a:P)-[:E]->(b:Q) RETURN min(a.k) AS c', reached: false },
  // Not a hop at all.
  'node-min': { q: 'MATCH (n:P) RETURN min(n.k) AS c', reached: false },
};

const name = process.env.SHAPE ?? 'start-only-labelled';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();
const vs = [];

for (let i = 0; i < V; i++) {
  // Every vertex carries `P` — so `:P` is VACUOUS — and a tenth also carry `Q`, which is not.
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: i % 10 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: (i * 7919) % V },
    }),
  );
}

// One edge per start vertex, pointing across the WHOLE vertex set, so the far objects are as
// scattered as the fixture allows — which is the regime where the deref costs anything.
for (let e = 0; e < E; e++) {
  g.addEdge({
    id: `e${e}`,
    labels: ['E'],
    from: vs[e % V],
    to: vs[(e * 7919) % V],
    properties: { w: e % 100 },
  });
}

const series: number[] = [];

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, shape.q);
  const ms = performance.now() - t0;

  series.push(ms);

  if (r === 0) {
    console.log(`rows=${rows.length} first=${JSON.stringify(rows[0])}`);
  }
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(20)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   V=${V} E=${E}`,
);
