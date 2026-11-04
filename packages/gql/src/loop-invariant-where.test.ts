import { describe, expect, test } from 'bun:test';

import { carriedWhere, loopInvariantWhere } from './executor/hop-projection.js';
import { parsePredicate } from './parser.js';

/**
 * `loopInvariantWhere`, tested directly, because the ROUTE it picks is answer-equivalent (item 1437).
 *
 * Item 1437 found `MATCH (a:P)-[:E]->(b:P) WHERE true RETURN b.n` at **194.63 ms against the
 * identical unfiltered row's 26.08** — 7.46x — because `carriedWhere` declined any predicate that
 * read neither endpoint nor the rel, and a predicate with NO free variables reads none of them. The
 * whole shape fell off hop projection to the general matcher (`walkSegments`, `matchPattern`,
 * `expand`, `evalLabelExpr` were the top frames). A REAL far predicate on the same row costs only
 * 2.41x, so the CONSTANT was 3.1x worse than doing actual per-edge work. Admitting it is 4.18x.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. Admitting a predicate to a different walk changes no answer, so
 * all 3,638 tests in this package pass with the change reverted — they passed before it and after
 * it, identically. That is the repo's recorded trap: *a route choice is answer-equivalent, so every
 * mutant survives the differential tests; extract the arithmetic as a pure fn and unit-test it.*
 * `loop-invariant-where-rows.test.ts` covers what the route must still ANSWER; this one is the only
 * thing that can see the route decision itself, and it is the only guard against the decline
 * silently coming back.
 *
 * Both halves of the predicate are asserted, because either one alone is wrong:
 *
 *   * drop the free-variable test and `WHERE b.n > 5` would be treated as invariant — a per-row
 *     predicate evaluated once, which is a WRONG ANSWER rather than a slow one.
 *   * drop `rowLocal` and a zero-variable FAULTING subquery would be hoisted into a walk whose
 *     raise parity assumes row-local evaluation (item 175).
 */

/** The predicate parser takes bare predicate text, which is exactly the carried `WHERE`'s shape. */
const inv = (src: string): boolean => loopInvariantWhere(parsePredicate(src));

describe('a predicate with no free variables is invariant (item 1437)', () => {
  test('⚠️ the literals — the shape that cost 7.46x', () => {
    expect(inv('true')).toBe(true);
    expect(inv('false')).toBe(true);
  });

  test('arithmetic and comparison over constants', () => {
    expect(inv('1 = 1')).toBe(true);
    expect(inv('1 < 2')).toBe(true);
    expect(inv('1 + 1 = 2')).toBe(true);
  });

  test('a PARAMETER is not a pattern variable, so a param-only predicate is invariant', () => {
    // The generated-query shape, and the one worth the most in practice: a builder that emits an
    // optional filter as `WHERE $flag` or `WHERE $min < $max` gets the fast walk now.
    expect(inv('$flag')).toBe(true);
    expect(inv('$min < $max')).toBe(true);
    expect(inv('$a = 1 AND $b = 2')).toBe(true);
  });

  test('a conjunction of constants, where every conjunct is invariant', () => {
    expect(inv('true AND true')).toBe(true);
    expect(inv('true OR false')).toBe(true);
    expect(inv('NOT false')).toBe(true);
  });
});

describe('a predicate that reads ANY pattern variable is not invariant (item 1437)', () => {
  test('⚠️ the far endpoint — treating this as invariant would be a wrong answer', () => {
    // THE MUTANT-KILLER for the free-variable half. `b.n > 5` differs per row; an invariant carry
    // would evaluate it once and apply that verdict to every row.
    expect(inv('b.n > 5')).toBe(false);
  });

  test('the start endpoint', () => {
    expect(inv('a.n > 5')).toBe(false);
  });

  test('a rel variable', () => {
    expect(inv('r.w < 100')).toBe(false);
  });

  test('a variable buried inside an otherwise-constant expression', () => {
    // The free-variable test must be over the WHOLE expression, not its outermost node.
    expect(inv('true AND b.n > 5')).toBe(false);
    expect(inv('1 = 1 OR a.k = 2')).toBe(false);
    expect(inv('NOT (b.n > 5)')).toBe(false);
    expect(inv('$p = b.n')).toBe(false);
  });
});

describe('`rowLocal` is required even with no free variables (item 1437)', () => {
  test('⚠️ a zero-variable SUBQUERY is not carried, however constant it looks', () => {
    // THE MUTANT-KILLER for the `rowLocal` half, and the reason the two tests are separate: this
    // predicate has NO free variables — the pattern binds its own `z` — so the free-variable half
    // admits it and only `rowLocal` refuses. Item 175 gave the seed gate a cheap-conjunct-first
    // order precisely so a faulting subquery stays unreached, and a walk that evaluates the whole
    // predicate at once loses that guarantee.
    expect(inv('EXISTS { MATCH (z:P) }')).toBe(false);
  });

  test('and inside a conjunction, where the other conjunct is a harmless constant', () => {
    expect(inv('true AND EXISTS { MATCH (z:P) }')).toBe(false);
  });
});

/**
 * ⚠️ THE WIRING, which the block above cannot see.
 *
 * `loopInvariantWhere` being right is necessary and not sufficient: a mutant that deletes the branch
 * calling it from `carriedWhere` leaves the pure fn intact and every test above green, and the
 * decline comes straight back at 7.46x. That is the repo's recorded shape — *export the composition
 * or the unwired mutant survives* — so `carriedWhere` is exported for this block alone.
 *
 * `startOnly: true` is the specific claim, not merely "not null": the start-gated closure is the one
 * whose contract an invariant predicate wants (it gates a vertex BEFORE reading its adjacency and
 * already carries items 139-145' raise parity), and a carry that resolved to the general per-edge
 * closure instead would measure 2.41x rather than 4.18x while answering identically.
 */
describe('the invariant carry is WIRED into carriedWhere (item 1437)', () => {
  const carry = (src: string, relVar?: string) =>
    carriedWhere(parsePredicate(src), 'b', 'a', relVar);

  test('⚠️ `WHERE true` is carried as START-ONLY, reading nothing', () => {
    expect(carry('true')).toEqual({ needsStart: false, startOnly: true, needsRel: false });
  });

  test('a param-only predicate too, which is the generated-query shape', () => {
    expect(carry('$flag')).toEqual({ needsStart: false, startOnly: true, needsRel: false });
    expect(carry('$min < $max')).toEqual({ needsStart: false, startOnly: true, needsRel: false });
  });

  test('a zero-variable subquery still DECLINES, so `rowLocal` is wired as well', () => {
    expect(carry('EXISTS { MATCH (z:P) }')).toBeNull();
  });

  test('and the ordinary classifications are untouched by the new branch', () => {
    // The regression guard: these three are what `carriedWhere` decided before item 1437, and the
    // new branch sits above them. A far predicate reads the far end; a start predicate is start-only
    // and needs the start bound; a rel predicate is neither.
    expect(carry('b.n > 5')).toEqual({ needsStart: false, startOnly: false, needsRel: false });
    expect(carry('a.n > 5')).toEqual({ needsStart: true, startOnly: true, needsRel: false });
    expect(carry('r.w < 100', 'r')).toEqual({
      needsStart: false,
      startOnly: false,
      needsRel: true,
    });
    // A name the pattern does not bind is refused outright, which is the first test in the function
    // and must not be reachable past the invariant branch.
    expect(carry('zzz.n > 5')).toBeNull();
  });

  test('an absent `WHERE` is the no-op carry, not the invariant one', () => {
    expect(carriedWhere(undefined, 'b', 'a', undefined)).toEqual({
      needsStart: false,
      startOnly: false,
      needsRel: false,
    });
  });
});
