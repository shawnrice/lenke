import { Graph } from '@lenke/core';

import {
  Scope,
  V,
  count,
  fold,
  has,
  limit,
  max,
  mean,
  min,
  order,
  range,
  sample,
  sum,
  tail,
  values,
} from './src/index.ts';
import { toArray } from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2483: the lenke half of the local-scope UNWRAPPING map. Every TinkerPop value in the
 * `TP` column came from `gremlin-console:3.7.3` on the modern graph, whose ages fold to
 * `[29, 27, 32, 35]`.
 */
const g = new Graph();
const ages = [29, 27, 32, 35];

for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
  g.addVertex({ id, labels: ['P'], properties: { age: ages[i], name: id } });
}

const four = () => traversal(V(), values('age'), fold());
const one = () => traversal(V(), has('name', 'a'), values('age'), fold());

const rows: Array<[string, () => unknown, string]> = [
  ['B1 fold(4)', () => four(), '[[29,27,32,35]]'],
  ['B2 fold(1)', () => one(), '[[29]]'],
  ['S1 tail(local,1)', () => traversal(V(), values('age'), fold(), tail(Scope.local, 1)), '[35]'],
  ['S2 limit(local,1)', () => traversal(V(), values('age'), fold(), limit(Scope.local, 1)), '[29]'],
  [
    'S3 range(local,0,1)',
    () => traversal(V(), values('age'), fold(), range(Scope.local, 0, 1)),
    '[29]',
  ],
  [
    'S4 range(local,2,3)',
    () => traversal(V(), values('age'), fold(), range(Scope.local, 2, 3)),
    '[32]',
  ],
  // S5 `sample(Scope.local, 1)`: `sample(n: number)` has NO scope overload either, so the row below
  // is the GLOBAL sample, which is a different question. Kept, labelled, and counted as a DIFFER so
  // the gap stays visible rather than reading as an unwrapping difference.
  ['S5 sample(1) [GLOBAL ONLY]', () => traversal(V(), values('age'), fold(), sample(1)), '[[32]]'],
  [
    'T1 tail(local,2)',
    () => traversal(V(), values('age'), fold(), tail(Scope.local, 2)),
    '[[32,35]]',
  ],
  [
    'T2 limit(local,2)',
    () => traversal(V(), values('age'), fold(), limit(Scope.local, 2)),
    '[[29,27]]',
  ],
  [
    'T3 range(local,1,3)',
    () => traversal(V(), values('age'), fold(), range(Scope.local, 1, 3)),
    '[[27,32]]',
  ],
  [
    'U1 tail(local,1) on 1',
    () => traversal(V(), has('name', 'a'), values('age'), fold(), tail(Scope.local, 1)),
    '[29]',
  ],
  [
    'U2 limit(local,2) on 1',
    () => traversal(V(), has('name', 'a'), values('age'), fold(), limit(Scope.local, 2)),
    '[[29]]',
  ],
  [
    'U3 order(local) on 1',
    () => traversal(V(), has('name', 'a'), values('age'), fold(), order(Scope.local)),
    '[[29]]',
  ],
  // U4/W2 REMOVED: `dedupe(...labels: string[])` has NO scope overload, so `dedupe(Scope.local)`
  // passed a SYMBOL as a property key. Both rows printed "agree" — falsely, because the four ages
  // are already distinct, so a non-dedupe and a real local dedupe give the same list. `bun run
  // check` caught it (`TS2345: Argument of type 'symbol' is not assignable to parameter of type
  // 'string'`) where the probe's own comparison column did not. See `MISSING` below.
  [
    'W1 order(local)',
    () => traversal(V(), values('age'), fold(), order(Scope.local)),
    '[[27,29,32,35]]',
  ],

  ['A1 count(local)', () => traversal(V(), values('age'), fold(), count(Scope.local)), '[4]'],
  ['A2 sum(local)', () => traversal(V(), values('age'), fold(), sum(Scope.local)), '[123]'],
  ['A3 min(local)', () => traversal(V(), values('age'), fold(), min(Scope.local)), '[27]'],
  ['A4 max(local)', () => traversal(V(), values('age'), fold(), max(Scope.local)), '[35]'],
  ['A5 mean(local)', () => traversal(V(), values('age'), fold(), mean(Scope.local)), '[30.75]'],
  ['E1 limit(local,0)', () => traversal(V(), values('age'), fold(), limit(Scope.local, 0)), '[[]]'],
  [
    'E2 range(local,9,10)',
    () => traversal(V(), values('age'), fold(), range(Scope.local, 9, 10)),
    '[]',
  ],
];

let agree = 0;
let differ = 0;

for (const [label, build, tp] of rows) {
  let got: string;

  try {
    got = JSON.stringify(toArray(build() as never, g));
  } catch (e) {
    got = `ERR ${String((e as Error)?.message ?? e).slice(0, 40)}`;
  }

  const same = got.replaceAll(' ', '') === tp.replaceAll(' ', '');

  if (same) {
    agree += 1;
  } else {
    differ += 1;
  }

  console.log(
    `  ${label.padEnd(24)} lenke=${got.padEnd(18)} TP=${tp.padEnd(18)} ${same ? 'agree' : 'DIFFER'}`,
  );
}

console.log(`\n  ${agree} agree, ${differ} DIFFER, of ${rows.length} cases`);
