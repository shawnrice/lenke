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
import type { Plan, Step } from '@lenke/gremlin';
import { traversal } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung, read pre-build (item 1660)
import { countShortcut } from '../gremlin/src/executor/count-shortcut.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal executor entry point, read pre-build
import { effectivePlan, toArray } from '../gremlin/src/executor/index.js';
// ⚠️ THE DIRECTIVE SITS INSIDE THE BRACES, which looks odd and is the only placement that works:
// the rule reports a WRAPPED import on its `} from '…'` line, so a directive above the `import`
// keyword misses it — and keeping the import on one line instead fails `fmt:check` (item 1660).
import {
  idSeededValuesShortcut,
  nodeValuesShortcut,
  seededIdWalk,
  // eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung, read pre-build (item 1660)
} from '../gremlin/src/executor/node-values.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung, read pre-build (item 1660)
import { groupCountShortcut } from '../gremlin/src/executor/projection.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal prologue, read pre-build (item 1660)
import { newContext, planReadsPath } from '../gremlin/src/executor/runtime.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung, read pre-build (item 1660)
import { asStringId } from '../gremlin/src/executor/sources.js';
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
  'seeded-twokeys',
  'seeded-bare',
  'seeded-manyvalues',
  'floor-manyvalues',
  // Item 1660's envelope arms — see THE ENVELOPE QUESTION below.
  'bypass-values',
  'bypass-hopcount',
  'rung-walkonly',
  'rung-eager',
  'rung-eager-oneshot',
  'pro-base',
  'pro-context',
  'pro-effective',
  'pro-declines',
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

/**
 * ⚠️ THE CONTROL FOR A NEW RUNG, which the arms above cannot be. Every other arm here is either
 * ADMITTED by item 1650's shortcut or answered before `run` reaches its call site, so none of them
 * prices what the extra gate costs a shape it DECLINES. `values(k, s)` fans out per key, which the
 * rung refuses, and `V(id)` bare has no projection at all — both walk past the new call site and on
 * to the pipeline.
 */
const twoKeyPlans = new Map<string, Plan>();
const barePlans = new Map<string, Plan>();

for (const id of IDS) {
  twoKeyPlans.set(id, traversal(V(id), values('k', 'kk')));
  barePlans.set(id, traversal(V(id)));
}

/**
 * ⚠️ THE MULTI-ROW CASE, so a change aimed at per-CALL overhead is not read off a one-row answer
 * alone. 64 ids through one plan: if a change helps the fixed cost and hurts the per-row path, the
 * one-id arms cannot see it and this one can.
 */
const manyValuesPlan = traversal(V(...IDS), values('k'));

const floorManyValues = (): unknown => {
  const rows: unknown[] = [];

  for (const id of IDS) {
    const v = g.getVertexById(id);

    if (v !== undefined) {
      rows.push((v as Vertex).properties.k);
    }
  }

  return rows;
};

/**
 * ⚠️ THE ENVELOPE QUESTION (item 1660), which item 1652's term-by-term ablations could NOT answer.
 *
 * Item 1652 priced each term of the remaining ~126 ns separately — `newContext` at 2.7-5%, laziness
 * at FLAT, the rung's position at a wash — and declared a floor. But a sum of small ablations is not
 * the envelope: each one was measured against the OTHER terms still present, and the question "what
 * would a perfect `run` cost?" needs ONE arm that removes the whole prologue at once.
 *
 * `bypass-values` is that arm. It calls the rung that answers `V(id).values(k)` DIRECTLY, so it pays
 * `getVertexById`, the walk and the generator protocol — and NONE of `run`'s prologue: no
 * `EFF_CHECKED` read, no `newContext`, no `withSack` peel, no `effectivePlan`, and none of the three
 * rungs that decline this shape before the fourth answers it.
 *
 * ⚠️ IT IS NOT A CANDIDATE IMPLEMENTATION. Skipping the static checks and the vacuous-label drop is
 * UNSOUND — that is the point, exactly as item 1652's singleton `newContext` was. It prices a
 * ceiling nothing can exceed, and the three `pro-*` arms then say where inside that ceiling the time
 * sits, so a route token's share can be read off rather than estimated:
 *
 *   seeded − bypass          = the whole removable prologue
 *   pro-declines − pro-effective = the declining chain ALONE, which is all a route token removes
 *   bypass − floor           = the rung's own cost, unreachable without changing the contract
 *
 * ⚠️ THE `pro-*` ARMS RECONSTRUCT `run`'s PROLOGUE and so can DRIFT from it. They are a cross-check
 * on the subtraction, never the primary number: if `pro-declines` does not land near
 * `seeded − bypass`, believe the subtraction and distrust the reconstruction.
 */
const drained = (it: { drain?: () => unknown[] } & Iterable<unknown>): unknown[] =>
  typeof it.drain === 'function' ? it.drain() : [...it];

const bypassValues = (): unknown => {
  const plan = seededPlans.get(nextId())!;
  const rung = idSeededValuesShortcut(plan, g);

  if (rung === undefined) {
    throw new Error('bypass-values: the rung DECLINED — the arm is measuring nothing');
  }

  return drained(rung);
};

const bypassHopCount = (): unknown => {
  const plan = hopCountPlans.get(nextId())!;
  const n = countShortcut(plan, g);

  if (n === undefined) {
    throw new Error('bypass-hopcount: the rung DECLINED — the arm is measuring nothing');
  }

  return [n];
};

/**
 * ⚠️ INSIDE THE RUNG (item 1660). `bypass-values − floor` is ~81 ns — **two thirds of the whole
 * call** and far more than the prologue — and nothing has ever decomposed it. These two arms split
 * it into the parts a change could reach.
 *
 * `rung-walkonly` skips `matchSeededShape` and calls the module-scope generator directly with the
 * arguments already extracted, so `bypass-values − rung-walkonly` is the shape match plus the
 * `{ ids, label, key }` object it allocates per call.
 *
 * `rung-eager` replaces the GENERATOR with the same loop writing into an array, so
 * `rung-walkonly − rung-eager` is the generator protocol: the generator object, its resume/suspend
 * per yield, and the `[...gen]` spread's array iterator.
 *
 * ⚠️ UNLIKE ITEM 1652's EAGER-ARRAY ABLATION, THIS ONE IS NOT AUTOMATICALLY UNSOUND. That item
 * replaced the rung's return value while keeping the generator, and measured FLAT. This removes the
 * generator machinery itself — which the laziness contract forbids for a MULTI-id list (`asStringId`
 * must raise from inside the walk, after earlier ids have yielded) but which **nothing observes for
 * a SINGLE id**, because there is no earlier value to have yielded. So if this arm converts, the
 * one-id case is a sound specialization rather than a priced-and-refused trade.
 */
const rungWalkOnly = (): unknown => {
  const plan = seededPlans.get(nextId())!;
  const source = plan.steps[0] as Extract<Step, { kind: 'V' }>;
  const proj = plan.steps[1] as Extract<Step, { kind: 'values' }>;

  return [...seededIdWalk(source.ids!, undefined, proj.keys[0], g)];
};

const rungEager = (): unknown => {
  const plan = seededPlans.get(nextId())!;
  const source = plan.steps[0] as Extract<Step, { kind: 'V' }>;
  const proj = plan.steps[1] as Extract<Step, { kind: 'values' }>;
  const ids = source.ids!;
  const [key] = proj.keys;
  const acc: unknown[] = [];

  for (const id of ids) {
    const v = g.getVertexById(asStringId(id));

    if (v === undefined || v === null) {
      continue;
    }

    const props = v.properties;

    if (key in props) {
      acc.push(props[key]);
    }
  }

  return acc;
};

/**
 * ⚠️ THE ARM THAT ANSWERS ITEM 1651's OBJECTION, which `rung-eager` alone does not.
 *
 * Item 1651 deleted the `{ [Symbol.iterator], drain }` wrapper partly because it made
 * `V(id).values(k)` RE-ITERABLE where `run`'s result is one-shot for nearly every plan — so whether
 * re-iteration worked depended on which rung fired. **A bare eager array has exactly that problem**,
 * so `rung-eager` prices a ceiling that the contract may not allow us to reach.
 *
 * `arr.values()` is the cheapest one-shot form available: a built-in Array Iterator, no closure and
 * no object literal. If this arm holds `rung-eager`'s win, the objection costs nothing and the
 * eager route is both sound AND fast. If it gives the win back, the generator protocol is the
 * contract's price rather than waste, and that is the honest finding instead.
 */
const rungEagerOneShot = (): unknown => {
  const arr = rungEager() as unknown[];

  return [...arr.values()];
};

/**
 * ⚠️ THE ARM THAT MAKES THE CROSS-CHECK EXACT. Every `pro-*` arm pays the id cycle, the plan-map
 * lookup and the timing loop, and so does every `seeded`/`bypass` arm — so that base CANCELS in the
 * subtraction `seeded − bypass` but NOT in a `pro-*` arm's absolute number. Without this arm the
 * reconstruction reads ~42 ns against the subtraction's ~28 and the two look like they disagree.
 */
const proBase = (): unknown => seededPlans.get(nextId())!.steps.length;

/** `run`'s prologue up to and including `newContext`. */
const proContext = (): unknown => {
  const plan = seededPlans.get(nextId())!;

  return newContext(planReadsPath(plan)).tracksPath;
};

/** …plus the vacuous-label drop / rewrite chain, whose prefix items 1647/1648 already cache. */
const proEffective = (): unknown => {
  const plan = seededPlans.get(nextId())!;
  const ctx = newContext(planReadsPath(plan));

  return effectivePlan(plan, g, ctx.tracksPath).steps.length;
};

/**
 * …plus the three rungs that DECLINE `V(id).values(k)` before item 1650's answers it. This is the
 * only part of the prologue a per-plan route token can remove, so `pro-declines − pro-effective` is
 * that lever's entire ceiling.
 */
const proDeclines = (): unknown => {
  const plan = seededPlans.get(nextId())!;
  const ctx = newContext(planReadsPath(plan));
  const effective = effectivePlan(plan, g, ctx.tracksPath);
  const a = countShortcut(effective, g);
  const b = groupCountShortcut(effective, g);
  const c = ctx.tracksPath ? undefined : nodeValuesShortcut(effective, g);

  // ⚠️ ASSERTED, not assumed: if any of the three ever ANSWERS this shape, the subtraction above is
  // measuring a different route from the one `seeded` takes and the whole arm is void.
  if (a !== undefined || b !== undefined || c !== undefined) {
    throw new Error('pro-declines: a rung ANSWERED — this is not the decline chain seeded pays');
  }

  return effective.steps.length;
};

const WORK: Record<string, () => unknown> = {
  floor,
  'bypass-values': bypassValues,
  'bypass-hopcount': bypassHopCount,
  'rung-walkonly': rungWalkOnly,
  'rung-eager': rungEager,
  'rung-eager-oneshot': rungEagerOneShot,
  'pro-base': proBase,
  'pro-context': proContext,
  'pro-effective': proEffective,
  'pro-declines': proDeclines,
  'seeded-manyvalues': () => toArray(manyValuesPlan, g),
  'floor-manyvalues': floorManyValues,
  'seeded-twokeys': () => toArray(twoKeyPlans.get(nextId())!, g),
  'seeded-bare': () => toArray(barePlans.get(nextId())!, g),
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
