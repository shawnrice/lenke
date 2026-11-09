// The filtered chain count over flat slot runs (item 1688), and the shapes that must decline it.
//
// ⚠️ EVERY AGREEMENT TEST IS AGAINST AN INDEPENDENT ROUTE, not a hand-computed number: the same
// question asked as a `COUNT { … }` subquery cannot reach this arm, so a disagreement is a real
// defect rather than two copies of the same mistake.
//
// ⚠️ AND A ROUTE CHOICE IS ANSWER-EQUIVALENT WHEN IT IS *TIGHTENED*. A clause wrongly relaxed here
// returns a WRONG COUNT and these tests catch it; a clause wrongly tightened silently abandons the
// arm and every answer stays right. `filteredChainCsrApplies` has its own assertions below for that
// second direction, which is `perf-gate-needs-its-own-test`'s rule.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';
import { filteredChainCsrApplies } from './filtered-chain-csr.js';

/**
 * Out-degree AND in-degree both vary — item 1684's third fixture trap was an in-regular graph whose
 * walk counts are `N * F^k` by arithmetic however the traversal behaves. Labels and `k` are spread so
 * the filters below actually exclude something.
 *
 * ⚠️ THE LABEL AND THE PROPERTY ARE MIXED DIFFERENTLY FROM THE DEGREE, AND THAT IS A BUG FIX. The
 * first version of this fixture labelled `i % 4 === 0` while taking the degree from
 * `1 + ((i * 2654435761) % 4)` — and `i % 4 === 0` forces that product's low bits to zero, so every
 * `Q` vertex had degree 1, whose single edge is the `F` type. `(b:Q)-[:E]->` therefore counted ZERO,
 * with both routes agreeing on it: a case that proved nothing while looking like a pass. A fixture
 * whose label correlates with its degree is the same class of defect as one whose walk count is
 * `N * F^k`, so the counts are asserted non-zero below rather than assumed.
 */
const build = (n = 300): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ((i * 40_503) >>> 3) % 3 === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: ((i * 2_246_822_519) >>> 7) % 19 },
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
        labels: [r % 5 === 0 ? 'F' : 'E'],
        properties: {},
      });
      e += 1;
    }
  }

  return g;
};

const g = build();
const countOf = (q: string): number => Number(query(g, q)[0].c);

/** The oracle: a subquery, which goes to the per-anchor composition and never reaches this arm. */
const viaSubquery = (pattern: string, where = ''): number =>
  Number(query(g, `MATCH (a:P) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c);

describe('⚠️ the fixture itself, before anything measured against it is believed', () => {
  /**
   * An answer INVARIANT to the property under test cannot validate a fixture. The in-degree
   * distribution is what a 3-walk count collapses on, and the label/degree correlation above is what
   * made two whole cases count zero, so both are checked directly.
   */
  test('in-degree varies and the labels do not track the degree', () => {
    const inDeg = new Map<string, number>();
    let qWithOutE = 0;

    for (const v of g.vertices) {
      inDeg.set(v.id, 0);
    }

    for (const e of g.edges) {
      if (e.labels.has('E')) {
        inDeg.set(e.to.id, (inDeg.get(e.to.id) ?? 0) + 1);
      }
    }

    for (const v of g.vertices) {
      if (v.labels.has('Q') && [...g.edges].some((e) => e.from === v && e.labels.has('E'))) {
        qWithOutE += 1;
      }
    }

    // Not in-regular: a constant in-degree makes every walk count pure arithmetic.
    expect(new Set(inDeg.values()).size).toBeGreaterThan(2);
    // Not functional: a single target per vertex makes branching unobservable.
    expect(new Set([...g.edges].map((e) => e.to)).size).toBeGreaterThan(g.vertexCount / 2);
    // The label is reachable THROUGH an E edge, which is the correlation that bit.
    expect(qWithOutE).toBeGreaterThan(10);
  });
});

describe('the arm agrees with an independent route, every filter position', () => {
  const CASES: [string, string, string][] = [
    ['no filter, 3 legs', '-[:E]->(b)-[:E]->(c)-[:E]->(d)', ''],
    ['START filter', '-[:E]->(b)-[:E]->(c)-[:E]->(d)', ' WHERE a.k > 9'],
    ['INTERIOR filter on b', '-[:E]->(b)-[:E]->(c)-[:E]->(d)', ' WHERE b.k > 9'],
    ['INTERIOR filter on c', '-[:E]->(b)-[:E]->(c)-[:E]->(d)', ' WHERE c.k > 9'],
    ['END filter', '-[:E]->(b)-[:E]->(c)-[:E]->(d)', ' WHERE d.k > 9'],
    ['4 legs, no filter', '-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)', ''],
    ['4 legs, START filter', '-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)', ' WHERE a.k > 9'],
    ['4 legs, END filter', '-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x)', ' WHERE x.k > 9'],
    ['mixed edge types', '-[:E]->(b)-[:F]->(c)-[:E]->(d)', ' WHERE d.k > 9'],
    ['inward legs', '<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)', ' WHERE d.k > 9'],
    ['mixed directions', '-[:E]->(b)<-[:E]-(c)-[:E]->(d)', ' WHERE a.k > 9'],
    ['interior LABEL', '-[:E]->(b:Q)-[:E]->(c)-[:E]->(d)', ''],
    ['end LABEL', '-[:E]->(b)-[:E]->(c)-[:E]->(d:Q)', ''],
    ['label AND filter at once', '-[:E]->(b:Q)-[:E]->(c)-[:E]->(d)', ' WHERE d.k > 9'],
    ['inline property form', '-[:E]->(b {k: 3})-[:E]->(c)-[:E]->(d)', ''],
  ];

  for (const [name, pattern, where] of CASES) {
    test(`${name} — same count as the subquery route`, () => {
      const direct = countOf(`MATCH (a:P)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern, where));
      // Non-zero, or two zeroes are agreeing and the case proves nothing.
      expect(direct).toBeGreaterThan(0);
    });
  }
});

describe('⚠️ equivalent spellings must agree, which is this repo’s opening defect class', () => {
  /**
   * A clause `WHERE b.k = 3` and an inline `(b {k: 3})` are one question written twice. A rung that
   * takes one and declines the other makes them cost 100-300x differently while returning identical
   * answers, so no correctness test sees it — only a direct comparison does.
   */
  test('a clause WHERE and an inline property give the same count', () => {
    const clause = countOf(
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 3 RETURN count(*) AS c',
    );
    const inline = countOf('MATCH (a:P)-[:E]->(b {k: 3})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c');

    expect(clause).toBe(inline);
    expect(clause).toBeGreaterThan(0);
  });

  test('an inline WHERE on the node agrees too', () => {
    const inlineWhere = countOf(
      'MATCH (a:P)-[:E]->(b WHERE b.k = 3)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    );

    expect(inlineWhere).toBe(
      countOf('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 3 RETURN count(*) AS c'),
    );
  });
});

describe('⚠️ the shapes that must DECLINE, each still answering correctly', () => {
  /**
   * An undirected leg walks two adjacency indexes and must count a self-loop ONCE — item 1097 fixed
   * a half-answer bug there, and a single CSR run cannot express it. If the arm took these it would
   * be a wrong count, so the assertion is against the subquery route.
   */
  const CASES: [string, string][] = [
    ['an undirected first leg', '-[:E]-(b)-[:E]->(c)-[:E]->(d)'],
    ['an undirected middle leg', '-[:E]->(b)-[:E]-(c)-[:E]->(d)'],
    ['an undirected last leg', '-[:E]->(b)-[:E]->(c)-[:E]-(d)'],
    ['all legs undirected', '-[:E]-(b)-[:E]-(c)-[:E]-(d)'],
  ];

  for (const [name, pattern] of CASES) {
    test(`${name} — declines and still agrees`, () => {
      const direct = countOf(`MATCH (a:P)${pattern} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern));
      expect(direct).toBeGreaterThan(0);
    });
  }

  /**
   * ⚠️ A SELF-LOOP IS THE CASE THE UNDIRECTED EXCLUSION EXISTS FOR, so it gets a fixture of its own
   * rather than relying on the shared graph happening to contain one.
   */
  test('⚠️ an undirected chain over a self-loop agrees', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    h.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });
    h.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });

    const directed = Number(
      query(h, 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c')[0].c,
    );
    const undirected = Number(
      query(h, 'MATCH (a:P)-[:E]-(b)-[:E]-(c)-[:E]-(d) RETURN count(*) AS c')[0].c,
    );

    expect(directed).toBe(
      Number(
        query(h, 'MATCH (a:P) RETURN sum(COUNT { (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) }) AS c')[0].c,
      ),
    );
    expect(undirected).toBe(
      Number(
        query(h, 'MATCH (a:P) RETURN sum(COUNT { (a)-[:E]-(b)-[:E]-(c)-[:E]-(d) }) AS c')[0].c,
      ),
    );
  });
});

describe('a write between two counts is seen', () => {
  const Q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE d.k > 9 RETURN count(*) AS c';

  /**
   * The arm reads `topologyVersion`-keyed CSRs, so this is the "count, write, count" shape a cache
   * with no invalidation answers correctly forever.
   */
  test('an added edge is seen by the second count', () => {
    const h = build(60);

    // The first count is what POPULATES the CSR cache; its value is not the assertion.
    query(h, Q);

    h.addEdge({
      id: 'extra',
      from: h.getVertexById('v3')!,
      to: h.getVertexById('v7')!,
      labels: ['E'],
      properties: {},
    });

    const after = Number(query(h, Q)[0].c);
    const fresh = build(60);

    fresh.addEdge({
      id: 'extra',
      from: fresh.getVertexById('v3')!,
      to: fresh.getVertexById('v7')!,
      labels: ['E'],
      properties: {},
    });

    // The invariant is agreement with a graph built that way, not that the number moved — item
    // 1685's test asserted the latter and failed for a legitimate reason.
    expect(after).toBe(Number(query(fresh, Q)[0].c));
  });

  /**
   * ⚠️ A PROPERTY WRITE MUST BE SEEN THOUGH `topologyVersion` DOES NOT MOVE. The masks read
   * properties and are therefore rebuilt per call; if one were cached on that signal it would go
   * stale here with no signal to catch it.
   */
  test('⚠️ a property write changes the count with the topology unchanged', () => {
    const h = build(60);
    const before = Number(query(h, Q)[0].c);
    const tv = h.topologyVersion;

    for (const v of h.vertices) {
      v.setProperty('k', 18);
    }

    expect(h.topologyVersion).toBe(tv);

    const after = Number(query(h, Q)[0].c);

    expect(after).not.toBe(before);
    // Every `k` now passes `> 9`, so the filtered count equals the unfiltered one.
    expect(after).toBe(
      Number(query(h, 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c')[0].c),
    );
  });
});

describe('filteredChainCsrApplies — the route choice as a pure function', () => {
  const leg = (both = false) => ({
    out: true,
    both,
    types: ['E'],
    label: undefined,
    gate: undefined,
  });

  test('a directed, unseeded chain applies', () => {
    expect(filteredChainCsrApplies([leg(), leg(), leg()], false)).toBe(true);
  });

  /**
   * ⚠️ THE DIRECTION NO DIFFERENTIAL TEST CAN SEE. Each of these, if wrongly relaxed, is caught by
   * the agreement tests above — but a clause wrongly TIGHTENED keeps every answer right and silently
   * abandons the arm, so only this assertion covers it.
   */
  test('⚠️ each exclusion declines on its own', () => {
    // An undirected leg anywhere.
    expect(filteredChainCsrApplies([leg(true), leg(), leg()], false)).toBe(false);
    expect(filteredChainCsrApplies([leg(), leg(true), leg()], false)).toBe(false);
    expect(filteredChainCsrApplies([leg(), leg(), leg(true)], false)).toBe(false);
    // An index SEED: the query is already sub-linear and the O(V) masks would throw that away.
    expect(filteredChainCsrApplies([leg(), leg(), leg()], true)).toBe(false);
    // No legs at all.
    expect(filteredChainCsrApplies([], false)).toBe(false);
  });
});
