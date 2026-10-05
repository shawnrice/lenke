import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode } from '@lenke/errors';
import type { LenkeError } from '@lenke/errors';

import { query } from './index.js';

// The two hop-count walks are now driven from the VERTEX side rather than the edge index (audit
// item 164): creation order for locality, and the degree summed only for vertices the predicate
// keeps. Measured 102.1ms -> 50.3ms on the far row and 75.7 -> 43.0 on the start row, and
// 8.7x on a selective predicate, where the old walk was flat in selectivity.
//
// Two things that were previously IMPOSSIBLE are now possible and are what these tests exist
// for:
//
//   1. A DEGREE-0 vertex is now visited. It must contribute 0 — iterating it at all is new.
//   2. The predicate is evaluated BEFORE the degree is known, so a vertex the old walk never
//      reached could now surface a fault. A `catch` re-throws only when the degree is non-zero.
//      That is the raise-parity class of items 139, 142, 144 and 145.

/**
 * `a` and `b` are sources; `x1` has TWO in-edges, `x2` one, `x3` none. Degrees are deliberately
 * uneven: a 1:1 fixture cannot tell a degree sum from a vertex count, which is this walk's whole
 * job (and the fixture mistake item 156 made).
 */
const fixture = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['Src'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['Src'], properties: { n: 2 } });
  g.addVertex({ id: 'x1', labels: ['Dst'], properties: { n: 10 } });
  g.addVertex({ id: 'x2', labels: ['Dst'], properties: { n: 20 } });
  g.addVertex({ id: 'x3', labels: ['Dst'], properties: { n: 30 } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('x1'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('b'), to: v('x1'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: v('a'), to: v('x2'), labels: ['E'], properties: {} });

  return g;
};

const count = (g: Graph, q: string): unknown => query(g, q)[0]?.c;

describe('the far-end hop count sums degrees, not vertices', () => {
  test('a predicate keeping both reached far vertices counts every edge', () => {
    // x1 has two in-edges and x2 one, so the answer is 3 and not 2.
    expect(count(fixture(), 'MATCH (a)-[:E]->(x:Dst) WHERE x.n > 5 RETURN count(*) AS c')).toBe(3);
  });

  test('a predicate keeping only the DOUBLE-degree vertex counts 2', () => {
    expect(count(fixture(), 'MATCH (a)-[:E]->(x:Dst) WHERE x.n < 15 RETURN count(*) AS c')).toBe(2);
  });

  test('a predicate keeping only the single-degree vertex counts 1', () => {
    expect(count(fixture(), 'MATCH (a)-[:E]->(x:Dst) WHERE x.n = 20 RETURN count(*) AS c')).toBe(1);
  });

  test('a DEGREE-0 vertex that passes the predicate contributes nothing', () => {
    // x3 passes `n > 5` and has no in-edges. The old walk never saw it at all; the new one
    // visits it and must add 0. Were it counted as 1, the first test above would read 4.
    const g = fixture();

    expect(count(g, 'MATCH (a)-[:E]->(x:Dst) WHERE x.n > 25 RETURN count(*) AS c')).toBe(0);
  });

  test('a predicate matching nothing counts 0', () => {
    expect(count(fixture(), 'MATCH (a)-[:E]->(x:Dst) WHERE x.n > 99 RETURN count(*) AS c')).toBe(0);
  });

  test('an untyped hop sums every type', () => {
    // The `types === undefined` branch of the degree sum, reachable only while no edge carries
    // two types (`multiTypeEdgeCount === 0`).
    const g = fixture();
    const v = (id: string) => g.getVertexById(id)!;

    g.addEdge({ id: 'f1', from: v('a'), to: v('x2'), labels: ['F'], properties: {} });

    expect(count(g, 'MATCH (a)-[]->(x:Dst) WHERE x.n > 5 RETURN count(*) AS c')).toBe(4);
  });

  test('a two-type hop sums both named buckets', () => {
    const g = fixture();
    const v = (id: string) => g.getVertexById(id)!;

    g.addEdge({ id: 'f1', from: v('a'), to: v('x2'), labels: ['F'], properties: {} });

    expect(count(g, 'MATCH (a)-[:E|F]->(x:Dst) WHERE x.n > 5 RETURN count(*) AS c')).toBe(4);
    expect(count(g, 'MATCH (a)-[:F]->(x:Dst) WHERE x.n > 5 RETURN count(*) AS c')).toBe(1);
  });

  test('the incoming direction reads the other index', () => {
    // Reversed, the far end is the SOURCE: `a` has two out-edges and `b` one.
    expect(count(fixture(), 'MATCH (x)<-[:E]-(y:Src) WHERE y.n > 0 RETURN count(*) AS c')).toBe(3);
  });

  test('a CONJUNCTION label rejects a vertex the seed bucket includes', () => {
    // A mutant that dropped `matchesLabel` entirely SURVIVED all 17 tests, because
    // `candidateVertexSource` already narrows to the seed label's bucket — so the filter only
    // matters where the label expression is NARROWER than the seed, and the original fixture had
    // no such vertex carrying in-edges. That is fixture blindness, so here is the case.
    //
    // `:Dst&Tag` seeds on `Dst`, whose bucket includes `x5` — which is NOT tagged and DOES have
    // an in-edge. Only `matchesLabel` keeps it out of the sum.
    const g = fixture();
    const v = (id: string) => g.getVertexById(id)!;

    g.addLabelToVertex('Tag', v('x1'));
    g.addVertex({ id: 'x5', labels: ['Dst'], properties: { n: 50 } });
    g.addEdge({ id: 'e9', from: v('a'), to: v('x5'), labels: ['E'], properties: {} });

    // x1 is tagged and has two in-edges; x5 is untagged with one, and must not be counted.
    expect(count(g, 'MATCH (a)-[:E]->(x:Dst&Tag) WHERE x.n > 5 RETURN count(*) AS c')).toBe(2);
  });

  test('a disjunction label rejects a non-matching vertex that has in-edges', () => {
    // The other arm: `seedLabel` gives up on an `or`, so the walk scans EVERY vertex and
    // `matchesLabel` is the only thing excluding the `Other`-labelled vertex — which here has an
    // in-edge, unlike anything in the base fixture.
    const g = fixture();
    const v = (id: string) => g.getVertexById(id)!;

    g.addVertex({ id: 'o', labels: ['Other'], properties: { n: 60 } });
    g.addEdge({ id: 'e8', from: v('a'), to: v('o'), labels: ['E'], properties: {} });

    expect(count(g, 'MATCH (a)-[:E]->(x:Dst|Src) WHERE x.n > 5 RETURN count(*) AS c')).toBe(3);
  });

  test('a label the seed cannot narrow still scans correctly', () => {
    // `Dst OR Src` yields no guaranteed seed label, so the walk falls back to every vertex and
    // `matchesLabel` filters — the other arm of `candidateVertexSource`.
    expect(count(fixture(), 'MATCH (a)-[:E]->(x:Dst|Src) WHERE x.n > 5 RETURN count(*) AS c')).toBe(
      3,
    );
  });
});

describe('the start-end hop count sums degrees, not vertices', () => {
  test('a predicate keeping both sources counts every edge', () => {
    // `a` has two out-edges, `b` one.
    expect(count(fixture(), 'MATCH (s:Src)-[:E]->(x) WHERE s.n > 0 RETURN count(*) AS c')).toBe(3);
  });

  test('a predicate keeping only the double-degree source counts 2', () => {
    expect(count(fixture(), 'MATCH (s:Src)-[:E]->(x) WHERE s.n = 1 RETURN count(*) AS c')).toBe(2);
  });

  test('a source with no out-edges contributes nothing', () => {
    const g = fixture();

    g.addVertex({ id: 'c', labels: ['Src'], properties: { n: 3 } });

    expect(count(g, 'MATCH (s:Src)-[:E]->(x) WHERE s.n > 0 RETURN count(*) AS c')).toBe(3);
    expect(count(g, 'MATCH (s:Src)-[:E]->(x) WHERE s.n = 3 RETURN count(*) AS c')).toBe(0);
  });
});

describe('raise parity: a fault only surfaces where the old walk would have evaluated it', () => {
  test('a predicate that faults on a DEGREE-0 vertex does not raise', () => {
    // `1 / (x.n - 30)` divides by zero on x3 alone, and x3 has no in-edges — so the walk driven
    // from the edge index never evaluated it. Visiting it must not turn that into an error.
    const g = fixture();

    // My expectation here was 2 and the test said 3. Both REACHED vertices satisfy the
    // predicate (1/(10-30) and 1/(20-30) are both < 99); the division by zero lands on x3,
    // which has no in-edges and so contributes nothing. 3 is the swallow working.
    expect(count(g, 'MATCH (a)-[:E]->(x:Dst) WHERE 1 / (x.n - 30) < 99 RETURN count(*) AS c')).toBe(
      3,
    );
  });

  test('the SAME fault on a vertex WITH an in-edge does raise', () => {
    // The pair that matters: identical predicate shape, the faulting value moved onto a vertex
    // the walk does reach. Without this, a `catch` that swallowed everything would pass the
    // test above.
    const g = fixture();
    let code: string | undefined;

    try {
      query(g, 'MATCH (a)-[:E]->(x:Dst) WHERE 1 / (x.n - 10) < 99 RETURN count(*) AS c');
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidValue);
  });

  test('giving the degree-0 vertex an edge makes the same query raise', () => {
    // The sharpest form: one query, two graphs differing only in whether x3 has an in-edge.
    const g = fixture();
    const q = 'MATCH (a)-[:E]->(x:Dst) WHERE 1 / (x.n - 30) < 99 RETURN count(*) AS c';

    expect(count(g, q)).toBe(3);

    g.addEdge({
      id: 'e4',
      from: g.getVertexById('a')!,
      to: g.getVertexById('x3')!,
      labels: ['E'],
      properties: {},
    });

    let code: string | undefined;

    try {
      query(g, q);
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidValue);
  });

  test('a type fault swallowed on a degree-0 vertex, raised on a reached one', () => {
    // A second fault shape, because `division by zero` and `arithmetic requires a number` take
    // different paths to the throw.
    const g = fixture();

    g.addVertex({ id: 'x4', labels: ['Dst'], properties: { n: 'text' } });

    expect(count(g, 'MATCH (a)-[:E]->(x:Dst) WHERE x.n + 1 > 2 RETURN count(*) AS c')).toBe(3);

    g.addEdge({
      id: 'e5',
      from: g.getVertexById('a')!,
      to: g.getVertexById('x4')!,
      labels: ['E'],
      properties: {},
    });

    let code: string | undefined;

    try {
      query(g, 'MATCH (a)-[:E]->(x:Dst) WHERE x.n + 1 > 2 RETURN count(*) AS c');
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidValue);
  });

  test('the START walk has the same parity', () => {
    const g = fixture();

    g.addVertex({ id: 'c', labels: ['Src'], properties: { n: 3 } });

    // `c` faults and has no out-edges.
    expect(count(g, 'MATCH (s:Src)-[:E]->(x) WHERE 1 / (s.n - 3) < 99 RETURN count(*) AS c')).toBe(
      3,
    );

    g.addEdge({
      id: 'e6',
      from: g.getVertexById('c')!,
      to: g.getVertexById('x1')!,
      labels: ['E'],
      properties: {},
    });

    let code: string | undefined;

    try {
      query(g, 'MATCH (s:Src)-[:E]->(x) WHERE 1 / (s.n - 3) < 99 RETURN count(*) AS c');
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidValue);
  });
});
