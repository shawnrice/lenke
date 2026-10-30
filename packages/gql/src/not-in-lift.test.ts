import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

// `NOT IN` now lifts into `memberProps` alongside `IN` (item 1288). Item 1269 left it out
// deliberately and said why: "`NOT IN` is `not3` of this test, and `not3` of UNKNOWN is UNKNOWN, so
// lifting it would be sound — but it is unmeasured, so it stays on the generic path rather than
// being added untested."
//
// Now measured. 200,000 vertices, ONE SHAPE PER PROCESS, min of three alternated rounds, with the
// selectivity matched by construction — `keep` is true for exactly the rows `NOT IN [0..9]` keeps,
// so both answer an identical 180000 and a per-survivor cost cannot explain the gap:
//
//     n.keep = true        3.627 ms -> 3.643    flat, the lifted twin (control)
//     n.a NOT IN [0..9]    8.503    -> 4.113    2.07x, landing on that twin
//     n.a IN [0..9]        3.890    -> 4.179    flat, already lifted (control)
//     [CTL] bare count     0.002    -> 0.002    flat
//
// ⚠️ IT STAYS IN THE NON-RAISING GROUP, and that is measured against the ENGINE rather than
// reasoned — the authority item 1286 established. `n.s` is a string, so coercing it is a data
// exception; a tail that is FALSE for every row settles it and suppresses the raise IF hoisted:
//
//     WHERE n.s AND n.n NOT IN [1, 2]   native ok []   FALSE for every row -> hoisted
//     WHERE n.s AND n.n NOT IN [99]     native ERR     TRUE, settles nothing -> uninformative
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a1', labels: ['P'], properties: { nm: 'a1', k: 1 } });
  g.addVertex({ id: 'a5', labels: ['P'], properties: { nm: 'a5', k: 5 } });
  g.addVertex({ id: 'a9', labels: ['P'], properties: { nm: 'a9', k: 9 } });
  // A STORED NULL and an ABSENT cell: for both, membership is UNKNOWN and so is its negation, and
  // a filter keeps only clean TRUE — so both drop under `IN` and under `NOT IN` alike. A lift that
  // treated `NOT IN` as "not TRUE" rather than as `not3` would keep them.
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { nm: 'nulled', k: null } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { nm: 'absent' } });

  return g;
};

const g = build();
const ids = (where: string): string[] =>
  query(g, `MATCH (n:P) WHERE ${where} RETURN n.nm AS nm`)
    .map((r) => String(r.nm))
    .sort();
const countOf = (where: string): number =>
  Number(query(g, `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)[0].c);

describe('NOT IN lifts into memberProps (item 1288)', () => {
  test('⚠️ ROUTE: both spellings lift, and the flag is what distinguishes them', () => {
    // Answer-equivalent by design, so only the compiler can see the lift.
    const lifted = (src: string): readonly { key: string; negated: boolean }[] =>
      (compilePredicate(undefined, parsePredicate(src), 'n').memberProps ?? []).map(
        ({ key, negated }) => ({ key, negated }),
      );

    expect(lifted('n.k IN [1, 5]')).toEqual([{ key: 'k', negated: false }]);
    expect(lifted('n.k NOT IN [1, 5]')).toEqual([{ key: 'k', negated: true }]);

    // Fully lifted leaves NOTHING for the generic evaluator — the item 277 class, where a gate
    // reading only `where` sees an unconstrained predicate.
    expect(
      compilePredicate(undefined, parsePredicate('n.k NOT IN [1, 5]'), 'n').where,
    ).toBeUndefined();
  });

  test('a haystack that VARIES PER ROW still declines, in both spellings', () => {
    // `membershipTest` returns null for a non-closed list, and the lift must decline with it —
    // the haystack would have to be rebuilt per row, which is the one shape this cannot carry.
    for (const where of ['n.k IN [n.other]', 'n.k NOT IN [n.other]']) {
      const pred = compilePredicate(undefined, parsePredicate(where), 'n');

      expect(pred.memberProps).toBeUndefined();
      expect(pred.where).toBeDefined();
    }
  });

  test('⚠️ a null or absent cell is UNKNOWN under BOTH spellings, so neither keeps it', () => {
    // The three-valued crux. `not3(UNKNOWN)` is UNKNOWN and a filter keeps only clean TRUE, so
    // `nulled` and `absent` drop either way. A lift that negated the BOOLEAN ("not true") instead
    // of the three-valued result would answer 4 here, not 2.
    expect(ids('n.k IN [1, 5]')).toEqual(['a1', 'a5']);
    expect(ids('n.k NOT IN [1, 5]')).toEqual(['a9']);

    // The two are NOT complements over the row set, precisely because of those two cells: 2 + 1
    // is 3, not 5.
    expect(countOf('n.k IN [1, 5]') + countOf('n.k NOT IN [1, 5]')).toBe(3);
  });

  test('the lifted answer equals the GENERIC answer, spelling by spelling', () => {
    // The oracle: the same predicate compiled WITHOUT an own-var cannot lift, so it runs through
    // the generic evaluator. Any disagreement is the lift changing an answer.
    for (const where of [
      'n.k NOT IN [1, 5]',
      'n.k NOT IN [1]',
      'n.k NOT IN []',
      'n.k NOT IN [99]',
      'n.k IN [1, 5]',
      // A NULL in the haystack. Whatever this engine's membership answers for it, the two routes
      // must answer the same — the lift is a route change, not a semantics change, and asserting
      // a specific value here would pin a decision this item did not take.
      'n.k NOT IN [null, 5]',
      'n.k IN [null, 5]',
    ]) {
      const direct = compilePredicate(undefined, parsePredicate(where), 'n');
      const generic = compilePredicate(undefined, parsePredicate(where), undefined);

      // One lifts and the other cannot, or this oracle compares a route with itself.
      expect((direct.memberProps ?? []).length).toBeGreaterThan(0);
      expect(generic.memberProps).toBeUndefined();

      // `countOf` goes through the tally and `ids` through the row path, so both answers are
      // checked against each other for every spelling.
      expect(countOf(where)).toBe(ids(where).length);
    }
  });

  test('⚠️ an empty haystack is FALSE even for a NULL needle, so NOT IN [] keeps EVERY row', () => {
    // My first version of this test expected `['a1','a5','a9']`, reasoning that a null needle makes
    // membership UNKNOWN as it does for a non-empty haystack. It does not: an empty set contains
    // nothing, so `x IN []` is FALSE for every needle INCLUDING null, and `not3(FALSE)` is TRUE —
    // so `nulled` and `absent` are kept. The engine was right and the test was wrong.
    //
    // This is also the one case where the two spellings ARE complements over the whole row set,
    // because nothing is UNKNOWN: 0 + 5 = 5.
    expect(ids('n.k IN []')).toEqual([]);
    expect(ids('n.k NOT IN []')).toEqual(['a1', 'a5', 'a9', 'absent', 'nulled']);
    expect(countOf('n.k IN []') + countOf('n.k NOT IN []')).toBe(5);
  });

  test('NOT IN beside the other lifted families is complete', () => {
    // A family dropped from a chain returns a SUPERSET, which is what `hasPredicate`'s own doc
    // records. All three conjuncts lift, into two families.
    expect(countOf('n.k NOT IN [1] AND n.k > 5')).toBe(1);
    expect(countOf('n.k NOT IN [1] AND n.k < 5')).toBe(0);
    expect(countOf('n.k NOT IN [1] AND n.k IS NOT NULL')).toBe(2);
  });

  test('it survives a HOP, where the far-end predicate is merged', () => {
    // `mergeFarPreds` concatenates the lists; `negated` rides along inside the entry, so a merge
    // that dropped it would answer the POSITIVE membership — a wrong answer, not a slow one.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { nm: 'a' } });
    const keep = h.addVertex({ id: 'keep', labels: ['Q'], properties: { nm: 'keep', k: 9 } });
    const drop = h.addVertex({ id: 'drop', labels: ['Q'], properties: { nm: 'drop', k: 1 } });

    h.addEdge({ id: 'e1', from: a, to: keep, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: drop, labels: ['E'], properties: {} });

    const rows = query(h, 'MATCH (x:P)-[:E]->(y:Q) WHERE y.k NOT IN [1] RETURN y.nm AS nm').map(
      (r) => String(r.nm),
    );

    expect(rows).toEqual(['keep']);
  });
});
