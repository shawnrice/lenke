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

/**
 * The same rows as a MULTISET — order canonicalized away.
 *
 * Row order is unspecified in this engine (as in SQL without ORDER BY), and the cross-engine
 * harness canonicalizes it out on purpose: "Row order is unspecified and canonicalized out on
 * purpose. Column order is not." Since item 167 the fused path may drive the FAR side when the
 * start is unconstrained, which reorders rows and changes nothing else — so the tests whose
 * subject is AGREEMENT compare multisets, while the ones whose subject is the row CONTENT still
 * pin exact values.
 */
const asMultiset = (rows: readonly unknown[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

describe('fused hop projection', () => {
  test('rows and their ORDER match the general path', () => {
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n');

    // v0→v1, v0→v2, v0→v1 (parallel), then v1→v1 (self-loop), v1→v3, then v2→v5.
    // This one still pins the exact ORDER after item 167, and the reason is specific: `P` is
    // NOT vacuous in this fixture (v5 is not a `P`), so a start label has to be applied by
    // iteration and the START-driven walk takes it. Do not read this as a general guarantee
    // that row order is stable — an unconstrained start drives the far side instead.
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

      // A multiset: the claim is that the self-loop row SURVIVES in both paths, which is
      // independent of where it lands. This start is unlabelled, so item 167's far-driven walk
      // takes it and the two paths enumerate in different orders.
      expect(asMultiset(query(g, q))).toEqual(asMultiset([{ n: 'b' }, { n: 'a' }]));
      expect(asMultiset(query(g, q))).toEqual(asMultiset(viaGeneral(g, q)));
    }
  });

  test('an unlabelled start scans every vertex, agreeing with the general path', () => {
    // Was "in the same order as the general path" until item 167. An UNCONSTRAINED start is
    // exactly the case that now drives the far side, so the orders differ by design; the rows
    // are what this test is about.
    const g = build();
    const [fast, slow] = bothWays(g, 'MATCH (a)-[:T]->(x) RETURN x.name AS n');

    expect(asMultiset(fast)).toEqual(asMultiset(slow));
    // And the count is unchanged: one row per edge, so a dropped or duplicated row shows here.
    expect(fast.length).toBe(slow.length);
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

// Item 444: a NAMED but UNMENTIONED relationship takes the fast path.
//
// The gate used to refuse `-[e:E]->` outright, and its comment called that "defensive, not
// load-bearing". It cost 3.7x — `MATCH (a:P)-[e:E]->(b) RETURN count(b.k)` measured 4.6ms
// against 1.25ms for the identical query spelled `-[:E]->` — and it WAS load-bearing, through
// a hole the comment did not name: `freePredicateVars` adds a subquery pattern's own binding
// names to its bound set, so an inner `-[r:T]->` CORRELATING on an outer `r` is reported as
// reading nothing at all. `mentionsName` closes that by asking a different question — does the
// name appear anywhere — which no free-variable analysis can be fooled about.
describe('a named relationship on the hop fast path (item 444)', () => {
  // TWO parallel edges between the same pair, which is what makes a correlated `r` distinguish
  // itself: the correlated count is 1 and the degree is 2. A single-edge fixture would agree by
  // luck, the vacuity trap items 422, 425, 427, 429 and 435 each paid for.
  const twin = (): Graph => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['U'], properties: { n: 1 } });
    const x = h.addVertex({ id: 'x', labels: ['X'], properties: { n: 2 } });

    h.addEdge({ from: a, to: x, labels: ['T'], properties: { w: 7 } });
    h.addEdge({ from: a, to: x, labels: ['T'], properties: { w: 8 } });

    return h;
  };

  test('named and unmentioned answers exactly what the anonymous spelling answers', () => {
    const g = build();

    for (const [anon, named] of [
      ['MATCH (a:P)-[:T]->(x) RETURN x.name AS n', 'MATCH (a:P)-[e:T]->(x) RETURN x.name AS n'],
      [
        'MATCH (a:P)-[:T]->(x) WHERE x.age > 25 RETURN x.name AS n',
        'MATCH (a:P)-[e:T]->(x) WHERE x.age > 25 RETURN x.name AS n',
      ],
      [
        'MATCH (a:P)-[:T]->(x {age: 30}) RETURN x.name AS n',
        'MATCH (a:P)-[e:T]->(x {age: 30}) RETURN x.name AS n',
      ],
      [
        'MATCH (a:P)-[:T]->(x) RETURN count(x.age) AS c',
        'MATCH (a:P)-[e:T]->(x) RETURN count(x.age) AS c',
      ],
      ['MATCH (a:P)-[:T]->(x) RETURN a.name AS n', 'MATCH (a:P)-[e:T]->(x) RETURN a.name AS n'],
    ]) {
      expect(query(g, named)).toEqual(query(g, anon));
    }
  });

  // Item 446 made this shape take the fast path instead of declining, by BINDING the edge. The
  // assertions are unchanged and still the point: `w` is 7 and 8, which a fixture with one edge
  // — or two edges carrying the same `w` — could not tell from a single-edge answer.
  test('a projected item that READS the edge is right', () => {
    const g = twin();

    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN r.w AS w')).toEqual([{ w: 7 }, { w: 8 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN sum(r.w) AS s')).toEqual([{ s: 15 }]);
  });

  test('a SUBQUERY in the projection correlating on the edge declines', () => {
    const g = twin();

    // `r` comes from the OUTER pattern, so the inner pattern is a correlation on that one edge
    // and the count is 1 — not `p`'s degree of 2. This is the case that broke when the gate was
    // removed outright, and `freePredicateVars` reports NO free variables for it.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN COUNT { MATCH (p)-[r:T]->(z) } AS c')).toEqual([
      { c: 1 },
      { c: 1 },
    ]);
  });

  // NO TEETH against the guard, and recorded as such rather than left to look like a test that
  // has them. The `m.where` half of the gate can be removed — and `carriedWhere`'s
  // neither-endpoint refusal removed with it — and this test still passes, because `rowLocal`
  // refuses a subquery `WHERE` on this path before either is consulted. What it pins is the
  // ANSWER, which is worth pinning on its own: it is the shape that would go wrong first if the
  // subquery refusal were ever relaxed.
  test('a SUBQUERY in the clause WHERE correlating on the edge answers per-edge', () => {
    const g = twin();

    // The inner hop names `r`, so
    // it CORRELATES on the outer edge: the predicate holds for the `w = 7` row and not the
    // `w = 8` one, giving ONE row. Read uncorrelated — `r` fresh, matching any `T` edge with
    // `w = 7` — it would hold for BOTH, giving two. One row against two is the distinguishing
    // outcome, and it needs the twin edges to carry DIFFERENT `w` to exist at all.
    expect(
      query(
        g,
        'MATCH (p:U)-[r:T]->(q) WHERE EXISTS { MATCH (p)-[r:T WHERE r.w = 7]->(z) } RETURN q.n AS n',
      ),
    ).toEqual([{ n: 2 }]);

    // The spelling that reads the OUTER `r` from an anonymous inner hop means the same thing and
    // is visible to `freePredicateVars`, so it was never at risk. Asserted because the two
    // spellings agreeing is the actual claim — and because a change that broke only the
    // invisible one would otherwise look like a change that broke nothing.
    expect(
      query(
        g,
        'MATCH (p:U)-[r:T]->(q) WHERE EXISTS { MATCH (p)-[:T WHERE r.w = 7]->(z) } RETURN q.n AS n',
      ),
    ).toEqual([{ n: 2 }]);
  });

  test('an unrelated string equal to the edge name declines, harmlessly', () => {
    const g = build();

    // `mentionsName` compares every string in the AST, so a literal `'e'` reports mentioned for
    // the rel variable `e`. That is a declined fast path and the same answer — asserted so the
    // over-broadness stays deliberate rather than becoming a surprise.
    expect(query(g, "MATCH (a:P)-[e:T]->(x) RETURN 'e' AS lit, x.name AS n")).toEqual(
      query(g, "MATCH (a:P)-[:T]->(x) RETURN 'e' AS lit, x.name AS n"),
    );
  });
});

// Item 446: the hop fast path BINDS the edge, so a projected item may read the rel variable.
//
// Item 444 admitted a named-but-unmentioned rel and still declined every mention. Reading one
// cost 632 ns/row against 192 for the same walk without it, because mentioning the rel sent the
// query to the general path. Binding the edge is one `set` per edge on a binding the walk already
// carries — `expand`'s bucket loop is holding the edge — and measured 3.0x on `RETURN r`, 3.1x on
// `RETURN r.w`, against four flat controls.
describe('the hop fast path binds the edge (item 446)', () => {
  // The start label is on EVERY vertex, which makes it vacuous — and a vacuous start label is
  // what lets the far-driven walk be chosen. That matters here: the far-driven walk hoists
  // `projectRow` to once per far VERTEX (item 167), which is invalid once an item reads the edge,
  // and `x` below is the far end of TWO edges carrying DIFFERENT `w`. A fixture whose parallel
  // edges shared a `w`, or whose far vertices had one edge each, could not tell a correct walk
  // from a hoisting one.
  const fan = (): Graph => {
    const h = new Graph();
    const a1 = h.addVertex({ id: 'a1', labels: ['U'], properties: { n: 1 } });
    const a2 = h.addVertex({ id: 'a2', labels: ['U'], properties: { n: 2 } });
    const x = h.addVertex({ id: 'x', labels: ['U', 'X'], properties: { n: 9 } });

    h.addEdge({ id: 'e1', from: a1, to: x, labels: ['T'], properties: { w: 1 } });
    h.addEdge({ id: 'e2', from: a2, to: x, labels: ['T'], properties: { w: 2 } });

    return h;
  };

  test('each row gets ITS OWN edge, not one edge repeated per far vertex', () => {
    const g = fan();

    // Both edges land on `x`. A hoisting walk would emit one edge's `w` twice — [1,1] or [2,2] —
    // and the sum would be 2 or 4 rather than 3.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN r.w AS w')).toEqual([{ w: 1 }, { w: 2 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN sum(r.w) AS s')).toEqual([{ s: 3 }]);
  });

  test('the bound edge is the EDGE, not the far node', () => {
    const g = fan();

    // `w` lives only on the edges and `n` only on the vertices, so binding the far node to the
    // rel variable — or the edge to the far variable — shows up as nulls rather than as a
    // plausible wrong number.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN r.w AS w, q.n AS n')).toEqual([
      { w: 1, n: 9 },
      { w: 2, n: 9 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN r.n AS rn, q.w AS qw')).toEqual([
      { rn: null, qw: null },
      { rn: null, qw: null },
    ]);
  });

  test('the whole edge element projects, and matches the declining spelling', () => {
    const g = fan();
    const fast = query(g, 'MATCH (p:U)-[r:T]->(q) RETURN r');
    // `WHERE r.w < 100` reads the rel in the clause WHERE, which `carriedWhere` refuses, so this
    // spelling takes the GENERAL path while keeping every row. Comparing the two is comparing
    // the fast path against the engine's own general answer rather than against my expectation.
    const general = query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w < 100 RETURN r');

    expect(fast).toEqual(general);
    expect(fast.length).toBe(2);
  });

  test('a REVERSED hop binds the edge and the far end independently', () => {
    const g = fan();

    // Walking in, the far end is `edge.from` while the edge is the same object — so a walk that
    // conflated them would differ here and not in the forward case.
    expect(query(g, 'MATCH (q:U)<-[r:T]-(p) RETURN r.w AS w, p.n AS pn')).toEqual([
      { w: 1, pn: 1 },
      { w: 2, pn: 2 },
    ]);
  });

  test('a FAR label is still applied when the edge is bound', () => {
    const g = fan();

    // `:X` is only on `x`, and `:U` is on all three, so the far label has to exclude something
    // for this to mean anything. Both edges end at `x`, so `:X` keeps both and `:Nope` keeps none.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q:X) RETURN r.w AS w')).toEqual([{ w: 1 }, { w: 2 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q:Nope) RETURN r.w AS w')).toEqual([]);
  });

  test('the shapes that must still DECLINE answer correctly', () => {
    const g = fan();

    // `filteredHopWalk` does not bind the edge, so each of these must decline rather than be
    // served by the rel-bound walk ignoring its filter. A far inline predicate, a far clause
    // WHERE, a start-reading item, and a rel-reading clause WHERE.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q {n: 9}) RETURN r.w AS w')).toEqual([{ w: 1 }, { w: 2 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE q.n = 9 RETURN r.w AS w')).toEqual([
      { w: 1 },
      { w: 2 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q {n: 1}) RETURN r.w AS w')).toEqual([]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) RETURN p.n AS pn, r.w AS w')).toEqual([
      { pn: 1, w: 1 },
      { pn: 2, w: 2 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 2 RETURN r.w AS w')).toEqual([{ w: 2 }]);
  });
});
