/**
 * WHICH fast-path detector fires for which query shape — a ROUTE assertion per detector.
 *
 * `compileLinear` ends by running nineteen independent compile-time probes, and its own comment is
 * explicit that this is not a ladder: *"EVERY detector RUNS … nineteen independent compile-time
 * probes."* Each one, when it fires, hands the executor a closure that answers a recognised shape
 * directly instead of running the general pipeline.
 *
 * THESE ROUTES ARE ANSWER-EQUIVALENT, WHICH IS WHY THEY NEED THEIR OWN TEST. A query whose shortcut
 * stops firing returns exactly the same rows, by the general pipeline, more slowly — so a
 * correctness test over its answer passes either way. `count-shortcut.test.ts` and its siblings
 * check the shortcut's ANSWER against an independent enumeration, which is exactly that shape.
 *
 * HOW MUCH THE PRE-EXISTING SUITE ACTUALLY CAUGHT, measured rather than asserted — each detector
 * disabled in turn and the gql suite run WITHOUT this file:
 *
 *     detectCountShortcut never fires   -> CAUGHT, 4 failures
 *     detectNodeProjection never fires  -> SURVIVED
 *
 * So the coverage was PARTIAL and incidental, not absent: two tests ("a both-ends-constrained count
 * seeds its tally", "the sweep is BOUNDED in the path count") happen to assert something only the
 * count shortcut produces, while a dead `detectNodeProjection` was invisible to all 2,723 tests.
 * Which detectors had incidental cover and which had none was not knowable before this file, and
 * that unevenness is the real hazard: a refactor that disables three detectors might fail loudly for
 * one and silently for the other two.
 *
 * Item 910 priced the detectors at **25% of planning the big query** and named "a route assertion
 * per detector" as the prerequisite for sharing work between them — because the failure mode of that
 * refactor is precisely a shape summary that silently stops a shortcut firing. This file is that
 * prerequisite.
 *
 * The NEGATIVE cases matter as much: a detector that starts firing on a shape it does not actually
 * handle would answer that shape with the wrong closure, which is a wrong ANSWER rather than a slow
 * one.
 *
 * Expectations are the routes the engine chooses today, read off `compileLinear` directly. They are
 * descriptive, not aspirational — if a future change deliberately re-routes a shape, update the row
 * and say why in the audit.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/** The detector fields that came back non-null, sorted — i.e. the routes this query will take. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([k, v]) => k !== 'clauses' && v !== null && v !== undefined)
    .map(([k]) => k)
    .sort();
};

describe('every fast-path detector fires for its own shape', () => {
  const CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    // --- counts -------------------------------------------------------------------------
    ['node count', 'MATCH (n:L) RETURN count(*) AS c', ['countShortcut']],
    ['hop count', 'MATCH (a:L)-[:R]->(b:L) RETURN count(*) AS c', ['countShortcut']],
    [
      'two-hop count',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(*) AS c',
      ['countShortcut'],
    ],
    [
      'bounded var-length count',
      'MATCH (a:L)-[:R]->{1,3}(b) RETURN count(*) AS c',
      ['varLengthCount'],
    ],

    // --- grouped ------------------------------------------------------------------------
    [
      'grouped node count',
      'MATCH (n:L) RETURN n.k AS k, count(*) AS c',
      ['groupCountShortcut', 'groupedNodeAggregate'],
    ],
    [
      'grouped hop count on the FAR key',
      'MATCH (a:L)-[:R]->(b:L) RETURN b.k AS k, count(*) AS c',
      ['groupHopShortcut', 'groupedHopAggregate'],
    ],
    [
      'grouped hop count on the NEAR key',
      'MATCH (a:L)-[:R]->(b:L) RETURN a.k AS k, count(*) AS c',
      ['groupedHopAggregate'],
    ],

    // --- projections --------------------------------------------------------------------
    ['node projection', 'MATCH (n:L) RETURN n.k AS k', ['nodeProjection']],
    ['node projection, the element itself', 'MATCH (n:L) RETURN n', ['nodeProjection']],
    ['hop projection', 'MATCH (a:L)-[:R]->(b:L) RETURN b.k AS k', ['hopProjection']],
    ['distinct projection', 'MATCH (n:L) RETURN DISTINCT n.k AS k', ['distinctProjection']],

    // --- aggregates ---------------------------------------------------------------------
    ['node aggregate', 'MATCH (n:L) RETURN max(n.k) AS m', ['nodeAggregate']],
    // ITEM 1197: a WRAPPED aggregate is claimed by the same detector. Before it, every one of
    // these fell to the general path — which materializes a group of bindings — at 6.5-10.2x the
    // bare spelling. These rows are the only thing that holds that, since the route is
    // answer-equivalent: `node-aggregate.test.ts` asserts the answers and would pass either way.
    [
      'WRAPPED aggregate (size over collect)',
      'MATCH (n:L) RETURN size(collect(n.k)) AS c',
      ['nodeAggregate'],
    ],
    [
      'WRAPPED aggregate (coalesce)',
      'MATCH (n:L) RETURN coalesce(collect(n.k), 1) AS c',
      ['nodeAggregate'],
    ],
    [
      'WRAPPED aggregate over a LITERAL',
      'MATCH (n:L) RETURN size(collect(1)) AS c',
      ['nodeAggregate'],
    ],
    // THE NEGATIVE CASES, which matter as much (see this file's header). Two aggregates must still
    // decline — the route carries ONE accumulator — and the FOLD path still requires the aggregate
    // to BE the item, so `abs(min(n.k) - 10)` is unchanged. That second row is this file's record
    // that the fold-path sibling was left deliberately: it is the same lever on `min`/`max`/`count`
    // and is priced on its own rather than assumed to be worth the same.
    [
      'a wrapped aggregate plus a SECOND aggregate declines',
      'MATCH (n:L) RETURN size(collect(n.k)) + count(*) AS c',
      [],
    ],
    ['a wrapped FOLD aggregate still declines', 'MATCH (n:L) RETURN abs(min(n.k) - 10) AS c', []],
    ['hop aggregate', 'MATCH (a:L)-[:R]->(b:L) RETURN max(b.k) AS m', ['hopAggregate']],
    [
      'MULTI node aggregate (two items)',
      'MATCH (n:L) RETURN max(n.k) AS a, min(n.k) AS b',
      ['multiNodeAggregate'],
    ],
    [
      'MULTI hop aggregate (two items)',
      'MATCH (a:L)-[:R]->(b:L) RETURN max(b.k) AS a, min(b.k) AS b',
      ['multiHopAggregate'],
    ],
    // TWO routes since item 1049, and that is this test earning itself. Giving `foldFor` a DISTINCT
    // arm made `foldedAggs` non-empty for `count(DISTINCT …)`, which opened `detectNodeAggregate`
    // as well — item 778's hazard exactly ("opening one gate can disqualify another rung, and
    // nothing about the gate being opened reveals it"), and nothing but this table would have said
    // so. The ROUTE TAKEN is unchanged: `clauses.ts` consults `distinctCount` at 1458 and
    // `nodeAggregate` only at 1474, so the second one compiles and never runs. Measured as a
    // control in `rel-lift-probe.ts` (`node-distinct`) rather than assumed free.
    [
      'distinct count',
      'MATCH (n:L) RETURN count(DISTINCT n.k) AS c',
      ['distinctCount', 'nodeAggregate'],
    ],

    // --- optional hops ------------------------------------------------------------------
    [
      'optional hop count',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN count(*) AS c',
      ['optionalHopCount'],
    ],
    [
      'optional hop projection',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN b.k AS k',
      ['optionalHopProjection'],
    ],

    // --- reachability and FOR -----------------------------------------------------------
    [
      'reachability (unbounded + DISTINCT)',
      'MATCH (a:L)-[:R]->*(b:L) RETURN DISTINCT b.k AS k',
      ['reachShortcut'],
    ],
    [
      'FOR count over a property list',
      'MATCH (n:L) FOR x IN n.tags RETURN count(*) AS c',
      ['forCount'],
    ],
    [
      'FOR projection over a property list',
      'MATCH (n:L) FOR x IN n.tags RETURN x AS v',
      ['forProjection'],
    ],
  ];

  for (const [name, src, want] of CASES) {
    it(`${name} → ${want.join(',')}`, () => {
      expect(routes(src)).toEqual([...want].sort());
    });
  }

  // Every one of the nineteen is covered by the table above. Asserted rather than claimed, so a
  // detector added later without a route case fails HERE instead of going unguarded.
  it('covers all nineteen detectors', () => {
    const covered = new Set(CASES.flatMap(([, , want]) => want));
    const all = new Set(
      Object.keys(
        compileLinear(
          (parse('MATCH (n:L) RETURN count(*) AS c') as never as { parts: readonly never[] })
            .parts[0],
        ) as unknown as Record<string, unknown>,
      ).filter((k) => k !== 'clauses'),
    );

    expect([...all].filter((k) => !covered.has(k)).sort()).toEqual([]);
    expect(all.size).toBe(19);
  });
});

describe('a shape with no shortcut takes NO fast path', () => {
  // A detector that starts firing on a shape it does not handle answers it with the wrong closure —
  // a wrong ANSWER, not a slow one. These pin the other direction.
  const NONE: ReadonlyArray<readonly [string, string]> = [
    ['a bare RETURN', 'RETURN 1 AS one'],
    ['a write', 'INSERT (:L {k: 1})'],
    ['an UNBOUNDED var-length count', 'MATCH (a:L)-[:R]->*(b) RETURN count(*) AS c'],
    ['a FOR over a literal list', 'FOR x IN [1, 2, 3] RETURN x AS v'],
    [
      'two separate MATCH clauses with an aggregate',
      'MATCH (a:L) MATCH (b:L) RETURN max(a.k) AS m',
    ],
  ];

  for (const [name, src] of NONE) {
    it(`${name} fires nothing`, () => {
      expect(routes(src)).toEqual([]);
    });
  }
});

/**
 * ITEM 935 — a NEGATIVE numeric literal must route exactly like its positive twin.
 *
 * `-1` parsed as a unary-minus EXPRESSION rather than a literal, and every predicate fast path
 * downstream requires a LITERAL operand — so `n.k > -1` quietly fell to the general evaluator
 * while `n.k >= 0`, the same predicate over a non-negative column, took the fast route. Measured
 * at **2.2x**: 44.13/43.12/41.63 ns a vertex against 20.04/18.44/19.00, three order-alternated
 * rounds, same survivors.
 *
 * The assertion is route EQUALITY against the twin rather than a hard-coded route name, because the
 * claim is "these two spellings cost the same", which is the claim this repo is named for — and it
 * stays true if the route set is renamed or extended later.
 */
describe('a negative numeric literal routes like its positive twin (item 935)', () => {
  const TWINS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a filtered node count',
      'MATCH (n:L) WHERE n.k > -1 RETURN count(*) AS c',
      'MATCH (n:L) WHERE n.k >= 0 RETURN count(*) AS c',
    ],
    [
      'an inline property constraint',
      'MATCH (n:L {k: -1}) RETURN count(*) AS c',
      'MATCH (n:L {k: 1}) RETURN count(*) AS c',
    ],
    [
      'a projection with a filter',
      'MATCH (n:L) WHERE n.k > -1 RETURN n.k AS k',
      'MATCH (n:L) WHERE n.k >= 0 RETURN n.k AS k',
    ],
    [
      'a far-end filter on a hop',
      'MATCH (a:L)-[:R]->(b) WHERE b.k > -1 RETURN count(*) AS c',
      'MATCH (a:L)-[:R]->(b) WHERE b.k >= 0 RETURN count(*) AS c',
    ],
  ];

  for (const [name, neg, pos] of TWINS) {
    it(`${name} routes identically`, () => {
      // Non-empty, or the assertion would hold vacuously for two shapes that both route nowhere.
      expect(routes(pos).length).toBeGreaterThan(0);
      expect(routes(neg)).toEqual(routes(pos));
    });
  }

  // THE GUARD'S BOUNDARY — values and faults, not routes, but kept here so the fold's whole
  // contract reads in one place. The fold is numeric LITERALS only; a mutant that drops the
  // `typeof` check folds `-'abc'` to `lit(NaN)`, which the numeric model then renders as `null`
  // instead of faulting. That mutant SURVIVED the whole 2,760-test suite before these three
  // existed. Each expectation is verified against the real native engine, which throws for the
  // string and the boolean and answers `null` for `null`.
  it('a negated NON-numeric literal still faults, and is not folded', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['L'], properties: { k: 1 } });

    expect(() => query(g, "MATCH (n:L) RETURN -'abc' AS m")).toThrow();
    expect(() => query(g, 'MATCH (n:L) RETURN -true AS m')).toThrow();
    // `null` is the one that must NOT fault: negating it is null in both engines.
    expect((query(g, 'MATCH (n:L) RETURN -null AS m')[0] as Record<string, unknown>).m).toBeNull();
  });
});
