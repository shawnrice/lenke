// `directEqProps` lifts an element-local `=` conjunct out of the compiled expression and into
// `eqProps`, which `matchesPredicate` answers with a direct property read. Two things are tested
// here and they fail for different reasons:
//
//   1. that the lift FIRES — observed directly on `compilePredicate`'s output, because a semantic
//      test alone would pass vacuously if it stopped firing (the fixture trap that has cost this
//      repo eight surviving mutants);
//   2. that a lifted entry carries EXPRESSION equality and not inline-property equality, which is
//      the whole reason a `$param` may be lifted at all.
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

const g = new Graph();

beforeAll(() => {
  // `nulled` stores a null, `absent` has no `k` at all. `propOf` reads BOTH as null, which is why
  // `structuralEq` alone cannot tell the inline reading from the expression one.
  g.addVertex({ id: 'one', labels: ['P'], properties: { k: 1 } });
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { k: null } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: {} });
});

const countOf = (q: string, params?: Record<string, unknown>): number =>
  Number(query(g, q, params)[0].c);

describe('the lift fires, and only where it is element-local', () => {
  const lifted = (src: string, ownVar = 'n'): readonly { key: string }[] =>
    compilePredicate(undefined, parsePredicate(src), ownVar).eqProps ?? [];

  test('a LITERAL-valued equality lifts', () => {
    expect(lifted('n.k = 1').map((p) => p.key)).toEqual(['k']);
  });

  test('a PARAM-valued equality lifts — it did NOT until the null guard existed', () => {
    expect(lifted('n.k = $p').map((p) => p.key)).toEqual(['k']);
  });

  test('a whole AND-chain of them lifts, in order', () => {
    expect(lifted("n.k = 1 AND n.s = 'x'").map((p) => p.key)).toEqual(['k', 's']);
  });

  test('BOTH operand orders lift — the named bug class is the two costing differently', () => {
    expect(lifted('1 = n.k').map((p) => p.key)).toEqual(['k']);
  });

  test('no own-var means no lift at all, which is what the general scan path used to get', () => {
    expect(
      compilePredicate(undefined, parsePredicate('n.k = 1'), undefined).eqProps,
    ).toBeUndefined();
  });

  test('a conjunct on ANOTHER variable declines the WHOLE chain', () => {
    expect(lifted('n.k = 1 AND m.s = 2')).toEqual([]);
  });

  // UPDATED at item 278, which taught the lift to carry an ORDERING comparison as well. These
  // two used to assert that ANY non-equality conjunct declined the whole chain; it no longer
  // does, so they now pin WHERE each conjunct lands — the equality in `eqProps`, the ordering
  // one in `cmpProps`. The behaviour they were protecting (nothing silently unapplied) is
  // asserted by the answer tests below and by `eqprops-gate.test.ts`.
  test('a mixed chain splits: the equality lifts, the ordering one lands in cmpProps', () => {
    const pred = compilePredicate(undefined, parsePredicate('n.k = 1 AND n.j > 2'), 'n');

    expect((pred.eqProps ?? []).map((e) => e.key)).toEqual(['k']);
    expect((pred.cmpProps ?? []).map((c) => `${c.key}${c.op}`)).toEqual(['j>']);
    // Nothing is left for the generic evaluator, so nothing can be dropped by a gate that
    // reads only `where` — which is the failure item 277 fixed.
    expect(pred.where).toBeUndefined();
  });

  test('an inequality alone lifts into cmpProps', () => {
    const pred = compilePredicate(undefined, parsePredicate('n.k > 1'), 'n');

    expect(pred.eqProps).toBeUndefined();
    expect((pred.cmpProps ?? []).map((c) => `${c.key}${c.op}`)).toEqual(['k>']);
  });

  // UPDATED at item 1284, the same way item 278 updated the two above it. This used to assert
  // that an unreadable conjunct declined the WHOLE chain; it now lifts the PREFIX and leaves the
  // unreadable tail as the residual `where`, which measured 2.31x on a 200,000-vertex scan. What
  // it protects — nothing silently unapplied — is asserted by the answer tests in
  // `mixed-chain-lift.test.ts`, which check a dropped residual as a SUPERSET of rows.
  test('a conjunct that is not a comparison lifts the PREFIX and leaves a residual', () => {
    const pred = compilePredicate(undefined, parsePredicate("n.k = 1 AND upper(n.s) = 'X'"), 'n');

    expect((pred.eqProps ?? []).map((e) => e.key)).toEqual(['k']);
    expect(pred.cmpProps).toBeUndefined();
    // The tail is STILL THERE. If this ever reads `undefined`, the function call has been dropped
    // and the predicate answers a superset.
    expect(pred.where).not.toBeUndefined();
  });

  test('CONTROL: the unreadable conjunct FIRST still declines the whole chain', () => {
    // Only a PREFIX lifts, so a chain that opens with the unreadable conjunct lifts nothing — the
    // boundary that keeps executed order equal to written order.
    const pred = compilePredicate(undefined, parsePredicate("upper(n.s) = 'X' AND n.k = 1"), 'n');

    expect(pred.eqProps).toBeUndefined();
    expect(pred.cmpProps).toBeUndefined();
    expect(pred.where).not.toBeUndefined();
  });

  // ⚠️ THE THREE **NESTED** DECLINE SITES, each of which a surviving mutant proved untested.
  // Item 1284's mutation run replaced `stop = i; break;` with `continue;` at the three sites that
  // sit inside an inner `if` — a negated compare on another variable, a per-row membership
  // haystack, and a dotted compare on another variable. `continue` makes the conjunct VANISH: it
  // is neither lifted nor left in the residual, so the predicate answers a SUPERSET. All 3217
  // tests passed. These are the assertions that make it fail.
  //
  // Each one checks the ROUTE (nothing lifted, the tail still compiled) and then the ANSWER, since
  // the route alone would not show what dropping the conjunct costs.
  test('⚠️ a NEGATED compare on another variable declines, and is not dropped', () => {
    const pred = compilePredicate(undefined, parsePredicate('NOT (m.k = 1) AND n.k = 1'), 'n');

    expect(pred.eqProps).toBeUndefined();
    expect(pred.where).not.toBeUndefined();
  });

  test('⚠️ a PER-ROW membership haystack declines, and is not dropped', () => {
    // A list whose members are not closed cannot be lifted — the haystack differs per row.
    const pred = compilePredicate(undefined, parsePredicate('n.k IN [n.j] AND n.k = 1'), 'n');

    expect(pred.eqProps).toBeUndefined();
    expect(pred.memberProps).toBeUndefined();
    expect(pred.where).not.toBeUndefined();
  });

  test('⚠️ a DOTTED compare on another variable declines, and is not dropped', () => {
    const pred = compilePredicate(
      undefined,
      parsePredicate("m.meta.city = 'nyc' AND n.k = 1"),
      'n',
    );

    expect(pred.eqProps).toBeUndefined();
    expect(pred.pathProps).toBeUndefined();
    expect(pred.where).not.toBeUndefined();
  });

  test('⚠️ ANSWERS: a dropped conjunct would be visible as a superset of rows', () => {
    // The route assertions above are on `compilePredicate`; these run the engine, so a conjunct
    // that vanished anywhere between the two shows up as an extra row. `one` has k=1; `nulled`
    // stores null and `absent` has no `k`, so both are UNKNOWN under every spelling here and drop.
    expect(countOf('MATCH (n:P) WHERE n.k IN [n.k] AND n.k = 1 RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (n:P) WHERE n.k = 1 AND n.k IN [n.k] RETURN count(*) AS c')).toBe(1);
    // A conjunct that is FALSE for every row: if it were dropped this answers 1, not 0.
    expect(countOf('MATCH (n:P) WHERE n.k = 1 AND n.k IN [n.k + 1] RETURN count(*) AS c')).toBe(0);
    expect(countOf('MATCH (n:P) WHERE n.k IN [n.k + 1] AND n.k = 1 RETURN count(*) AS c')).toBe(0);
  });
});

describe('a lifted entry carries EXPRESSION equality, not inline-property equality', () => {
  // THE DISTINGUISHING INPUT. Without the null guard in `matchesPredicate`'s `eqProps` loop, a
  // null-resolving param reads as the inline `{k: null}` question and answers 2 — the stored null
  // AND the absent key — where `=` answers 0. That is a wrong answer, not a slower one.
  test('a NULL param answers like `=` (no rows), not like `{k: null}`', () => {
    expect(countOf('MATCH (n:P) WHERE n.k = $p RETURN count(*) AS c', { p: null })).toBe(0);
    expect(countOf('MATCH (n:P WHERE n.k = $p) RETURN count(*) AS c', { p: null })).toBe(0);
  });

  test('CONTROL: the inline PROPERTY spelling keeps the inline reading', () => {
    // Unchanged, and it must stay different — `props` is a separate loop with no guard. If this
    // ever starts answering 0 the two readings have been conflated in the wrong direction.
    expect(countOf('MATCH (n:P {k: $p}) RETURN count(*) AS c', { p: null })).toBe(2);
    expect(countOf('MATCH (n:P {k: null}) RETURN count(*) AS c')).toBe(2);
  });

  test('CONTROL: a NON-null param still matches, so the guard did not reject everything', () => {
    expect(countOf('MATCH (n:P) WHERE n.k = $p RETURN count(*) AS c', { p: 1 })).toBe(1);
    expect(countOf('MATCH (n:P WHERE n.k = $p) RETURN count(*) AS c', { p: 1 })).toBe(1);
    expect(countOf('MATCH (n:P) WHERE n.k = 1 RETURN count(*) AS c')).toBe(1);
  });

  test('a null LITERAL answers 0 through the lifted path too', () => {
    expect(countOf('MATCH (n:P) WHERE n.k = null RETURN count(*) AS c')).toBe(0);
  });

  test('a stored null is not matched by a non-null param', () => {
    expect(countOf('MATCH (n:P) WHERE n.k = $p RETURN count(*) AS c', { p: 2 })).toBe(0);
  });
});
