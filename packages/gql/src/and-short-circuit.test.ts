import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

// `AND` short-circuits on FALSE: once a conjunct settles the chain false, every later conjunct
// is an INESSENTIAL part of the expression and is not evaluated, so a throwing one does not
// throw. ISO/IEC 39075 leaves both halves of this to the implementation, in its FREE
// `-implementation-dependent.xml` artifact — `US008` (the actual order of expression
// evaluation) and `UA004` (whether an exception raised by the evaluation of an inessential part
// is actually raised) — so both outcomes conform and the choice is ours to make on cost. A
// FALSE is cheaper than an exception (user, 2026-10-08).
//
// The three things these tests exist to hold, because each has a plausible wrong version:
//
//   1. FALSE settles; UNKNOWN does NOT. `and(null, false)` is `false`, so a chain cannot stop
//      at UNKNOWN — a short-circuit testing `!== true` instead of `=== false` would answer
//      UNKNOWN where the truth is FALSE, and no fault-based test would notice.
//   2. The skip is only of INESSENTIAL conjuncts. A chain that simply stopped evaluating its
//      tail would pass every "does not raise" assertion here, which is why each has a CONTROL
//      whose sibling does not settle.
//   3. `OR` and `XOR` are NOT symmetric. `OR` keeps evaluating both operands because the
//      native engine has nothing on the OR side to settle a row out of the chain, and
//      byte-identity with it is the binding constraint, not symmetry for its own sake. `XOR`
//      can never short-circuit — neither operand is ever inessential.
//
// Mirrored in the Rust engine by `fold_operand`'s `must_narrow`
// (crates/lenke-engine/src/exec.rs) and pinned there by
// `a_false_conjunct_leaves_a_throwing_conjunct_unevaluated`.

const g = (): Graph => {
  const nd = [
    // `s` is a STRING, so coercing it to a truth value is a data exception — the cheapest
    // dynamically-typed fault there is, and the one the static boolean-context check cannot
    // catch (this engine is schemaless, so `n.s`'s type is unknowable at parse time).
    '{"type":"node","id":"1","labels":["P"],"properties":{"n":1,"s":"a"}}',
    '{"type":"node","id":"2","labels":["P"],"properties":{"n":2,"s":"b"}}',
    // No `zz` anywhere, so `n.zz = 'a'` is UNKNOWN on every row rather than FALSE. That is
    // the distinction point for (1) above.
    '{"type":"node","id":"3","labels":["P"],"properties":{"n":3,"s":"c"}}',
    // An actual edge, so a `VALUE { (n)-[:E]->(b) RETURN … }` subquery has a row to return.
    // Without it every such subquery matches nothing and yields NULL, which coerces to
    // UNKNOWN rather than faulting — so the CONTROL below passed for the wrong reason and the
    // test proved nothing about the subquery being evaluated.
    '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  ].join('\n');

  return deserialize(nd, 'ndjson', new Graph());
};

const rows = (q: string): unknown[] => query(g(), q);

const raised = (q: string): boolean => {
  try {
    query(g(), q);

    return false;
  } catch {
    return true;
  }
};

describe('AND short-circuits on FALSE', () => {
  test('a FALSE conjunct leaves a throwing sibling unevaluated', () => {
    // `n.n = 99` is false on every row, so `n.s` is never coerced.
    expect(raised(`MATCH (n:P) WHERE n.n = 99 AND n.s RETURN n.n AS x`)).toBe(false);
    expect(rows(`MATCH (n:P) WHERE n.n = 99 AND n.s RETURN n.n AS x`)).toEqual([]);
    // The same with an arithmetic fault rather than a coercion fault, since the two are
    // independent hazards and a classifier could get one right and the other wrong.
    expect(raised(`MATCH (n:P) WHERE n.n = 99 AND n.s + 1 > 0 RETURN n.n AS x`)).toBe(false);
  });

  test('CONTROL a sibling that does NOT settle is essential, and still raises', () => {
    // Without this the implementation could simply never evaluate the tail of a chain.
    expect(raised(`MATCH (n:P) WHERE n.n > 0 AND n.s RETURN n.n AS x`)).toBe(true);
    // Partially settling is not settling: `n.n = 1` is false for two rows and TRUE for one,
    // so the fault is reached on that one.
    expect(raised(`MATCH (n:P) WHERE n.n = 1 AND n.s RETURN n.n AS x`)).toBe(true);
  });

  test('UNKNOWN does not settle the chain, so a later conjunct is still reached', () => {
    // `n.zz = 'a'` is UNKNOWN (the key is absent everywhere), and `and(null, false)` is
    // `false` — so UNKNOWN cannot settle an AND and the throwing conjunct is essential. An
    // implementation that stopped at "not TRUE" would answer here instead of raising.
    //
    // THE ONE CASE IN THIS FILE WHERE THE ENGINES DIFFER: native answers [] because a FILTER
    // keeps only TRUE rows, so its conjunct split drops the UNKNOWN row before the sibling is
    // reached. A value context has no such luxury — UNKNOWN is a value there and the chain
    // must carry it. Declared in `divergence-registry.ts` under
    // `boolean-context-dynamic-operand-under-seek`, route (1); every other assertion here was
    // cross-checked against native and agrees.
    expect(raised(`MATCH (n:P) WHERE n.zz = 'a' AND n.s RETURN n.n AS x`)).toBe(true);
    // And the value side of the same rule, with no fault in play: UNKNOWN AND FALSE is FALSE,
    // not UNKNOWN. A chain that returned early on UNKNOWN would give `null` here.
    expect(rows(`RETURN (null AND false) AS r`)).toEqual([{ r: false }]);
    expect(rows(`RETURN (null AND true) AS r`)).toEqual([{ r: null }]);
  });

  test('the bare-expression form, where there is no filter and no seek', () => {
    expect(rows(`RETURN (false AND (1.0 / 0.0)) AS r`)).toEqual([{ r: false }]);
    // Three conjuncts: the settle happens in the middle and must stop the third too.
    expect(rows(`RETURN (true AND false AND (1.0 / 0.0)) AS r`)).toEqual([{ r: false }]);
  });

  test('WRITTEN ORDER, not cost order: a raising conjunct placed FIRST is reached', () => {
    // No reordering. A version of this partitioned the conjuncts so the ones that cannot
    // fault ran first; it agreed with the native engine on more WHERE shapes and disagreed on
    // shapes it had no business touching — native reorders only where its optimizer can seed
    // a conjunct out of the chain, and in a projection it does not reorder at all. Written
    // order is the one rule both engines can hold everywhere.
    expect(raised(`RETURN ((1.0 / 0.0) AND false) AS r`)).toBe(true);
    // The projection shape that forced the decision: `0` is a non-boolean literal operand, so
    // coercing it faults, and hoisting the safe `1 IS NULL` above it would have hidden that.
    expect(raised(`RETURN (0 AND (1 IS NULL)) AS r`)).toBe(true);
  });

  test('OR and XOR are NOT short-circuited', () => {
    expect(raised(`RETURN (true OR (1.0 / 0.0)) AS r`)).toBe(true);
    expect(raised(`RETURN (false XOR (1.0 / 0.0)) AS r`)).toBe(true);
    expect(raised(`MATCH (n:P) WHERE n.n > 0 OR n.s RETURN n.n AS x`)).toBe(true);
    // The three-valued answers are untouched by any of this.
    expect(rows(`RETURN (true OR null) AS r`)).toEqual([{ r: true }]);
    expect(rows(`RETURN (false OR null) AS r`)).toEqual([{ r: null }]);
  });

  test('a NOT around a short-circuited AND negates FALSE rather than propagating a fault', () => {
    // `NOT (false AND <throws>)` is `NOT false` = TRUE, so every row passes. This is the
    // shape whose TS side returned ROWS while native raised — an error against a NON-EMPTY
    // result, which the divergence registry explicitly may not excuse, so it had to be fixed
    // rather than declared.
    expect(rows(`MATCH (n:P) WHERE NOT (n.n = 99 AND n.s) RETURN n.n AS x`)).toHaveLength(3);
  });
});

describe('the static boolean-context check covers an aggregate VALUE subquery', () => {
  // The gap that the short-circuit exposed. `VALUE { … RETURN count(*) }` is statically a
  // number, and the native engine rejects it in a truth position at PLAN time. This engine had
  // no `valueSubquery` arm in `definitelyNonBool` and caught it per row instead — the same
  // `E_INVALID_VALUE` by a different route, which looked like agreement until a FALSE conjunct
  // stopped the row ever being evaluated. A static reject is order-independent, so it is the
  // route that survives short-circuiting.
  test('an aggregate-returning VALUE subquery is rejected before execution', () => {
    expect(
      raised(`MATCH (n:P) WHERE n.n = 99 AND VALUE { MATCH (n)-[:E]->(b) RETURN count(*) }
              RETURN n.n AS x`),
    ).toBe(true);
    // Rejected on an EMPTY match too, which is what makes it static rather than per-row:
    // there is no `Q` label, so no row could reach the operand.
    expect(
      raised(`MATCH (n:Q) WHERE VALUE { MATCH (n)-[:E]->(b) RETURN count(*) } RETURN n.n AS x`),
    ).toBe(true);
  });

  test('a NON-aggregate VALUE subquery stays dynamic, and is skipped by the short-circuit', () => {
    // A scalar `RETURN` lowers to the engine's `ScalarSubquery`, which its
    // `definitely_non_bool` does NOT flag — the body's type is as unknowable as a bare
    // property's. So this one is left to the per-row check and the short-circuit reaches it
    // first. Both engines answer [].
    expect(
      rows(`MATCH (n:P) WHERE n.n = 99 AND VALUE { MATCH (n)-[:E]->(b) RETURN b.n }
            RETURN n.n AS x`),
    ).toEqual([]);
    // CONTROL: with the sibling admitting rows it is evaluated, and a number in a truth
    // position faults per row. Without this the test above would pass for a subquery that had
    // simply stopped being evaluated at all.
    expect(
      raised(`MATCH (n:P) WHERE n.n > 0 AND VALUE { MATCH (n)-[:E]->(b) RETURN 7 }
              RETURN n.n AS x`),
    ).toBe(true);
  });

  test('a boolean-returning VALUE subquery is not flagged', () => {
    // The thing a too-broad static check would break: `RETURN b.n > 1` is a comparison, so
    // the subquery is a perfectly good truth value and must not be rejected.
    expect(
      rows(`MATCH (n:P) WHERE n.n = 99 AND VALUE { MATCH (n)-[:E]->(b) RETURN b.n > 1 }
            RETURN n.n AS x`),
    ).toEqual([]);
    // And it genuinely GATES: vertex 1's only out-edge lands on `n = 2`, so the subquery is
    // TRUE there and UNKNOWN (no row → NULL) on the other two. One row, not zero and not
    // three — which is what shows the subquery was evaluated as a predicate rather than
    // skipped or rejected.
    expect(
      rows(`MATCH (n:P) WHERE VALUE { MATCH (n)-[:E]->(b) RETURN b.n > 1 } RETURN n.n AS x`),
    ).toEqual([{ x: 1 }]);
  });
});
