import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import { Scope, V, count, fold, limit, order, range, sample, tail, values } from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2487: the CARDINALITY half of item 2483's findings — the one of its four that had no
 * explanation. 2483 saw a single instance (`range(local,9,10)` yields `[]` in TinkerPop and `[[]]`
 * here) and could not say whether it generalized.
 *
 * It does, and the rule is NOT "the result is empty". TinkerPop 3.7.3 on the modern graph
 * (`[29, 27, 32, 35]`):
 *
 *     KEPT  [[]]                        DROPPED  []
 *       limit(local, 0)                   range(local, 9, 10)
 *       tail(local, 0)                    range(local, 4, 5)
 *       sample(local, 0)                  empty fold + limit(local, 1)
 *       range(local, 0, 0)                empty fold + tail(local, 1)
 *       range(local, 2, 2)                empty fold + range(local, 0, 1)
 *       empty fold (no slicing)
 *       empty fold + order(local)
 *
 * `range(local,2,2)` and `range(local,4,5)` BOTH yield an empty list, and only the second drops the
 * row. The discriminator is whether the window's START is at or beyond the list's length: slicing
 * NOTHING keeps the row, having NOTHING TO SLICE FROM drops it. Aggregates never drop —
 * `count(local)` on an empty fold is `[0]`.
 *
 * Compared as a MULTISET with per-level sorting (item 2486), and no row carries a stream-level
 * `limit` (a window over an unordered set cannot be compared).
 */
const g = createTestTinkerGraph();

const canon1 = (x: unknown): string => {
  if (Array.isArray(x)) {
    return `[${x.map(canon1).sort().join(',')}]`;
  }

  return String(x);
};
const canonical = (rowsOut: readonly unknown[]): string =>
  `${rowsOut.length}:${rowsOut.map(canon1).sort().join('|')}`;

const four = () => [V(), values('age'), fold()] as const;
const empty = () => [V(), values('nosuch'), fold()] as const;

const rows: Array<[string, () => unknown, string]> = [
  ['E00 fold', () => traversal(...four()), '1:[27,29,32,35]'],
  ['E01 limit(local,0)', () => traversal(...four(), limit(Scope.local, 0)), '1:[]'],
  ['E02 tail(local,0)', () => traversal(...four(), tail(Scope.local, 0)), '1:[]'],
  ['E03 range(local,9,10)', () => traversal(...four(), range(Scope.local, 9, 10)), '0:'],
  ['E04 range(local,0,0)', () => traversal(...four(), range(Scope.local, 0, 0)), '1:[]'],
  ['E05 range(local,2,2)', () => traversal(...four(), range(Scope.local, 2, 2)), '1:[]'],
  ['E06 range(local,4,5)', () => traversal(...four(), range(Scope.local, 4, 5)), '0:'],
  // `sample` has NO local-scope overload here (item 2483), so this is the GLOBAL sample — a known
  // gap, kept in the table so it reads as missing API rather than as a cardinality difference.
  ['E07 sample(0) [GLOBAL]', () => traversal(...four(), sample(0)), '1:[]'],
  ['E08 empty fold', () => traversal(...empty()), '1:[]'],
  ['E09 empty + limit(local,1)', () => traversal(...empty(), limit(Scope.local, 1)), '0:'],
  ['E10 empty + tail(local,1)', () => traversal(...empty(), tail(Scope.local, 1)), '0:'],
  ['E11 empty + range(local,0,1)', () => traversal(...empty(), range(Scope.local, 0, 1)), '0:'],
  ['E12 empty + order(local)', () => traversal(...empty(), order(Scope.local)), '1:[]'],
  ['E13 empty + count(local)', () => traversal(...empty(), count(Scope.local)), '1:0'],
  ['E14 range(local,3,99)', () => traversal(...four(), range(Scope.local, 3, 99)), '1:[35]'],
];

let agreed = 0;
let disagreed = 0;

for (const [label, build, tp] of rows) {
  let canon: string;

  try {
    canon = canonical([...run(build() as never, g)]);
  } catch (e) {
    canon = `THROWS: ${String((e as Error)?.message ?? e).slice(0, 30)}`;
  }

  const verdict = canon === tp ? 'agree' : 'DIFFER';

  if (verdict === 'agree') {
    agreed += 1;
  } else {
    disagreed += 1;
  }

  console.log(
    `  ${label.padEnd(30)} ${verdict.padEnd(6)} lenke=${canon.padEnd(20)} TP=${tp.padEnd(18)}`,
  );
}

console.log(`\n  ${agreed} agree, ${disagreed} DIFFER, of ${rows.length}`);
console.log(
  '  (the leading number in each value is the ROW COUNT — that is the quantity at issue)',
);
