// The three-hop count's flat-array degree product (item 1685), and the clauses that must decline it.
//
// ⚠️ A WRONGLY RELAXED CLAUSE RETURNS A WRONG COUNT, so the differential assertions below catch it.
// A wrongly TIGHTENED one silently abandons the arm and every answer stays right — which is what
// `csrDegreeProductApplies`' own unit test is for. Both directions are covered here deliberately.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';
import { csrDegreeProductApplies } from './three-hop-degree-product.js';

/**
 * A fixture whose answer is NOT determined by arithmetic. Out-degrees vary AND in-degrees vary —
 * item 1684 shipped a fixture that was in-regular with varying out-degree, where a 3-walk count is
 * exactly `N * F^k` however the traversal behaves, so neither a correct nor a broken route could be
 * told apart. Labels and properties are spread so the declining cases below have something to bite.
 */
const build = (n = 400): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: i % 5 === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: i % 23 },
      }),
    );
  }

  let e = 0;

  for (let i = 0; i < n; i += 1) {
    const deg = 1 + ((i * 2654435761) % 4);

    for (let r = 0; r < deg; r += 1) {
      const mix = ((i * 2654435761) ^ ((i >> 7) * 40503) ^ (r * 104_729)) & 0x7fffffff;

      g.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[mix % n],
        labels: [r % 3 === 0 ? 'F' : 'E'],
        properties: {},
      });
      e += 1;
    }
  }

  return g;
};

const g = build();
const countOf = (q: string): number => Number(query(g, q)[0].c);

/**
 * The oracle: the same question answered by enumerating paths in a subquery, which cannot take the
 * degree product. `COUNT { … }` over a three-segment pattern goes to the per-anchor composition
 * (item 1684's route map), so the two routes are genuinely different code.
 */
const viaSubquery = (pattern: string): number =>
  Number(query(g, `MATCH (a:P) RETURN sum(COUNT { (a)${pattern} }) AS c`)[0].c);

describe('the fast arm agrees with an independent route', () => {
  const CASES: [string, string][] = [
    ['all directed, no labels', '-[:E]->(b)-[:E]->(c)-[:E]->(d)'],
    ['mixed edge types', '-[:E]->(b)-[:F]->(c)-[:E]->(d)'],
    ['inward first leg', '<-[:E]-(b)-[:E]->(c)-[:E]->(d)'],
    ['inward middle leg', '-[:E]->(b)<-[:E]-(c)-[:E]->(d)'],
    ['inward last leg', '-[:E]->(b)-[:E]->(c)<-[:E]-(d)'],
    ['all inward', '<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)'],
  ];

  for (const [name, pattern] of CASES) {
    test(`${name} — same count as the subquery route`, () => {
      const direct = countOf(`MATCH (a:P)${pattern} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern));
      // Non-zero, or the agreement above is two zeroes agreeing.
      expect(direct).toBeGreaterThan(0);
    });
  }
});

describe('⚠️ the clauses that must DECLINE, each still answering correctly', () => {
  /**
   * Each of these would be a WRONG COUNT if the arm took it, because a degree array cannot express
   * the constraint. The assertion is against the subquery route, so a relaxed guard shows up as a
   * disagreement rather than as a slow query.
   */
  const CASES: [string, string][] = [
    ['an undirected first leg', '-[:E]-(b)-[:E]->(c)-[:E]->(d)'],
    ['an undirected middle leg', '-[:E]->(b)-[:E]-(c)-[:E]->(d)'],
    ['an undirected last leg', '-[:E]->(b)-[:E]->(c)-[:E]-(d)'],
    ['a label at the far end', '-[:E]->(b)-[:E]->(c)-[:E]->(d:Q)'],
    ['a label at the c position', '-[:E]->(b)-[:E]->(c:Q)-[:E]->(d)'],
  ];

  for (const [name, pattern] of CASES) {
    test(`${name} — declines and still agrees`, () => {
      const direct = countOf(`MATCH (a:P)${pattern} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern));
      expect(direct).toBeGreaterThan(0);
    });
  }

  /**
   * ⚠️ A LABEL AT THE START IS THE SUBTLE ONE. `(a:Q)` constrains a position the arm reaches only as
   * a DEGREE, so it must decline — but `(a:P)` on an all-`P` graph is VACUOUS and `effectiveLabel`
   * returns `undefined` for it, so that one still qualifies. The two cannot be told apart by
   * looking at the pattern.
   */
  test('⚠️ a NON-vacuous start label declines, where a vacuous one qualifies', () => {
    const nonVacuous = countOf('MATCH (a:Q)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c');
    const vacuous = countOf('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c');

    expect(nonVacuous).toBe(
      Number(
        query(g, 'MATCH (a:Q) RETURN sum(COUNT { (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) }) AS c')[0].c,
      ),
    );
    // Only a fifth of the vertices are `:Q`, so the two must differ — otherwise this test would
    // pass with the start label ignored entirely.
    expect(nonVacuous).toBeLessThan(vacuous);
    expect(nonVacuous).toBeGreaterThan(0);
  });

  test('an interior gate declines and still agrees', () => {
    const direct = countOf(
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k > 10 RETURN count(*) AS c',
    );

    expect(direct).toBe(
      Number(
        query(
          g,
          'MATCH (a:P) RETURN sum(COUNT { (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k > 10 }) AS c',
        )[0].c,
      ),
    );
    expect(direct).toBeGreaterThan(0);
  });
});

describe('a write between two counts is seen', () => {
  /**
   * The arm reads three `topologyVersion`-keyed CSRs, so this is the "count, write, count" shape a
   * cache with no invalidation answers correctly forever.
   */
  /**
   * ⚠️ THE INVARIANT IS AGREEMENT WITH THE ORACLE AFTER THE WRITE, NOT "the number moved" — and the
   * first version of this test asserted the latter and FAILED for a legitimate reason. Adding
   * `v0 -> v1` left the count at 100 because `v0` has no in-edges on this fixture, so no 3-walk can
   * route through that edge: `indeg(v0) * …` is zero however many edges leave it. The test was
   * encoding a guess about the fixture, not the cache's contract.
   *
   * So the write is chosen at run time to be one that MUST change the answer — an endpoint with both
   * an in-edge and an out-edge — and both halves are asserted: the count moves, and it equals what a
   * graph built that way from the start reports.
   */
  test('an added edge is seen by the second count', () => {
    const h = build(50);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c';
    const indeg = new Map<string, number>();

    for (const edge of h.edges) {
      indeg.set(edge.toId, (indeg.get(edge.toId) ?? 0) + 1);
    }

    const from = [...h.vertices].find(
      (v) => (indeg.get(v.id) ?? 0) > 0 && (v.adjFrom?.get('E')?.size ?? 0) > 0,
    );

    expect(from).toBeDefined();

    const to = [...h.vertices].find((v) => (v.adjFrom?.get('E')?.size ?? 0) > 0);

    expect(to).toBeDefined();

    const before = Number(query(h, q)[0].c);

    h.addEdge({ id: 'extra', from: from!, to: to!, labels: ['E'], properties: {} });

    const after = Number(query(h, q)[0].c);

    expect(after).not.toBe(before);

    // And it agrees with a graph built that way from the start — the stale-cache check.
    const fresh = build(50);
    fresh.addEdge({
      id: 'extra',
      from: fresh.getVertexById(from!.id)!,
      to: fresh.getVertexById(to!.id)!,
      labels: ['E'],
      properties: {},
    });

    expect(after).toBe(Number(query(fresh, q)[0].c));
  });

  test('⚠️ an edge GAINING the walked type changes the count', () => {
    const h = build(50);
    const q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c';
    const anF = [...h.edges].find((edge) => edge.labels.has('F') && !edge.labels.has('E'));

    expect(anF).toBeDefined();

    const before = Number(query(h, q)[0].c);
    h.addLabelToEdge('E', anF!);

    expect(Number(query(h, q)[0].c)).not.toBe(before);
  });
});

describe('csrDegreeProductApplies — the route choice as a pure function', () => {
  const ok = {
    aBoth: false,
    midBoth: false,
    dBoth: false,
    aEff: undefined,
    cEff: undefined,
    dEff: undefined,
    bGated: false,
    cGated: false,
  };

  test('the all-clear case applies', () => {
    expect(csrDegreeProductApplies(ok)).toBe(true);
  });

  /**
   * ⚠️ THE DIRECTION A DIFFERENTIAL TEST CANNOT SEE. A clause wrongly TIGHTENED keeps every answer
   * correct and silently abandons the arm, so only a direct assertion catches it — the same reason
   * `walkKindFor` has its own test (`perf-gate-needs-its-own-test`).
   */
  test('⚠️ each clause declines on its own, and nothing else does', () => {
    expect(csrDegreeProductApplies({ ...ok, aBoth: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, midBoth: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, dBoth: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, aEff: { kind: 'label', name: 'Q' } })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, cEff: { kind: 'label', name: 'Q' } })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, dEff: { kind: 'label', name: 'Q' } })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, bGated: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...ok, cGated: true })).toBe(false);
  });
});
