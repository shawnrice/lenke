import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import {
  V,
  containing,
  endingWith,
  has,
  notContaining,
  regex,
  startsWith,
  values,
} from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2488: the text-predicate family against TinkerPop's SIGNATURE LIST (the oracle from item
 * 2484, validated at 2485 and 2486).
 *
 * TinkerPop has EIGHT: `TextP.containing`, `notContaining`, `startingWith`, `notStartingWith`,
 * `endingWith`, `notEndingWith`, `regex`, `notRegex`. lenke exports them as TOP-LEVEL predicates
 * rather than a `TextP` namespace (the same shape difference as `P`, item 2486) and has only FOUR
 * plus `matches`: `containing`, `notContaining`, `startsWith`, `endingWith`, `regex`.
 *
 * So three are missing outright, and the naming is inconsistent WITHIN lenke — `startsWith` is
 * JS-style where `endingWith` is TinkerPop-style.
 *
 * THE ROW THAT MATTERS IS THE MISSING KEY. TinkerPop's `has('lang', notContaining('av'))` is `[]`:
 * a vertex LACKING the key does not satisfy a NEGATED text predicate. A naive `!contains`
 * implementation would include the four vertices with no `lang` at all, which is why the fixture has
 * to be a graph where only some vertices carry the key (item 2483's rule that an arm whose expected
 * value coincides with the control's is not evidence).
 *
 * Compared as a MULTISET with per-level sorting, and the row COUNT is reported because the
 * missing-key rows are a cardinality question (items 2486, 2487).
 */
const g = createTestTinkerGraph();

const canonical = (rowsOut: readonly unknown[]): string =>
  `${rowsOut.length}:${rowsOut.map(String).sort().join(',')}`;

const rows: Array<[string, () => unknown, string]> = [
  [
    'P01 containing(o)',
    () => traversal(V(), has('name', containing('o')), values('name')),
    '3:josh,lop,marko',
  ],
  [
    'P02 notContaining(o)',
    () => traversal(V(), has('name', notContaining('o')), values('name')),
    '3:peter,ripple,vadas',
  ],
  [
    'P03 startsWith(m)',
    () => traversal(V(), has('name', startsWith('m')), values('name')),
    '1:marko',
  ],
  [
    'P05 endingWith(o)',
    () => traversal(V(), has('name', endingWith('o')), values('name')),
    '1:marko',
  ],
  ['P07 regex(^j.*)', () => traversal(V(), has('name', regex('^j.*')), values('name')), '1:josh'],
  [
    'P09 containing("")',
    () => traversal(V(), has('name', containing('')), values('name')),
    '6:josh,lop,marko,peter,ripple,vadas',
  ],
  [
    'P10 startsWith("")',
    () => traversal(V(), has('name', startsWith('')), values('name')),
    '6:josh,lop,marko,peter,ripple,vadas',
  ],
  [
    'P11 MISSING key containing',
    () => traversal(V(), has('lang', containing('av')), values('name')),
    '2:lop,ripple',
  ],
  [
    'P12 MISSING key notContaining',
    () => traversal(V(), has('lang', notContaining('av')), values('name')),
    '0:',
  ],
  [
    'P13 CASE containing(M)',
    () => traversal(V(), has('name', containing('M')), values('name')),
    '0:',
  ],
  [
    'P14 notContaining("")',
    () => traversal(V(), has('name', notContaining('')), values('name')),
    '0:',
  ],
];

/* The three TinkerPop predicates with no lenke export at all — asserted as ABSENT, not skipped. */
const MISSING = ['notStartingWith', 'notEndingWith', 'notRegex'] as const;

let agreed = 0;
let disagreed = 0;

for (const [label, build, tp] of rows) {
  let canon: string;

  try {
    canon = canonical([...run(build() as never, g)]);
  } catch (e) {
    canon = `THROWS: ${String((e as Error)?.message ?? e).slice(0, 28)}`;
  }

  const verdict = canon === tp ? 'agree' : 'DIFFER';

  if (verdict === 'agree') {
    agreed += 1;
  } else {
    disagreed += 1;
  }

  console.log(
    `  ${label.padEnd(30)} ${verdict.padEnd(6)} lenke=${canon.padEnd(36)} TP=${tp.padEnd(30)}`,
  );
}

console.log(`\n  ${agreed} agree, ${disagreed} DIFFER, of ${rows.length} expressible rows`);
console.log(`  MISSING from lenke entirely (TinkerPop has all three): ${MISSING.join(', ')}`);
console.log(
  '  NAMING: lenke `startsWith` where TinkerPop is `startingWith`, but `endingWith` matches.',
);
