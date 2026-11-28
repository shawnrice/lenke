import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import {
  V,
  between,
  eq,
  gt,
  has,
  hasNot,
  inside,
  is,
  lte,
  neq,
  not,
  outside,
  values,
  within,
  without,
} from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2489: how far does item 2488's missing-key defect reach?
 *
 * 2488 found `has(k, neq(v))` including elements that LACK `k`, where TinkerPop excludes them. The
 * obvious worry was that the same lowering had been applied to every negation and to the ordering
 * predicates, where 3VL also applies. **It has not.** The leak is exactly `neq` and `without`.
 *
 * THE CONTRAST THAT MAKES IT A CONFLATION, not merely a wrong answer — TinkerPop 3.7.3:
 *
 *     has('age', neq(29))        -> [vadas, josh, peter]              3 rows, KEY REQUIRED
 *     not(has('age', 29))        -> [vadas, lop, josh, ripple, peter] 5 rows, absence ADMITTED
 *
 * TinkerPop has BOTH and they mean different things. lenke's `has(k, neq(v))` returns the 5, i.e.
 * the same answer as its own `not(has(k, eq(v)))` — which agrees with TinkerPop. So lenke cannot
 * currently express TinkerPop's `has(k, neq(v))` at all, and anyone who wants today's behaviour
 * already has a spelling that will keep working. That makes the fix lower-risk than item 2488
 * assumed.
 *
 * The fixture is the modern graph because its properties are SPARSE — only four of six vertices have
 * `age` — which is the only reason any of this is visible (item 2483).
 */
const g = createTestTinkerGraph();

const canonical = (rowsOut: readonly unknown[]): string =>
  rowsOut.map(String).sort().join(',') || '(empty)';

const rows: Array<[string, () => unknown, string]> = [
  ['M01 hasNot(age)', () => traversal(V(), hasNot('age'), values('name')), 'lop,ripple'],
  [
    'M02 has(age,neq 29)',
    () => traversal(V(), has('age', neq(29)), values('name')),
    'josh,peter,vadas',
  ],
  [
    'M03 not(has(age,eq 29))',
    () => traversal(V(), not(traversal(has('age', eq(29)))), values('name')),
    'josh,lop,peter,ripple,vadas',
  ],
  ['M04 has(age,gt 29)', () => traversal(V(), has('age', gt(29)), values('name')), 'josh,peter'],
  ['M05 has(age,lte 29)', () => traversal(V(), has('age', lte(29)), values('name')), 'marko,vadas'],
  [
    'M06 has(age,inside 26,33)',
    () => traversal(V(), has('age', inside(26, 33)), values('name')),
    'josh,marko,vadas',
  ],
  [
    'M07 has(age,outside 26,33)',
    () => traversal(V(), has('age', outside(26, 33)), values('name')),
    'peter',
  ],
  [
    'M08 has(age,between 27,33)',
    () => traversal(V(), has('age', between(27, 33)), values('name')),
    'josh,marko,vadas',
  ],
  ['M09 values(age).is(neq 29)', () => traversal(V(), values('age'), is(neq(29))), '27,32,35'],
  [
    'M15 has(age,within 29,32)',
    () => traversal(V(), has('age', within(29, 32)), values('name')),
    'josh,marko',
  ],
  [
    'M16 has(age,without 29,32)',
    () => traversal(V(), has('age', without(29, 32)), values('name')),
    'peter,vadas',
  ],
];

let agreed = 0;
let disagreed = 0;

for (const [label, build, tp] of rows) {
  let got: string;

  try {
    got = canonical([...run(build() as never, g)]);
  } catch (e) {
    got = `THROWS: ${String((e as Error)?.message ?? e).slice(0, 26)}`;
  }

  const verdict = got === tp ? 'agree' : 'DIFFER';

  if (verdict === 'agree') {
    agreed += 1;
  } else {
    disagreed += 1;
  }

  console.log(`  ${label.padEnd(28)} ${verdict.padEnd(6)} lenke=${got.padEnd(30)} TP=${tp}`);
}

console.log(`\n  ${agreed} agree, ${disagreed} DIFFER, of ${rows.length}`);
console.log('  The two DIFFER rows are `neq` and `without` inside has(); every ORDERING predicate');
console.log('  agrees, and `not(has(k, eq(v)))` already gives the TinkerPop answer for absence.');
