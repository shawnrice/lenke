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

// Item 447: the FILTERED half — a clause `WHERE` or a far predicate alongside a bound edge.
//
// Item 446 bound the edge for the unfiltered shape only, so `WHERE r.w < 100 RETURN b` still
// declined and stayed at 772 ns/row. Carrying a rel-reading `WHERE` needs the edge bound BEFORE
// the gate is evaluated, which only `relBoundFilteredHopWalk` does.
//
// These tests exist because the suite had NO coverage of a rel-reading clause `WHERE` whose
// PROJECTION does not read the rel. While this item was half-applied — `carriedWhere` carrying
// the predicate but no walk binding the edge — all three of the first assertions below returned
// the empty set, and 2,128 tests passed. A gap that lets a half-finished change look finished is
// the most expensive kind.
describe('a rel-reading clause WHERE on the hop fast path (item 447)', () => {
  // Two edges with DIFFERENT `w` onto ONE far vertex, and `:U` on every vertex so the start
  // label is vacuous — the configuration that would let a hoisting walk be chosen if one were.
  const fan = (): Graph => {
    const h = new Graph();
    const a1 = h.addVertex({ id: 'a1', labels: ['U'], properties: { n: 1 } });
    const a2 = h.addVertex({ id: 'a2', labels: ['U'], properties: { n: 2 } });
    const x = h.addVertex({ id: 'x', labels: ['U', 'X'], properties: { n: 9 } });

    h.addEdge({ id: 'e1', from: a1, to: x, labels: ['T'], properties: { w: 1 } });
    h.addEdge({ id: 'e2', from: a2, to: x, labels: ['T'], properties: { w: 2 } });

    return h;
  };

  test('the filter is APPLIED, at three different selectivities', () => {
    const g = fan();

    // Vacuous, selective and empty. One assertion cannot tell a carried filter from a dropped
    // one: a dropped filter also answers `[{n:9},{n:9}]` for the vacuous case, which is why the
    // `= 1` and `> 99` rows are here.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w < 100 RETURN q.n AS n')).toEqual([
      { n: 9 },
      { n: 9 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 1 RETURN q.n AS n')).toEqual([{ n: 9 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w > 99 RETURN q.n AS n')).toEqual([]);
  });

  test('the gate reads the edge of ITS OWN row', () => {
    const g = fan();

    // `r.w = 1` keeps exactly one of two rows that share a far vertex. A walk binding one edge
    // for both would keep both or neither.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 1 RETURN r.w AS w, q.n AS n')).toEqual([
      { w: 1, n: 9 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 2 RETURN p.n AS pn')).toEqual([{ pn: 2 }]);
  });

  test('a filter mixing the edge with BOTH endpoints', () => {
    const g = fan();

    expect(
      query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w > 0 AND q.n = 9 RETURN p.n AS pn, r.w AS w'),
    ).toEqual([
      { pn: 1, w: 1 },
      { pn: 2, w: 2 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w > 0 AND p.n = 2 RETURN r.w AS w')).toEqual([
      { w: 2 },
    ]);
  });

  test('a mixed filter whose PROJECTION does not read the edge', () => {
    const g = fan();

    // The shape mutation found this suite was missing. Every other test here projects `r`, so
    // `itemsReadRel` routed them to the rel-bound walk and the `carriedWhere` half of the
    // decision was never the thing under test. Here the projection reads only the far end while
    // the FILTER reads the edge — so if `carriedWhere` carries the predicate without reporting
    // the rel read, the gate is evaluated by a walk that binds no edge, and the mutant doing
    // exactly that survived until this test existed.
    //
    // Both operand orders, because a predicate that reads the far end as well takes a different
    // branch of `carriedWhere` from one that reads only the edge.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 1 AND q.n = 9 RETURN q.n AS n')).toEqual([
      { n: 9 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE q.n = 9 AND r.w = 2 RETURN q.n AS n')).toEqual([
      { n: 9 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w > 0 AND q.n = 9 RETURN q.n AS n')).toEqual([
      { n: 9 },
      { n: 9 },
    ]);
    // And the start-reading variant of the same hazard.
    expect(query(g, 'MATCH (p:U)-[r:T]->(q) WHERE r.w = 2 AND p.n = 2 RETURN q.n AS n')).toEqual([
      { n: 9 },
    ]);
  });

  test('a far LABEL and a far inline predicate both still apply', () => {
    const g = fan();

    expect(query(g, 'MATCH (p:U)-[r:T]->(q:X) WHERE r.w = 2 RETURN r.w AS w')).toEqual([{ w: 2 }]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q:Nope) WHERE r.w = 2 RETURN r.w AS w')).toEqual([]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q {n: 9}) WHERE r.w = 2 RETURN r.w AS w')).toEqual([
      { w: 2 },
    ]);
    expect(query(g, 'MATCH (p:U)-[r:T]->(q {n: 1}) WHERE r.w = 2 RETURN r.w AS w')).toEqual([]);
  });

  test('a REVERSED filtered hop', () => {
    const g = fan();

    expect(query(g, 'MATCH (q:U)<-[r:T]-(p) WHERE r.w = 2 RETURN p.n AS pn, r.w AS w')).toEqual([
      { pn: 2, w: 2 },
    ]);
  });

  test('a subquery in the clause WHERE still declines, and correlates per edge', () => {
    const g = fan();

    // Item 444's hazard in the clause-`WHERE` position. The inner hop names `r`, so it
    // correlates on the outer edge: the predicate holds for the `w = 1` row alone.
    expect(
      query(
        g,
        'MATCH (p:U)-[r:T]->(q) WHERE EXISTS { MATCH (p)-[r:T WHERE r.w = 1]->(z) } RETURN q.n AS n',
      ),
    ).toEqual([{ n: 9 }]);
  });
});

// Item 456: a three-hop count's INTERIOR gate, built from an inline constraint as well as a
// clause `WHERE`.
//
// `interiorPredOf` read a clause `WHERE` only, so `(b {k: 2})` and `(b WHERE b.k = 2)` fell past
// the gated degree product onto a slower route while `WHERE b.k = 2` took it: 240.80-246.19 ms
// against 12.85-15.44 on the spelling probe's three-hop chain, isolated one group per process.
// 18x between three ways of writing one question.
//
// POSITION B ONLY, which is measured and not tidy: routing an inline gate on `c` through the
// product too made that shape 1.25x SLOWER (369 ms on the sweep it had been taking against 460
// on the product), because the product's walk iterates `b` but meets `c` once per middle EDGE.
describe('a three-hop count gated by an inline constraint (item 456)', () => {
  // Every vertex is `:P` with a `k`, so the three positions are distinguishable: a gate on `b`
  // keeps a different set from the same gate on `c`, and the counts below differ. A fixture
  // where the gate selected the same paths from either position could not tell the routes apart.
  const chain = (): Graph => {
    const g = new Graph();
    const v = (id: string, k: number) => g.addVertex({ id, labels: ['P'], properties: { k } });
    const a = v('a', 0);
    const b1 = v('b1', 2);
    const b2 = v('b2', 9);
    const c1 = v('c1', 2);
    const c2 = v('c2', 7);
    const d = v('d', 0);
    let n = 0;
    const e = (from: ReturnType<Graph['addVertex']>, to: ReturnType<Graph['addVertex']>) =>
      g.addEdge({ id: `e${(n += 1)}`, from, to, labels: ['E'], properties: {} });

    // a -> {b1, b2} -> {c1, c2} -> d, fully connected between layers.
    e(a, b1);
    e(a, b2);
    e(b1, c1);
    e(b1, c2);
    e(b2, c1);
    e(b2, c2);
    e(c1, d);
    e(c2, d);

    return g;
  };

  test('the three spellings of a gate on b agree', () => {
    const g = chain();

    // `b1` alone has k = 2, and it reaches both c's, each reaching d: 2 paths.
    for (const q of [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ]) {
      expect(query(g, q)).toEqual([{ c: 2 }]);
    }
  });

  test('the three spellings of a gate on c agree, and differ from b', () => {
    const g = chain();

    // `c1` alone has k = 2, reached from both b's: 2 paths — the same COUNT as the `b` gate here
    // by coincidence of the fixture's shape, so the next assertion is what separates them.
    for (const q of [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
    ]) {
      expect(query(g, q)).toEqual([{ c: 2 }]);
    }

    // A gate the two positions answer DIFFERENTLY, so a route that confused `onB` is caught:
    // `b2` has k = 9 and no `c` does, so gating `b` keeps 2 paths and gating `c` keeps none.
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b {k: 9})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 2 }]);
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 9})-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 0 }]);
  });

  test('BOTH interior positions gated still answers', () => {
    const g = chain();

    // The route declines this (the product gates one interior node), so it must fall through and
    // still be right: `b1` and `c1` are the only k = 2 pair, and `c1` reaches `d`.
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 1 }]);
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b {k: 9})-[:E]->(c {k: 7})-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 1 }]);
  });

  test('an OPEN inline constraint declines and is right', () => {
    const g = chain();

    // `{k: a.k}` reads another variable, so `inlineOf` returns null and the whole shortcut
    // declines to the general path. `a` has k = 0 and no `b` does, so nothing matches.
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b {k: a.k})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 0 }]);
  });

  test('an inline gate ALONGSIDE a clause WHERE keeps both', () => {
    const g = chain();

    // The shape mutation found this suite was missing. The inline gate is built BEFORE the
    // clause block runs, so a clause `WHERE` overwrites it — the two must not silently replace
    // one another. `b.k = 2` keeps b1 (2 paths) and `c.k = 2` narrows to c1, leaving 1; the
    // `d.k = 0` variant names an END position, which has no interior gate, and keeps both.
    expect(
      query(
        g,
        'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
      ),
    ).toEqual([{ c: 1 }]);
    expect(
      query(
        g,
        'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d) WHERE d.k = 0 RETURN count(*) AS c',
      ),
    ).toEqual([{ c: 2 }]);
  });

  test('a gate on an END position is unaffected', () => {
    const g = chain();

    // `a` and `d` are reached only as degrees, so they have no interior gate and take whatever
    // route they took before. Asserted so a change to the interior logic cannot quietly move
    // them: only `a` has k = 0 among starts, and `d` is the only end.
    expect(
      query(g, 'MATCH (a:P {k: 0})-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c'),
    ).toEqual([{ c: 4 }]);
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d {k: 0}) RETURN count(*) AS c'),
    ).toEqual([{ c: 4 }]);
  });
});

describe('an ANONYMOUS end node on the hop fast path (item 776)', () => {
  // `hopEnds` refused `node.variable === undefined`, so `MATCH (:P)-[r:E]->() RETURN r.k` fell to
  // the general row pipeline while `->(b)` took this path — 82.13 ms against 18.25 over the same
  // 200,000 rows, 4.88x, both answers correct. An anonymous end now gets a SYNTHESIZED binding
  // name instead of a refusal.
  //
  // THE SYNTHESIZED NAME MUST BE ONE NO QUERY CAN WRITE, and that is what these tests pin.
  // Mutation found nothing covered it: replacing the sentinel with a plausible name like `b`
  // passed the whole suite, while `MATCH (b:P)-[r:E]->() RETURN b.age` would then bind the FAR
  // node to `b` and read ITS age instead of the start's — a wrong answer only a query that names
  // its start `b` can see.
  const two = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 10 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 20 } });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { k: 1 } });

    return g;
  };

  test('a START named like a synthesized far binding still reads the start', () => {
    const g = two();

    // The start is the age-10 vertex and the far end is age 20. Both spellings of the start's
    // name must answer 10 — if the far binding could shadow the start, the first would read 20.
    expect(query(g, 'MATCH (b:P)-[r:E]->() RETURN b.age AS v')).toEqual([{ v: 10 }]);
    expect(query(g, 'MATCH (x:P)-[r:E]->() RETURN x.age AS v')).toEqual([{ v: 10 }]);
    // The same, with the far end NAMED, which is the spelling that always took this path.
    expect(query(g, 'MATCH (b:P)-[r:E]->(c) RETURN b.age AS v')).toEqual([{ v: 10 }]);
  });

  test('an anonymous end agrees with a named one it does not read', () => {
    const g = two();

    // The two spellings are the same question when the end is unread, which is the whole reason
    // the refusal was a gap: equal answers, 4.88x apart in cost.
    expect(query(g, 'MATCH (:P)-[r:E]->() RETURN r.k AS v')).toEqual(
      query(g, 'MATCH (:P)-[r:E]->(b) RETURN r.k AS v'),
    );
    expect(query(g, 'MATCH (a:P)-[:E]->() RETURN a.age AS v')).toEqual(
      query(g, 'MATCH (a:P)-[:E]->(b) RETURN a.age AS v'),
    );
    expect(query(g, 'MATCH (:P)-[:E]->() RETURN count(*) AS v')).toEqual([{ v: 1 }]);
  });
});

describe('lifting an INLINE start property into the WHERE (item 778)', () => {
  // `plainNode` refuses a start with inline properties, so `MATCH (a:P {k: 5})-[:E]->(b)` fell to
  // the general pipeline while its clause twin took the fast path — 5.04 ms against 0.95, item
  // 777 measured 8.4x on a larger fixture. The lift is a REWRITE, so what needs pinning is not
  // the speed but the three cases where the lifted form would MEAN something else. Mutation found
  // all three unguarded by tests: dropping the null refusal, the param refusal or the quantifier
  // refusal each passed the whole suite (the last one failed `reachability.test.ts` instead).
  const nulled = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: null, tag: 'has-null' } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 5, tag: 'has-five' } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: { tag: 'target' } });

    g.addEdge({ id: 'e1', from: a, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });

    return g;
  };

  test('an inline NULL is IS NULL and must NOT become `= null`', () => {
    const g = nulled();

    // `{k: null}` matches the node carrying a STORED null (null is a present value in this
    // engine), where `a.k = null` is UNKNOWN and matches nothing. Lifting the first into the
    // second would silently drop the row — the one refusal in this rewrite that changes an
    // answer rather than a plan (item 260).
    expect(query(g, 'MATCH (a:P {k: null})-[:E]->(x) RETURN a.tag AS v')).toEqual([
      { v: 'has-null' },
    ]);
    expect(query(g, 'MATCH (a:P)-[:E]->(x) WHERE a.k = null RETURN a.tag AS v')).toEqual([]);
  });

  test('an inline PARAM does not lift, because it could BE null', () => {
    const g = nulled();

    // Indistinguishable from the literal case at compile time, so `{k: $p}` keeps the inline
    // form and keeps IS NULL semantics when the param is null.
    expect(query(g, 'MATCH (a:P {k: $p})-[:E]->(x) RETURN a.tag AS v', { p: null })).toEqual([
      { v: 'has-null' },
    ]);
    expect(query(g, 'MATCH (a:P {k: $p})-[:E]->(x) RETURN a.tag AS v', { p: 5 })).toEqual([
      { v: 'has-five' },
    ]);
  });

  test('a non-null literal DOES lift, and agrees with its clause twin', () => {
    const g = nulled();

    // The case the rewrite exists for: equal answers, and now equal plans.
    expect(query(g, 'MATCH (a:P {k: 5})-[:E]->(x) RETURN a.tag AS v')).toEqual([{ v: 'has-five' }]);
    expect(query(g, 'MATCH (a:P {k: 5})-[:E]->(x) RETURN a.tag AS v')).toEqual(
      query(g, 'MATCH (a:P)-[:E]->(x) WHERE a.k = 5 RETURN a.tag AS v'),
    );
  });
});

// Item 780 passed `farVar`/`rel.variable` as `ownVar` to `compilePredicate`, so an inline node or
// rel `WHERE` on a hop now lifts into `eqProps`/`cmpProps` and is read straight off the element
// (1.45x, and `>` 1.41x). The lift's answer-equivalence rests entirely on ONE guard — the
// `rhs === null` rejection in `satisfies`'s `eqProps` loop, which gives `=`'s EXPRESSION reading
// where `{k: null}` means IS NULL (item 260).
//
// That guard was already well tested — removing it fails EIGHT tests — but every one of them is at
// the NODE position (`node-projection-direct-eq.test.ts`). Nothing pinned it at the two positions
// this change newly routes through, so a future refactor that lifted a far-node or rel `WHERE`
// into `props` instead would keep all eight green while silently turning `= null` into IS NULL on
// a hop. These tests close that: all four below fail with the guard removed.
describe('an inline node or rel WHERE on a hop lifts to eqProps (item 780)', () => {
  const g = new Graph();
  const src = g.addVertex({ id: 's', labels: ['S'], properties: { tag: 'src' } });
  const hasNull = g.addVertex({ id: 'n', labels: ['P'], properties: { k: null, tag: 'null' } });
  const hasFive = g.addVertex({ id: 'f', labels: ['P'], properties: { k: 5, tag: 'five' } });
  const absent = g.addVertex({ id: 'a', labels: ['P'], properties: { tag: 'absent' } });

  g.addEdge({ labels: ['E'], from: src, to: hasNull, properties: { w: null } });
  g.addEdge({ labels: ['E'], from: src, to: hasFive, properties: { w: 5 } });
  g.addEdge({ labels: ['E'], from: src, to: absent });

  const tags = (q: string, params?: Record<string, unknown>): unknown[] => query(g, q, params);

  test('an inline far `WHERE k = null` is UNKNOWN, not IS NULL', () => {
    // The two WHERE spellings agree with each other and BOTH differ from the inline property,
    // which is the whole distinction the guard carries.
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k = null) RETURN b.tag AS t')).toEqual([]);
    expect(tags('MATCH (s:S)-[:E]->(b) WHERE b.k = null RETURN b.tag AS t')).toEqual([]);
    expect(tags('MATCH (s:S)-[:E]->(b {k: null}) RETURN b.tag AS t')).toEqual([
      { t: 'null' },
      { t: 'absent' },
    ]);
  });

  test('an inline far `WHERE k = $p` with a NULL param matches nothing', () => {
    // A param cannot be shown non-null at compile time, so it lifts and is settled per row by
    // the same guard rather than by a compile-time refusal.
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k = $p) RETURN b.tag AS t', { p: null })).toEqual([]);
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k = $p) RETURN b.tag AS t', { p: 5 })).toEqual([
      { t: 'five' },
    ]);
  });

  test('an inline REL `WHERE w = null` is UNKNOWN too', () => {
    // `closedRelPred`'s own `ownVar` omission, fixed in the same change and reached by a
    // different walk.
    expect(tags('MATCH (s:S)-[r:E WHERE r.w = null]->(b) RETURN b.tag AS t')).toEqual([]);
    expect(tags('MATCH (s:S)-[r:E WHERE r.w = 5]->(b) RETURN b.tag AS t')).toEqual([{ t: 'five' }]);
  });

  test('a lifted ORDERING comparison drops a null operand rather than matching it', () => {
    // `cmpProps` (item 276) goes through `compareTruth`, so UNKNOWN settles the row — a FILTER
    // keeps only a clean TRUE (item 259). `<>` is the sharp one: `null <> 5` is UNKNOWN, so the
    // stored-null and absent rows drop rather than counting as "different".
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k > 1) RETURN b.tag AS t')).toEqual([{ t: 'five' }]);
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k <> 5) RETURN b.tag AS t')).toEqual([]);
  });
});

// Item 781 routes a clause `WHERE` that reads only the far variable into `farPred`, so the clause
// spelling costs what the inline ones do (21.07 → 13.90 ms). `mergeFarPreds` carries `props`,
// `eqProps` and `cmpProps` but NOT `where`, because `satisfies` evaluates `where` last and there
// is no position left that keeps a generic inline predicate ahead of a lifted clause one.
//
// So an inline far constraint that did NOT lift has to block the whole lift. Mutating that refusal
// away returns a WRONG ANSWER — the inline `IS NULL` is merged out of existence — while the entire
// 2,600-test suite stays green, which is why these exist.
//
// Every far node here has `j = 1`, so the clause predicate alone admits all three and only the
// inline constraint can tell them apart. A fixture where the clause were selective would hide the
// dropped conjunct behind the right answer.
describe('a far-only clause WHERE lifts into farPred (item 781)', () => {
  const g = new Graph();
  const src = g.addVertex({ id: 's', labels: ['S'], properties: { tag: 'src' } });

  for (const [id, properties] of [
    ['null', { k: null, j: 1, tag: 'null' }],
    ['five', { k: 5, j: 1, tag: 'five' }],
    ['absent', { j: 1, tag: 'absent' }],
  ] as [string, Record<string, unknown>][]) {
    g.addEdge({ labels: ['E'], from: src, to: g.addVertex({ id, labels: ['P'], properties }) });
  }

  const tags = (q: string, params?: Record<string, unknown>): unknown[] => query(g, q, params);

  test('a NON-LIFTING inline far constraint still applies beside a lifted clause', () => {
    // THE MUTANT KILLER. `IS NULL` does not lift (it is not a `compare`), so it stays in
    // `farPred.where` and the clause must NOT be merged in beside it.
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k IS NULL) WHERE b.j = 1 RETURN b.tag AS t')).toEqual(
      [{ t: 'null' }, { t: 'absent' }],
    );
    // The same query without the clause, to show the clause is what the lift could have eaten.
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k IS NULL) RETURN b.tag AS t')).toEqual([
      { t: 'null' },
      { t: 'absent' },
    ]);
  });

  test('a LIFTING inline far constraint composes with the clause', () => {
    // Both spellings of the inline side, since `props` and `eqProps` are different lists in
    // `mergeFarPreds` and only one of them is exercised by each.
    expect(tags('MATCH (s:S)-[:E]->(b {k: 5}) WHERE b.j = 1 RETURN b.tag AS t')).toEqual([
      { t: 'five' },
    ]);
    expect(tags('MATCH (s:S)-[:E]->(b WHERE b.k = 5) WHERE b.j = 1 RETURN b.tag AS t')).toEqual([
      { t: 'five' },
    ]);
  });

  test('an AND of two far-local conjuncts lifts, and a disjunction does not', () => {
    expect(tags('MATCH (s:S)-[:E]->(b) WHERE b.j = 1 AND b.k = 5 RETURN b.tag AS t')).toEqual([
      { t: 'five' },
    ]);
    // An `or` is not a `compare`, so nothing lifts and the gate keeps it — same answer either way,
    // which is the point of pinning it.
    expect(tags('MATCH (s:S)-[:E]->(b) WHERE b.k = 5 OR b.j = 1 RETURN b.tag AS t')).toEqual([
      { t: 'null' },
      { t: 'five' },
      { t: 'absent' },
    ]);
  });

  test('a clause reading the START is left to the gate', () => {
    // Pinned even though the refusal that names it has NO teeth of its own: mutating the
    // free-variable loop away is INERT, because `directEqProps` declines a conjunct whose
    // variable is not `ownVar` and the no-gain refusal then catches it. The loop stays because
    // it does not depend on that internal, and this test is what would notice if it changed.
    expect(
      tags('MATCH (s:S)-[:E]->(b) WHERE b.j = 1 AND s.tag = $t RETURN b.tag AS t', { t: 'src' }),
    ).toEqual([{ t: 'null' }, { t: 'five' }, { t: 'absent' }]);
    expect(
      tags('MATCH (s:S)-[:E]->(b) WHERE b.j = 1 AND s.tag = $t RETURN b.tag AS t', { t: 'no' }),
    ).toEqual([]);
  });
});

// Item 782 hoists the FAR-LOCAL conjuncts of a mixed clause `WHERE` into `farPred`, leaving the
// rest on the gate. What is left is start-only, so the existing start-gated walk takes it:
// `WHERE b.age = 5 AND a.age > 1` went 22.00 → 14.93 ms, and its start-first spelling 24.18 →
// 14.61, converging from a 1.10x spread to 1.02x.
//
// The split has its OWN copy of item 781's refusal 2, and item 781's test does not reach it:
// there the clause is a single far-local conjunct, so `rest` is empty, the split declines and the
// whole-clause lift handles it. Mutating the split's copy away therefore survived the entire
// suite while answering a different question. These tests reach the split path specifically — the
// clause must have BOTH a far-local conjunct and something else.
describe('a MIXED clause hoists its far-local conjuncts (item 782)', () => {
  const g = new Graph();

  for (let i = 0; i < 6; i += 1) {
    const a = g.addVertex({ id: `a${i}`, labels: ['P'], properties: { age: i, s: `s${i}` } });
    const b = g.addVertex({ id: `b${i}`, labels: ['Q'], properties: { k: i, j: i } });
    g.addEdge({ labels: ['E'], from: a, to: b });
  }

  const vs = (q: string): unknown[] => query(g, q);

  test('a NON-LIFTING inline far constraint blocks the split', () => {
    // THE MUTANT KILLER, and the one item 781's equivalent does not reach. `IS NULL` does not
    // lift, so it lives in `farPred.where`; `mergeFarPreds` cannot carry that, so the split must
    // decline. No far node has a null `k`, so the answer is empty — and dropping the refusal
    // returns all six rows.
    expect(
      vs('MATCH (a:P)-[:E]->(b WHERE b.k IS NULL) WHERE b.j >= 0 AND a.age >= 0 RETURN b.j AS v'),
    ).toEqual([]);
    // The LIFTING inline spelling of the same shape still composes, so the refusal is not simply
    // turning the split off whenever an inline constraint is present.
    expect(
      vs('MATCH (a:P)-[:E]->(b {j: 2}) WHERE b.j >= 0 AND a.age >= 0 RETURN b.j AS v'),
    ).toEqual([{ v: 2 }]);
  });

  test('both spellings of a mixed clause agree with each other and with the general path', () => {
    const want = [{ v: 3 }, { v: 4 }, { v: 5 }];
    expect(vs('MATCH (a:P)-[:E]->(b) WHERE b.j >= 3 AND a.age >= 3 RETURN b.j AS v')).toEqual(want);
    expect(vs('MATCH (a:P)-[:E]->(b) WHERE a.age >= 3 AND b.j >= 3 RETURN b.j AS v')).toEqual(want);
    // Forced onto the general path by projecting the START, which the fast path's projection
    // guard refuses — so this is the same question answered by the other implementation.
    expect(
      vs('MATCH (a:P)-[:E]->(b) WHERE b.j >= 3 AND a.age >= 3 RETURN a.s AS s, b.j AS v'),
    ).toEqual([
      { s: 's3', v: 3 },
      { s: 's4', v: 4 },
      { s: 's5', v: 5 },
    ]);
  });

  test('the residual is kept, not dropped', () => {
    // `gate: undefined` in place of the compiled residual is caught here and by three older
    // tests: the start half of the predicate simply vanishes and every row survives.
    expect(vs('MATCH (a:P)-[:E]->(b) WHERE b.j >= 0 AND a.age = 2 RETURN b.j AS v')).toEqual([
      { v: 2 },
    ]);
  });

  test('a conjunct that cannot hoist leaves the clause whole', () => {
    // A disjunction is not a `compare`, so nothing lifts and the gate keeps everything; a
    // conjunct reading BOTH ends likewise. Pinned because the split must decline, not partially
    // apply.
    expect(vs('MATCH (a:P)-[:E]->(b) WHERE b.j = 1 OR a.age = 2 RETURN b.j AS v')).toEqual([
      { v: 1 },
      { v: 2 },
    ]);
    expect(vs('MATCH (a:P)-[:E]->(b) WHERE b.j = a.age AND b.j >= 4 RETURN b.j AS v')).toEqual([
      { v: 4 },
      { v: 5 },
    ]);
  });
});
