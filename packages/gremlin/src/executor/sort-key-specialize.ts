/**
 * ELIMINATING `compareTotal`'s DEAD BRANCHES FOR A ONE-TYPE KEY COLUMN (item 1713).
 *
 * `order()` calls `compareTotal` once per comparison — ~20M times for a 1,000,000-value sort. When
 * every key is a non-null, surrogate-free string, almost everything that chain does is provably
 * dead: four null tests, the number/NaN block, two `typeRank` calls, the `cmpSameType` dispatch and
 * its own type tests, and the surrogate regex inside `compareCodePoints` — run on BOTH strings on
 * EVERY comparison to re-establish a fact that is per-string and invariant. This scans the key
 * column ONCE and, when it qualifies, sorts with the reduced comparator.
 *
 * ⚠️ THIS EXISTS BECAUSE ITEM 1712'S CORRECTNESS FIX COST 1.55x-1.68x, MEASURED. Gremlin used to
 * order strings with a plain `<` (code UNIT), which disagreed with the engine (code POINT) and was
 * a byte-identity break — the 15th open divergence. Fixing it routed strings through
 * `compareCodePoints`, which is correct and not optional, and on a 1,000,000-row string sort:
 *
 * ```text
 *    row                        PRE (cmpOrd)   POST (code point)   cost
 *    out('E').values('s').order()   442.3/443.3    686.6/746.2      1.55x / 1.68x
 *    the same over a NUMBER key     403.3/338.6    349.6/343.6      0.87x / 1.02x  (cannot reach it)
 *    a bare hop, NO sort            197.1/228.8    238.0/214.0      1.21x / 0.94x  (drift gauge)
 * ```
 *
 * So the regression is specific to the string key and well outside the controls' straddle. The
 * reduction below is what makes the correct comparator affordable: ~20M dispatch chains are replaced
 * by ~1M scan tests.
 *
 * ⚠️ IT IS BRANCH ELIMINATION WITH A PROOF, NOT A SECOND ORDERING. For two non-null strings
 * `compareTotal` takes none of its null arms (Gremlin sorts nulls FIRST, a language contract that is
 * untouched here), skips the number/NaN block, gets `typeRank` 1 on both sides so the rank branch is
 * dead, reaches `cmpSameType`'s string arm, and that arm is `compareCodePoints` — whose own fast
 * path, when neither string holds a high surrogate, is literally `a < b ? -1 : a > b ? 1 : 0`.
 * Anything the scan does not admit returns `false` and the untouched `compareTotal` runs.
 *
 * ⚠️ THE GQL TWIN IS `gql/src/executor/sort-column-specialize.ts` AND THE TWO ARE DELIBERATELY NOT
 * ONE FUNCTION. They scan different shapes — GQL walks `rows[i][col]`, this walks `keyed[i].key` —
 * and a shared version would need a per-element getter closure, which is a cost on the hot path this
 * exists to make cheap. What IS shared, and what actually could drift, is the ordering itself:
 * `compareCodePoints` and `HAS_SURROGATE` both come from `@lenke/core`.
 *
 * ⚠️ A NUMERIC ARM IS DELIBERATELY ABSENT. Its GQL twin was built, measured six times
 * (0.93x-1.18x, straddling 1.0) and dropped, and the numbers above say the same thing here: the
 * NUMBER-key row could not reach the string arm and measured 0.87x/1.02x, i.e. nothing. A floor arm
 * on the GQL side showed the reduction IS worth ~25% on numbers and the O(n) scan eats it, so the
 * open question is a cheaper classification, not a numeric arm. Read that module before adding one.
 */
import { HAS_SURROGATE } from '@lenke/core';

/**
 * ⚠️ TWO SHAPES, AND THE SECOND ONE IS WHY THIS NOTE EXISTS. `order()` does not have one sort site:
 * `fusedProjectedOrder` sorts a FLAT array of values (the `values(k).order()` fusion, item 1586),
 * while `sortByBys` sorts `{ item, key }` WRAPPERS (the `order().by(...)` shapes). Wiring only the
 * wrapper path left `out('E').values('s').order()` completely untouched — a counter on all six
 * sort sites in `aggregation.ts` showed the row entering `acc.sort` and the admit/decline counter
 * never firing at all. Timing could not have told me that: an unreached specialization and an
 * ineffective one both read as "no change".
 *
 * So both shapes get an arm, and each is MEASURED on a row that reaches it.
 */

/**
 * Is every value a non-null, surrogate-free string? The FLAT form, for `fusedProjectedOrder`.
 */
export const allPlainStrings = (xs: readonly unknown[]): boolean => {
  if (xs.length === 0) {
    return false;
  }

  for (const x of xs) {
    if (typeof x !== 'string' || HAS_SURROGATE.test(x)) {
      return false;
    }
  }

  return true;
};

/**
 * The reduced comparator over FLAT values. Negates for `descending` so ties stay 0 and the sort
 * remains stable, exactly as `-compareTotal(a, b)` does.
 */
export const reducedValueComparator = (
  descending: boolean,
): ((a: unknown, b: unknown) => number) => {
  if (descending) {
    return (a, b): number => {
      const x = a as string;
      const y = b as string;

      if (x < y) {
        return 1;
      }

      return x > y ? -1 : 0;
    };
  }

  return (a, b): number => {
    const x = a as string;
    const y = b as string;

    if (x < y) {
      return -1;
    }

    return x > y ? 1 : 0;
  };
};

/**
 * Is every key a non-null, surrogate-free string?
 *
 * ⚠️ IT EXITS ON THE FIRST DISQUALIFYING KEY, so a column that does not qualify pays a partial scan
 * rather than a whole one. The cost it must stay under is the sort it is helping, and a full scan is
 * ~1/20 of a 1,000,000-value sort's comparisons.
 *
 * `typeof v !== 'string'` rejects null and undefined on its way past, which is required and not
 * incidental: `compareTotal` places nulls FIRST and the reduced comparator has no null arm at all.
 */
export const allPlainStringKeys = (keyed: readonly { readonly key: unknown }[]): boolean => {
  if (keyed.length === 0) {
    return false;
  }

  for (const k of keyed) {
    if (typeof k.key !== 'string' || HAS_SURROGATE.test(k.key)) {
      return false;
    }
  }

  return true;
};

/**
 * The reduced comparator over `{ key }` wrappers.
 *
 * `descending` NEGATES rather than swapping the arguments, matching what `sortByBys` already does
 * with `-compareTotal(...)`: a tie stays 0, so `Array.prototype.sort` keeps arrival order, which is
 * observable and compared against native.
 */
export const reducedKeyComparator = (
  descending: boolean,
): ((a: { readonly key: unknown }, b: { readonly key: unknown }) => number) => {
  if (descending) {
    return (a, b): number => {
      const x = a.key as string;
      const y = b.key as string;

      if (x < y) {
        return 1;
      }

      return x > y ? -1 : 0;
    };
  }

  return (a, b): number => {
    const x = a.key as string;
    const y = b.key as string;

    if (x < y) {
      return -1;
    }

    return x > y ? 1 : 0;
  };
};
