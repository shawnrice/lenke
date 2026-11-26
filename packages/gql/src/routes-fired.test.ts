/**
 * WHICH fast-path detector fires for which query shape — a ROUTE assertion per detector.
 *
 * `compileLinear` ends by running twenty-one independent compile-time probes, and its own comment is
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

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/** The detector fields that came back non-null, sorted — i.e. the routes this query will take. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return (
    Object.entries(cl)
      // ⚠️ A RUNG IS A FUNCTION. Filtering on that rather than on "not null, and not `clauses`"
      // keeps this honest as `CLinear` grows: item 1510 added a `writes: boolean`, which is not a
      // rung, and the old predicate reported it as one. See `deferred-hop-order.test.ts`.
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort()
  );
};

describe('every fast-path detector fires for its own shape', () => {
  const CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    // --- counts -------------------------------------------------------------------------
    ['node count', 'MATCH (n:L) RETURN count(*) AS c', ['countShortcut']],
    ['hop count', 'MATCH (a:L)-[:R]->(b:L) RETURN count(*) AS c', ['countShortcut']],
    [
      /*
       * ⚠️⚠️ TWO RUNGS COMPILE FOR THIS SHAPE SINCE ITEM 2087, and the ORDER of this list is
       * alphabetical (the helper sorts), not precedence. `chainStarCount` is consumed ABOVE
       * `countShortcut` and DECLINES AT EXECUTION TIME when every label is vacuous — so with a
       * vacuous label `countShortcut` still answers (12.57 ms/rep via `twoHopUnfilteredCsrCount`),
       * and with a real one the level recurrence does (19.21 against the per-edge tally's 94.01).
       *
       * 🔑 THIS TEST CANNOT SEE WHICH ONE ANSWERS — it reads the compiled record, so a rung that is
       * merely WILLING appears here identically to one that fires. That is exactly how item 2087's
       * first attempt looked correct while being starved 357 lines down the chain.
       */
      'two-hop count',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(*) AS c',
      ['chainStarCount', 'countShortcut'],
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
      // ⚠️ `groupHopShortcut` JOINED THIS CASE AT ITEM 2011, and the far label is why. The shortcut
      // used to refuse a NEAR-keyed hop whose FAR end carried any label — one clause stricter than
      // its own runtime, which already picks the degree walk only when that label is vacuous and the
      // per-edge walk otherwise. The refusal cost 124x on the realistic corpus's own spelling.
      ['groupHopShortcut', 'groupedHopAggregate'],
    ],

    // --- projections --------------------------------------------------------------------
    ['node projection', 'MATCH (n:L) RETURN n.k AS k', ['nodeProjection']],
    ['node projection, the element itself', 'MATCH (n:L) RETURN n', ['nodeProjection']],
    ['hop projection', 'MATCH (a:L)-[:R]->(b:L) RETURN b.k AS k', ['hopProjection']],
    // Item 1619: the TWO-segment twin. `hopProjection` requires `segments.length === 1`, so the two
    // are disjoint by construction and each shape fires exactly one of them.
    [
      'two-hop projection',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k',
      ['hop2Projection'],
    ],
    // Item 1814: THREE segments and up. `detectChainProjection` requires `>= 3` and
    // `detectHop2Projection` exactly 2, so these two rows together are what holds that boundary —
    // the rungs are disjoint by construction and neither can starve the other.
    [
      'three-hop projection',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k',
      ['chainProjection'],
    ],
    [
      'four-hop projection',
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)-[:R]->(e) RETURN e.k AS k',
      ['chainProjection'],
    ],
    /**
     * ⚠️ `count(DISTINCT …)` OVER A CHAIN — item 1824. These two rungs are the reason this file's
     * count went 21 -> 23, and they are the ONLY compile-time guard on the route: removing the
     * branch that consumes either one is answer-equivalent, so nothing else in the suite notices
     * (this file's own header records that for all of them).
     */
    [
      'three-hop count(DISTINCT)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN count(DISTINCT d.k) AS c',
      // ⚠️ BOTH FIRE, and that is the design rather than a redundancy: `chainFoldLevels` (item 2010)
      // is a LEVEL RECURRENCE for the same shapes `chainFoldedAggregate` answers by walking every
      // path, and it is strictly narrower — so both compile and `clauses.ts` runs the level arm
      // first. A shape the level arm declines still has the path arm compiled and waiting.
      ['chainFoldLevels', 'chainFoldedAggregate'],
    ],
    [
      'two-hop count(DISTINCT)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c.k) AS c',
      ['chainFoldLevels', 'hop2FoldedAggregate'],
    ],
    /*
     * 🔑 THE ROW TWIN of the case above (item 2119). Both compute the same distinct set; the count
     * reports its size, which is free on top — so the row spelling was paying **27x to do strictly
     * less** (517.5 ms against 18.8 on the same 97 values) because only the count had the recurrence.
     *
     * ⚠️ `hop2Projection` IS STILL WILLING and is listed: it claimed this shape before item 2119 and is
     * the 517.5. `chainDistinctLevels` is consulted above it, which is the only precedence change that
     * item made.
     */
    [
      'two-hop RETURN DISTINCT <far prop>',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN DISTINCT c.k AS k',
      ['chainDistinctLevels', 'hop2Projection'],
    ],
    /**
     * ⚠️ ITEM 1830's ALLOWLIST — ADMISSIONS NOW, AND THAT IS ITEM 2409's CHANGE TO THIS FILE.
     *
     * It used to read: _"the refusals are the load-bearing half: `sum`/`avg` are order-sensitive in
     * the last ulp … so admitting any of them would break byte-identity with Rust"_, and carried
     * three cases asserting an EMPTY rung list for `sum`, `avg` and `collect`.
     *
     * 🔑🔑 TWO THINGS WERE WRONG WITH THAT, and item 2408 found the second one the hard way:
     *
     * 1. Item 2401 (owner ruling) replaced bit-identity for `sum`/`avg` with a PRECISION contract,
     *    and item 2400 freed the premise about walk order underneath it. So the stated reason is
     *    gone — `chain-fold-levels.ts`'s header carries the error-bound argument that replaced it.
     * 2. ⚠️ **ASSERTING THE REFUSAL GIVES A NARROWING MUTANT A GREENER FILE, NOT A REDDER ONE.**
     *    An `[]` expectation passes more easily the fewer rungs fire, so it cannot catch the
     *    regression it was written for — only the ADMISSION can ([[perf-gate-needs-its-own-test]],
     *    as item 2408 restated it). The `sum`/`avg` cases below now name the rung.
     *
     * ⚠️ `collect` KEEPS ITS REFUSAL and keeps its `[]`, for a reason no ruling touches: a weighted
     * fold cannot emit `u_v` copies of a value without materializing the list it exists to avoid.
     * Item 2404 made its element order unspecified, so order is not the blocker — there is simply
     * nothing to win. Its `[]` is honest about being the weaker form of assertion.
     */
    [
      'three-hop max',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN max(d.k) AS m',
      ['chainFoldLevels', 'chainFoldedAggregate'],
    ],
    [
      'two-hop min',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN min(c.k) AS m',
      ['chainFoldLevels', 'hop2FoldedAggregate'],
    ],
    [
      'three-hop count(x)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN count(d.k) AS c',
      ['chainFoldLevels', 'chainFoldedAggregate'],
    ],
    /*
     * ⚠️ ONLY `chainFoldLevels` FIRES, not the path arm below it. `chainFoldedAggregate` reads
     * `proj.foldedAggs`, which is undefined for `sum`/`avg` because the shared `foldFor` has no
     * entry — so unlike `min`/`max`/`count` above, these two have NO second rung waiting. That is
     * what makes the bail hand the query to the GENERAL path rather than to a sibling rung.
     */
    [
      'three-hop SUM is ADMITTED to the level fold (item 2409)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN sum(d.k) AS s',
      /*
       * ⚠️ TWO RUNGS COMPILE FOR THIS SHAPE SINCE ITEM 2411, and this list is alphabetical, NOT
       * precedence. `chainFoldLevels` is consulted ABOVE `chainFoldedAggregate` (see `CLinear`'s
       * own note), so the level fold still answers this one and the path-walk rung is the fallback
       * for the shapes it declines. 🔑 This harness reads the COMPILED RECORD, so it cannot see
       * which of the two answers — the A/B timing is what says the plain shape did not regress.
       */
      ['chainFoldLevels', 'chainFoldedAggregate'],
    ],
    [
      'two-hop AVG is ADMITTED to the level fold (item 2409)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN avg(c.k) AS a',
      // The two-hop twin of the pair above — `hop2FoldedAggregate` is the fallback at this width.
      ['chainFoldLevels', 'hop2FoldedAggregate'],
    ],
    /*
     * ⚠️⚠️ **AN AGGREGATE OVER A NON-FAR VARIABLE MUST STAY OFF — item 2410, and these rows are the
     * route claim the ANSWER tests cannot make.** `foldLevel` binds the far variable and nothing
     * else, so this rung answered `count(a.n)` as 0 over 1,280,000 paths. The pair below is the whole
     * condition: the SAME chain with the SAME aggregate differs only in which variable it reads, and
     * one routes while the other must not.
     *
     * ⚠️ An `[]` expectation passes more easily the fewer rungs fire (item 2409's own note), so the
     * far-end row above is what makes these two readable: it fires, and these do not.
     */
    [
      'count over the START variable stays off the level fold (item 2410)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN count(a.k) AS c',
      /*
       * 🔑 IT DOES NOT FALL TO THE GENERAL MATCHER — it lands on `chainFoldedAggregate`, the
       * path-walk twin that binds EVERY variable and so answers this correctly. That is the right
       * shape of the fix: the level fold declines what it cannot bind, and a rung that can takes it.
       * ⚠️ So the `[]` rows below are narrower claims than this one: `sum` has no such twin yet
       * because `ORDER_INVARIANT_AGGREGATES` still refuses it there.
       */
      ['chainFoldedAggregate'],
    ],
    [
      'sum over a MIDDLE variable stays off the level fold (item 2410)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN sum(b.k) AS s',
      // ⚠️ `[]` UNTIL ITEM 2411 WIDENED THE PATH-WALK RUNG — which is the point of the pair: the
      // level fold declines what it cannot bind, and the rung that binds every variable takes it.
      ['chainFoldedAggregate'],
    ],
    [
      'an argument reading the far variable AND another stays off (item 2410)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN sum(a.k + d.k) AS s',
      ['chainFoldedAggregate'],
    ],
    /*
     * ⚠️ A DISTINCT SUM STAYS OFF, and this one is a real refusal rather than a stale one: a
     * weighted fold over a deduped multiset has no weight to apply.
     */
    [
      'sum(DISTINCT) stays off the rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN sum(DISTINCT d.k) AS s',
      [],
    ],
    [
      'COLLECT must stay OFF the rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN collect(d.k) AS ks',
      [],
    ],
    [
      'a WRAPPED aggregate stays off',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN max(d.k) + 0 AS m',
      [],
    ],
    /**
     * ⚠️ ITEM 1832's GROUPED COUNT, admissions and refusals. The refusals are where the risk is:
     * TWO group keys would need a composite key (`buildGroups` keeps the stringify for that case
     * precisely because a plain join is not injective across a string cell), and a non-`count(*)`
     * aggregate is item 1829's order-sensitivity question again. Both decline, and nothing in the
     * ANSWERS would reveal it if they stopped declining.
     */
    /*
     * ⚠️ KEYED ON THE **FAR** END, which is why `chainGroupedLevels` does NOT join this case: its
     * recurrence answers walks-per-START, so a far key is not a per-start quantity. The two cases
     * below are the near-keyed shapes it does take.
     */
    [
      'three-hop grouped count',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k, count(*) AS c',
      ['chainGroupedCount'],
    ],
    [
      'chain grouped count on the NEAR key',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN a.k AS k, count(*) AS c',
      // ⚠️ TWO segments, so the overlap is `hop2GroupedCount` — `chainGroupedCount` wants three or
      // more. `chainGroupedLevels` admits 2+ and sits above both; the ladder runs it first.
      ['chainGroupedLevels', 'hop2GroupedCount'],
    ],
    /*
     * ⚠️⚠️ **THIS CASE PINS A 2.96x SPELLING CLIFF.** `LET g = a.k … GROUP BY g` parses as THREE
     * clauses and `detectChainGroupedCount` opens with `clauses.length !== 2`, so it reached NO rung
     * — 72.08 ms against the aliased form's 24.38 for the same groups (item 2012). `GROUP BY` takes
     * a BOUND NAME, so this is the only way to write the grouping explicitly, and it is the form
     * item 1817's realistic corpus uses. **The expectation listing ONLY `chainGroupedLevels` is the
     * assertion that the old rung still declines it** — if someone widens that rung later, this case
     * tells them the cliff is theirs to re-check.
     */
    [
      'chain grouped count, LET + GROUP BY spelling',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) LET g = a.k RETURN g, count(*) AS c GROUP BY g',
      ['chainGroupedLevels'],
    ],
    [
      'two-hop grouped count',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k, count(*) AS c',
      ['hop2GroupedCount'],
    ],
    /**
     * ⚠️ EVERY REFUSAL IS ASSERTED AT BOTH WIDTHS, and a mutation run is why. The two rungs live in
     * DIFFERENT FILES (`hop2-projection.ts` and `chain-projection.ts`), so a refusal pinned only at
     * two hops leaves the three-hop copy unguarded — and a mutant in the chain file sailed through
     * until these were doubled. A duplicated rule needs a duplicated test.
     */
    [
      'TWO group keys stay off (hop2)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k, c.s AS s, count(*) AS c',
      [],
    ],
    [
      'TWO group keys stay off (chain)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k, d.s AS s, count(*) AS c',
      [],
    ],
    [
      'a grouped SUM stays off (hop2)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k, sum(c.n) AS s',
      [],
    ],
    [
      'a grouped SUM stays off (chain)',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k, sum(d.n) AS s',
      [],
    ],
    [
      'an explicit GROUP BY stays off',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k, count(*) AS c GROUP BY k',
      [],
    ],
    /**
     * ⚠️ MULTI-COLUMN `DISTINCT` at ONE hop — item 1825, and the pair below is what keeps the two
     * one-hop DISTINCT rungs DISJOINT. `hopDistinctProjection` requires two or more columns;
     * `distinctProjection` serves exactly one. An `toEqual` on the whole fired-detector list is
     * what makes that a real assertion: if either rung widened to overlap the other, the one-column
     * case would report BOTH names and fail here — whereas a runtime precedence bug between them
     * would be invisible, since both routes return the same answer.
     */
    [
      'one-hop multi-column DISTINCT',
      'MATCH (a:L)-[:R]->(b:L) RETURN DISTINCT b.k AS k, b.s AS s',
      ['hopDistinctProjection'],
    ],
    [
      'one-hop SINGLE-column DISTINCT stays with the while-walking rung',
      'MATCH (a:L)-[:R]->(b:L) RETURN DISTINCT b.k AS k',
      ['distinctProjection'],
    ],
    /**
     * ⚠️ `ORDER BY` over the deeper widths — item 1827. Disjoint from every projection rung by
     * construction: those gate on `plainRowProjectionIgnoringDistinct`, which refuses an `orderBy`,
     * and these REQUIRE one — so no chain ordering between them can starve anything (item 1825's
     * lesson). The one-hop twin is `hopProjection`, which has admitted a sort since item 607.
     */
    [
      'two-hop ordered projection',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k ORDER BY k',
      ['hop2OrderedProjection'],
    ],
    [
      'three-hop ordered projection',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k ORDER BY k',
      ['chainOrderedProjection'],
    ],
    [
      'one-hop ordered projection keeps its own rung',
      'MATCH (a:L)-[:R]->(b:L) RETURN b.k AS k ORDER BY k',
      ['hopProjection'],
    ],
    /**
     * ⚠️ ~~A WINDOWED SORT MUST NOT REACH THE DEEPER ORDERED RUNGS~~ — **REVERSED AT ITEM 1852,
     * and the premise was wrong rather than merely outdated.** This row used to assert `[]` and
     * said admitting a window "loses `boundedTopRows`' heap — ~280x per `sortOf`".
     *
     * It loses nothing: the ordered rungs sort through `sortedRows` → `sortRowsByColumns`, which
     * IS where that heap lives. Refusing the window only at depth 2 and up sent the query to the
     * general matcher, and the measurement is one-sided in both regimes —
     *
     *     chain3 ORDER BY x LIMIT 10        101.43 ms -> 33.84   3.00x   (inside the heap)
     *     chain3 ORDER BY x LIMIT 100000    211.26 ms -> 37.32   5.66x   (past its crossover)
     *     chain3 ORDER BY x SKIP 5          387.91 ms -> 38.92   9.97x
     *
     * — including the large-limit cell the old note specifically feared. `detectNodeProjection`
     * and `detectHopProjection` had shipped this at depth 0 and 1 since items 1062 and 701, so the
     * refusal was also an inconsistency. The rows stay as ROUTE assertions, with the expectation
     * flipped: admitting a window is still answer-equivalent, so only a route test can hold it.
     */
    [
      'a two-hop sorted LIMIT now takes the ordered rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k ORDER BY k LIMIT 3',
      ['hop2OrderedProjection'],
    ],
    [
      'a three-hop sorted SKIP now takes the ordered rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k ORDER BY k SKIP 2',
      ['chainOrderedProjection'],
    ],
    /**
     * ⚠️ THE SKIP-ONLY, UNORDERED PAGE AT DEPTH 2 AND 3+ — item 1885, and these rows are the ONLY
     * thing that holds it: admitting the page is answer-equivalent (`skip-only-page-parity.ts`
     * establishes that cross-engine), so no value test can tell the routes apart. Before it, every
     * window sent these widths to the general matcher at **26.9/36.2/49.6/59.5 ms against a ~6 ms
     * unpaged twin**; after, `rung-gap-screen.mjs` reads 5.5/3.0/3.6/4.4.
     *
     * ⚠️ AND THE `LIMIT` ROWS BELOW ASSERT A DELIBERATE DECLINE, which is the half a reader will
     * want to change first. The general path is LAZY — `LIMIT 5` can stop after five rows — so
     * handing a bare limit to a rung that materializes every row and slices would be a regression
     * dressed as a win. `skipOnlyPage` refuses a `limit` for that reason and these rows pin it.
     */
    [
      'a two-hop SKIP with no ORDER BY takes the paged rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k SKIP 2',
      ['hop2PagedProjection'],
    ],
    [
      'a three-hop OFFSET with no ORDER BY takes the paged rung',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k OFFSET 2',
      ['chainPagedProjection'],
    ],
    [
      'a two-hop bare LIMIT is DECLINED on purpose — the general path is lazy',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k LIMIT 2',
      [],
    ],
    [
      'a three-hop SKIP plus LIMIT is DECLINED on purpose — likewise',
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k SKIP 2 LIMIT 2',
      [],
    ],
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
    // ⚠️ ITEM 1198 RE-ROUTED THIS DELIBERATELY, and this row is how that showed up: item 1197 left
    // the FOLD path declining and asserted it here, so widening it failed this test rather than
    // passing silently. That is the whole point of the file (its header: "if a future change
    // deliberately re-routes a shape, update the row and say why in the audit"). Priced at
    // 8.12-9.46x before the change — `upper(max(a.str))` 47.8ms against `min(a.num)`'s 3.9 — so
    // the fold sibling was worth what the collecting path was, which was NOT knowable from the
    // collecting measurement.
    [
      'WRAPPED fold aggregate (arithmetic)',
      'MATCH (n:L) RETURN abs(min(n.k) - 10) AS c',
      ['nodeAggregate'],
    ],
    ['WRAPPED fold aggregate (count)', 'MATCH (n:L) RETURN count(n.k) * 2 AS c', ['nodeAggregate']],
    [
      'WRAPPED fold aggregate (string extremum)',
      'MATCH (n:L) RETURN upper(max(n.s)) AS c',
      ['nodeAggregate'],
    ],
    // The arity gate still holds on the fold path too: one accumulator, so a second aggregate
    // anywhere in the item must fall to the general path.
    [
      'a wrapped fold plus a SECOND aggregate declines',
      'MATCH (n:L) RETURN abs(min(n.k)) + count(*) AS c',
      [],
    ],
    // And the MULTI-aggregate route is untouched — two items still go to their own detector.
    [
      'two aggregate ITEMS still take the multi route',
      'MATCH (n:L) RETURN min(n.k) AS a, max(n.k) AS b',
      ['multiNodeAggregate'],
    ],
    ['hop aggregate', 'MATCH (a:L)-[:R]->(b:L) RETURN max(b.k) AS m', ['hopAggregate']],
    /*
     * ⚠️ `sum`, NOT just `max`, since item 2401. `sum` reaches this rung too, and before 2401 it
     * reached it only on a FORCED start-driven walk (`ORDER_SENSITIVE_AGGREGATES` conflated "this
     * rung admits the aggregate" with "its order is observable"). Splitting those let `sum` take the
     * far-driven walk: 280.2 -> 24.3 ms on the bench row, 11.5x.
     *
     * This row asserts the rung FIRES for `sum`. It deliberately does not try to assert WHICH walk
     * was chosen — that is internal to the rung, and the evidence for it is the 11.5x plus the
     * closed-form fan-in oracles in `hop-sum-fold.test.ts`, which is where a dropped multiplicity
     * would show up as a wrong answer.
     */
    ['hop aggregate, sum', 'MATCH (a:L)-[:R]->(b:L) RETURN sum(b.k) AS s', ['hopAggregate']],
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

    // --- the skip-only page (item 1776) -------------------------------------------------
    //
    // A `SKIP` with no `LIMIT` takes the node-projection rung and slices; a `LIMIT`, with or
    // without a skip, must still decline, because the general path is LAZY for it and stops after
    // `skip + limit` rows where this rung materializes everything (360x in the general path's
    // favour, item 1775). The four rows below are that one rule's whole truth table, and the
    // negative three are the load-bearing half: `skip-only-page.test.ts` compares the rung's rows
    // against the general path's and so passes either way if the ROUTE silently changes.
    ['a skip-only page', 'MATCH (n:L) RETURN n.k AS k OFFSET 2', ['nodeProjection']],
    [
      'a skip-only page, two columns',
      'MATCH (n:L) RETURN n.k AS k, n.n AS t OFFSET 2',
      ['nodeProjection'],
    ],
    ['a bare LIMIT still declines', 'MATCH (n:L) RETURN n.k AS k LIMIT 2', []],
    ['a skip WITH a limit still declines', 'MATCH (n:L) RETURN n.k AS k OFFSET 2 LIMIT 2', []],
    // ⚠️ A PARAMETERIZED SKIP TAKES THE RUNG TOO, SINCE ITEM 1778. The sibling rules decline a
    // parameterized window because a `LIMIT $n` decides between a heap and a sort-and-slice — the
    // ROUTE depends on the value, while the plan cache is shared across params. A skip-only page
    // has no such dependence, so declining it only cost a 7.3x gap between two spellings of one
    // query. A parameterized LIMIT still declines, which is the row below.
    [
      'a PARAMETERIZED skip takes the rung',
      'MATCH (n:L) RETURN n.k AS k OFFSET $s',
      ['nodeProjection'],
    ],
    ['a PARAMETERIZED limit still declines', 'MATCH (n:L) RETURN n.k AS k LIMIT $n', []],
    // The hop rung too (item 1777 gave it the page, 1778 the parameterized spelling).
    [
      'a skip-only page on a hop',
      'MATCH (a:L)-[:R]->(b) RETURN b.k AS k OFFSET 2',
      ['hopProjection'],
    ],
    [
      'a PARAMETERIZED skip-only page on a hop',
      'MATCH (a:L)-[:R]->(b) RETURN b.k AS k OFFSET $s',
      ['hopProjection'],
    ],

    // --- optional hops ------------------------------------------------------------------
    [
      'optional hop count',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN count(*) AS c',
      ['optionalHopCount'],
    ],
    /*
     * 🔑 THE GROUPED TWIN (item 2123). Each half had a rung and the PAIR did not, which cost 18x.
     * ⚠️ The two cannot compete: this one needs a two-item projection and its sibling a bare
     * `count(*)`, so they are disjoint by construction.
     */
    [
      'optional hop GROUPED count',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN a.k AS g, count(*) AS c',
      ['optionalGroupedHopCount'],
    ],
    /*
     * ⚠️ `ANY SHORTEST` + `count(*)` (item 2151). The selector is what makes this DISJOINT from
     * `varLengthCount` beside it: that rung refuses any selector, this one requires `anyShortest`.
     * 🔑 And bare `ANY` is NOT this shape — `'any'` dedups per ENDPOINT where `'anyShortest'` dedups
     * per endpoint PAIR, so the two count differently.
     */
    [
      'ANY SHORTEST endpoint count',
      'MATCH ANY SHORTEST (a:L)-[:R]->{1,3}(b:L) RETURN count(*) AS c',
      ['shortestEndpointCount'],
    ],
    [
      // Item 1853: the multi-column DISTINCT over a node scan, which had no rung at all while
      // every hop and chain width had one — 27.7x the one-column spelling.
      'node scan, multi-column DISTINCT',
      'MATCH (n:L) RETURN DISTINCT n.k AS k, n.j AS j',
      ['nodeDistinctProjection'],
    ],
    [
      'optional hop projection',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN b.k AS k',
      ['optionalHopProjection'],
    ],
    [
      // Item 1849: the same shape with a sort over an output column, which used to fall off the
      // rung entirely at 18.7x a row.
      'optional hop projection, ordered',
      'MATCH (a:L) OPTIONAL MATCH (a)-[:R]->(b) RETURN b.k AS k ORDER BY k',
      ['optionalOrderedProjection'],
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

  /**
   * The `CLinear` fields that are NOT detectors, named rather than inferred.
   *
   * ⚠️ This list is the exception register for the guard below, and it must stay as short as the
   * truth allows. The count cannot be derived by filtering on `typeof v === 'function'` the way
   * `routes()` does, because this test needs ALL twenty-one detectors and most are `null` for any
   * one query shape. So a new non-detector field has to be added here by hand — and the guard
   * failing is how you find out, which is what happened to item 1510's `writes`.
   */
  const NON_DETECTORS = new Set(['clauses', 'writes']);

  // Every one is covered by the table above. Asserted rather than claimed, so a
  // detector added later without a route case fails HERE instead of going unguarded.
  it('covers all thirty-eight detectors', () => {
    const covered = new Set(CASES.flatMap(([, , want]) => want));
    const all = new Set(
      Object.keys(
        compileLinear(
          (parse('MATCH (n:L) RETURN count(*) AS c') as never as { parts: readonly never[] })
            .parts[0],
        ) as unknown as Record<string, unknown>,
      ).filter((k) => !NON_DETECTORS.has(k)),
    );

    expect([...all].filter((k) => !covered.has(k)).sort()).toEqual([]);
    // 34 -> 35 at item 2087 (`chainStarCount`). This number failing is the guard WORKING: it is how
    // a detector added without a route case above gets found.
    // 35 -> 36 at item 2119 (`chainDistinctLevels`).
    // 36 -> 37 at item 2123 (`optionalGroupedHopCount`).
    // 37 -> 38 at item 2151 (`shortestEndpointCount`).
    expect(all.size).toBe(38);
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
