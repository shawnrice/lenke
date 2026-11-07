/**
 * WHERE DOES A REUSED `union(out(T), in_(T)).count()` CALL SPEND ITS ~530 ns? One purpose per
 * process, built for item 1647.
 *
 * ⚠️ WHY IT EXISTS. Item 1647 cached `effectivePlan`'s graph-free prefix and measured the chain
 * itself going **167 -> 24 ns** on exactly this plan (`plan-memo-trade-probe.ts`). The Gremlin
 * spelling probe, whose `union(out, in)` arm reuses its plan and should therefore collect that
 * 140 ns, did NOT move: 524-547 ns POST against 505-601 PRE. Both readings cannot be right about
 * the same call, so this instrument asks the call itself rather than a group ratio.
 *
 *     ARM=full bun union-both-call-floor.ts        # toArray(plan, graph), the whole call
 *     ARM=eff  bun union-both-call-floor.ts        # effectivePlan alone, on the same plan
 *     ARM=rest bun union-both-call-floor.ts        # toArray of the ALREADY-rewritten plan
 *
 * `rest` is the control that decides it: if `full - rest` is ~24 ns the cache is being collected and
 * the residual is elsewhere; if it is ~160 ns the cache is not reached on this path at all.
 *
 * ONE ARM PER PROCESS (item 762), and per item 1640 do not compare these numbers with another
 * file's.
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { V, both, count, in_, out, union } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { traversal } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { effectivePlan, toArray } from '../gremlin/src/executor/index.js';
import { assertBranching } from './src/fixture-branching.js';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 12);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'full';

const ARMS = ['full', 'eff', 'rest', 'both-full', 'rebuilt-full', 'build-only'];

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

assertBranching('union-both-call-floor', NODES, FANOUT, endpoints);

const unionPlan: Plan = traversal(V(), union(out('T'), in_('T')), count());
const bothPlan: Plan = traversal(V(), both('T'), count());
/** What `effectivePlan` turns the union spelling into — run directly, so no rewrite is needed. */
const rewrittenPlan: Plan = effectivePlan(unionPlan, g, false);

/**
 * ⚠️ THE OTHER ARM OF ITEM 1648'S TRADE. Gremlin has no parameter binding (item 1577), so a
 * caller whose value varies REBUILDS the plan every call and never collects a per-plan memo — it
 * pays the static checks every time plus one slot write. `build-only` is the control the change
 * cannot reach at all: construction with no `run`.
 */
const buildUnion = (): Plan => traversal(V(), union(out('T'), in_('T')), count());

const WORK: Record<string, () => unknown> = {
  full: () => toArray(unionPlan, g),
  'rebuilt-full': () => toArray(buildUnion(), g),
  'build-only': () => buildUnion(),
  eff: () => effectivePlan(unionPlan, g, false),
  rest: () => toArray(rewrittenPlan, g),
  'both-full': () => toArray(bothPlan, g),
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
    answer: ARM === 'eff' ? 'n/a' : JSON.stringify(work()),
    nsPerCall: Number((warm[Math.floor(warm.length / 2)] ?? 0).toFixed(1)),
    min: Number(Math.min(...series).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
