// The GATED three-hop degree product (item 1689), and the shapes that must decline it.
//
// ⚠️ EVERY AGREEMENT TEST IS AGAINST AN INDEPENDENT ROUTE — the same question as a `COUNT { … }`
// subquery, which goes to the per-anchor composition and cannot reach this arm. A hand-computed
// expectation would only prove that two copies of my arithmetic agree.
//
// ⚠️ AND A ROUTE CHOICE IS ANSWER-EQUIVALENT WHEN IT IS *TIGHTENED*. A clause wrongly relaxed here
// returns a WRONG COUNT and these tests catch it; a clause wrongly tightened silently abandons the
// arm and every answer stays right, so both predicates carry their own direct assertions below.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../index.js';
import {
  csrDegreeProductApplies,
  csrGatedDegreeProductApplies,
} from './three-hop-degree-product.js';

/**
 * ⚠️ THE LABEL AND THE PROPERTY ARE MIXED DIFFERENTLY FROM THE DEGREE, which item 1688 learned the
 * hard way: labelling `i % 4 === 0` while taking the degree from `1 + ((i * 2654435761) % 4)` forces
 * every labelled vertex to degree 1, and two cases then counted ZERO with both routes agreeing on
 * it. In-degree varies too — a linear `(a*i+b) % N` target is a bijection per layer, which makes a
 * 3-walk count `N * F^k` by arithmetic however the traversal behaves (item 1684).
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
const viaSubquery = (pattern: string, where = ''): number =>
  Number(query(g, `MATCH (a:P) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c);

describe('⚠️ the fixture, before any number measured against it is believed', () => {
  test('in-degree varies, branching exists, and the label is reachable through an E edge', () => {
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
    expect(
      [...g.vertices].filter(
        (v) => v.labels.has('Q') && [...g.edges].some((e) => e.from === v && e.labels.has('E')),
      ).length,
    ).toBeGreaterThan(10);
  });
});

describe('the gated arm agrees with an independent route', () => {
  const PAT = '-[:E]->(b)-[:E]->(c)-[:E]->(d)';
  const CASES: [string, string, string][] = [
    // `c` constrained — the row this arm exists for.
    ['c clause filter', PAT, ' WHERE c.k > 9'],
    ['c clause equality', PAT, ' WHERE c.k = 3'],
    ['c inline WHERE', '-[:E]->(b)-[:E]->(c WHERE c.k > 9)-[:E]->(d)', ''],
    ['c inline property', '-[:E]->(b)-[:E]->(c {k: 3})-[:E]->(d)', ''],
    ['c LABEL', '-[:E]->(b)-[:E]->(c:Q)-[:E]->(d)', ''],
    ['c label AND filter', '-[:E]->(b)-[:E]->(c:Q)-[:E]->(d)', ' WHERE c.k > 9'],
    // `b` constrained — already once per vertex in the walk, so the arm adds no mask for it.
    ['b clause filter', PAT, ' WHERE b.k > 9'],
    ['b inline property', '-[:E]->(b {k: 3})-[:E]->(c)-[:E]->(d)', ''],
    ['b LABEL', '-[:E]->(b:Q)-[:E]->(c)-[:E]->(d)', ''],
    // Both at once, and with the edge types mixed so the three CSR shapes differ.
    ['b and c together', '-[:E]->(b:Q)-[:E]->(c WHERE c.k > 9)-[:E]->(d)', ''],
    ['mixed edge types', '-[:E]->(b)-[:F]->(c)-[:E]->(d)', ' WHERE c.k > 9'],
    ['inward legs', '<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)', ' WHERE c.k > 9'],
    ['mixed directions', '-[:E]->(b)<-[:E]-(c)-[:E]->(d)', ' WHERE c.k > 9'],
  ];

  for (const [name, pattern, where] of CASES) {
    test(`${name} — same count as the subquery route`, () => {
      const direct = countOf(`MATCH (a:P)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(viaSubquery(pattern, where));
      expect(direct).toBeGreaterThan(0);
    });
  }
});

describe('⚠️ equivalent spellings must agree, which is this repo’s opening defect class', () => {
  test('a clause WHERE, an inline WHERE and an inline property on `c` all agree', () => {
    const clause = countOf(
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 3 RETURN count(*) AS c',
    );

    expect(
      countOf('MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 3)-[:E]->(d) RETURN count(*) AS c'),
    ).toBe(clause);
    expect(countOf('MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 3})-[:E]->(d) RETURN count(*) AS c')).toBe(
      clause,
    );
    expect(clause).toBeGreaterThan(0);
  });
});

describe('⚠️ the shapes that must DECLINE, each still answering correctly', () => {
  /**
   * A label at `a` or `d` constrains the FAR ENDPOINT OF A DEGREE: it counts only edges whose other
   * end carries it, where the CSR counts them all. If the arm took these it would be a wrong count,
   * so each is checked against the subquery route. An undirected leg is `undirectedSide`'s two
   * buckets minus the self-loops counted twice, which item 1097 fixed a half-answer bug in.
   */
  const CASES: [string, string][] = [
    ['a LABEL on the far side', '-[:E]->(b)-[:E]->(c)-[:E]->(d)'],
    ['d LABEL', '-[:E]->(b)-[:E]->(c)-[:E]->(d:Q)'],
    ['undirected first leg', '-[:E]-(b)-[:E]->(c)-[:E]->(d)'],
    ['undirected middle leg', '-[:E]->(b)-[:E]-(c)-[:E]->(d)'],
    ['undirected last leg', '-[:E]->(b)-[:E]->(c)-[:E]-(d)'],
  ];

  for (const [name, pattern] of CASES) {
    test(`${name} — declines and still agrees`, () => {
      const where = ' WHERE c.k > 9';
      const direct = countOf(`MATCH (a:Q)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(
        Number(query(g, `MATCH (a:Q) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c),
      );
      expect(direct).toBeGreaterThan(0);
    });
  }

  /**
   * ⚠️ A SELF-LOOP UNDER AN UNDIRECTED LEG is the case that exclusion exists for, so it gets its own
   * fixture rather than relying on the shared graph containing one.
   */
  test('⚠️ an undirected chain over a self-loop agrees', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 11 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { k: 12 } });

    h.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });
    h.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });

    const q = 'MATCH (a:P)-[:E]-(b)-[:E]-(c)-[:E]-(d) WHERE c.k > 9 RETURN count(*) AS c';

    expect(Number(query(h, q)[0].c)).toBe(
      Number(
        query(
          h,
          'MATCH (a:P) RETURN sum(COUNT { (a)-[:E]-(b)-[:E]-(c)-[:E]-(d) WHERE c.k > 9 }) AS c',
        )[0].c,
      ),
    );
  });
});

describe('a write between two counts is seen', () => {
  const Q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k > 9 RETURN count(*) AS c';

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
   * ⚠️ A PROPERTY WRITE MUST BE SEEN THOUGH `topologyVersion` DOES NOT MOVE. The accept weights read
   * properties through the gate and are rebuilt per call; cached on that signal they would go stale
   * with no signal to catch it.
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

describe('the two route predicates, as pure functions', () => {
  const unfiltered = {
    aBoth: false,
    midBoth: false,
    dBoth: false,
    aEff: undefined,
    cEff: undefined,
    dEff: undefined,
    bGated: false,
    cGated: false,
  };
  const gatedShape = {
    aBoth: false,
    midBoth: false,
    dBoth: false,
    aEff: undefined,
    dEff: undefined,
  };
  const anyLabel = { kind: 'label' as const, name: 'Q' };

  test('the unfiltered arm applies only with nothing constrained', () => {
    expect(csrDegreeProductApplies(unfiltered)).toBe(true);
    expect(csrDegreeProductApplies({ ...unfiltered, cGated: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...unfiltered, bGated: true })).toBe(false);
    expect(csrDegreeProductApplies({ ...unfiltered, cEff: anyLabel })).toBe(false);
  });

  /**
   * ⚠️ THE DIRECTION NO DIFFERENTIAL TEST CAN SEE. Each exclusion, if wrongly relaxed, is caught by
   * the agreement tests above; a clause wrongly TIGHTENED keeps every answer right and silently
   * abandons the arm, so only these assertions cover it.
   */
  test('⚠️ the gated arm takes b/c constraints and refuses a/d labels and undirected legs', () => {
    expect(csrGatedDegreeProductApplies(gatedShape)).toBe(true);
    // The three the gated arm LIFTS are not even its inputs — a `c` label or either gate cannot
    // make it decline, which is the whole difference between the two predicates.
    expect(csrGatedDegreeProductApplies({ ...gatedShape, aEff: anyLabel })).toBe(false);
    expect(csrGatedDegreeProductApplies({ ...gatedShape, dEff: anyLabel })).toBe(false);
    expect(csrGatedDegreeProductApplies({ ...gatedShape, aBoth: true })).toBe(false);
    expect(csrGatedDegreeProductApplies({ ...gatedShape, midBoth: true })).toBe(false);
    expect(csrGatedDegreeProductApplies({ ...gatedShape, dBoth: true })).toBe(false);
  });
});
