import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The DISTINCT walk's `evalFn` is the GENERIC compiled expression, so it reads its element back
// out of the binding: `(env) => propOf(env.binding.get(v), key)`. The walk already holds the
// element, so that cost a `Map.set` in `take` plus a `Map.get` inside the evaluator per vertex
// purely to hand it over. Audit item 216 reads the property directly when the walked expression
// is exactly `<keyedVar>.<key>` and nothing else wants the binding — 1.25-1.41x across the whole
// `distinct + order by` / `top distinct values` / `count distinct` family.
//
// What has to stay true, and is what these tests are for:
//
//   - `propOf` coalesces an ABSENT key and an explicit undefined to NULL, so a direct read must
//     give the same null the generic path gives — not `undefined`, which would key differently
//     in the dedup set and could print as a missing column.
//   - a clause `WHERE` still needs the binding (`satisfies` takes it), so the set must still
//     happen when there is a gate.
//   - an expression that is NOT a bare property (`n.age / 2`, a function call) must keep taking
//     the generic evaluator.
//   - a `LET`-bound projection resolves through `bound.expr`, so it specializes when THAT is a
//     bare property and not otherwise.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: ['P'], properties: props });

  v('a', { k: 3, other: 'x' });
  v('b', { k: 1, other: 'y' });
  v('c', { k: 3, other: 'z' });
  v('d', { k: null, other: 'w' });
  // No `k` at all — `propOf` must read this as the SAME null as `d`'s explicit one, so the two
  // collapse to a single distinct value.
  v('e', { other: 'v' });
  v('f', { k: 1, other: 'u' });

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

describe('a direct property read gives exactly what the generic evaluator gave', () => {
  test('DISTINCT over a bare property', () => {
    // Nulls sort LAST under the engine default, so the order is 1, 3, null.
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS x ORDER BY x')).toEqual([
      { x: 1 },
      { x: 3 },
      { x: null },
    ]);
  });

  test('and agrees with the general path', () => {
    const q = 'MATCH (n:P) RETURN DISTINCT n.k AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('an ABSENT key and an explicit null are the same distinct value', () => {
    // `d` has `k: null` and `e` has no `k`. Both read as null, so there is ONE null row, not two.
    const rows = query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS x');

    expect(rows.filter((r) => r.x === null).length).toBe(1);
  });

  test('a key NO vertex carries is one null row, not undefined', () => {
    const rows = query(g, 'MATCH (n:P) RETURN DISTINCT n.missing AS x');

    expect(rows).toEqual([{ x: null }]);
    // The distinction that matters: `null`, not a column that went missing.
    expect(Object.hasOwn(rows[0], 'x')).toBe(true);
  });
});

describe('count mode takes the same read and keeps its null rule', () => {
  test('count(DISTINCT n.k) does not count nulls', () => {
    // Distinct non-null values are 3 and 1, so 2 — the null from `d`/`e` is excluded.
    expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c')).toEqual([{ c: 2 }]);
  });

  test('count(DISTINCT) over a key nobody carries is 0, not 1', () => {
    expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT n.missing) AS c')).toEqual([{ c: 0 }]);
  });
});

describe('the binding is still set when something else reads it', () => {
  test('a clause WHERE still filters', () => {
    // `satisfies` takes the binding, so skipping the set would break the gate rather than just
    // slow it down. Only `k = 3` survives.
    expect(query(g, 'MATCH (n:P) WHERE n.k > 1 RETURN DISTINCT n.k AS x ORDER BY x')).toEqual([
      { x: 3 },
    ]);
  });

  test('a gated count agrees too', () => {
    expect(query(g, 'MATCH (n:P) WHERE n.k > 1 RETURN count(DISTINCT n.k) AS c')).toEqual([
      { c: 1 },
    ]);
  });

  test('a gate that reads a DIFFERENT property than the projection', () => {
    // The gate reads `other` while the projection reads `k`, so the binding is load-bearing for
    // a key the direct read never touches.
    expect(query(g, "MATCH (n:P) WHERE n.other = 'z' RETURN DISTINCT n.k AS x ORDER BY x")).toEqual(
      [{ x: 3 }],
    );
  });
});

describe('a non-property expression keeps the generic evaluator', () => {
  test('arithmetic over a property', () => {
    const q = 'MATCH (n:P) RETURN DISTINCT n.k / 2 AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('a function call over a property', () => {
    const q = 'MATCH (n:P) RETURN DISTINCT abs(n.k) AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('PROPERTY_EXISTS carries a variable and a key but is NOT a property read', () => {
    // The distinguishing input for the `kind === 'prop'` check. A `property_exists` node has both
    // `.variable` and `.key`, so a guard that only compared the variable would specialize it and
    // return the property's VALUE where the answer is a BOOLEAN. `e` carries no `k`.
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT property_exists(n, k) AS x')).toEqual([
      { x: true },
      { x: false },
    ]);
  });

  test('and in count mode, where it must count booleans not values', () => {
    // Values would give 3 distinct (3, 1, null); booleans give 2.
    expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT property_exists(n, k)) AS c')).toEqual([
      { c: 2 },
    ]);
  });
});

describe('a LET-bound projection resolves through its expression', () => {
  test('LET of a bare property specializes and keeps the LET column name', () => {
    // The column is `a` (the RETURN item), not `n.k` — the `LET` names a binding, not a column.
    expect(query(g, 'MATCH (n:P) LET a = n.k RETURN DISTINCT a ORDER BY a')).toEqual([
      { a: 1 },
      { a: 3 },
      { a: null },
    ]);
  });

  test('LET of an expression does not specialize, and still agrees', () => {
    const q = 'MATCH (n:P) LET a = n.k / 2 RETURN DISTINCT a ORDER BY a';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });
});

describe('the far end of a hop reads directly too', () => {
  const h = new Graph();
  const mk = (id: string, k: unknown) => h.addVertex({ id, labels: ['P'], properties: { k } });
  const [s1, s2, f1, f2, f3] = [mk('s1', 0), mk('s2', 0), mk('f1', 7), mk('f2', 8), mk('f3', 7)];

  h.addEdge({ from: s1, to: f1, labels: ['T'], properties: {} });
  h.addEdge({ from: s1, to: f2, labels: ['T'], properties: {} });
  h.addEdge({ from: s2, to: f3, labels: ['T'], properties: {} });
  // An unreached vertex, so the walk cannot simply be reading every vertex's `k`.
  mk('f4', 99);

  test('DISTINCT over the far end', () => {
    expect(query(h, 'MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.k AS x ORDER BY x')).toEqual([
      { x: 7 },
      { x: 8 },
    ]);
  });

  test('count(DISTINCT) over the far end', () => {
    expect(query(h, 'MATCH (a:P)-[:T]->(f) RETURN count(DISTINCT f.k) AS c')).toEqual([{ c: 2 }]);
  });
});
