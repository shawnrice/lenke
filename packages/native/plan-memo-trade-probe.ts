/**
 * IS A `WeakMap<Plan, Plan>` MEMO ON `effectivePlan` WORTH IT? Both arms of the trade, in one
 * instrument (item 1646).
 *
 * ⚠️ WHY THIS EXISTS. Item 1645 found that `run` calls `effectivePlan` on EVERY invocation, so a
 * spelling needing normalisation pays for the normalisation every call — **117.5 ns of the 225.2 ns
 * gap** between `union(out(T), in(T)).count()` and `both(T).count()`. A memo would recover that for a
 * REUSED plan.
 *
 * Item 1503 measured exactly that trade for the much cheaper `readsPath` boolean and REFUSED it:
 * **1.52-1.61x for a reused plan but 1.07-1.15x WORSE for a rebuilt one**, because a freshly built
 * plan never hits the memo and still pays the `set`. Gremlin has no parameter binding (item 1577), so
 * a caller whose id varies rebuilds — and that is the case the refusal protects.
 *
 * What item 1645 added is a number on the OTHER side: 117.5 ns for the whole rewrite chain rather
 * than one boolean. Whether that beats the rebuilt penalty is a measurement nobody had made, and it
 * needs both arms. This is both arms.
 *
 *     ARM=reused-nomemo bun plan-memo-trade-probe.ts
 *     ARM=rebuilt-memo NODES=200000 REPS=12 bun plan-memo-trade-probe.ts
 *
 * ⚠️ THE MEMO HERE IS NOT A SHIPPABLE DESIGN AND IS NOT MEANT TO BE. `effectivePlan` takes the GRAPH
 * because `dropVacuousLabels` reads its label counts, so a plan-keyed memo goes stale when the
 * graph's labels change — the `csr_fresh` trap CLAUDE.md records going wrong natively. A sound key is
 * (plan, graph, mutation-epoch) and the graph has no epoch today. This probe measures the CEILING: if
 * even an unsound, maximally-cheap memo does not win, no sound one will.
 *
 * ONE ARM PER PROCESS (item 762), and per item 1640 do not compare these numbers with another file's.
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { V, both, count, in_, out, union } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { traversal } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { effectivePlan } from '../gremlin/src/executor/index.js';
import { assertBranching } from './src/fixture-branching.js';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 12);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'reused-nomemo';

const ARMS = [
  'reused-nomemo',
  'reused-memo',
  'rebuilt-nomemo',
  'rebuilt-memo',
  'rebuilt-build-only',
  'reused-field',
  'rebuilt-field',
  'reused-field2',
  'rebuilt-field2',
  'reused-field3',
  'rebuilt-field3',
];

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

const endpoints = (k: number): readonly [number, number] => [
  (k * 7919) % NODES,
  ((k % NODES) * 104_729 + Math.floor(k / NODES) * 977) % NODES,
];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } });
}

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const [from, to] = endpoints(k);

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

assertBranching('plan-memo-trade-probe', NODES, FANOUT, endpoints);

/**
 * The UNION spelling, because it is the one that makes `effectivePlan` do work: `fuseUnionBoth` fires
 * and rewrites it to `both(T)`. The `both` spelling would measure the gate declining, which item 1645
 * priced at 14.2 ns and is not the question.
 */
const buildUnion = (): Plan => traversal(V(), union(out('T'), in_('T')), count());

/** Kept so the `both` spelling is one import away for anyone extending this. */
const buildBoth = (): Plan => traversal(V(), both('T'), count());

void buildBoth;

const memo = new WeakMap<Plan, Plan>();

/** The maximally-cheap memo: one `get`, and a `set` on a miss. No graph in the key — see the header. */
const effectiveMemo = (plan: Plan): Plan => {
  const hit = memo.get(plan);

  if (hit !== undefined) {
    return hit;
  }

  const out1 = effectivePlan(plan, g, false);

  memo.set(plan, out1);

  return out1;
};

/**
 * ⚠️ THE THIRD DESIGN, AND THE ONE THAT MAY HAVE NO TRADE AT ALL. The `WeakMap` arms pay ~128 ns on a
 * guaranteed MISS because a `set` allocates — that penalty is what item 1503's refusal rests on.
 * Caching ON THE PLAN OBJECT makes a miss a property write on an object the caller just allocated,
 * which should be a few ns rather than a hundred.
 *
 * ⚠️ AND IT IS KEYED ON `graph.version`, which EXISTS ALREADY — `Graph` carries a mutation counter
 * (plus per-token `epoch(name)`), so the staleness trap item 1645 worried about has a sound answer
 * today. `dropVacuousLabels` reads the graph's label counts, so any mutation must invalidate; the
 * version compare is conservative and correct. A tighter key would be `epoch(label)`.
 *
 * `Plan` is `readonly`, so a shipped version of this needs a deliberate mutable cache field rather
 * than a cast — this probe only prices the shape.
 */
type Cached = Plan & { __eff?: { version: number; plan: Plan } };

/**
 * ⚠️ TWO SCALAR FIELDS, NO OBJECT. `effectiveField` below allocates `{ version, plan }` on every
 * MISS, and three rounds put that at +7 to +77 ns on the rebuilt arm — which is most of why the
 * on-plan cache did not remove the trade. Storing the version and the plan as two separate fields
 * allocates nothing on a miss, so a rebuilt plan should pay two property writes and nothing else.
 */
type Cached2 = Plan & { __effV?: number; __effP?: Plan };

/**
 * ⚠️⚠️ THE SOUND KEY NEEDS THE GRAPH'S IDENTITY, NOT JUST ITS VERSION — a hole in my own two-field
 * design, caught before it was built. `effectivePlan(plan, graphA)` followed by
 * `effectivePlan(plan, graphB)` HITS WRONGLY whenever both graphs happen to share a version, and two
 * freshly built graphs both start at the same one. `dropVacuousLabels` reads the graph's label
 * counts, so the cached plan would be the other graph's answer: a wrong answer, not a slow one.
 *
 * Three fields, still allocation-free on a miss.
 */
type Cached3 = Plan & { __eG?: Graph; __eV?: number; __eP?: Plan };

const effectiveField3 = (plan: Plan): Plan => {
  const p = plan as Cached3;

  if (p.__eG === g && p.__eV === g.version && p.__eP !== undefined) {
    return p.__eP;
  }

  const out1 = effectivePlan(plan, g, false);

  p.__eG = g;
  p.__eV = g.version;
  p.__eP = out1;

  return out1;
};

const effectiveField2 = (plan: Plan): Plan => {
  const p = plan as Cached2;

  if (p.__effV === g.version && p.__effP !== undefined) {
    return p.__effP;
  }

  const out1 = effectivePlan(plan, g, false);

  p.__effV = g.version;
  p.__effP = out1;

  return out1;
};

const effectiveField = (plan: Plan): Plan => {
  const p = plan as Cached;
  const hit = p.__eff;

  if (hit !== undefined && hit.version === g.version) {
    return hit.plan;
  }

  const out1 = effectivePlan(plan, g, false);

  p.__eff = { version: g.version, plan: out1 };

  return out1;
};

const reusedPlan = buildUnion();
const reusedFieldPlan = buildUnion();
const reusedField2Plan = buildUnion();
const reusedField3Plan = buildUnion();

const WORK: Record<string, () => unknown> = {
  'reused-nomemo': () => effectivePlan(reusedPlan, g, false),
  'reused-memo': () => effectiveMemo(reusedPlan),
  // ⚠️ A FRESH PLAN EVERY CALL, which is item 1503's refusal case: the memo never hits and still pays
  // the `set`. `buildUnion()` is inside the timed body on purpose — that IS the rebuilt case.
  'rebuilt-nomemo': () => effectivePlan(buildUnion(), g, false),
  'rebuilt-memo': () => effectiveMemo(buildUnion()),
  // The control: building alone, so the rebuilt arms can be read net of construction.
  'rebuilt-build-only': () => buildUnion(),
  'reused-field': () => effectiveField(reusedFieldPlan),
  'rebuilt-field': () => effectiveField(buildUnion()),
  'reused-field2': () => effectiveField2(reusedField2Plan),
  'rebuilt-field2': () => effectiveField2(buildUnion()),
  'reused-field3': () => effectiveField3(reusedField3Plan),
  'rebuilt-field3': () => effectiveField3(buildUnion()),
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
    nsPerCall: Number((warm[Math.floor(warm.length / 2)] ?? 0).toFixed(1)),
    min: Number(Math.min(...series).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
