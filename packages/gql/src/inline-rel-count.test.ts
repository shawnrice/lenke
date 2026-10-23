import { describe, expect, test } from 'bun:test';

// An inline rel `WHERE` now reaches the one-hop count tally that its clause twin already took
// (item 633), so the two spellings cost the same. The tally is a DIFFERENT code path from the
// general clause loop, which makes "does it still count the right edges" the whole question —
// the file it lives in says it twice: a dropped predicate here "is a wrong answer rather than
// a slow one".
//
// Every case asserts the inline spelling against its clause twin AND against a hand-written
// expectation. The twin alone would pass if both routes broke the same way; the hand-written
// number alone would not catch a divergence between the spellings, which is the bug class this
// engine is named for.
import { Graph } from '@lenke/core';

import { query } from './index.js';

// 6 vertices, 9 edges, `w` spread so every predicate below keeps a DIFFERENT subset — a
// fixture where two predicates coincide cannot tell them apart.
const fixture = (): Graph => {
  const g = new Graph();
  const vs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
    g.addVertex({ id, labels: i < 4 ? ['P'] : ['Q'], properties: { k: i } }),
  );
  const edge = (from: number, to: number, w: unknown, label = 'E'): void => {
    g.addEdge({
      id: `e${from}_${to}_${String(w)}`,
      from: vs[from],
      to: vs[to],
      labels: [label],
      // `w` absent entirely on one edge, and a stored null on another: the two cases an
      // inline `{k: v}` reads differently from `WHERE r.k = v`.
      properties: w === undefined ? {} : { w },
    });
  };

  edge(0, 1, 1);
  edge(0, 2, 5);
  edge(1, 2, 5);
  edge(1, 3, 10);
  edge(2, 3, 10);
  edge(2, 4, 10);
  edge(3, 4, undefined);
  edge(3, 5, null);
  edge(0, 3, 7, 'F');

  return g;
};

const count = (text: string, params: Record<string, unknown> = {}): number => {
  const rows = [...(query(fixture(), text, params) as Iterable<{ c: unknown }>)];
  const [row] = rows;

  return Number(row?.c ?? -1);
};

describe('an inline rel WHERE on a one-hop count', () => {
  const CASES: [string, string, string, Record<string, unknown>, number][] = [
    [
      'equality',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w = $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w = $w]->(b) RETURN count(*) AS c',
      { w: 10 },
      3,
    ],
    [
      'ordering >=',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w >= $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w >= $w]->(b) RETURN count(*) AS c',
      { w: 5 },
      5,
    ],
    [
      'ordering <',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w < $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w < $w]->(b) RETURN count(*) AS c',
      { w: 10 },
      3,
    ],
    [
      'inequality',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w <> $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w <> $w]->(b) RETURN count(*) AS c',
      { w: 10 },
      3,
    ],
    [
      // A conjunction, so the whole predicate has to survive and not just its first conjunct.
      'conjunction',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w >= $lo AND r.w <= $hi RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w >= $lo AND r.w <= $hi]->(b) RETURN count(*) AS c',
      { lo: 5, hi: 5 },
      2,
    ],
    [
      // NULL and ABSENT. `r.w = null` is UNKNOWN and a filter keeps only TRUE, so the edge
      // with a stored null and the edge with no `w` at all are BOTH excluded — by both
      // spellings. This is the case that makes the inline-PROPERTY form (`{w: $w}`) different,
      // which is why item 633 admits only the `WHERE` form.
      'equality against null',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w = $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w = $w]->(b) RETURN count(*) AS c',
      { w: null },
      0,
    ],
    [
      // A LABEL that excludes most edges, so the tally's type filter and the predicate must
      // both apply.
      'a different edge type',
      'MATCH (a:P)-[r:F]->(b) WHERE r.w = $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:F WHERE r.w = $w]->(b) RETURN count(*) AS c',
      { w: 7 },
      1,
    ],
    [
      // A labelled FAR end, which the tally carries separately (`inFar`) — the predicate must
      // not displace it.
      'a labelled far end',
      'MATCH (a:P)-[r:E]->(b:Q) WHERE r.w = $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w = $w]->(b:Q) RETURN count(*) AS c',
      { w: 10 },
      1,
    ],
  ];

  for (const [name, clause, inline, params, want] of CASES) {
    test(`agrees with its clause twin and with the expected count: ${name}`, () => {
      expect(count(clause, params)).toBe(want);
      expect(count(inline, params)).toBe(want);
    });
  }

  // BOTH predicates at once. The synthesis is guarded on `pred === undefined` precisely so a
  // clause `WHERE` and an inline one are never silently reduced to one of them; this is the
  // assertion that guard exists for.
  test('a clause WHERE and an inline WHERE together apply BOTH', () => {
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w >= $lo]->(b) WHERE r.w <= $hi RETURN count(*) AS c', {
        lo: 5,
        hi: 5,
      }),
    ).toBe(2);
    // And the asymmetric spelling, in case only one order is wired.
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w <= $hi]->(b) WHERE r.w >= $lo RETURN count(*) AS c', {
        lo: 5,
        hi: 5,
      }),
    ).toBe(2);
  });

  // 🛑 THREE CASES THE MUTANTS DEMANDED. Each of these survived a first mutation run, and in
  // every case the code was right and the FIXTURE could not tell the difference:
  //
  //   - inline PROPERTIES had no case at all, so admitting them to the tally (where they
  //     would be silently ignored) changed no assertion — a wrong COUNT nobody checked.
  //   - the correlated case below returned 0 either way on the main fixture, so dropping the
  //     free-variable check was invisible. It needs an answer that is NON-ZERO when the
  //     correlation is honoured and different when it is not.
  //   - a QUANTIFIED rel had no case, so admitting one changed nothing observable.
  test('inline PROPERTIES still count correctly (they decline to the general path)', () => {
    // Same answer as the `WHERE` spelling for a non-null value — that equivalence is the
    // whole reason the inline-property form is tempting, and the reason it must not be
    // admitted to the tally without being applied.
    expect(count('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c', { w: 10 })).toBe(3);
    expect(count('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c', { w: 5 })).toBe(2);
    // The NULL value: `{w: null}` is IS-NULL and matches the stored null AND the ABSENT key —
    // TWO edges here, where `WHERE r.w = null` matches 0. That divergence is the whole reason
    // inline properties stay out of the tally, and the first draft of this line expected 1
    // because it forgot the absent key was the second half of IS-NULL.
    expect(count('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c', { w: null })).toBe(2);
    // PROPERTIES **AND** AN INLINE `WHERE` ON ONE REL. This is the shape that separates the
    // two guards: `relInlineWhereOnly` requires `r.where !== undefined` anyway, so dropping
    // its PROPERTIES check is inert for the properties-only spelling and only bites here,
    // where the `WHERE` would be carried into the tally and the properties silently dropped.
    // A mutant removing that check survived until this line existed.
    expect(
      count('MATCH (a:P)-[r:E {w: $w} WHERE r.w >= $lo]->(b) RETURN count(*) AS c', {
        w: 10,
        lo: 0,
      }),
    ).toBe(3);
  });

  test('a QUANTIFIED rel with an inline WHERE still counts correctly', () => {
    // `{1,1}` is the quantified spelling of a single hop, so it must agree with the
    // unquantified one; `{1,2}` then adds the two-hop walks.
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w = $w]->{1,1}(b) RETURN count(*) AS c', { w: 10 }),
    ).toBe(3);
    // `{1,1}` AND `{1,2}` ON A PREDICATE WHOSE WALKS CHAIN, so the two differ: 5 single hops
    // with `w >= 5` and 4 two-hop continuations through vertex 2, which is 9. The `w = 10`
    // pair above cannot tell a one-hop tally from a var-length walk, because no `w = 10` edge
    // chains and both readings give 3 — a coincidence that let a mutant admitting a QUANTIFIED
    // rel to the one-hop tally survive.
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w >= $w]->{1,1}(b) RETURN count(*) AS c', { w: 5 }),
    ).toBe(5);
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w >= $w]->{1,2}(b) RETURN count(*) AS c', { w: 5 }),
    ).toBe(9);
    // THREE, not four: the edges with `w >= 10` are 1->3, 2->3 and 2->4, and no two of them
    // chain (3's out-edges have an absent `w` and a stored null, 4 has none), so every walk is
    // length 1. Counted by hand after the first draft guessed 4.
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w >= $w]->{1,2}(b) RETURN count(*) AS c', { w: 10 }),
    ).toBe(3);
  });

  test('a CORRELATED inline WHERE is honoured, not treated as element-local', () => {
    // Its own fixture, so the main one's expectations stay put. `w` equals the SOURCE's `k`
    // on exactly two edges, and nothing else — so 2 is only reachable by actually reading
    // `a.k` per edge. Treating the predicate as element-local leaves `a` unbound (null) and
    // the comparison is UNKNOWN for every edge, giving 0.
    const g = new Graph();
    const vs = [0, 1, 2, 3].map((i) =>
      g.addVertex({ id: `n${i}`, labels: ['P'], properties: { k: i } }),
    );
    const link = (from: number, to: number, w: number): void => {
      g.addEdge({
        id: `x${from}_${to}`,
        from: vs[from],
        to: vs[to],
        labels: ['E'],
        properties: { w },
      });
    };

    link(1, 0, 1); // k=1, w=1 -> matches
    link(2, 0, 2); // k=2, w=2 -> matches
    link(3, 0, 9); // k=3, w=9 -> does not
    link(0, 1, 7); // k=0, w=7 -> does not

    const rows = [
      ...(g === undefined
        ? []
        : (query(g, 'MATCH (a:P)-[r:E WHERE r.w = a.k]->(b) RETURN count(*) AS c') as Iterable<{
            c: unknown;
          }>)),
    ];

    expect(Number(rows[0]?.c ?? -1)).toBe(2);
  });

  // An inline rel `WHERE` that reads ANOTHER variable is a correlation, not a per-edge gate,
  // and must decline to the general path rather than be applied as if it were element-local.
  test('an inline WHERE reading another variable still answers correctly', () => {
    expect(
      count('MATCH (a:P)-[r:E WHERE r.w = a.k]->(b) RETURN count(*) AS c', {}),
      // ZERO, and worth spelling out because the first draft of this test asserted 1: no edge
      // in the fixture has a `w` equal to its SOURCE's `k` (0->1 has w=1 against k=0, 1->3 has
      // w=10 against k=1, and so on). The engine was right and the expectation was wrong.
    ).toBe(0);
  });

  // The PROJECTED form, which is a different rung from the count and must not have been
  // broken by giving the count one.
  test('the projected form still returns the right rows', () => {
    const rows = [
      ...(query(fixture(), 'MATCH (a:P)-[r:E WHERE r.w = $w]->(b) RETURN r.w AS w', {
        w: 10,
      }) as Iterable<{ w: unknown }>),
    ];

    expect(rows.map((r) => r.w)).toEqual([10, 10, 10]);
  });
});
