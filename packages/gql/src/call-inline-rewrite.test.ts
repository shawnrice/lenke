// `CALL (n) { MATCH (n)-[:T]->(x) RETURN x }` IS `MATCH (n)-[:T]->(x)` — a correlated inline
// call whose body is one pattern and a RETURN of the names it introduces.
//
// The call runs its body once per incoming row through the general matcher, so
// `MATCH (n:P) CALL (n) { … } RETURN count(*)` cost 996.2ms at 200,000 vertices against the
// native engine's 6.2 and against 0.0 for the one-pattern spelling (item 513). Rewritten, item
// 507's fusion merges the result into the preceding MATCH and the whole ladder applies.
//
// This file pins the equivalence and — the part that matters — the shapes it must refuse.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  // `lonely` yields nothing from the call, so a non-optional CALL drops its row.
  g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 9 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['S'], properties: {} });

  return g;
};

const g = build();
const bag = (q: string): string[] =>
  query(g, q)
    .map((r) => JSON.stringify(r))
    .sort();

/**
 * ⚠️ THE ROUTE, WHICH THIS FILE DID NOT ASSERT UNTIL ITEM 1662 — and the omission cost exactly
 * what `perf-gate-needs-its-own-test` says it costs. A rewrite is ANSWER-EQUIVALENT: deleting
 * `inlineCorrelatedCall` outright leaves every `bag()` assertion below passing, so a file that
 * checks only answers cannot tell "rewritten" from "took the slow path". It is not a theoretical
 * gap: item 1662 extended the rewrite to claim a shape the test named `an ALIASED or computed
 * yield declines` had pinned, that test's title became false, and it PASSED, because the answer
 * was the only thing it looked at. The clause list is the only thing that can say.
 */
const kinds = (q: string): string[] => {
  const parsed = parse(q);

  if (!('parts' in parsed)) {
    throw new Error(`not a query: ${q}`);
  }

  const [part] = parsed.parts;

  return compileLinear(part).clauses.map((c) => c.kind);
};

/** Did the rewrite claim the clause? `callInline` surviving compilation means it did not. */
const inlined = (q: string): boolean => !kinds(q).includes('callInline');

describe('a correlated inline CALL is rewritten to its MATCH (item 513)', () => {
  test('the rewritten shape answers the one-pattern spelling, and the hand value', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual(bag('MATCH (n:P) MATCH (n)-[:T]->(x) RETURN n.k AS n, x.k AS x'));
    // `a` reaches b and c; `b` and `lonely` have no T edge, so their rows DROP (a CALL is not
    // optional). Two rows.
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual([JSON.stringify({ n: 1, x: 2 }), JSON.stringify({ n: 1, x: 3 })].sort());
    expect(
      query<{ c: number }>(
        g,
        'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN count(*) AS c',
      )[0]?.c,
    ).toBe(2);
  });

  test('a body WHERE and a landing label are carried', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x:Q) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual([JSON.stringify({ n: 1, x: 3 })]);
    expect(
      bag(
        'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) WHERE x.k = 2 RETURN x } RETURN n.k AS n, x.k AS x',
      ),
    ).toEqual([JSON.stringify({ n: 1, x: 2 })]);
  });

  test('the REL variable is yielded too when the body returns it', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN r, x } RETURN x.k AS x'),
    ).toEqual(bag('MATCH (n:P) MATCH (n)-[r:T]->(x) RETURN x.k AS x'));
  });

  // The refusals. Each would change the answer, and each is checked by one.
  test('a body that binds a name it does NOT return declines', () => {
    // `x` is bound inside and not yielded, so the call HIDES it. Inlining would leave it bound,
    // which `RETURN *` can see — this is the one condition whose violation is invisible in the
    // ordinary shapes.
    const cols = Object.keys(
      query(g, 'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x)-[:S]->(y) RETURN y } RETURN *')[0] ?? {},
    ).sort();

    expect(cols).toEqual(['n', 'y']);
  });

  test('OPTIONAL CALL keeps the row and declines', () => {
    // The left-outer form: `b` and `lonely` survive with `x` null, which a plain MATCH would
    // drop. Four rows, not two.
    expect(
      bag(
        'MATCH (n:P) OPTIONAL CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x',
      ),
    ).toEqual(
      [
        JSON.stringify({ n: 1, x: 2 }),
        JSON.stringify({ n: 1, x: 3 }),
        JSON.stringify({ n: 2, x: null }),
        JSON.stringify({ n: 9, x: null }),
      ].sort(),
    );
  });

  /**
   * ⚠️ THIS TEST USED TO BE TITLED `an ALIASED or computed yield declines`, and it is the reason
   * the `kinds` helper above exists. Item 1662 made both shapes INLINE; the title was then
   * wrong and the test still passed, because it asserted only the answer. The answers are kept
   * — they are the equivalence oracle for the new route — and the route is now asserted too.
   */
  test('an ALIASED or computed yield INLINES — and only the COMPUTED one reaches a rung', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x AS y } RETURN n.k AS n, y.k AS y'),
    ).toEqual([JSON.stringify({ n: 1, y: 2 }), JSON.stringify({ n: 1, y: 3 })].sort());
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS v } RETURN n.k AS n, v AS v'),
    ).toEqual([JSON.stringify({ n: 1, v: 2 }), JSON.stringify({ n: 1, v: 3 })].sort());

    // `y` and `v` are new columns; `x` escapes the call and is unread by the tail, so both fire.
    //
    // ⚠️ `[match, return]`, NOT `[match, let, return]` — and the difference is 2165 ns an outer
    // row against 330 (item 1662). The rewrite emits `[match, match, let, return]`; it runs
    // INSIDE `inlineTrailingLet`, which folds a ONE-ITEM trailing `LET` into the projection, and
    // `fuseAnchorThenHop` then merges the two MATCHes. A `LET` left standing is off every rung.
    // Asserting the COMPOSED shape rather than this rewrite's own output is the point: the first
    // build of item 1662 fired correctly, passed its route assertion, and still left the clause
    // on the slow path, because the composition was the thing that was wrong.
    // ⚠️ THE TWO SHAPES LAND DIFFERENTLY, AND THE SPLIT IS THE RESULT (item 1662). Both lose
    // the `callInline`, but only the COMPUTED yield loses its `LET` as well:
    //
    //   RETURN x.k AS v   ->  [match, return]        on `hopAggregate`, ~330 ns an outer row
    //   RETURN x   AS y   ->  [match, let, return]   off every rung, ~2165
    //
    // `inlineTrailingLet` substitutes a PROPERTY READ into the projection but declines a bare
    // VARIABLE rename (`LET y = x`), which predates this rewrite. So the alias-only spelling is
    // inlined without being made fast. It is a smaller win rather than a wrong one, and it is
    // pinned here so the next reader does not assume both halves reached the ladder.
    expect(
      kinds('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x AS y } RETURN n.k AS n, y.k AS y'),
    ).toEqual(['match', 'let', 'return']);
    expect(
      kinds('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS v } RETURN n.k AS n, v AS v'),
    ).toEqual(['match', 'return']);
  });

  // The pass-through shapes item 513 took, now with the route pinned as well as the answer.
  test('the pass-through shapes really are inlined, not merely answered', () => {
    expect(
      kinds('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x } RETURN n.k AS n, x.k AS x'),
    ).toEqual(['match', 'return']);
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN r, x } RETURN x.k AS x'),
    ).toBe(true);
    expect(inlined('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x:Q) RETURN x } RETURN x.k AS x')).toBe(
      true,
    );
  });

  test('an UNCORRELATED CALL — empty scope — declines', () => {
    // Nothing is imported, so the body is the same for every row: a different shape from a
    // lateral join, and not this rewrite's business.
    expect(
      query<{ c: number }>(
        g,
        'MATCH (n:P) CALL () { MATCH (z:Q) RETURN z } RETURN count(*) AS c',
      )[0]?.c,
    ).toBe(3);
  });
});

/**
 * The COMPUTED-yield extension (item 1662). `CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS c }`
 * is `MATCH (n)-[:T]->(x) LET c = x.k`, which measured 9.4x against the CALL route.
 *
 * ⚠️ WHAT MAKES IT HARD IS NOT THE `LET`, IT IS THAT `x` ESCAPES. The body's pattern introduces
 * `x` and the call YIELDS only `x.k`, so the call hides `x`; the emitted MATCH cannot hide it.
 * Item 1661 priced this route and declined to build it for exactly that reason. The condition
 * that makes it sound is `nameIsUnread` — the same predicate `dropUnreadPathVar` uses — so these
 * tests are about the escape, not about the arithmetic.
 */
describe('a COMPUTED yield inlines only when the escaping names are unread (item 1662)', () => {
  test('the escaping name read by the TAIL declines', () => {
    // `x` is live after the call here, so inlining would answer a different question.
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS c } RETURN c, x.k AS xk'),
    ).toBe(false);
  });

  test('RETURN * declines, because it reads every binding without naming one', () => {
    // The string-free reference site: no name scan can see it, so `nameIsUnread` refuses on the
    // projection's `star` flag. The columns prove `x` never leaked.
    const q = 'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS c } RETURN *';

    expect(inlined(q)).toBe(false);
    expect(Object.keys(query(g, q)[0] ?? {}).sort()).toEqual(['c', 'n']);
  });

  test('a yield that is not CHEAP and TOTAL declines', () => {
    // A function call can RAISE, so moving it into a `LET` is not an answer-preserving move the
    // way a property read is. `cheapPureExpr` is `prop | var | lit | param` and nothing else.
    expect(
      inlined(
        'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN abs(x.k) AS c } RETURN sum(c) AS t',
      ),
    ).toBe(false);
  });

  test('an UN-ALIASED computed yield declines — there is no name to bind', () => {
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k } RETURN count(*) AS c'),
    ).toBe(false);
  });

  test('an alias colliding with an IMPORTED name declines', () => {
    // `n` is already a column on the outer row; a `LET n = …` would shadow it where the call
    // merged a second column of that name.
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS n } RETURN count(*) AS c'),
    ).toBe(false);
  });

  test('a LITERAL and a PARAMETER yield inline, and answer the same', () => {
    expect(
      bag('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN 7 AS c } RETURN n.k AS n, c'),
    ).toEqual(bag('MATCH (n:P) MATCH (n)-[:T]->(x) RETURN n.k AS n, 7 AS c'));
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN 7 AS c } RETURN n.k AS n, c'),
    ).toBe(true);
  });

  test('SEVERAL computed yields inline into ONE let, and answer the same', () => {
    const q =
      'MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN x.k AS c, n.k AS d } RETURN c, d ORDER BY c';

    // ⚠️ THE `LET` SURVIVES HERE, AND THAT IS NOT AN OVERSIGHT. `inlineTrailingLet` folds a
    // ONE-ITEM `LET` only — a later item may read an earlier one (`LET a = n.k, b = a`), so
    // collecting them into one substitution map is a wrong answer, and that refusal predates
    // this rewrite. So a TWO-yield body inlines the CALL but stays off the rungs. The one-yield
    // shape above is the fast one; this is the honest shape of the partial win.
    expect(kinds(q)).toEqual(['match', 'let', 'return']);
    expect(bag(q)).toEqual(
      bag('MATCH (n:P) MATCH (n)-[r:T]->(x) RETURN x.k AS c, n.k AS d ORDER BY c'),
    );
  });

  test('a MIX of a pass-through and a computed yield inlines, and answers the same', () => {
    const q =
      'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN x, x.k AS c } RETURN x.k AS xk, c ORDER BY c';

    expect(kinds(q)).toEqual(['match', 'return']);
    expect(bag(q)).toEqual(
      bag('MATCH (n:P) MATCH (n)-[:T]->(x) RETURN x.k AS xk, x.k AS c ORDER BY c'),
    );
  });

  test('the ESCAPING REL variable is checked too, not just the node', () => {
    // `-[r:T]->` introduces `r` and the body yields only `x.k`, so `r` escapes as well.
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN x.k AS c } RETURN sum(c) AS t'),
    ).toBe(true);
    expect(
      inlined('MATCH (n:P) CALL (n) { MATCH (n)-[r:T]->(x) RETURN x.k AS c } RETURN c, r.z AS rz'),
    ).toBe(false);
  });

  test('OPTIONAL still declines with a computed yield', () => {
    expect(
      inlined(
        'MATCH (n:P) OPTIONAL CALL (n) { MATCH (n)-[:T]->(x) RETURN x.k AS c } RETURN count(*) AS t',
      ),
    ).toBe(false);
  });
});
