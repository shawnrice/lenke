// A cross-engine divergence found by the differential fuzzer at item 2022, PRE-EXISTING.
//
// **NATIVE RAISES WHERE THIS ENGINE RETURNS SIX ROWS**, and the divergence registry's one entry
// explicitly does NOT cover that:
//
//     "An error against a NON-EMPTY result is a different thing entirely … and is NOT covered here."
//
// Found by `fuzz-sweep.sh` on run 10 of 10 (the sweep exists to keep the failing run's output — item
// 2012). Replay: `FUZZ_SEED=3826437490 bun test src/differential-fuzz.test.ts`.
//
// **A SECOND INSTANCE AT ITEM 2025 CONFIRMS THIS IS A CLASS, NOT A ONE-OFF** — same shape, a
// different non-boolean operand:
//
//     FUZZ_SEED=1493132919
//     MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (date('2020-01-01') AND (n.s IS FALSE)))
//       RETURN t.n AS x, n.n AS y ORDER BY x, y
//
// A TEMPORAL literal in a truth position where the first was `atan2(n.m.k, '1e3')`. Both are
// statically non-boolean operands inside an inline pattern predicate under `OPTIONAL MATCH`; the
// second case is asserted below. Observed rate across both: **2 in ~28 runs of 20,000 queries**
// (~1 per 280,000), the same order as the registry's documented sibling.
//
// IT IS NOT ITEM 2022's. Verified by replaying the same seed against `HEAD` with that item's
// change absent: it fails identically. The merge helper cannot affect predicate evaluation order.
//
// **THE NUANCE THAT MAKES IT INTERESTING, and that the registry's matcher cannot see.** The inline
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

/*
 * **FOUR OPERAND KINDS HAVE NOW ARRIVED FOR THIS ONE CLASS, which is why it is a CLASS and not a
 * coincidence.** Each was found by the differential fuzzer on a different random seed:
 *
 *     FUZZ_SEED=1493132919   date('2020-01-01')        a temporal in boolean position
 *     FUZZ_SEED=3826437490   atan2(n.m.k, '1e3')       a string argument to a numeric fn
 *     FUZZ_SEED=3908458595   acos(n.s)                 a string argument to a numeric fn (item 2037)
 *     FUZZ_SEED=1387327370   ('\t\n' AND (NOT true))   a STRING LITERAL as a conjunct (item 2070)
 *   FUZZ_SEED=3369177423  (null <> n.m.k)  — a MAP MEMBER ACCESS as the operand, and the FIFTH
 *     distinct operand kind on this divergence (item 2085, found in a routine sweep). Recorded
 *     because it rules out the narrowest reading of the bug: `n.m.k` is not a bad TYPE or a missing
 *     property but a lookup INSIDE a property's value, so whatever raises here is reached through a
 *     different accessor than the four before it. It was also the one failure in a 5-run sweep
 *     during a core change, and was ruled out STRUCTURALLY — the same seed fails with that change's
 *     fast arm KILLED — rather than by resembling this family.
 *
 * **THE FOURTH IS THE SIMPLEST ONE YET AND THAT MATTERS:** the first three put a non-boolean in
 * boolean position through a FUNCTION CALL, so "the function returns the wrong type" was an available
 * reading. A bare string literal as the left conjunct of an `AND` removes it — the class is about a
 * statically non-boolean OPERAND, whatever produces it.
 *
 * The shape is identical every time: a statically non-boolean operand in an inline pattern predicate
 * under `OPTIONAL MATCH`, where this engine's conjunct order settles the row before evaluating the
 * bad operand and the Rust engine evaluates it and raises `E_INVALID_VALUE`. `OPTIONAL MATCH` then
 * turns "no match" into NULL-filled rows, so the outer results differ: six rows against an error.
 *
 * THE RATE IS ROUGHLY 1 IN 280,000 GENERATED QUERIES, so a 20,000-query sweep hits it about every
 * fourteenth run — which is exactly how it keeps surfacing in `fuzz-sweep.sh` and being
 * re-diagnosed. Anyone seeing a sweep fail on an `OPTIONAL MATCH` + inline-predicate query should
 * check this file FIRST.
 */
const Q =
  "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ((atan2(n.m.k, '1e3') >= n.x) AND " +
  '((n.m.k >= 3) AND (n.x < 0)))) RETURN t.n AS x, n.n AS y ORDER BY x, y';

test('this engine answers the query — recorded, not asserted as correct', () => {
  /*
   * THIS ASSERTION IS A RECORD OF BEHAVIOUR, NOT A CLAIM THAT IT IS RIGHT. `atan2(n.m.k, '1e3')`
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
   * **PINNED `failing` SO IT CANNOT GO GREEN UNNOTICED.** If a later change makes the engines
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

test('the SECOND operand kind — a temporal literal in a truth position (item 2025)', () => {
  /*
   * RECORDED, NOT ASSERTED AS CORRECT, exactly like the first case. `date('2020-01-01') AND …`
   * puts a TEMPORAL in a truth position; this engine settles the row on the other conjunct and never
   * evaluates it, the Rust engine raises `E_INVALID_VALUE`. Two different operand kinds reaching the
   * same divergence is what makes this a class — and what makes `s` matter below: the fixture needs
   * the second conjunct to be decidable without the first.
   */
  /*
   * **THE FIXTURE DECIDES WHETHER THE DIVERGENCE HAPPENS AT ALL, AND MY FIRST ATTEMPT BROKE IT.**
   * I set `s = false`, which makes `n.s IS FALSE` **TRUE** — so the AND cannot settle on it, this
   * engine reaches the temporal and RAISES, and the two engines agree. With `s` ABSENT, `n.s` is null
   * and `null IS FALSE` is FALSE, which settles the row and short-circuits the temporal away: that is
   * the fuzzer's fixture and the divergent one. A reproduction of a short-circuit divergence has to
   * reproduce the SHORT CIRCUIT.
   */
  const g = build();
  const rows = [
    ...query(
      g,
      "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (date('2020-01-01') AND (n.s IS FALSE))) " +
        'RETURN t.n AS x, n.n AS y ORDER BY x, y',
    ),
  ] as { x: number; y: unknown }[];

  expect(rows.map((r) => r.x)).toEqual([3, 5, 7]);
  expect(rows.every((r) => r.y === null)).toBe(true);
});
