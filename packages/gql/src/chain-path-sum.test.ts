/*
 * Item 2411 — `sum`/`avg` on the PATH-WALK rungs (`detectChainFoldedAggregate` and
 * `detectHop2FoldedAggregate`), the shapes the chain LEVEL fold declines.
 *
 * ⚠️⚠️ **THIS IS A DIFFERENT ARGUMENT FROM ITEM 2409's, AND CONFLATING THEM WOULD PIN THE WRONG
 * THING.** The level fold computes `Σ u_v · x_v` over distinct reached vertices — a DIFFERENT
 * COMPUTATION from a per-path sum, which is why it needed an error bound. These rungs walk the actual
 * paths, so this is a plain left fold over the same addends in a possibly different ORDER. That is a
 * re-association and nothing more.
 *
 * 🔑 So the cross-route comparisons here use item 2401's PRECISION CONTRACT (1e-9 relative: ~3 orders
 * above reassociation noise, ~4 below a dropped row), not equality. ⚠️ A test demanding the same BITS
 * from the rung and the general path would make this unshippable while proving nothing the contract
 * asks for — and an INTEGER fixture would pass against either, since an integer sum in f64 is exact
 * whatever the order. Every float assertion below is over a binary-inexact column on purpose.
 *
 * 🔑 WHAT IS PINNED EXACTLY is everything the contract does NOT free:
 *   - the EMPTY answers, which disagree with each other on purpose (`sum` → 0, `avg` → null);
 *   - `avg`'s denominator skipping nulls;
 *   - the BAIL on a value the fold may not add, which must FAULT and not answer;
 *   - the refusals that are still live: `sum(DISTINCT)` and `collect`.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Four layers of two vertices, every vertex pointing at both vertices of the next — 16 three-hop
 * paths, each vertex on 8 of them. `Q` on the even layers and `F` on some edges give the label
 * expression and the union arms something non-vacuous to match without changing the walk's size.
 */
type LayerProps = (Record<string, unknown> | undefined)[] | undefined;

const layered = (props: LayerProps[] = []): Graph => {
  const g = new Graph();
  const vals = [
    [10, 20],
    [1, 2],
    [3, 4],
    [100, 200],
  ];

  for (const [li, row] of vals.entries()) {
    for (const [vi, n] of row.entries()) {
      g.addVertex({
        id: `L${li}-${vi}`,
        labels: li % 2 === 0 ? ['P', 'Q'] : ['P'],
        // `w` is binary-inexact, so a re-association is observable at all.
        properties: props[li]?.[vi] ?? { n, w: n * 0.1 },
      });
    }
  }

  for (let li = 0; li + 1 < vals.length; li += 1) {
    for (let from = 0; from < 2; from += 1) {
      for (let to = 0; to < 2; to += 1) {
        g.addEdge({
          id: `e${li}-${from}-${to}`,
          from: g.getVertexById(`L${li}-${from}`)!,
          to: g.getVertexById(`L${li + 1}-${to}`)!,
          labels: from === to ? ['E', 'F'] : ['E'],
          properties: {},
        });
      }
    }
  }

  return g;
};

/** ⚠️ EACH OF THESE DECLINES THE LEVEL FOLD FOR A DIFFERENT REASON — that is why there are four. */
const SHAPES: readonly (readonly [string, string, string])[] = [
  ['label expression', '(a:P)-[:E]->(b:P|Q)-[:E]->(c:P)-[:E]->(d:P)', 'd'],
  ['union types', '(a:P)-[:E|F]->(b:P)-[:E|F]->(c:P)-[:E|F]->(d:P)', 'd'],
  ['inline properties', '(a:P)-[:E]->(b:P {n: 1})-[:E]->(c:P)-[:E]->(d:P)', 'd'],
  // The argument reads the START, which the level recurrence cannot express at all (item 2410).
  ['non-far argument', '(a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P)', 'a'],
];

/** The same four reasons at TWO hops, which is `hop2-projection.ts`'s rung rather than the chain's. */
const SHAPES2: readonly (readonly [string, string, string])[] = [
  ['label expression', '(a:P)-[:E]->(b:P|Q)-[:E]->(c:P)', 'c'],
  ['union types', '(a:P)-[:E|F]->(b:P)-[:E|F]->(c:P)', 'c'],
  ['non-far argument', '(a:P)-[:E]->(b:P)-[:E]->(c:P)', 'a'],
];

const one = (g: Graph, text: string): unknown => {
  const rows = query(g, text, {}) as Record<string, unknown>[];

  expect(rows).toHaveLength(1);

  return rows[0].x;
};

/** Item 2401's contract at 1e-9 relative — the same tolerance `closeEnough` uses. */
const withinContract = (got: unknown, want: number): void => {
  expect(typeof got).toBe('number');
  expect(Math.abs((got as number) - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
};

/** Kahan over the ENGINE'S OWN ROWS — a reference, not a re-derived walk. */
const kahan = (xs: readonly number[]): number => {
  let s = 0;
  let c = 0;

  for (const x of xs) {
    const y = x - c;
    const t = s + y;

    c = t - s - y;
    s = t;
  }

  return s;
};

describe('item 2411 — sum/avg on the path-walk chain rungs', () => {
  test.each([...SHAPES, ...SHAPES2])(
    "%s: sum and avg agree with the rung's own rows, within the contract",
    (_name, pattern, v) => {
      const g = layered();
      const rows = query(g, `MATCH ${pattern} RETURN ${v}.w AS x`, {}) as { x: number }[];
      const exact = kahan(rows.map((r) => r.x));

      // ⚠️ NOT VACUOUS: a fixture with one path would make every fold trivially right.
      expect(rows.length).toBeGreaterThan(3);

      withinContract(one(g, `MATCH ${pattern} RETURN sum(${v}.w) AS x`), exact);
      withinContract(one(g, `MATCH ${pattern} RETURN avg(${v}.w) AS x`), exact / rows.length);
      // The integer column is EXACT in f64 whatever the order, so it may be pinned outright — and
      // that is the assertion that would catch a dropped or double-counted path.
      expect(one(g, `MATCH ${pattern} RETURN count(${v}.n) AS x`)).toBe(rows.length);
    },
  );

  /*
   * ⚠️⚠️ **THE EMPTY ANSWERS DISAGREE WITH EACH OTHER ON PURPOSE, and item 2410 is why.** `sum` of
   * nothing is `0` and `avg` of nothing is `null` on every route in this engine; item 2409 answered
   * `null` for both on the level fold and that was a route-dependent answer. 🔑 The one-hop control
   * is what makes this a CONTRACT rather than this rung's preference — one hop cannot reach either
   * chain rung, so it answers from the general path and the two must agree.
   */
  test.each(SHAPES)(
    '%s: an all-null column answers 0 for sum and null for avg',
    (_n, pattern, v) => {
      /*
       * ⚠️ `n` STAYS ON LAYER 1, because the inline-properties shape matches on `{n: 1}` — nulling it
       * everywhere made that arm match NOTHING, so the test asserted against an empty walk instead of
       * an all-null column. Only `w`, the column being folded, is absent.
       */
      const g = layered([
        [{}, {}],
        [{ n: 1 }, { n: 2 }],
        [{}, {}],
        [{}, {}],
      ]);
      const walked = query(g, `MATCH ${pattern} RETURN ${v}.w AS x`, {});

      // ⚠️ THE WALK MUST BE NON-EMPTY, or "0 for sum" is the empty-walk answer rather than the
      // all-null one and the test proves nothing about null exclusion.
      expect(walked.length).toBeGreaterThan(3);
      expect(one(g, `MATCH ${pattern} RETURN sum(${v}.w) AS x`)).toBe(0);
      expect(one(g, `MATCH ${pattern} RETURN avg(${v}.w) AS x`)).toBe(null);

      // CROSS-ROUTE CONTROL: the general path, which cannot reach these rungs.
      expect(one(g, 'MATCH (a:P)-[:E]->(b:P) RETURN sum(b.w) AS x')).toBe(0);
      expect(one(g, 'MATCH (a:P)-[:E]->(b:P) RETURN avg(b.w) AS x')).toBe(null);
    },
  );

  /*
   * ⚠️ `avg`'s DENOMINATOR SKIPS NULLS, so it is the value and not a fraction of it. A fixture where
   * every value is present cannot tell `count` from `inner.length`, so this one makes half the far
   * layer null — and the integer column makes the expectation exact rather than contractual.
   */
  test('avg divides by the NON-NULL count, not the path count', () => {
    const g = layered([undefined, undefined, undefined, [{ n: 100 }, {}]]);
    const pattern = '(a:P)-[:E]->(b:P|Q)-[:E]->(c:P)-[:E]->(d:P)';
    const rows = query(g, `MATCH ${pattern} RETURN d.n AS x`, {}) as { x: unknown }[];
    const kept = rows.filter((r) => r.x !== null && r.x !== undefined);

    // 16 paths, 8 of them reaching the vertex that still carries `n`.
    expect(rows).toHaveLength(16);
    expect(kept).toHaveLength(8);
    expect(one(g, `MATCH ${pattern} RETURN sum(d.n) AS x`)).toBe(800);
    expect(one(g, `MATCH ${pattern} RETURN count(d.n) AS x`)).toBe(8);
    // 800/8, NOT 800/16.
    expect(one(g, `MATCH ${pattern} RETURN avg(d.n) AS x`)).toBe(100);
  });

  /*
   * ⚠️⚠️ **A STORED TEMPORAL MUST FAULT, NOT ANSWER.** One temporal anywhere in the column turns
   * `sum` from "add numbers" into a loud data exception (item 2336), and the fold cannot know that
   * while compiling — so it bails at execution time with a partial total already in hand and hands
   * the WHOLE query back. 🔑 Answering the partial total is the silent wrong answer this guards, and
   * `min` is the control: it is a comparison, not an addition, so it must NOT fault.
   */
  test('a stored temporal FAULTS the fold rather than summing part of the column', () => {
    const g = layered([
      undefined,
      undefined,
      undefined,
      [
        { n: 1, w: 0.5 },
        { n: 2, w: 0.5 },
      ],
    ]);
    const pattern = '(a:P)-[:E]->(b:P|Q)-[:E]->(c:P)-[:E]->(d:P)';

    // The control first: with a numeric column the fold answers, so the fault below is the TEMPORAL
    // and not the shape.
    expect(one(g, `MATCH ${pattern} RETURN sum(d.n) AS x`)).toBe(24);

    /*
     * ⚠️ THE TEMPORAL IS STORED, NOT COMPUTED. `sum(d.n + DATE '2024-01-01')` yields null per element
     * and the fold then answered `0` — the first version of this test asserted a fault and got one
     * for the wrong reason. `{ '@date': … }` is the stored form, and it sits on the LAST layer so
     * real numbers are accumulated before the fold meets it (item 2159's sharpest shape): a bail
     * that returned its partial total would answer a number instead of throwing.
     */
    const t = layered([
      undefined,
      undefined,
      undefined,
      [{ n: 1 }, { n: { '@date': '2024-01-02' } }],
    ]);

    expect(() => query(t, `MATCH ${pattern} RETURN sum(d.n) AS x`, {})).toThrow();
    expect(() => query(t, `MATCH ${pattern} RETURN avg(d.n) AS x`, {})).toThrow();
    // ⚠️ AND THE CONTROL: the same column under `min` does NOT fault, because a total order covers a
    // temporal where addition does not. So the throw is `sum`'s semantics, not the fixture.
    expect(() => query(t, `MATCH ${pattern} RETURN min(d.n) AS x`, {})).not.toThrow();
  });

  /*
   * ⚠️ THE REFUSALS THAT ARE STILL LIVE, and both are real rather than stale. `sum(DISTINCT)` folds
   * over a DEDUPED multiset, which this accumulator does not perform — admitting it would silently
   * sum the duplicates. `collect`'s element order is its answer's content.
   */
  test.each(SHAPES)('%s: sum(DISTINCT) and collect still answer correctly', (_n, pattern, v) => {
    const g = layered();
    const rows = query(g, `MATCH ${pattern} RETURN ${v}.n AS x`, {}) as { x: number }[];
    const distinct = new Set(rows.map((r) => r.x));

    expect(one(g, `MATCH ${pattern} RETURN sum(DISTINCT ${v}.n) AS x`)).toBe(
      [...distinct].reduce((t, x) => t + x, 0),
    );
    expect(one(g, `MATCH ${pattern} RETURN collect(${v}.n) AS x`)).toHaveLength(rows.length);
  });

  /*
   * ⚠️ AN EXPRESSION WRAPPING THE AGGREGATE must not be answered by the fold's result directly —
   * `sum(x) * 2` folds the same aggregate but the row's value is the arithmetic.
   */
  test('an expression wrapping the aggregate keeps the arithmetic', () => {
    const g = layered();
    const pattern = '(a:P)-[:E]->(b:P|Q)-[:E]->(c:P)-[:E]->(d:P)';
    const plain = one(g, `MATCH ${pattern} RETURN sum(d.n) AS x`) as number;

    expect(one(g, `MATCH ${pattern} RETURN sum(d.n) * 2 AS x`)).toBe(plain * 2);
    expect(one(g, `MATCH ${pattern} RETURN sum(d.n) + 1 AS x`)).toBe(plain + 1);
  });
});
