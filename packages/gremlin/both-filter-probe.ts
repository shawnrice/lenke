/**
 * ONE SHAPE PER PROCESS: the FILTERED `both()` count, which `countShortcut` declines (item 1087).
 *
 * `filteredHopCount` opens with `if (hop.kind !== 'out' && hop.kind !== 'in') return undefined;`
 * and the comment "`both` double-counts a self-loop; see `vertexStepCount`". **TinkerPop 3.7.3 was
 * asked rather than assumed, and that double-count is the CORRECT answer** — on three `T` edges
 * including a self-loop on a `P` vertex:
 *
 *   out 3   in 3   both 6   bothE 6   both.has(k,gt(0)) 6   both.has(k,eq(1)) 3
 *   hasLabel(P).both 5      hasLabel(P).both.has(k,eq(1)) 3
 *
 * lenke answers all eight identically, and so does the forced-`identity()` decline. So `both` is
 * `out + in` EXACTLY, self-loop included twice, filter and all — which makes the shortcut's sum
 * exact with no correction, the opposite of the GQL side where item 1086 needed one (ISO's
 * `-[:T]-` emits a loop ONCE).
 *
 *   cd packages/gremlin && SHAPE=both bun both-filter-probe.ts
 */
import { Graph } from '@lenke/core';

import {
  V,
  both,
  count,
  gt,
  has,
  hasLabel,
  identity,
  in_,
  out,
  toArray,
  traversal,
} from './src/index.ts';

const N = Number(process.env.BF_N ?? 200_000);
const REPS = Number(process.env.BF_REPS ?? 14);

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 90 } }),
);

/** Never `i`, so the fixture's self-loop count is exactly zero — item 1075's third correction. */
const target = (i: number, d: number): number => {
  const t = (i * 7919 + d * 104_729) % N;

  return t === i ? (i + 1) % N : t;
};

let e = 0;

for (let i = 0; i < N; i++) {
  for (let d = 0; d < 3; d++) {
    g.addEdge({
      id: `e${e++}`,
      labels: ['T'],
      from: vs[i],
      to: vs[target(i, d)],
      properties: { w: 1 },
    });
  }
}

const n = (...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

const SHAPES: Record<string, { run: () => number; reached: boolean }> = {
  // SUBJECT: the filtered `both` hop, which declines today.
  both: { run: () => n(V(), both('T'), has('k', gt(60)), count()), reached: true },
  'both-labelled': {
    run: () => n(V(), hasLabel('P'), both('T'), has('k', gt(60)), count()),
    reached: true,
  },
  // CONTROLS. `out` and `in` already take the rung, so neither may move.
  out: { run: () => n(V(), out('T'), has('k', gt(60)), count()), reached: false },
  in: { run: () => n(V(), in_('T'), has('k', gt(60)), count()), reached: false },
  // The forced DECLINE of the subject — `identity()` is a step the rung cannot absorb, which is
  // this suite's own oracle idiom (and item 930's warning against forcing a decline with a shape
  // the optimizer may one day learn). It must NOT move: it is the route the subject leaves.
  'both-declined': {
    run: () => n(V(), both('T'), identity(), has('k', gt(60)), count()),
    reached: false,
  },
  // The unfiltered `both` count, answered by `vertexStepCount`'s own route.
  'both-bare': { run: () => n(V(), both('T'), count()), reached: false },
};

const name = process.env.SHAPE ?? 'both';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  answer = shape.run();
  series.push(performance.now() - t0);
}

// EVERY ARM ASSERTS ITS ANSWER against the forced decline — item 1074's probe read 3-10x faster
// while answering 0, so a time with no oracle beside it is not evidence.
const oracle = n(V(), both('T'), identity(), has('k', gt(60)), count());
const want = name.startsWith('both') && name !== 'both-bare' ? oracle : answer;

if (answer !== want) {
  console.error(`WRONG ANSWER: ${name} gave ${answer}, the forced decline gives ${want}`);
  process.exit(1);
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`answer=${answer}`);
console.log(
  `${name.padEnd(16)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
