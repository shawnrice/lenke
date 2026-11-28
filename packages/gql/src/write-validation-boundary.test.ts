import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/*
 * Item 2514: THE GQL WRITE SURFACE STAYS BEHIND THE CORE VALIDATION BOUNDARY.
 *
 * `validate.ts` has three validators — `validateLabel` (non-empty, no `::`), `validatePropertyKey`
 * (non-empty) and `validatePropertyValue` (no bigint, recursing into list elements) — and their own
 * comments say they are "enforced at the graph's mutation boundary so a name that won't round-trip
 * can't enter the model".
 *
 * ## WHY THIS FILE EXISTS, GIVEN THAT CORE ALREADY TESTS THE VALIDATORS
 *
 * A mutation run (item 2514) made each validator a no-op in turn:
 *
 *     validateLabel          -> core CAUGHT 2,  gql CAUGHT 2 (these rows),  gremlin/native survived
 *     validatePropertyKey    -> core CAUGHT 2,  gql CAUGHT 2 (these rows),  gremlin/native survived
 *     validatePropertyValue  -> core CAUGHT 1,  gql survived — see the param note below
 *
 * ⚠️ THE FIRST RUN OF THAT TABLE WAS MEANINGLESS FOR THREE OF THE FOUR COLUMNS and said
 * "gremlin/gql/native survived" for every mutant. `packages/gql` resolves `@lenke/core` to the
 * BUILT DIST, so mutating `core/src` reached only `core`'s own tests until `bun run build` ran
 * between the mutant and the suites. The numbers above are from the rebuilt run.
 *
 * So the validators themselves ARE covered — by `packages/core` alone. **What no test covered is the
 * WIRING: that a write arriving through a query surface actually reaches them.** Those are different
 * claims, and only the second one is at risk from the thing this engine does constantly — adding a
 * write FAST PATH. `clauses.ts` holds the general write path (`addVertex` x3, `addEdge` x3,
 * `setProperty` x5) and `shortcuts.ts` ALREADY has its own `setProperty` call site; a future rung that
 * constructed an element directly, or assigned into `properties`, would leave every core test green.
 *
 * Per this repo's rule that a guard with no test is not automatically a gap (item 2513): here the
 * neighbouring coverage does NOT subsume it. Core proves the validator throws; nothing proved the
 * surface calls it.
 *
 * ⚠️ HONEST LIMIT OF THE DEMONSTRATION: a `validate.ts` no-op mutant makes these rows fail, which
 * shows they are live but NOT that they add anything over core's. Their distinct value is against a
 * surface bypass, which no mutation of `validate.ts` can simulate — that claim is reasoned from the
 * call-site layout above, not measured.
 */
const seeded = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });

  return g;
};

describe('the GQL write surface reaches the core validation boundary', () => {
  test('INSERT rejects an empty LABEL', () => {
    expect(() => query(new Graph(), 'INSERT (:``)')).toThrow('must be non-empty');
  });

  test('INSERT rejects an empty property KEY', () => {
    expect(() => query(new Graph(), 'INSERT (:P {`` : 1})')).toThrow(
      'property key must be non-empty',
    );
  });

  test('SET rejects an empty property KEY', () => {
    expect(() => query(seeded(), 'MATCH (n:P) SET n.`` = 1')).toThrow(
      'property key must be non-empty',
    );
  });

  test('INSERT rejects an empty EDGE type', () => {
    const g = seeded();

    g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    expect(() =>
      query(g, 'MATCH (x:P), (y:P) WHERE x.k = 1 AND y.k IS NULL INSERT (x)-[:``]->(y)'),
    ).toThrow('must be non-empty');
  });

  /*
   * ⚠️ THESE TWO ROWS TEST THE **PARAM** BOUNDARY, NOT `validatePropertyValue` — and the mutation
   * run is what established that. With `validatePropertyValue` made a no-op, `core` catches it but
   * `gql` does NOT, including these rows: they still throw, because the PARAM boundary rejects a
   * bigint before any write is attempted. The validator's own comment says exactly this — "the
   * param + FFI boundaries already reject bigint with the same code; this closes the pure-JS
   * in-process store, the one path that stored it raw".
   *
   * So `validatePropertyValue` is UNREACHABLE from the GQL write surface, `packages/core` is the
   * only place it can be tested, and it already is. These rows are kept because the param
   * boundary is itself a contract worth pinning (`numeric-model-f64`: float64, so a bigint is
   * refused rather than silently downgraded) — they are simply named for what they actually cover.
   */
  test('SET rejects a BIGINT param value — at the PARAM boundary', () => {
    expect(() => query(seeded(), 'MATCH (n:P) SET n.big = $v', { v: 10n })).toThrow();
  });

  test('a bigint hidden inside a LIST param is rejected too — also the PARAM boundary', () => {
    expect(() => query(seeded(), 'MATCH (n:P) SET n.big = $v', { v: [1, 2n] })).toThrow();
  });

  /* A valid write of each shape, so the rows above are refusing the INVALID case and not everything. */
  test('the valid forms still write — the controls for the six refusals', () => {
    const g = seeded();

    expect(query(g, "INSERT (:Q {ok: 'yes'})")).toEqual([]);
    expect(query(g, 'MATCH (n:P) SET n.ok = 1')).toEqual([]);
    expect(query(g, 'MATCH (n:Q) RETURN n.ok AS v')).toEqual([{ v: 'yes' }]);
    expect(query(g, 'MATCH (n:P) RETURN n.ok AS v')).toEqual([{ v: 1 }]);
  });
});
