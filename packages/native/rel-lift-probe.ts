/**
 * ONE SHAPE PER PROCESS, with the per-rep series printed (item 1034).
 *
 * `edge-index-probe.ts` runs nine shapes in one process and reports a median of six warm reps.
 * That is the wrong instrument for a dispatch change: CLAUDE.md records both halves of why — a
 * two-dist in-process A/B flatters any change that REDISTRIBUTES call sites, and some TS shapes
 * are outright BIMODAL inside one process, so a median of six can land in either mode. Item 1034's
 * first reading had the same query 2.6x FASTER with named ends and 2x SLOWER with anonymous ones,
 * which is one question giving two answers — the instrument, not the engine.
 *
 * So: one shape, chosen by `SHAPE`, in its own process; fourteen reps; the whole series printed;
 * the median of reps 4+ as the summary. The arms that cannot execute a rel lift are controls and
 * are listed as such.
 *
 *   cd packages/native && SHAPE=named-clause bun rel-lift-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.EDGE_N ?? 100_000);
const REPS = Number(process.env.EDGE_REPS ?? 14);

/** Every shape is the SAME count over the same fixture; only the spelling differs.
 *  `reached` says whether a rel lift can execute for it — the controls are the `false` rows. */
const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // The SUBJECT, both spellings of one question. Anonymous ends and named ends must agree.
  'anon-clause': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN count(*) AS c',
    reached: true,
  },
  'named-clause': {
    q: 'MATCH (a)-[e:PAID]->(b) WHERE e.amount = 500 RETURN count(*) AS c',
    reached: true,
  },
  // Also reached: the predicate reads only `e`. A key NO edge carries, so it is the selectivity
  // extreme of the same route rather than a control.
  unindexed: { q: 'MATCH ()-[e:PAID]->() WHERE e.other = 500 RETURN count(*) AS c', reached: true },
  // CONTROLS. Neither can take the new walk: the inline spelling is an `InlinePred` on the tally,
  // and a node-key clause routes to the START walk.
  'named-inline': {
    q: 'MATCH (a)-[e:PAID {amount: 500}]->(b) RETURN count(*) AS c',
    reached: false,
  },
  'node-key': { q: 'MATCH (a)-[e:PAID]->(b) WHERE a.n = 7 RETURN count(*) AS c', reached: false },
};

const name = process.env.SHAPE ?? 'named-clause';
const shape = SHAPES[name];

if (shape === undefined) {
  console.log(`unknown SHAPE=${name}; one of ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

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
    properties: { amount: i % 1_000 },
  });
}

g.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] });

const series: number[] = [];
let answer: unknown;

for (let r = 0; r < REPS; r++) {
  const t = performance.now();

  answer = tsQuery(g, shape.q)[0]?.c;
  series.push(performance.now() - t);
}

// Reps 4+ only: the first three are visibly the JIT tiering up, and the MEDIAN rather than the
// min, because the general scalar path plateaus high and emits a rare fast rep that `min` would
// report as the whole story.
const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `SHAPE=${name} reached=${shape.reached} answer=${String(answer)} median=${median.toFixed(3)}`,
);
console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
