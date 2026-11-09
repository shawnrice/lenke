/**
 * ITEM 1692's A/B INSTRUMENT: one engine SHAPE per process, so the arm's effect and its blast radius
 * are measured separately.
 *
 * `bench-gremlin.ts` has no row selector, and running several shapes in one process is what made
 * item 1691's first probe read the same arm at 31.9, 44.2 and 65.6 ms — the polymorphism trap
 * `start-filtered-hop-values.ts` records about the previous probe for this very row.
 *
 * Shapes:
 *
 *   target        V().out(E).has(k, eq(1)).id()         the arm's row
 *   targetValues  V().out(E).has(k, eq(1)).values(n)    the arm's row, other projection
 *   limited       … .id().limit(50)                     ⚠️ MUST take the LAZY path: the arm is
 *                                                       drain-only, so this is both a control and
 *                                                       the early-exit guard
 *   noFilter      V().out(E).values(n)                  no far filter -> declines
 *   bothHop       V().both(E).has(k, eq(1)).id()        `both` -> declines
 *   startOnly     V().hasLabel(Admin).out(E).values(n)  a START filter only -> declines
 *
 *   SHAPE=target node gremlin-far-mask-ab.mjs
 */
import { Graph } from '@lenke/core';
import {
  V,
  both,
  eq,
  has,
  hasLabel,
  id,
  limit,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(
    g.addVertex({
      id: `u${i}`,
      labels: ((i * 40_503) >>> 3) % 3 === 0 ? ['User', 'Admin'] : ['User'],
      properties: { k: i % 90, n: i },
    }),
  );
}

let e = 0;
const targets = new Set();

// ⚠️ Target NONLINEAR in `i`, so in-degree varies and the graph is not functional (items
// 1516/1518/1684): a linear `(a*i+b) % N` is a bijection per layer and makes this row a chain.
for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    targets.add(mix % N);
    g.addEdge({ id: `e${e}`, from: vs[i], to: vs[mix % N], labels: ['E'], properties: {} });
    e += 1;
  }
}

if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const SHAPES = {
  target: traversal(V(), out('E'), has('k', eq(1)), id()),
  targetValues: traversal(V(), out('E'), has('k', eq(1)), values('n')),
  limited: traversal(V(), out('E'), has('k', eq(1)), id(), limit(50)),
  noFilter: traversal(V(), out('E'), values('n')),
  bothHop: traversal(V(), both('E'), has('k', eq(1)), id()),
  startOnly: traversal(V(), hasLabel('Admin'), out('E'), values('n')),
};

const PICK = process.env.SHAPE;

if (PICK === undefined || SHAPES[PICK] === undefined) {
  throw new Error(`set SHAPE to one of: ${Object.keys(SHAPES).join(', ')}`);
}

const plan = SHAPES[PICK];
const rows = toArray(plan, g).length;

if (rows === 0) {
  throw new Error(`SHAPE ${PICK} yielded no rows — it would prove nothing`);
}

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  toArray(plan, g);
  series.push(performance.now() - t0);
}

/** ⚠️ MEDIAN of the warm reps: the TS per-row path plateaus and emits a rare fast rep, so `min` is
 *  the wrong estimator and has reversed a verdict's sign in this repo before. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${PICK.padEnd(14)} median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(8)} rows=${String(rows).padStart(8)} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
