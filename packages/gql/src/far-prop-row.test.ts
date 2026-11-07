import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import type { Projection } from './ast.js';
import type { CProjection } from './executor.js';
import { farPropRow } from './executor/hop-projection.js';
import { query } from './index.js';

/**
 * `MATCH (a)-[:E]->(b) WHERE … RETURN b.k AS k` builds its row with a DIRECT read instead of the
 * generic `projectRow` (item 1636) — **1.19-1.23x**, non-overlapping across three order-alternated
 * rounds, with the unfiltered twin flat and digests identical.
 *
 * ⚠️ ITEM 1447 BUILT THIS AND REVERTED IT AT −4.8%/+0.7%. Its wiring chose between two closures per
 * CALL through a hoisted local, so `buildRow(binding, far)` was ONE bytecode site that every compile
 * flowed through — polymorphic, which is the exact inline-cache cost the specialization deletes. The
 * route is a SIBLING `return` now. That history is why these tests exist at the boundaries rather
 * than on the happy path: a detector that silently declines everything would measure 0% and look
 * like item 1447 all over again.
 *
 * The fixture is a chain so each vertex has exactly one out-edge, plus the cases that decide the
 * gate:
 *
 * ```text
 *   v0 n=0  >v1        v3 n=3  >v4
 *   v1 n=1  >v2        v4 n=4  >v5
 *   v2 n=2  >v3        v5 n=5          (no out-edge)
 *   w   NO n  >v1      a far end that LACKS the projected key
 * ```
 */
const g = ((): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 6; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i, s: `s${i}` } });
  }

  // ⚠️ `w` carries NO `n`, which is not the same as `n: null`: a direct read must coerce an ABSENT
  // key to NULL exactly as `propOf` does, or the fast and general spellings disagree.
  graph.addVertex({ id: 'w', labels: ['P'], properties: { s: 'sw' } });

  let e = 0;

  for (let i = 0; i < 5; i += 1) {
    graph.addEdge({
      id: `e${e++}`,
      from: graph.getVertexById(`v${i}`) as Vertex,
      to: graph.getVertexById(`v${i + 1}`) as Vertex,
      labels: ['E'],
      properties: {},
    });
  }

  // An edge INTO `w`, so a far end lacking the key is reachable.
  graph.addEdge({
    id: `e${e++}`,
    from: graph.getVertexById('v0') as Vertex,
    to: graph.getVertexById('w') as Vertex,
    labels: ['E'],
    properties: {},
  });

  return graph;
})();

/**
 * A SECOND graph for the DISTINCT case, because it needs a DUPLICATE far value and adding one to the
 * shared fixture above invalidated nine existing literals at once. Two far ends carry `n: 7`, so
 * `DISTINCT` removes exactly one row and the assertion discriminates — which the first version, on a
 * fixture whose rows were already distinct, did not.
 *
 * `s0 > t1, t2` and both `t`s have `n: 7`.
 */
const dupG = ((): Graph => {
  const graph = new Graph();

  graph.addVertex({ id: 's0', labels: ['P'], properties: { n: 0 } });
  graph.addVertex({ id: 't1', labels: ['P'], properties: { n: 7 } });
  graph.addVertex({ id: 't2', labels: ['P'], properties: { n: 7 } });

  for (const [i, to] of ['t1', 't2'].entries()) {
    graph.addEdge({
      id: `d${i}`,
      from: graph.getVertexById('s0') as Vertex,
      to: graph.getVertexById(to) as Vertex,
      labels: ['E'],
      properties: {},
    });
  }

  return graph;
})();

describe('the direct row read answers what the generic projection answers', () => {
  test('the shape at 1.19x — one property off the far variable', () => {
    // DERIVED: far ends with n > 2 are v3 (from v2), v4 (from v3), v5 (from v4).
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN b.n AS n')).toEqual([
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ]);
  });

  test('⚠️ the ROW KEY comes from the ALIAS, not the property name', () => {
    /**
     * The key is taken from the COMPILED item's `name`, which is where the alias rule already
     * lives. A specialization that re-derived "alias ?? source text" would drift from the general
     * path on exactly this spelling.
     */
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN b.n AS zz')).toEqual([
      { zz: 3 },
      { zz: 4 },
      { zz: 5 },
    ]);
  });

  test('⚠️ an ABSENT key reads NULL ON THE SPECIALIZED PATH — the predicate reads another key', () => {
    /**
     * ⚠️ THIS IS THE TEST THE `?? null` MUTANT NEEDED, and the first version of this file did not
     * have it. The unfiltered case below also asserts `{ n: null }` — but an unfiltered projection
     * routes to the FAR-DRIVEN walk, so it never reaches this specialization and the mutant that
     * dropped `?? null` SURVIVED it. Passing for the wrong reason, which is the recurring trap in
     * this file's history (items 1576, 1636).
     *
     * `w` has `s` but no `n`, so filtering on `s` admits it and projecting `n` must coerce the
     * absent key to NULL exactly as `propOf` does.
     */
    expect(query(g, "MATCH (a:P)-[:E]->(b) WHERE b.s = 'sw' RETURN b.n AS n")).toEqual([
      { n: null },
    ]);
  });

  test('an ABSENT key reads NULL on the general path too', () => {
    /**
     * `w` has no `n`, so its row is `{ n: null }` and NOT omitted: a projection drops nothing,
     * unlike Gremlin's `values(k)`.
     *
     * ⚠️ `w` COMES LAST, and I derived it second. An UNFILTERED projection routes to the FAR-DRIVEN
     * walk, which iterates far ENDPOINTS, so the order follows vertex insertion (`w` was added
     * last) and not edge insertion. Verified route-independent: the PRE and POST arms return this
     * identical order, so the specialization does not reorder rows — which matters because GQL row
     * order is unspecified and a test asserting it would otherwise be pinning an accident.
     */
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN b.n AS n')).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
      { n: null },
    ]);
  });

  test('a string-valued property, so the read is not number-specific', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 3 RETURN b.s AS s')).toEqual([
      { s: 's4' },
      { s: 's5' },
    ]);
  });

  test('the FILTER key and the PROJECTED key may differ', () => {
    // Filtering on `s` and projecting `n` — a mutant reading one key for both answers differently.
    expect(query(g, "MATCH (a:P)-[:E]->(b) WHERE b.s = 's4' RETURN b.n AS n")).toEqual([{ n: 4 }]);
  });

  test('a filter on the START with a far projection still answers correctly', () => {
    // The start-only predicate routes to a different closure; the row is still one far property.
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE a.n > 3 RETURN b.n AS n')).toEqual([{ n: 5 }]);
  });
});

describe('the route declines what it must, and the answer is unchanged', () => {
  test('TWO items decline', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 3 RETURN b.n AS n, a.n AS m')).toEqual([
      { n: 4, m: 3 },
      { n: 5, m: 4 },
    ]);
  });

  test('a START property projection declines — it is not the far variable', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 3 RETURN a.n AS n')).toEqual([
      { n: 3 },
      { n: 4 },
    ]);
  });

  test('⚠️ `ORDER BY` declines — the deferred arm rewrites the projection', () => {
    /**
     * `walkProj === proj` is the guard. With ORDER BY, `order.walkProj` is a REDUCED copy whose
     * items are not the AST's, so the detector would read one projection while the walk built rows
     * from another. The answer must still be sorted.
     */
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN b.n AS n ORDER BY n DESC')).toEqual(
      [{ n: 5 }, { n: 4 }, { n: 3 }],
    );
  });

  test('⚠️ DISTINCT declines, and it REMOVES a row so the assertion discriminates', () => {
    /**
     * `dup` carries n=4 like `v4`, so there are SEVEN far ends and SIX distinct values. A route that
     * admitted DISTINCT into the specialization would emit all seven. The first version of this test
     * asserted `toHaveLength(6)` on a fixture with six distinct values out of six rows, which passes
     * either way — and the `plainRowProjection` mutant survived it.
     */
    expect(query(dupG, 'MATCH (a:P)-[:E]->(b) RETURN b.n AS n')).toEqual([{ n: 7 }, { n: 7 }]);
    expect(query(dupG, 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.n AS n')).toEqual([{ n: 7 }]);
  });

  test('a LIMIT declines', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN b.n AS n LIMIT 2')).toHaveLength(2);
  });

  test('⚠️ `ORDER BY` on a DIFFERENT expression — where `walkProj` really diverges', () => {
    /**
     * ⚠️ THE `walkProj === proj` MUTANT NEEDED THIS. Sorting by the projected expression leaves the
     * walk projection equal to the real one, so dropping the guard changed nothing and the mutant
     * survived. Sorting by `b.s` while projecting `b.n` forces the deferred arm to build a REDUCED
     * projection carrying the sort key — and that copy's items are not the AST's, so a detector
     * reading the AST would describe a projection the walk is not building.
     *
     * DERIVED: far ends with n > 2 are v3(s3), v4(s4) and v5(s5); descending by `s` gives s5, s4,
     * s3 — so n = 5, 4, 3.
     */
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN b.n AS n ORDER BY b.s DESC'),
    ).toEqual([{ n: 5 }, { n: 4 }, { n: 3 }]);
  });

  test('an AGGREGATE declines', () => {
    expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(b.n) AS c')).toEqual([{ c: 5 }]);
  });

  test('a non-property expression on the far variable declines', () => {
    // `b.n + 1` is an arithmetic node, not `{kind:'prop'}`.
    expect(query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 3 RETURN b.n + 1 AS n')).toEqual([
      { n: 5 },
      { n: 6 },
    ]);
  });

  test('projecting the far ELEMENT declines', () => {
    const rows = query(g, 'MATCH (a:P)-[:E]->(b) WHERE b.n > 4 RETURN b AS b');

    expect(rows).toHaveLength(1);
    expect((rows[0].b as Vertex).id).toBe('v5');
  });
});

/**
 * ⚠️ THE DETECTOR AS A PURE FUNCTION, because a route choice is ANSWER-EQUIVALENT and four of ten
 * mutants survived the differential tests above by construction — `route/never-taken`,
 * `gate/plain-dropped`, `kind/agg-admitted` and `call/walkproj-guard-dropped`. Nothing that compares
 * ANSWERS can fail on a gate that merely declines, so the gate gets tested directly. Items 1630 and
 * 1631 reached the same conclusion on the Gremlin side.
 */
describe('farPropRow', () => {
  const plain: Projection = { star: false, items: [], distinct: false };
  const cproj = (name: string, isAgg = false): CProjection =>
    ({
      star: false,
      distinct: false,
      aggregating: isAgg,
      countedGroups: false,
      items: [{ name, fn: (() => null) as never, isAgg }],
    }) as unknown as CProjection;

  const prop = (variable: string, key: string): Projection => ({
    ...plain,
    items: [{ expr: { kind: 'prop', variable, key } }],
  });

  test('admits one property off the far variable, row key from the COMPILED name', () => {
    expect(farPropRow(prop('b', 'n'), cproj('zz'), 'b')).toEqual({ rowKey: 'zz', key: 'n' });
  });

  test('declines a property off ANOTHER variable', () => {
    expect(farPropRow(prop('a', 'n'), cproj('n'), 'b')).toBeUndefined();
  });

  test('declines a non-property expression', () => {
    const v: Projection = { ...plain, items: [{ expr: { kind: 'var', name: 'b' } }] };

    expect(farPropRow(v, cproj('b'), 'b')).toBeUndefined();
  });

  test('declines an AGGREGATE item even when its expression looks like a prop', () => {
    // Redundant with the kind check for every spelling the parser produces — an aggregate is a
    // `func` node — so this pins the gate's intent rather than a reachable shape.
    expect(farPropRow(prop('b', 'n'), cproj('n', true), 'b')).toBeUndefined();
  });

  test('declines TWO items, and ZERO items', () => {
    const two: Projection = {
      ...plain,
      items: [
        { expr: { kind: 'prop', variable: 'b', key: 'n' } },
        { expr: { kind: 'var', name: 'a' } },
      ],
    };

    expect(farPropRow(two, cproj('n'), 'b')).toBeUndefined();
    expect(farPropRow({ ...plain, items: [] }, cproj('n'), 'b')).toBeUndefined();
  });

  test('declines every non-plain projection `plainRowProjection` refuses', () => {
    const base = prop('b', 'n');

    expect(farPropRow({ ...base, star: true }, cproj('n'), 'b')).toBeUndefined();
    expect(farPropRow({ ...base, distinct: true }, cproj('n'), 'b')).toBeUndefined();
    expect(farPropRow({ ...base, groupBy: [] }, cproj('n'), 'b')).toBeUndefined();
    expect(
      farPropRow(
        { ...base, orderBy: [{ expr: { kind: 'var', name: 'n' } }] as never },
        cproj('n'),
        'b',
      ),
    ).toBeUndefined();
    expect(
      farPropRow({ ...base, limit: { kind: 'literal', value: 1 } as never }, cproj('n'), 'b'),
    ).toBeUndefined();
    expect(
      farPropRow({ ...base, skip: { kind: 'literal', value: 1 } as never }, cproj('n'), 'b'),
    ).toBeUndefined();
  });

  test('declines when the COMPILED projection has a different item count', () => {
    const c = { ...cproj('n'), items: [] } as unknown as CProjection;

    expect(farPropRow(prop('b', 'n'), c, 'b')).toBeUndefined();
  });
});
