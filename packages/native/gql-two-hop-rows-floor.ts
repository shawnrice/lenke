/**
 * THE FLOOR for GQL's two-hop ROW projection, priced before building anything (item 1465's rule).
 *
 * `gql-cliff-finder.ts` found this shape has NO rung at all (item 1618):
 *
 * ```text
 *    MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k                  29 ns/row   hopProjection
 *    MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k     644 ns/row   PIPELINE
 *    the same two-hop COUNT                                  closed form, 415 us
 * ```
 *
 * 22x worse PER ROW than the one-hop projection, on a shape that is one segment away from it. The
 * profile says it is the generic matcher rather than extra work — `expand` 28.5%, `walkSegments`
 * 11.3%, `evalLabelExpr` 9.3%, `withBinding` 8.5% — where the one-hop shape runs `farDrivenHopWalk`.
 *
 * ⚠️ THE GQL FLOOR IS NOT THE GREMLIN ONE. Item 1617 measured a two-hop nested walk emitting BARE
 * VALUES at ~40 ns/row; GQL must emit ROW OBJECTS keyed by the alias, which is an allocation per
 * row that the Gremlin walk does not pay. So the floor is measured here with the rows actually
 * built, in three forms, to separate the walk from the row construction:
 *
 *   - `walk only`      — the nested walk, pushing the scalar. The Gremlin-shaped floor.
 *   - `rows literal`   — pushing `{ k: value }`, which is what a one-alias projection returns.
 *   - `rows template`  — one shape allocated per row from a template object, `farDrivenHopWalk`'s
 *                        own trick (its header calls it template-and-copy).
 *
 *     bun gql-two-hop-rows-floor.ts
 *     NODES=50000 REPS=8 bun gql-two-hop-rows-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 10);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['P'],
    properties: { team: `t${i % 50}`, k: i % 100, n: i, s: `s${i % 1000}` },
  });
}

/** ⚠️ Split on the REPEAT INDEX — items 1516/1518; a linear `(a*k+b)%N` makes the graph functional. */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`) as Vertex,
    to: g.getVertexById(`u${to}`) as Vertex,
    labels: ['E'],
    properties: { w: k % 7 },
  });
  edges += 1;
}

const targets = new Set<string>();
const degree = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
}

const branching = [...degree.values()].filter((d) => d > 1).length;

if (targets.size < NODES * 0.5 || branching < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed');
}

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${branching} branching\n`,
);

type Mode = 'scalar' | 'literal' | 'template';

const handTwoHop = (mode: Mode): unknown[] => {
  const acc: unknown[] = [];
  const template = { k: undefined as unknown };

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    for (const e0 of b0 as Iterable<Edge>) {
      const b1 = e0.to.adjFrom?.get('E');

      if (b1 === undefined) {
        continue;
      }

      for (const e1 of b1 as Iterable<Edge>) {
        const { k } = e1.to.properties;

        if (mode === 'scalar') {
          acc.push(k);
        } else if (mode === 'literal') {
          acc.push({ k });
        } else {
          const row = { ...template };

          row.k = k;
          acc.push(row);
        }
      }
    }
  }

  return acc;
};

type Arm = { name: string; run: () => number };

const ARMS: Arm[] = [
  {
    name: 'ENGINE  1 hop rows (hopProjection)',
    run: () => query(g, 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k').length,
  },
  {
    name: 'ENGINE  2 hop rows (the PIPELINE)',
    run: () => query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k').length,
  },
  {
    name: 'ENGINE  2 hop COUNT (closed form)',
    run: () => query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c').length,
  },
  { name: 'HAND    2 hop, scalar  (walk only)', run: () => handTwoHop('scalar').length },
  { name: 'HAND    2 hop, {k: v}  (rows)', run: () => handTwoHop('literal').length },
  { name: 'HAND    2 hop, template copy', run: () => handTwoHop('template').length },
];

console.log(
  `${'arm'.padEnd(38)} ${'ms/rep'.padStart(9)} ${'rows'.padStart(9)} ${'ns/row'.padStart(8)}`,
);

for (const arm of ARMS) {
  let rows = 0;

  for (let i = 0; i < 3; i += 1) {
    rows = arm.run();
  }

  const series: number[] = [];

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    rows = arm.run();
    series.push(performance.now() - t0);
  }

  // MEDIAN of the post-warmup reps — `ts-spelling-probe`'s estimator, after `min` reported a rare
  // fast rep against a high plateau.
  const tail = series.slice(2).sort((a, b) => a - b);
  const median = tail[Math.floor(tail.length / 2)];

  console.log(
    `${arm.name.padEnd(38)} ${median.toFixed(2).padStart(9)} ${String(rows).padStart(9)} ${((median * 1e6) / rows).toFixed(1).padStart(8)}`,
  );
}
