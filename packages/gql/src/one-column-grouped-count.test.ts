import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause } from './ast.js';
import { detectGroupedHopCount } from './executor/grouped-hop.js';
import { detectGroupedNodeCount } from './executor/node-scan.js';
import { query } from './index.js';
import { parse } from './parser.js';

// A GROUPED COUNT that does not project its key — `RETURN count(*) AS c GROUP BY n.k`, and the
// `LET` spelling of the same thing. Both declined the tally before item 1582 on the arity gate
// `proj.items.length !== 2`, and so cost 24.8x the two-column form (15.23 ms against 0.614, both
// measured on ONE build at 50,000 vertices; `group-count-spelling-probe.mjs`) for a question that
// asks for strictly LESS output.
//
// WHAT THESE TESTS HAVE TO PIN. The rung now emits a row with ONE column where it used to emit
// two, and chooses the group key from `GROUP BY` instead of from a projection item. Neither is
// checkable by a count: the number of rows is the number of groups either way. So the oracle used
// throughout is the TWO-COLUMN form with its key column dropped — same groups, same first-seen
// order, same counts — because that spelling reached the tally before this change and its
// behaviour is already pinned by `counted-groups` and `tally-select-having`.

const graphOf = (keys: readonly unknown[]): Graph => {
  const g = new Graph();

  for (const [i, k] of keys.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: k === undefined ? {} : { k } });
  }

  return g;
};

/** The one-column spellings under test, and the two-column oracle they must agree with. */
const ONE_COL = 'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k';
const ONE_COL_LET = 'MATCH (n:P) LET a = n.k RETURN count(*) AS c GROUP BY a';
const TWO_COL = 'MATCH (n:P) RETURN n.k AS a, count(*) AS c GROUP BY n.k';

const rowsOf = (g: Graph, q: string): Array<Record<string, unknown>> => query(g, q);

/** The oracle: the two-column form, reduced to just its count column, in order. */
const oracle = (g: Graph): Array<Record<string, unknown>> =>
  rowsOf(g, TWO_COL).map((r) => ({ c: r.c }));

describe('one-column grouped count', () => {
  const FIXTURES: Array<readonly [string, readonly unknown[]]> = [
    ['repeated keys', ['a', 'b', 'a', 'c', 'b', 'a']],
    ['every row its own group', [1, 2, 3, 4]],
    ['one group', ['same', 'same', 'same']],
    ['single row', ['only']],
    // `null` is a stored, present value in this engine, so it is a GROUP and not an absence.
    ['nulls among values', ['a', null, 'b', null, 'a']],
    // A missing property reads as `null`, so these must land in ONE group with the explicit nulls.
    ['missing property', [undefined, 'a', undefined, null]],
    ['numeric and string keys', [1, '1', 2, '2', 1]],
    // `valueKey` is type-prefixed, so a string that spells a tag must not collide with one.
    ['keys that spell tags', ['N', 'bT', 'n1', 'N']],
    ['boolean keys', [true, false, true]],
  ];

  for (const [name, keys] of FIXTURES) {
    test(`${name}: matches the two-column form with the key dropped`, () => {
      const g = graphOf(keys);
      const want = oracle(g);

      expect(rowsOf(g, ONE_COL)).toEqual(want);
      expect(rowsOf(g, ONE_COL_LET)).toEqual(want);
    });
  }

  test('emits ONE column, named by the alias, and no key column', () => {
    const g = graphOf(['a', 'b', 'a']);
    const rows = rowsOf(g, ONE_COL);

    expect(rows).toEqual([{ c: 2 }, { c: 1 }]);

    // The point of the shape: the key is NOT in the output, under any name.
    for (const r of rows) {
      expect(Object.keys(r)).toEqual(['c']);
    }
  });

  test('groups come out in FIRST-SEEN order, which is the pinned contract', () => {
    // `b` is seen first, so its row comes first even though `a` is the larger group.
    const g = graphOf(['b', 'a', 'a', 'c', 'a']);

    expect(rowsOf(g, ONE_COL)).toEqual([{ c: 1 }, { c: 3 }, { c: 1 }]);
    expect(rowsOf(g, ONE_COL)).toEqual(oracle(g));
  });

  test('NaN keys group together, as the engine total order requires', () => {
    const g = graphOf([Number.NaN, 1, Number.NaN]);

    // Asserted against the oracle rather than a literal: this is `valueKey`'s business and the
    // two spellings agreeing is the claim, not a particular grouping of NaN.
    expect(rowsOf(g, ONE_COL)).toEqual(oracle(g));
    expect(rowsOf(g, ONE_COL)).toEqual([{ c: 2 }, { c: 1 }]);
  });
});

describe('one-column grouped count: the clauses that ride along', () => {
  const g = (): Graph => graphOf(['a', 'b', 'a', 'c', 'b', 'a']);

  test('a WHERE filters before grouping', () => {
    const graph = g();
    const want = (
      query(
        graph,
        "MATCH (n:P) WHERE n.k <> 'c' RETURN n.k AS a, count(*) AS c GROUP BY n.k",
      ) as Array<Record<string, unknown>>
    ).map((r) => ({ c: r.c }));

    expect(rowsOf(graph, "MATCH (n:P) WHERE n.k <> 'c' RETURN count(*) AS c GROUP BY n.k")).toEqual(
      want,
    );
  });

  test('an inline constraint filters before grouping', () => {
    const graph = g();

    expect(rowsOf(graph, "MATCH (n:P {k: 'a'}) RETURN count(*) AS c GROUP BY n.k")).toEqual([
      { c: 3 },
    ]);
  });

  // ⚠️ `HAVING` is a clause of ISO's SELECT spelling, not of `RETURN`: every
  // `RETURN … GROUP BY … HAVING …` raises `Unexpected trailing input 'HAVING'`, the two-column
  // form included. My first draft of this test wrote the `RETURN` spelling on the strength of
  // seeing `GROUP BY n.k HAVING count(*) > 1` in a sibling test file — which is in a SELECT
  // query there. So the SELECT form is where this has to be pinned, and it exercises the same
  // rung: `tally-select-having` records that the two spellings share `groupedProjection`.
  test('HAVING is applied to the grouped rows (the SELECT spelling)', () => {
    const graph = g();

    expect(
      rowsOf(graph, 'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 1'),
    ).toEqual([{ c: 3 }, { c: 2 }]);
    // And without the HAVING, so the filter is shown to be what removed the third group.
    expect(rowsOf(graph, 'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k')).toEqual([
      { c: 3 },
      { c: 2 },
      { c: 1 },
    ]);
  });

  test('SKIP and LIMIT window the groups in first-seen order', () => {
    const graph = g();

    expect(rowsOf(graph, 'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k LIMIT 2')).toEqual([
      { c: 3 },
      { c: 2 },
    ]);
    expect(rowsOf(graph, 'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k SKIP 1 LIMIT 1')).toEqual([
      { c: 2 },
    ]);
  });

  test('a label restricts the scan', () => {
    const graph = g();

    graph.addVertex({ id: 'other', labels: ['Q'], properties: { k: 'a' } });

    expect(rowsOf(graph, ONE_COL)).toEqual([{ c: 3 }, { c: 2 }, { c: 1 }]);
    // Unlabelled, the Q vertex joins the `a` group.
    expect(rowsOf(graph, 'MATCH (n) RETURN count(*) AS c GROUP BY n.k')).toEqual([
      { c: 4 },
      { c: 2 },
      { c: 1 },
    ]);
  });

  test('ORDER BY still answers correctly, on whichever path takes it', () => {
    const graph = g();

    // ⚠️ This spelling DECLINES the rung by design (see `groupedProjection`): its only resolvable
    // sort target is the count column, and `colSortsOf` is written around a projected key column
    // this form does not have. The answer must still be right, because declining has to mean
    // "the general path handles it" and not "it is unsupported" — and the probe's `ord1` arm uses
    // exactly this shape as its same-build general-path control.
    expect(rowsOf(graph, 'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k ORDER BY c')).toEqual([
      { c: 1 },
      { c: 2 },
      { c: 3 },
    ]);
    expect(rowsOf(graph, 'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k ORDER BY c DESC')).toEqual([
      { c: 3 },
      { c: 2 },
      { c: 1 },
    ]);
  });
});

describe('one-column grouped count over a hop', () => {
  // `groupedProjection` is shared by the node tally and the HOP tally, so admitting the
  // one-column form reached both. The hop twin needs its own coverage: it resolves the key to a
  // property of one END of the hop, which is a different code path from the node scan.
  const hopGraph = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['A'], properties: { t: 'x' } });
    const b = g.addVertex({ id: 'b', labels: ['A'], properties: { t: 'y' } });

    for (const [i, [from, to, k]] of (
      [
        [a, a, 'p'],
        [a, b, 'p'],
        [a, b, 'q'],
        [b, a, 'p'],
      ] as const
    ).entries()) {
      g.addVertex({ id: `t${i}`, labels: ['T'], properties: { k } });
      g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: {} });
    }

    return g;
  };

  test('grouping by the FAR end matches the two-column form', () => {
    const g = hopGraph();
    const want = (
      query(g, 'MATCH (x:A)-[:E]->(y) RETURN y.t AS a, count(*) AS c GROUP BY y.t') as Array<
        Record<string, unknown>
      >
    ).map((r) => ({ c: r.c }));

    expect(rowsOf(g, 'MATCH (x:A)-[:E]->(y) RETURN count(*) AS c GROUP BY y.t')).toEqual(want);
    expect(rowsOf(g, 'MATCH (x:A)-[:E]->(y) LET a = y.t RETURN count(*) AS c GROUP BY a')).toEqual(
      want,
    );
  });

  test('grouping by the START end matches the two-column form', () => {
    const g = hopGraph();
    const want = (
      query(g, 'MATCH (x:A)-[:E]->(y) RETURN x.t AS a, count(*) AS c GROUP BY x.t') as Array<
        Record<string, unknown>
      >
    ).map((r) => ({ c: r.c }));

    expect(rowsOf(g, 'MATCH (x:A)-[:E]->(y) RETURN count(*) AS c GROUP BY x.t')).toEqual(want);
  });
});

describe('one-column grouped count: shapes that must NOT be mistaken for it', () => {
  test('an UNGROUPED count keeps its own single-row answer', () => {
    const g = graphOf(['a', 'b', 'a']);

    // No `GROUP BY`, so this is the plain count rung and must stay one row of 3 — the one-column
    // gate requires an explicit grouping element and this is exactly the shape it must not claim.
    expect(rowsOf(g, 'MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('a one-item projection that is NOT count(*) is not a tally', () => {
    const g = graphOf(['a', 'b', 'a']);

    expect(rowsOf(g, 'MATCH (n:P) RETURN n.k AS a GROUP BY n.k')).toEqual([{ a: 'a' }, { a: 'b' }]);
  });

  test('count(DISTINCT …) is not count(*) and must not take the tally', () => {
    const g = graphOf(['a', 'b', 'a']);

    expect(rowsOf(g, 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c GROUP BY n.k')).toEqual([
      { c: 1 },
      { c: 1 },
    ]);
  });

  test('grouping by a non-property expression declines and still answers', () => {
    const g = graphOf(['a', 'b', 'a']);

    // `GROUP BY n` groups by the NODE, not a property, so `keySource.kind !== 'prop'` declines.
    expect(rowsOf(g, 'MATCH (n:P) RETURN count(*) AS c GROUP BY n')).toEqual([
      { c: 1 },
      { c: 1 },
      { c: 1 },
    ]);
  });

  test('a LET whose name the GROUP BY does not use declines and still answers', () => {
    const g = graphOf(['a', 'b', 'a']);

    expect(rowsOf(g, 'MATCH (n:P) LET a = n.k RETURN count(*) AS c GROUP BY n.k')).toEqual([
      { c: 2 },
      { c: 1 },
    ]);
  });
});

// ⚠️ THE ROUTE ITSELF NEEDS ASSERTING, and the answers above cannot do it.
//
// Declining a rung is ANSWER-EQUIVALENT — the general path returns the same rows — so a mutant
// that makes the gate always refuse is invisible to every test in this file. Mutation says so
// rather than theory: three mutants SURVIVED the 125-test correctness run, and all three
// degrade the rung to "decline" (refusing the one-column form outright, admitting a projection
// with no items, and taking the key from the projection instead of from `GROUP BY` — which makes
// `keySource` a `func` and so declines downstream). The five mutants that changed an ANSWER were
// all caught.
//
// So the route is asserted directly against the detectors, which is what
// `perf-gate-needs-its-own-test` prescribes: a route choice needs a test of the choice.
const clausesOf = (q: string): readonly Clause[] => {
  const stmt = parse(q);
  const [part] = (stmt as unknown as { parts: { clauses?: readonly Clause[] }[] }).parts;
  const clauses = part?.clauses;

  if (clauses === undefined) {
    throw new Error(`no clause list parsed from: ${q}`);
  }

  return clauses;
};

describe('one-column grouped count: the ROUTE, not the answer', () => {
  const takesNode = (q: string): boolean => detectGroupedNodeCount(clausesOf(q)) !== null;
  const takesHop = (q: string): boolean => detectGroupedHopCount(clausesOf(q)) !== null;

  test('the one-column spellings REACH the node tally', () => {
    expect(takesNode('MATCH (n:P) RETURN count(*) AS c GROUP BY n.k')).toBe(true);
    expect(takesNode('MATCH (n:P) LET a = n.k RETURN count(*) AS c GROUP BY a')).toBe(true);
    // Unlabelled and filtered, both of which ride along on the same rung.
    expect(takesNode('MATCH (n) RETURN count(*) AS c GROUP BY n.k')).toBe(true);
    expect(takesNode("MATCH (n:P) WHERE n.k <> 'c' RETURN count(*) AS c GROUP BY n.k")).toBe(true);
    expect(takesNode('MATCH (n:P) RETURN count(*) AS c GROUP BY n.k LIMIT 2')).toBe(true);
  });

  test('the two-column form still reaches it, so the change did not trade one for the other', () => {
    expect(takesNode('MATCH (n:P) RETURN n.k AS a, count(*) AS c GROUP BY n.k')).toBe(true);
    expect(takesNode('MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a')).toBe(true);
  });

  test('the one-column spellings REACH the hop tally', () => {
    expect(takesHop('MATCH (a:P)-[:E]->(b) RETURN count(*) AS c GROUP BY b.k')).toBe(true);
    expect(takesHop('MATCH (a:P)-[:E]->(b) LET x = b.k RETURN count(*) AS c GROUP BY x')).toBe(
      true,
    );
  });

  test('the shapes that must DECLINE, do', () => {
    // No grouping element: this is the plain ungrouped count's rung, not the tally's.
    expect(takesNode('MATCH (n:P) RETURN count(*) AS c')).toBe(false);
    // ORDER BY: the one-column form has no projected key column to sort by.
    expect(takesNode('MATCH (n:P) RETURN count(*) AS c GROUP BY n.k ORDER BY c')).toBe(false);
    // Not `count(*)`.
    expect(takesNode('MATCH (n:P) RETURN count(DISTINCT n.k) AS c GROUP BY n.k')).toBe(false);
    expect(takesNode('MATCH (n:P) RETURN max(n.k) AS c GROUP BY n.k')).toBe(false);
    // A grouping key that is not a property of the matched node.
    expect(takesNode('MATCH (n:P) RETURN count(*) AS c GROUP BY n')).toBe(false);
    // A `LET` the GROUP BY does not name.
    expect(takesNode('MATCH (n:P) LET a = n.k RETURN count(*) AS c GROUP BY n.k')).toBe(false);
    // Three items is still too many.
    expect(takesNode('MATCH (n:P) RETURN n.k AS a, n.k AS b, count(*) AS c GROUP BY n.k')).toBe(
      false,
    );
    // A hop is not a node scan, and vice versa.
    expect(takesNode('MATCH (a:P)-[:E]->(b) RETURN count(*) AS c GROUP BY b.k')).toBe(false);
    expect(takesHop('MATCH (n:P) RETURN count(*) AS c GROUP BY n.k')).toBe(false);
  });
});
