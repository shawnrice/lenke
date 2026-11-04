import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { farDrivenPaysForMultiType } from './executor/hop-projection.js';
import { query } from './index.js';

/**
 * The multi-type hop's ROUTE CHOICE, tested as arithmetic (item 1390).
 *
 * This needs its own test for a reason that applies to every perf gate in this repo: a route choice
 * is ANSWER-EQUIVALENT. Both walks return the same rows, so every differential test, fuzzer and
 * correctness suite passes whichever one is picked — and a gate that chooses backwards is invisible
 * to all of them. The first version of this gate DID choose backwards (it used `candidateCount`,
 * which counts label matches rather than vertices that receive edges, so it read a degree of 1.33
 * where the real in-degree was 133) and the entire suite stayed green; only the bench caught it,
 * at 55.7 ms against the 17.2 the refused route delivers.
 *
 * So the arithmetic is extracted and pinned here, and the rows are checked separately — the pattern
 * `perf-gate-needs-its-own-test` records.
 */
describe('farDrivenPaysForMultiType — the gate arithmetic (item 1390)', () => {
  test('a fan-in of 1 declines: there is no hoist to amortize', () => {
    // 266,667 edges over 200,000 receiving vertices is a degree of 1.33, where the far-driven walk
    // measured 86.1 ms against the start-driven 69.3.
    expect(farDrivenPaysForMultiType(266_667, 200_000)).toBe(false);
  });

  test('a fan-in of ~133 accepts: the hoist has 133 rows to spread one projectRow over', () => {
    // The same edges into 2,000 receiving vertices, where it measured 16.1 against 55.7.
    expect(farDrivenPaysForMultiType(266_667, 2_000)).toBe(true);
  });

  // ⚠️ THESE ENCODE THE THRESHOLD'S VALUE, which is the point: it is 4 since item 1403 (it was 8,
  // calibrated at out-degree 1 only, and refused a route worth 32-43.5% at degree 3-4). A test that
  // pins a measured constant has to be edited when the measurement changes — that is the cost of
  // the constant being measured rather than assumed, and it is the right cost to pay. It has moved
  // twice: 8 -> 4 (item 1403, out-degree never swept) and 4 -> 3 (item 1406, the DISJOINT-type
  // fixture puts the crossover between true degree 2 and 3).
  test('the threshold is a FLOOR, not a strict crossing', () => {
    expect(farDrivenPaysForMultiType(30, 10)).toBe(true);
    expect(farDrivenPaysForMultiType(29, 10)).toBe(false);
  });

  // ZERO ENDPOINTS IS THE DIVIDE-BY-ZERO CASE, and it is reachable: a graph with vertices and no
  // edges at all. Expressed as a multiplication rather than a division precisely so there is no
  // `Infinity` to reason about, but the guard is asserted rather than assumed.
  test('no receiving vertices declines rather than dividing', () => {
    expect(farDrivenPaysForMultiType(0, 0)).toBe(false);
    expect(farDrivenPaysForMultiType(100, 0)).toBe(false);
  });

  test('it is monotone in both arguments, which is what makes it a cost model', () => {
    expect(farDrivenPaysForMultiType(1_000, 10)).toBe(true);
    // More edges can only make the hoist more worthwhile.
    expect(farDrivenPaysForMultiType(2_000, 10)).toBe(true);
    // More receiving vertices can only make it less.
    expect(farDrivenPaysForMultiType(1_000, 1_000)).toBe(false);
  });
});

/**
 * Both routes answer identically, on fixtures that take DIFFERENT routes.
 *
 * The gate's whole premise is that these are interchangeable, so the premise is checked: one
 * fixture whose fan-in is 1 (start-driven) and one whose fan-in is high (far-driven), with the same
 * question asked of both and the answer derived by hand rather than from the engine.
 */
const chain = (n: number, endpoints: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${i % endpoints}`)!,
      // Every third edge carries both, so the two buckets overlap and the dedupe is live.
      labels: i % 3 === 0 ? ['E', 'F'] : ['E'],
      properties: {},
    });
  }

  return g;
};

const rowsOf = (g: Graph, src: string): unknown[] => query(g, src).map((r) => r['x']);

describe('the two multi-type routes agree (item 1390)', () => {
  test('fan-in 1 takes the start-driven walk and answers 60 rows', () => {
    const g = chain(60, 60);

    expect(farDrivenPaysForMultiType(60 + 20, 60)).toBe(false);
    expect(rowsOf(g, 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.k AS x')).toHaveLength(60);
  });

  test('fan-in 30 takes the far-driven walk and answers the SAME 60 rows', () => {
    const g = chain(60, 2);

    expect(farDrivenPaysForMultiType(60 + 20, 2)).toBe(true);
    expect(rowsOf(g, 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.k AS x')).toHaveLength(60);
  });

  test('the two fixtures give the same multiset per endpoint, which is the equivalence that matters', () => {
    const wide = chain(60, 2);
    // 60 edges into 2 endpoints: 30 each, every one of them selected exactly once.
    const got = rowsOf(wide, 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.k AS x');

    expect(got.filter((x) => x === 0)).toHaveLength(30);
    expect(got.filter((x) => x === 1)).toHaveLength(30);
  });

  test('a two-type edge is deduped whichever route is taken', () => {
    // 3 edges, all into `v0`, and `e0` carries BOTH types — so a summing route answers 4.
    const g = new Graph();

    for (const id of ['v0', 'v1', 'v2', 'v3']) {
      g.addVertex({ id, labels: ['P'], properties: { k: id } });
    }

    g.addEdge({
      id: 'e0',
      from: g.getVertexById('v1')!,
      to: g.getVertexById('v0')!,
      labels: ['E', 'F'],
      properties: {},
    });
    g.addEdge({
      id: 'e1',
      from: g.getVertexById('v2')!,
      to: g.getVertexById('v0')!,
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'e2',
      from: g.getVertexById('v3')!,
      to: g.getVertexById('v0')!,
      labels: ['F'],
      properties: {},
    });

    // 4 edge-bucket memberships over 1 receiving vertex is a degree of 4, which is now AT the
    // threshold and accepts (item 1403 lowered it from 8). So this case got STRONGER rather than
    // needing a rewrite: it used to take the start-driven walk, making the test name's "far-driven"
    // aspirational, and now it genuinely exercises the far-driven arm's own dedupe on a graph where
    // a summing route would answer 4 against the correct 3.
    expect(farDrivenPaysForMultiType(4, 1)).toBe(true);
    expect(rowsOf(g, 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.k AS x')).toHaveLength(3);
  });
});

/**
 * A COMPOUND far label on the far-driven route — the case mutation testing found uncovered.
 *
 * Item 1390's mutant M4 removed the `matchesLabel(far, farLabel)` test from the far-driven
 * multi-type walk and SURVIVED the whole suite. The hole is reachable: `hopEnds` constrains the
 * START label to a simple one, but the FAR label may be any expression, and `candidateVertexSource`
 * seeds from a label bucket only for a SIMPLE label — for anything else it yields every vertex and
 * leaves the filtering to its caller. So on `:A&B` that check is the only thing doing the work.
 *
 * The fan-in is 20, over the gate's threshold, so this fixture takes the far-driven route rather
 * than describing it.
 */
const compoundFar = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i += 1) {
    g.addVertex({ id: `s${i}`, labels: ['S'], properties: { k: i } });
  }

  // One endpoint carries BOTH labels and the other only `A`, so `:A&B` must keep one and drop the
  // other — a walk that skips the test answers 40 where 20 is right.
  g.addVertex({ id: 'both', labels: ['A', 'B'], properties: { k: 100 } });
  g.addVertex({ id: 'onlyA', labels: ['A'], properties: { k: 200 } });

  for (let i = 0; i < 40; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`s${i}`)!,
      to: g.getVertexById(i % 2 === 0 ? 'both' : 'onlyA')!,
      labels: i % 3 === 0 ? ['E', 'F'] : ['E'],
      properties: {},
    });
  }

  return g;
};

describe('a COMPOUND far label still filters on the far-driven route (item 1390)', () => {
  test('the gate accepts this fixture, so the route under test is the far-driven one', () => {
    // 40 `E` plus 14 `F` memberships over 2 receiving vertices is a degree well over the threshold.
    expect(farDrivenPaysForMultiType(54, 2)).toBe(true);
  });

  test('`:A&B` keeps only the endpoint carrying both labels', () => {
    expect(rowsOf(compoundFar(), 'MATCH (a)-[:E|F]->(b:A&B) RETURN b.k AS x')).toHaveLength(20);
  });

  test('a SIMPLE far label keeps both endpoints, which pins that 20 is a filter and not a bug', () => {
    expect(rowsOf(compoundFar(), 'MATCH (a)-[:E|F]->(b:A) RETURN b.k AS x')).toHaveLength(40);
    expect(rowsOf(compoundFar(), 'MATCH (a)-[:E|F]->(b) RETURN b.k AS x')).toHaveLength(40);
  });

  test('every kept row IS the both-labelled endpoint', () => {
    const got = rowsOf(compoundFar(), 'MATCH (a)-[:E|F]->(b:A&B) RETURN b.k AS x');

    expect(new Set(got)).toEqual(new Set([100]));
  });
});
