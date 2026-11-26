/*
 * Item 2177 — `count(b)` becomes `count(*)` when `b` is bound by a non-optional pattern.
 *
 * ```text
 *     one shape per process, median of reps 7-12
 *     row                          BEFORE      NEW
 *     var-length count(b)          533.92     8.61    62.0x
 *     two-hop count(c)              17.08     0.20    85.4x
 *     var-length count(*)  [ctl]     8.86     6.38    flat
 *     count(a.k)           [ctl]     3.26     3.17    flat
 *     OPTIONAL count(b)    [ctl]     8.34     0.00    composes (see below)
 * ```
 *
 * **THIS IS THE "EQUIVALENT SPELLINGS MUST COST THE SAME" BUG CLASS.** Every count rung gates on a
 * STAR projection, so naming the variable fell off ALL of them onto the general matcher — **the same
 * answer, 62x and 85x apart.** No correctness test could have caught it, which is why the repo keeps a
 * spelling probe; this pair was not in it.
 *
 * **THE SOUNDNESS ARGUMENT, AND IT IS NOT SYMMETRIC**: `count(x)` counts rows where `x` is NON-NULL,
 * `count(*)` counts rows. A plain `MATCH` only emits rows where the pattern matched, so a pattern variable
 * is always bound and the two agree. Under `OPTIONAL MATCH` they genuinely differ, and the tests below pin
 * both directions.
 *
 * IMPORTS FROM `./index.js`, THE SOURCE — item 2169 lost a mutation round to importing the built dist.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `a -> b`, `b` has no out-edge, `c` is isolated. The isolated and leaf nodes are what make the
 * OPTIONAL cases differ from the plain ones — without them every row matches and the distinction is
 * invisible.
 */
const g = (): Graph => {
  const graph = new Graph();

  for (const id of ['a', 'b', 'c']) {
    graph.addVertex({ id, labels: ['P'], properties: { k: 1 } });
  }

  graph.addEdge({
    id: 'e',
    from: graph.getVertexById('a')!,
    to: graph.getVertexById('b')!,
    labels: ['E'],
    properties: {},
  });

  return graph;
};

const row = (q: string): Record<string, unknown> => {
  const out = query(g(), q) as unknown as { rows?: Record<string, unknown>[] };

  return (out.rows ?? (out as unknown as Record<string, unknown>[]))[0];
};

describe('count(bound var) becomes count(*) (item 2177)', () => {
  describe('the rewritten spellings agree with the star spelling', () => {
    test.each([
      ['plain hop', 'MATCH (a:P)-[:E]->(x:P) RETURN count(%) AS c', 1],
      ['var-length 1..2', 'MATCH (a:P)-[:E]->{1,2}(x:P) RETURN count(%) AS c', 1],
      ['two hops', 'MATCH (a:P)-[:E]->(x:P)-[:E]->(y:P) RETURN count(%) AS c', 0],
      ['a bare scan', 'MATCH (x:P) RETURN count(%) AS c', 3],
    ])('%s', (_name, shape, want) => {
      /*
       * The ORACLE is the star spelling on the same fixture, and the literal is derived: one edge
       * a->b, so one matched pair; no two-hop path exists; three vertices.
       */
      const named = row(shape.replace('%', 'x')).c;
      const star = row(shape.replace('%', '*')).c;

      expect(named).toBe(star);
      expect(named).toBe(want);
    });

    test('the START variable rewrites too, not just the far one', () => {
      expect(row('MATCH (a:P)-[:E]->(x:P) RETURN count(a) AS c').c).toBe(1);
    });

    test('an EDGE variable is a pattern variable as well', () => {
      expect(row('MATCH (a:P)-[r:E]->(x:P) RETURN count(r) AS c').c).toBe(1);
    });
  });

  describe('OPTIONAL MATCH, where count(x) and count(*) genuinely DIFFER', () => {
    test('count(x) counts MATCHES; count(*) counts ROWS including null-padded ones', () => {
      /*
       * THE CASE THE REWRITE MUST NOT BREAK. Three vertices each produce a row; only `a` has an
       * out-edge, so `x` is null on two of them. `count(x)` must stay 1 while `count(*)` is 3 — if the
       * rewrite fired blindly, `count(x)` would answer 3.
       */
      expect(row('MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(x:P) RETURN count(x) AS c').c).toBe(1);
      expect(row('MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(x:P) RETURN count(*) AS c').c).toBe(3);
    });

    test('BOTH in one projection, which is where the two passes must not collide', () => {
      /*
       * `unoptionalizeForAggregate` refuses a projection containing a STAR count (its own comment: "A
       * STAR count is the one aggregate that sees a null-filled row"), so the clause keeps `optional` and
       * this pass then declines as well. If either pass fired here the two columns would be equal.
       */
      const r = row(
        'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(x:P) RETURN count(x) AS c, count(*) AS d',
      );

      expect(r.c).toBe(1);
      expect(r.d).toBe(3);
    });

    test('an ANCHOR extended by an OPTIONAL hop is still always bound', () => {
      /*
       * THE SHAPE A FIRST VERSION OF THE GATE WRONGLY REFUSED. `x` is bound by the plain `MATCH`, and
       * the OPTIONAL only adds a column — `x` is never null, so `count(x)` must equal `count(*)` (3 rows:
       * one per vertex, since only `a` matches the optional hop but all three survive it).
       */
      expect(row('MATCH (x:P) OPTIONAL MATCH (x)-[:E]->(y:P) RETURN count(x) AS c').c).toBe(3);
      expect(row('MATCH (x:P) OPTIONAL MATCH (x)-[:E]->(y:P) RETURN count(*) AS c').c).toBe(3);
      // And the OPTIONAL's OWN variable still counts matches only.
      expect(row('MATCH (x:P) OPTIONAL MATCH (x)-[:E]->(y:P) RETURN count(y) AS c').c).toBe(1);
    });

    test('a var-length OPTIONAL hop keeps the distinction', () => {
      expect(row('MATCH (a:P) OPTIONAL MATCH (a)-[:E]->{1,2}(x:P) RETURN count(x) AS c').c).toBe(1);
    });
  });

  describe('the refusals', () => {
    test('count(a.k) is NOT a bound variable — a missing property is null', () => {
      /*
       * THE BOUNDARY. `count(a.k)` counts rows whose `k` is non-null, which is genuinely fewer than
       * `count(*)` when a property is absent. Here one vertex loses `k`, so the two must differ.
       */
      const h = g();

      h.addVertex({ id: 'nok', labels: ['P'], properties: {} });

      const out = query(h, 'MATCH (a:P) RETURN count(a.k) AS c, count(*) AS d') as unknown as {
        rows?: Record<string, unknown>[];
      };
      const [r] = out.rows ?? (out as unknown as Record<string, unknown>[]);

      expect(r.c).toBe(3);
      expect(r.d).toBe(4);
    });

    test('count(DISTINCT x) counts VALUES, not rows', () => {
      /*
       * Two edges land on the same target, so the distinct count is 1 where the row count is 2 — the
       * rewrite must not touch it.
       */
      const h = g();

      h.addEdge({
        id: 'e2',
        from: h.getVertexById('c')!,
        to: h.getVertexById('b')!,
        labels: ['E'],
        properties: {},
      });

      const out = query(
        h,
        'MATCH (a:P)-[:E]->(x:P) RETURN count(DISTINCT x) AS c, count(*) AS d',
      ) as unknown as { rows?: Record<string, unknown>[] };
      const [r] = out.rows ?? (out as unknown as Record<string, unknown>[]);

      expect(r.c).toBe(1);
      expect(r.d).toBe(2);
    });

    test('an unbound name is not rewritten into a star count', () => {
      /*
       * `count(zzz)` names nothing in the pattern. Whatever the engine does with it — answer 0, or
       * raise — it must not become `count(*)`'s 3, which is what an ungated rewrite would produce.
       */
      let got: unknown = 'threw';

      try {
        got = row('MATCH (x:P) RETURN count(zzz) AS c').c;
      } catch {
        got = 'threw';
      }

      expect(got).not.toBe(3);
    });
  });

  test('a grouped projection keeps its groups', () => {
    // `count(x)` beside a grouping key must still group, not collapse to one row.
    const out = query(g(), 'MATCH (x:P) RETURN x.k AS k, count(x) AS c') as unknown as {
      rows?: Record<string, unknown>[];
    };
    const rows = out.rows ?? (out as unknown as Record<string, unknown>[]);

    expect(rows).toHaveLength(1);
    expect(rows[0].c).toBe(3);
  });
});
