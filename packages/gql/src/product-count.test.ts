import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The product-of-counts shortcut (audit item 135): `count(*)` over INDEPENDENT
// patterns is the product of their counts, so `MATCH (a:P {k: 1}), (b:P {k: 2})
// RETURN count(*)` needs two bucket walks rather than |A| x |B| enumerated rows.
//
// TWO oracles, because either alone can pass while the shortcut is wrong:
//
//   1. ARITHMETIC — computed here from the fixture's own definition, so it cannot be
//      circular with the engine's matcher.
//   2. FORCED DECLINE — the identical question with a trailing `LET`, which makes
//      `detectCountShortcut` reject (every clause before `RETURN` must be a `MATCH`)
//      and routes the same query through the general enumerating path. This is the
//      one that catches a product that is self-consistently wrong.
//
// Sizes are deliberately four DISTINCT numbers: |k=1| = 3, |k=2| = 5, so the
// product 15 is not the sum 8, not 3^2 = 9 and not 5^2 = 25. A fixture where two of
// those coincide cannot tell a product from a mistake — the trap this file is the
// ninth recorded instance of.
const K1 = ['v0', 'v1', 'v2'];
const K2 = ['v3', 'v4', 'v5', 'v6', 'v7'];
const N = 12;
const QS = ['v0', 'v1'];
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [0, 3],
];

const kOf = (id: string): number => {
  if (K1.includes(id)) {
    return 1;
  }

  return K2.includes(id) ? 2 : 9;
};

const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) => {
    const id = `v${i}`;

    return g.addVertex({
      id,
      labels: QS.includes(id) ? ['P', 'Q'] : ['P'],
      properties: { k: kOf(id) },
    });
  });

  for (const [a, b] of EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['E'], properties: { w: a } });
  }

  return g;
};

const countOf = (g: Graph, q: string): number => (query(g, q)[0]?.c as number) ?? -1;

/** The same question with a trailing `LET`, which forces the general path. */
const enumerated = (g: Graph, q: string): number => {
  const i = q.lastIndexOf(' RETURN ');

  return countOf(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

/** Shortcut answer, general-path answer, and the independent arithmetic — all three. */
const bothWays = (g: Graph, q: string): [number, number] => [countOf(g, q), enumerated(g, q)];

describe('product-of-counts shortcut', () => {
  test('two independent node patterns multiply, and match the general path', () => {
    const g = build();
    const q = 'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toBe(K1.length * K2.length);
    expect(fast).toBe(15);
    expect(slow).toBe(fast);
  });

  test('the two-clause spelling costs and answers the same', () => {
    const g = build();
    // Separate MATCH clauses are the OTHER spelling of the same question. Teaching
    // one and not the other is this repo's named bug class.
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 1}) MATCH (b:P {k: 2}) RETURN count(*) AS c');

    expect(fast).toBe(15);
    expect(slow).toBe(15);
  });

  test('three patterns multiply all three factors', () => {
    const g = build();
    const [fast, slow] = bothWays(
      g,
      'MATCH (a:P {k: 1}), (b:P {k: 2}), (c:Q) RETURN count(*) AS c',
    );

    expect(fast).toBe(K1.length * K2.length * QS.length);
    expect(fast).toBe(30);
    expect(slow).toBe(fast);
  });

  test('an unconstrained factor uses the bucket size, not a walk', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P), (b:Q) RETURN count(*) AS c');

    expect(fast).toBe(N * QS.length);
    expect(fast).toBe(24);
    expect(slow).toBe(fast);
  });

  test('an EMPTY factor makes the product zero', () => {
    const g = build();
    // `k = 7` matches nothing, so the answer is 0 however the other factor counts —
    // and the short-circuit must not turn an empty factor into a skipped one.
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 7}), (b:P {k: 2}) RETURN count(*) AS c');

    expect(fast).toBe(0);
    expect(slow).toBe(0);
  });

  test('a missing LABEL factor makes the product zero', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:Nope), (b:P {k: 2}) RETURN count(*) AS c');

    expect(fast).toBe(0);
    expect(slow).toBe(0);
  });

  test('an edge pattern is a usable factor', () => {
    const g = build();
    // Measured against both engines: a multi-pattern MATCH imposes NO cross-pattern
    // edge uniqueness, so this is |E| x |Q| and not |E| x |Q| minus anything.
    const [fast, slow] = bothWays(g, 'MATCH (x)-[:E]->(y), (b:Q) RETURN count(*) AS c');

    expect(fast).toBe(EDGES.length * QS.length);
    expect(fast).toBe(8);
    expect(slow).toBe(fast);
  });

  test('a SHARED variable is a join and must not multiply', () => {
    const g = build();
    // `a` in both patterns constrains ONE binding: the answer is |k=1| = 3, not 9.
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 1}), (a:P) RETURN count(*) AS c');

    expect(fast).toBe(K1.length);
    expect(fast).toBe(3);
    expect(slow).toBe(fast);
    expect(fast).not.toBe(K1.length * K1.length);
  });

  test('a shared variable across two MATCH clauses is also a join', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 1}) MATCH (a:P) RETURN count(*) AS c');

    expect(fast).toBe(3);
    expect(slow).toBe(3);
  });

  test('a CORRELATING clause WHERE must not multiply', () => {
    const g = build();
    // `b.k = a.k` ties the patterns together: the answer is |k=1|^2 = 9 (each of the
    // three `a` pairs with the three `b` sharing its k), which is NOT |A| x |P|.
    const [fast, slow] = bothWays(
      g,
      'MATCH (a:P {k: 1}), (b:P) WHERE b.k = a.k RETURN count(*) AS c',
    );

    expect(fast).toBe(K1.length * K1.length);
    expect(fast).toBe(9);
    expect(slow).toBe(fast);
    expect(fast).not.toBe(K1.length * N);
  });

  test('DISTINCT path variables do not prevent the product', () => {
    const g = build();
    // `p` and `p2` are different names, so these patterns are still independent.
    // This case is NOT a collision test — it was named as one, and mutation proved
    // it checked nothing of the sort.
    const [fast, slow] = bothWays(
      g,
      'MATCH p = (a:P {k: 1}), p2 = (b:P {k: 2}) RETURN count(*) AS c',
    );

    expect(fast).toBe(15);
    expect(slow).toBe(15);
  });

  test('a PATH variable colliding with a node variable declines, preserving the raise', () => {
    const g = build();
    // `p` is a path variable in the first pattern and a NODE variable in the second.
    // The general path raises on it, and WHICH queries raise is part of the
    // cross-engine invariant — so the product must decline rather than answer 15.
    //
    // This is what gives `patternVarsOf`'s `pathVar` line teeth: with that one line
    // removed the patterns look independent, the product fires, and the raise
    // becomes `15`. Asserting agreement rather than the message keeps the test from
    // enshrining the particular error, which is today an internal TypeError.
    const outcome = (q: string): string => {
      try {
        return `answered ${countOf(g, q)}`;
      } catch {
        return 'raised';
      }
    };
    const q = 'MATCH p = (a:P {k: 1}), (p:P {k: 2}) RETURN count(*) AS c';
    const i = q.lastIndexOf(' RETURN ');

    expect(outcome(q)).toBe('raised');
    expect(outcome(`${q.slice(0, i)} LET _z = 1${q.slice(i)}`)).toBe('raised');
  });

  test('the same path variable in two MATCH clauses still multiplies', () => {
    const g = build();
    // Re-binding `p` to a different path does not correlate the NODE patterns, and
    // the general path agrees, so this one is a product.
    const [fast, slow] = bothWays(
      g,
      'MATCH p = (a:P {k: 1}) MATCH p = (b:P {k: 2}) RETURN count(*) AS c',
    );

    expect(fast).toBe(15);
    expect(slow).toBe(15);
  });
});

describe('constrained node count tally', () => {
  test('inline, inline WHERE and clause WHERE all agree', () => {
    const g = build();
    // Three spellings of ONE question. Before item 135 only the unconstrained form
    // had a shortcut; the first of these cost 10.5ms on a 20,000-vertex fixture
    // against native's 0.04ms.
    const spellings = [
      'MATCH (a:P {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P WHERE a.k = 2) RETURN count(*) AS c',
      'MATCH (a:P) WHERE a.k = 2 RETURN count(*) AS c',
    ];

    for (const q of spellings) {
      const [fast, slow] = bothWays(g, q);

      expect(fast).toBe(K2.length);
      expect(slow).toBe(K2.length);
    }
  });

  test('an inline constraint AND a clause WHERE must BOTH hold', () => {
    const g = build();
    // Carried as two closed predicates rather than one spliced `AND`, so this is the
    // case that catches only one of them being applied: `k = 2` matches 5 and
    // `a.k = 1` matches 3, and together they match NOTHING.
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 2}) WHERE a.k = 1 RETURN count(*) AS c');

    expect(fast).toBe(0);
    expect(slow).toBe(0);
  });

  test('a clause WHERE and an inline constraint that agree still count once', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P {k: 2}) WHERE a.k = 2 RETURN count(*) AS c');

    expect(fast).toBe(K2.length);
    expect(slow).toBe(K2.length);
  });

  test('an unlabelled constrained count walks every vertex', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a {k: 2}) RETURN count(*) AS c');

    expect(fast).toBe(K2.length);
    expect(slow).toBe(K2.length);
  });

  test('a constrained count over a MULTI-label node declines rather than guessing', () => {
    const g = build();
    // `(a:P&Q)` has no single bucket, so there is nothing to tally; it must still be
    // right, by whatever path it takes.
    const [fast, slow] = bothWays(g, 'MATCH (a:P&Q {k: 1}) RETURN count(*) AS c');

    expect(fast).toBe(QS.length);
    expect(slow).toBe(QS.length);
  });
});

describe('the product shortcut declines where it must', () => {
  const g = build();
  // Each of these would be a WRONG answer if the product answered it, since a
  // shortcut returns ONE row holding ONE global count.
  const cases: [string, string, unknown][] = [
    ['GROUP BY', 'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c GROUP BY a', undefined],
    ['DISTINCT', 'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN DISTINCT count(*) AS c', undefined],
    ['LIMIT 0', 'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c LIMIT 0', undefined],
    [
      'count(DISTINCT)',
      'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(DISTINCT a) AS c',
      undefined,
    ],
  ];

  for (const [name, q] of cases) {
    test(`${name} takes the general path`, () => {
      // The assertion is agreement with the forced-decline spelling, which is the
      // only thing that can be stated without re-deriving each modifier's meaning.
      expect(query(g, q)).toEqual(
        query(
          g,
          `${q.slice(0, q.lastIndexOf(' RETURN '))} LET _z = 1${q.slice(q.lastIndexOf(' RETURN '))}`,
        ),
      );
    });
  }

  test('OPTIONAL MATCH is not a factor', () => {
    const g2 = build();
    const q = 'MATCH (a:P {k: 1}) OPTIONAL MATCH (b:P {k: 7}) RETURN count(*) AS c';

    // An unmatched OPTIONAL still yields its row with `b` null, so the answer is
    // |k=1| = 3 — NOT zero, which a product over an empty factor would give.
    expect(countOf(g2, q)).toBe(K1.length);
  });
});
