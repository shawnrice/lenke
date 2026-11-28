import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2469: the three `detectHop2*` detectors from item 2460's map —
 * `detectHop2GroupedCount`, `detectHop2OrderedProjection`, `detectHop2PagedProjection`. None was
 * named in any test, and they own the DEPTH-2 grouped, ordered and paged shapes: item 2467's field
 * map showed the `detectChain*` family never lights at two hops, so these are the only detectors
 * covering the commonest non-trivial projection depth.
 *
 * THE FIELD MAP WAS PROBED FIRST, and it answers a question the names cannot:
 *
 * ```text
 *    depth 2 shape               detector that lights
 *      z.k, count(*)               hop2GroupedCount
 *      z.k, sum(z.k)               (none)          <- only COUNT is grouped-served
 *      ORDER BY k / DESC / +LIMIT  hop2OrderedProjection
 *      SKIP 1                      hop2PagedProjection
 *      LIMIT 2                     (none)
 *      SKIP 1 LIMIT 2              (none)          <- the pair is NOT the paged shape
 *      plain / two columns         hop2Projection
 *      count(*) alone              (none; countShortcut owns it)
 *      z.k, count(*) ORDER BY k    (none)
 * ```
 *
 * **`SKIP` ALONE IS THE PAGED ARM AND `SKIP` + `LIMIT` IS NOT**, which is the sharpest thing here
 * and is exactly backwards from what the name suggests. Item 1905 records the reason from the other
 * side: "a `SKIP` with no `LIMIT` reaches the deferred arm". A test written from the detector's name
 * would have asserted the `SKIP 1 LIMIT 2` shape and passed for the wrong reason, since that shape
 * declines.
 *
 * A route choice is answer-equivalent, so none of this is visible to the differential, fuzz or
 * conformance suites (`perf-gate-needs-its-own-test`). Each admission calls the returned function
 * and compares ROWS against the engine (`gate-returning-a-value`): positionally under an explicit
 * `ORDER BY`, and as a MULTISET otherwise, because an unordered result's row order is
 * implementation-dependent (`order-is-unspecified`).
 */

/** a->b->c->d->e, alternating `k`, plus one off-label vertex so `:P` is not vacuous. */
const build = (): Graph => {
  const g = new Graph();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const v: Record<string, ReturnType<Graph['addVertex']>> = {};

  for (let i = 0; i < ids.length; i += 1) {
    v[ids[i]] = g.addVertex({ id: ids[i], labels: ['P'], properties: { k: (i % 2) + 1 } });
  }

  for (let j = 0; j < ids.length - 1; j += 1) {
    g.addEdge({ id: `e${j}`, from: v[ids[j]], to: v[ids[j + 1]], labels: ['E'], properties: {} });
  }

  // `label-vacuity-gates-fast-paths` cuts both ways (item 2467), so the fixture is not homogeneous.
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

const C2 = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(z:P)';

describe('detectHop2GroupedCount', () => {
  it('serves a grouped COUNT at depth 2, and its ROWS are the engine answer', () => {
    const text = `${C2} RETURN z.k AS k, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.hop2GroupedCount).not.toBeNull();
    expect(bag(compiled.hop2GroupedCount?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
  });

  it('DECLINES a grouped SUM — only COUNT is served here', () => {
    // The aggregate, not the grouping, is the discriminator; no other detector takes this shape.
    const text = `${C2} RETURN z.k AS k, sum(z.k) AS s`;
    const compiled = routes(text);

    expect(compiled.hop2GroupedCount).toBeNull();
    expect(query(g, text, {})).toHaveLength(2);
  });

  it('DECLINES a DISTINCT grouped count — the one guard the flip sweep found load-bearing', () => {
    /*
     * FOUND BY FLIPPING (item 2469). Of five surviving mutants, only `ret.projection.distinct`
     * moved a verdict: dropping it admits exactly this shape and nothing else. The other four
     * conditions in that conjunction are conditionally redundant and say so at their clauses.
     */
    const text = `${C2} RETURN DISTINCT z.k AS k, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.hop2GroupedCount).toBeNull();
    expect(query(g, text, {})).toHaveLength(2);
  });

  it('DECLINES a grouped count under an ORDER BY', () => {
    const compiled = routes(`${C2} RETURN z.k AS k, count(*) AS n ORDER BY k`);

    expect(compiled.hop2GroupedCount).toBeNull();
    expect(compiled.hop2OrderedProjection).toBeNull();
  });

  it('DECLINES an ungrouped count, which `countShortcut` owns', () => {
    const compiled = routes(`${C2} RETURN count(*) AS n`);

    expect(compiled.hop2GroupedCount).toBeNull();
  });

  it('DECLINES a plain projection', () => {
    const compiled = routes(`${C2} RETURN z.k AS k`);

    expect(compiled.hop2GroupedCount).toBeNull();
    expect(compiled.hop2Projection).not.toBeNull();
  });
});

describe('detectHop2OrderedProjection', () => {
  it('serves ORDER BY, and the rows are compared POSITIONALLY because the order is a contract', () => {
    const text = `${C2} RETURN z.k AS k ORDER BY k`;
    const compiled = routes(text);

    expect(compiled.hop2OrderedProjection).not.toBeNull();
    expect(compiled.hop2OrderedProjection?.(g, {})).toStrictEqual(query(g, text, {}));
  });

  it('serves a DESCENDING order, which is the opposite comparator', () => {
    const text = `${C2} RETURN z.k AS k ORDER BY k DESC`;
    const compiled = routes(text);
    const rows = compiled.hop2OrderedProjection?.(g, {}) ?? [];

    expect(compiled.hop2OrderedProjection).not.toBeNull();
    expect(rows).toStrictEqual(query(g, text, {}));
    // Pin the direction itself, or an ascending mutant would pass the comparison above.
    expect(rows.map((r) => (r as { k: number }).k)).toStrictEqual([2, 1, 1]);
  });

  it('serves ORDER BY with a LIMIT, where the order decides WHICH rows survive', () => {
    const text = `${C2} RETURN z.k AS k ORDER BY k LIMIT 2`;
    const compiled = routes(text);

    expect(compiled.hop2OrderedProjection).not.toBeNull();
    expect(compiled.hop2OrderedProjection?.(g, {})).toStrictEqual(query(g, text, {}));
  });

  it('DECLINES a projection with no ORDER BY', () => {
    expect(routes(`${C2} RETURN z.k AS k`).hop2OrderedProjection).toBeNull();
  });

  it('DECLINES a SKIP with no ORDER BY, which the paged arm takes', () => {
    const compiled = routes(`${C2} RETURN z.k AS k SKIP 1`);

    expect(compiled.hop2OrderedProjection).toBeNull();
    expect(compiled.hop2PagedProjection).not.toBeNull();
  });
});

describe('detectHop2PagedProjection — SKIP alone, not SKIP plus LIMIT', () => {
  it('serves a SKIP with no LIMIT', () => {
    const text = `${C2} RETURN z.k AS k SKIP 1`;
    const compiled = routes(text);

    expect(compiled.hop2PagedProjection).not.toBeNull();
    // Unordered, so the surviving rows are a multiset question, not a positional one.
    expect(bag(compiled.hop2PagedProjection?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
    expect(compiled.hop2PagedProjection?.(g, {})).toHaveLength(2);
  });

  it('DECLINES a LIMIT with no SKIP', () => {
    // `limitBound` alone short-circuits through `take` without projecting the tail, so there is
    // nothing for this arm to save.
    const text = `${C2} RETURN z.k AS k LIMIT 2`;
    const compiled = routes(text);

    expect(compiled.hop2PagedProjection).toBeNull();
    expect(query(g, text, {})).toHaveLength(2);
  });

  it('DECLINES SKIP *and* LIMIT together — the pair is NOT this shape', () => {
    /*
     * The assertion most likely to be written backwards from the detector's name. Item 1905 states
     * the rule from the other direction: "a `SKIP` with no `LIMIT` reaches the deferred arm".
     */
    const text = `${C2} RETURN z.k AS k SKIP 1 LIMIT 2`;
    const compiled = routes(text);

    expect(compiled.hop2PagedProjection).toBeNull();
    expect(compiled.hop2OrderedProjection).toBeNull();
    expect(compiled.hop2Projection).toBeNull();
    expect(query(g, text, {})).toHaveLength(2);
  });

  it('DECLINES a projection with no window at all', () => {
    const compiled = routes(`${C2} RETURN z.k AS k`);

    expect(compiled.hop2PagedProjection).toBeNull();
    expect(compiled.hop2Projection).not.toBeNull();
  });
});
