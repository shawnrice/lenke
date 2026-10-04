import type { Graph, Vertex } from '@lenke/core';

import type { Clause, Expr, LabelExpr } from '../ast.js';
import type { CClause, CPredicate, CProjection, CReturnItem, Params, Row } from '../executor.js';
import {
  compilePredicate,
  freePredicateVars,
  projectRow,
  relTypeNames,
  satisfies,
  valueKey,
} from '../executor.js';
import { candidateVertices, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { plainNode, plainRel } from './shortcuts.js';

/** Rows for a whole `MATCH … RETURN` query, or `null` if the shape does not fit. */
export type RowsFn = (graph: Graph, params: Params) => Row[];

/**
 * `MATCH (a:L)-[:T]->(x) RETURN <expressions over x>` — walk the hop and build each row
 * directly, with no binding copy and no generator stack.
 *
 * ### Why this shape
 *
 * `traverse 1-hop project` is the largest absolute cost in the cross-engine bench for the
 * TypeScript engine: 807.9ms for 1,000,000 rows (806ns a row) against native's 75.7ms. The
 * split says the cost is the ROW PIPELINE, not the data:
 *
 *     RETURN x.name AS n          861ns a row
 *     RETURN 1 AS n               662ns a row   — no property read at all
 *     RETURN x.name, x.age        771ns a row   — two reads, no dearer than one
 *
 * So 77% of it is machinery that a constant projection pays in full. A CPU profile of the
 * same query puts 50.4% in generator/closure bodies, 14.4% in `generatorResume`, **7.2% in
 * the `Map` constructor** and 4.8% in `withBinding` — `withBinding` does `new Map(binding)`,
 * so a 1-hop allocates two binding maps per row before anything is projected.
 *
 * This path removes all of it: ONE binding `Map`, mutated per edge, and a direct `push`.
 * `projectRow` builds a fresh `Row` and never retains the binding, which is what makes
 * reusing one safe.
 *
 * Mirrors native's `try_fused_hop_project`, including its central restriction — there, every
 * projected item must satisfy `refs_only_slot(e, 1)`; here, every item may read only the far
 * variable. That is what lets the binding hold exactly one entry.
 *
 * ### Row ORDER is preserved, not merely permitted
 *
 * Unordered row order is unspecified in this engine (as in SQL without `ORDER BY`), so a
 * different order would not be a bug. It is matched anyway, because a gratuitous reordering
 * would churn every caller and test for nothing: the walk is `candidateVertices(startLabel)`
 * and then the per-vertex type bucket, which is exactly what the general path's
 * `candidateVertices` → `expand` does for a directed single-type hop.
 */
export const detectHopProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    // A clause `WHERE` would have to be evaluated per row, which is the general path's job.
    m.where !== undefined ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  const [pattern] = m.patterns;

  // No path variable: `p = (a)-[:T]->(x)` has to build a Path per row.
  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node } = seg;

  // `both` would visit a self-loop from both ends, and a quantifier needs the general
  // matcher.
  //
  // The rel-variable and path-variable checks here (and `pathVar` above) are DEFENSIVE, not
  // load-bearing: the projection guard below already rejects any item that reads a name
  // other than the far variable, so an unread `r` or `p` cannot change a row, and mutation
  // confirms removing either changes no answer. They stay because that redundancy depends
  // on the projection guard keeping its exact shape.
  //
  // A path MODE (`SIMPLE`/`ACYCLIC`/`WALK`/`TRAIL`) is deliberately NOT rejected: this
  // engine applies those restrictors per repetition, so on a single non-quantified hop they
  // are no-ops — measured against the general path including the `ACYCLIC`-with-a-self-loop
  // case, which is the one that could have differed. A path SELECTOR (`ANY SHORTEST`) raises
  // on a non-var-length pattern in both paths.
  if (!plainRel(rel) || rel.direction === 'both' || rel.variable !== undefined) {
    return null;
  }

  if (!plainNode(start) || !plainNode(node)) {
    return null;
  }

  // ONE concrete edge type, so the per-vertex bucket is exact. `relTypeNames` returns
  // `undefined` for an untyped hop and `null` for a shape with no single bucket.
  const types = relTypeNames(rel.label);

  if (types?.length !== 1) {
    return null;
  }

  const [typeName] = types;
  const farVar = node.variable;

  if (farVar === undefined) {
    return null;
  }

  const startLabel = start.label;

  // `candidateVertices` seeds from the label bucket ONLY for a simple label; for anything
  // else it yields every vertex and leaves the filtering to its caller. Requiring a simple
  // (or absent) label keeps the seed exact without re-deriving that filtering here.
  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const proj: CProjection = cret.projection;

  // The five conditions `projectedRows` fast-paths, plus `star`: anything that sorts,
  // dedups, pages or aggregates needs the whole set in hand.
  if (
    proj.star ||
    proj.aggregating ||
    proj.distinct ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length === 0
  ) {
    return null;
  }

  // Every projected item may read ONLY the far variable — the restriction that lets the
  // binding hold one entry. An item reading the start would need it bound too (cheap), but
  // one reading the REL variable could not be served at all, and `freePredicateVars` does
  // not distinguish a name it does not recognize from one it does, so the narrow rule is
  // the sound one.
  for (const item of ret.projection.items) {
    for (const name of freePredicateVars(item.expr)) {
      if (name !== farVar) {
        return null;
      }
    }
  }

  const out = rel.direction === 'out';
  const farLabel: LabelExpr | undefined = node.label;

  return (graph, params) => {
    const rows: Row[] = [];
    // ONE binding, mutated per edge. This is the allocation the profile found.
    const binding = new Map<string, unknown>();
    const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;

    for (const v of candidateVertices(graph, startLabel)) {
      const bucket = index.get(v.id)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        const far: Vertex = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);
        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

/**
 * Exactly one DISTINCT item, and nothing that needs the whole set in hand.
 *
 * ONE item is the load-bearing condition: the dedup key is then `valueKey` of that single
 * value, so a duplicate costs neither a row object nor a `rowKey`. With two items the row
 * itself is the key and there is nothing to save.
 */
const distinctOneItem = (proj: CProjection): boolean =>
  proj.distinct &&
  !proj.star &&
  !proj.aggregating &&
  proj.items.length === 1 &&
  proj.orderBy.length === 0 &&
  proj.skip === undefined &&
  proj.limit === undefined;

/** The far end named, and the relationship plain and unnamed (nothing to bind per edge). */
const endsNamedAndPlainRel = (
  hop: { rel: { variable?: string }; node: { variable?: string } } | undefined,
): boolean =>
  hop === undefined ||
  (plainRel(hop.rel as never) && hop.rel.variable === undefined && hop.node.variable !== undefined);

/** Does `where` read nothing but `only`? A name it does not recognize counts against it. */
const whereReadsOnly = (where: Expr | undefined, only: string): boolean => {
  if (where === undefined) {
    return true;
  }

  for (const name of freePredicateVars(where)) {
    if (name !== only) {
      return false;
    }
  }

  return true;
};

/**
 * The pieces `detectDistinctProjection` needs, or `null` if the shape does not fit. Split out
 * so the detector stays under the complexity gate — the same split `groupedClauses` has from
 * its own detector, and for the same reason.
 */
type DistinctShape = {
  item: CReturnItem;
  keyedVar: string;
  onStart: boolean;
  startLabel: LabelExpr | undefined;
  farLabel: LabelExpr | undefined;
  adjacency: Adjacency | undefined;
  gatePred: CPredicate | undefined;
};

const distinctShape = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): DistinctShape | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret.kind !== 'return') {
    return null;
  }

  if (cret.kind !== 'return') {
    return null;
  }

  const proj: CProjection = cret.projection;

  if (!distinctOneItem(proj)) {
    return null;
  }

  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length > 1) {
    return null;
  }

  const { start } = pattern;
  const hop = pattern.segments.length === 1 ? pattern.segments[0] : undefined;
  const far = hop?.node;

  if (start.variable === undefined || !endsNamedAndPlainRel(hop)) {
    return null;
  }

  const startVar = start.variable;

  // The projected expression must read exactly ONE end, which is the element the walk
  // evaluates it against. A CONSTANT projection (no reads) dedupes to a single row and is
  // left to the general path rather than reasoned about with an empty binding.
  const reads = freePredicateVars(ret.projection.items[0].expr);
  const onStart = reads.size === 1 && reads.has(startVar);
  const onFar =
    hop !== undefined && reads.size === 1 && far?.variable !== undefined && reads.has(far.variable);

  if (!onStart && !onFar) {
    return null;
  }

  const keyedVar = onStart ? startVar : (far?.variable as string);
  const keyed = onStart ? start : (far as NonNullable<typeof far>);
  const other = onStart ? far : start;

  // The NON-keyed end is not visited by the evaluation, so it may carry nothing but a label.
  if (other !== undefined && !plainNode(other)) {
    return null;
  }

  if (!plainNode(keyed)) {
    return null;
  }

  // A clause `WHERE` reading only the keyed end is carried; anything else declines.
  const { where } = m;

  if (!whereReadsOnly(where, keyedVar)) {
    return null;
  }

  const gatePred = where === undefined ? undefined : compilePredicate(undefined, where);
  const startLabel = start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const [item] = proj.items;
  const adjacency: Adjacency | undefined =
    hop === undefined
      ? undefined
      : { direction: hop.rel.direction, ...(hop.rel.label ? { label: hop.rel.label } : {}) };
  const farLabel = far?.label;

  return { item, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred };
};

/**
 * `MATCH <node or 1-hop> RETURN DISTINCT <one expression over one end>` — dedupe by the
 * projected VALUE while walking, building a row only for each new one.
 *
 * ### Why
 *
 * `DISTINCT` is applied in `applyProjection` AFTER projection: every row is built, then
 * `rowKey`'d, then filtered. So a hop that yields 1,000,000 rows and 90 distinct values built
 * a million row objects and a million row keys to return ninety. Priced against native, which
 * this pass had never compared on the dedup family:
 *
 *     MATCH (a:Person)-[:KNOWS]->(x) RETURN DISTINCT x.age    ts 1153.3ms   native   7.4ms
 *     MATCH (n:Person) RETURN DISTINCT n.age                  ts  215.0ms   native   0.4ms
 *
 * A single projected item is the condition that makes this possible: the dedup key can then be
 * `valueKey` of the one value, so neither the row object nor `rowKey` is needed for a
 * duplicate. With two items the row itself is the key and nothing is saved, so it declines.
 *
 * Order is FIRST-SEEN in both paths — the general one keeps the first occurrence in stream
 * order, and a `Map`'s insertion order gives the same thing provided the walk meets elements
 * in the general path's order, which is `candidateVertices` then `expand` (item 142 had to
 * learn that the hard way, with a 7.4x given back for getting the order wrong).
 *
 * The filter is carried in the same change, per item 141's lesson, when it reads only the same
 * end as the projection.
 */
export const detectDistinctProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  const shape = distinctShape(clauses, compiled);

  if (shape === null) {
    return null;
  }

  const { item, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred } = shape;

  return (graph, params) => {
    const seen = new Map<string, Row>();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const take = (el: Vertex): void => {
      binding.set(keyedVar, el);

      if (gatePred !== undefined && !satisfies(el, gatePred, binding, params, graph)) {
        return;
      }

      const value = item.fn(env);
      const k = valueKey(value);

      if (!seen.has(k)) {
        seen.set(k, { [item.name]: value });
      }
    };

    for (const v of candidateVertices(graph, startLabel)) {
      if (adjacency === undefined) {
        take(v);

        continue;
      }

      for (const step of expand(graph, v, adjacency)) {
        if (farLabel !== undefined && !matchesLabel(step.node, farLabel)) {
          continue;
        }

        take(onStart ? v : step.node);
      }
    }

    return [...seen.values()];
  };
};
