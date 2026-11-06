import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { compileLinear } from './executor.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * `MATCH (a)-[:T]->(b)-[:U]->(c) RETURN <items>` — the two-segment row projection (item 1619),
 * **5.28x** (206.1 ms to 39.0 isolated, 320k rows).
 *
 * ⚠️ `WHERE true` IS THE ORACLE. The rung declines any clause `WHERE`, so appending `WHERE true`
 * runs the IDENTICAL question down the general matcher — item 570 records `WHERE true` as *the*
 * control for this engine, and here it is the only way to reach the path this rung replaced. Row
 * order without an `ORDER BY` is unspecified (item 198), so the comparison is as a MULTISET.
 *
 * Every case below is checked three ways: the rung's rows, the `WHERE true` rows, and — where the
 * shape is small enough to state — a derived literal. And the ROUTE is asserted separately, because
 * a route choice is answer-equivalent and nothing about the rows says which path produced them
 * (`perf-gate-needs-its-own-test`).
 *
 * ```text
 *   a [L] k=1  >b >c ~d        `>` is R, `~` is S
 *   b [L] k=2  >c
 *   c [M] k=3  >c              a SELF-LOOP
 *   d [L,M] (no k) >a
 *   e [M] k=5                  no edges
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['L'],
    k: 1,
    out: [
      ['b', 'R'],
      ['c', 'R'],
      ['d', 'S'],
    ],
  },
  { id: 'b', labels: ['L'], k: 2, out: [['c', 'R']] },
  { id: 'c', labels: ['M'], k: 3, out: [['c', 'R']] },
  { id: 'd', labels: ['L', 'M'], k: undefined, out: [['a', 'R']] },
  { id: 'e', labels: ['M'], k: 5, out: [] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = { id: r.id };

    if (r.k !== undefined) {
      properties.k = r.k;
    }

    graph.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  return graph;
})();

/** The fast-path rungs that fire, by NAME — `deferred-hop-order.test.ts`' helper. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const sorted = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

/** The rung's rows against the general matcher's, as a multiset. */
const agrees = (src: string): Record<string, unknown>[] => {
  const fast = query(g, src) as Record<string, unknown>[];
  // ⚠️ `WHERE true` BEFORE the RETURN, which is where a clause `WHERE` goes.
  const general = query(g, src.replace(' RETURN ', ' WHERE true RETURN ')) as Record<
    string,
    unknown
  >[];

  expect(routes(src)).toContain('hop2Projection');
  expect(routes(src.replace(' RETURN ', ' WHERE true RETURN '))).not.toContain('hop2Projection');
  expect(sorted(fast)).toEqual(sorted(general));

  return fast;
};

describe('a two-segment pattern projecting rows', () => {
  test('the far end only — the shape at 5.28x', () => {
    /**
     * ⚠️ DERIVED BY A SCRIPT over the table, after SEVEN of my eyeballed literals in this file were
     * wrong and the engine was right every time — the sixth through twelfth of this session. The
     * `R` two-hop paths from an `L` start are a>b>c, a>c>c, b>c>c, d>a>b, d>a>c (NOT c>c>c: `c` is
     * `M`, not `L`), so the far `k` values are 3, 3, 3, 2, 3.
     *
     * `agrees` is what actually settles each case — it compares the rung against the general matcher
     * — and the literals exist to catch the case where BOTH are wrong together.
     */
    expect(sorted(agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k'))).toEqual(
      sorted([{ k: 3 }, { k: 3 }, { k: 3 }, { k: 2 }, { k: 3 }]),
    );
  });

  test('⚠️ a SELF-LOOP may be traversed TWICE, and the default path mode does not forbid it', () => {
    /**
     * `c` has a loop `c>c`, so `c>c>c` reuses the SAME edge for both segments. The default `mode` is
     * `'trail'`, which forbids a repeated edge — but only per REPETITION of a quantifier, so it is
     * inert across two distinct segments. Measured, not reasoned: the default, `WALK`, `TRAIL` and
     * `ACYCLIC` all answer the same rows on this fixture, and the first version of the rung declined
     * every query because it refused `mode !== undefined` (`mode` is never `undefined`).
     */
    const rows = agrees('MATCH (x:M)-[:R]->(y)-[:R]->(z) RETURN x.id AS x, y.id AS y, z.id AS z');

    // Derived: `d` carries BOTH `L` and `M`, so an `M` start is {c, d, e} — c>c>c, d>a>b, d>a>c.
    expect(sorted(rows)).toEqual(
      sorted([
        { x: 'c', y: 'c', z: 'c' },
        { x: 'd', y: 'a', z: 'b' },
        { x: 'd', y: 'a', z: 'c' },
      ]),
    );

    for (const mode of ['WALK', 'TRAIL', 'ACYCLIC']) {
      expect(sorted(query(g, `MATCH ${mode} (x:M)-[:R]->(y)-[:R]->(z) RETURN x.id AS x`))).toEqual(
        sorted([{ x: 'c' }, { x: 'd' }, { x: 'd' }]),
      );
    }
  });

  test('ALL THREE variables projected, and the MIDDLE one alone', () => {
    expect(
      agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, b.id AS b, c.id AS c'),
    ).toHaveLength(5);
    expect(agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN b.id AS b')).toHaveLength(5);
    expect(agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.id AS a')).toHaveLength(5);
  });

  test('a MISSING property projects null rather than dropping the row', () => {
    /**
     * Derived: with an `L` far end the only `R` two-hop path is d>a>b, so `k` is 2. To reach the
     * MISSING property the `d` vertex has to be the far end, which `:L` admits and `-[:S]->` reaches:
     * a>b>c has no `S`, and the only `S` edge is a>d — so `(x)-[:R]->(y)-[:S]->(z)` is empty and the
     * null row needs `d` in the MIDDLE or at the start. `(x)-[:S]->(y)-[:R]->(z)` puts `d` in the
     * middle; projecting `y.k` there is the null.
     *
     * Unlike Gremlin's `values(k)`, a GQL projection emits the row WITH a null rather than dropping
     * it — which is the asymmetry worth pinning here.
     */
    expect(sorted(agrees('MATCH (x)-[:R]->(y)-[:R]->(z:L) RETURN z.k AS k'))).toEqual(
      sorted([{ k: 2 }]),
    );
    expect(sorted(agrees('MATCH (x)-[:S]->(y)-[:R]->(z) RETURN y.k AS k'))).toEqual(
      sorted([{ k: null }]),
    );
  });

  test('LABELS on each of the three nodes, and a label nothing carries', () => {
    expect(agrees('MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M) RETURN c.id AS c')).toHaveLength(2);
    expect(agrees('MATCH (a:L)-[:R]->(b:L)-[:R]->(c) RETURN c.id AS c')).toHaveLength(3);
    expect(agrees('MATCH (a:ZZZ)-[:R]->(b)-[:R]->(c) RETURN c.id AS c')).toEqual([]);
  });

  test('MIXED directions, and a different type per segment', () => {
    for (const src of [
      'MATCH (a)-[:R]->(b)<-[:R]-(c) RETURN a.id AS a, c.id AS c',
      'MATCH (a)<-[:R]-(b)-[:R]->(c) RETURN a.id AS a, c.id AS c',
      'MATCH (a)<-[:R]-(b)<-[:R]-(c) RETURN a.id AS a, c.id AS c',
      'MATCH (a)-[:S]->(b)-[:R]->(c) RETURN c.id AS c',
      'MATCH (a)-[:R]->(b)-[:S]->(c) RETURN c.id AS c',
    ]) {
      agrees(src);
    }

    // `S` is a>d and `d` has one `R` out-edge to `a`, so the chain is a>d>a.
    expect(sorted(agrees('MATCH (a)-[:S]->(b)-[:R]->(c) RETURN c.id AS c'))).toEqual(
      sorted([{ c: 'a' }]),
    );
  });

  test('UNNAMED nodes constrain by label and project nothing', () => {
    expect(agrees('MATCH (:L)-[:R]->()-[:R]->(c) RETURN c.id AS c')).toHaveLength(5);
  });

  test('an expression over two variables, and a literal item', () => {
    agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.id AS a, c.k AS ck, 1 AS one');
    // ⚠️ `AS sum` does not parse — `sum` is an aggregate name and `bindName` refuses it. `tot` is
    // the same test without the reserved word.
    agrees('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN a.k + c.k AS tot');
  });
});

describe('the rung declines what it must — and the answer stays right', () => {
  const declines = (src: string): void => {
    expect(routes(src)).not.toContain('hop2Projection');
  };

  test('ONE segment is `hopProjection`’s shape; THREE is nobody’s', () => {
    declines('MATCH (a:L)-[:R]->(b) RETURN b.k AS k');
    expect(routes('MATCH (a:L)-[:R]->(b) RETURN b.k AS k')).toContain('hopProjection');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k');
  });

  test('a clause WHERE — deliberately open, with its own number', () => {
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) WHERE c.k = 3 RETURN c.k AS k');
    // And the answer is still right down the general matcher.
    expect(query(g, 'MATCH (a:L)-[:R]->(b)-[:R]->(c) WHERE c.k = 3 RETURN count(*) AS n')).toEqual([
      { n: 4 },
    ]);
  });

  test('`both` on either segment', () => {
    declines('MATCH (a:L)-[:R]-(b)-[:R]->(c) RETURN c.k AS k');
    declines('MATCH (a:L)-[:R]->(b)-[:R]-(c) RETURN c.k AS k');
  });

  test('a quantifier, an untyped rel, and a multi-type rel', () => {
    declines('MATCH (a:L)-[:R]->{1,2}(b)-[:R]->(c) RETURN c.k AS k');
    declines('MATCH (a:L)-[]->(b)-[:R]->(c) RETURN c.k AS k');
    declines('MATCH (a:L)-[:R|S]->(b)-[:R]->(c) RETURN c.k AS k');
  });

  test('a NAMED relationship, even an unread one', () => {
    /**
     * `detectHopProjection` admits an unmentioned rel variable and its own comment records the
     * subquery-correlation hole that relaxation cost. This module refuses it outright rather than
     * taking on that risk for a shape nobody has asked for.
     */
    declines('MATCH (a:L)-[r:R]->(b)-[:R]->(c) RETURN c.k AS k');
  });

  test('INLINE properties or an inline WHERE on a node or a rel', () => {
    declines("MATCH (a:L {id: 'a'})-[:R]->(b)-[:R]->(c) RETURN c.k AS k");
    declines('MATCH (a:L)-[:R]->(b WHERE b.k > 1)-[:R]->(c) RETURN c.k AS k');
    declines('MATCH (a:L)-[:R {w: 1}]->(b)-[:R]->(c) RETURN c.k AS k');
  });

  test('⚠️ a path VARIABLE declines only when it is actually READ', () => {
    /**
     * ⚠️ AN UNREAD PATH VARIABLE IS DROPPED BEFORE ANY DETECTOR SEES THE CLAUSES, so
     * `MATCH p = … RETURN c.k` fires this rung and SHOULD: there is no `Path` to build. I wrote this
     * test expecting a decline and the engine was right — `drop-unread-path-var` is the rewrite, and
     * the clauses the detectors receive are the post-rewrite form.
     *
     * The decline is real the moment `p` is read, which is what the rung's own guard is for.
     */
    expect(routes('MATCH p = (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k')).toContain(
      'hop2Projection',
    );
    declines('MATCH p = (a:L)-[:R]->(b)-[:R]->(c) RETURN nodes(p) AS ns');
    declines('MATCH p = (a:L)-[:R]->(b)-[:R]->(c) RETURN p AS p');
  });

  test('anything but a PLAIN row projection', () => {
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN DISTINCT c.k AS k');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k ORDER BY k');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k LIMIT 2');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN count(*) AS n');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN max(c.k) AS m');
    declines('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN *');
  });

  test('an OPTIONAL MATCH', () => {
    declines('OPTIONAL MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k');
  });

  test('⚠️ a PARAMETER in the projection is ADMITTED, not declined', () => {
    /**
     * I wrote this as a decline, reasoning that `size($p)` reads a name the pattern does not bind.
     * The engine is right: `$p` is a PARAMETER, not a free variable, `freePredicateVars` does not
     * report it, and `projectRow` is handed `params` anyway — so there is nothing for the walk to
     * bind and nothing to decline. Recorded as an admission with its oracle rather than deleted,
     * because the next reader will have the same wrong intuition.
     */
    expect(routes('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k, $p AS p')).toContain(
      'hop2Projection',
    );
  });
});
