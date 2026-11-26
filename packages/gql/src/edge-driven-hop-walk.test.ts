import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { EDGE_DRIVEN_MIN_COVERAGE, labelCoverage } from './executor/labels.js';
import { query } from './index.js';

/**
 * Item 1940: `edgeDrivenHopWalk` — the middle ground between the counting far-driven walk (which
 * cannot test a start label, because it never visits an edge) and the start-driven walk.
 *
 * ```text
 *   MATCH (a:T)-[:E]->(b:T), ONE off-label vertex in 50,000:   20.63 ms -> 4.91   4.2x
 *   the same with T vacuous (counting arm, unchanged):          2.97              flat
 *   10% off-label:                                             20.57 -> 5.54
 * ```
 *
 * ROW ORDER DIFFERS FROM THE OTHER ARMS BY DESIGN — this one emits in edge-bucket order where
 * they emit in vertex order. Row order is unspecified for an unordered result (the repo's own
 * WON'T-FIX, like SQL without `ORDER BY`), so every answer here is compared as a MULTISET. An
 * `ORDER BY` forces the start-driven arm and never reaches this walk, which is its own test below.
 *
 * AND THE ROUTE CHOICE IS TESTED THROUGH `labelCoverage`, NOT THROUGH TIMING. Both arms report
 * the same rung (`hopProjection`), so `routes()` cannot tell them apart —
 * [[perf-gate-needs-its-own-test]]'s rule is to extract the arithmetic and unit-test it, which is
 * what the first describe block does.
 */
const sortedRows = (rows: readonly unknown[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

describe('labelCoverage — the gate arithmetic, tested as a pure function', () => {
  const g = new Graph();

  for (let i = 0; i < 10; i += 1) {
    g.addVertex({ id: String(i + 1), labels: i < 4 ? ['T'] : ['U'], properties: { n: i } });
  }

  test('a plain label reports its bucket fraction', () => {
    expect(labelCoverage(g, { kind: 'label', name: 'T' })).toBeCloseTo(0.4, 10);
    expect(labelCoverage(g, { kind: 'label', name: 'U' })).toBeCloseTo(0.6, 10);
  });

  test('a label no vertex carries reports 0, not undefined', () => {
    expect(labelCoverage(g, { kind: 'label', name: 'Nope' })).toBe(0);
  });

  test('undefined for every COMPOUND kind, because a bucket size is not its coverage', () => {
    // A disjunction's buckets OVERLAP so their sizes do not add; a conjunction's intersection is
    // not a bucket; a negation's complement would need a count this cannot derive.
    const t = { kind: 'label', name: 'T' } as const;
    const u = { kind: 'label', name: 'U' } as const;

    expect(labelCoverage(g, { kind: 'or', left: t, right: u })).toBeUndefined();
    expect(labelCoverage(g, { kind: 'and', left: t, right: u })).toBeUndefined();
    expect(labelCoverage(g, { kind: 'not', expr: t })).toBeUndefined();
  });

  test('undefined for no label at all, and for an empty graph', () => {
    expect(labelCoverage(g, undefined)).toBeUndefined();
    expect(labelCoverage(new Graph(), { kind: 'label', name: 'T' })).toBeUndefined();
  });

  test('the threshold sits ABOVE item 1939s swept crossover band of 0.18-0.35', () => {
    // So the gate can only DECLINE a win, never cause a regression. A threshold inside the band
    // would route some graphs to the slower arm.
    expect(EDGE_DRIVEN_MIN_COVERAGE).toBeGreaterThan(0.35);
    expect(EDGE_DRIVEN_MIN_COVERAGE).toBeLessThan(1);
  });
});

/**
 * OFF-LABEL VERTICES CARRY NO EDGES, so `MATCH (a:T)-[:E]->(b:T)` and `MATCH (a)-[:E]->(b)`
 * answer the SAME multiset — which is what lets one spelling be the oracle for the other. Without
 * that the two would be different questions and no comparison would mean anything (the fixture bug
 * item 1935 caught on itself).
 */
const build = (offLabel: number, live = 12): Graph => {
  const g = new Graph();

  for (let i = 0; i < offLabel; i += 1) {
    g.addVertex({ id: `off${String(i)}`, labels: ['U'], properties: { n: -1 } });
  }

  for (let i = 0; i < live; i += 1) {
    // `id2` is the INSERTION INDEX — `n` repeats every 5, so this is what makes TIE ORDER
    // observable in the windowed test below.
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 5, id2: i } });
  }

  for (let i = 0; i < live; i += 1) {
    const src = g.getVertexById(String(i + 1));
    const dst = g.getVertexById(String(((i * 5 + 1) % live) + 1));

    if (src === null || dst === null) {
      throw new Error('fixture');
    }

    g.addEdge({ id: `e${String(i)}`, from: src, to: dst, labels: ['E'], properties: {} });
  }

  return g;
};

describe('the walk answers what the other arms answer, as a multiset', () => {
  const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';
  const UNLABELLED = 'MATCH (a)-[:E]->(b) RETURN b.n AS x';

  test('T vacuous: the counting arm, and the baseline answer', () => {
    const g = build(0);

    expect(sortedRows(query(g, Q, {}))).toEqual(sortedRows(query(g, UNLABELLED, {})));
    expect(query(g, Q, {}).length).toBe(12);
  });

  test('ONE off-label vertex — coverage 12/13, ABOVE the threshold: the edge-driven arm', () => {
    const g = build(1);

    expect(labelCoverage(g, { kind: 'label', name: 'T' })).toBeGreaterThan(
      EDGE_DRIVEN_MIN_COVERAGE,
    );
    expect(sortedRows(query(g, Q, {}))).toEqual(sortedRows(query(g, UNLABELLED, {})));
  });

  test('coverage BELOW the threshold: the start-driven arm, same answer', () => {
    // 12 T against 30 off-label is 0.29 — inside item 1939's crossover band, where the
    // start-driven walk is the better choice and a boolean gate would have regressed 25x.
    const g = build(30);

    expect(labelCoverage(g, { kind: 'label', name: 'T' })).toBeLessThan(EDGE_DRIVEN_MIN_COVERAGE);
    expect(sortedRows(query(g, Q, {}))).toEqual(sortedRows(query(g, UNLABELLED, {})));
  });

  test('the FAR label is tested too, so an edge into an off-label vertex is excluded', () => {
    const g = build(1);
    const off = g.getVertexById('off0');
    const src = g.getVertexById('1');

    if (off === null || src === null) {
      throw new Error('fixture');
    }

    // An edge from a T vertex INTO the off-label one: the far test must drop it.
    g.addEdge({ id: 'eoff', from: src, to: off, labels: ['E'], properties: {} });

    expect(query(g, Q, {}).length).toBe(12);
    // ...and the same edge is visible when the far end is unconstrained.
    expect(query(g, 'MATCH (a:T)-[:E]->(b) RETURN b.n AS x', {}).length).toBe(13);
  });

  test('an incoming hop tests the right endpoints', () => {
    const g = build(1);

    expect(sortedRows(query(g, 'MATCH (a:T)<-[:E]-(b:T) RETURN b.n AS x', {}))).toEqual(
      sortedRows(query(g, 'MATCH (a)<-[:E]-(b) RETURN b.n AS x', {})),
    );
  });

  test('an ORDER BY forces the start-driven arm and still orders correctly', () => {
    const g = build(1);
    const out = query(g, 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x', {}) as {
      x: number;
    }[];
    const keys = out.map((r) => r.x);

    expect(keys).toEqual([...keys].sort((p, q) => p - q));
    expect(sortedRows(out)).toEqual(sortedRows(query(g, Q, {})));
  });

  test('\u26a0\u26a0 a WINDOWED ORDER BY keeps the start-driven arm, and TIE ORDER proves it', () => {
    /*
     * \u26a0\u26a0 THIS IS AN ORDER-SENSITIVE ASSERTION ON PURPOSE, and the only one in this file.
     * `deferredHopOrder` sets `startDriven` for a stated CORRECTNESS reason: "the far-driven walk
     * REORDERS rows and a stable sort leaves ties on ARRIVAL ORDER, which is observable between the
     * engines (item 605)". So the `startDrivenForOrder` escape in the gate is not a route
     * preference \u2014 it protects tie order, and the edge-driven arm would arrive in edge-bucket
     * order.
     *
     * \ud83d\udd11 AND IT NEEDED A WINDOW PLUS TIES TO BITE. The battery's first run had this mutant
     * SURVIVE, because the unwindowed `ORDER BY x` test above does not set `startDrivenForOrder` at
     * all and a plain sort hides arrival order anyway. `b.id2` is projected precisely so the tie
     * order is visible \u2014 item 1903's rule that "a sort-order claim needs a fixture whose arrival
     * order is NOT a plausible answer", one arm later.
     */
    const g = build(1);
    const out = query(
      g,
      'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x, b.id2 AS i ORDER BY x LIMIT 5',
      {},
    );

    expect(out).toEqual([
      { x: 0, i: 0 },
      { x: 0, i: 5 },
      { x: 0, i: 10 },
      { x: 1, i: 1 },
      { x: 1, i: 6 },
    ]);
  });

  test('a COMPOUND start label declines the arm and still answers', () => {
    const g = build(1);

    expect(sortedRows(query(g, 'MATCH (a:T|U)-[:E]->(b:T) RETURN b.n AS x', {}))).toEqual(
      sortedRows(query(g, Q, {})),
    );
  });

  test('a label no vertex carries answers nothing', () => {
    expect(query(build(1), 'MATCH (a:Nope)-[:E]->(b:T) RETURN b.n AS x', {}).length).toBe(0);
  });

  /*
   * Item 1950. THE ARM'S ORDER TRACKS EDGE-INSERTION ORDER, AND A FIXTURE CAN HIDE THAT.
   *
   * `hop-projection.test.ts` pins an exact row order for `MATCH (a:P)-[:T]->(x)` and used to
   * explain it by saying the START-driven walk takes that shape. It does not — `P` covers 5 of 6
   * vertices there, so THIS arm claims it, and the assertion survives only because that fixture
   * inserts its edges grouped by source, which happens to equal the start-driven nesting.
   *
   * The two fixtures below hold the EDGE SET and the vertex set fixed and vary only INSERTION
   * ORDER. Grouped, the arm agrees with the start-driven order; interleaved, it does not — and
   * the multiset is identical either way. That is the contract: the answer is a multiset, and
   * any test that pins this arm's order is a change detector over its fixture.
   */
  describe('row order follows edge-insertion order (item 1950)', () => {
    const SPEC: [string, string[], Record<string, unknown>][] = [
      ['v0', ['P'], { name: 'a' }],
      ['v1', ['P', 'Q'], { name: 'b' }],
      ['v2', ['P'], { name: 'c' }],
      ['v3', ['P', 'Q'], { name: 'd' }],
      ['v4', ['P'], { name: 'e' }],
      // NOT a `P`, which is what keeps the start label non-vacuous and this arm in play.
      ['v5', ['R'], { name: 'f' }],
    ];
    // The same six `T` edges in both orders; `v0->v1` twice is a parallel pair.
    const GROUPED: [string, string][] = [
      ['v0', 'v1'],
      ['v0', 'v2'],
      ['v0', 'v1'],
      ['v1', 'v1'],
      ['v1', 'v3'],
      ['v2', 'v5'],
    ];
    const INTERLEAVED: [string, string][] = [
      ['v2', 'v5'],
      ['v0', 'v1'],
      ['v1', 'v1'],
      ['v0', 'v2'],
      ['v1', 'v3'],
      ['v0', 'v1'],
    ];

    const buildOrdered = (edges: readonly [string, string][]): Graph => {
      const g = new Graph();
      const vs = new Map<string, ReturnType<Graph['addVertex']>>();

      for (const [id, labels, properties] of SPEC) {
        vs.set(id, g.addVertex({ id, labels, properties }));
      }

      for (const [from, to] of edges) {
        const f = vs.get(from);
        const t = vs.get(to);

        if (f === undefined || t === undefined) {
          throw new Error('fixture lost a vertex');
        }

        g.addEdge({ from: f, to: t, labels: ['T'] });
      }

      return g;
    };

    const HOP = 'MATCH (a:P)-[:T]->(x) RETURN x.name AS n';
    const names = (g: Graph): string[] => (query(g, HOP, {}) as { n: string }[]).map((r) => r.n);

    test('the arm is in play for this shape at all', () => {
      const coverage = labelCoverage(buildOrdered(GROUPED), { kind: 'label', name: 'P' });

      // 5 of 6 — non-vacuous, so the counting walk is out, and over the threshold, so the
      // start-driven walk is too. This is the measurement that corrected item 1949's worry.
      expect(coverage).toBeCloseTo(5 / 6, 10);
      expect(coverage).toBeGreaterThan(EDGE_DRIVEN_MIN_COVERAGE);
    });

    test('grouped insertion AGREES with the start-driven order, by coincidence', () => {
      expect(names(buildOrdered(GROUPED))).toEqual(['b', 'c', 'b', 'b', 'd', 'f']);
    });

    test('interleaved insertion gives a DIFFERENT order from the same edge set', () => {
      const grouped = names(buildOrdered(GROUPED));
      const interleaved = names(buildOrdered(INTERLEAVED));

      expect(interleaved).toEqual(['f', 'b', 'b', 'c', 'd', 'b']);
      expect(interleaved).not.toEqual(grouped);
    });

    test('and the MULTISET is identical either way, which is the contract', () => {
      expect([...names(buildOrdered(INTERLEAVED))].sort()).toEqual(
        [...names(buildOrdered(GROUPED))].sort(),
      );
    });
  });
});
