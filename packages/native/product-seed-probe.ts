/**
 * ONE SPELLING PER PROCESS: does a product's constrained side seed its index?
 *
 * Item 1073's subject — `bun run spelling`'s `a product's one-sided predicate: comma vs MATCH
 * MATCH (item 285)` group, which survives the `SPELL_ONLY` confirmation item 1072 added:
 *
 * ```text
 *   14.40ms  MATCH (a:S), (b:P) WHERE b.k = 7 RETURN b.k AS x
 *   10.61ms  MATCH (a:S) MATCH (b:P) WHERE b.k = 7 RETURN b.k AS x
 *   11.66ms  MATCH (a:S), (b:P WHERE b.k = 7) RETURN b.k AS x
 *   24.34ms  MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x        ← 2.3x
 * ```
 *
 * `k` is INDEXED and `k = 7` selects 1/50 of the vertices, so every spelling should seek. The
 * INLINE one being slowest is the suspicious part: `pred.props` is the FIRST thing
 * `indexCandidates` reads, so if any spelling seeds it should be that one.
 *
 * Four `S` vertices and 200,000 `P`, as the spelling probe's fixture has — the product is small on
 * one side deliberately, because a comma product materializes |left| x |right| bindings.
 *
 *   cd packages/native && SHAPE=inline-prop bun product-seed-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.PS_N ?? 200_000);
const REPS = Number(process.env.PS_REPS ?? 14);

const SHAPES: Record<string, string> = {
  'comma-clause': 'MATCH (a:S), (b:P) WHERE b.k = 7 RETURN b.k AS x',
  'match-match': 'MATCH (a:S) MATCH (b:P) WHERE b.k = 7 RETURN b.k AS x',
  'inline-where': 'MATCH (a:S), (b:P WHERE b.k = 7) RETURN b.k AS x',
  'inline-prop': 'MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x',
  // CONTROLS: the same constrained side WITHOUT the product, so the seek is measured alone.
  'solo-clause': 'MATCH (b:P) WHERE b.k = 7 RETURN b.k AS x',
  'solo-inline-prop': 'MATCH (b:P {k: 7}) RETURN b.k AS x',
};

const name = process.env.SHAPE ?? 'inline-prop';
const q = SHAPES[name];

if (q === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  g.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['P', 'Q', 'Univ'] : ['P', 'Univ'],
    properties: { k: i % 50, s: `s${i % 7}` },
  });
}

for (let i = 0; i < 4; i++) {
  g.addVertex({ id: `s${i}`, labels: ['S', 'Univ'], properties: { k: i, s: `t${i}` } });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });

const series: number[] = [];
let rows = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const out = tsQuery(g, q);

  series.push(performance.now() - t0);
  rows = out.length;
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`rows=${rows}`);
console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(18)} median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
