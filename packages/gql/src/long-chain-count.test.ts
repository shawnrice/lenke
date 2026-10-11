// Item 298. The count family was smooth to FOUR segments and fell off a cliff at FIVE: 200 nodes
// of degree 5, min of 3, the rate per path was 8.7 / 9.9 ns at three and four hops and 425.6 ns
// at five, flat at 433.2 by six — the signature of the general matcher, which builds a binding
// per path. `longChainCount` answers five or more segments as a forward sweep of way counts,
// O(hops x edges) in time and O(vertices) in memory: 266.03 -> 0.37 ms at five hops (719x) and
// 1353.82 -> 0.52 ms at six (2603x).
//
// EVERY TEST HERE HAS AN ORACLE, and it is the engine's own other route. A clause `WHERE` over
// four or more segments declines the whole shortcut family (`detectCountShortcut` returns `null`
// there), so adding an always-true predicate that READS a variable forces the identical question
// onto the general matcher. `sweptAndWalked` asks both and requires them equal. That is the
// safety argument: a sweep that mis-attributes a weight returns a plausible number, and only a
// second route disagrees with it.
import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * An IRREGULAR graph, on purpose. Equal degrees hide a mis-weighted sweep — every wrong
 * attribution lands on a bucket of the same size — so degrees here vary per vertex, labels are
 * mixed, and two edge types interleave.
 */
const g = (): Graph => {
  const graph = new Graph();
  const ids: Vertex[] = [];

  for (let i = 0; i < 24; i++) {
    ids.push(
      graph.addVertex({
        // Three labels, unevenly spread, so a label test at any position changes the answer.
        labels: [i % 3 === 0 ? 'A' : 'B', 'N'],
        properties: { i },
      }),
    );
  }

  for (let i = 0; i < ids.length; i++) {
    // Degrees 1..4, varying with i.
    for (let d = 0; d <= i % 4; d++) {
      graph.addEdge({
        from: ids[i],
        to: ids[(i * 5 + d * 7 + 1) % ids.length],
        labels: [d % 2 === 0 ? 'E' : 'F'],
        properties: { d },
      });
    }
  }

  return graph;
};

const countOf = (q: string): number => {
  const [row] = [...query(g(), q)] as { c: number }[];

  return row?.c ?? -1;
};

/**
 * The same question down both routes. `tail` is appended verbatim; it must be a predicate that
 * READS a bound name (a constant `WHERE 1 = 1` is a different gate) and that is true of every
 * vertex in the fixture, so the only thing it changes is the ROUTE.
 */
const sweptAndWalked = (pattern: string): number => {
  const swept = countOf(`MATCH ${pattern} RETURN count(*) AS c`);
  const walked = countOf(`MATCH ${pattern} WHERE a.i >= 0 RETURN count(*) AS c`);

  expect(swept).toBe(walked);

  return swept;
};

/** The unfiltered five-segment baseline every DECLINE case is measured against. */
const PLAIN_OUT_PATTERN = '(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)';
const PLAIN_OUT = `MATCH ${PLAIN_OUT_PATTERN} RETURN count(*) AS c`;

describe('the sweep agrees with the general matcher', () => {
  test('five segments, unlabelled interior', () => {
    expect(sweptAndWalked(PLAIN_OUT_PATTERN)).toBe(204);
  });

  test('six segments', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)-[:E]->(h)'));
  });

  test('seven segments — the depth a fifth hand-written arm would not have reached', () => {
    expect(
      sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)-[:E]->(h)-[:E]->(j)'),
    );
  });

  test('a label on every position, including the two ENDS', () => {
    // The ends are what the degree products cannot carry. The sweep visits them, so it can.
    expect(sweptAndWalked('(a:A)-[:E]->(b:B)-[:E]->(c:A)-[:E]->(d:B)-[:E]->(e:A)-[:E]->(f:B)'));
  });

  test('a label on the LAST position only — the bucket-size fast path has a far label', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:A)'));
  });

  test('a label on the START position only', () => {
    expect(sweptAndWalked('(a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
  });

  test('a CONJUNCTIVE label, where the candidate source hands back a SUPERSET', () => {
    // `seedLabel` on an `and` seeds ONE side and returns the other unchecked, so
    // `candidateVertexSource(:N&A)` yields all 24 `N` vertices and the explicit `matchesLabel`
    // re-test is what narrows them to the 8 that are also `A`. A mutant that dropped that
    // re-test SURVIVED every single-label case here — `:A` already seeds exactly the right
    // bucket, and `:N` is vacuous — and only a conjunction whose seeded side is a superset
    // tells them apart: 68 against the unnarrowed 204.
    expect(sweptAndWalked('(a:N&A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
    expect(sweptAndWalked('(a:N)-[:E]->(b:N&A)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:N&A)')).toBe(68);
  });

  test('every segment REVERSED', () => {
    expect(sweptAndWalked('(a:N)<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)<-[:E]-(e)<-[:E]-(f)'));
  });

  test('MIXED directions — a swapped endpoint on any leg is a different answer', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)<-[:E]-(c)-[:E]->(d)<-[:E]-(e)-[:E]->(f)'));
  });

  test('a SECOND edge type, and mixed types along the chain', () => {
    expect(sweptAndWalked('(a:N)-[:F]->(b)-[:F]->(c)-[:F]->(d)-[:F]->(e)-[:F]->(f)'));
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:F]->(c)-[:E]->(d)-[:F]->(e)-[:E]->(f)'));
  });

  test('an UNTYPED relationship spans both buckets', () => {
    // The abbreviated edge pattern, which carries no type — so `relTypeNames` is `undefined` and
    // both `edgesOfTypes` and `bucketSize` take their every-bucket route.
    expect(sweptAndWalked('(a:N)->(b)->(c)->(d)->(e)->(f)'));
  });

  test('a chain that DIES in the middle counts 0, and still counts a row', () => {
    // No vertex carries `Z`, so position 3 is empty and the early return fires. ISO yields one
    // row of zero for an aggregate with no GROUP BY, which the sweep must not swallow.
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c:Z)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  test('a chain whose LAST position is empty counts 0', () => {
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:Z) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  test('an unreachable edge TYPE counts 0', () => {
    expect(
      countOf(
        'MATCH (a:N)-[:NOPE]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });
});

describe('what the sweep must DECLINE, and still answer correctly', () => {
  // Each of these falls through to the general matcher. The test is that the answer is right —
  // a sweep that wrongly accepted one would return a number that cannot be expressed as a
  // product of way counts.
  test('a SHARED node variable is a self-join', () => {
    // `a` appears twice, so the chain must close on itself. The sweep has no way to express
    // that: its way counts have forgotten where they came from, so it must decline.
    //
    // Its own fixture, because the discriminating evidence is that the closed count is BOTH
    // smaller than the open one AND non-zero — if the sweep had wrongly accepted the shape it
    // would have answered `open`, and a zero would not have told them apart. A ring of 10 with
    // steps +1 and +2 gives 10 x 2^5 = 320 open 5-walks and, since a closed one needs five steps
    // summing to 10, exactly 10 closed ones (all +2).
    const ring = new Graph();
    const ids = Array.from({ length: 10 }, (_, i) =>
      ring.addVertex({ labels: ['N'], properties: { i } }),
    );

    for (let i = 0; i < 10; i++) {
      for (const step of [1, 2]) {
        ring.addEdge({ from: ids[i], to: ids[(i + step) % 10], labels: ['E'], properties: {} });
      }
    }

    const on = (q: string): number => ([...query(ring, q)] as { c: number }[])[0]?.c ?? -1;
    const closed = on(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(a) RETURN count(*) AS c',
    );
    const open = on(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
    );

    expect(open).toBe(320);
    expect(closed).toBe(10);
  });

  test('an INLINE property constraint declines', () => {
    const constrained = countOf(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c {i: 1})-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
    );
    expect(constrained).toBeLessThan(countOf(PLAIN_OUT));
  });

  test('a BOUND relationship variable declines', () => {
    expect(
      countOf(
        'MATCH (a:N)-[r:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(
      countOf('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    );
  });

  test('an UNDIRECTED segment declines — it is not one direction or the other', () => {
    // EXACT, not an inequality. `>= PLAIN_OUT` was the first spelling and a mutant that dropped
    // the `'both'` gate SURVIVED it: taking the segment as whichever direction it was written
    // makes the two counts EQUAL, which `>=` accepts. Measured both positions, because a gate
    // that only covers the first leg is the same bug one segment along.
    expect(
      countOf('MATCH (a:N)-[:E]-(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    ).toBe(420);
    expect(
      countOf('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]-(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    ).toBe(420);
    expect(countOf(PLAIN_OUT)).toBe(204);
  });

  test('a VARIABLE-LENGTH quantifier declines', () => {
    // `plainRel` refuses a quantifier. EXACT for the same reason: `> 0` let a mutant that
    // dropped the `plainRel` gate through, because a quantified leg taken as a single hop still
    // returns a positive number.
    expect(
      countOf(
        'MATCH (a:N)-[:E]->{1,2}(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(522);
  });

  test('an INLINE RELATIONSHIP property declines', () => {
    // The other half of `plainRel`, and the one no other gate covers: there is no relationship
    // VARIABLE here, so `s.rel.variable !== undefined` does not catch it.
    expect(
      countOf(
        'MATCH (a:N)-[:E {d: 0}]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(132);
  });
});

describe('the sweep is BOUNDED in the path count, which is the point', () => {
  // The incident shape. 120 nodes at degree 5 is 120 x 5^7 = 9.375M seven-hop paths; the sweep
  // does 7 passes over 600 edges. A unit test cannot assert an RSS or a time, so what it pins is
  // that a count no enumeration could finish is still EXACT — checked against the closed form,
  // which this fixture has because every vertex has exactly degree 5.
  const regular = (): Graph => {
    const graph = new Graph();
    const ids = Array.from({ length: 120 }, (_, i) =>
      graph.addVertex({ labels: ['N'], properties: { i } }),
    );

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < 5; d++) {
        graph.addEdge({
          from: ids[i],
          to: ids[(i * 11 + d) % ids.length],
          labels: ['E'],
          properties: {},
        });
      }
    }

    return graph;
  };

  test('a seven-hop count over 9.4M paths is exact', () => {
    const q = `MATCH (a:N)${'-[:E]->()'.repeat(7)} RETURN count(*) AS c`;
    const [row] = [...query(regular(), q)] as { c: number }[];

    expect(row?.c).toBe(120 * 5 ** 7);
  });

  test('a TEN-hop count, where the general matcher would enumerate 1.17e9 paths', () => {
    const q = `MATCH (a:N)${'-[:E]->()'.repeat(10)} RETURN count(*) AS c`;
    const [row] = [...query(regular(), q)] as { c: number }[];

    expect(row?.c).toBe(120 * 5 ** 10);
  });
});
