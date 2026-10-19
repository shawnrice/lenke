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

import type { Clause } from '../ast.js';
import type { Params, Row } from '../executor.js';
import { compareSort, sortsOnOutputNames } from '../executor.js';

/** One `ORDER BY` key, resolved to the output column it names. */
export type ColSort = { col: string; descending: boolean; nullsFirst: boolean | undefined };

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
): ColSort[] | null | undefined => {
  const keys = ret.projection.orderBy;

  if (keys === undefined || keys.length === 0) {
    return undefined;
  }

  if (ret.projection.skip !== undefined || ret.projection.limit !== undefined) {
    return null;
  }

  if (!sortsOnOutputNames(ret, new Set(cols))) {
    return null;
  }

  const out: ColSort[] = [];

  for (const k of keys) {
    // `sortsOnOutputNames` has already established that every key is a `var` naming one of `cols`;
    // this re-test is the TYPE NARROWING, not a second check of the rule. An `Expr` union has no
    // `name` until narrowed, and asserting past that would be indistinguishable to a reader from
    // a missing test.
    if (k.expr.kind === 'var') {
      out.push({ col: k.expr.name, descending: k.descending, nullsFirst: k.nullsFirst });
    }
  }

  return out;
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
export const sortRowsByColumns = (rows: Row[], sorts: readonly ColSort[]): Row[] => {
  if (sorts.length === 0) {
    return rows;
  }

  return rows.sort((a, b) => {
    for (const s of sorts) {
      const c = compareSort(a[s.col], b[s.col], s.descending, s.nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  });
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
  sorts: readonly ColSort[] | undefined,
): RowsProducer | null => {
  if (inner === null || sorts === undefined) {
    return inner;
  }

  return (graph, params) => {
    const rows = inner(graph, params);

    return rows === null ? null : sortRowsByColumns(rows, sorts);
  };
};
