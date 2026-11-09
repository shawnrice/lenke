/**
 * WHICH OF THE TWO THREE-SEGMENT ROUTES ANSWERS THIS PATTERN (item 1708).
 *
 * ⚠️ ITS OWN MODULE BECAUSE A CAP SAID SO, AND THAT CAP IS DOING ITS JOB. Adding this test inline
 * put `shortcuts.ts` at 3,008 lines against a maximum of 3,000 — the same limit that moved item
 * 1685's degree product out, and its note applies verbatim: "the limit that fired is the one that
 * says 'this belongs somewhere else', not a formality to raise". It also gives the choice a
 * testable home, which `perf-gate-needs-its-own-test` wants for any route decision.
 *
 * ⚠️ A LEAF MODULE: `InteriorGates` is declared here rather than imported from `shortcuts.ts`,
 * which imports this — the same cycle `far-mask-drain.ts` and `csr-cache.ts` each had to avoid,
 * and `import/no-cycle` is an error in this repo.
 *
 * THE MEASUREMENT. Both routes forced on ONE fixture, four rows, two order-alternated rounds, one
 * row per process, each arm's built bundle HASHED to prove it was the code it claimed (a string
 * marker could not do it: a comment is stripped by the bundler and a single-use `const` is inlined
 * by it — two runs aborted on that before the hash guard went in):
 *
 * ```text
 *    row                      PRODUCT    SWEEP
 *    count 3-hop                 7.41     8.68   product 1.17x — item 301's direction, intact
 *    + start filter              8.91     8.94   tie
 *    + interior filter          17.40    11.04   SWEEP 1.58x
 *    + interior inline          18.46    10.75   SWEEP 1.72x
 * ```
 *
 * So the verdict splits by SHAPE. `threeSegmentRoute`'s existing comparison keys on label VACUITY
 * instead — a vacuous start label makes `narrow === graph.vertexCount` and picks the product even on
 * the shape where the sweep is 1.6x-1.7x better. Item 1706 observed that as "the interior row is
 * faster on a multi-label graph" without the attribution; this is the attribution.
 *
 * ⚠️ NOT ITEMS 301/310's REFUTED LEVER. Those routed EVERY three-segment chain to the sweep and
 * measured it losing, which the unfiltered row above reproduces at 1.17x. The interior-gated shape
 * is the one they never isolated, and it is the only one this admits.
 */
import type { Expr, Segment } from '../ast.js';
import { compilePredicate } from './core.js';
import { flattenConjuncts, freePredicateVars } from './expr-analysis.js';
import { inlineOf } from './inline-gate.js';
import type { InlinePred } from './inline-gate.js';

/**
 * Interior gates for a three-segment count, bucketed by the position each conjunct reads.
 *
 * ⚠️ DECLARED HERE AND IMPORTED BY `shortcuts.ts`, not the other way round — this is a LEAF module
 * and the reverse would be a cycle. It also keeps one declaration instead of two: the first draft
 * duplicated it, which is the kind of drift a shared type exists to prevent.
 */
export type InteriorGates = { b: readonly InlinePred[]; c: readonly InlinePred[] };

/**
 * Does either INTERIOR position carry a constraint?
 *
 * ⚠️ THE INLINE SPELLING HAS TO BE READ FROM THE SEGMENTS, NOT FROM `interiorPred`.
 * `inlineInteriorGate` sets that only for an inline `b`, so `(c {k: 2})` leaves it `undefined` while
 * being exactly the shape this prefers — the 1.72x row above. Testing the nodes covers all three
 * spellings (clause, inline `WHERE`, inline property) with one rule, which is the "one question, one
 * route" requirement items 219 and 1701 both turn on.
 *
 * `inlineOf` returning `null` is a constraint it REFUSES (a correlated property value). That counts
 * as constrained here: the caller declines such a pattern upstream, and treating it as unconstrained
 * would be the one reading that could route a shape this has not measured.
 */
export const interiorConstrained = (
  segments: readonly Segment[],
  interiorPred: InteriorGates | null | undefined,
): boolean => {
  if (
    interiorPred !== null &&
    interiorPred !== undefined &&
    (interiorPred.b.length > 0 || interiorPred.c.length > 0)
  ) {
    return true;
  }

  return inlineOf(segments[0].node) !== undefined || inlineOf(segments[1].node) !== undefined;
};

/**
 * The three-segment clause `WHERE`, SPLIT INTO CONJUNCTS and bucketed by the interior position each
 * one reads. `null` declines.
 *
 * ⚠️ IT USED TO ADMIT ONLY ONE POSITION, AND THAT WAS A 1411x EQUIVALENT-SPELLING GAP (item 1700).
 * The old test was `readsOnly(name)` — EVERY free variable of the whole clause had to be that one
 * name — so `WHERE b.k = 7 AND c.k > 60` had a free set of `{b, c}`, failed both tests, returned
 * `null`, and the query fell to the general row pipeline at **1411.1 ms against the inline
 * spelling's 1.0**, for the same count of 9,275. Only the b+c pair collapsed: a START or END
 * conjunct reaches the sweep (`a AND c` 2.2 ms, `b AND d` 1.3), and the three-segment path has no
 * second route of its own.
 *
 * ⚠️ AND THE MACHINERY WAS ALREADY THERE, which is what made this a reader bug rather than a
 * missing feature: `buildThreeHopCount` takes `{ b, c }` as two independent gate LISTS and the
 * INLINE spelling filled both. This makes the clause reader produce what the inline reader already
 * produced — item 219's "one question, one route" at the third position.
 *
 * Each conjunct must read EXACTLY ONE interior variable. A conjunct over the ends, over two
 * positions at once, or naming anything this pattern does not bind still declines, because the
 * product reaches `a` and `d` only as DEGREES and has no once-per-element place to gate them. That
 * is `chainGatesOf`'s rule (item 305) applied to the two positions this shape visits.
 *
 * `bindVar` is load-bearing: the conjunct reads `b.k`, so `inlineHolds` has to bind the element
 * under that name before evaluating it. Dropping it evaluates against an empty binding.
 *
 * ⚠️ EXPORTED BECAUSE IT IS A ROUTE CHOICE, AND A MUTATION PASS PROVED THE DIFFERENCE. Three
 * mutants — bucketing a `b` conjunct under `c`, never filling the `c` bucket, and not splitting the
 * clause at all — all SURVIVED the whole suite: each makes the reader NARROWER, so the shape
 * declines and the general pipeline returns the same answer. `interior-and-gates.test.ts`'s decline
 * cases assert answers, which cannot see a route. So the bucketing is asserted DIRECTLY here, the
 * way `csrDegreeProductApplies` and `gate-conjunct-route.test.ts` are — `perf-gate-needs-its-own-test`.
 */
export const interiorPredOf = (where: Expr, s1: Segment, s2: Segment): InteriorGates | null => {
  const bName = s1.node.variable;
  const cName = s2.node.variable;
  const b: InlinePred[] = [];
  const c: InlinePred[] = [];

  for (const conjunct of flattenConjuncts(where)) {
    const free = freePredicateVars(conjunct);

    // A constant conjunct (no free names) declines, as it did before: it is not a per-vertex test.
    if (free.size !== 1) {
      return null;
    }

    const [name] = free;

    if (bName !== undefined && name === bName) {
      b.push({ pred: compilePredicate(undefined, conjunct, bName), bindVar: bName });
    } else if (cName !== undefined && name === cName) {
      c.push({ pred: compilePredicate(undefined, conjunct, cName), bindVar: cName });
    } else {
      return null;
    }
  }

  if (b.length === 0 && c.length === 0) {
    return null;
  }

  return { b, c };
};
