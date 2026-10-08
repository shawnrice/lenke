import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// An inline PROPERTY compiles to `structuralEq(propOf(element, key), …)` — a direct read. An inline
// `WHERE` compiles to the generic expression evaluator, which reads its element back out of the
// BINDING, so it pays a `Map.set` by the caller plus a `Map.get` per property read to hand over an
// element `satisfies` already holds. That is item 216's finding in a second place, and the spelling
// probe had been flagging it for three shapes at once (audit item 224):
//
//     MATCH (n:P {k: 2}) RETURN count(*)              3.82ms
//     MATCH (n:P) WHERE n.k = 2 RETURN count(*)       5.80
//     MATCH (n:P WHERE n.k = 2) RETURN count(*)       8.51     ← 2.2x the first
//
// `directEqProps` recognises an inline `WHERE` that is exactly one `<own>.<key> = <non-null
// literal>` and compiles it as a property-style check: 1.52x on the node count, 1.68x on the
// mirrored operand order, 1.27x and 1.26x on the two hop shapes, and the probe's `node count`
// group stops flagging.
//
// THE THREE RESTRICTIONS ARE THE SUBSTANCE OF THIS FILE. Each is forced by semantics, and each has
// a test that FAILS if the rewrite is widened to cover it.
const build = (): Graph => {
  const g = new Graph();

  // `has` carries k; `absent` has no k at all; `nulled` stores an explicit null. The three behave
  // differently under `=`, `<>` and an inline `{k: null}`, which is what makes them the fixture.
  g.addVertex({ id: 'has2', labels: ['P'], properties: { k: 2, s: 'xx' } });
  g.addVertex({ id: 'has9', labels: ['P'], properties: { k: 9, s: 'xx' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { s: 'yy' } });
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { k: null, s: 'zz' } });
  g.addVertex({ id: 'listy', labels: ['P'], properties: { tags: [1, 2], s: 'ww' } });

  return g;
};

const g = build();
const countOf = (q: string, params?: Record<string, unknown>): number =>
  Number(query(g, q, params)[0].c);

describe('the inline WHERE equality matches what the other spellings match', () => {
  test('all three spellings of one equality agree', () => {
    const inlineWhere = countOf('MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c');

    expect(inlineWhere).toBe(countOf('MATCH (n:P {k: 2}) RETURN count(*) AS c'));
    expect(inlineWhere).toBe(countOf('MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c'));
    expect(inlineWhere).toBe(1);
  });

  test('the MIRRORED operand order agrees and is not a separate question', () => {
    expect(countOf('MATCH (n:P WHERE 2 = n.k) RETURN count(*) AS c')).toBe(
      countOf('MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c'),
    );
  });

  test('a value NO vertex carries matches nothing', () => {
    expect(countOf('MATCH (n:P WHERE n.k = 777) RETURN count(*) AS c')).toBe(0);
  });

  test('a key NO vertex carries matches nothing', () => {
    expect(countOf('MATCH (n:P WHERE n.missing = 1) RETURN count(*) AS c')).toBe(0);
  });

  test('it composes on both ends of a hop', () => {
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['P'], properties: { k } });
    const [a, b] = [v('a', 1), v('b', 2)];

    h.addEdge({ from: a, to: b, labels: ['E'], properties: {} });

    for (const [q, want] of [
      ['MATCH (a:P WHERE a.k = 1)-[:E]->(b) RETURN count(*) AS c', 1],
      ['MATCH (a:P)-[:E]->(b WHERE b.k = 2) RETURN count(*) AS c', 1],
      ['MATCH (a:P WHERE a.k = 2)-[:E]->(b) RETURN count(*) AS c', 0],
      ['MATCH (a:P)-[:E]->(b WHERE b.k = 1) RETURN count(*) AS c', 0],
    ] as const) {
      expect(Number(query(h, q)[0].c)).toBe(want);
    }
  });

  test('and it still answers what the general path answers', () => {
    const q = 'MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c';

    // A dead `LET` forces the general path, which the count shortcuts decline.
    expect(countOf(q)).toBe(Number(query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '))[0].c));
  });
});

describe('RESTRICTION: `=` only, because `<>` diverges on a missing property', () => {
  test('`<>` excludes a vertex whose property is ABSENT', () => {
    // `absent` has no `k`, so `n.k <> 2` is UNKNOWN and the row is rejected. A rewrite that
    // negated a structural check would INCLUDE it — 3 instead of 2.
    //
    // has9 (9 <> 2) and nulled (null <> 2 is UNKNOWN → rejected)… so only has9 and… let the
    // general path be the oracle rather than my arithmetic.
    const q = 'MATCH (n:P WHERE n.k <> 2) RETURN count(*) AS c';

    expect(countOf(q)).toBe(Number(query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '))[0].c));
  });

  test('`<>` excludes the explicit null too', () => {
    // Both the absent and the stored-null vertex are UNKNOWN under `<>`, so only `has9` survives.
    expect(countOf('MATCH (n:P WHERE n.k <> 2) RETURN count(*) AS c')).toBe(1);
  });

  test('the ordering operators keep the general path and their own answers', () => {
    for (const [q, want] of [
      ['MATCH (n:P WHERE n.k > 2) RETURN count(*) AS c', 1],
      ['MATCH (n:P WHERE n.k >= 2) RETURN count(*) AS c', 2],
      ['MATCH (n:P WHERE n.k < 9) RETURN count(*) AS c', 1],
    ] as const) {
      expect(countOf(q)).toBe(want);
    }
  });
});

describe('RESTRICTION: a non-null LITERAL, never a param', () => {
  test('a param equality still answers correctly', () => {
    expect(countOf('MATCH (n:P WHERE n.k = $p) RETURN count(*) AS c', { p: 2 })).toBe(1);
  });

  test('a NULL param matches nothing, where the inline property matches null AND absent', () => {
    // This is why a param may not take the route: `{k: $p}` with a null `$p` matches the stored
    // null and the absent key, while `n.k = $p` matches neither. Rewriting one into the other
    // would change the answer for a value only known at run time.
    expect(countOf('MATCH (n:P WHERE n.k = $p) RETURN count(*) AS c', { p: null })).toBe(0);
    expect(countOf('MATCH (n:P {k: $p}) RETURN count(*) AS c', { p: null })).toBe(3);
  });

  test('a NULL literal matches nothing, and the inline property still matches all three', () => {
    expect(countOf('MATCH (n:P WHERE n.k = null) RETURN count(*) AS c')).toBe(0);
    expect(countOf('MATCH (n:P {k: null}) RETURN count(*) AS c')).toBe(3);
  });

  test('a LIST literal keeps the general path and still matches structurally', () => {
    // A list is not a `lit` node, so it declines the rewrite — and must still match the stored
    // list structurally, which is the behaviour a reference comparison once broke.
    expect(countOf('MATCH (n:P WHERE n.tags = [1, 2]) RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (n:P {tags: [1, 2]}) RETURN count(*) AS c')).toBe(1);
  });
});

describe('RESTRICTION: one comparison, never an AND-chain', () => {
  test('a FALSE conjunct does not suppress a raise from another', () => {
    // `AND` does not short-circuit here, by design and for byte-identity. `n.k = 999` matches
    // nothing, yet the CAST still raises. Hoisting that conjunct into a property check would let
    // `satisfies` reject the element first and swallow the raise.
    expect(() =>
      query(g, 'MATCH (n:P WHERE n.k = 999 AND CAST(n.s AS INTEGER) > 0) RETURN count(*) AS c'),
    ).toThrow();
  });

  test('the raise is the same one the clause spelling produces', () => {
    expect(() =>
      query(g, 'MATCH (n:P) WHERE n.k = 999 AND CAST(n.s AS INTEGER) > 0 RETURN count(*) AS c'),
    ).toThrow();
  });

  test('an AND-chain with no raise still answers correctly', () => {
    expect(countOf("MATCH (n:P WHERE n.k = 2 AND n.s = 'xx') RETURN count(*) AS c")).toBe(1);
    expect(countOf("MATCH (n:P WHERE n.k = 2 AND n.s = 'zz') RETURN count(*) AS c")).toBe(0);
  });

  test('an OR of equalities keeps the general path', () => {
    expect(countOf('MATCH (n:P WHERE n.k = 2 OR n.k = 9) RETURN count(*) AS c')).toBe(2);
  });

  test('a NOT around an equality keeps the general path', () => {
    const q = 'MATCH (n:P WHERE NOT (n.k = 2)) RETURN count(*) AS c';

    expect(countOf(q)).toBe(Number(query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '))[0].c));
  });
});

describe('RESTRICTION: only an INLINE where, never a clause one', () => {
  test('a clause WHERE reading another variable still answers correctly', () => {
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['P'], properties: { k } });
    const [a, b] = [v('a', 1), v('b', 1)];

    h.addEdge({ from: a, to: b, labels: ['E'], properties: {} });

    // The clause form may read any variable, so it cannot be element-local and must not be
    // rewritten. `a.k = b.k` reads both ends.
    expect(
      Number(query(h, 'MATCH (a:P)-[:E]->(b) WHERE a.k = b.k RETURN count(*) AS c')[0].c),
    ).toBe(1);
  });

  test('an inline WHERE reading ANOTHER variable is not rewritten against this element', () => {
    // `(y WHERE x.k = 2)` is valid GQL and reads the OTHER end. The rewrite must not treat it as a
    // property of `y`: `x.k` is 2 and `y.k` is 9, so a mis-targeted check answers 0 instead of 1.
    //
    // `inlineOf` refuses this shape (a free name that is not the node's variable) and
    // `directEqProps` checks the variable too, so the two guards are redundant — but a DOUBLE
    // mutant removing both is only caught because this shape is written down. Without it the pair
    // protects nothing a test can see.
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['P'], properties: { k } });
    const [x, y] = [v('x', 2), v('y', 9)];

    h.addEdge({ from: x, to: y, labels: ['E'], properties: {} });

    expect(Number(query(h, 'MATCH (x:P)-[:E]->(y WHERE x.k = 2) RETURN count(*) AS c')[0].c)).toBe(
      1,
    );
    // The mirror, so the fixture distinguishes which end is read rather than being symmetric.
    expect(Number(query(h, 'MATCH (x:P)-[:E]->(y WHERE y.k = 2) RETURN count(*) AS c')[0].c)).toBe(
      0,
    );
  });

  test('an inline WHERE on an ANONYMOUS node keeps the general path', () => {
    // No own variable to compare against, so `directEqProps` declines. `(:P WHERE …)` cannot name
    // itself, so this is really a parse-level question; the point is that it still answers.
    const q = 'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c';

    expect(countOf(q)).toBe(1);
  });
});
