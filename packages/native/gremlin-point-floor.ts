/**
 * THE GREMLIN POINT LOOKUP AGAINST A HAND FLOOR, and the two spellings of it against each other.
 *
 * ⚠️ WHY IT EXISTS. Three items left questions on this shape and none of them can be answered from
 * the others' numbers (item 1640: do not compare across files):
 *
 * - **Item 1642** decomposed `V().hasId(x).values(k)` at **1277.6 ns/call** — 233.8 construction,
 *   ~1044 execution — and named the structural fix: a closed-form route for "seeded by id + one
 *   projection" that never builds a traverser.
 * - **Item 1643** made `V().hasId(x)` rewrite to the seeded `V(x)` for exactly one id, and left the
 *   two spellings **1.44x** apart anyway, blaming a per-call plan reallocation whose fix — a memo on
 *   the rewrite — item 1503 had refused.
 * - **Items 1647/1648** then built that memo (as a plan slot, not a `WeakMap`) and cached the static
 *   checks too. So item 1643's residual may already be gone, and its "35-55x a 9.3 ns hand floor"
 *   needs re-measuring before anything is built against it.
 *
 * THE FLOOR IS THE POINT. `floor` does by hand exactly what the query answers — one
 * `getVertexById` and one property read — so the gap is the engine's per-call overhead for a
 * ONE-ROW answer, which is what a serving workload pays on its commonest query.
 *
 *     ARM=floor bun gremlin-point-floor.ts
 *     ARM=seeded bun gremlin-point-floor.ts
 *     ARM=hasid-rebuilt N=200000 REPS=14 bun gremlin-point-floor.ts
 *
 * ⚠️ IT IMPORTS THE EXECUTOR FROM `src`, NOT FROM `@lenke/gremlin`. Item 1647 lost an A/B to that:
 * the package resolves to the BUILT DIST, so a `src`-only change measures as a null in both arms.
 *
 * ONE ARM PER PROCESS (item 762), and the ids are spread across the vertex set so no single entry
 * monopolises an inline cache.
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { V, count, hasId, out, values } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { traversal } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal executor entry point, read pre-build
import { toArray } from '../gremlin/src/executor/index.js';
import { assertBranching } from './src/fixture-branching.js';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'floor';

const ARMS = [
  'floor',
  'floor-count',
  'seeded',
  'hasid',
  'seeded-count',
  'hasid-count',
  'seeded-rebuilt',
  'hasid-rebuilt',
  'build-only',
  'floor-hopcount',
  'seeded-hopcount',
  'floor-manyids',
  'seeded-manyids',
];

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } });
}

/**
 * ⚠️ EDGES, BECAUSE THE FIRST VERSION HAD NONE and the hop-count arms both answered 0 — a
 * degree measurement on a degree-ZERO fixture, which is the answer-invariant-to-the-property trap
 * CLAUDE.md records at item 702. `to` splits on the repeat index so the graph BRANCHES (items
 * 1516/1518): `(a*k + b) % N` alone is invariant under `k -> k + N`, which would give every vertex
 * FANOUT parallel edges to ONE target.
 */
const FANOUT = Number(process.env.FANOUT ?? 4);

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = (k * 7919) % NODES;
  const to = ((k % NODES) * 104_729 + Math.floor(k / NODES) * 977) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`v${from}`) as Vertex,
    to: g.getVertexById(`v${to}`) as Vertex,
    labels: ['T'],
    properties: {},
  });
}

assertBranching('gremlin-point-floor', NODES, FANOUT, (k: number) => [
  (k * 7919) % NODES,
  ((k % NODES) * 104_729 + Math.floor(k / NODES) * 977) % NODES,
]);

/**
 * A spread of ids rather than one, so the measurement is not of a single entry parked in an inline
 * cache — but a FIXED cycle, so every arm sees the same sequence.
 */
const IDS = Array.from({ length: 64 }, (_, i) => `v${(i * 3121) % NODES}`);
let cursor = 0;

const nextId = (): string => {
  cursor = (cursor + 1) & 63;

  return IDS[cursor];
};

/** The hand floor: exactly the work the query answers, with no engine in the way. */
const floor = (): unknown => {
  const v = g.getVertexById(nextId());

  return v === undefined ? undefined : (v as Vertex).properties.k;
};

const floorCount = (): unknown => (g.getVertexById(nextId()) === undefined ? 0 : 1);

const seededPlans = new Map<string, Plan>();
const hasidPlans = new Map<string, Plan>();
const seededCountPlans = new Map<string, Plan>();
const hasidCountPlans = new Map<string, Plan>();

for (const id of IDS) {
  seededPlans.set(id, traversal(V(id), values('k')));
  hasidPlans.set(id, traversal(V(), hasId(id), values('k')));
  seededCountPlans.set(id, traversal(V(id), count()));
  hasidCountPlans.set(id, traversal(V(), hasId(id), count()));
}

/**
 * ⚠️ THE SHAPE THE DECLINE ACTUALLY COSTS MOST. `countShortcut` refuses any SEEDED source outright
 * (`(source.ids?.length ?? 0) > 0` returns undefined), so `V(id).out(T).count()` — one vertex's
 * out-degree, the commonest serving question there is — takes the whole traverser walk even though
 * the answer is the length of one adjacency list.
 */
const hopCountPlans = new Map<string, Plan>();
const manyIdPlan = traversal(V(...IDS), count());

for (const id of IDS) {
  hopCountPlans.set(id, traversal(V(id), out('T'), count()));
}

const floorHopCount = (): unknown => {
  const v = g.getVertexById(nextId());

  return v === undefined ? 0 : g.outDegree(v as Vertex, 'T');
};

const floorManyIds = (): unknown => {
  let n = 0;

  for (const id of IDS) {
    if (g.getVertexById(id) !== undefined) {
      n += 1;
    }
  }

  return n;
};

const WORK: Record<string, () => unknown> = {
  floor,
  'floor-hopcount': floorHopCount,
  'seeded-hopcount': () => toArray(hopCountPlans.get(nextId())!, g),
  'floor-manyids': floorManyIds,
  'seeded-manyids': () => toArray(manyIdPlan, g),
  'floor-count': floorCount,
  // Plans REUSED — one per id, built up front, so the per-plan memos of items 1647/1648 are warm.
  seeded: () => toArray(seededPlans.get(nextId())!, g),
  hasid: () => toArray(hasidPlans.get(nextId())!, g),
  'seeded-count': () => toArray(seededCountPlans.get(nextId())!, g),
  'hasid-count': () => toArray(hasidCountPlans.get(nextId())!, g),
  // ⚠️ THE CASE GREMLIN ACTUALLY HAS, because it has no parameter binding (item 1577): a caller
  // whose id varies builds a new plan every call and collects no memo.
  'seeded-rebuilt': () => toArray(traversal(V(nextId()), values('k')), g),
  'hasid-rebuilt': () => toArray(traversal(V(), hasId(nextId()), values('k')), g),
  // The control the engine change cannot reach: construction with no run.
  'build-only': () => traversal(V(nextId()), values('k')),
};

const work = WORK[ARM];
const INNER = Number(process.env.INNER ?? 20_000);

for (let i = 0; i < 3; i += 1) {
  for (let j = 0; j < INNER; j += 1) {
    work();
  }
}

const series: number[] = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (let j = 0; j < INNER; j += 1) {
    work();
  }

  series.push(((performance.now() - t0) * 1e6) / INNER);
}

const warm = series.slice(DROP).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    arm: ARM,
    answer: JSON.stringify(work()),
    nsPerCall: Number((warm[Math.floor(warm.length / 2)] ?? 0).toFixed(1)),
    min: Number(Math.min(...series).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
