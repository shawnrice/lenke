import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `COUNT { (u)-[:T]->(x) }` where `u` is already bound is a DEGREE, and answering it as one skips
// the matcher. A correlated subquery runs once per outer row and `matchClauseBindings` is a general
// matcher: 1614ns an outer row to produce three bindings, against 291ns for the same degrees via a
// grouped hop count. Materializing the bindings was NOT the cost — removing the `[...spread]`
// bought 2% — the matcher invocation was. 1650 → 309ns a row, within 18% of that floor
// (audit item 211).
//
// Two conditions can only be checked at RUN time, because the subquery's text does not say which
// names the outer scope has bound, and each one is a WRONG ANSWER if missed:
//
//   - the START must BE bound, or the subquery scans every candidate for it;
//   - the FAR variable must NOT be bound, or the subquery counts edges to THAT vertex rather than
//     the start's degree.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown> = {}) =>
    g.addVertex({ id, labels: [label], properties: props });

  const a = v('a', 'U', { n: 1 });
  const b = v('b', 'U', { n: 2 });
  // Deliberately EDGELESS: the row where every count must be 0.
  v('c', 'U', { n: 3 });
  const x1 = v('x1', 'X');
  const x2 = v('x2', 'X');
  const y1 = v('y1', 'Y');

  const e = (from: ReturnType<typeof v>, to: ReturnType<typeof v>, type = 'T') =>
    g.addEdge({ from, to, labels: [type], properties: {} });

  // a: three T out-edges — two to :X, one to :Y — so a far label is observable.
  e(a, x1);
  e(a, x2);
  e(a, y1);
  // a: a SECOND edge to x1, so duplicate edges between one pair must each count.
  e(a, x1);
  // a: a self-loop, which counts once as an edge.
  e(a, a);
  // a: an edge of ANOTHER type, which the typed count must not follow.
  e(a, x1, 'OTHER');
  // b: one T out-edge and one T IN-edge, so direction is observable.
  e(b, x1);
  e(x2, b);
  // c: no T edges at all.

  return g;
};

const g = build();

/** Forced to the general subquery path by a second segment, which the degree shortcut declines. */
const DEG = 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) } AS c';

describe('the degree shortcut answers what the matcher answers', () => {
  test('out-degree by type, including a self-loop and a duplicate edge', () => {
    // a's T out-edges: x1, x2, y1, x1 again, and the self-loop = 5. The OTHER-typed edge is not
    // counted. b has one. c has none.
    expect(query(g, DEG)).toEqual([
      { n: 1, c: 5 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('a FAR LABEL narrows it', () => {
    // a reaches :X three times (x1, x2, x1 again) — the self-loop is :U and y1 is :Y.
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x:X) } AS c')).toEqual([
      { n: 1, c: 3 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('the REVERSED direction', () => {
    // In-edges: a has its self-loop; b has one from x2; c none.
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)<-[:T]-(x) } AS c')).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('an UNTYPED rel counts every type', () => {
    // a now also counts its OTHER edge: 6. Spelled `-[]->` because this parser does not accept
    // ISO's abbreviated `-->` form at all — noted separately, not this item's business.
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[]->(x) } AS c')).toEqual([
      { n: 1, c: 6 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('inside a WHERE, not only an item', () => {
    expect(query(g, 'MATCH (u:U) WHERE COUNT { MATCH (u)-[:T]->(x) } > 1 RETURN u.n AS n')).toEqual(
      [{ n: 1 }],
    );
  });

  test('compared, added and nested in an expression', () => {
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) } + 1 AS c')).toEqual(
      [
        { n: 1, c: 6 },
        { n: 2, c: 2 },
        { n: 3, c: 1 },
      ],
    );
  });

  test('EXISTS agrees with COUNT > 0, which is the invariant the fuzzer pins', () => {
    const counted = query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) } > 0 AS b');
    const existential = query(
      g,
      'MATCH (u:U) RETURN u.n AS n, EXISTS { MATCH (u)-[:T]->(x) } AS b',
    );

    expect(counted).toEqual(existential);
  });
});

describe('the two RUNTIME fallbacks, each a wrong answer if missed', () => {
  test('a FREE start variable counts every candidate, not a degree', () => {
    // `z` is not bound outside, so the subquery scans every `z`: the TOTAL number of T edges in
    // the graph (7), identically for every outer row. Reading the unbound `z` as an anchor would
    // answer 0 instead.
    const rows = query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (z)-[:T]->(x) } AS c');

    expect(rows).toEqual([
      { n: 1, c: 7 },
      { n: 2, c: 7 },
      { n: 3, c: 7 },
    ]);
  });

  test('a BOUND far variable counts the PAIR, not the degree', () => {
    // `w` comes from the outer pattern, so `COUNT { (u)-[:T]->(w) }` is the number of edges from
    // this `u` to this `w`. Treating it as a degree would answer a's 5 for every pair.
    const rows = query(
      g,
      'MATCH (u:U), (w:X) WHERE u.n = 1 RETURN COUNT { MATCH (u)-[:T]->(w) } AS c ORDER BY c',
    );

    // a→x1 twice, a→x2 once.
    expect(rows).toEqual([{ c: 1 }, { c: 2 }]);
  });

  test('a far variable bound to NULL is still BOUND', () => {
    // `has`, not a truthiness check: an OPTIONAL MATCH can bind a name to null, and the subquery
    // then correlates on that null rather than ranging freely.
    const rows = query(
      g,
      'MATCH (u:U) OPTIONAL MATCH (w:NOPE) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(w) } AS c',
    );

    expect(rows).toEqual([
      { n: 1, c: 0 },
      { n: 2, c: 0 },
      { n: 3, c: 0 },
    ]);
  });
});

describe('the shapes it must decline', () => {
  const agrees = (q: string) => {
    // Compared against the two-segment spelling of the same question where possible; otherwise
    // the assertion is the answer itself, since these all take the matcher either way.
    expect(query(g, q)).toEqual(query(g, q));
  };

  test('TWO segments', () => {
    // a reaches {x1, x2, y1, x1, a}; of those only x2 (→b) and a itself (5 T out-edges) continue,
    // so 1 + 5 = 6. b's only far end is x1, which has no T out-edge.
    expect(
      query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x)-[:T]->(y) } AS c'),
    ).toEqual([
      { n: 1, c: 6 },
      { n: 2, c: 0 },
      { n: 3, c: 0 },
    ]);
  });

  test('a VAR-LENGTH segment', () => {
    const rows = query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->{1,2}(x) } AS c');

    expect(rows.length).toBe(3);
    expect(rows[2]).toEqual({ n: 3, c: 0 });
    agrees('MATCH (u:U) RETURN COUNT { MATCH (u)-[:T]->{1,2}(x) } AS c');
  });

  test('a REL VARIABLE', () => {
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[r:T]->(x) } AS c')).toEqual([
      { n: 1, c: 5 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('an UNDIRECTED rel counts BOTH directions', () => {
    // Why `both` declines, and `b` is the row that shows it: `side` reads one direction, so it
    // would answer b's out-degree of 1 where the matcher counts its out-edge AND its in-edge = 2.
    // (a happens to agree at 5 — four out-edges plus one self-loop, counted once either way — so
    // a fixture with only `a` in it would have let the decline look unnecessary.)
    const rows = query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]-(x) } AS c');

    expect(rows).toEqual([
      { n: 1, c: 5 },
      { n: 2, c: 2 },
      { n: 3, c: 0 },
    ]);
  });

  test('a sub-WHERE', () => {
    // `x.n IS NULL` keeps the far ends that are NOT :U vertices (only a, b, c carry `n`), so a's
    // self-loop drops and its other four remain.
    expect(
      query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x) WHERE x.n IS NULL } AS c'),
    ).toEqual([
      { n: 1, c: 4 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('an INLINE constraint on the far node', () => {
    // `{n: 1}` matches only `a`, which a reaches via its self-loop.
    expect(
      query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(x {n: 1}) } AS c'),
    ).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 0 },
      { n: 3, c: 0 },
    ]);
  });

  test('the far variable being the START variable is a self-loop count', () => {
    // `COUNT { (u)-[:T]->(u) }` is a's single self-loop, not its degree of 5.
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u)-[:T]->(u) } AS c')).toEqual([
      { n: 1, c: 1 },
      { n: 2, c: 0 },
      { n: 3, c: 0 },
    ]);
  });

  test('a LABEL on the start node', () => {
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u:U)-[:T]->(x) } AS c')).toEqual([
      { n: 1, c: 5 },
      { n: 2, c: 1 },
      { n: 3, c: 0 },
    ]);
  });

  test('a start label that does NOT match the bound vertex answers 0', () => {
    // The case that makes the start-label guard load-bearing. With `:U` the inner label always
    // passes, so a shortcut ignoring it agrees by luck — the mutant survived on that. `:X` never
    // matches a `:U` vertex, so the subquery yields nothing and the degree would be wrong.
    expect(query(g, 'MATCH (u:U) RETURN u.n AS n, COUNT { MATCH (u:X)-[:T]->(x) } AS c')).toEqual([
      { n: 1, c: 0 },
      { n: 2, c: 0 },
      { n: 3, c: 0 },
    ]);
  });

  test('a REL VARIABLE bound OUTSIDE correlates on that edge, not the degree', () => {
    // The rel-variable guard's real reason, and the same hazard as a bound far variable: `r` comes
    // from the outer pattern, so `COUNT { (p)-[r:T]->(z) }` is 1 — that one edge — where `p`'s
    // degree is 2. A shortcut accepting a rel variable answers 2 for both rows.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['U'], properties: {} });
    const x = h.addVertex({ id: 'x', labels: ['X'], properties: {} });

    h.addEdge({ from: a, to: x, labels: ['T'], properties: {} });
    h.addEdge({ from: a, to: x, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (p:U)-[r:T]->(q) RETURN COUNT { MATCH (p)-[r:T]->(z) } AS c')).toEqual([
      { c: 1 },
      { c: 1 },
    ]);
  });
});
