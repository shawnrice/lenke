import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1566: an inline `CALL { … }` with NO scope list is non-correlated, so its body is
 * loop-invariant and runs ONCE instead of once per outer row. 289x at 1,000 driving rows.
 *
 * ⚠️ THE WHOLE RISK IS IN THE GUARD, not the hoist. Three things must stay true:
 *   - a SCOPED `CALL (n) { … }` is correlated and must NOT be hoisted (its rows differ per row);
 *   - a body that WRITES must run per outer row, because ISO runs it per row — hoisting
 *     `CALL { INSERT … }` would insert once instead of N times;
 *   - the hoist must be LAZY, so an outer query with no rows never runs the body at all.
 *
 * Each of those is a test below, and each kills a mutant that the 3,913-test suite otherwise passes.
 */
const g6 = (): Graph => {
  const graph = new Graph();
  const vs: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < 6; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  // Degree exactly 1 each, so a CORRELATED count is 1 and a NON-CORRELATED one is 6. That gap is
  // what makes the two spellings distinguishable at all.
  for (let i = 0; i < 6; i += 1) {
    graph.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i + 1) % 6], labels: ['E'] });
  }

  return graph;
};

const plain = (): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 4; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  }

  return graph;
};

const countLabel = (graph: Graph, label: string): number => {
  let n = 0;

  for (const v of graph.vertices) {
    if (v.labels.has(label)) {
      n += 1;
    }
  }

  return n;
};

describe('the hoist does not change answers', () => {
  test('an UNSCOPED body sees a FRESH variable, so every row gets the whole-graph count', () => {
    const rows = query(
      g6(),
      'MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN n.n AS nn, c ORDER BY nn',
    );

    // `c` is 6 for every row — the inner `n` is not the outer one. That identical value IS the
    // invariance the hoist relies on.
    expect(rows.map((r) => r.c)).toEqual([6, 6, 6, 6, 6, 6]);
  });

  test('⚠️ a SCOPED body is CORRELATED and must NOT be hoisted', () => {
    const rows = query(
      g6(),
      'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN n.n AS nn, c ORDER BY nn',
    );

    // Degree 1, so every row gets 1 — and a hoisted first row would give all six the same value,
    // which here is indistinguishable. The 6-vs-1 contrast with the test above is what separates
    // the two spellings; this pins that the scoped form still answers per row.
    expect(rows.map((r) => r.c)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test('a scoped body whose answer DIFFERS per row — the real anti-hoist check', () => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 0 } });
    const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });
    const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { n: 2 } });

    // Out-degrees 2, 1, 0 — three DIFFERENT answers, so hoisting any one of them is visible.
    graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    graph.addEdge({ id: 'e2', from: a, to: c, labels: ['E'] });
    graph.addEdge({ id: 'e3', from: b, to: c, labels: ['E'] });

    const rows = query(
      graph,
      'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN n.n AS nn, c ORDER BY nn',
    );

    expect(rows.map((r) => r.c)).toEqual([2, 1, 0]);
  });

  test('an unscoped body with a SET-OP part still answers correctly', () => {
    const rows = query(
      g6(),
      'MATCH (n:P) CALL { MATCH (x:P) RETURN x.n AS v UNION MATCH (x:P) WHERE x.n < 2 RETURN x.n AS v } RETURN count(*) AS t',
    );

    // Six outer rows x six distinct `v` from the union.
    expect(rows).toEqual([{ t: 36 }]);
  });
});

describe('⚠️ the guards, each of which a mutant removes', () => {
  test('a WRITING unscoped body runs ONCE PER OUTER ROW, not once', () => {
    // The guard that matters most: ISO runs a non-correlated subquery per outer row, so its writes
    // happen per row. Hoisting would create ONE `:Q` instead of four.
    const graph = plain();

    query(graph, 'MATCH (n:P) CALL { INSERT (:Q) } RETURN count(*) AS t');

    expect(countLabel(graph, 'Q')).toBe(4);
  });

  test('a writing body still runs per row when the outer query has MANY rows', () => {
    const graph = new Graph();

    for (let i = 0; i < 7; i += 1) {
      graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
    }

    query(graph, 'MATCH (n:P) CALL { INSERT (:Q) } RETURN count(*) AS t');

    expect(countLabel(graph, 'Q')).toBe(7);
  });

  test('⚠️ a NESTED inline CALL that writes blocks the hoist too — found by a surviving mutant', () => {
    // `bodyIsReadOnly` recurses into a nested `callInline`, and nothing tested that: the
    // `no-recursion` mutant (treat any nested CALL as read-only) survived all 3,921 tests.
    //
    // I nearly recorded it as unreachable, on the grounds that `CALL { CALL { INSERT … } }` raises
    // "a query must end in RETURN or FINISH". It does — but the inner body only needs a RETURN,
    // and then it is perfectly expressible. Item 1562's lesson: "unreachable because the language
    // forbids it" is a claim about the IMPLEMENTATION, so check it.
    const graph = plain();

    query(
      graph,
      'MATCH (n:P) CALL { CALL { INSERT (:Q) RETURN 1 AS z } RETURN 1 AS y } RETURN count(*) AS t',
    );

    expect(countLabel(graph, 'Q')).toBe(4);
  });

  test('a write directly in the unscoped body, followed by a RETURN, is also not hoisted', () => {
    const graph = plain();

    query(graph, 'MATCH (n:P) CALL { INSERT (:Q) RETURN 1 AS z } RETURN count(*) AS t');

    expect(countLabel(graph, 'Q')).toBe(4);
  });

  test('⚠️ the hoist is LAZY — no outer rows means the body never runs', () => {
    // An eager computation would run the body once even with nothing to join it to. A writing body
    // makes that observable: zero outer rows must mean zero inserts.
    const graph = plain();

    query(graph, 'MATCH (n:Nope) CALL { INSERT (:Q) } RETURN count(*) AS t');

    expect(countLabel(graph, 'Q')).toBe(0);
  });

  test('an empty unscoped body drops the outer rows, and OPTIONAL keeps them null-filled', () => {
    const graph = g6();

    expect(
      query(graph, 'MATCH (n:P) CALL { MATCH (z:Nope) RETURN z.n AS c } RETURN count(*) AS t'),
    ).toEqual([{ t: 0 }]);

    const kept = query(
      graph,
      'MATCH (n:P) OPTIONAL CALL { MATCH (z:Nope) RETURN z.n AS c } RETURN n.n AS nn, c ORDER BY nn',
    );

    expect(kept.length).toBe(6);
    expect(kept.every((r) => r.c === null)).toBe(true);
  });
});
