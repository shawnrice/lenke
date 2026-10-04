import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectHopProjection` (audit item 138): `MATCH (a:L)-[:T]->(x) RETURN <exprs over x>`
// builds rows directly from the hop, with one reused binding and no generator stack.
//
// Every test compares against the SAME query routed through the general path, and compares
// ROW ARRAYS IN ORDER rather than as sets — row order is unspecified for an unordered query,
// so this path would be allowed to differ, but it is written to match and a silent
// reordering would churn callers for nothing. Comparing in order is also what catches a
// walk that visits the right edges in the wrong nesting.
const build = (): Graph => {
  const g = new Graph();
  // Every vertex carries `name`, which `viaGeneral` relies on; v3 has NO `age`, so an
  // absent property must project as null rather than being skipped.
  const spec: [string, string[], Record<string, unknown>][] = [
    ['v0', ['P'], { name: 'a', age: 10 }],
    ['v1', ['P', 'Q'], { name: 'b', age: 20 }],
    ['v2', ['P'], { name: 'c', age: 30 }],
    ['v3', ['P', 'Q'], { name: 'd' }],
    ['v4', ['P'], { name: 'e', age: 50 }],
    // Not a `P`, so it is never a start candidate but can be a far endpoint.
    ['v5', ['R'], { name: 'f', age: 60 }],
  ];
  const vs = new Map<string, ReturnType<Graph['addVertex']>>();

  for (const [id, labels, properties] of spec) {
    vs.set(id, g.addVertex({ id, labels, properties }));
  }

  const edge = (from: string, to: string, label: string): void => {
    const f = vs.get(from);
    const t = vs.get(to);

    if (f === undefined || t === undefined) {
      throw new Error('fixture lost a vertex');
    }

    g.addEdge({ from: f, to: t, labels: [label], properties: { w: 1 } });
  };

  edge('v0', 'v1', 'T');
  edge('v0', 'v2', 'T');
  edge('v0', 'v1', 'T'); // PARALLEL: the same pair twice, so the row must appear twice
  edge('v1', 'v1', 'T'); // SELF-LOOP
  edge('v1', 'v3', 'T');
  edge('v2', 'v5', 'T'); // far endpoint outside the start label
  edge('v0', 'v3', 'S'); // a second type, so a typed hop differs from an untyped one
  // v4 has NO out-edges at all and must contribute nothing.

  return g;
};

/**
 * The same question through the GENERAL path, by adding a clause `WHERE` — which
 * `detectHopProjection` refuses outright. `a.name = a.name` is true for every row because
 * every vertex carries `name`; an absent property would make it NULL and drop rows, which is
 * exactly why a present one is used.
 */
const viaGeneral = (g: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');
  const start = /MATCH \((\w+)/.exec(q)?.[1] ?? 'a';

  return query(g, `${q.slice(0, i)} WHERE ${start}.name = ${start}.name${q.slice(i)}`);
};

/** Fused rows and general rows, for an in-order comparison. */
const bothWays = (g: Graph, q: string) => [query(g, q), viaGeneral(g, q)] as const;

describe('fused hop projection', () => {
  test('rows and their ORDER match the general path', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n');

    // v0→v1, v0→v2, v0→v1 (parallel), then v1→v1 (self-loop), v1→v3, then v2→v5.
    expect(fast).toEqual([{ n: 'b' }, { n: 'c' }, { n: 'b' }, { n: 'b' }, { n: 'd' }, { n: 'f' }]);
    expect(fast).toEqual(slow);
  });

  test('a parallel edge yields its row twice', () => {
    const g = build();
    const rows = query(g, 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n') as { n: string }[];

    expect(rows.filter((r) => r.n === 'b')).toHaveLength(3); // two parallel + the self-loop
  });

  test('an absent property projects as null, not a dropped row', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x) RETURN x.age AS a');

    expect(fast).toEqual([{ a: 20 }, { a: 30 }, { a: 20 }, { a: 20 }, { a: null }, { a: 60 }]);
    expect(fast).toEqual(slow);
  });

  test('several items keep their COLUMN order', () => {
    const g = build();
    // Column order is observable in both engines' output bytes (see the audit's column-order
    // item), so the projection's item order has to survive this path.
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x) RETURN x.age AS a, x.name AS n');

    expect(Object.keys(fast[0] as object)).toEqual(['a', 'n']);
    expect(fast).toEqual(slow);
  });

  test('a computed expression over the far endpoint works', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x) RETURN x.age + 1 AS a');

    expect(fast).toEqual(slow);
    expect((fast[0] as { a: number }).a).toBe(21);
  });

  test('the far LABEL is applied', () => {
    const g = build();
    // `Q` is on v1 and v3: v0→v1, v0→v1 (parallel), v1→v1, v1→v3.
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x:Q) RETURN x.name AS n');

    expect(fast).toEqual([{ n: 'b' }, { n: 'b' }, { n: 'b' }, { n: 'd' }]);
    expect(fast).toEqual(slow);
  });

  test('the reversed spelling walks the other index', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P)<-[:T]-(x) RETURN x.name AS n');

    expect(fast).toEqual(slow);
    // Edges INTO the P vertices, grouped by target in candidate order: v1 has three
    // in-edges (v0 twice, itself), v2 one, v3 one.
    expect(fast).toHaveLength(5);
  });

  test('a start vertex with no out-edges contributes nothing', () => {
    const g = build();
    const rows = query(g, 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n');

    // v4 is a `P` with no out-edges; nothing in the output can come from it.
    expect(rows).toHaveLength(6);
  });

  test('a NON-SIMPLE start label declines, because the seed would not be filtered', () => {
    const g = build();
    // `candidateVertices` seeds from a label bucket only for a SIMPLE label; for a
    // conjunction it yields every vertex and leaves the filtering to its caller — which this
    // walk does not do. So the guard is load-bearing, and mutation caught that no test
    // covered it: removing it survived everything else here.
    //
    // `P&Q` is v1 and v3. v1 has two out-edges (its self-loop and v1→v3) and v3 has none, so
    // the honest answer is 2 rows where an unfiltered seed would give all 6.
    const q = 'MATCH (a:P&Q)-[:T]->(x) RETURN x.name AS n';
    const rows = query(g, q);

    expect(rows).toEqual([{ n: 'b' }, { n: 'd' }]);
    expect(rows).toEqual(viaGeneral(g, q));
    expect(rows).not.toHaveLength(6);
  });

  test('a complex FAR label is fine, since it is checked per edge', () => {
    const g = build();
    // Unlike the start label, the far label goes through `matchesLabel`, which handles any
    // label expression — so this stays on the fast path and must still be right.
    const q = 'MATCH (a:P)-[:T]->(x:P&Q) RETURN x.name AS n';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('a path MODE is a no-op on a single hop, self-loop included', () => {
    // `ACYCLIC` forbids a repeated NODE, and a self-loop repeats one — so this is where a
    // mode could change the rows and the fused path, which applies no restrictor, would be
    // wrong. Measured against the general path: this engine applies TRAIL/SIMPLE/ACYCLIC/
    // WALK per repetition, so on a single non-quantified hop every mode is a no-op and the
    // self-loop row survives in BOTH paths. Verified rather than assumed, and asserted here
    // so a change to the general path cannot quietly make the fused one wrong.
    const g = new Graph();
    const a = g.addVertex({ id: 'w0', labels: ['P'], properties: { name: 'a' } });
    const b = g.addVertex({ id: 'w1', labels: ['P'], properties: { name: 'b' } });

    g.addEdge({ from: a, to: b, labels: ['T'], properties: {} });
    g.addEdge({ from: a, to: a, labels: ['T'], properties: {} });

    for (const mode of ['', 'WALK ', 'TRAIL ', 'SIMPLE ', 'ACYCLIC ']) {
      const q = `MATCH ${mode}(a:P)-[:T]->(x) RETURN x.name AS n`;

      expect(query(g, q)).toEqual([{ n: 'b' }, { n: 'a' }]);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    }
  });

  test('an unlabelled start scans every vertex, in the same order as the general path', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a)-[:T]->(x) RETURN x.name AS n');

    expect(fast).toEqual(slow);
  });
});

describe('fused hop projection declines where it must', () => {
  // Each of these must still answer correctly, by whatever path it takes. The assertion is
  // agreement with the general spelling, which is the only claim statable without
  // re-deriving each modifier's meaning.
  const cases: [string, string][] = [
    ['reads the START variable', 'MATCH (a:P)-[:T]->(x) RETURN a.name AS n'],
    ['reads BOTH ends', 'MATCH (a:P)-[:T]->(x) RETURN a.name AS m, x.name AS n'],
    ['a named REL variable', 'MATCH (a:P)-[r:T]->(x) RETURN x.name AS n'],
    ['DISTINCT', 'MATCH (a:P)-[:T]->(x) RETURN DISTINCT x.name AS n'],
    ['ORDER BY', 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n ORDER BY n'],
    ['LIMIT', 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n LIMIT 2'],
    ['an aggregate', 'MATCH (a:P)-[:T]->(x) RETURN count(*) AS n'],
    ['an untyped hop', 'MATCH (a:P)-[]->(x) RETURN x.name AS n'],
    ['a type disjunction', 'MATCH (a:P)-[:T|S]->(x) RETURN x.name AS n'],
    ['a BOTH direction', 'MATCH (a:P)-[:T]-(x) RETURN x.name AS n'],
    ['an inline far constraint', 'MATCH (a:P)-[:T]->(x {name: "b"}) RETURN x.name AS n'],
    ['an inline start constraint', 'MATCH (a:P {name: "a"})-[:T]->(x) RETURN x.name AS n'],
    ['a path variable', 'MATCH p = (a:P)-[:T]->(x) RETURN x.name AS n'],
    ['two segments', 'MATCH (a:P)-[:T]->(x)-[:T]->(y) RETURN x.name AS n'],
    ['a quantified hop', 'MATCH (a:P)-[:T]->{1,2}(x) RETURN x.name AS n'],
  ];

  for (const [name, q] of cases) {
    test(`${name} still answers correctly`, () => {
      const g = build();

      // Compared against the general spelling for EVERY case, including `ORDER BY`, `LIMIT`,
      // `DISTINCT` and aggregates. These were originally exempted on the belief that
      // `viaGeneral`'s inserted `WHERE` could not sit in front of them — it can
      // (`MATCH … WHERE … RETURN … ORDER BY x` is fine), and the exemption meant the
      // projection guard for paging/ordering had NO teeth: mutation in item 143 removed it
      // and nothing failed.
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });
  }

  test('a clause WHERE declines and is actually applied', () => {
    const g = build();
    // The decline that `viaGeneral` itself relies on. `x.age > 25` keeps v2 (30), v3 is
    // null-dropped, v5 (60) stays.
    const rows = query(g, 'MATCH (a:P)-[:T]->(x) WHERE x.age > 25 RETURN x.name AS n');

    expect(rows).toEqual([{ n: 'c' }, { n: 'f' }]);
  });
});
