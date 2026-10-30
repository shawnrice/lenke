import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

// `WHERE n.v IS TYPED INTEGER` now lifts into `typedTests` (item 1298) — the last structurally
// liftable leaf of the enum item 1272 listed, priced at item 1297.
//
// 200,000 nodes against `n.marker = true`, a `compare` marking exactly the rows the test keeps, so
// every arm answers 100000. Min of three alternated rounds, one shape per process:
//
//     IS TYPED INTEGER         9.128 ms -> 3.814    2.40x
//     IS NOT TYPED INTEGER     8.678    -> 4.385    1.98x
//     [CTL] n.marker = true    4.199    -> 4.083    flat
//
// Both spellings now land ON the matched twin, which is the property that matters here.
//
// ⚠️ IT RUNS IN THE **LATE** GROUP, after `truthProps`, despite being total and non-raising. The
// engine is the authority (item 1286) and it hoists NO form of this test — measured at item 1297
// with `n.s` as the faulting sibling, including the cases whose tail is FALSE for every row:
//
//     WHERE n.s AND n.n IS TYPED STRING     native ERR
//     WHERE n.s AND n.s IS TYPED INTEGER    native ERR
//
// So "non-raising implies hoistable" is not a rule in this engine, and `typedTests` sits beside
// `truthTestProps` rather than with `nulls`/`member`/`labelTests`.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'int', labels: ['P'], properties: { nm: 'int', v: 7 } });
  g.addVertex({ id: 'frac', labels: ['P'], properties: { nm: 'frac', v: 1.5 } });
  g.addVertex({ id: 'str', labels: ['P'], properties: { nm: 'str', v: 'x' } });
  g.addVertex({ id: 'bool', labels: ['P'], properties: { nm: 'bool', v: true } });
  // A STORED NULL and an ABSENT key: `valueIsTypedTy` reads both as nullish and answers
  // `!notNull`, so they are kept by a bare `IS TYPED T` and dropped by `IS TYPED T NOT NULL`.
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { nm: 'nulled', v: null } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { nm: 'absent' } });

  return g;
};

const g = build();
const ids = (where: string): string[] =>
  query(g, `MATCH (n:P) WHERE ${where} RETURN n.nm AS nm`)
    .map((r) => String(r.nm))
    .sort();

describe('IS TYPED lifts into typedTests (item 1298)', () => {
  test('⚠️ ROUTE: every spelling lifts, and hasPredicate sees it', () => {
    const lifted = (src: string) => compilePredicate(undefined, parsePredicate(src), 'n');
    const pos = lifted('n.v IS TYPED INTEGER');

    expect((pos.typedTests ?? []).length).toBe(1);
    expect(pos.typedTests?.[0].negated).toBe(false);
    expect(pos.where).toBeUndefined();
    // ⚠️ Item 1289's `haspredicate-blind` mutant SURVIVED all 4,200 tests until an explicit
    // assertion existed, because no query in that file reached a gate consulting `hasPredicate`.
    expect(hasPredicate(pos)).toBe(true);

    const neg = lifted('n.v IS NOT TYPED INTEGER');

    expect(neg.typedTests?.[0].negated).toBe(true);
    expect(hasPredicate(neg)).toBe(true);

    // The `NOT (…)` spelling folds into the flag rather than a second list.
    const notted = lifted('NOT (n.v IS TYPED INTEGER)');

    expect(notted.typedTests?.[0].negated).toBe(true);

    // Another variable, and a non-property subject, both decline.
    expect(lifted('m.v IS TYPED INTEGER').typedTests).toBeUndefined();
    expect(lifted('upper(n.s) IS TYPED STRING').typedTests).toBeUndefined();
  });

  test('the answers filter, and NOT NULL is carried', () => {
    // `7` is an INTEGER; `1.5` is not. A carrier that dropped `ty` would keep both.
    expect(ids('n.v IS TYPED INTEGER')).toEqual(['absent', 'int', 'nulled']);
    // ⚠️ A NULLISH cell answers `!notNull`, so the bare form KEEPS it and `NOT NULL` drops it.
    // A carrier that dropped `notNull` would answer the same for both spellings.
    expect(ids('n.v IS TYPED INTEGER NOT NULL')).toEqual(['int']);
    expect(ids('n.v IS TYPED STRING NOT NULL')).toEqual(['str']);
    expect(ids('n.v IS TYPED BOOLEAN NOT NULL')).toEqual(['bool']);
  });

  test('the negated spellings are the complements', () => {
    expect(ids('n.v IS NOT TYPED INTEGER')).toEqual(['bool', 'frac', 'str']);
    expect(ids('NOT (n.v IS TYPED INTEGER)')).toEqual(['bool', 'frac', 'str']);
  });

  test('the lifted answer equals the GENERIC answer, spelling by spelling', () => {
    for (const where of [
      'n.v IS TYPED INTEGER',
      'n.v IS NOT TYPED INTEGER',
      'n.v IS TYPED INTEGER NOT NULL',
      'n.v IS TYPED STRING',
      'NOT (n.v IS TYPED BOOLEAN)',
    ]) {
      const direct = compilePredicate(undefined, parsePredicate(where), 'n');
      const generic = compilePredicate(undefined, parsePredicate(where), undefined);

      // One lifts and the other cannot, or the oracle compares a route with itself.
      expect((direct.typedTests ?? []).length).toBeGreaterThan(0);
      expect(generic.typedTests).toBeUndefined();

      const viaCount = Number(query(g, `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)[0].c);

      expect(viaCount).toBe(ids(where).length);
    }
  });

  test('beside the other lifted families the chain is complete', () => {
    // A family dropped from a chain returns a SUPERSET — `hasPredicate`'s recorded failure.
    expect(ids("n.v IS TYPED INTEGER AND n.nm = 'int'")).toEqual(['int']);
    expect(ids("n.v IS TYPED INTEGER AND n.nm = 'str'")).toEqual([]);
    expect(ids('n.v IS TYPED INTEGER AND n.v IS NOT NULL')).toEqual(['int']);
  });

  test('⚠️ it survives a HOP, and the far-end MERGE must carry it', () => {
    // The INLINE far constraint is what reaches `mergeFarPreds` — item 1289's `merge-drops-family`
    // mutant SURVIVED until its test had one. Both far nodes satisfy `{nm: 'x'}`; only one
    // satisfies the clause, so a dropped list answers 2.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['S'], properties: { nm: 'a' } });
    const keep = h.addVertex({ id: 'keep', labels: ['P'], properties: { nm: 'x', v: 3 } });
    const drop = h.addVertex({ id: 'drop', labels: ['P'], properties: { nm: 'x', v: 'y' } });

    h.addEdge({ id: 'e1', from: a, to: keep, labels: ['T'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: drop, labels: ['T'], properties: {} });

    expect(
      Number(
        query(
          h,
          "MATCH (p:S)-[:T]->(b {nm: 'x'}) WHERE b.v IS TYPED INTEGER NOT NULL RETURN count(*) AS c",
        )[0].c,
      ),
    ).toBe(1);

    // CONTROL: without the clause predicate both survive.
    expect(query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) RETURN b.nm AS nm").length).toBe(2);
  });
});
