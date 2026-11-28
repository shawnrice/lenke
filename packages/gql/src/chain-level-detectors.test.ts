import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2467: the four reachable `detectChain*` detectors from item 2460's map —
 * `detectChainStarCount`, `detectChainFoldLevels`, `detectChainDistinctLevels` and
 * `detectChainOrderedProjection`. None was named in any test.
 *
 * THE FIELD MAP WAS PROBED BEFORE A LINE OF THIS WAS WRITTEN, and it is not what the names suggest.
 * At DEPTH 2 the `hop2*` detectors take the grouped and ordered shapes, so three of the chain
 * detectors never light there; depth 3 is where they appear. And `detectChainGroupedLevels` is a
 * DIFFERENT detector from `detectChainGroupedCount`, which is what a depth-3 grouped count actually
 * reaches — so a test written from the name alone would have asserted the wrong field.
 *
 * ```text
 *    one hop      sum -> chainFoldLevels      DISTINCT -> chainDistinctLevels + distinctProjection
 *                 count(*) -> countShortcut ONLY       ORDER BY -> hopProjection
 *    depth 2      count(*) -> countShortcut + chainStarCount    sum -> chainFoldLevels + hop2FoldedAggregate
 *                 grouped  -> hop2GroupedCount          ORDER BY -> hop2OrderedProjection
 *    depth 3      count(*) -> countShortcut + chainStarCount    sum -> chainFoldLevels + chainFoldedAggregate
 *                 grouped  -> chainGroupedCount         ORDER BY -> chainOrderedProjection
 * ```
 *
 * THE ONE-HOP CONTRAST IS THE SHARPEST THING HERE AND IT IS DOCUMENTED IN THE SOURCE. Fold and
 * distinct admit a single hop deliberately — "ONE HOP IS ADMITTED HERE AND NOWHERE ELSE (item
 * 2420)… at one hop the recurrence degenerates to `u_1(v) = in-degree(v)`", and item 2423 for the
 * distinct twin — while `detectChainStarCount` requires "TWO SEGMENTS MINIMUM". Four detectors over
 * the same clause shape, two admitting one hop and two refusing it.
 *
 * A route choice is answer-equivalent, so none of this is visible to the differential, fuzz or
 * conformance suites (`perf-gate-needs-its-own-test`). Each admission calls the returned function
 * and compares ROWS against the engine (`gate-returning-a-value`), as a MULTISET where the order is
 * a walk's rather than an `ORDER BY`'s (`order-is-unspecified`).
 */

/** A 5-vertex chain a->b->c->d->e with alternating `k`. */
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

  return g;
};

const g = build();

/*
 * A SECOND GRAPH WHOSE `:P` LABEL IS NOT VACUOUS, and it is required rather than decorative.
 *
 * `detectChainStarCount` returns `Row[] | undefined` — admitted at compile time, able to decline at
 * RUN time — and on the all-`P` graph above it declines at EVERY depth it admits (2, 3 and 4),
 * because the label test is vacuous there and only the graph can say so. Add one off-label vertex
 * and the same compiled function returns rows. So a label-homogeneous fixture can reach the
 * detector's `null` and `undefined` states but NEVER its rows, which is the half a test most needs.
 *
 * Note the polarity: [[label-vacuity-gates-fast-paths]] records GQL fast paths NEEDING a vacuous
 * label, and this one is the other way round.
 */
const gMixed = (() => {
  const mixed = build();

  mixed.addVertex({ id: 'off', labels: ['Q'], properties: { k: 9 } });

  return mixed;
})();

type Linear = Parameters<typeof compileLinear>[0];

const routes = (text: string) => {
  const parsed = parse(text) as { parts?: readonly unknown[] };

  return compileLinear((parsed.parts === undefined ? parsed : parsed.parts[0]) as Linear);
};

const bag = (rows: readonly unknown[]) => [...rows].map((r) => JSON.stringify(r)).sort();

const H1 = 'MATCH (a:P)-[:E]->(z:P)';
const C2 = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(z:P)';
const C3 = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(z:P)';

describe('detectChainStarCount — two segments minimum', () => {
  it('serves depth 2 and depth 3 over a graph whose label is not vacuous', () => {
    for (const text of [`${C2} RETURN count(*) AS n`, `${C3} RETURN count(*) AS n`]) {
      const compiled = routes(text);

      expect(compiled.chainStarCount).not.toBeNull();
      expect(compiled.chainStarCount?.(gMixed, {})).toStrictEqual(query(gMixed, text, {}));
    }
  });

  it('is ADMITTED but declines at RUN TIME when the label is VACUOUS — all three states', () => {
    /*
     * The only fixture in this survey to reach the third state. `null` is never-admitted (one hop,
     * below); `undefined` is admitted-then-declined, here; rows are the test above. A test that
     * only ever saw `null` and rows would pass with the run-time check deleted.
     */
    for (const hops of [C2, C3]) {
      const text = `${hops} RETURN count(*) AS n`;
      const compiled = routes(text);

      expect(compiled.chainStarCount).not.toBeNull();
      expect(compiled.chainStarCount?.(g, {})).toBeUndefined();
      // The general path still answers, which is what `undefined` asks for.
      expect(query(g, text, {})).toHaveLength(1);
    }
  });

  it('DECLINES ONE hop, which the source states as "TWO SEGMENTS MINIMUM"', () => {
    // The contrast with the fold and distinct detectors below is the point: same clause shape, and
    // two of the four admit it.
    const text = `${H1} RETURN count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.chainStarCount).toBeNull();
    expect(compiled.countShortcut).not.toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ n: 4 }]);
  });

  /*
   * THE PROJECTION-SHAPE AXIS. The first cut of this file covered DEPTH thoroughly and projection
   * shape not at all, and five of six mutants survived as a result (item 2467) — the depth
   * assertions were doing all the work. Each fixture below was chosen for the guard it reaches.
   */
  it('DECLINES a GROUPED count, reaching the `groupKeys` guard', () => {
    const text = `${C3} RETURN z.k AS k, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.chainStarCount).toBeNull();
    // A different detector owns the grouped shape — note it is `chainGroupedCount`, NOT
    // `chainGroupedLevels`, which is a separate detector entirely.
    expect(compiled.chainGroupedCount).not.toBeNull();
    expect(query(gMixed, text, {})).toHaveLength(2);
  });

  it('DECLINES a count under a WINDOW, reaching the skip/limit/orderBy guard', () => {
    for (const suffix of ['LIMIT 1', 'SKIP 1', 'ORDER BY n']) {
      expect(routes(`${C3} RETURN count(*) AS n ${suffix}`).chainStarCount).toBeNull();
    }
  });

  it('DECLINES `RETURN DISTINCT count(*)`, reaching the star/distinct guard', () => {
    expect(routes(`${C3} RETURN DISTINCT count(*) AS n`).chainStarCount).toBeNull();
  });

  it('DECLINES a non-count projection at depth 3', () => {
    expect(routes(`${C3} RETURN z.k AS k`).chainStarCount).toBeNull();
  });
});

describe('detectChainFoldLevels — one hop IS admitted (item 2420)', () => {
  it('serves a ONE-HOP fold, where the recurrence degenerates to in-degree', () => {
    const text = `${H1} RETURN sum(z.k) AS s`;
    const compiled = routes(text);

    expect(compiled.chainFoldLevels).not.toBeNull();
    expect(compiled.chainFoldLevels?.(g, {})).toStrictEqual(query(g, text, {}));
  });

  it('serves depth 2 and depth 3 folds too', () => {
    for (const text of [`${C2} RETURN sum(z.k) AS s`, `${C3} RETURN sum(z.k) AS s`]) {
      const compiled = routes(text);

      expect(compiled.chainFoldLevels).not.toBeNull();
      expect(compiled.chainFoldLevels?.(g, {})).toStrictEqual(query(g, text, {}));
    }
  });

  it('DECLINES a bare count, which the star-count arm serves instead', () => {
    const compiled = routes(`${C3} RETURN count(*) AS n`);

    expect(compiled.chainFoldLevels).toBeNull();
    expect(compiled.chainStarCount).not.toBeNull();
  });

  it('DECLINES a DISTINCT aggregate other than count, which its own guard refuses', () => {
    // `if (distinct && name !== 'count')` — a `sum(DISTINCT …)` is not the weighted fold's shape.
    const text = `${C3} RETURN sum(DISTINCT z.k) AS s`;

    expect(routes(text).chainFoldLevels).toBeNull();
    expect(query(gMixed, text, {})).toHaveLength(1);
  });

  /*
   * THE FAR-READ GUARD IS LOAD-BEARING, and these three fixtures are the proof (item 2467). Its
   * mutant survived the first battery; applying it alone and sweeping candidates showed exactly
   * these three shapes flipping from declined to ADMITTED, while nothing else moved. The level
   * recurrence folds a weight per FAR vertex, so an aggregate that reads anything else — the near
   * variable, both, or neither — has no per-level weight to fold.
   */
  it('DECLINES an aggregate over the NEAR variable', () => {
    const text = `${C3} RETURN sum(a.k) AS s`;

    expect(routes(text).chainFoldLevels).toBeNull();
    expect(query(gMixed, text, {})).toHaveLength(1);
  });

  it('DECLINES an aggregate over a MIXED expression reading both ends', () => {
    const text = `${C3} RETURN sum(z.k + a.k) AS s`;

    expect(routes(text).chainFoldLevels).toBeNull();
    expect(query(gMixed, text, {})).toHaveLength(1);
  });

  it('DECLINES an aggregate over a CONSTANT, which reads no variable at all', () => {
    const text = `${C3} RETURN sum(1) AS s`;

    expect(routes(text).chainFoldLevels).toBeNull();
    expect(query(gMixed, text, {})).toHaveLength(1);
  });

  it('ADMITS count(DISTINCT far) but not sum/avg(DISTINCT), which its own guard splits', () => {
    // `if (distinct && name !== 'count')` — so the DISTINCT form is served for `count` alone.
    expect(routes(`${C3} RETURN count(DISTINCT z.k) AS n`).chainFoldLevels).not.toBeNull();
    expect(routes(`${C3} RETURN sum(DISTINCT z.k) AS s`).chainFoldLevels).toBeNull();
    expect(routes(`${C3} RETURN avg(DISTINCT z.k) AS s`).chainFoldLevels).toBeNull();
  });

  it('DECLINES a plain projection with no aggregate', () => {
    expect(routes(`${C3} RETURN z.k AS k`).chainFoldLevels).toBeNull();
  });
});

describe('detectChainDistinctLevels — one hop IS admitted (item 2423)', () => {
  it('serves a ONE-HOP DISTINCT, alongside `distinctProjection`', () => {
    const text = `${H1} RETURN DISTINCT z.k AS k`;
    const compiled = routes(text);

    expect(compiled.chainDistinctLevels).not.toBeNull();
    // Both arms admit; precedence lives in `runLinear`, not in the route table.
    expect(compiled.distinctProjection).not.toBeNull();
    expect(bag(compiled.chainDistinctLevels?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
  });

  it('serves depth 3 DISTINCT', () => {
    const text = `${C3} RETURN DISTINCT z.k AS k`;
    const compiled = routes(text);

    expect(compiled.chainDistinctLevels).not.toBeNull();
    expect(bag(compiled.chainDistinctLevels?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
  });

  it('DECLINES the same projection without DISTINCT', () => {
    expect(routes(`${C3} RETURN z.k AS k`).chainDistinctLevels).toBeNull();
  });
});

describe('detectChainOrderedProjection — depth 3, not depth 2', () => {
  it('serves an ORDER BY at depth 3, and its ROWS are the engine answer IN ORDER', () => {
    // An explicit ORDER BY IS a contract, so this one is compared positionally.
    const text = `${C3} RETURN z.k AS k ORDER BY k`;
    const compiled = routes(text);

    expect(compiled.chainOrderedProjection).not.toBeNull();
    expect(compiled.chainOrderedProjection?.(g, {})).toStrictEqual(query(g, text, {}));
  });

  it('DECLINES at depth 2, where the hop2 sibling takes it', () => {
    const compiled = routes(`${C2} RETURN z.k AS k ORDER BY k`);

    expect(compiled.chainOrderedProjection).toBeNull();
    expect(compiled.hop2OrderedProjection).not.toBeNull();
  });

  it('DECLINES at one hop, where the plain hop projection takes it', () => {
    const compiled = routes(`${H1} RETURN z.k AS k ORDER BY k`);

    expect(compiled.chainOrderedProjection).toBeNull();
    expect(compiled.hopProjection).not.toBeNull();
  });

  it('DECLINES a depth-3 projection with no ORDER BY', () => {
    const compiled = routes(`${C3} RETURN z.k AS k`);

    expect(compiled.chainOrderedProjection).toBeNull();
    expect(compiled.chainProjection).not.toBeNull();
  });
});
