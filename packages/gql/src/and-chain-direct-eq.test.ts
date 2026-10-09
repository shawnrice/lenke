import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 230 extended `directEqProps` from exactly one `=` comparison to an AND-chain whose EVERY
// conjunct is `<ownVar>.<key> = <closed value>`, lifting the literal-valued ones into `eqProps`
// (read off the element directly) and leaving the param-valued ones with the general evaluator.
//
// The admission rule is what makes the reordering sound: `satisfies` checks `eqProps` BEFORE
// `where` and short-circuits, while GQL's `AND` does not short-circuit, so a lifted conjunct must
// not be able to hide a sibling's raise. A closed `=` cannot raise in this engine — cross-type `=`
// is a no-match where `<=` throws — so there is nothing to hide. Every test below is a case that
// would distinguish the two if that reasoning were wrong; a suite that merely passes does not
// establish it (audit items 230 and 193).
const graph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 2, tags: [1, 2] } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1, j: 9, tags: [1, 2] } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { k: 5, j: 2 } });
  // A STORED null, and a vertex MISSING `j` entirely — the two shapes `structuralEq` and `=`
  // could disagree on.
  g.addVertex({ id: 'd', labels: ['P'], properties: { k: null, j: 2 } });
  g.addVertex({ id: 'e', labels: ['P'], properties: { k: 1 } });

  return g;
};

const count = (text: string, params: Record<string, unknown> = {}): unknown =>
  query(graph(), text, params)[0].c;

describe('an AND-chain of equalities answers as the general path does', () => {
  test('two literal conjuncts agree with the same question spelled inline', () => {
    expect(count('MATCH (n:P) WHERE n.k = 1 AND n.j = 2 RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (n:P {k: 1, j: 2}) RETURN count(*) AS c')).toBe(1);
  });

  test('operand order on either conjunct is the same question', () => {
    expect(count('MATCH (n:P) WHERE 1 = n.k AND n.j = 2 RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (n:P) WHERE n.k = 1 AND 2 = n.j RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (n:P) WHERE 1 = n.k AND 2 = n.j RETURN count(*) AS c')).toBe(1);
  });

  test('a MISSING property is no-match, not a match against null', () => {
    // `e` has no `j`. `structuralEq(undefined, 2)` is false and `=` yields UNKNOWN; both reject.
    expect(count('MATCH (n:P) WHERE n.k = 1 AND n.j = 2 RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (n:P) WHERE n.j = 2 RETURN count(*) AS c')).toBe(3);
  });

  test('a STORED null matches neither a value nor a null literal', () => {
    // `d.k` is null. This is the case that forces the non-null-literal rule: `{k: null}` matches a
    // stored null, `n.k = null` matches nothing, so a null literal is NOT liftable and stays with
    // the general evaluator.
    expect(count('MATCH (n:P) WHERE n.k = null AND n.j = 2 RETURN count(*) AS c')).toBe(0);
    expect(count('MATCH (n:P {k: null, j: 2}) RETURN count(*) AS c')).toBe(1);
  });

  test('a LIST-valued literal conjunct compares structurally', () => {
    expect(count('MATCH (n:P) WHERE n.tags = [1, 2] AND n.k = 1 RETURN count(*) AS c')).toBe(2);
    expect(count('MATCH (n:P) WHERE n.tags = [1, 2] AND n.j = 9 RETURN count(*) AS c')).toBe(1);
  });

  test('a PARAM conjunct stays correct beside a lifted literal one', () => {
    expect(count('MATCH (n:P) WHERE n.k = 1 AND n.j = $j RETURN count(*) AS c', { j: 2 })).toBe(1);
    expect(count('MATCH (n:P) WHERE n.j = $j AND n.k = 1 RETURN count(*) AS c', { j: 9 })).toBe(1);
    expect(
      count('MATCH (n:P) WHERE n.k = $k AND n.j = $j RETURN count(*) AS c', { k: 1, j: 2 }),
    ).toBe(1);
  });

  test('a param resolving to NULL matches nothing, which is why params do not lift', () => {
    // The whole reason a param-valued conjunct stays with the general evaluator. `structuralEq`
    // ends in `===`, so `structuralEq(null, null)` is TRUE and would match the stored null on `d`;
    // `=` yields UNKNOWN and matches nothing. The value is not known at compile time, so there is
    // no way to tell the two cases apart there — the conjunct stays behind instead.
    //
    // Without this case the mutant that lifts params survives: every other param test binds a
    // non-null value, where the two notions agree (audit item 230).
    expect(count('MATCH (n:P) WHERE n.k = $k RETURN count(*) AS c', { k: null })).toBe(0);
    expect(count('MATCH (n:P) WHERE n.j = 2 AND n.k = $k RETURN count(*) AS c', { k: null })).toBe(
      0,
    );

    // And the inline spelling of the same thing is a DIFFERENT question, which is settled
    // behaviour here: `{k: null}` is an IS NULL test and matches the stored null.
    expect(count('MATCH (n:P {k: null}) RETURN count(*) AS c')).toBe(1);
  });

  test('three conjuncts, mixed literal and param', () => {
    expect(
      count('MATCH (n:P) WHERE n.k = 1 AND n.j = 2 AND n.tags = $t RETURN count(*) AS c', {
        t: [1, 2],
      }),
    ).toBe(1);
  });
});

describe('a conjunct the rule cannot admit declines the WHOLE chain', () => {
  test('an INEQUALITY beside an equality is unchanged', () => {
    // Declining is the point: a residual that CAN raise is what the admission rule forbids, so a
    // chain containing one is left entirely to the general evaluator.
    expect(count('MATCH (n:P) WHERE n.k = 1 AND n.j > 2 RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (n:P) WHERE n.j > 2 AND n.k = 1 RETURN count(*) AS c')).toBe(1);
  });

  test('a RAISING conjunct is SETTLED OUT when no row satisfies the liftable one', () => {
    // THE decisive case for the reordering, and it has changed direction. This test used to
    // assert a raise, on the premise that "`AND` evaluates every item — it does NOT
    // short-circuit", and reasoned that `eqProps` DOES short-circuit, so a chain split between
    // the two "would answer 0 and swallow the raise", which declining the whole chain avoided.
    //
    // `AND` now short-circuits on FALSE in both places (user, 2026-10-08), so the two paths
    // AGREE and 0 is the answer either way. `trim(n.k)` on a number is still a data exception —
    // it is simply never reached, because `n.k = 999` settles every row first.
    expect(count("MATCH (n:P) WHERE n.k = 999 AND trim(n.k) = 'x' RETURN count(*) AS c")).toBe(0);
    // THE REVERSED SPELLING, which used to raise here and answer 0 in the engine — the last
    // open residual of that divergence. It now answers 0 in both (2026-10-09). Written order
    // no longer decides in a FILTER, because a filter keeps only a clean TRUE: `n.k = 999` is
    // never TRUE on any row, so the row is lost whichever conjunct is read first, and
    // `filterPredicate` therefore puts the conjunct that cannot raise in front. The engine
    // reaches the same answer by its seek and by `filter_conjuncts_reordered`.
    expect(count("MATCH (n:P) WHERE trim(n.k) = 'x' AND n.k = 999 RETURN count(*) AS c")).toBe(0);

    // CONTROL, and now the load-bearing half: with the liftable conjunct MATCHING, the raising
    // one is essential and is reached. Without this the test would pass for a chain that had
    // simply stopped evaluating its tail at all.
    expect(() =>
      count("MATCH (n:P) WHERE n.k = 1 AND trim(n.k) = 'x' RETURN count(*) AS c"),
    ).toThrow();
    expect(() =>
      count("MATCH (n:P) WHERE trim(n.k) = 'x' AND n.k = 1 RETURN count(*) AS c"),
    ).toThrow();
  });

  test('cross-type ORDERING is a no-match in this engine, not a raise', () => {
    // Recorded because it is where the first version of this test went wrong: the THROW on a
    // cross-type `<=` is the NATIVE engine's behaviour. The TS engine answers no-match for every
    // cross-type ordering pair, so none of these is a raising conjunct and none of them would have
    // tested the property above.
    expect(count("MATCH (n:P) WHERE n.k = 999 AND n.j <= 'x' RETURN count(*) AS c")).toBe(0);
    expect(count("MATCH (n:P) WHERE n.k <= 'x' RETURN count(*) AS c")).toBe(0);
  });

  test('a MISSING param raises even when no row satisfies the literal conjunct', () => {
    // This chain IS split — `n.k = 999` lifts and `n.j = $absent` stays — and it still refuses,
    // which establishes that a missing parameter is caught BEFORE the walk rather than on the row
    // that first reads it. Worth pinning: if it were per-row, the split would turn this refusal
    // into an answer of 0, because no row survives the lifted conjunct to reach the param.
    expect(() =>
      count('MATCH (n:P) WHERE n.k = 999 AND n.j = $absent RETURN count(*) AS c'),
    ).toThrow();
    expect(() =>
      count('MATCH (n:P) WHERE n.j = $absent AND n.k = 999 RETURN count(*) AS c'),
    ).toThrow();
  });

  test('a NON-COMPARISON conjunct declines, and is not silently dropped', () => {
    // `IS NOT NULL` is not a `compare` node at all, so it reaches a different branch from the
    // inequality above: the one that decides what to do with a conjunct the rule cannot read. The
    // only safe answer is to decline the chain; DROPPING it would lose the constraint and
    // over-count, which is the "a shortcut that half-applies a predicate is a wrong answer" failure
    // this file is built around.
    //
    // Three of the five vertices have `k = 1`, and only two of those have a `j` — so the mutant
    // that drops the conjunct answers 3 where the truth is 2. Without this case it survives: every
    // other chain here is made of comparisons, which decline through the operator check instead
    // (audit item 230).
    expect(count('MATCH (n:P) WHERE n.k = 1 AND n.j IS NOT NULL RETURN count(*) AS c')).toBe(2);
    expect(count('MATCH (n:P) WHERE n.j IS NOT NULL AND n.k = 1 RETURN count(*) AS c')).toBe(2);
    expect(count('MATCH (n:P) WHERE n.k = 1 AND NOT n.j = 9 RETURN count(*) AS c')).toBe(1);
  });

  test('a conjunct on ANOTHER variable declines, and the answer is still right', () => {
    const g = graph();

    g.addVertex({ id: 'z', labels: ['Q'], properties: { k: 1 } });

    expect(query(g, 'MATCH (n:P), (m:Q) WHERE n.k = 1 AND m.k = 1 RETURN count(*) AS c')[0].c).toBe(
      3,
    );
  });

  test('a CORRELATED subquery count whose predicate reads only the OUTER variable', () => {
    // THE shape that makes `ownVar`'s own variable check load-bearing, and it took instrumenting
    // the guard to find: a `CALL (m) { … }` body is a single-node count, and its clause `WHERE`
    // reaches the tally reading `m` — a variable the counted element knows nothing about. Nothing
    // in 1,656 existing tests reached that branch with a foreign free variable.
    //
    // `m.k = 1` is a closed equality on a prop, so it has the exact SHAPE `directEqProps` lifts;
    // only the variable tells it apart. Read off the wrong element it becomes `n.k = 1`, which
    // counts 3 of the 5 P vertices instead of all 5 — so this case distinguishes, and the DOUBLE
    // mutant that removes both this check and the caller's locality guard is caught by it.
    const g = graph();

    g.addVertex({ id: 'z', labels: ['Q'], properties: { k: 1 } });

    const rows = query(
      g,
      'MATCH (m:Q) CALL (m) { MATCH (n:P) WHERE m.k = 1 RETURN count(*) AS c } RETURN c',
    ) as { c: unknown }[];

    expect(rows.map((r) => r.c)).toEqual([5]);

    // And the genuinely correlated form, where the value side is the outer element's property
    // rather than a literal — not liftable at all, since `asPropCompare` requires a closed value.
    const corr = query(
      g,
      'MATCH (m:Q) CALL (m) { MATCH (n:P) WHERE n.k = m.k RETURN count(*) AS c } RETURN c',
    ) as { c: unknown }[];

    expect(corr.map((r) => r.c)).toEqual([3]);
  });
});
