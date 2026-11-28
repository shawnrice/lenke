import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import {
  Column,
  Order,
  Pop,
  T,
  V,
  as_,
  group,
  has,
  in_,
  limit,
  neq,
  out,
  select,
  unfold,
  values,
  where,
} from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2486: the `select` family against TinkerPop's SIGNATURE LIST — the oracle item 2484
 * identified and item 2485 validated on `by()` (15/15, a clean null).
 *
 * `select` is the family where `Pop` lives, and `Pop` only MEANS anything when a label is bound more
 * than once, so every Pop row below binds `a` TWICE (`as('a').out().as('a')`). A fixture that bound
 * it once would make `Pop.first`, `Pop.last` and a bare `select('a')` all agree and prove nothing —
 * item 2483's lesson that an arm whose expected value coincides with the control's is not evidence.
 *
 * `P` IS NOT A NAMESPACE HERE. TinkerPop spells predicates `P.neq('b')`; lenke exports them as
 * top-level functions (`neq`, `eq`, `within`, `between`, …), so the form is `where('a', neq('b'))`.
 * Same expressiveness, different surface — not a gap, and noted because the probe's first draft
 * imported a `P` that does not exist.
 *
 * NOTHING IS `JSON.stringify`d: `canon1` below walks the result itself. Item 2485 lost a run to
 * `JSON.stringify(new Map(...))` being `{}`, and this probe lost two more to a hand-rolled
 * flattener — `select(a, b)` returns a PLAIN OBJECT here, not a `Map`, so a Map/Array/else branch
 * printed `[object Object]` on three rows.
 */
const g = createTestTinkerGraph();

/** `a` bound TWICE — the only shape in which Pop is observable. */
const twice = () => [V(), has('name', 'marko'), as_('a'), out(), as_('a')] as const;

const rows: Array<[string, () => unknown, string]> = [
  [
    'S01 select(a)',
    () => traversal(V(), has('name', 'marko'), as_('a'), out(), select('a'), values('name')),
    'marko|marko|marko',
  ],
  [
    'S02 select(a,b)',
    () =>
      traversal(V(), has('name', 'marko'), as_('a'), out(), as_('b'), select('a', 'b').by('name')),
    'a=marko,b=josh|a=marko,b=lop|a=marko,b=vadas',
  ],
  [
    'S03 select(Pop.first,a)',
    () => traversal(...twice(), select(Pop.first, 'a'), values('name')),
    'marko|marko|marko',
  ],
  [
    'S04 select(Pop.last,a)',
    () => traversal(...twice(), select(Pop.last, 'a'), values('name')),
    'josh|lop|vadas',
  ],
  [
    'S05 select(Pop.all,a)',
    () => traversal(...twice(), select(Pop.all, 'a')),
    'josh,marko|lop,marko|marko,vadas',
  ],
  [
    'S06 select(Pop.all,a) unfold',
    () => traversal(...twice(), select(Pop.all, 'a'), unfold(), values('name')),
    'josh|lop|marko|marko|marko|vadas',
  ],
  [
    'S07 select(Column.keys)',
    () => traversal(V(), group().by(T.label).by('name'), select(Column.keys)),
    'PERSON,SOFTWARE',
  ],
  [
    'S08 select(Column.values)',
    () => traversal(V(), group().by(T.label).by('name'), select(Column.values)),
    'josh,marko,peter,vadas,lop,ripple',
  ],
  [
    // `limit(2)` was here and had to go: a WINDOW over an unordered 5-row set picks a different
    // two in each engine, so the row could never agree by construction. Compared in full instead.
    'S09 select(a,b,c) full',
    () =>
      traversal(
        V(),
        has('name', 'marko'),
        as_('a'),
        out(),
        as_('b'),
        in_(),
        as_('c'),
        select('a', 'b', 'c').by('name'),
      ),
    'a=marko,b=josh,c=marko|a=marko,b=lop,c=josh|a=marko,b=lop,c=marko|a=marko,b=lop,c=peter|a=marko,b=vadas,c=marko',
  ],
  [
    'S10 select(a).by(trav)',
    () =>
      traversal(
        V(),
        has('name', 'marko'),
        as_('a'),
        out(),
        select('a').by(traversal(values('age'))),
      ),
    '29|29|29',
  ],
  [
    'S11 select(Pop.first,a,b)',
    () =>
      traversal(
        V(),
        has('name', 'marko'),
        as_('a'),
        out(),
        as_('b'),
        select(Pop.first, 'a', 'b').by('name'),
      ),
    'a=marko,b=josh|a=marko,b=lop|a=marko,b=vadas',
  ],
  ['S12 select(UNBOUND label)', () => traversal(V(), has('name', 'marko'), select('zz')), ''],
  [
    'S14 where(a, neq(b))',
    () =>
      traversal(
        V(),
        as_('a'),
        out(),
        as_('b'),
        where('a', neq('b')),
        select('a', 'b').by('name'),
        limit(2),
      ),
    'ANY2',
  ],
];

/*
 * CANONICAL MULTISET FORM, and it took three attempts — every failure was this function, not the
 * engine (the fifth instrument-at-fault this session).
 *
 *   1. `JSON.stringify` alone: `select(a,b)` renders as `{}`-ish and Maps vanish entirely (2485).
 *   2. A Map/Array/else branch: `select(a,b)` printed `[object Object]` on THREE rows, because it
 *      returns a PLAIN OBJECT here, not a `Map` — so neither branch matched.
 *   3. Inner arrays sorted on the lenke side only, so `select(Pop.all,'a')` and
 *      `select(Column.values)` "differed" against expectations I had written unsorted.
 *
 * So: recurse, sort at EVERY level, and write the expectations in the same form. Order is not
 * contracted here (decided 2026-11-22), so a multiset is the only comparison that can be a
 * regression guard rather than a permanent false failure.
 */
const canon1 = (x: unknown): string => {
  if (x instanceof Map) {
    return [...x.entries()]
      .map(([k, v]) => `${String(k)}=${canon1(v)}`)
      .sort()
      .join(',');
  }

  if (Array.isArray(x)) {
    return x.map(canon1).sort().join(',');
  }

  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;

    if ('properties' in o) {
      const nm = (o.properties as Record<string, unknown> | undefined)?.name;

      return typeof nm === 'string' || typeof nm === 'number' ? String(nm) : '?';
    }

    return Object.entries(o)
      .map(([k, v]) => `${k}=${canon1(v)}`)
      .sort()
      .join(',');
  }

  return String(x);
};
const canonical = (rowsOut: readonly unknown[]): string => rowsOut.map(canon1).sort().join('|');

let expressed = 0;
let rejected = 0;
let agreed = 0;
let disagreed = 0;

for (const [label, build, tp] of rows) {
  let canon = '';
  let count = 0;

  try {
    const raw = [...run(build() as never, g)];

    count = raw.length;
    canon = canonical(raw);
  } catch (e) {
    rejected += 1;
    console.log(
      `  ${label.padEnd(28)} CANNOT EXPRESS / THROWS: ${String((e as Error)?.message ?? e).slice(0, 44)}`,
    );
    continue;
  }

  expressed += 1;

  /*
   * COMPARED AS A MULTISET, deliberately. Every lenke row below holds the same VALUES as TinkerPop
   * and several hold them in a different ORDER (`Pop.last` is `[vadas,josh,lop]` here against
   * `[lop,vadas,josh]` there; `Column.keys` is `[PERSON,SOFTWARE]` against `[SOFTWARE,PERSON]`).
   * This repo does not contract walk order — how a traversal visits elements is
   * implementation-dependent (decided 2026-11-22) — so an order-sensitive comparison here would
   * report a permanent false failure and the probe would be useless as a regression guard.
   */
  // `ANY2` is a CARDINALITY expectation, for a row where only the count is comparable.
  let verdict: string;

  if (tp === 'ANY2') {
    verdict = count === 2 ? 'agree' : 'DIFFER';
  } else {
    verdict = canon === tp ? 'agree' : 'DIFFER';
  }

  if (verdict === 'agree') {
    agreed += 1;
  } else {
    disagreed += 1;
  }

  console.log(
    `  ${label.padEnd(28)} ${verdict.padEnd(6)} lenke=${canon.slice(0, 46).padEnd(46)} TP=${tp.slice(0, 30)}`,
  );
}

console.log(
  `\n  ${expressed} expressed, ${rejected} CANNOT EXPRESS, of ${rows.length} — ` +
    `${agreed} agree, ${disagreed} DIFFER (as multisets)`,
);
console.log(`  (Order export present for parity with the by() probe: ${typeof Order})`);
