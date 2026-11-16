// A cross-engine divergence found by the differential fuzzer at item 2022, PRE-EXISTING.
//
// ⚠️⚠️ **NATIVE RAISES WHERE THIS ENGINE RETURNS SIX ROWS**, and the divergence registry's one entry
// explicitly does NOT cover that:
//
//     "An error against a NON-EMPTY result is a different thing entirely … and is NOT covered here."
//
// Found by `fuzz-sweep.sh` on run 10 of 10 (the sweep exists to keep the failing run's output — item
// 2012). Replay: `FUZZ_SEED=3826437490 bun test src/differential-fuzz.test.ts`.
//
// ⚠️ IT IS NOT ITEM 2022's. Verified by replaying the same seed against `HEAD` with that item's
// change absent: it fails identically. The merge helper cannot affect predicate evaluation order.
//
// 🔑 **THE NUANCE THAT MAKES IT INTERESTING, and that the registry's matcher cannot see.** The inline
// predicate lives inside an `OPTIONAL MATCH`, and it matches NOTHING on either engine — so at the
// PATTERN level this is the registry's covered shape, "a malformed predicate against no rows". But
// `OPTIONAL MATCH` turns "no match" into a row with NULLs, so the OUTER result is six non-empty rows
// and the matcher, which only looks at final results, classifies it as the excluded shape.
//
// So the question this poses is a conformance one, not a bug fix: does the registry's "never rows"
// bound mean the pattern's rows or the statement's? Recorded here rather than decided, and pinned
// `failing` so it cannot be forgotten and cannot go green unnoticed.
import { expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/*
 * The fuzzer's fixture, reduced to the four properties the query reads. `m` is a MAP so `n.m.k`
 * resolves, and `k` is >= 3 on some rows so the second conjunct is not trivially false everywhere.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const [id, n, x, k] of [
    ['v1', 3, 1, 5],
    ['v2', 5, -1, 2],
    ['v3', 7, 0, 7],
  ] as const) {
    g.addVertex({ id, labels: ['T'], properties: { n, x, m: { k } } });
  }

  g.addEdge({
    id: 'e1',
    from: g.getVertexById('v1')!,
    to: g.getVertexById('v2')!,
    labels: ['E'],
    properties: {},
  });

  return g;
};

const Q =
  "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ((atan2(n.m.k, '1e3') >= n.x) AND " +
  '((n.m.k >= 3) AND (n.x < 0)))) RETURN t.n AS x, n.n AS y ORDER BY x, y';

test('this engine answers the query — recorded, not asserted as correct', () => {
  /*
   * ⚠️ THIS ASSERTION IS A RECORD OF BEHAVIOUR, NOT A CLAIM THAT IT IS RIGHT. `atan2(n.m.k, '1e3')`
   * has a STRING second argument; this engine never evaluates it because the AND chain settles the
   * row on `n.x < 0` first ([[conjunct-order-chosen-for-speed]] — cheapest conjunct first, per
   * engine, is owner policy). The Rust engine evaluates it and raises `E_INVALID_VALUE`.
   */
  const rows = [...query(build(), Q)] as { x: number; y: unknown }[];

  expect(rows.map((r) => r.x)).toEqual([3, 5, 7]);
  // Every `y` is null: the optional pattern matched nothing on this engine either.
  expect(rows.every((r) => r.y === null)).toBe(true);
});

test.failing('AND the Rust engine agrees — it does not: it raises E_INVALID_VALUE', () => {
  /*
   * ⚠️⚠️ **PINNED `failing` SO IT CANNOT GO GREEN UNNOTICED.** If a later change makes the engines
   * agree — by either engine moving — this test starts passing and bun reports it, which is the
   * signal to delete this file and record the resolution.
   *
   * What would have to be decided to close it properly, from the registry's own doctrine:
   *
   *   - The registry covers `E_INVALID_VALUE` against an EMPTY result ("malformed predicate against
   *     no rows — never wrong data, and never rows"), and explicitly excludes an error against a
   *     NON-EMPTY one. Under `OPTIONAL MATCH` the pattern produces no rows while the STATEMENT
   *     produces null-filled ones, so the bound's wording does not settle this shape.
   *   - Item 259 already tried the obvious fix for the sibling shape — extending this engine's
   *     static boolean-context check to inline pattern predicates — and it made things WORSE (1
   *     divergence a run became 7). That is recorded in the registry and is not to be re-attempted
   *     ([[boolean-context-static-check]]).
   *
   * So this is a conformance decision about `OPTIONAL MATCH`'s null rows, not a defect to patch.
   */
  const rows = [...query(build(), Q)];

  // The assertion that would hold if the engines agreed: this engine would have to raise too.
  expect(rows).toBeUndefined();
});
