import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the multi-column node-scan DISTINCT produces — item 1853.
 *
 * Every hop and chain width already claimed a multi-column `DISTINCT`; the plain node scan claimed
 * only the one-column case, so `RETURN DISTINCT n.n, n.k` fell to the general matcher at **110.9 ms
 * against the one-column spelling's 4.0** — and 12x the cost of emitting every row it dedupes.
 *
 * ⚠️ THE RISK IS THE KEY, NOT THE WALK. The rung reuses `detectNodeProjection` to build rows and
 * `distinctRows` to dedupe them, so nothing about the scan is new — what is new is that a
 * multi-column key now decides which rows collapse. The fixture is therefore built from the values
 * that make keying hard rather than from distinct integers: a stored `null`, `-0` against `0`,
 * `NaN`, a string that looks like another column's value, and two columns whose values are swapped
 * between rows so a key that IGNORED COLUMN ORDER would wrongly merge them.
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

const build = (): Graph => {
  const g = new Graph();
  const rows: [unknown, unknown][] = [
    [1, 2],
    [1, 2], // an exact duplicate — must collapse
    [2, 1], // the SWAP of the first: must NOT collapse into it
    [0, -0], // `-0` and `0` are one group, so this pairs with the next
    [-0, 0],
    [null, 1], // a stored null is a value, not an absence
    [null, 1],
    [Number.NaN, 3],
    [Number.NaN, 3], // NaN equals itself for keying
    ['1', 2], // the STRING '1' must not collapse into the NUMBER 1
  ];

  for (const [i, [a, b]] of rows.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { a, b } });
  }

  return g;
};

const seq = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) =>
      Object.values(r)
        .map((v) => {
          if (v === null) {
            return '<null>';
          }

          return typeof v === 'number' && Number.isNaN(v)
            ? '#NaN'
            : `${typeof v}:${JSON.stringify(v)}`;
        })
        .join('|'),
    )
    .sort();

/** The same question with an extra bound variable, which `detectNodeProjection` refuses. */
const viaGeneral = (text: string): string =>
  text.replace('MATCH (n:T)', 'MATCH (n:T), (zz:T)').replace('RETURN DISTINCT', 'RETURN DISTINCT');

describe('a multi-column DISTINCT over a node scan', () => {
  test('agrees with the route that declines it, on the values that make keying hard', () => {
    const g = build();
    const text = 'MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y';

    expect(routes(text)).toContain('nodeDistinctProjection');

    const got = seq(g, text);

    // Ten rows in, and exactly the duplicate pairs collapse: [1,2]x2, [null,1]x2, [NaN,3]x2 and
    // the `-0`/`0` pair each become one.
    expect(got.length).toBe(6);
    expect(got).toEqual(
      [
        'number:1|number:2',
        'number:2|number:1',
        'number:0|number:0',
        '<null>|number:1',
        '#NaN|number:3',
        // ⚠️ RENDERED WITH `JSON.stringify`, so the STRING '1' reads as `string:"1"` and cannot be
        // confused with the NUMBER 1 — which is the collision this row exists to rule out.
        'string:"1"|number:2',
      ].sort(),
    );
  });

  /**
   * ⚠️ THE SWAPPED PAIR IS THE COLUMN-ORDER GUARD. `[1,2]` and `[2,1]` have the same VALUES, so a
   * key that joined them without respecting position would collapse two different rows into one.
   */
  test('a swapped pair stays two rows', () => {
    const g = build();
    const got = seq(g, 'MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y');

    expect(got).toContain('number:1|number:2');
    expect(got).toContain('number:2|number:1');
  });

  test('three columns, and the projected expressions need not be bare properties', () => {
    const g = build();

    for (const text of [
      'MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y, n.a AS z',
      'MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y, 1 AS z',
    ]) {
      expect(routes(text)).toContain('nodeDistinctProjection');
      // The third column is a function of the first two (or a constant), so it adds no groups.
      expect(seq(g, text).length).toBe(6);
    }
  });

  test('the one-column spelling keeps its own tuned rung', () => {
    expect(routes('MATCH (n:T) RETURN DISTINCT n.a AS x')).toEqual(['distinctProjection']);
  });

  /**
   * ⚠️ A SORT OR WINDOW IS REFUSED, deliberately: `distinctRows` runs AFTER the rows exist, so a
   * window would have to be applied after the dedupe while `detectNodeProjection` would have
   * applied it before — which returns different ROWS, not a different order.
   */
  test('a sort or a window declines, and still answers', () => {
    const g = build();

    for (const tail of ['ORDER BY x', 'LIMIT 3', 'ORDER BY x LIMIT 2']) {
      const text = `MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y ${tail}`;

      expect(routes(text)).not.toContain('nodeDistinctProjection');
      expect(query(g, text).length).toBeGreaterThan(0);
    }
  });

  /** And the rung's rows match the general path's, as a multiset. */
  test('agrees with a spelling the node rung cannot claim', () => {
    const g = build();
    const text = 'MATCH (n:T) RETURN DISTINCT n.a AS x, n.b AS y';
    const oracle = viaGeneral(text);

    expect(routes(oracle)).not.toContain('nodeDistinctProjection');
    // The cross product with a second unconstrained scan repeats each row ten times, which
    // DISTINCT collapses back to the same six.
    expect(seq(g, oracle)).toEqual(seq(g, text));
  });
});
