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

import type { Clause, CountValue, Expr, SortItem } from '../ast.js';
import type { Params, Row } from './core.js';
import { resolveCount } from './rows.js';
import { reducedRowComparator, sortColumnKind } from './sort-column-specialize.js';
import { compareSort } from './values.js';

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

/**
 * THE UNSORTED-WINDOW RULE, as a pure function: `null` declines the rung, a number is the literal
 * `SKIP` the rung must slice off its own rows, and `0` means "no unsorted window here" (either
 * there is no window at all, or there is an `ORDER BY` and `outputColumnSorts` owns the decision).
 *
 * ⚠️ THE TWO HALVES OF THE RULE PULL OPPOSITE WAYS, which is why it is one function rather than a
 * condition inline (item 1776).
 *
 *   - A `LIMIT`, with or without a skip, DECLINES — and the decline is a statement about
 *     LAZINESS, not about windows. The general path stops after `skip + limit` rows where a
 *     materializing rung scans everything: item 1775 measured `RETURN n.k LIMIT 10` at 0.035 ms
 *     on the general path against 12.565 for the rung on the `ORDER BY … LIMIT` spelling, 360x in
 *     the general path's favour. `sortOf` records the same trade as ~280x for the DISTINCT walk.
 *   - A SKIP ALONE IS ADMITTED, because that brake does not exist for it. The engine must emit
 *     `N - skip` rows either way, so there is no laziness to collect and the decline was pure
 *     loss: **7.9x** over 200,000 vertices, for TEN FEWER ROWS than the unpaged spelling that took
 *     the rung (item 1775, five interleaved processes, p25 per process; 5.4x at 20,000, so it
 *     grows with N).
 *
 * A LITERAL skip only. A parameterized one resolves against `params`, which the plan cache is
 * shared across, so the route would be chosen for one page and reused for another — `deferredRoute`
 * declines a parameterized window for exactly this reason.
 *
 * `skip === 0` is left to the general path rather than admitted as a no-op page: `dropVacuousPage`
 * already owns vacuous windows, and a second opinion about them here is a second thing to be wrong
 * about.
 *
 * ⚠️ `typeof proj.skip === 'number'` IS REDUNDANT AT RUNTIME and is kept because the TYPECHECKER
 * is what enforces it — mutation established that rather than my reading it. Replacing it with
 * `true` leaves all 23 tests in `skip-only-page.test.ts` green, because `{ param: 's' } > 0` is
 * already false, so the `> 0` test declines a parameterized skip on its own. It is not a survivor
 * to delete: `tsc` rejects that mutant with three errors (`'proj.skip' is possibly 'undefined'`,
 * `Operator '>' cannot be applied`, and the return type), so the guard has teeth in the gate that
 * actually runs on it. Item 475's rule — a surviving mutant means "redundant" as readily as
 * "untested", and the two have opposite fixes.
 *
 * A PURE FUNCTION WITH ITS OWN TEST because this is a route CHOICE, and a route choice is
 * answer-equivalent — so every mutant of it survives the differential tests
 * ([[perf-gate-needs-its-own-test]]). It is also what kept `detectNodeProjection` under the
 * complexity cap, which objected at 41 against 35 with the rule written inline.
 */
export const unsortedPageRoute = (proj: {
  // `unknown[]` because the AST's `SortItem` and the compiled `CSortItem` are different types and
  // both callers pass their own: only the LENGTH is read here, so narrowing further would buy a
  // cast at each call site and no safety.
  readonly orderBy?: readonly unknown[];
  readonly skip?: CountValue;
  readonly limit?: CountValue;
}): CountValue | null => {
  if ((proj.orderBy?.length ?? 0) > 0) {
    return 0;
  }

  if (proj.skip === undefined && proj.limit === undefined) {
    return 0;
  }

  return proj.limit === undefined && proj.skip !== undefined && proj.skip !== 0 ? proj.skip : null;
};
/**
 * The rows a rung produced, with item 1776's skip-only page applied — `0` being the no-page case.
 *
 * ⚠️ THE BOUND IS RESOLVED PER CALL, which is what lets a PARAMETERIZED page take a rung at all
 * (item 1778). `deferredRoute` and `outputColumnSorts` both decline a parameterized window, and
 * that is right for THEM: a `LIMIT $n` decides between a heap and a sort-and-slice, so the ROUTE
 * depends on the value while the plan cache is shared across params. A skip-only page has no such
 * dependence — every non-negative skip takes the same route and differs only in where the slice
 * lands — so the only thing that must wait for `params` is the number, and that waits here.
 *
 * ⚠️ AND THE VALUE IS ALREADY VALIDATED BY THE TIME THIS RUNS, which is the other half of why this
 * is safe rather than merely faster. `noteCountParam` registers a bound's `$param` at compile time
 * and `compile.ts` checks it eagerly before a row is produced — non-negative integer, bound at all
 * — so a negative or fractional bound raises `E_INVALID_VALUE` on EITHER route, and `rows.slice()`
 * here can never see the negative index that would silently return the LAST k rows. That check is
 * route-independent, so it protects a rung it was not written for; the tests pin it anyway.
 */
export const pageSlice = (rows: Row[], skip: CountValue, params: Params): Row[] => {
  const n = typeof skip === 'number' ? skip : (resolveCount(skip, params) ?? 0);

  return n > 0 ? rows.slice(n) : rows;
};
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
 * THE FIRST `cap` ITEMS of the sorted order for a KEYED sequence, without sorting the rest.
 *
 * The twin of `boundedTopRows`, for callers that hold opaque items plus a key FUNCTION rather than
 * rows with resolved columns — specifically the statement-position `<order by and page statement>`,
 * which sorts the working BINDING table. That clause full-sorted every binding and sliced, so
 * `MATCH (n:P) ORDER BY n.k LIMIT 10` over 200,000 rows measured **62.4 ms against 9.5** for the
 * clause-position spelling of the same query (item 868) — a 6.6x gap between two ways of writing
 * one thing, which the TS spelling probe flagged the moment the group was added.
 *
 * Two costs go, not one: the O(n log n) sort becomes O(n log cap), and a loser is discarded as soon
 * as it is compared, so only `cap` key arrays are retained instead of one per row. Keys are still
 * evaluated for every item — nothing here knows which will win — so that part is unavoidable.
 *
 * THE ANSWER MUST BE THE FULL SORT'S, ITEM FOR ITEM, including ties: `Array.prototype.sort` is
 * stable, so the sliced full sort breaks ties by ARRIVAL ORDER, and tie order under `ORDER BY` is
 * OBSERVABLE between the engines (item 605). The arrival index is therefore carried as the final
 * tiebreak, which makes the heap's order total and selecting the least `cap` under a total order
 * yield exactly the sort's first `cap`. `compareSort` stays the one comparator, so DESC and NULLS
 * placement cannot drift from native.
 */
export const boundedTopKeyed = <T>(
  items: readonly T[],
  keyAt: (item: T, i: number) => unknown,
  sorts: readonly { readonly descending: boolean; readonly nullsFirst?: boolean | undefined }[],
  cap: number,
): T[] => {
  type Kept = { item: T; keys: readonly unknown[]; at: number };
  // ONE KEY AT A TIME rather than an array per item (item 1064). The signature used to be
  // `keysOf: (item) => readonly unknown[]`, so EVERY candidate allocated an array — and the loop
  // boxed every candidate into a `Kept` as well, for `n` items to keep `cap`. Over 200,000
  // vertices that was ~5 ms of pure allocation: a top-10 through this helper measured 11.97 ms
  // against 6.65 for a hand-rolled heap over a flat key array, and the gap was the boxing, not
  // the heap. Now a LOSER is compared without being boxed and only a winner is materialized.
  const keysOf = (item: T): unknown[] => sorts.map((_, i) => keyAt(item, i));
  const cmp = (a: Kept, b: Kept): number => {
    for (const [i, spec] of sorts.entries()) {
      const c = compareSort(a.keys[i], b.keys[i], spec.descending, spec.nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    // Arrival order, so the heap's order is the stable sort's total order.
    return a.at - b.at;
  };
  // A MAX-heap: the root is the worst item kept, the one a candidate has to beat.
  const h: Kept[] = [];
  const siftUp = (from: number) => {
    let i = from;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (cmp(h[parent], h[i]) >= 0) {
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

      if (l < h.length && cmp(h[m], h[l]) < 0) {
        m = l;
      }

      if (r < h.length && cmp(h[m], h[r]) < 0) {
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

  // A candidate is compared against the root WITHOUT being boxed: `keyAt` is called at most once
  // per sort level, exactly as the old `keysOf` was, and nothing is allocated unless it wins.
  // An INDEXED loop and no `sorts.entries()`, unlike `cmp` above. This runs once per CANDIDATE —
  // `cmp` only runs O(cap log cap) times — and `entries()` allocates an iterator and a tuple per
  // call, which at 200,000 candidates measured ~2 ms of the shape's total.
  const beatsRoot = (item: T, at: number): boolean => {
    const [root] = h;

    for (let i = 0; i < sorts.length; i += 1) {
      const spec = sorts[i];
      const c = compareSort(keyAt(item, i), root.keys[i], spec.descending, spec.nullsFirst);

      if (c !== 0) {
        return c < 0;
      }
    }

    // REDUNDANT TODAY, and mutation says so rather than my reading it: a mutant returning `false`
    // here SURVIVES. Candidates arrive in increasing `at` and every kept item was seen earlier, so
    // a candidate's arrival index is always GREATER than the root's and this can never be true. It
    // stays as the statement of intent, and as the thing that fails loudly if this is ever fed
    // items out of arrival order — the same call the engine makes elsewhere for a guard whose
    // removal changes no answer (item 475's rule: a survivor means "redundant" as readily as
    // "untested", and the two have opposite fixes). `cmp` below is where the tiebreak is
    // load-bearing: it orders the KEPT items, which the heap holds in no particular order.
    return at < root.at;
  };

  for (let at = 0; at < items.length; at += 1) {
    const item = items[at];

    if (h.length < cap) {
      h.push({ item, keys: keysOf(item), at });
      siftUp(h.length - 1);
    } else if (beatsRoot(item, at)) {
      h[0] = { item, keys: keysOf(item), at };
      siftDown();
    }
  }

  h.sort(cmp);

  return h.map((k) => k.item);
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

          // A COLUMN OF ONE TYPE WITH NO NULLS SORTS WITH THE DEAD BRANCHES GONE (item 1711):
          // ~1.45x on a 1,000,000-row string sort, ~1.06x on a numeric one. The scan decides it
          // once; `compareSort` is still the comparator for every column it declines; and the
          // reduction is exact rather than a second derivation. The module's note carries the
          // numbers, why the numeric arm is kept on consistency rather than size, and the refuted
          // warm-up explanation -- read it before changing the scan.
          const reduced = reducedRowComparator(sortColumnKind(rows, col), col, descending);

          if (reduced !== undefined) {
            return rows.sort(reduced);
          }

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
/**
 * The same wrapper for item 1776's SKIP-ONLY PAGE: drop the first `skip` rows a rung produced, or
 * return it unchanged when there is no such page (`skip === 0`).
 *
 * ⚠️ IT IS THE CALLER'S JOB TO HAVE FORCED AN ORDER THIS MAY BE SLICED. A sort is
 * order-INVARIANT in the sense that matters here — it decides the order itself — while a skip
 * INHERITS whichever order the walk produced, so slicing a walk whose visit order differs from the
 * general path's returns different ROWS, not merely different order. For the hop rung that means
 * the START-DRIVEN walk, whose order `detectHopProjection`'s own `forceStartDriven` doc records as
 * the general path's, measured in both engines at item 551.
 *
 * ONE WRAPPER AROUND WHICHEVER WALK IS CHOSEN, and the run-time null passed THROUGH, both for the
 * reasons `sortedRows` states above: a detector with four exits is exactly where one of them
 * quietly misses the page, and a declined walk must stay declined rather than answering `[]`.
 */
export const pagedRows = (inner: RowsProducer | null, skip: CountValue): RowsProducer | null => {
  if (inner === null || skip === 0) {
    return inner;
  }

  return (graph, params) => {
    const rows = inner(graph, params);

    return rows === null ? null : pageSlice(rows, skip, params);
  };
};
