import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2471: the last three detectors on item 2460's map — `detectChainGroupedLevels`,
 * `detectChainPagedProjection` and `detectShortestEndpointCount`.
 *
 * **ITEMS 2467 AND 2469 REPORTED THE FIRST TWO AS "NO PROBED SHAPE REACHES EITHER", AND THAT WAS
 * WRONG.** Both are reachable; my probe shapes were. The correction came from READING THE GUARD
 * CHAINS instead of guessing shapes — the rule items 2467 and 2470 each paid for — and it took one
 * run:
 *
 * ```text
 *    detector                    what its guard actually requires
 *      chainGroupedLevels          the group key is a PROPERTY OF THE CHAIN'S START variable
 *                                  (`keySource.variable !== chain.pattern.start.variable` -> null).
 *                                  I had grouped on the FAR variable, which only `chainGroupedCount`
 *                                  takes.
 *      chainPagedProjection        a SKIP with NO LIMIT. I had used `SKIP 1 LIMIT 2`, which declines
 *                                  — the same inversion item 2469 found in its hop2 twin.
 *      shortestEndpointCount       `ANY SHORTEST` plus a BOUNDED quantifier. An unbounded `->*` is
 *                                  refused, because `max === null` fails the min/max test.
 * ```
 *
 * So "nothing reaches it" is a claim about the prober, not the code, until the guard says otherwise.
 * Had that stood, two live detectors would have been on record as candidate dead code.
 *
 * Route choices are answer-equivalent, so none of this is visible to the differential, fuzz or
 * conformance suites (`perf-gate-needs-its-own-test`). Each admission calls the returned function and
 * compares ROWS against the engine (`gate-returning-a-value`), as a multiset where the order is a
 * walk's (`order-is-unspecified`).
 */

/** a->b->c->d->e with alternating `k`, plus an off-label vertex so `:P` is not vacuous (2467). */
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

const C3 = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(z:P)';

describe('detectChainGroupedLevels — keyed on the chain START, not the far end', () => {
  it('serves a group key that is a property of the START variable', () => {
    const text = `${C3} RETURN a.k AS ak, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.chainGroupedLevels).not.toBeNull();
    expect(bag(compiled.chainGroupedLevels?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
  });

  it('serves the LET spelling of the same key', () => {
    // The guard resolves a `LET` name back to its expression before testing the variable, so both
    // spellings must reach the same arm — a spelling asymmetry here would be exactly the class of
    // bug this repo exists to not have.
    const text = `${C3} LET ak = a.k RETURN ak, count(*) AS n`;
    const compiled = routes(text);

    expect(compiled.chainGroupedLevels).not.toBeNull();
    expect(bag(compiled.chainGroupedLevels?.(g, {}) ?? [])).toStrictEqual(bag(query(g, text, {})));
  });

  it('DECLINES a key on the FAR variable, which a different detector takes', () => {
    const compiled = routes(`${C3} RETURN z.k AS k, count(*) AS n`);

    expect(compiled.chainGroupedLevels).toBeNull();
    expect(compiled.chainGroupedCount).not.toBeNull();
  });

  it('DECLINES an ungrouped count', () => {
    expect(routes(`${C3} RETURN count(*) AS n`).chainGroupedLevels).toBeNull();
  });
});

describe('detectChainPagedProjection — SKIP alone, as in its hop2 twin', () => {
  it('serves a SKIP with no LIMIT', () => {
    const text = `${C3} RETURN z.k AS k SKIP 1`;
    const compiled = routes(text);

    expect(compiled.chainPagedProjection).not.toBeNull();
    expect(bag(compiled.chainPagedProjection?.(g, {}) ?? [])).toStrictEqual(
      bag(query(g, text, {})),
    );
  });

  it('DECLINES SKIP + LIMIT, and LIMIT alone', () => {
    // The shape I wrongly probed at item 2467 and concluded nothing reached this detector.
    expect(routes(`${C3} RETURN z.k AS k SKIP 1 LIMIT 2`).chainPagedProjection).toBeNull();
    expect(routes(`${C3} RETURN z.k AS k LIMIT 2`).chainPagedProjection).toBeNull();
  });

  it('DECLINES a projection with no window', () => {
    const compiled = routes(`${C3} RETURN z.k AS k`);

    expect(compiled.chainPagedProjection).toBeNull();
    expect(compiled.chainProjection).not.toBeNull();
  });
});

describe('detectShortestEndpointCount — ANY SHORTEST with a BOUNDED quantifier', () => {
  const SHORTEST = 'MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(z:P) RETURN count(*) AS n';

  it('serves a bounded ANY SHORTEST count, at two different bounds', () => {
    for (const text of [
      SHORTEST,
      'MATCH ANY SHORTEST (a:P)-[:E]->{1,2}(z:P) RETURN count(*) AS n',
    ]) {
      const compiled = routes(text);

      expect(compiled.shortestEndpointCount).not.toBeNull();
      // Returns `Row[] | undefined`: the rows here, since `:P` is not vacuous on this fixture.
      expect(compiled.shortestEndpointCount?.(g, {})).toStrictEqual(query(g, text, {}));
    }
  });

  it('DECLINES an UNBOUNDED quantifier', () => {
    /*
     * `->*` parses to `{min: 0, max: null}`, and the min/max test refuses a null max. The source
     * notes that `max === null` is itself redundant with `max < min` by coercion — "mutation says
     * so" — which is the same conditional-redundancy verdict item 2461 derived independently for
     * `trailMinAdmissible`. Two places in this engine, found two different ways.
     */
    const text = 'MATCH ANY SHORTEST (a:P)-[:E]->*(z:P) RETURN count(*) AS n';

    expect(routes(text).shortestEndpointCount).toBeNull();
    expect(query(g, text, {})).toHaveLength(1);
  });

  it('DECLINES without the ANY SHORTEST selector', () => {
    const text = 'MATCH (a:P)-[:E]->{1,3}(z:P) RETURN count(*) AS n';

    expect(routes(text).shortestEndpointCount).toBeNull();
    // The plain var-length count answers the same query, and does so by a different route.
    expect(compiledVarLength(text)).not.toBeNull();
  });

  it('DECLINES a window on the count', () => {
    for (const suffix of ['ORDER BY n', 'LIMIT 1', 'SKIP 1']) {
      expect(routes(`${SHORTEST} ${suffix}`).shortestEndpointCount).toBeNull();
    }
  });

  it('DECLINES `RETURN DISTINCT count(*)` — distinct on the PROJECTION, not in the aggregate', () => {
    /*
     * A FIXTURE GAP THE FLIP SWEEP CAUGHT (item 2471). My first version asserted
     * `count(DISTINCT z)`, which declines for a DIFFERENT reason — `countStarColumn` refuses it,
     * because it is not a `count(*)` at all. The `projection.distinct` guard is about `RETURN
     * DISTINCT`, and only this shape reaches it: dropping that condition admits exactly this query
     * and nothing else in a nine-shape sweep.
     */
    expect(
      routes('MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(z:P) RETURN DISTINCT count(*) AS n')
        .shortestEndpointCount,
    ).toBeNull();
  });

  it('DECLINES count(DISTINCT z) too, but via the count-column guard rather than DISTINCT', () => {
    expect(
      routes('MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(z:P) RETURN count(DISTINCT z) AS n')
        .shortestEndpointCount,
    ).toBeNull();
  });

  it('a MULTI-SEGMENT ANY SHORTEST is a SYNTAX ERROR, so one guard is unreachable by construction', () => {
    /*
     * `shapeOf` refuses `pattern.segments.length !== 1`, and dropping that condition flips NOTHING
     * — because the PARSER rejects a multi-segment `ANY SHORTEST` outright. That is the strongest
     * form of "unreachable for the real input set" (item 2463's verdict class): not merely
     * unreached by current callers, but unreachable by any query that parses.
     *
     * Asserted here so the fact lives in a test rather than only in a mutation log — if the grammar
     * ever admits the shape, this fails and the guard becomes live.
     */
    for (const text of [
      'MATCH ANY SHORTEST (a:P)-[:E]->{1,2}(b:P)-[:E]->(z:P) RETURN count(*) AS n',
      'MATCH ANY SHORTEST (a:P)-[:E]->(b:P)-[:E]->(z:P) RETURN count(*) AS n',
    ]) {
      expect(() => routes(text)).toThrow();
    }
  });

  it('ADMITS a path variable, which the `pattern.pathVar` guard looks written to refuse', () => {
    /*
     * OPEN QUESTION, recorded rather than claimed (item 2471). `shapeOf` tests
     * `pattern.pathVar !== undefined` and returns undefined for it, yet
     * `MATCH p = ANY SHORTEST …` IS admitted. The likeliest explanation is that the parser binds
     * `p =` somewhere other than `pattern.pathVar`, which would make that condition dead for the
     * same reason as the one above — but I have not confirmed where the binding lands, so this
     * pins the OBSERVED behaviour only.
     */
    const text = 'MATCH p = ANY SHORTEST (a:P)-[:E]->{1,3}(z:P) RETURN count(*) AS n';

    expect(routes(text).shortestEndpointCount).not.toBeNull();
    expect(query(g, text, {})).toHaveLength(1);
  });
});

const compiledVarLength = (text: string) => routes(text).varLengthCount;
