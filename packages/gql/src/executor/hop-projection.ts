import type { Graph, Vertex } from '@lenke/core';

import type { Clause, LabelExpr } from '../ast.js';
import type { CClause, CProjection, Params, Row } from '../executor.js';
import { freePredicateVars, projectRow, relTypeNames } from '../executor.js';
import { candidateVertices, matchesLabel } from '../graph-queries.js';
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
