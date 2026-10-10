// Item 274. `productCountOf` used to decline any clause `WHERE`; now a conjunct reading
// only ONE pattern is attributed to that pattern's own count. The shortcut returns a
// NUMBER, so a wrong attribution is a wrong answer with no other symptom — these tests are
// the inputs that distinguish a correct attribution from a plausible one.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = (): Graph => {
  const graph = new Graph();

  // Tiny: k = 0, 1, 2, 3
  for (let i = 0; i < 4; i++) {
    graph.addVertex({ labels: ['Tiny'], properties: { k: i } });
  }

  // User: k = 0..9
  for (let i = 0; i < 10; i++) {
    graph.addVertex({ labels: ['User'], properties: { k: i, grp: i % 2 } });
  }

  return graph;
};

const count = (q: string, params?: Record<string, unknown>): number =>
  query<{ c: number }>(g(), q, params)[0].c;

describe('a single-pattern conjunct is attributed to its pattern', () => {
  test('the unfiltered product is the baseline', () => {
    expect(count('MATCH (s:Tiny) MATCH (u:User) RETURN count(*) AS c')).toBe(40);
  });

  // 4 x |User where k > 5| = 4 x 4 = 16.
  test('a RIGHT-side predicate', () => {
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k > 5 RETURN count(*) AS c')).toBe(16);
  });

  // |Tiny where k > 1| x 10 = 2 x 10 = 20. The WHERE hangs off the SECOND match clause
  // while `s` is bound by the FIRST, which is why attribution has to span clauses — a
  // per-clause search finds no owner here and declines (measured: this spelling stayed at
  // 91ms while the right-side one dropped to 4ms).
  test('a LEFT-side predicate, whose WHERE is on a later clause', () => {
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE s.k > 1 RETURN count(*) AS c')).toBe(20);
  });

  // Both sides at once: 2 x 4 = 8.
  test('one conjunct per side', () => {
    expect(
      count('MATCH (s:Tiny) MATCH (u:User) WHERE s.k > 1 AND u.k > 5 RETURN count(*) AS c'),
    ).toBe(8);
  });

  // Two conjuncts on the SAME pattern must AND together, not overwrite: |User where
  // k > 5 AND grp = 1| = {7, 9} = 2, so 4 x 2 = 8. If the second conjunct replaced the
  // first the answer would be 4 x 5 = 20.
  test('two conjuncts on one pattern are ANDed, not overwritten', () => {
    expect(
      count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k > 5 AND u.grp = 1 RETURN count(*) AS c'),
    ).toBe(8);
  });

  test('the comma spelling of the same question agrees', () => {
    expect(count('MATCH (s:Tiny), (u:User) WHERE u.k > 5 RETURN count(*) AS c')).toBe(16);
    expect(count('MATCH (s:Tiny), (u:User) WHERE s.k > 1 RETURN count(*) AS c')).toBe(20);
  });

  test('a param predicate is attributed the same way', () => {
    expect(
      count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k > $min RETURN count(*) AS c', { min: 5 }),
    ).toBe(16);
  });

  test('a predicate matching nothing gives zero, not the unfiltered product', () => {
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k > 999 RETURN count(*) AS c')).toBe(0);
  });
});

describe('what must still decline — a wrong attribution here is a wrong NUMBER', () => {
  // A CORRELATING conjunct is not a product at all. 4 Tiny x 10 User, keeping pairs where
  // u.k = s.k: s.k in {0,1,2,3} each match exactly one user, so 4 — NOT a product of any
  // two factors.
  test('a conjunct reading BOTH patterns', () => {
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k = s.k RETURN count(*) AS c')).toBe(4);
  });

  test('a correlating conjunct beside a single-pattern one', () => {
    // u.k = s.k keeps 4 pairs; of those, s.k > 1 keeps s.k in {2,3} → 2.
    expect(
      count('MATCH (s:Tiny) MATCH (u:User) WHERE u.k = s.k AND s.k > 1 RETURN count(*) AS c'),
    ).toBe(2);
  });

  // THE SUBQUERY CASE, and the one nothing else would catch. `freePredicateVars` returns an
  // EMPTY set for `EXISTS { … }` (the blindness item 213 recorded breaking an ORDER BY
  // alias guard), so a conjunct reading another pattern's variable from INSIDE a subquery
  // looks like it reads nothing. Attributing by free vars alone would hand it to the wrong
  // pattern and answer a product where the truth is a join.
  test('a conjunct whose only variable read is inside a subquery', () => {
    // EXISTS over a correlated condition: true only when some User has k = s.k, which is
    // every s in 0..3, so the answer is the full product 40 — but it must be computed, not
    // assumed, and a mis-attribution would silently change it.
    expect(
      count(
        'MATCH (s:Tiny) MATCH (u:User) WHERE EXISTS { MATCH (v:User) WHERE v.k = s.k } \
         RETURN count(*) AS c',
      ),
    ).toBe(40);
  });

  // THE CASE THAT MAKES THE SUBQUERY GUARD LOAD-BEARING rather than defensive. A conjunct
  // that is ONLY a subquery reports no free variables, so it finds no owning pattern and
  // declines anyway — the subquery guard is redundant there. But MIX a subquery with a
  // same-pattern read and `freePredicateVars` reports `{u}`: a legitimate owner, passing
  // the completeness check, so the conjunct IS attributed — while the subquery inside it
  // reads `s`, which the per-vertex tally over `u` cannot see. Without the guard this
  // answers a product computed from a predicate evaluated with `s` unbound.
  test('a conjunct MIXING a subquery with a same-pattern read', () => {
    // u.k > 5 is true for {6,7,8,9}; the EXISTS is true for every s in 0..3. So every pair
    // satisfies the OR, and the answer is the full product 40.
    expect(
      count(
        'MATCH (s:Tiny) MATCH (u:User) \
         WHERE u.k > 5 OR EXISTS { MATCH (v:User) WHERE v.k = s.k } RETURN count(*) AS c',
      ),
    ).toBe(40);
  });

  test('a conjunct mixing a subquery that is FALSE with a same-pattern read', () => {
    // The EXISTS is false for every s, so only u.k > 5 survives: 4 Tiny x 4 Users = 16.
    expect(
      count(
        'MATCH (s:Tiny) MATCH (u:User) \
         WHERE u.k > 5 OR EXISTS { MATCH (v:User) WHERE v.k = s.k + 100 } RETURN count(*) AS c',
      ),
    ).toBe(16);
  });

  test('a subquery that excludes some rows', () => {
    // EXISTS { (v:User) WHERE v.k = s.k + 100 } is false for every s, so zero rows.
    expect(
      count(
        'MATCH (s:Tiny) MATCH (u:User) WHERE EXISTS { MATCH (v:User) WHERE v.k = s.k + 100 } \
         RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  // A SHARED variable is a join, not a product, and that check must run BEFORE attribution
  // (a name bound twice has no single owning pattern).
  test('a shared variable with a predicate', () => {
    expect(count('MATCH (u:User) MATCH (u:User) WHERE u.k > 5 RETURN count(*) AS c')).toBe(4);
  });

  test('a constant predicate', () => {
    // No free variables, so no owning pattern — it must decline and still answer correctly.
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE 1 = 1 RETURN count(*) AS c')).toBe(40);
    expect(count('MATCH (s:Tiny) MATCH (u:User) WHERE 1 = 2 RETURN count(*) AS c')).toBe(0);
  });
});
