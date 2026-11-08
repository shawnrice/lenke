/**
 * THE PLAIN COUNT RUNG: `MATCH (n:L) RETURN count(*)` answered from a label bucket\'s size.
 *
 * ⚠️ THIS RUNG IS THE REASON SEVERAL "FLOORS" IN THIS AUDIT WERE INVALID, which is worth knowing
 * before using it as a control. It answers in O(1) from `verticesByLabel`, so an arm written
 * `MATCH (n:P) RETURN count(*)` reads ~0.1 ns a row and is not a floor for anything that
 * materialises — items 1653, 1654 and 1661 each divided a materialising path by an arm this rung
 * had claimed, and the ratios were meaningless. In this engine a `count(*)` arm is a RUNG until
 * proven otherwise.
 *
 * ⚠️ AND IT IS WHY `verticesByLabel` MAINTENANCE IS A CORRECTNESS QUESTION, not a bookkeeping one.
 * The count is read from that index rather than counted, so an index the `v.labels =` setter failed
 * to maintain produces a WRONG ANSWER through the public API — a known open decision, recorded
 * rather than fixed here.
 *
 * A module of one symbol, for `optional-hop.ts`\'s reason: it has no private machinery and no family
 * to join, and pairing it with the optional-hop count on the strength of a shared word in their
 * names would be a grab-bag.
 */

import type { Graph } from '@lenke/core';

import type { Clause } from '../ast.js';
import type { CClause, Params, Row } from './core.js';
import { columnName } from './rows.js';
import type { CountFn } from './shortcuts.js';
import { keyedCountOf, pageOneRow, patternCountOf, productCountOf } from './shortcuts.js';

export const detectCountShortcut = (
  clauses: readonly Clause[],
  compiled?: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length < 2) {
    return null;
  }

  // The last clause is the `RETURN`; everything before it must be a `MATCH`. This
  // used to demand EXACTLY two clauses, which is why the two-clause spelling of a
  // cartesian count (`MATCH (a:P {k: 1}) MATCH (b:P {k: 2})`) declined — see
  // `productCountOf`. A `LET` anywhere still declines here, as it must: the
  // shortcut answers the whole query, and a `LET` can rebind what `RETURN` reads.
  const ret = clauses[clauses.length - 1];

  if (ret.kind !== 'return') {
    return null;
  }

  const matches: Extract<Clause, { kind: 'match' }>[] = [];

  for (let i = 0; i < clauses.length - 1; i++) {
    const c = clauses[i];

    if (c.kind !== 'match' || c.optional) {
      return null;
    }

    matches.push(c);
  }

  const [m] = matches;

  const proj = ret.projection;

  // `groupBy` and `having` were MISSING here, and both are silent wrong answers rather than
  // slow paths — a shortcut answers one global count, so a grouped count collapses to a single
  // row and a `HAVING` that should drop the row never runs. Measured against native, which is
  // right in every case:
  //
  //   MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c GROUP BY a
  //     ts [{"c":4}]   native [[1],[1],[1],[1]]
  //   SELECT count(*) AS c FROM MATCH (a:Person)-[:KNOWS]->(b) HAVING count(*) > 100
  //     ts [{"c":4}]   native []
  //
  // The 1-hop and 2-hop shortcuts have shipped with this. The `gql-conformance` HAVING case
  // did not catch it because it asks a BARE NODE pattern, which had no shortcut until
  // `buildNodeCount` and so went through general execution — adding that shortcut is what
  // turned the latent gap into a failing test. A `LET` before the `RETURN` also hid it, by
  // making `clauses.length !== 2` reject the shortcut outright.
  // SKIP/LIMIT are NOT refused. An un-grouped `count(*)` with one item is exactly ONE row, so
  // a page over it is arithmetic on a one-element list — and refusing it made `LIMIT 1`, which
  // cannot change the answer, cost 380x the same query without it (0.021ms vs 7.979ms over
  // 20,000 nodes, against native's 0.003ms either way). Two spellings of one question, one of
  // them hundreds of times slower: the bug class this repo is named after. See `pageOneRow`.
  if (
    proj.star ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    proj.items.length !== 1
  ) {
    return null;
  }

  const [item] = proj.items;
  const e = item.expr;

  if (e.kind !== 'func' || e.name !== 'count' || !e.star || e.distinct) {
    return null;
  }

  const column = item.alias ?? columnName(e);

  // DISTINCT and ORDER BY are NOT refused, and the reason is the one this function already gives
  // for SKIP/LIMIT two comments up: an un-grouped `count(*)` with one item is exactly ONE ROW. A
  // row cannot be deduplicated away from itself and cannot be reordered, so both clauses are
  // identities here — and refusing them cost a 0.00 ms answer **29.78 ms** (`RETURN DISTINCT
  // count(*)`) and **34.53** (`ORDER BY c`) at 200,000 vertices, measured one case per process.
  // Neither spelling is contrived: ordering by the count you just asked for, or writing DISTINCT
  // out of habit, is what a reader does (item 544).
  //
  // ORDER BY is admitted only for a sort key that is a plain reference to the OUTPUT column.
  // Any other expression could FAULT while being evaluated for the sort — `ORDER BY 1/0` raises
  // on the general path — and a shortcut that skipped the sort would skip the fault with it. A
  // reference to the column just produced cannot fault beyond producing it.
  //
  // The `kind === 'var'` half is load-bearing and its mutant is caught. The NAME comparison is
  // equivalent by construction and its mutant survives: an aggregating projection's ORDER BY
  // resolves against the OUTPUT columns, and there is exactly one of them here, so any valid
  // `var` key already IS this column. Kept as the local statement of the rule, and recorded
  // rather than left as an unexplained survivor.
  const orderOnOutput = (proj.orderBy ?? []).every(
    (sort) => sort.expr.kind === 'var' && sort.expr.name === column,
  );

  if (!orderOnOutput) {
    return null;
  }

  const rowOf = (count: number): Row => ({ [column]: count });

  // ONE pattern in ONE `MATCH` keeps the original path, which is the only one that
  // can answer a clause `WHERE` (through the 1-hop tally).
  const one = ((): CountFn | null => {
    if (matches.length === 1 && m.patterns.length === 1) {
      // The COMPILED start node carries the seed hints lifted from the `WHERE`, which is what
      // lets the node tally seek an index instead of scanning the label bucket. Optional so a
      // caller without the compiled clauses still gets the (bucket-scanning) shortcut.
      const cm = compiled?.[0];
      const cstart = cm?.kind === 'match' ? cm.patterns[0]?.start : undefined;
      // Its FAR mirror, so the far-side walk can seek too (item 178). Item 176 wired only the
      // start, which left the far-anchored spelling of one question scanning the far label
      // bucket while its start-anchored twin seeked.
      const cfar = cm?.kind === 'match' ? cm.patterns[0]?.segments[0]?.node : undefined;
      // And the END of a two-segment pattern, which the reversed reading seeds from (item 220).
      // `cfar` is `segments[0].node` — the MIDDLE when there are two segments, not the end.
      const cend = cm?.kind === 'match' ? cm.patterns[0]?.segments[1]?.node : undefined;

      return patternCountOf(m.patterns[0], m.where, rowOf, cstart, cfar, cend);
    }

    // A product first — it is the cheaper answer and covers disjoint patterns. When it
    // declines for a SHARED variable, the keyed sum-of-products may still apply.
    return productCountOf(matches, rowOf) ?? keyedCountOf(matches, rowOf);
  })();

  if (one === null) {
    return null;
  }

  // Unpaged is the overwhelmingly common spelling, so it returns the row with no window
  // arithmetic and no array slice at all.
  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph, params) => [one(graph, params)];
  }

  return (graph, params) => pageOneRow(one, graph, params, proj.skip, proj.limit);
};
