/**
 * THE FLOOR for a TWO-HOP row-returning Gremlin walk (item 1614), priced BEFORE building anything —
 * item 1465's rule.
 *
 * `hopValuesShortcut` takes `[V, hop, proj]` and declines at a second hop, so `V().out(E).values(k)`
 * rides a fused walk while `V().out(E).out(E).values(k)` drops the WHOLE query onto the traverser
 * pipeline. The per-row gap is 4.6x, and the profiles say it is the pipeline rather than the extra
 * work:
 *
 * ```text
 *    one hop   (g-hopvaluesrows)    drain 15.9%  pick 8.9%        <- the fused walk
 *    two hops  (g-hop2valuesrows)   iterLabeled 19.3%  otherEndpoint 14.8%
 *                                   traverseToVertex 11.3%  unwrap 3.1%  extend 1.6%
 *                                                                    <- the generic pipeline
 *      65.7 ns/row against 304
 * ```
 *
 * ⚠️ EVERY TWO-HOP SHAPE IN THE PROFILE CORPUS ENDS IN `count()`, which `hopChainCount` answers
 * from degrees without walking at all (item 590) — so the two-hop WALK has only ever been profiled
 * in the arm where it does not run. That is why this is a structural hole rather than a known cost.
 *
 * The floor is the nested walk by hand, in TinkerPop's own order: for each vertex, for each out-edge
 * in bucket order, for each out-edge of THAT far end. `id` as well as `values`, because the one-hop
 * file prices the property read separately and a gap present in both arms is the walk.
 *
 *     bun two-hop-values-floor.ts
 *     NODES=50000 REPS=10 bun two-hop-values-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, gt, has, id, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 15);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 97, n: i } });
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
    properties: {},
  });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS AND THE BRANCHING before trusting any number off this fixture.
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

/** The hand walk, in TinkerPop's order: per vertex, per out-edge, per out-edge of the far end. */
const handTwoHop = (key: string | undefined): unknown[] => {
  const outp: unknown[] = [];

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
        const far = e1.to;

        if (key === undefined) {
          outp.push(far.id);
        } else {
          const value = far.properties[key];

          if (value !== undefined) {
            outp.push(value);
          }
        }
      }
    }
  }

  return outp;
};

/** The same nesting one level deeper, to price the three-hop case item 1614 declines. */
const handThreeHop = (key: string): unknown[] => {
  const outp: unknown[] = [];

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
        const b2 = e1.to.adjFrom?.get('E');

        if (b2 === undefined) {
          continue;
        }

        for (const e2 of b2 as Iterable<Edge>) {
          const value = e2.to.properties[key];

          if (value !== undefined) {
            outp.push(value);
          }
        }
      }
    }
  }

  return outp;
};

/** The trailing-filtered nested walk by hand — the floor for the item 1615 arms. */
const handTwoHopFiltered = (): unknown[] => {
  const outp: unknown[] = [];

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

        if (typeof k === 'number' && k > 44) {
          outp.push(k);
        }
      }
    }
  }

  return outp;
};

type Arm = { name: string; run: () => number };

const ARMS: Arm[] = [
  {
    name: 'engine 1 hop values (the FUSED reference)',
    run: () => toArray(traversal(V(), out('E'), values('k')), g).length,
  },
  {
    name: 'engine 2 hop values  (FUSED at 1614)',
    run: () => toArray(traversal(V(), out('E'), out('E'), values('k')), g).length,
  },
  {
    name: 'engine 2 hop id      (FUSED at 1614)',
    run: () => toArray(traversal(V(), out('E'), out('E'), id()), g).length,
  },
  { name: 'HAND  2 hop values   (the FLOOR)', run: () => handTwoHop('k').length },
  { name: 'HAND  2 hop id       (the FLOOR)', run: () => handTwoHop(undefined).length },
  // ── Item 1615: the two-hop walk WITH A FILTER, in each of the three positions ────────────────
  //
  // These are the shapes item 1614 left on the pipeline and the only two the cliff finder still read
  // that way. The trailing one cost 4.7x its (now fused) unfiltered neighbour for FIFTY TIMES FEWER
  // rows, because it walked all 319,972 traversers down the pipeline and then filtered. Their
  // profiles are the same delegation chain item 1614 removed: `iterLabeled` + `iterByLabel` +
  // `outEdgesOf` + `otherEndpoint` + `traverseToVertex` is 53.7% of the trailing shape and 49.7% of
  // the mid one.
  {
    name: '2 hop + TRAILING has, values',
    run: () => toArray(traversal(V(), out('E'), out('E'), has('k', gt(44)), values('k')), g).length,
  },
  {
    name: '2 hop + MID has, values',
    run: () => toArray(traversal(V(), out('E'), has('k', gt(44)), out('E'), values('k')), g).length,
  },
  {
    name: '2 hop + LEAD has, values',
    run: () => toArray(traversal(V(), has('k', gt(44)), out('E'), out('E'), values('k')), g).length,
  },
  {
    name: 'HAND  2 hop + trailing has (FLOOR)',
    run: () => handTwoHopFiltered().length,
  },
  // ⚠️ THREE hops, to PRICE what item 1614 leaves open rather than asserting it is worth taking.
  {
    name: 'engine 3 hop values  (the pipeline)',
    run: () => toArray(traversal(V(), out('E'), out('E'), out('E'), values('k')), g).length,
  },
  { name: 'HAND  3 hop values   (the FLOOR)', run: () => handThreeHop('k').length },
];

console.log(
  `${'arm'.padEnd(42)} ${'ms/rep'.padStart(9)} ${'rows'.padStart(9)} ${'ns/row'.padStart(8)}`,
);

for (const arm of ARMS) {
  let rows = 0;

  for (let i = 0; i < 3; i += 1) {
    rows = arm.run();
  }

  // MIN of N, the harness's own estimator for the native path.
  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    rows = arm.run();
    best = Math.min(best, performance.now() - t0);
  }

  console.log(
    `${arm.name.padEnd(42)} ${best.toFixed(2).padStart(9)} ${String(rows).padStart(9)} ${((best * 1e6) / rows).toFixed(1).padStart(8)}`,
  );
}
