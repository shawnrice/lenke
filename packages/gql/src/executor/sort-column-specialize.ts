/**
 * ELIMINATING THE ORDER BY COMPARATOR'S DEAD BRANCHES, under a precondition checked once (item 1711).
 *
 * `sortRowsByColumns` calls `compareSort` once per comparison, which is ~20M times for a 1,000,000-row
 * sort. For a column whose values are all one type and never null, almost everything that chain does is
 * provably dead: four `isNullish` tests, two `typeRank` switches, the temporal/array/record ladder, the
 * NaN check, and two call layers. This scans the column ONCE and, when it qualifies, sorts with the
 * reduced comparator instead.
 *
 * ⚠️ THIS IS NOT A SECOND DERIVATION OF "WHICH ROW SORTS FIRST", which is what `sortRowsByColumns`'s
 * own note forbids ("a second derivation ... is the one thing byte-identity cannot survive"). It is
 * branch ELIMINATION, and the reduction is exact in both directions:
 *
 *   - STRINGS, non-null, surrogate-free. `compareSort` takes neither null branch, `compareValues` takes
 *     neither, both ranks are 1 so the rank branch is dead, the value is not temporal/array/record and
 *     the rank is not 4, so it reaches `compareCodePoints(x, y)` — whose OWN fast path, when neither
 *     string holds a high surrogate, is literally `a < b ? -1 : a > b ? 1 : 0`. Identical by inspection.
 *   - NUMBERS, non-null, NaN-free. Same dead null branches, both ranks 0, not temporal/array/record,
 *     rank is not 4, not the string pair, and the NaN block is skipped because neither is NaN — leaving
 *     `x < y ? -1 : x > y ? 1 : 0`, the final expression of `compareValues` itself.
 *
 * Anything the precondition does not admit — a null, a mixed-type column, NaN, a temporal, a list, a
 * record, an element, or a string holding a high surrogate — returns `generic` and the untouched
 * `compareSort` runs. The guard regex is IMPORTED from `values.ts` rather than copied, so there is one
 * definition of the surrogate question.
 *
 * THE MEASUREMENT (one row per process, 14 reps, drop 3, median; order-alternated rounds; every
 * arm's built bundle HASHED to prove it was the code it claimed; `hopsingleyield` — the same
 * hop+projection with NO sort — carried in every run as the drift gauge). On a QUIET machine,
 * 1,000,000 rows:
 *
 * ```text
 *    row                        PRE          POST       ratio
 *    ORDER BY a string      896.9/765.6   525.3/528.0   1.71x / 1.45x
 *    no sort (control)       80.7/84.5     95.7/87.4    0.84x / 0.97x  <- drift, AGAINST the change
 * ```
 *
 * POST is stable at 525-528 across rounds while PRE ranges 766-897, so the spread is on the
 * PRISTINE side. The control moved up to 16% the WRONG way, which makes these numbers conservative
 * rather than flattered. Quote ~1.45x as the floor of the range.
 *
 * ⚠️ LOAD CONTAMINATION VOIDED AN EARLIER RUN, AND THE GAUGE IS HOW IT WAS CAUGHT. One run read
 * every absolute ~1.8x high — the control went 82-92 ms to 154-165 — because 48 foreign
 * `while :; do :; done` spinners had the box at load 25. The RATIOS still looked plausible (1.23x,
 * 1.53x), which is the trap: a contaminated run does not announce itself in the ratio. Re-run gated
 * on `/proc/loadavg`, and distrust any reading whose control absolute has moved off its usual band.
 *
 * ⚠️ A NUMERIC ARM WAS BUILT, MEASURED AND DROPPED — do not rebuild it without reading this.
 * It classified an all-number, NaN-free column and used the same reduced comparator (for numbers
 * `compareValues` also ends in `x < y ? -1 : x > y ? 1 : 0`, so the reduction was equally exact).
 * Six readings across four runs: **0.93x, 1.05x, 1.06x, 1.11x, 1.14x, 1.18x** — it STRADDLES 1.0,
 * and on the quiet machine the adverse round put it at 0.93x while the control moved 0.84x. The
 * best evidence for it was POST against a string-only build (1.053x, 1.112x, matched controls), and
 * that is not enough to ship a second code path, a second precondition (NaN) and a scan that every
 * sorted numeric column pays.
 *
 * WHY IT NETS TO NOTHING WHILE THE STRING ARM NETS 1.45x, which is the part worth keeping: a FLOOR
 * arm (reduced comparator, NO scan) measured 1.25x on the numeric row, so the comparator reduction
 * IS worth ~25% there — the O(n) scan eats it. The string comparator saves far more per
 * comparison (a `compareCodePoints` call plus two regex tests plus the ladder, against the ladder
 * alone), so the same scan is cheap relative to the saving. THE OPEN QUESTION IS THEREFORE A
 * CHEAPER CLASSIFICATION, NOT THIS ARM. Rebuilding the arm as written will measure ~1.0x again.
 *
 * ⚠️ THE SCAN IS PURE COST AND BUYS NO WARM-UP — tested, because the OPPOSITE looked true. A
 * three-arm run put POST ahead of a NO-SCAN floor build in both rounds, which is impossible if the
 * floor is really the floor, and the tempting story was that the scan pre-touches every `row[col]`
 * so the comparator's ~20M property reads start monomorphic. REFUTED by an arm that runs the scan
 * and `void`s its answer, keeping the pristine comparator: **0.92x and 0.95x**, i.e. SLOWER than
 * PRE by the scan's own cost. The floor anomaly was drift. Do not reach for "the scan also warms
 * the cache" as an argument.
 *
 * ⚠️ THE COMPARATOR BODIES ARE THE if/return FORM BECAUSE `no-nested-ternary` IS AN ERROR HERE, and
 * `compareValues` itself ends that way. The arms above were measured with the equivalent nested
 * ternary, so the reshape was RE-MEASURED rather than assumed equivalent -- this repo has a recorded
 * habit of executor reshapes costing unrelated rows a few percent.
 *
 * ⚠️ FULL SORT ONLY, deliberately. `boundedTopKeyed`'s heap does O(n log cap) comparisons, not
 * O(n log n), so an O(n) scan is a much larger fraction of its work and could cost more than it saves.
 * The scan pays for itself here because ~20M comparisons are replaced in exchange for ~1M tests.
 */
import { HAS_SURROGATE } from '@lenke/core';

import type { Row } from './core.js';

/**
 * Which reduced comparator a column admits, or `generic` for the untouched `compareSort`.
 *
 * ⚠️ THERE IS NO `'number'` MEMBER, AND THAT IS A MEASURED DECISION, NOT AN OVERSIGHT — see the
 * dropped-arm record in this module's header before adding one back.
 */
export type SortColumnKind = 'string' | 'generic';

/**
 * Classify one sort column by scanning its values once.
 *
 * ⚠️ IT EXITS ON THE FIRST DISQUALIFYING VALUE, so a column that does not qualify pays a partial scan
 * rather than a whole one — a mixed column usually disqualifies within a few rows. The cost this must
 * stay under is the sort it is trying to help, and a full scan is ~1/20 of a 1,000,000-row sort's
 * comparisons.
 *
 * `undefined` counts as null here exactly as `isNullish` treats it: an absent property arrives as
 * `null` through `propOf`, but a row built by another path can carry `undefined`, and both take
 * `compareSort`'s null branch, which the reduced comparator does not have.
 */
export const sortColumnKind = (rows: readonly Row[], col: string): SortColumnKind => {
  if (rows.length === 0) {
    return 'generic';
  }

  const first = rows[0][col];
  const kind = typeof first;

  if (kind === 'string') {
    for (const row of rows) {
      const v = row[col];

      if (typeof v !== 'string' || HAS_SURROGATE.test(v)) {
        return 'generic';
      }
    }

    return 'string';
  }

  return 'generic';
};

/**
 * The reduced comparator for a classified column, or `undefined` for `generic`.
 *
 * ⚠️ ONE EXPRESSION SERVES BOTH KINDS, and that is not a shortcut: the reduction above lands on the
 * same `x < y ? -1 : x > y ? 1 : 0` for strings and for numbers, because `compareCodePoints`' own
 * surrogate-free fast path is that expression. Writing two identical bodies would invite them to drift.
 *
 * `nullsFirst` is absent from the signature because the precondition excludes nulls, so it cannot
 * matter — and taking it would suggest it had been honoured.
 */
export const reducedRowComparator = (
  kind: SortColumnKind,
  col: string,
  descending: boolean,
): ((a: Row, b: Row) => number) | undefined => {
  if (kind === 'generic') {
    return undefined;
  }

  if (descending) {
    return (a: Row, b: Row): number => {
      const x = a[col] as number | string;
      const y = b[col] as number | string;

      if (x < y) {
        return 1;
      }

      return x > y ? -1 : 0;
    };
  }

  return (a: Row, b: Row): number => {
    const x = a[col] as number | string;
    const y = b[col] as number | string;

    if (x < y) {
      return -1;
    }

    return x > y ? 1 : 0;
  };
};
