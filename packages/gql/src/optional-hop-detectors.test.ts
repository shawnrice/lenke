import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2470: `detectOptionalOrderedProjection` and `detectOptionalGroupedHopCount` from item 2460's
 * map — neither named in any test, and neither field name appearing anywhere in `CLOSED.md`.
 *
 * THE FIELD MAP, probed before writing a line, and it splits on the AGGREGATE rather than on the
 * grouping:
 *
 * ```text
 *    OPTIONAL MATCH shape          detector that lights
 *      RETURN z.k                    optionalHopProjection
 *      RETURN z.k ORDER BY k [DESC]  optionalOrderedProjection
 *      RETURN a.k, count(*)          optionalGroupedHopCount
 *      RETURN a.k, count(z)          (none)
 *      RETURN count(*)               optionalHopCount
 *      RETURN count(z)               countShortcut
 *      RETURN z.k SKIP 1             (none)
 *      RETURN DISTINCT z.k           (none)
 * ```
 *
 * **`count(*)` AND `count(z)` ROUTE DIFFERENTLY BECAUSE THEY ANSWER DIFFERENTLY.** On a row whose
 * optional side missed, `count(z)` contributes nothing (the value is NULL) while `count(*)` counts
 * the row — ISO's rule, and the reason the grouped detector takes only the star form. The test below
 * asserts both the route and the two answers, so a widening that admitted `count(z)` would be caught
 * by the ROWS rather than only by the field.
 *
 * A route choice is answer-equivalent, so none of this is visible to the differential, fuzz or
 * conformance suites (`perf-gate-needs-its-own-test`). Each admission calls the returned function and
 * compares against `query` — positionally where an explicit `ORDER BY` makes the order a contract,
 * as a multiset otherwise (`order-is-unspecified`).
 */

/*
 * `a` and `c` have an outgoing `E`; `b` and `d` do not, so the OPTIONAL side genuinely misses for
 * some rows. One `:Q` vertex keeps `:P` non-vacuous — item 2467 showed a homogeneous fixture cannot
 * reach some arms at all.
 */
const build = (): Graph => {
  const g = new Graph();
  const v: Record<string, ReturnType<Graph['addVertex']>> = {};

  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 1],
    ['d', 2],
  ] as const) {
    v[id] = g.addVertex({ id, labels: ['P'], properties: { k } });
  }

  v.x = g.addVertex({ id: 'x', labels: ['P'], properties: { k: 3 } });
  v.y = g.addVertex({ id: 'y', labels: ['P'], properties: { k: 4 } });
  g.addEdge({ id: 'e1', from: v.a, to: v.x, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v.c, to: v.y, labels: ['E'], properties: {} });
  g.addVertex({ id: 'off', labels: ['Q'], properties: { k: 9 } });

  return g;
};

const g = build();

type Linear = Parameters<typeof compileLinear>[0];

const routes = (text: string) => {
  const parsed = parse(text) as { parts?: readonly unknown[] };

  return compileLinear((parsed.parts === undefined ? parsed : parsed.parts[0]) as Linear);
};

const bag = (rows: readonly unknown[]) => [...rows].map((r) => JSON.stringify(r)).sort();
const ks = (rows: readonly unknown[]) => rows.map((r) => (r as { k: number | null }).k);

const OPT = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(z:P)';

describe('detectOptionalOrderedProjection', () => {
  it('serves an ASCENDING order, compared POSITIONALLY because the order is a contract', () => {
    const text = `${OPT} RETURN z.k AS k ORDER BY k`;
    const compiled = routes(text);

    expect(compiled.optionalOrderedProjection).not.toBeNull();
    expect(compiled.optionalOrderedProjection?.(g, {})).toStrictEqual(query(g, text, {}));
  });

  it('serves a DESCENDING order, and the direction itself is pinned', () => {
    const text = `${OPT} RETURN z.k AS k ORDER BY k DESC`;
    const compiled = routes(text);
    const rows = compiled.optionalOrderedProjection?.(g, {}) ?? [];

    expect(compiled.optionalOrderedProjection).not.toBeNull();
    expect(rows).toStrictEqual(query(g, text, {}));
    // Without this an ascending mutant would still match `query`, since both arms would flip.
    expect(ks(rows).filter((k) => k !== null)).toStrictEqual([4, 3]);
  });

  it('puts the MISSING optional side LAST in both directions', () => {
    /*
     * The non-obvious half. NULLs sort last under `ORDER BY k` AND under `ORDER BY k DESC` — they
     * are not simply "largest", they are placed by the engine's total order. Four of the six rows
     * here have a NULL `k` (b, d, x and y have no outgoing E), so a direction-dependent NULL
     * placement would be plainly visible.
     */
    for (const dir of ['', ' DESC']) {
      const rows = query(g, `${OPT} RETURN z.k AS k ORDER BY k${dir}`, {});
      const nulls = ks(rows).map((k) => k === null);
      const firstNull = nulls.indexOf(true);

      expect(firstNull).toBeGreaterThan(0);
      // Every entry from the first NULL onward is NULL: no interleaving.
      expect(nulls.slice(firstNull).every(Boolean)).toBe(true);
    }
  });

  it('DECLINES a projection with no ORDER BY, which the plain optional arm takes', () => {
    const compiled = routes(`${OPT} RETURN z.k AS k`);

    expect(compiled.optionalOrderedProjection).toBeNull();
    expect(compiled.optionalHopProjection).not.toBeNull();
  });

  it('DECLINES a SKIP and a DISTINCT, neither of which any arm serves', () => {
    for (const suffix of ['SKIP 1', 'LIMIT 1']) {
      expect(routes(`${OPT} RETURN z.k AS k ${suffix}`).optionalOrderedProjection).toBeNull();
    }

    expect(routes(`${OPT} RETURN DISTINCT z.k AS k`).optionalOrderedProjection).toBeNull();
  });

  it('DECLINES a NON-optional hop, where the plain hop projection takes the order', () => {
    const compiled = routes('MATCH (a:P)-[:E]->(z:P) RETURN z.k AS k ORDER BY k');

    expect(compiled.optionalOrderedProjection).toBeNull();
    expect(compiled.hopProjection).not.toBeNull();
  });
});

describe('detectOptionalGroupedHopCount', () => {
  it('serves a grouped count(*), and its ROWS are the engine answer', () => {
    const text = `${OPT} RETURN a.k AS ak, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.optionalGroupedHopCount).not.toBeNull();
    expect(bag(compiled.optionalGroupedHopCount?.(g, {}) ?? [])).toStrictEqual(
      bag(query(g, text, {})),
    );
  });

  it('DECLINES count(z) — and the two spellings ANSWER DIFFERENTLY, which is why', () => {
    /*
     * `count(*)` counts the row; `count(z)` skips it when `z` is NULL. So for the `ak` group whose
     * optional side missed, the star form reports 2 and the expression form reports 0. Asserting
     * both answers means a widening that admitted `count(z)` into the star detector would be caught
     * by the rows, not merely by the field being non-null.
     */
    const starText = `${OPT} RETURN a.k AS ak, count(*) AS n`;
    const exprText = `${OPT} RETURN a.k AS ak, count(z) AS n`;

    expect(routes(exprText).optionalGroupedHopCount).toBeNull();

    const star = query(g, starText, {}) as { ak: number; n: number }[];
    const expr = query(g, exprText, {}) as { ak: number; n: number }[];
    const at = (rows: { ak: number; n: number }[], ak: number) => rows.find((r) => r.ak === ak)?.n;

    // `ak === 2` is `b` and `d`, neither of which has an outgoing E.
    expect(at(star, 2)).toBe(2);
    expect(at(expr, 2)).toBe(0);
    // `ak === 1` is `a` and `c`, both of which do.
    expect(at(star, 1)).toBe(2);
    expect(at(expr, 1)).toBe(2);
  });

  /*
   * THE CLAUSE-STRUCTURE AXIS. All six mutants survived the first cut of this file, because every
   * fixture varied the PROJECTION while these guards test the SHAPE OF THE CLAUSES. A flip sweep —
   * each mutant alone against nine structural candidates — moved a verdict for four of them, and
   * these are those four shapes. (Item 2467 made the same mistake on the depth axis; this is the
   * same lesson one axis over.)
   */
  it('DECLINES when the FIRST match is itself OPTIONAL', () => {
    const text = `OPTIONAL MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(z:P) RETURN a.k AS ak, count(*) AS n`;

    expect(routes(text).optionalGroupedHopCount).toBeNull();
  });

  it('DECLINES when the optional side carries a WHERE', () => {
    // The predicate changes which rows the optional side contributes, so the counting rewrite
    // cannot assume a miss means "no match".
    const text = `${OPT} WHERE z.k > 0 RETURN a.k AS ak, count(*) AS n`;

    expect(routes(text).optionalGroupedHopCount).toBeNull();
  });

  it('DECLINES a two-pattern anchor', () => {
    const text = `MATCH (a:P), (b:P) OPTIONAL MATCH (a)-[:E]->(z:P) RETURN a.k AS ak, count(*) AS n`;

    expect(routes(text).optionalGroupedHopCount).toBeNull();
  });

  it('DECLINES an anchor that is itself a hop rather than a bare node', () => {
    const text = `MATCH (a:P)-[:E]->(w:P) OPTIONAL MATCH (a)-[:E]->(z:P) RETURN a.k AS ak, count(*) AS n`;

    expect(routes(text).optionalGroupedHopCount).toBeNull();
  });

  it('DECLINES an UNGROUPED count(*), which its own sibling serves', () => {
    const compiled = routes(`${OPT} RETURN count(*) AS n`);

    expect(compiled.optionalGroupedHopCount).toBeNull();
    expect(compiled.optionalHopCount).not.toBeNull();
  });

  it('DECLINES a plain projection and an ordered one', () => {
    expect(routes(`${OPT} RETURN z.k AS k`).optionalGroupedHopCount).toBeNull();
    expect(routes(`${OPT} RETURN z.k AS k ORDER BY k`).optionalGroupedHopCount).toBeNull();
  });
});
