/**
 * `sum`/`avg` as a PER-PATH LEFT FOLD over a path-walk rung's rows — item 2411.
 *
 * ⚠️⚠️ **THIS IS THE EASY HALF OF ITEM 2409's ARGUMENT, AND THE DIFFERENCE MATTERS.** The chain LEVEL
 * recurrence folds `Σ u_v · x_v` over distinct reached vertices, which is a DIFFERENT COMPUTATION
 * from adding the per-path values one at a time, so it needed an error bound to stay inside item
 * 2401's contract. The rungs here walk the actual paths, so this is a plain left fold over the same
 * addends in a possibly different ORDER — a re-association and nothing more, which is exactly what
 * item 2401's precision contract frees and item 2400's ruling made walk-order-independent.
 *
 * The refusal this replaces was stated identically in `chain-projection.ts` and `hop2-projection.ts`:
 *
 * > `sum / avg  order-SENSITIVE in the last ulp (f64)  REFUSED` … This engine's hard invariant is
 * > BYTE-IDENTITY with the Rust engine, so admitting `sum` would make the two disagree in the last
 * > ulp wherever this walk's order differs from the general path's.
 *
 * 🔑 That invariant is gone. `sum`/`avg` are accurate to within `n·ε·Σ|xᵢ|` and explicitly NOT
 * bit-identical across engines (item 2401, owner ruling), so "the two disagree in the last ulp" is
 * the contract rather than a defect. ⚠️ Within-engine determinism is NOT relaxed, and this fold is
 * deterministic: the rung's walk is the same walk run to run.
 *
 * ⚠️⚠️ **ONE COPY, DELIBERATELY, AND BOTH RUNGS SAY WHY.** `chain-projection.ts` warns twice that two
 * copies of one shape rule is how the far endpoint ended up on a per-edge tally; the two modules
 * already carry duplicate `ORDER_INVARIANT_AGGREGATES` sets, and a second copy of the ACCUMULATOR
 * would be the one that drifts, because its empty case and its bail are both load-bearing.
 *
 * ⚠️⚠️ **AND `foldFor` IS NOT WIDENED — item 2159's rule, which still holds.** Its result is read by
 * call sites that infer ORDER-INSENSITIVITY from foldability (`node-scan.ts`'s unfiltered scan,
 * `core.ts`'s grouped path, `hop-projection.ts`, `shortcuts.ts`, `grouped-hop.ts`), and a `sum` is
 * not order-insensitive in its bits. `node-scan.ts:1776` warns of this in advance. So `sum`/`avg`
 * arrive here with `foldedAggs` UNDEFINED and this module compiles their argument itself.
 */
import type { Expr } from '../ast.js';
import type { CompiledExpr, CProjection, FoldedAgg, Row } from './core.js';
import { compileExpr } from './core.js';

/** The aggregate this module folds, identified off the AST because no `foldedAggs` entry exists. */
export type PathSumAgg = {
  readonly name: 'sum' | 'avg';
  readonly argFn: CompiledExpr;
  /** The aggregate's own AST node, so the caller's "the item IS the aggregate" test is unchanged. */
  readonly expr: Extract<Expr, { kind: 'func' }>;
};

/**
 * `sum(<expr>)` / `avg(<expr>)` as the projection's ONLY item, or `null`.
 *
 * ⚠️ `DISTINCT` IS REFUSED AND STAYS REFUSED: `sum(DISTINCT x)` folds over a deduped multiset, which
 * is a set operation this accumulator does not perform — admitting it here would silently sum the
 * duplicates. `foldFor` refuses it for the same reason and `count` is the only distinct fold anywhere
 * in the engine.
 */
export const pathSumAggFor = (proj: CProjection, item: Expr | undefined): PathSumAgg | null => {
  if (
    !proj.aggregating ||
    proj.items.length !== 1 ||
    // A `foldedAggs` entry means `foldFor` already lowered this one, so it is not ours.
    (proj.foldedAggs?.length ?? 0) !== 0 ||
    item?.kind !== 'func' ||
    (item.name !== 'sum' && item.name !== 'avg') ||
    item.star ||
    item.distinct ||
    item.args.length !== 1
  ) {
    return null;
  }

  return { name: item.name, argFn: compileExpr(item.args[0]), expr: item };
};

/**
 * The reducer the rung runs over its walk's rows, or `null` when neither fold applies.
 *
 * ⚠️ BUILT AT COMPILE TIME, not per call: the branch between the two folds is decided once, and the
 * returned closure is the only thing the hot path touches.
 */
export const foldedRowsReducer = (
  folded: FoldedAgg | undefined,
  sumAgg: PathSumAgg | null,
  column: string,
  outName: string,
): ((inner: readonly Row[]) => Row[] | null) | null => {
  if (sumAgg !== null) {
    const { name } = sumAgg;

    return (inner) => {
      let total = 0;
      let count = 0;

      for (const row of inner) {
        const v = (row as Record<string, unknown>)[column];

        // Nullish is EXCLUDED, not zero, and it never reaches `step` on the general path either
        // (`stepFolded`'s `isNullish`). `avg`'s denominator skips it too, which is why `count` is
        // tallied here rather than read off `inner.length`.
        if (v === null || v === undefined) {
          continue;
        }

        /*
         * ⚠️⚠️ **THE BAIL HANDS THE WHOLE QUERY BACK, IT DOES NOT ANSWER PART OF IT.** One temporal
         * anywhere in the column turns `sum` from "add numbers" into a loud data exception (item
         * 2336), and whether a property holds one is not knowable while compiling — so the decline
         * happens at execution time, with a partial total already in hand. 🔑 Returning that partial
         * total would be a silently wrong answer where the general path FAULTS; item 2159's sharpest
         * test is exactly that shape, a column numeric until its LAST row. `null` falls through and
         * the rung below re-walks and answers or faults as it always did.
         */
        if (typeof v !== 'number') {
          return null;
        }

        total += v;
        count += 1;
      }

      if (count === 0) {
        /*
         * ⚠️⚠️ **AN EMPTY `sum` IS `0` AND AN EMPTY `avg` IS `null`, AND THE TWO DISAGREEING IS THE
         * CONTRACT — item 2410 measured it across every route.** Item 2409 answered `null` for both
         * on the level fold and that was a route-dependent answer, reachable by a chain over a
         * column that is entirely null. ⚠️ Do not "tidy" these two into agreeing.
         */
        return [{ [outName]: name === 'sum' ? 0 : null }];
      }

      return [{ [outName]: name === 'sum' ? total : total / count }];
    };
  }

  if (folded === undefined) {
    return null;
  }

  const { fold } = folded;

  return (inner) => {
    let acc = fold.init();

    for (const row of inner) {
      const v = (row as Record<string, unknown>)[column];

      // Nullish never reaches `step` on the general path either (`stepFolded`'s `isNullish`), and
      // it must not: a null in the set would make a later non-null the SECOND distinct value where
      // it is the first.
      if (v !== null && v !== undefined) {
        acc = fold.step(acc, v);
      }
    }

    return [{ [outName]: fold.finish(acc) }];
  };
};
