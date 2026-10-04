import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `visitRemaining` matches an UNCORRELATED tail once and forms the product, instead of
// re-matching it per outer row (audit item 121). Everything here checks that the shortcut and
// the per-outer-row path agree, and that correlated shapes keep the per-row path.
//
// The ORACLE is the two-CLAUSE spelling: `MATCH p1 MATCH p2` runs each clause through
// `runMatch`, never through `visitRemaining`, so it computes the same product by a different
// route and cannot be circular with the thing under test.

const build = (n: number, distinct: number): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: n }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % distinct, i } }),
  );

  // A few edges so a correlated `(a)-[:E]->(b)` tail has something to find.
  for (let i = 0; i + 1 < n; i += 3) {
    g.addEdge({ from: vs[i], to: vs[i + 1], labels: ['E'], properties: {} });
  }

  return g;
};

const c = (g: Graph, q: string): number => (query(g, q)[0] as { c: number }).c;

describe('a multi-pattern MATCH agrees with the two-clause spelling', () => {
  test('an uncorrelated product matches its oracle', () => {
    const g = build(60, 7);

    for (const [one, two] of [
      ['MATCH (a:P {k: 1}), (b:P {k: 2})', 'MATCH (a:P {k: 1}) MATCH (b:P {k: 2})'],
      ['MATCH (a:P), (b:P {k: 2})', 'MATCH (a:P) MATCH (b:P {k: 2})'],
      ['MATCH (a:P {k: 1}), (b:P)', 'MATCH (a:P {k: 1}) MATCH (b:P)'],
      // a key no vertex carries: the product is empty on both routes
      ['MATCH (a:P {k: 99}), (b:P {k: 2})', 'MATCH (a:P {k: 99}) MATCH (b:P {k: 2})'],
      // three patterns, so the hoist nests
      [
        'MATCH (a:P {k: 1}), (b:P {k: 2}), (d:P {k: 3})',
        'MATCH (a:P {k: 1}) MATCH (b:P {k: 2}) MATCH (d:P {k: 3})',
      ],
    ]) {
      expect(c(g, `${one} RETURN count(*) AS c`)).toBe(c(g, `${two} RETURN count(*) AS c`));
    }
  });

  // These must keep the per-outer-row path: hoisting them would compute the tail against the
  // wrong binding and silently change the answer.
  test('a correlated tail is not hoisted', () => {
    const g = build(60, 7);

    // The tail READS a variable the first pattern binds. The bucket sizes must DIFFER for
    // this to prove anything: with `build(60, 7)` the k=1 and k=2 buckets are both 9, so
    // `{k: a.k}` and `{k: 2}` both give 9*9 = 81 and the correlated and uncorrelated answers
    // coincide — the first version of this test passed while distinguishing nothing.
    const uneven = new Graph();

    for (let i = 0; i < 9; i++) {
      // k=1 gets 4 vertices, k=2 gets 5 — so |k=1|*|k=1| = 16 and |k=1|*|k=2| = 20.
      uneven.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i < 4 ? 1 : 2 } });
    }

    expect(c(uneven, `MATCH (a:P {k: 1}), (b:P {k: a.k}) RETURN count(*) AS c`)).toBe(16);
    expect(c(uneven, `MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c`)).toBe(20);
    expect(c(uneven, `MATCH (a:P {k: 1}), (b:P {k: a.k}) RETURN count(*) AS c`)).toBe(
      c(uneven, `MATCH (a:P {k: 1}) MATCH (b:P {k: 1}) RETURN count(*) AS c`),
    );
    // The tail SHARES a variable (a join, not a product).
    expect(c(g, `MATCH (a:P {k: 1}), (a)-[:E]->(b) RETURN count(*) AS c`)).toBe(
      c(g, `MATCH (a:P {k: 1})-[:E]->(b) RETURN count(*) AS c`),
    );
  });

  // A tail may read something bound at an OUTER level — that is still uncorrelated with the
  // pattern being hoisted over, so it must hoist AND be right.
  test('a tail reading an outer-clause variable still agrees', () => {
    const g = build(30, 5);
    const one = `MATCH (z:P {k: 0}) MATCH (a:P {k: 1}), (b:P {k: z.k}) RETURN count(*) AS c`;
    const two = `MATCH (z:P {k: 0}) MATCH (a:P {k: 1}) MATCH (b:P {k: z.k}) RETURN count(*) AS c`;

    expect(c(g, one)).toBe(c(g, two));
  });

  // Column order for `RETURN *` comes from the binding's key order, and the merge has to
  // reproduce what the recursion produced: outer keys, then the hoisted pattern's, then the
  // tail's. See [column-order.test.ts] for why order is observable at all.
  test('RETURN * keeps the recursion key order', () => {
    const g = build(6, 3);
    const rows = query(g, `MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN *`);

    expect(Object.keys(rows[0] ?? {})).toEqual(['a', 'b']);

    const three = query(g, `MATCH (a:P {k: 1}), (b:P {k: 2}), (d:P {k: 0}) RETURN *`);

    expect(Object.keys(three[0] ?? {})).toEqual(['a', 'b', 'd']);
  });

  // The tail cache is capped at 4096, so a bigger tail must fall back to re-matching and
  // still be correct. The TAIL has to exceed the cap while the product stays small, or the
  // test is just slow: 5000 vertices in the tail bucket and 2 in the outer one. (A first
  // version used 2500 per bucket — under the cap, so it never reached the fallback, and its
  // 6,250,000-row oracle timed out.)
  test('a tail larger than the cache cap still agrees', () => {
    const g = new Graph();

    for (let i = 0; i < 5_000; i++) {
      g.addVertex({ id: `t${i}`, labels: ['P'], properties: { k: 0 } });
    }

    for (let i = 0; i < 2; i++) {
      g.addVertex({ id: `o${i}`, labels: ['P'], properties: { k: 1 } });
    }

    const one = `MATCH (a:P {k: 1}), (b:P {k: 0}) RETURN count(*) AS c`;
    const two = `MATCH (a:P {k: 1}) MATCH (b:P {k: 0}) RETURN count(*) AS c`;

    expect(c(g, one)).toBe(2 * 5_000);
    expect(c(g, one)).toBe(c(g, two));
  });

  // An anonymous pattern binds nothing, so nothing downstream can depend on it — the
  // `binds.size === 0` early exit. It must still produce the right cardinality.
  test('a pattern binding nothing is hoisted over correctly', () => {
    const g = build(12, 4);

    expect(c(g, `MATCH (:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c`)).toBe(
      c(g, `MATCH (:P {k: 1}) MATCH (b:P {k: 2}) RETURN count(*) AS c`),
    );
  });

  test('OPTIONAL over several patterns is unchanged', () => {
    const g = build(12, 4);

    // The OPTIONAL clause's own patterns go through the same code; a no-match must still
    // produce one null-filled row per incoming binding rather than dropping it.
    expect(
      c(g, `MATCH (a:P {k: 1}) OPTIONAL MATCH (x:P {k: 99}), (y:P {k: 98}) RETURN count(*) AS c`),
    ).toBe(c(g, `MATCH (a:P {k: 1}) RETURN count(*) AS c`));
  });
});
