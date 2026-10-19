// `detectNodeProjection` now admits an `ORDER BY` whose every key is an OUTPUT COLUMN, when there
// is no window (item 605). It projects every row and sorts, where the general path sorts bindings.
//
// THE ORACLE IS A DECLINED SPELLING OF THE SAME QUERY, which is what makes this file possible
// without a second implementation to compare against:
//
//     RETURN a.k AS x ORDER BY x      -- the key is the output column, so the shortcut takes it
//     RETURN a.k AS x ORDER BY a.k    -- structurally the same sort, but an expression key, so
//                                        `outputColumnSorts` declines and the GENERAL path answers
//
// The two are the same query by any reading, so they must return the same rows in the SAME ORDER.
// That turns the engine's own general path into the oracle, and it is the repo's equivalent-
// spellings invariant applied to a route rather than to a cost.
//
// TIES ARE THE POINT. Row order under `ORDER BY` is pinned between the engines — item 605 measured
// TS and native agreeing exactly over a fixture with 20 ties per group — so a sort that is not
// stable, or that runs over a different arrival order, is a real divergence and not a don't-care.
// Every fixture here therefore has far more rows than distinct key values.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (n: number, distinct: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      // `k` repeats every `distinct` vertices, so almost every comparison is a tie.
      // `j` is a second, coarser key. `maybe` is null on a third of the rows, for NULLS placement.
      properties: {
        k: `k${i % distinct}`,
        j: i % 3,
        maybe: i % 3 === 0 ? null : i % 7,
        n: i,
      },
    });
  }

  return g;
};

const rowsOf = (g: Graph, q: string): string =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .join('|');

/** A hop fixture: `n` vertices each with one out-edge, and only `distinct` key values. */
const hopGraph = (n: number, distinct: number): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: { k: `k${i % distinct}`, t: i % 3, j: i % 2, n: i },
      }),
    );
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      // A scatter, so the far end's creation order is NOT the start's edge order — which is what
      // makes the far-driven walk's arrival order differ and the tie assertions meaningful.
      to: vs[(i * 7 + 13) % n],
      labels: ['K'],
      properties: {},
    });
  }

  return g;
};

/** The admitted spelling and a DECLINED spelling of the same sort must agree row for row. */
const agree = (g: Graph, shortcut: string, general: string): void => {
  const a = rowsOf(g, shortcut);
  const b = rowsOf(g, general);

  expect(a).toBe(b);
  // And neither is empty, or the comparison is vacuous — the trap this repo records as a fixture
  // that agrees because both sides returned nothing.
  expect(a.length).toBeGreaterThan(0);
};

describe('the ordered node projection', () => {
  test('ASC over heavy ties matches the declined spelling row for row', () => {
    const g = build(600, 7);

    agree(g, 'MATCH (a:P) RETURN a.k AS x ORDER BY x', 'MATCH (a:P) RETURN a.k AS x ORDER BY a.k');
  });

  test('DESC over heavy ties matches', () => {
    const g = build(600, 7);

    agree(
      g,
      'MATCH (a:P) RETURN a.k AS x ORDER BY x DESC',
      'MATCH (a:P) RETURN a.k AS x ORDER BY a.k DESC',
    );
  });

  test('several keys match, and the LATER key is not ignored', () => {
    const g = build(600, 7);

    agree(
      g,
      'MATCH (a:P) RETURN a.j AS y, a.k AS x ORDER BY y, x',
      'MATCH (a:P) RETURN a.j AS y, a.k AS x ORDER BY a.j, a.k',
    );

    // A sort on the COARSE key alone leaves 200-row ties, so if the second key were dropped the
    // test above could still pass by luck. This pins that the two-key order differs from the
    // one-key order, which is what makes the comparison able to see a dropped key.
    expect(rowsOf(g, 'MATCH (a:P) RETURN a.j AS y, a.k AS x ORDER BY y, x')).not.toBe(
      rowsOf(g, 'MATCH (a:P) RETURN a.j AS y, a.k AS x ORDER BY y'),
    );
  });

  test('NULLS placement matches, both explicit and default', () => {
    const g = build(600, 7);

    for (const nulls of ['', ' NULLS FIRST', ' NULLS LAST']) {
      agree(
        g,
        `MATCH (a:P) RETURN a.maybe AS m ORDER BY m${nulls}`,
        `MATCH (a:P) RETURN a.maybe AS m ORDER BY a.maybe${nulls}`,
      );
    }
  });

  test('a clause WHERE is carried and the order still matches', () => {
    const g = build(600, 7);

    agree(
      g,
      'MATCH (a:P) WHERE a.j > 0 RETURN a.k AS x ORDER BY x',
      'MATCH (a:P) WHERE a.j > 0 RETURN a.k AS x ORDER BY a.k',
    );
  });

  test('an inline pattern predicate is carried and the order still matches', () => {
    const g = build(600, 7);

    agree(
      g,
      'MATCH (a:P {j: 1}) RETURN a.k AS x ORDER BY x',
      'MATCH (a:P {j: 1}) RETURN a.k AS x ORDER BY a.k',
    );
  });

  // --- the HOP projection (item 607) ------------------------------------------------------------

  test('a HOP sorted by an output column matches the declined spelling row for row', () => {
    // Same oracle as the node cases: `ORDER BY x` takes the shortcut, `ORDER BY b.k` is
    // structurally the same sort but an expression key, so it declines to the general path.
    const g = hopGraph(400, 7);

    agree(
      g,
      'MATCH (a:P)-[:K]->(b) RETURN b.k AS x ORDER BY x',
      'MATCH (a:P)-[:K]->(b) RETURN b.k AS x ORDER BY b.k',
    );
    agree(
      g,
      'MATCH (a:P)-[:K]->(b) RETURN a.k AS x ORDER BY x DESC',
      'MATCH (a:P)-[:K]->(b) RETURN a.k AS x ORDER BY a.k DESC',
    );
  });

  test('a SORTED hop must leave the FAR-DRIVEN walk, which reorders rows', () => {
    // `MATCH (a:P)-[:K]->(b) RETURN b.k` reads only the far end, so unsorted it rides
    // `farDrivenHopWalk` — whose header says it changes row order deliberately and is sound only
    // because an unordered result's order is unspecified. A sort pins the SORTED order and leaves
    // TIES on arrival order, so sorting rows produced in THAT order reorders ties away from the
    // general path. `hopOrderPlan` therefore forces the start-driven walk.
    //
    // The fixture is almost all ties — 400 rows over 7 distinct keys — so the tie order IS the
    // assertion. Against the declined spelling, which never leaves the general path.
    const g = hopGraph(400, 7);

    // A SECOND, DISTINCT COLUMN IS WHAT MAKES THE TIES VISIBLE. Projecting only the sort key
    // leaves every tied row as the same object (`{t: 0}`), so a reordering of ties is
    // indistinguishable and the assertion cannot fail — a mutant letting the far-driven walk keep
    // a sorted query SURVIVED exactly that fixture. `n` is unique per vertex, so each tied row is
    // identifiable and its position is part of the comparison. Item 425 recorded the same trap:
    // "I wrote the fixture for this guard is not evidence it exercises the guard."
    agree(
      g,
      'MATCH (a:P)-[:K]->(b) RETURN b.t AS t, b.n AS n ORDER BY t',
      'MATCH (a:P)-[:K]->(b) RETURN b.t AS t, b.n AS n ORDER BY b.t',
    );
    // DESC too: the sorted order reverses but the ties within each group must still arrive in the
    // general path's order, not the reverse of it.
    agree(
      g,
      'MATCH (a:P)-[:K]->(b) RETURN b.t AS t, b.n AS n ORDER BY t DESC',
      'MATCH (a:P)-[:K]->(b) RETURN b.t AS t, b.n AS n ORDER BY b.t DESC',
    );
  });

  test('a HOP window with no sort stays with the general path', () => {
    // The hop gate's own laziness rule, which the node test above does not reach — that one is a
    // node query and this is the hop gate. A mutant admitting a bare window into the streaming
    // gate SURVIVED until this existed: the wrapper only SORTS, it does not page, so a shortcut
    // that claimed `LIMIT 5` would return every row.
    const g = hopGraph(400, 7);

    expect(query(g, 'MATCH (a:P)-[:K]->(b) RETURN b.k AS x LIMIT 5')).toHaveLength(5);
    expect(query(g, 'MATCH (a:P)-[:K]->(b) RETURN b.k AS x SKIP 395')).toHaveLength(5);
  });

  test('a hop with a carried WHERE and an inline predicate still matches', () => {
    const g = hopGraph(400, 7);

    agree(
      g,
      'MATCH (a:P)-[:K]->(b) WHERE b.j > 0 RETURN b.k AS x ORDER BY x',
      'MATCH (a:P)-[:K]->(b) WHERE b.j > 0 RETURN b.k AS x ORDER BY b.k',
    );
    agree(
      g,
      'MATCH (a:P {j: 1})-[:K]->(b) RETURN b.k AS x ORDER BY x',
      'MATCH (a:P {j: 1})-[:K]->(b) RETURN b.k AS x ORDER BY b.k',
    );
  });

  // --- the three DECLINE rules, each with the behaviour it protects -----------------------------

  test('a WINDOW with a sort DECLINES, because the general path projects only survivors', () => {
    // Item 604 measured this on both engines: with a window, an item that faults on a DISCARDED
    // row never raises, because the top-k keeps bindings and projects survivors. A path that
    // projected everything then sliced would raise. `v1` cannot cast; ordering by `n` puts it
    // second, so `LIMIT 1` must not see it.
    const g = new Graph();

    g.addVertex({ id: 'v0', labels: ['P'], properties: { s: '1', n: 1 } });
    g.addVertex({ id: 'v1', labels: ['P'], properties: { s: 'not-a-number', n: 2 } });

    expect(
      query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x, a.n AS k ORDER BY k LIMIT 1'),
    ).toEqual([{ x: 1, k: 1 }]);

    // Without the window every row IS emitted, so the same projection raises — which is why the
    // no-window case needs no cannot-fault check at all.
    expect(() =>
      query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x, a.n AS k ORDER BY k'),
    ).toThrow();
  });

  test('a key that is NOT an output column declines — and DESC is what proves it', () => {
    // `ORDER BY a` names the PATTERN VARIABLE, not an output column: it is a valid sort (a node
    // has an order) and `outputColumnSorts` must decline it, because `row['a']` does not exist —
    // this path would see `undefined` for every row, call it all ties, and return scan order.
    //
    // ASC CANNOT SEE THAT. Scan order IS insertion order, which is what `ORDER BY a` ascending
    // returns, so the wrong answer coincides with the right one. A mutant admitting any `var`
    // key SURVIVED the whole suite on exactly that coincidence. DESC is the spelling where the
    // two diverge, so it is the one with teeth.
    const g = new Graph();

    for (let i = 0; i < 6; i += 1) {
      // `k` runs DOWN as insertion runs up, so the node order and the property order disagree
      // and neither can stand in for the other.
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: `k${5 - i}` } });
    }

    expect(rowsOf(g, 'MATCH (a:P) RETURN a.k AS x ORDER BY a')).toBe(
      ['k5', 'k4', 'k3', 'k2', 'k1', 'k0'].map((k) => JSON.stringify({ x: k })).join('|'),
    );
    expect(rowsOf(g, 'MATCH (a:P) RETURN a.k AS x ORDER BY a DESC')).toBe(
      ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'].map((k) => JSON.stringify({ x: k })).join('|'),
    );
  });

  test('`LIMIT 0` returns [] WITHOUT projecting', () => {
    const g = new Graph();

    g.addVertex({ id: 'v0', labels: ['P'], properties: { s: 'not-a-number' } });

    // `applyProjection` returns `[]` before projecting anything, so a faulting projection must
    // not raise here. A path that projected first and sliced after would.
    expect(query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x ORDER BY x LIMIT 0')).toEqual([]);
  });

  test('a window with NO sort stays LAZY — it must not be admitted', () => {
    // `sortOf` records a ~280x regression for taking an unordered window: the general path
    // short-circuits after a few rows where this path materializes everything. Correctness cannot
    // show that, so this pins the one thing a test can: the answer is still a page, and the
    // shortcut has not claimed the query.
    const g = build(600, 7);
    const got = query(g, 'MATCH (a:P) RETURN a.k AS x LIMIT 5') as Record<string, unknown>[];

    expect(got).toHaveLength(5);
  });
});
