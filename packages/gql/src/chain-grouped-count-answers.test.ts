import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the grouped-count chain rungs produce — item 1832.
 *
 * GROUPING IS WHERE KEYING MISTAKES BECOME WRONG ANSWERS, and this engine has shipped two in that
 * area already (items 1561, 1562, both in dedupe's one-column fast path, both found by mutation).
 * The rung tallies by `valueKey` because `buildGroups`' own comment settles the single-key case —
 * "for it the row key IS the value key" — so every case below is a value whose KEYING could go
 * wrong, not a value that merely exercises the path.
 *
 * THE ORACLE IS VERIFIED TO DECLINE, asked of `compileLinear` rather than assumed (item 1827):
 *
 * ```text
 *   RETURN d.k AS k, count(*) AS c                   -> chainGroupedCount
 *   RETURN d.k AS k, count(*) AS c LIMIT 100000000   -> []   (a real second route, all rows)
 *   RETURN d.k AS k, count(*) AS c GROUP BY k        -> []   (an explicit GROUP BY declines)
 *   RETURN d.k AS k, d.s AS s, count(*) AS c         -> []   (two group keys decline)
 *   RETURN d.k AS k, sum(d.n) AS s                   -> []   (a non-count aggregate declines)
 * ```
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Three levels, fully connected, every level carrying the same values (item 1822's lesson). */
const levels = (values: readonly unknown[]): Graph => {
  const g = new Graph();
  const n = values.length;

  for (let level = 0; level < 4; level += 1) {
    for (let i = 0; i < n; i += 1) {
      const properties: Record<string, unknown> = { s: `s${i % 2}`, n: i };

      if (values[i] !== undefined) {
        properties.k = values[i];
      }

      g.addVertex({ id: `L${level}_${i}`, labels: level === 0 ? ['L'] : ['M'], properties });
    }
  }

  let e = 0;

  for (let level = 0; level < 3; level += 1) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const from = g.getVertexById(`L${level}_${i}`);
        const to = g.getVertexById(`L${level + 1}_${j}`);

        if (from === null || to === null) {
          throw new Error('fixture is broken: a level vertex is missing after insertion');
        }

        g.addEdge({ id: `e${e}`, from, to, labels: ['R'] });
        e += 1;
      }
    }
  }

  return g;
};

const HOP2 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)';
const HOP3 = 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M)';
const HUGE = 100_000_000;

/** Sorted by rendered key, so a comparison is about the GROUPS and not their order. */
const groups = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort((x, y) => x.localeCompare(y));

describe('the grouped count over a chain', () => {
  test('counts each group, and the counts sum to the row count', () => {
    const g = levels([1, 2, 2, 3]);
    const rows = query(g, `${HOP2} RETURN c.k AS k, count(*) AS c`);

    // 4^3 = 64 rows at two hops, spread over three distinct keys by their multiplicity.
    expect(groups(rows)).toEqual(
      groups([
        { k: 1, c: 16 },
        { k: 2, c: 32 },
        { k: 3, c: 16 },
      ]),
    );
    expect(rows.reduce((n, r) => n + (r.c as number), 0)).toBe(64);
  });

  test('the three-hop width agrees', () => {
    const g = levels([1, 2, 2, 3]);
    const rows = query(g, `${HOP3} RETURN d.k AS k, count(*) AS c`);

    expect(rows.reduce((n, r) => n + (r.c as number), 0)).toBe(256);
    expect(groups(rows)).toEqual(
      groups([
        { k: 1, c: 64 },
        { k: 2, c: 128 },
        { k: 3, c: 64 },
      ]),
    );
  });

  /** A null key is a GROUP, not a dropped row — `null-first-class-policy`. */
  test('null and absent keys form their own group', () => {
    const g = levels([1, null, undefined]);
    const rows = query(g, `${HOP2} RETURN c.k AS k, count(*) AS c`);

    // `null` and an ABSENT property both read as null, so they are ONE group of two sources.
    expect(groups(rows)).toEqual(
      groups([
        { k: 1, c: 9 },
        { k: null, c: 18 },
      ]),
    );
  });

  /** `0` and `-0` key the same, and NaN keys equal to itself — `valueKey`'s rules, not `===`. */
  test('0/-0 are one group and NaN is one group, at BOTH widths', () => {
    expect(query(levels([0, -0]), `${HOP2} RETURN c.k AS k, count(*) AS c`)).toEqual([
      { k: 0, c: 8 },
    ]);
    expect(query(levels([0, -0]), `${HOP3} RETURN d.k AS k, count(*) AS c`)).toEqual([
      { k: 0, c: 16 },
    ]);

    for (const [chain, far, n] of [
      [HOP2, 'c', 18],
      [HOP3, 'd', 54],
    ] as const) {
      const nan = query(
        levels([Number.NaN, Number.NaN, 1]),
        `${chain} RETURN ${far}.k AS k, count(*) AS c`,
      );

      expect(nan.length).toBe(2);
      expect(nan.find((r) => Number.isNaN(r.k))?.c).toBe(n);
    }
  });

  /**
   * THE CROSS-ROUTE ORACLE, against a spelling verified to decline. It compares the ROWS AS
   * EMITTED — order included — because group order is what keeps the two ENGINES byte-identical
   * even though `order-is-unspecified` means no caller may rely on it.
   */
  test('agrees with the general path, group order included', () => {
    const g = levels([3, 1, 2, 2, null, 1]);

    for (const [chain, far] of [
      [HOP2, 'c'],
      [HOP3, 'd'],
    ] as const) {
      const viaRung = query(g, `${chain} RETURN ${far}.k AS k, count(*) AS c`);
      const viaGeneral = query(g, `${chain} RETURN ${far}.k AS k, count(*) AS c LIMIT ${HUGE}`);

      expect(viaRung).toEqual(viaGeneral);
    }
  });

  /**
   * A NUMBER AND A STRING THAT RENDER THE SAME MUST NOT SHARE A GROUP, and this test exists
   * because a mutant SURVIVED without it. Keying by `String(key)` instead of `valueKey` passes every
   * other case here — `0`/`-0`, `NaN`, `null` and even an element all render distinctly enough — and
   * silently merges `1` with `'1'`. `valueKey` is TYPE-PREFIXED for exactly this, and nothing else
   * in the file was asking it to be.
   */
  test('a numeric key and a string key that render alike stay apart', () => {
    const g = levels([1, '1', 2]);

    // BOTH WIDTHS, and a second mutation run is why. The two rungs are separate implementations
    // in separate files, so a keying test written only at `HOP2` leaves the chain copy unguarded —
    // the `String(key)` mutant survived exactly that way even after this case was added. The route
    // refusals above learned the same lesson one step earlier; the ANSWERS needed it too.
    for (const [chain, far, per] of [
      [HOP2, 'c', 9],
      [HOP3, 'd', 27],
    ] as const) {
      const rows = query(g, `${chain} RETURN ${far}.k AS k, count(*) AS c`);

      expect(rows.length).toBe(3);
      expect(groups(rows)).toEqual(
        groups([
          { k: 1, c: per },
          { k: '1', c: per },
          { k: 2, c: per },
        ]),
      );
    }
  });

  /** A group key that is an ELEMENT keys by id, not by object identity. */
  test('an element key groups by id', () => {
    const g = levels([1, 2, 3]);
    const rows = query(g, `${HOP2} RETURN c AS v, count(*) AS c`);

    expect(rows.length).toBe(3);
    expect(rows.reduce((n, r) => n + (r.c as number), 0)).toBe(27);
  });

  /** A carried far-end WHERE must filter before the tally. */
  test('a far-end WHERE filters before grouping', () => {
    const g = levels([1, 2, 3, 4]);
    const rows = query(g, `${HOP2} WHERE c.k > 2 RETURN c.k AS k, count(*) AS c`);

    expect(groups(rows)).toEqual(
      groups([
        { k: 3, c: 16 },
        { k: 4, c: 16 },
      ]),
    );
  });
});
