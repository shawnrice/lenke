import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 221 gave three-segment counts a degree product and left all four filtered positions on the
// row pipeline. The two INTERIOR positions are the carryable pair, because the walk visits both:
// `b` is the vertex it iterates (gated once per VERTEX) and `c` is the far end of each middle edge
// (gated once per MIDDLE EDGE). The `a` and `d` ends are reached only as DEGREES and still decline.
// Item 219's point, one segment along.
//
// Every spelling was measured first, and four live equivalent-spelling gaps turned up (audit 222):
//
//              clause        inline       gap       after
//     b > 60   9360.5ms      3945.9ms     2.37x     167.4 / 167.4   (1.00x)
//     b = 61   7432.7         560.7      13.3x       17.1 /  18.0   (1.05x)
//     c > 60   9460.7        4557.9       2.08x     550.1 / 562.5   (1.02x)
//     c = 61   7705.2        1502.5       5.13x     482.7 / 454.3   (1.06x)
//
// `b` ends up far cheaper than `c` (167 against 550) because gating `b` prunes before the inner
// edge loop, where gating `c` runs per middle edge. Those are different questions, so that is a
// cost difference and not a spelling gap.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], k: number) =>
    g.addVertex({ id, labels, properties: { k } });
  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>, ty = 'T') =>
    g.addEdge({ from: f, to: t, labels: [ty], properties: {} });

  const a1 = v('a1', ['A'], 1);
  const a2 = v('a2', ['A'], 2);
  // Two middles, one passing a `k > 50` gate and one not.
  const bHi = v('bHi', ['B'], 70);
  const bLo = v('bLo', ['B'], 5);
  // `cShared` is reached from BOTH middles, which is the case that proves the `c` gate runs per
  // middle EDGE and still contributes once for each of them.
  const cShared = v('cShared', ['C'], 80);
  const cLo = v('cLo', ['C'], 6);
  const d1 = v('d1', ['D'], 9);
  const d2 = v('d2', ['D'], 9);

  // indeg(bHi) = 2, indeg(bLo) = 1 — unequal, so a dropped middle is visible in the product.
  e(a1, bHi);
  e(a2, bHi);
  e(a1, bLo);

  e(bHi, cShared);
  e(bHi, cLo);
  e(bLo, cShared);

  // outdeg(cShared) = 2, outdeg(cLo) = 1.
  e(cShared, d1);
  e(cShared, d2);
  e(cLo, d1);

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the count shortcuts decline. */
const general = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

const H = (b = '(b)', c = '(c)') => `MATCH (a)-[:T]->${b}-[:T]->${c}-[:T]->(d)`;

describe('every spelling of a `b` constraint is one question', () => {
  const SPELLINGS = [
    `${H()} WHERE b.k > 50 RETURN count(*) AS n`,
    `${H('(b WHERE b.k > 50)')} RETURN count(*) AS n`,
  ];

  test('clause and inline WHERE agree', () => {
    expect(query(g, SPELLINGS[0])).toEqual(query(g, SPELLINGS[1]));
  });

  test('and both agree with the general path', () => {
    for (const q of SPELLINGS) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('the answer is the product over SURVIVING middles', () => {
    // Only bHi passes. indeg(bHi) = 2; its middle edges go to cShared (outdeg 2) and cLo (1).
    // 2 * 2 + 2 * 1 = 6.
    expect(query(g, SPELLINGS[0])).toEqual([{ n: 6 }]);
  });

  const EQ = [
    `${H()} WHERE b.k = 70 RETURN count(*) AS n`,
    `${H('(b {k: 70})')} RETURN count(*) AS n`,
    `${H('(b WHERE b.k = 70)')} RETURN count(*) AS n`,
  ];

  test('the three equality spellings agree and match the general path', () => {
    for (const q of EQ) {
      expect(query(g, q)).toEqual(query(g, EQ[0]));
      expect(query(g, q)).toEqual(general(q));
    }
  });
});

describe('every spelling of a `c` constraint is one question', () => {
  const SPELLINGS = [
    `${H()} WHERE c.k > 50 RETURN count(*) AS n`,
    `${H('(b)', '(c WHERE c.k > 50)')} RETURN count(*) AS n`,
    `${H('(b)', '(c {k: 80})')} RETURN count(*) AS n`,
  ];

  test('all three agree with the general path', () => {
    for (const q of SPELLINGS) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('the first two agree with each other', () => {
    expect(query(g, SPELLINGS[0])).toEqual(query(g, SPELLINGS[1]));
  });

  test('a `c` reached by SEVERAL middle edges contributes once PER EDGE', () => {
    // cShared is reached from bHi and from bLo. Both middle edges count:
    //   bHi->cShared: indeg(bHi) 2 x outdeg(cShared) 2 = 4
    //   bLo->cShared: indeg(bLo) 1 x outdeg(cShared) 2 = 2
    // So 6 — not 4, which is what deduping `c` would give.
    expect(query(g, SPELLINGS[0])).toEqual([{ n: 6 }]);
  });

  test('a `c` gate that matches nothing counts nothing', () => {
    expect(query(g, `${H()} WHERE c.k > 1000 RETURN count(*) AS n`)).toEqual([{ n: 0 }]);
  });

  test('a `c` gate matching everything equals the unfiltered count', () => {
    expect(query(g, `${H()} WHERE c.k > -1 RETURN count(*) AS n`)).toEqual(
      query(g, `${H()} RETURN count(*) AS n`),
    );
  });
});

describe('the gates compose with labels and directions', () => {
  const SHAPES = [
    `MATCH (a:A)-[:T]->(b:B)-[:T]->(c:C)-[:T]->(d:D) WHERE b.k > 50 RETURN count(*) AS n`,
    `MATCH (a:A)-[:T]->(b:B)-[:T]->(c:C)-[:T]->(d:D) WHERE c.k > 50 RETURN count(*) AS n`,
    `MATCH (a)-[:T]->(b)<-[:T]-(c)-[:T]->(d) WHERE b.k > 50 RETURN count(*) AS n`,
    `MATCH (a)<-[:T]-(b)-[:T]->(c)<-[:T]-(d) WHERE c.k > 50 RETURN count(*) AS n`,
    `MATCH (a)<-[:T]-(b)<-[:T]-(c)<-[:T]-(d) WHERE b.k > 50 RETURN count(*) AS n`,
    // A label EXPRESSION, which falls back to a whole-graph scan and so needs the per-vertex
    // label re-check as well as the gate.
    `MATCH (a)-[:T]->(b:B|C)-[:T]->(c)-[:T]->(d) WHERE b.k > 50 RETURN count(*) AS n`,
  ];

  for (const q of SHAPES) {
    test(q.slice(6, Math.min(q.indexOf(' RETURN'), 70)), () => {
      expect(query(g, q)).toEqual(general(q));
    });
  }

  test('a gate on an ANONYMOUS interior node is refused, not misapplied', () => {
    // A clause predicate needs a variable to name; `(b)` anonymous means the gate has no binding
    // to set, so the shape declines rather than gating the wrong element.
    const q = 'MATCH (a)-[:T]->()-[:T]->(c)-[:T]->(d) WHERE c.k > 50 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('an inline constraint on an anonymous interior node still works', () => {
    // Inline needs no variable: `inlineOf` returns a pred with no `bindVar`.
    const q = 'MATCH (a)-[:T]->({k: 70})-[:T]->(c)-[:T]->(d) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });
});

describe('the `b` gate runs before the degrees are read', () => {
  test('a middle that passes the gate but has no `a` side contributes nothing', () => {
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['N'], properties: { k } });
    const [src, orphan, live, mid, end] = [
      v('src', 0),
      v('orphan', 99),
      v('live', 99),
      v('m', 0),
      v('e', 0),
    ];

    // `orphan` passes `k > 50` and has an out-edge, but NO in-edge, so its `a` side is zero.
    h.addEdge({ from: orphan, to: mid, labels: ['T'], properties: {} });
    h.addEdge({ from: mid, to: end, labels: ['T'], properties: {} });
    // `live` passes and has both sides.
    h.addEdge({ from: src, to: live, labels: ['T'], properties: {} });
    h.addEdge({ from: live, to: mid, labels: ['T'], properties: {} });

    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d) WHERE b.k > 50 RETURN count(*) AS n';

    // Only `live` contributes: indeg 1 x (mid -> end, outdeg 1) = 1.
    expect(query(h, q)).toEqual([{ n: 1 }]);
    expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });
});

describe('what the interior route must NOT claim', () => {
  test('a predicate on the START still answers correctly', () => {
    const q = `${H()} WHERE a.k > 0 RETURN count(*) AS n`;

    expect(query(g, q)).toEqual(general(q));
  });

  test('a predicate on the END still answers correctly', () => {
    const q = `${H()} WHERE d.k > 0 RETURN count(*) AS n`;

    expect(query(g, q)).toEqual(general(q));
  });

  test('a predicate reading BOTH interiors still answers correctly', () => {
    const q = `${H()} WHERE b.k > 50 AND c.k > 50 RETURN count(*) AS n`;

    expect(query(g, q)).toEqual(general(q));
  });

  test('a predicate reading an interior AND an end still answers correctly', () => {
    const q = `${H()} WHERE b.k > 50 AND d.k > 0 RETURN count(*) AS n`;

    expect(query(g, q)).toEqual(general(q));
  });

  test('a CONSTANT predicate still answers correctly', () => {
    // It names no position, so there is nothing to gate; the shape declines rather than picking
    // one arbitrarily.
    const q = `${H()} WHERE 1 = 1 RETURN count(*) AS n`;

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual(query(g, `${H()} RETURN count(*) AS n`));
  });

  test('an inline constraint on the START or END still answers correctly', () => {
    for (const q of [
      'MATCH (a {k: 1})-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d {k: 9}) RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('a CORRELATED inline interior still answers correctly', () => {
    for (const q of [
      'MATCH (a)-[:T]->(b {k: a.k})-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c {k: a.k})-[:T]->(d) RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('and the declined answers are not all the same number', () => {
    // Otherwise every "still answers correctly" above could pass on a single value.
    const answers = [
      query(g, `${H()} WHERE a.k > 0 RETURN count(*) AS n`)[0].n,
      query(g, `${H()} WHERE b.k > 50 AND c.k > 50 RETURN count(*) AS n`)[0].n,
      query(g, `${H()} RETURN count(*) AS n`)[0].n,
    ];

    expect(new Set(answers).size).toBeGreaterThan(1);
  });
});
