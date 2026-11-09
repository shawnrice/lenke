// The filtered two-hop count over flat slot runs (item 1690), and the shapes that must decline it.
//
// ⚠️ EVERY AGREEMENT TEST IS AGAINST AN INDEPENDENT ROUTE — the same question as a `COUNT { … }`
// subquery, which goes to the per-anchor composition and cannot reach this arm. A hand-computed
// expectation would only prove that two copies of my arithmetic agree.
//
// ⚠️ AND A ROUTE CHOICE IS ANSWER-EQUIVALENT WHEN IT IS *TIGHTENED*: a wrongly relaxed clause
// returns a WRONG COUNT and these tests catch it, while a wrongly tightened one silently abandons
// the arm and every answer stays right. `twoHopFilteredCsrApplies` carries its own assertions for
// that second direction.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';
import { twoHopFilteredCsrApplies } from './two-hop-filtered-csr.js';

/**
 * ⚠️ LABEL AND PROPERTY MIXED DIFFERENTLY FROM THE DEGREE. Item 1688's fixture labelled
 * `i % 4 === 0` while taking the degree from `1 + ((i * 2654435761) % 4)`, which forces every
 * labelled vertex to degree 1 — two cases then counted ZERO with both routes agreeing. In-degree
 * varies too: a linear `(a*i+b) % N` target is a bijection per layer, which makes a k-walk count
 * `N * F^k` by arithmetic however the traversal behaves (item 1684).
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
const viaSubquery = (pattern: string, where = '', anchor = 'a:P'): number =>
  Number(query(g, `MATCH (${anchor}) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c);

describe('⚠️ the fixture, before any number measured against it is believed', () => {
  test('in-degree varies and branching exists', () => {
    const inDeg = new Map<string, number>();

    for (const v of g.vertices) {
      inDeg.set(v.id, 0);
    }

    for (const e of g.edges) {
      if (e.labels.has('E')) {
        inDeg.set(e.to.id, (inDeg.get(e.to.id) ?? 0) + 1);
      }
    }

    expect(new Set(inDeg.values()).size).toBeGreaterThan(2);
    expect(new Set([...g.edges].map((e) => e.to)).size).toBeGreaterThan(g.vertexCount / 2);
  });
});

describe('the two-hop arm agrees with an independent route', () => {
  const PAT = '-[:E]->(b)-[:E]->(c)';
  const CASES: [string, string, string][] = [
    ['start clause filter', PAT, ' WHERE a.k > 9'],
    ['start clause equality', PAT, ' WHERE a.k = 3'],
    ['start inline property', '-[:E]->(b)-[:E]->(c)', ''],
    // The END filter, which reaches this arm through the pattern being oriented.
    ['end clause filter', PAT, ' WHERE c.k > 9'],
    ['end clause equality', PAT, ' WHERE c.k = 3'],
    ['MIDDLE label', '-[:E]->(b:Q)-[:E]->(c)', ' WHERE a.k > 9'],
    ['middle label, end filter', '-[:E]->(b:Q)-[:E]->(c)', ' WHERE c.k > 9'],
    ['mixed edge types', '-[:E]->(b)-[:F]->(c)', ' WHERE a.k > 9'],
    ['inward legs', '<-[:E]-(b)<-[:E]-(c)', ' WHERE a.k > 9'],
    ['mixed directions', '-[:E]->(b)<-[:E]-(c)', ' WHERE a.k > 9'],
    ['mixed directions, end filter', '-[:E]->(b)<-[:E]-(c)', ' WHERE c.k > 9'],
  ];

  for (const [name, pattern, where] of CASES) {
    test(`${name} — same count as the subquery route`, () => {
      const direct = countOf(`MATCH (a:P)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern, where));
      expect(direct).toBeGreaterThan(0);
    });
  }

  test('a start inline property agrees with its clause twin', () => {
    const inline = countOf('MATCH (a:P {k: 3})-[:E]->(b)-[:E]->(c) RETURN count(*) AS c');
    const clause = countOf('MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE a.k = 3 RETURN count(*) AS c');

    expect(inline).toBe(clause);
    expect(inline).toBeGreaterThan(0);
  });
});

describe('⚠️ the shapes that must DECLINE, each still answering correctly', () => {
  /**
   * A label at the END position filters which edges the final DEGREE may count, where the CSR counts
   * them all — the same boundary item 1689 drew. An undirected leg must yield a self-loop ONCE,
   * which items 1092/1093 settled, and a single CSR run cannot express it.
   */
  const CASES: [string, string, string][] = [
    ['END label', '-[:E]->(b)-[:E]->(c:Q)', ' WHERE a.k > 9'],
    ['END label with an end filter', '-[:E]->(b)-[:E]->(c:Q)', ' WHERE c.k > 9'],
    ['undirected first leg', '-[:E]-(b)-[:E]->(c)', ' WHERE a.k > 9'],
    ['undirected second leg', '-[:E]->(b)-[:E]-(c)', ' WHERE a.k > 9'],
    ['both legs undirected', '-[:E]-(b)-[:E]-(c)', ' WHERE a.k > 9'],
  ];

  for (const [name, pattern, where] of CASES) {
    test(`${name} — declines and still agrees`, () => {
      const direct = countOf(`MATCH (a:P)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern, where));
      expect(direct).toBeGreaterThan(0);
    });
  }

  /** ⚠️ A SELF-LOOP is the case the undirected exclusion exists for, so it gets its own fixture. */
  test('⚠️ an undirected two-hop over a self-loop agrees', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 11 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { k: 12 } });

    h.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });
    h.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });

    const q = 'MATCH (a:P)-[:E]-(b)-[:E]-(c) WHERE a.k > 9 RETURN count(*) AS c';

    expect(Number(query(h, q)[0].c)).toBe(
      Number(
        query(h, 'MATCH (a:P) RETURN sum(COUNT { (a)-[:E]-(b)-[:E]-(c) WHERE a.k > 9 }) AS c')[0].c,
      ),
    );
  });
});

describe('a write between two counts is seen', () => {
  const Q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE a.k > 9 RETURN count(*) AS c';

  test('an added edge is seen by the second count', () => {
    const h = build(60);

    // The first count populates the CSR cache; its value is not the assertion.
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

    expect(after).toBe(Number(query(fresh, Q)[0].c));
  });

  /**
   * ⚠️ A PROPERTY WRITE MUST BE SEEN THOUGH `topologyVersion` DOES NOT MOVE. The accept mask reads
   * properties and is rebuilt per call; cached on that signal it would go stale with no signal to
   * catch it.
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
    expect(after).toBe(
      Number(query(h, 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c')[0].c),
    );
  });
});

describe('twoHopFilteredCsrApplies — the route choice as a pure function', () => {
  const ok = {
    firstBoth: false,
    secondBoth: false,
    cEff: undefined,
    seeded: false,
    predReadsOnlyStart: true,
  };
  const anyLabel = { kind: 'label' as const, name: 'Q' };

  test('a directed, unseeded, end-unlabelled shape applies', () => {
    expect(twoHopFilteredCsrApplies(ok)).toBe(true);
  });

  /**
   * ⚠️ THE DIRECTION NO DIFFERENTIAL TEST CAN SEE. Each exclusion relaxed is caught by the
   * agreement tests above; tightened, every answer stays right and the arm is silently abandoned,
   * so only these assertions cover it.
   */
  test('⚠️ each exclusion declines on its own', () => {
    expect(twoHopFilteredCsrApplies({ ...ok, firstBoth: true })).toBe(false);
    expect(twoHopFilteredCsrApplies({ ...ok, secondBoth: true })).toBe(false);
    // An END label filters a DEGREE, not a visited vertex.
    expect(twoHopFilteredCsrApplies({ ...ok, cEff: anyLabel })).toBe(false);
    // An index seed makes the query sub-linear already; an O(V) mask throws that away.
    expect(twoHopFilteredCsrApplies({ ...ok, seeded: true })).toBe(false);
    // A predicate that can read the far node or the edge has no per-vertex form.
    expect(twoHopFilteredCsrApplies({ ...ok, predReadsOnlyStart: false })).toBe(false);
  });
});
