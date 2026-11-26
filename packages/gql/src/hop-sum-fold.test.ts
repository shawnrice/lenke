/*
 * Item 2159 — `sum()` over a hop streams into an accumulator instead of collecting an array.
 *
 * **THE WIN IS ~1.1x, NOT THE 3.6x THE BENCH ROW SUGGESTED, AND THE DIFFERENCE IS A CORRECTNESS
 * REQUIREMENT.** `max` costs 14.5 ms on this shape where `sum` costs 93.5, and that gap is the WALK:
 * `max` is order-insensitive so the planner takes the far-driven walk, while `sum` must take the
 * start-driven one. Float addition is not associative, so reordering the addends changes the last ulp and
 * breaks byte-identity with the Rust engine. An ablation isolates it — `sum(1)` 48.25 ms against
 * `max(1)` 12.88 with no property read at all.
 *
 * So what this fold removes is only the `values` array plus `aggregateOverValues`' three further
 * passes (`some(isTemporal)`, `some(Array.isArray)`, `reduce`): measured 1.09x on the far side and 1.15x
 * on the start side, answers identical.
 *
 * **THE TESTS THAT MATTER ARE THE FALLBACK ONES.** `SUM_FOLD` bails on anything that is not a plain
 * number, because a column containing any temporal must route to `temporalSum`, which needs every value
 * in hand. A bail must produce the SAME answer or the SAME error as before the fold existed.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** `n` numeric, `s` a string, and one hop per vertex so a hop aggregate has rows. */
const graphOf = (values: readonly unknown[]): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'src', labels: ['P'], properties: { n: 1, s: 'a' } });

  for (const [i, v] of values.entries()) {
    g.addVertex({ id: `t${i}`, labels: ['P'], properties: { n: v, s: `s${i}` } });
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById('src')!,
      to: g.getVertexById(`t${i}`)!,
      labels: ['T'],
      properties: { w: i },
    });
  }

  return g;
};

const HOP_SUM = 'MATCH (a:P)-[:T]->(b) RETURN sum(b.n) AS c';

describe('the hop sum fold (item 2159)', () => {
  describe('the arithmetic', () => {
    test('sums the far-side column', () => {
      // 1 + 2 + 3 = 6; `src`'s own n = 1 is not a far end of any edge.
      expect(query(graphOf([1, 2, 3]), HOP_SUM)[0].c).toBe(6);
    });

    test('NULLs are skipped, not coerced to zero', () => {
      /*
       * `isNullish` filtering happens in the caller, BEFORE either arm — so this pins that the fold
       * did not duplicate (or drop) that rule. A `null` coerced to 0 would still give 6 here, which is
       * why the count below matters too.
       */
      const g = graphOf([1, null, 2, 3]);

      expect(query(g, HOP_SUM)[0].c).toBe(6);
      // And the walk really did see four rows, so the null was skipped rather than absent.
      expect(query(g, 'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c')[0].c).toBe(4);
    });

    test('an EMPTY input sums to 0, as `reduce(…, 0)` did', () => {
      const g = new Graph();

      g.addVertex({ id: 'lonely', labels: ['P'], properties: { n: 5 } });

      expect(query(g, HOP_SUM)[0].c).toBe(0);
    });

    test('every value NULL also sums to 0', () => {
      expect(query(graphOf([null, null]), HOP_SUM)[0].c).toBe(0);
    });

    test('negatives and floats', () => {
      expect(query(graphOf([1.5, -2.5, 1]), HOP_SUM)[0].c).toBe(0);
      expect(query(graphOf([0.1, 0.2]), HOP_SUM)[0].c).toBeCloseTo(0.3, 10);
    });

    test('the START-side and EDGE-side spellings agree with the engine', () => {
      const g = graphOf([1, 2, 3]);

      // `src` is the start of all three edges, so sum(a.n) is 1+1+1.
      expect(query(g, 'MATCH (a:P)-[:T]->(b) RETURN sum(a.n) AS c')[0].c).toBe(3);
      // Edge `w` values are 0, 1, 2.
      expect(query(g, 'MATCH (a:P)-[e:T]->(b) RETURN sum(e.w) AS c')[0].c).toBe(3);
    });
  });

  describe('the BAIL-OUT, which must not change an answer or an error', () => {
    test('a STRING column still throws, with the same code', () => {
      /*
       * The sentinel is caught and the collecting arm re-runs, which is what produces this error —
       * so the message and code come from `aggregateOverValues` exactly as before. A fold that let
       * its own `Symbol` escape would surface an unhelpful throw instead.
       */
      const run = (): unknown =>
        query(graphOf([1, 2]), 'MATCH (a:P)-[:T]->(b) RETURN sum(b.s) AS c');

      expect(run).toThrow();
      // A real engine error with its own code, not a leaked sentinel.
      expect(run).toThrow(expect.objectContaining({ code: 'E_INVALID_VALUE' }));
    });

    test('a column that is numeric UNTIL the last row still bails correctly', () => {
      /*
       * THE SHARPEST BAIL CASE: the fold has already accumulated three numbers when it meets the
       * string, so the fallback must discard that partial sum and re-run from scratch. A fold that
       * returned its partial accumulator would answer 6 instead of throwing.
       */
      const g = graphOf([1, 2, 3]);

      g.addVertex({ id: 'bad', labels: ['P'], properties: { n: 'not a number' } });
      g.addEdge({
        id: 'ebad',
        from: g.getVertexById('src')!,
        to: g.getVertexById('bad')!,
        labels: ['T'],
        properties: {},
      });

      expect(() => query(g, HOP_SUM)).toThrow();
    });

    test('a LIST value throws', () => {
      expect(() =>
        query(graphOf([1, 2]), 'MATCH (a:P)-[:T]->(b) RETURN sum([1, 2]) AS c'),
      ).toThrow();
    });

    test('a BOOLEAN is not a plain number and so bails', () => {
      expect(() => query(graphOf([1, true, 2]), HOP_SUM)).toThrow();
    });
  });

  describe('the aggregates that must NOT have changed', () => {
    test.each([
      ['max', 'MATCH (a:P)-[:T]->(b) RETURN max(b.n) AS c', 3],
      ['min', 'MATCH (a:P)-[:T]->(b) RETURN min(b.n) AS c', 1],
      ['count', 'MATCH (a:P)-[:T]->(b) RETURN count(b.n) AS c', 3],
      ['count(*)', 'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c', 3],
    ])('%s', (_name, q, want) => {
      expect(query(graphOf([1, 2, 3]), q)[0].c).toBe(want);
    });

    test('avg still collects and still answers', () => {
      expect(query(graphOf([1, 2, 3]), 'MATCH (a:P)-[:T]->(b) RETURN avg(b.n) AS c')[0].c).toBe(2);
    });

    test('sum over a plain SCAN is a different path and unchanged', () => {
      // src.n = 1 plus 1 + 2 + 3.
      expect(query(graphOf([1, 2, 3]), 'MATCH (a:P) RETURN sum(a.n) AS c')[0].c).toBe(7);
    });

    test('collect still returns every value, in walk order', () => {
      const rows = query(graphOf([1, 2, 3]), 'MATCH (a:P)-[:T]->(b) RETURN collect(b.n) AS c');

      expect(rows[0].c).toStrictEqual([1, 2, 3]);
    });
  });
});

/*
 * Item 2401 — THE FAR-DRIVEN WALK IS NOW PERMITTED FOR `sum`/`avg`, AND THESE ARE ITS TEETH.
 *
 * Item 2400 relaxed cross-engine identity to CONTENT rather than POSITION, and item 2401 ruled that
 * float aggregates carry a PRECISION contract rather than a bit-identity one. So the header above is
 * superseded on one point: the 3.6x IS available, and `sum`/`avg` left `ORDER_SENSITIVE_WALK`.
 * Measured on the bench row: 280.2 -> 24.3 ms, 11.5x, with `max`/`sum`-over-a-scan flat.
 *
 * What that relaxes is a CORRECTNESS guard, and the differential fuzzer CANNOT see the bug it was
 * guarding: `sum` is NOT idempotent, so a far vertex reachable by three edges must contribute its
 * value THREE times, and a far-driven walk visits each far vertex ONCE. A route that drops the
 * multiplicity is both fast and wrong. The fuzzer's fixture is three vertices carrying small
 * INTEGERS with no fan-in, so it can neither reassociate (integer sums are exact in f64) nor
 * under-count. Hence a closed-form fan-in test here, which is the only thing standing under the
 * relaxation.
 */
describe('a far-driven hop sum keeps each edge’s contribution (item 2401)', () => {
  const FANIN = 3;
  const N = 40;

  /** Every vertex points at `FANIN` DISTINCT targets, so every target has fan-in `FANIN`. */
  const fanInGraph = (): Graph => {
    const g = new Graph();

    for (let i = 0; i < N; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: (i % 7) + 1 } });
    }

    let e = 0;

    // Split on the REPEAT index, never `(i * c) % N`: that form is invariant under `i -> i + N`, so
    // every one of a vertex's edges would land on the SAME target and the fan-in would be fake
    // while every degree count still looked right (items 1516/1518).
    for (let rep = 0; rep < FANIN; rep += 1) {
      for (let i = 0; i < N; i += 1) {
        g.addEdge({
          id: `e${e}`,
          from: g.getVertexById(`v${i}`)!,
          to: g.getVertexById(`v${(i * 13 + rep * 17 + 1) % N}`)!,
          labels: ['T'],
          properties: { w: (e % 5) + 1 },
        });
        e += 1;
      }
    }

    return g;
  };

  /** The closed form, computed from the generator rather than from the engine. */
  const oracle = (): { sum: number; count: number } => {
    let sum = 0;
    let count = 0;

    for (let rep = 0; rep < FANIN; rep += 1) {
      for (let i = 0; i < N; i += 1) {
        sum += (((i * 13 + rep * 17 + 1) % N) % 7) + 1;
        count += 1;
      }
    }

    return { sum, count };
  };

  const one = (g: Graph, q: string): unknown => Object.values(query(g, q)[0] ?? {})[0];

  test('sum over a hop equals the closed form, not the per-far-vertex sum', () => {
    const g = fanInGraph();
    const { sum, count } = oracle();

    expect(one(g, 'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c')).toBe(count);
    expect(one(g, 'MATCH (a:P)-[:T]->(b) RETURN sum(b.k) AS c')).toBe(sum);
    expect(one(g, 'MATCH (a:P)-[:T]->(b) RETURN avg(b.k) AS c')).toBeCloseTo(sum / count, 9);
  });

  test('a SECOND accumulator agrees — collect still rides the start-driven walk', () => {
    const g = fanInGraph();
    const { sum, count } = oracle();
    const list = one(g, 'MATCH (a:P)-[:T]->(b) RETURN collect(b.k) AS c') as number[];

    // `collect` stayed in `ORDER_SENSITIVE_WALK` because its order IS its value, so this arm is
    // reached by a DIFFERENT route than the fold above — which is what makes it an independent check
    // rather than the same code asserted twice.
    expect(list).toHaveLength(count);
    expect(list.reduce((s, v) => s + v, 0)).toBe(sum);
  });

  test('the UNDIRECTED hop, which was refused outright before item 2401', () => {
    const g = fanInGraph();
    const { sum } = oracle();

    // `orderSensitive && hopDir === 'both'` returned null, so this shape fell to the general path.
    // Both directions now ride the rung, and an undirected hop sees every edge from BOTH ends.
    expect(one(g, 'MATCH (a:P)-[:T]-(b) RETURN sum(b.k) AS c')).toBe(2 * sum);
  });
});
