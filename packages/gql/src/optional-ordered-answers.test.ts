import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the ORDERED optional-hop rung produces — item 1849.
 *
 * `detectOptionalHopProjection` gates on `plainRowProjection`, which refuses an `orderBy`, so
 * `MATCH (a) OPTIONAL MATCH (a)-[:E]->(b) RETURN … ORDER BY …` fell to the general matcher at
 * **2081 ns a row against the unordered shape's 111**. The rung now strips the sort, reuses the
 * base detector's whole gate, and sorts the rows it produced (item 1827's trick).
 *
 * ⚠️ ORDER IS THE ANSWER HERE, so every assertion compares ARRAYS, never sets. That is what makes
 * this family different from the DISTINCT rungs, where row order is unspecified: the moment a
 * query says `ORDER BY`, the sequence is the contract.
 *
 * ⚠️ THE ORACLE IS `WHERE true`, WHICH IS A NO-OP THAT DECLINES THE RUNG. An outer clause `WHERE`
 * is one of the three modifiers this rung refuses (the other two, an edge variable and a window,
 * change the question or the rows), so `MATCH (a:T) WHERE true OPTIONAL MATCH …` asks EXACTLY the
 * same question down the general path. A hand-written expected array would only re-state what the
 * rung does; this compares two implementations.
 *
 * ⚠️ AND THE NULL ROWS ARE THE POINT OF THE FIXTURE. An OPTIONAL hop emits a NULL-filled row for
 * every start with no match, so the sort has to place nulls exactly where the general path does —
 * which no fixture of fully-matched vertices would check.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/**
 * Half the vertices have an out-edge and half do not, so both the matched and the NULL-filled arms
 * are populated. `k` repeats so the sort has genuine ties to break.
 */
const build = (): Graph => {
  const g = new Graph();
  const n = 12;

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 4, s: `s${i % 3}` } });
  }

  for (let i = 0; i < n; i += 2) {
    const from = g.getVertexById(`v${i}`);
    const to = g.getVertexById(`v${(i + 3) % n}`);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: { w: i % 5 } });
  }

  return g;
};

/** The row SEQUENCE, rendered so a null is distinguishable from the string "null". */
const seq = (g: Graph, text: string, params: Record<string, unknown> = {}): string[] =>
  query(g, text, params).map((r) =>
    Object.values(r)
      .map((v) => (v === null ? '<null>' : JSON.stringify(v)))
      .join('/'),
  );

/**
 * The same question down the general path.
 *
 * ⚠️ THE DEVICE CHANGED AT ITEM 1851, and this comment is the reason it is a comment. It used to
 * be a no-op OUTER `WHERE true`, which declined the rung — until item 1851 taught the rung to
 * carry an anchor predicate, at which point `WHERE true` started TAKING it and every comparison
 * here would have become the rung against itself. The assertion in "the rung actually fires for
 * each of those" is what caught that; without it the file would have gone on passing while
 * testing nothing.
 *
 * The replacement is a `WHERE true` on the OPTIONAL clause instead. That one is refused for a
 * reason that is not going to be relaxed: a `WHERE` on the OPTIONAL MATCH filters the HOP, so it
 * changes what "matched" means and therefore which anchors get a NULL row — it is a different
 * question from narrowing the starts, not a harder version of the same one.
 */
const viaGeneral = (text: string): string =>
  text.replace('(b:T) RETURN', '(b:T) WHERE true RETURN');

describe('an ORDER BY over an optional hop', () => {
  const CASES = [
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x',
    // The sort key is the NULLABLE column, so null placement is the whole question.
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY y, x',
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY y DESC, x',
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x DESC, y DESC',
    // A string column, so the comparator is not only numeric.
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.s AS x, b.s AS y ORDER BY x, y',
    // A type union on the hop, which the rung also serves.
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E|F]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
  ];

  test('produces the same SEQUENCE as the route that declines it', () => {
    const g = build();

    for (const text of CASES) {
      const got = seq(g, text);

      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(seq(g, viaGeneral(text)));
    }
  });

  test('the rung actually fires for each of those', () => {
    for (const text of CASES) {
      expect(routes(text)).toContain('optionalOrderedProjection');
      // …and the oracle genuinely does not, or the comparison above is vacuous.
      expect(routes(viaGeneral(text))).not.toContain('optionalOrderedProjection');
    }
  });

  /** Every start appears, matched or not — the OPTIONAL contract, which a sort must not change. */
  test('keeps the NULL-filled row for every unmatched start', () => {
    const g = build();
    const rows = seq(
      g,
      'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
    );

    expect(rows.length).toBe(12);
    expect(rows.filter((r) => r.endsWith('<null>')).length).toBe(6);
  });
});

describe('the ordered optional rung declines what it must', () => {
  /**
   * ⚠️ ~~A WINDOW IS REFUSED~~ — **ADMITTED SINCE ITEM 1852.** My note here called refusing it a
   * correctness condition because "the order decides WHICH rows survive". The order does decide
   * that, and it is exactly why sort-then-slice is correct: the sort is by OUTPUT COLUMNS and the
   * window applies to the sorted result. `outputColumnSorts` holds the real conditions (no
   * faulting projected item, no parameterised window) and `sortRowsByColumns` applies the window
   * itself, bounded heap included. The answers are still compared against the declining route.
   */
  test('a SKIP or LIMIT takes the rung and answers what the general route answers', () => {
    const g = build();

    for (const tail of [
      'ORDER BY x, y LIMIT 3',
      'ORDER BY x, y SKIP 2',
      'ORDER BY x, y SKIP 1 LIMIT 2',
    ]) {
      const text = `MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ${tail}`;

      expect(routes(text)).toContain('optionalOrderedProjection');
      expect(seq(g, text)).toEqual(seq(g, viaGeneral(text)));
    }
  });

  /**
   * ⚠️ ~~A PARAMETERISED window still declines~~ — **ADMITTED SINCE ITEM 1867**, and the reason
   * this note gave ("its value is not known when the route is chosen") was the overstated half of
   * a real concern. The ROUTE does not depend on the value: this rung sorts and slices, and
   * `sortRowsByColumns` picks heap-vs-sort at RUN time against the actual row count. Only the
   * NUMBER waits for `params`, which it now does. The top-k rungs are the ones where the refusal
   * is genuine, because they size a heap at compile time.
   *
   * The answer assertion is unchanged and still passes — it is what says the admission is correct
   * rather than merely different.
   */
  test('a parameterised window takes the rung, and answers the same', () => {
    const g = build();
    const text =
      'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y LIMIT $n';

    expect(routes(text)).toContain('optionalOrderedProjection');
    expect(query(g, text, { n: 3 }).length).toBe(3);
    // ⚠️ AND AGAINST THE GENERAL ROUTE, which a length check alone cannot do: three rows of the
    // WRONG three would satisfy it.
    expect(seq(g, text, { n: 3 })).toEqual(seq(g, viaGeneral(text), { n: 3 }));
  });

  /** A sort key that is not an output column cannot be answered by sorting the rung's rows. */
  test('a sort key that names no output column does not take the rung', () => {
    const g = build();
    const text = 'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x ORDER BY a.s';

    expect(routes(text)).not.toContain('optionalOrderedProjection');
    expect(seq(g, text)).toEqual(seq(g, viaGeneral(text)));
  });
});
