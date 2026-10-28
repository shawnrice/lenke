/**
 * ONE SHAPE PER PROCESS: what does deferring the HOP projection under a windowed sort cost or save?
 *
 * Item 1063's instrument, the same one `defer-sort-probe.ts` uses and for the same reasons — a
 * single process running every shape lets one shape's dispatch pollute another's, and some TS
 * shapes are bimodal inside one process. The first in-process reading of this change had the
 * UNDIRECTED PLAIN control at 33.83 before and 50.99 after, which is a 1.5x regression on an arm
 * the change cannot reach; that is what this file exists to adjudicate.
 *
 *   cd packages/native && SHAPE=directed-arith bun defer-hop-probe.ts
 *
 * `reached: false` rows are CONTROLS: shapes that took the rung before the change, or that it
 * still refuses.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.HOP_N ?? 50_000);
const REPS = Number(process.env.HOP_REPS ?? 14);

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // THE SUBJECTS — one per walk variant, so a partial build would show up as one arm not moving.
  'directed-arith': {
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
    reached: true,
  },
  // The EXPRESSION spelling of the same key. It and `directed-arith` are one question.
  'directed-expr-key': {
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY b.k + 1 LIMIT 10',
    reached: true,
  },
  'filtered-arith': {
    q: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k > 10 RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
    reached: true,
  },
  'undirected-arith': {
    q: 'MATCH (a:P)-[:E]-(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
    reached: true,
  },
  'relbound-arith': {
    q: 'MATCH (a:P)-[e:E]->(b:P) RETURN e.w + 1 AS c ORDER BY c LIMIT 10',
    reached: true,
  },
  'seeded-arith': {
    q: 'MATCH (a:P {k: 7})-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
    reached: true,
  },
  fn: { q: 'MATCH (a:P)-[:E]->(b:P) RETURN upper(b.s) AS c ORDER BY c LIMIT 10', reached: true },
  // Both endpoints read, so the key row carries TWO elements rather than one.
  'both-ends': {
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k + 1 AS c ORDER BY x LIMIT 10',
    reached: true,
  },

  // CONTROLS. The four `*-plain` arms already took the rung — every item is a property read, so
  // `outputColumnSorts` admitted the window on the first ask and the deferred arm is never
  // consulted. They are the arms that must not move.
  'directed-plain': {
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c ORDER BY c LIMIT 10',
    reached: false,
  },
  'filtered-plain': {
    q: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k > 10 RETURN b.k AS c ORDER BY c LIMIT 10',
    reached: false,
  },
  'undirected-plain': {
    q: 'MATCH (a:P)-[:E]-(b:P) RETURN b.k AS c ORDER BY c LIMIT 10',
    reached: false,
  },
  'relbound-plain': {
    q: 'MATCH (a:P)-[e:E]->(b:P) RETURN e.w AS c ORDER BY c LIMIT 10',
    reached: false,
  },
  // No window, so the fault rule never applied: this took the rung before and after.
  nolimit: { q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c', reached: false },
  // Still refused, and under deferral that guard is correctness, not cosmetics.
  limit0: { q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 0', reached: false },
  // No sort at all — the general path is lazy here and the rung declines, unchanged.
  unsorted: { q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c LIMIT 10', reached: false },
  // An UNRELATED hop shape with no sort and no window: the broadest null control available.
  'plain-hop': { q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c', reached: false },
};

const name = process.env.SHAPE ?? 'directed-arith';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();
const vs = [];

for (let i = 0; i < N; i++) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: (i * 7919) % N, s: `s${i % 997}` },
    }),
  );
}

for (let i = 0; i < N; i++) {
  g.addEdge({
    id: `e${i}`,
    labels: ['E'],
    from: vs[i],
    to: vs[(i * 13 + 1) % N],
    properties: { w: i % 100 },
  });
}

const series: number[] = [];

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, shape.q);
  const ms = performance.now() - t0;

  series.push(ms);

  if (r === 0) {
    console.log(`rows=${rows.length}`);
  }
}

const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];

console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(18)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${median.toFixed(2)} ms   N=${N}`,
);
