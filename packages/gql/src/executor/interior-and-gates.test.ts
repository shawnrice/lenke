// A three-segment clause `WHERE` split across BOTH interior positions (item 1701), closing the
// 1411x equivalent-spelling gap item 1700 found.
//
// ⚠️ THE CENTRAL ASSERTION OF THIS FILE IS THAT TWO SPELLINGS AGREE, not that a count is some
// number. `WHERE b.k = 7 AND c.k > 60` and `(b {k: 7})-[…]->(c WHERE c.k > 60)` are one question;
// they were 1411.1 ms and 1.0 ms apart with the same answer, which no correctness test could see.
// Each case below therefore pairs a clause spelling against its inline twin AND against an
// independent `COUNT { … }` subquery route.
//
// ⚠️ AND A ROUTE CHOICE IS ANSWER-EQUIVALENT WHEN TIGHTENED: a clause wrongly relaxed here returns a
// WRONG COUNT and these tests catch it, while a wrongly tightened one silently declines to the
// general pipeline and every answer stays right. The decline cases are what cover that direction,
// and they assert the ANSWER rather than the route, because the route is not observable from here.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr, Segment } from '../ast.js';
import { query } from '../index.js';
import { parse } from '../parser.js';
import { interiorConstrained, interiorPredOf } from './interior-route-choice.js';

/**
 * ⚠️ Scattered insertion and a nonlinear target, so the graph is neither functional nor in-regular
 * (items 1516/1518/1684) — a k-walk count over either is `N * F^k` by arithmetic however the
 * traversal behaves, which would make every case below pass for the wrong reason.
 */
const build = (n = 400): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ((i * 40_503) >>> 3) % 3 === 0 ? ['P', 'Q'] : ['P'],
        properties: { k: i % 17, j: (i * 7) % 11 },
      }),
    );
  }

  for (let m = 0; m < n * 4; m += 1) {
    const to = ((m % n) * 104_729 + Math.floor(m / n) * 977) % n;

    g.addEdge({ id: `e${m}`, from: vs[(m * 7919) % n], to: vs[to], labels: ['E'], properties: {} });
  }

  return g;
};

const g = build();
const countOf = (q: string): number => Number(query(g, q)[0].c);
const CHAIN = '-[:E]->(b)-[:E]->(c)-[:E]->(d)';

describe('⚠️ the fixture, before any agreement is believed', () => {
  test('branching exists and the gates exclude something', () => {
    expect(new Set([...g.edges].map((e) => e.to)).size).toBeGreaterThan(g.vertexCount / 2);

    const all = countOf(`MATCH (a:P)${CHAIN} RETURN count(*) AS c`);
    const gated = countOf(`MATCH (a:P)${CHAIN} WHERE b.k = 7 AND c.k > 9 RETURN count(*) AS c`);

    expect(gated).toBeGreaterThan(0);
    expect(gated).toBeLessThan(all);
  });
});

describe('a clause over BOTH interior positions agrees with its inline twin', () => {
  const CASES: [string, string, string][] = [
    [
      'b equality AND c ordering',
      `MATCH (a:P)${CHAIN} WHERE b.k = 7 AND c.k > 9 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b {k: 7})-[:E]->(c WHERE c.k > 9)-[:E]->(d) RETURN count(*) AS c',
    ],
    [
      'c equality AND b ordering',
      `MATCH (a:P)${CHAIN} WHERE c.k = 7 AND b.k > 9 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b WHERE b.k > 9)-[:E]->(c {k: 7})-[:E]->(d) RETURN count(*) AS c',
    ],
    [
      'the conjuncts in the OTHER written order',
      `MATCH (a:P)${CHAIN} WHERE c.k > 9 AND b.k = 7 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b {k: 7})-[:E]->(c WHERE c.k > 9)-[:E]->(d) RETURN count(*) AS c',
    ],
    [
      'TWO conjuncts on b and one on c',
      `MATCH (a:P)${CHAIN} WHERE b.k > 2 AND b.j < 9 AND c.k > 9 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b WHERE b.k > 2 AND b.j < 9)-[:E]->(c WHERE c.k > 9)-[:E]->(d) RETURN count(*) AS c',
    ],
    [
      'a clause on b with an INLINE on c',
      `MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 7})-[:E]->(d) WHERE b.k > 9 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b WHERE b.k > 9)-[:E]->(c {k: 7})-[:E]->(d) RETURN count(*) AS c',
    ],
    [
      'an interior LABEL with a clause on the other interior',
      `MATCH (a:P)-[:E]->(b:Q)-[:E]->(c)-[:E]->(d) WHERE c.k > 9 RETURN count(*) AS c`,
      'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c WHERE c.k > 9)-[:E]->(d) RETURN count(*) AS c',
    ],
  ];

  for (const [name, clause, inline] of CASES) {
    test(`${name} — the two spellings give the same count`, () => {
      const a = countOf(clause);

      expect(a).toBe(countOf(inline));
      expect(a).toBeGreaterThan(0);
    });
  }

  /** The independent oracle: a subquery, which cannot reach this arm at all. */
  test('⚠️ and both agree with an independent subquery route', () => {
    const want = Number(
      query(g, `MATCH (a:P) RETURN sum(COUNT { (a)${CHAIN} WHERE b.k = 7 AND c.k > 9 }) AS c`)[0].c,
    );

    expect(countOf(`MATCH (a:P)${CHAIN} WHERE b.k = 7 AND c.k > 9 RETURN count(*) AS c`)).toBe(
      want,
    );
    expect(
      countOf(
        'MATCH (a:P)-[:E]->(b {k: 7})-[:E]->(c WHERE c.k > 9)-[:E]->(d) RETURN count(*) AS c',
      ),
    ).toBe(want);
    expect(want).toBeGreaterThan(0);
  });
});

describe('⚠️ the shapes that must still DECLINE, each still answering correctly', () => {
  /**
   * The product reaches `a` and `d` only as DEGREES, so a conjunct there has no once-per-element
   * place to go — `chainGatesOf`'s rule (item 305) at the two positions this shape visits. A
   * conjunct spanning TWO variables is not a per-vertex test at all, and a constant one is not a
   * test of a position. All of these were declining before item 1701 and must continue to; the
   * assertion is the ANSWER, since the route is not observable here.
   */
  const CASES: [string, string][] = [
    [
      'a conjunct on the START',
      `MATCH (a:P)${CHAIN} WHERE a.k = 7 AND c.k > 9 RETURN count(*) AS c`,
    ],
    ['a conjunct on the END', `MATCH (a:P)${CHAIN} WHERE b.k = 7 AND d.k > 9 RETURN count(*) AS c`],
    ['both ends', `MATCH (a:P)${CHAIN} WHERE a.k > 2 AND d.k > 9 RETURN count(*) AS c`],
    [
      'a conjunct spanning the two interiors',
      `MATCH (a:P)${CHAIN} WHERE b.k = c.k RETURN count(*) AS c`,
    ],
    [
      'a conjunct spanning an interior and an end',
      `MATCH (a:P)${CHAIN} WHERE b.k = a.k AND c.k > 9 RETURN count(*) AS c`,
    ],
    [
      'an OR rather than a conjunction',
      `MATCH (a:P)${CHAIN} WHERE b.k = 7 OR c.k > 9 RETURN count(*) AS c`,
    ],
  ];

  for (const [name, q] of CASES) {
    test(`${name} — declines and still agrees with the subquery route`, () => {
      const pattern = q.slice(q.indexOf('-[:E]->'), q.indexOf(' WHERE'));
      const where = q.slice(q.indexOf(' WHERE'), q.indexOf(' RETURN'));
      const direct = countOf(q);

      expect(direct).toBe(
        Number(query(g, `MATCH (a:P) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c),
      );
      expect(direct).toBeGreaterThan(0);
    });
  }

  /**
   * ⚠️ A CONSTANT CONJUNCT. `free.size !== 1` declines it, as the old reader's `free.size === 0`
   * check did — it is not a per-vertex test, so there is no position to bucket it under.
   */
  test('a constant conjunct declines and still answers', () => {
    const direct = countOf(`MATCH (a:P)${CHAIN} WHERE 1 = 1 AND c.k > 9 RETURN count(*) AS c`);

    expect(direct).toBe(countOf(`MATCH (a:P)${CHAIN} WHERE c.k > 9 RETURN count(*) AS c`));
    expect(direct).toBeGreaterThan(0);
  });
});

describe('a write between two counts is seen', () => {
  const Q = `MATCH (a:P)${CHAIN} WHERE b.k = 7 AND c.k > 9 RETURN count(*) AS c`;

  test('an added edge is seen by the second count', () => {
    const h = build(80);

    // The first count populates the plan and CSR caches; its value is not the assertion.
    query(h, Q);
    h.addEdge({
      id: 'extra',
      from: h.getVertexById('v3')!,
      to: h.getVertexById('v11')!,
      labels: ['E'],
      properties: {},
    });

    const fresh = build(80);

    fresh.addEdge({
      id: 'extra',
      from: fresh.getVertexById('v3')!,
      to: fresh.getVertexById('v11')!,
      labels: ['E'],
      properties: {},
    });

    expect(Number(query(h, Q)[0].c)).toBe(Number(query(fresh, Q)[0].c));
  });
});

describe('interiorPredOf — the BUCKETING asserted directly', () => {
  /**
   * ⚠️ THIS BLOCK EXISTS BECAUSE THREE MUTANTS SURVIVED THE WHOLE SUITE. Bucketing a `b` conjunct
   * under `c`, never filling the `c` bucket, and not splitting the clause at all each make the
   * reader NARROWER — so the shape declines, the general pipeline answers, and every count above
   * stays right. A route choice is answer-equivalent when tightened, so the route has to be
   * asserted where it is decided (`perf-gate-needs-its-own-test`).
   *
   * The inputs are PARSED, not hand-built, so the test feeds the reader exactly what the engine
   * feeds it.
   */
  const readerFor = (
    q: string,
  ): { gates: ReturnType<typeof interiorPredOf>; segments: readonly Segment[] } => {
    const ast = parse(q) as unknown as {
      parts: { clauses: { kind: string; patterns?: unknown[]; where?: Expr }[] }[];
    };
    const match = ast.parts[0].clauses.find((c) => c.kind === 'match');

    if (match?.where === undefined) {
      throw new Error('the probe query must have a MATCH with a WHERE');
    }

    const [pattern] = match.patterns as { segments: readonly Segment[] }[];
    const { segments } = pattern;

    return { gates: interiorPredOf(match.where, segments[0], segments[1]), segments };
  };
  const q = (where: string): string =>
    `MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE ${where} RETURN count(*) AS c`;

  test('a conjunct on b lands in the b bucket, and one on c in the c bucket', () => {
    const { gates } = readerFor(q('b.k = 7 AND c.k > 9'));

    expect(gates).not.toBeNull();
    expect(gates?.b.length).toBe(1);
    expect(gates?.c.length).toBe(1);
  });

  test('⚠️ the clause IS split: three conjuncts become three gates', () => {
    const { gates } = readerFor(q('b.k > 2 AND b.j < 9 AND c.k > 9'));

    expect(gates?.b.length).toBe(2);
    expect(gates?.c.length).toBe(1);
  });

  test('a single-position clause fills only that bucket', () => {
    expect(readerFor(q('b.k = 7')).gates?.b.length).toBe(1);
    expect(readerFor(q('b.k = 7')).gates?.c.length).toBe(0);
    expect(readerFor(q('c.k > 9')).gates?.b.length).toBe(0);
    expect(readerFor(q('c.k > 9')).gates?.c.length).toBe(1);
  });

  test('each gate carries its own bindVar, which `inlineHolds` needs', () => {
    const { gates } = readerFor(q('b.k = 7 AND c.k > 9'));

    expect(gates?.b[0]?.bindVar).toBe('b');
    expect(gates?.c[0]?.bindVar).toBe('c');
  });

  /** ⚠️ The DECLINE direction, asserted on the reader rather than on an answer. */
  test('⚠️ the shapes that must decline return null', () => {
    expect(readerFor(q('a.k = 7 AND c.k > 9')).gates).toBeNull();
    expect(readerFor(q('b.k = 7 AND d.k > 9')).gates).toBeNull();
    expect(readerFor(q('b.k = c.k')).gates).toBeNull();
    expect(readerFor(q('1 = 1 AND c.k > 9')).gates).toBeNull();
    // An OR is not a conjunction, so `flattenConjuncts` yields it whole and its two free names
    // decline it.
    expect(readerFor(q('b.k = 7 OR c.k > 9')).gates).toBeNull();
  });
});

describe('⚠️ the SWEEP path, which needs a NON-VACUOUS start label to reach', () => {
  /**
   * ⚠️ EVERY TEST ABOVE LABELS EVERY VERTEX `P`, SO `P` IS VACUOUS — `effectiveLabel` returns
   * `undefined`, the CSR degree product applies, and the sweep is never consulted for an answer.
   * Two mutants proved that blind spot: sweeping a clause whose gates CANNOT be built, and building
   * those gates from the wrong pattern positions, both SURVIVED the whole suite.
   *
   * Four vertices under another label make `P` real. The arms then decline — a label-filtered degree
   * is not an `off` delta — and the sweep answers, which is item 1705's fix and the 64.6x-77.7x it
   * measured. Item 1703 is the measurement: four edgeless vertices out of 200,004 flip the route.
   */
  const build2 = (n = 300): Graph => {
    const g2 = build(n);

    for (let i = 0; i < 4; i += 1) {
      g2.addVertex({ id: `other${i}`, labels: ['S'], properties: { k: i, j: i } });
    }

    return g2;
  };
  const h = build2();
  const countIn = (q: string): number => Number(query(h, q)[0].c);
  const sub = (pattern: string, where = ''): number =>
    Number(query(h, `MATCH (a:P) RETURN sum(COUNT { (a)${pattern}${where} }) AS c`)[0].c);

  test('the start label is genuinely NOT vacuous in this fixture', () => {
    expect([...h.vertices].some((v) => !v.labels.has('P'))).toBe(true);
    expect([...h.vertices].filter((v) => v.labels.has('P')).length).toBeLessThan(h.vertexCount);
  });

  const CASES: [string, string][] = [
    ['one interior conjunct', ' WHERE c.k > 9'],
    ['both interior positions', ' WHERE b.k = 7 AND c.k > 9'],
    ['two conjuncts on one position', ' WHERE b.k > 2 AND b.j < 9'],
    // ⚠️ A clause whose gates CANNOT be built — `chainGatesOf` returns `null` for a conjunct
    // spanning two variables — so the sweep must NOT be taken. M2 swept it anyway and survived.
    ['a conjunct spanning two positions', ' WHERE b.k = c.k'],
    ['a constant conjunct', ' WHERE 1 = 1 AND c.k > 9'],
    ['an end conjunct', ' WHERE d.k > 9'],
    ['a start conjunct', ' WHERE a.k > 9'],
  ];

  for (const [name, where] of CASES) {
    test(`${name} — agrees with the subquery route on a multi-label graph`, () => {
      const pattern = '-[:E]->(b)-[:E]->(c)-[:E]->(d)';
      const direct = countIn(`MATCH (a:P)${pattern}${where} RETURN count(*) AS c`);

      expect(direct).toBe(sub(pattern, where));
      expect(direct).toBeGreaterThan(0);
    });
  }

  test('⚠️ and the clause still agrees with its inline twin here', () => {
    expect(
      countIn('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 3 RETURN count(*) AS c'),
    ).toBe(countIn('MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 3})-[:E]->(d) RETURN count(*) AS c'));
  });
});

describe('interiorConstrained — the ROUTE choice, asserted directly', () => {
  /**
   * ⚠️ THIS CHOICE IS ANSWER-EQUIVALENT, so every mutant of it survives the differential tests and
   * it needs its own assertions — `perf-gate-needs-its-own-test`, and the same reason
   * `csrDegreeProductApplies` and `interiorPredOf` carry theirs. The numbers that justify the
   * choice (product 1.17x unfiltered, sweep 1.58x-1.72x interior-gated) are on the function.
   */
  const segmentsOf = (q: string): readonly Segment[] => {
    const ast = parse(q) as unknown as {
      parts: { clauses: { kind: string; patterns?: { segments: readonly Segment[] }[] }[] }[];
    };
    const match = ast.parts[0].clauses.find((c) => c.kind === 'match');

    if (match?.patterns === undefined) {
      throw new Error('the probe query must have a MATCH');
    }

    return match.patterns[0].segments;
  };
  const chain = (b: string, c: string): readonly Segment[] =>
    segmentsOf(`MATCH (a:P)-[:E]->(${b})-[:E]->(${c})-[:E]->(d) RETURN count(*) AS c`);
  const gates = { b: [], c: [] } as Parameters<typeof interiorConstrained>[1];

  test('an UNCONSTRAINED chain is not interior-constrained — the product keeps that row', () => {
    expect(interiorConstrained(chain('b', 'c'), undefined)).toBe(false);
    expect(interiorConstrained(chain('b', 'c'), gates)).toBe(false);
  });

  test('⚠️ an INLINE constraint on either interior position counts, read from the SEGMENTS', () => {
    // `inlineInteriorGate` sets `interiorPred` only for an inline `b`, so the `c` case would be
    // missed entirely by testing the gates alone — and the inline `c` row is the 1.72x one.
    expect(interiorConstrained(chain('b {k: 2}', 'c'), undefined)).toBe(true);
    expect(interiorConstrained(chain('b', 'c {k: 2}'), undefined)).toBe(true);
    expect(interiorConstrained(chain('b WHERE b.k > 2', 'c'), undefined)).toBe(true);
    expect(interiorConstrained(chain('b', 'c WHERE c.k > 2'), undefined)).toBe(true);
  });

  test('a CLAUSE-derived gate on either position counts', () => {
    const one = interiorPredOf(
      (
        parse(
          'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 7 RETURN count(*) AS c',
        ) as unknown as {
          parts: { clauses: { kind: string; where?: Expr }[] }[];
        }
      ).parts[0].clauses.find((cl) => cl.kind === 'match')!.where!,
      chain('b', 'c')[0],
      chain('b', 'c')[1],
    );

    expect(one).not.toBeNull();
    expect(interiorConstrained(chain('b', 'c'), one)).toBe(true);
  });

  test('an END or START constraint alone does NOT count — those are not interior', () => {
    expect(
      interiorConstrained(
        segmentsOf('MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d {k: 2}) RETURN count(*) AS c'),
        undefined,
      ),
    ).toBe(false);
    expect(
      interiorConstrained(
        segmentsOf('MATCH (a:P {k: 2})-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c'),
        undefined,
      ),
    ).toBe(false);
  });
});
