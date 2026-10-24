/**
 * Sorting ROWS that a fast path has already produced, by the names of its own output columns.
 *
 * A home of its own because two modules need it and neither can own it: `shortcuts.ts` imports
 * from `hop-projection.ts`, so anything the hop detector needs cannot live in `shortcuts.ts`
 * without a cycle. Item 606 is the reason the alternative is not a second copy — "two copies of
 * this list is how one of them falls behind the other" (`plainRowProjection`).
 *
 * THE SHARED RULE THESE EXIST FOR. A rung that materializes its rows can take an `ORDER BY` the
 * general path would have taken, as long as sorting evaluates nothing the query would not:
 *
 *   - EVERY key must name an OUTPUT COLUMN. Its value is already computed by the projection, so a
 *     key cannot fault beyond producing the row — `sortsOnOutputNames` is that test, shared with
 *     the aggregate rungs at items 544/545.
 *   - There must be NO WINDOW. With `SKIP`/`LIMIT` the general path keeps top-k INPUT bindings and
 *     projects only survivors (item 145), so an item that faults on a discarded row never raises
 *     there — measured on BOTH engines at item 604, where
 *     `RETURN CAST(a.s AS INTEGER) AS x, a.n AS k ORDER BY k LIMIT 1` returns a row while the same
 *     query without the window raises. Projecting everything and slicing after would raise where
 *     the query does not. `LIMIT 0` is the same rule again: `applyProjection` returns `[]` BEFORE
 *     projecting anything.
 *   - A window with NO sort also declines, and that one is about SPEED rather than raises: the
 *     general path is LAZY there and a `LIMIT 5` short-circuits where a materializing rung scans
 *     everything. `sortOf` records it as a ~280x regression for the DISTINCT walk.
 */
import type { Graph } from '@lenke/core';

import type { Clause, Expr, SortItem } from '../ast.js';
import type { Params, Row } from '../executor.js';
import { compareSort } from '../executor.js';

/**
 * Can evaluating this expression FAULT, beyond producing its own value?
 *
 * Conservative by construction: four kinds are total and everything else declines, including
 * shapes that probably cannot fault. A false "cannot fault" is a wrong answer; a false "might
 * fault" is only the general path.
 *
 *   - `var` / `prop` are total. A missing property reads NULL (`propOf` returns null for an
 *     absent key and for a null element), which is a value, not a fault.
 *   - `lit` is a constant.
 *   - `param` is substituted before evaluation, so it is a literal by the time a row is
 *     projected. An UNBOUND one raises — but it raises on the first row either path projects, and
 *     a window greater than zero always projects at least one, so the outcome is a raise either
 *     way.
 *
 * Everything else can genuinely throw and is refused: `arith` divides, `compare` throws on a
 * cross-type `<=` ([[cross-type-comparison-no-error]]), `index`/`field` can miss, a scalar call
 * can reject its argument, and a subquery is a whole evaluation. `list`/`record` could recurse
 * into their elements and deliberately do not — the win is not in them and an extra branch here
 * is an extra thing to be wrong about.
 *
 * WHY THIS EXISTS (item 610). It is the "conservative cannot-fault check on the projection" item
 * 426 deferred, and it is what licenses a WINDOW to ride a sorted shortcut: the general path keeps
 * top-k INPUT bindings and projects only survivors, so an item that faults on a DISCARDED row
 * never raises there. If no item can fault, projecting every row cannot differ.
 */
const cannotFault = (e: Expr): boolean =>
  e.kind === 'var' || e.kind === 'prop' || e.kind === 'lit' || e.kind === 'param';

/** One `ORDER BY` key, resolved to the output column it names. */
export type ColSort = { col: string; descending: boolean; nullsFirst: boolean | undefined };

/** A resolved sort, plus the window to apply AFTER it (item 610). */
export type SortPlan = { sorts: readonly ColSort[]; skip: number; limit: number | undefined };

/**
 * The projection's `ORDER BY` as column sorts, or `null` to decline.
 *
 * `undefined` means there is no sort and the caller's streaming path applies unchanged — the three
 * outcomes are deliberately distinct, because "no sort" and "cannot take this sort" send the query
 * to different places.
 */
export const outputColumnSorts = (
  ret: Extract<Clause, { kind: 'return' }>,
  cols: readonly string[],
): SortPlan | null | undefined => {
  const keys = ret.projection.orderBy;

  if (keys === undefined || keys.length === 0) {
    return undefined;
  }

  const { skip, limit } = ret.projection;
  const windowed = skip !== undefined || limit !== undefined;
  // A `CountValue` may be a PARAMETER (`LIMIT $n`), not a number — the AST type says so and the
  // slice below cannot take one. A parameterized window declines rather than being resolved here:
  // the value lives in `params` at run time while this decision is made once at compile time, and
  // resolving it would make the route depend on a binding the plan is cached across.
  const numericWindow =
    (skip === undefined || typeof skip === 'number') &&
    (limit === undefined || typeof limit === 'number');

  // A WINDOW RIDES A SORT only when no projected item can fault (item 610). With a window the
  // general path projects only the survivors, so an item that faults on a discarded row never
  // raises there — item 604 measured both engines returning a row for
  // `RETURN CAST(a.s AS INTEGER) AS x, a.n AS k ORDER BY k LIMIT 1` while the same query without
  // the window raises on both. If nothing can fault, projecting every row cannot differ.
  //
  // `LIMIT 0` is refused for SPEED, not correctness, and mutation says so: a mutant admitting it
  // SURVIVES. The correctness worry does not apply here — `applyProjection` returns `[]` before
  // projecting, but so does the slice below, and no admitted item can fault anyway, so both paths
  // answer `[]`. What the clause avoids is doing the work: sorting every row to return none.
  // Keeping a guard whose removal is answer-equivalent is the same call item 601 made, and it is
  // labelled as the perf guard it is rather than borrowing the raise-parity argument above.
  if (
    windowed &&
    (!numericWindow || limit === 0 || !ret.projection.items.every((it) => cannotFault(it.expr)))
  ) {
    return null;
  }

  // `ORDER BY <the expression a projected item already computes>` IS `ORDER BY <its alias>`,
  // and the two spellings were costing different amounts (item 642). `sortsOnOutputNames`
  // admits only a `var` naming a projected column, so `RETURN n.k AS c ORDER BY n.k` fell to
  // the general path while `… ORDER BY c` took this one — measured at 1,000,000 rows, min of 9,
  // four alternated rounds, against a null control reading 0.99x:
  //
  //   ORDER BY c      84.85 ms
  //   ORDER BY n.k   164.71      1.94x
  //
  // Item 144 recorded this pair as FLAT and added it as the spelling "that already works", to
  // localise its COMPUTED sibling's 1.72x to the substitution. That sibling has since converged
  // (1.01x) and this one opened up, so the fast path reached the alias and never reached the
  // expression — this repo's named bug class.
  //
  // RESTRICTED TO `prop`, for two reasons rather than caution. Its shape is flat
  // (`{kind, variable, key}`), so "the same expression" is an exact comparison and not a
  // general AST deep-equal that would silently go stale as `Expr` grows. And a property read
  // CANNOT FAULT — it yields null for an absent key — so substituting it cannot disturb the
  // windowed-sort fault rule above (item 610), which a computed key could.
  const aliasOf = (e: Expr): string | undefined => {
    if (e.kind !== 'prop') {
      return undefined;
    }

    const { variable, key } = e;

    return ret.projection.items.find(
      (it) =>
        it.alias !== undefined &&
        it.expr.kind === 'prop' &&
        it.expr.variable === variable &&
        it.expr.key === key,
    )?.alias;
  };

  const resolved: SortItem[] = keys.map((k) => {
    const alias = aliasOf(k.expr);

    return alias === undefined ? k : { ...k, expr: { kind: 'var', name: alias } };
  });

  if (!resolved.every((k) => k.expr.kind === 'var' && cols.includes(k.expr.name))) {
    return null;
  }

  const out: ColSort[] = [];

  for (const k of resolved) {
    // The check above has already established that every key is a `var` naming one of `cols`;
    // this re-test is the TYPE NARROWING, not a second check of the rule. An `Expr` union has no
    // `name` until narrowed, and asserting past that would be indistinguishable to a reader from
    // a missing test.
    if (k.expr.kind === 'var') {
      out.push({ col: k.expr.name, descending: k.descending, nullsFirst: k.nullsFirst });
    }
  }

  return {
    sorts: out,
    // Narrowed by `numericWindow` above; a non-numeric window has already declined.
    skip: typeof skip === 'number' ? skip : 0,
    limit: typeof limit === 'number' ? limit : undefined,
  };
};

/**
 * THE FIRST `cap` ROWS of the sorted order, without sorting the rest.
 *
 * `sortRowsByColumns` full-sorted every row and sliced, so `ORDER BY a LIMIT 5` over 200,000 rows
 * paid an O(n log n) sort to emit five (item 701). The general path has had a bounded heap since
 * item 425 — but these queries never reach it: `detectNodeProjection` takes them first, which is
 * why instrumenting `applyProjection` at item 700 found its top-k firing zero times.
 *
 * THE ANSWER MUST BE THE FULL SORT'S, ROW FOR ROW. `Array.prototype.sort` is stable, so the sliced
 * full sort breaks ties by ARRIVAL ORDER, and tie order is observable between the engines (item
 * 605). `rows` is in arrival order here, so the row's INDEX is its arrival index — unlike the
 * `applyProjection` heap, which has to carry one alongside, because it evicts from a permuted
 * array. Adding `x < y` as the final tiebreak makes the heap's order the full sort's total order,
 * and selecting the least `cap` under a total order yields exactly the sort's first `cap`.
 *
 * `compareSort` stays the one comparator, for the reason `sortRowsByColumns` gives.
 */
const boundedTopRows = (rows: Row[], sorts: readonly ColSort[], cap: number): Row[] => {
  const one = sorts.length === 1 ? sorts[0] : undefined;
  const cmpRows = (a: Row, b: Row): number => {
    if (one !== undefined) {
      return compareSort(a[one.col], b[one.col], one.descending, one.nullsFirst);
    }

    for (const s of sorts) {
      const c = compareSort(a[s.col], b[s.col], s.descending, s.nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  };
  // A MAX-heap of row indices: the root is the worst row kept, which is the one a candidate has
  // to beat. Indices rather than rows because the index is also the tiebreak.
  const h: number[] = [];
  const less = (x: number, y: number): boolean => {
    const c = cmpRows(rows[x], rows[y]);

    return c !== 0 ? c < 0 : x < y;
  };
  const siftUp = (from: number) => {
    let i = from;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (!less(h[parent], h[i])) {
        break;
      }

      const t = h[parent];
      h[parent] = h[i];
      h[i] = t;
      i = parent;
    }
  };
  const siftDown = () => {
    let i = 0;

    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;

      if (l < h.length && less(h[m], h[l])) {
        m = l;
      }

      if (r < h.length && less(h[m], h[r])) {
        m = r;
      }

      if (m === i) {
        break;
      }

      const t = h[m];
      h[m] = h[i];
      h[i] = t;
      i = m;
    }
  };

  for (let i = 0; i < rows.length; i += 1) {
    if (h.length < cap) {
      h.push(i);
      siftUp(h.length - 1);
    } else if (less(i, h[0])) {
      h[0] = i;
      siftDown();
    }
  }

  h.sort((x, y) => {
    if (less(x, y)) {
      return -1;
    }

    return less(y, x) ? 1 : 0;
  });

  return h.map((i) => rows[i]);
};

/**
 * Sort rows by resolved output columns, IN PLACE.
 *
 * Goes through `compareSort`, the engine's own comparator, whose doc states "the Rust
 * `compare_sort` matches" — so DESC and the NULLS placement cannot drift from native, and a second
 * comparator is the one thing byte-identity cannot survive.
 *
 * `Array.prototype.sort` is STABLE, so ties keep the caller's arrival order. That is load-bearing
 * rather than incidental: tie order under `ORDER BY` is OBSERVABLE between the engines — item 605
 * measured TS and native agreeing exactly over a fixture with 20 ties per group — so a caller may
 * only use this if it produces rows in the same order the general path would. A walk that reorders
 * rows deliberately (`farDrivenHopWalk`) must therefore decline the sort rather than sort here.
 */
export const sortRowsByColumns = (rows: Row[], plan: SortPlan): Row[] => {
  const { sorts, skip, limit } = plan;

  if (sorts.length === 0) {
    return rows;
  }

  // A SMALL WINDOW SELECTS RATHER THAN SORTS (item 701). The heap is O(n log cap) against the
  // sort's O(n log n), so it only wins while `cap` is a small fraction of `n` and at `cap` near
  // `n` it is a slower way to sort everything. The `* 16` is the MEASURED crossover rather than a
  // guess: a cap sweep at 200,000 rows, alternated min-of-three, read 2.9x at 100, 3.2x at 1,000,
  // 2.1x at 5,000, 1.45x at 10,000 and 0.99x at 20,000 — so the heap stops paying at about `n/10`
  // and this admits to `n/16`, inside the win. A looser `* 8` was built first and measured 0.95x
  // on `LIMIT 20,000`, which is the regression this constant exists to keep out.
  if (limit !== undefined && (skip + limit) * 16 <= rows.length) {
    return boundedTopRows(rows, sorts, skip + limit).slice(skip);
  }

  // ONE sort key, which is the common case, gets a comparator with NO LOOP and no per-call
  // property reads. That is the whole of this optimization: hoisting the spec out of the
  // MULTI-key loop as well was built, measured at 1.00-1.02x against the pre-change dist
  // alternated in one process, and reverted -- it also cost three array allocations per sort
  // call, which a small result set pays and never earns back.
  //
  // `compareSort` is deliberately untouched: it is the one comparator, byte-identical to the
  // Rust `compare_sort`, and a second derivation of "which row sorts first" is the one thing
  // byte-identity cannot survive.
  const sorted =
    sorts.length === 1
      ? ((): Row[] => {
          const [{ col, descending, nullsFirst }] = sorts;

          return rows.sort((a, b) => compareSort(a[col], b[col], descending, nullsFirst));
        })()
      : rows.sort((a, b) => {
          for (const s of sorts) {
            const c = compareSort(a[s.col], b[s.col], s.descending, s.nullsFirst);

            if (c !== 0) {
              return c;
            }
          }

          return 0;
        });

  // THE WINDOW IS APPLIED AFTER THE SORT, which is the order the query means and the order the
  // general path uses. Only reached when `outputColumnSorts` admitted it — no item can fault, so
  // projecting every row and slicing is the same answer the top-k path gives.
  return skip === 0 && limit === undefined
    ? sorted
    : sorted.slice(skip, limit === undefined ? undefined : skip + limit);
};

/** A fast path that produces rows, or hands the query back at run time. */
export type RowsProducer = (graph: Graph, params: Params) => Row[] | null;

/**
 * Wrap a rows producer so its output is sorted, or return it unchanged when there is no sort.
 *
 * ONE WRAPPER AROUND WHICHEVER WALK IS CHOSEN, rather than a sort inside each builder: a detector
 * with three exits is exactly where one of them quietly misses the sort, and that failure returns
 * plausible rows in the wrong order.
 *
 * The run-time null is passed THROUGH. A `RowsProducer` may decline per call — the hop walks hand
 * the query back when a per-call test fails, not only at compile time — and sorting that would
 * answer a declined walk with an empty result instead of letting the general path run.
 */
export const sortedRows = (
  inner: RowsProducer | null,
  plan: SortPlan | undefined,
): RowsProducer | null => {
  if (inner === null || plan === undefined) {
    return inner;
  }

  return (graph, params) => {
    const rows = inner(graph, params);

    return rows === null ? null : sortRowsByColumns(rows, plan);
  };
};
