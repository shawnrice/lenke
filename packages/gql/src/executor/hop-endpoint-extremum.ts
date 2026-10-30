// Item 1246's per-ENDPOINT extremum fold for a one-hop aggregate.
//
// ⚠️ ITS OWN MODULE FOR A MEASURED REASON, not a stylistic one. Living in `hop-projection.ts` —
// module scope, ~180 lines beside a 4,400-line file — cost an UNRELATED shape 1.08x with disjoint
// ranges: `min(a.name), max(a.name)`, which this fold refuses outright, read 239406 -> 258617 us
// over three alternated rounds. Returning the bare walk closure for a declining shape did NOT fix
// that (the first hypothesis, and it was wrong — the decline already got the identical closure),
// which leaves module code layout. That is this repo's recorded `ts-closure-size-is-load-bearing`
// shape and item 762's redistribution effect: adding code moves the code that does not use it.
import type { Edge, Graph } from '@lenke/core';

import type { Clause, Expr } from '../ast.js';
import type { AggFold, CompiledExpr, Params, Row } from '../executor.js';
import { freePredicateVars, relTypeNames } from '../executor.js';
import { candidateVertexSource, matchesLabel } from '../graph-queries.js';
import { isNullish } from './scalars.js';
import { plainNode, plainRel, vacuousLabel } from './shortcuts.js';

/**
 * The accumulator shape this fold needs, restated structurally rather than importing `HopAcc`
 * from `hop-projection.ts` — that module imports THIS one, and a cycle is worth avoiding for a
 * type this narrow. Only the `fold` arm can ride the per-endpoint path, and the caller's
 * `allExtrema` is what guarantees every accumulator is one.
 */
type FoldAcc =
  | { readonly kind: 'fold'; readonly out: string; readonly fold: AggFold }
  | { readonly kind: 'rows' | 'values'; readonly out: string };

/** The caller's row-producing signature (`RowsFn`), restated for the same reason. */
type RowsFn = (graph: Graph, params: Params) => Row[] | null;

/**
 * `MATCH (a)-[:T]->(x) RETURN min(<x expr>), max(<x expr>)` folded ONCE PER DISTINCT ENDPOINT
 * rather than once per ROW (item 1246).
 *
 * ⚠️ THE IDENTITY THAT LICENSES THIS IS EXTREMUM-ONLY: min/max over a multiset equal min/max over
 * its distinct SUPPORT, so the ~200,000 endpoints of a 1,000,000-edge hop answer what the rows are
 * asked. `count(*)` cannot ride it (it needs the multiplicity) and neither can `sum`/`avg`, which
 * is exactly what `allExtrema` already distinguishes — note that flag is reused here for a SECOND
 * purpose and keeps its first (self-loop safety across two undirected walks).
 *
 * ⚠️ AND HALF OF IT IS A REGRESSION. Item 1245 priced the parts separately in one process on the
 * bench fixture, before any of this was written:
 *
 * ```text
 *   engine (the walk below)            173698.3 us
 *   per-edge fold            [CTL]     336675.0     1.94x WORSE
 *   per-distinct-endpoint fold         186070.9     1.07x WORSE   <- this idea ALONE loses
 *   the same + universal-label test     59851.6     2.90x BETTER
 * ```
 *
 * Folding per endpoint only pays once the start label costs nothing to test. Without that, proving
 * "x has a qualifying in-edge" resolves `e.from` per in-edge and gives back more than the
 * multiplicity saved. When the label is carried by EVERY live node, a non-empty bucket IS the
 * proof, so nothing is resolved — `vacuousLabel`, exported for this since item 167, and the same
 * test native's `for_each_typed_out` makes. A detector built from the first half alone would have
 * shipped 1.07x slower while answering correctly, which no correctness test can see.
 *
 * WHY THE CHECK IS AT RUN TIME. Vacuity is a property of the GRAPH, not the query, so it cannot be
 * decided when the shape is compiled. A `null` return declines to the walk below, which is why
 * this is a branch INSIDE that closure and not a new rung: `clauses.ts` would fall past the whole
 * rung instead of to its walk, and the ladder's own notes price an extra branch ahead of a hot
 * dispatch at 1.12x (items 418, 469). The branch added here is one closure-captured `undefined`
 * test per QUERY, not per row.
 */
export const primedEndpointExtremum = (
  m: Clause,
  accs: readonly FoldAcc[],
  args: readonly { readonly expr: Expr; readonly fn: CompiledExpr }[],
  allExtrema: boolean,
): RowsFn | null => {
  // Every accumulator an extremum, and one argument closure per accumulator — which holds only
  // because `allExtrema` excludes the `rows` arm, the one acc kind that projects no column.
  if (!allExtrema || accs.length === 0 || accs.length !== args.length) {
    return null;
  }

  if (m.kind !== 'match' || m.where !== undefined || m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  // An inline property or a `WHERE` on either end would have to be applied per ROW to be the
  // general path's answer; an edge variable could be read by the projection. All decline.
  if (!plainNode(start) || !plainNode(far) || !plainRel(rel) || rel.variable !== undefined) {
    return null;
  }

  // UNDIRECTED is declined, not unsound: `-[:T]-` would test both buckets, and it has its own
  // self-loop arithmetic (items 480-483) that this has not been measured against.
  if (rel.direction === 'both') {
    return null;
  }

  const farVar = far.variable;

  if (farVar === undefined) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  // EVERY argument must read the far endpoint and NOTHING else — native's `refs_only_slot(e, 1)`.
  // An argument reading `a` would need the start vertex, which this walk never binds, and a
  // constant one is refused rather than special-cased.
  for (const a of args) {
    const free = freePredicateVars(a.expr);

    if (free.size !== 1 || !free.has(farVar)) {
      return null;
    }
  }

  const startLabel = start.label;
  const farLabel = far.label;
  const outward = rel.direction === 'out';

  return (graph, params) => {
    // THE RUN-TIME ADMISSION. A start label no vertex fails costs nothing to drop; any other
    // declines to the row walk, which item 1245 measured as the better plan there.
    if (startLabel !== undefined && !vacuousLabel(graph, startLabel)) {
      return null;
    }

    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const state: unknown[] = accs.map((a) => (a.kind === 'fold' ? a.fold.init() : undefined));
    const index = outward ? graph.edgesToByLabel : graph.edgesFromByLabel;

    // `candidateVertexSource` seeds from the far label's own index when it can and falls back to
    // every vertex for a compound expression, which is why the recheck below still runs.
    for (const x of candidateVertexSource(graph, farLabel)) {
      if (farLabel !== undefined && !matchesLabel(x, farLabel)) {
        continue;
      }

      // Does x carry at least ONE edge of a wanted type on the relevant side? With the start
      // label vacuous that is the whole of the pattern's reachability test, and a bucket SIZE
      // answers it without touching an edge.
      const byType = index.get(x.id);

      if (byType === undefined || !hasAnyOfTypes(byType, types)) {
        continue;
      }

      binding.set(farVar, x);

      // An INDEX loop, not `accs.entries()` — item 469 measured that iterator's per-accumulator
      // tuple at 40-55% of a multi-aggregate scan.
      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind !== 'fold') {
          continue;
        }

        const v = args[i].fn(env);

        if (isNullish(v)) {
          continue;
        }

        state[i] = a.fold.step(state[i], v);
      }
    }

    const out: Row = {};

    for (let i = 0; i < accs.length; i += 1) {
      const a = accs[i];

      // `finish` over an UNTOUCHED accumulator is what gives a hop matching nothing its one row
      // of nulls, which is the general path's answer too.
      if (a.kind === 'fold') {
        out[a.out] = a.fold.finish(state[i]);
      }
    }

    return [out];
  };
};

/**
 * Wrap a per-ROW walk so the per-ENDPOINT fold is consulted first, for the SINGLE-aggregate rung
 * (item 1247).
 *
 * ⚠️ A FUNCTION RATHER THAN FOUR LINES AT THE CALL SITE, because `detectHopAggregate` is already
 * at the complexity cap and this pushed it to 37 of 35. That cap has been right here before — the
 * file records `hopAccFor` being extracted for the same reason — so the branching lives here and
 * the detector gains one call.
 *
 * A declining shape gets `walkRows` ITSELF, not a wrapper: item 1246 measured a wrapper costing an
 * unreachable shape 1.06x with disjoint ranges.
 */
export const withPrimedEndpointExtremum = (
  walkRows: RowsFn,
  m: Clause,
  out: string,
  fold: AggFold | undefined,
  // The expression AND its compiled closure as ONE parameter, which is also the shape
  // `primedEndpointExtremum` takes: proving the argument reads only the far endpoint needs the
  // expression, and the walk needs the closure.
  arg: { readonly expr: Expr; readonly fn: CompiledExpr },
  isExtremum: boolean,
): RowsFn => {
  const primed =
    fold === undefined
      ? null
      : primedEndpointExtremum(m, [{ kind: 'fold', out, fold }], [arg], isExtremum);

  if (primed === null) {
    return walkRows;
  }

  return (graph, params) => primed(graph, params) ?? walkRows(graph, params);
};

/** Does `byType` hold any edge of `types` (any type when `undefined`)? A SIZE read, no edge touched. */
const hasAnyOfTypes = (
  byType: Map<string, Set<Edge>>,
  types: readonly string[] | undefined,
): boolean => {
  if (types === undefined) {
    for (const set of byType.values()) {
      if (set.size > 0) {
        return true;
      }
    }

    return false;
  }

  for (const t of types) {
    if ((byType.get(t)?.size ?? 0) > 0) {
      return true;
    }
  }

  return false;
};
