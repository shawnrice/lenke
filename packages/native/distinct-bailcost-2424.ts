/**
 * WHAT DOES THE OBJECT BAIL COST the shape that pays it?
 *
 * Item 2424's primitive arm returns `null` on the first object value and the caller then runs the
 * keyed arm over the WHOLE pass again, so an object-valued column walks twice. That is the cost
 * side of the item and it has to be measured rather than waved at: the alternative (converting
 * mid-loop) was rejected because this file measures a per-row branch ahead of a hot body at 1.6x
 * (item 159), and because `rows` stores `cell ?? null` and so cannot supply the raw values a
 * conversion would need to re-key.
 *
 * The bail fires on the FIRST reached vertex when every value is an object, so the wasted work is
 * one `levelWalk` plus one `fn(env)` — not a whole deduped pass. This probe measures the real
 * figure for a temporal column (the realistic object case in this repo's domain) against a numeric
 * one, and the operator compares it to the same run with `ARM=keyed`, where the raw arm is skipped.
 *
 *     bun distinct-bailcost-2424.ts
 */
import { Graph, type Vertex } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: reads SOURCE so an A/B edit is visible without a dist rebuild ([[fuzzers-read-built-dists]]).
import { query } from '../gql/src/index.ts';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const WARMUP = 3;

const g = new Graph();
const vs: Vertex[] = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: {
        k: i % 97,
        // A STORED temporal, so the cell comes back as an object and the primitive arm bails.
        t: { '@date': `2024-01-${String(1 + (i % 28)).padStart(2, '0')}` },
      },
    }),
  );
}

for (let e = 0; e < NODES; e += 1) {
  g.addEdge({
    id: `e${e}`,
    from: vs[e],
    to: vs[(e * 7 + 3) % NODES],
    labels: ['E'],
    properties: {},
  });
}

const SHAPES = {
  numeric: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS v',
  temporal: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.t AS v',
};

for (const [name, text] of Object.entries(SHAPES)) {
  const warm = query(g, text, {});
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, text, {});
    series.push(performance.now() - t0);
  }

  const kept = series.slice(WARMUP).sort((a, b) => a - b);
  const med = kept[kept.length >> 1];

  console.log(
    `${name.padEnd(9)} median ${med.toFixed(2)} ms  rows ${String(warm.length)}  (NODES=${String(NODES)})`,
  );
  console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
}
