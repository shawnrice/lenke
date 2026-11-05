import type { Graph, Vertex } from '@lenke/core';

import type { Plan } from '../ast.js';
import { matches } from '../predicates.js';
import { type VertexFilter, collectVertexFilters } from './count-shortcut.js';
import type { HopValues } from './hop-values.js';

/**
 * `V().hasLabel(L).out(T).values(k)` — a hop whose START IS FILTERED, which `hopValuesShortcut`
 * declines outright (item 1534). The YIELD twin of `count-shortcut.ts`'s `startFilteredHopCount`.
 *
 * `hopValuesShortcut` destructures `const [source, hop, proj] = steps` and refuses unless step 1 is
 * the hop, so ANY step between the source and the hop sends the whole plan to the traverser
 * pipeline. That reads like it should make every realistic hop decline — and it does not, which is
 * why this gap survived: `effectivePlan` runs `dropVacuousLabels`, so `hasLabel('P')` on a graph
 * where every vertex carries `P` is DELETED from the plan before the shortcut sees it. A SELECTIVE
 * label is not dropped, and then the decline is real.
 *
 * Item 1534 measured the family per row at 200,000 vertices, degree 1, `Q` on half the vertices —
 * the declined spelling against the admitted one, which emits TWICE the rows:
 *
 * ```text
 *   hasLabel(Q).out(E)              815.6 ns/row   vs   out(E)             189.9   4.30x
 *   hasLabel(Q).out(E).id()         834.7          vs   out(E).id()        240.7   3.47x
 *   has(k, gt(48)).out(E).values(k) 1123.4         vs   out(E).values(k)   372.3   3.02x
 *   hasLabel(Q).out(E).values(k)   1033.7          vs                      372.3   2.78x
 * ```
 *
 * The declined arm is also slower in WALL CLOCK while doing half the work (103.5 ms against 73.2),
 * which is what makes it a route loss rather than a slow walk: ~41% of it is the generator
 * delegation chain the hand walk skips (`iterLabeled` 24.6%, `outEdgesOf` 9.2%, `iterByLabel`
 * 7.2%), plus the traverser machinery `isVertexShaped`/`traverseToVertex`/`startTraverser`.
 * `hop-values.ts`'s own header prices that chain at 375.6 ms against 251.
 *
 * ⚠️ WHY THIS IS A NEW MODULE RATHER THAN A GUARD RELAXED IN `hop-values.ts`. Items 1441 and 1466
 * measured an edit to that file at up to 16% on UNRELATED rows, arbitrarily signed, and item 1466
 * declined a 3.3x win on exactly that basis. Item 1482 is the precedent for the way out — it took
 * the no-hop sibling (`V().hasLabel(L).values(k)`, 2.39x) into its own module. So `hop-values.ts`
 * is byte-identical and this walk is consulted only where it already declined.
 *
 * It is also why the SCOPE is narrow on purpose. `hopValuesShortcut` has four walks (`oneType`,
 * `pairTypes`, `manyTypes`, `bothOneType`) and forking all four here would be the duplication item
 * 1527 refused. This module takes exactly ONE named type on `out`/`in` — the shape every arm above
 * measures — and declines the rest, which simply leaves them where they already are. `both` and the
 * multi-type spellings are separate items with their own numbers.
 *
 * What is NOT duplicated is the filter admission itself. `collectVertexFilters` is
 * `count-shortcut.ts`'s, exported rather than reimplemented, because it carries a judgement this
 * module must not restate: it DECLINES a `has` whose key the property index could seek
 * (`seekWorthTaking`), deferring to `seedFromIndex`. Re-deriving that deference here is how the two
 * would drift.
 */
export const startFilteredHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  // `V` + at least one filter + the hop. At `length === 3` with no filter, `hopValuesShortcut`
  // already owns the plan and this one is never consulted.
  if (steps.length < 3) {
    return undefined;
  }

  const [source] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound `hopValuesShortcut` has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  // The hop is the first `out`/`in` after the source. Everything between has to be a vertex filter,
  // which `collectVertexFilters` decides below — so this scan only has to find the boundary.
  let at = 1;

  while (at < steps.length && steps[at].kind !== 'out' && steps[at].kind !== 'in') {
    at += 1;
  }

  if (at === 1 || at >= steps.length) {
    return undefined;
  }

  const hop = steps[at];

  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined;
  }

  // ONE named type. An untyped hop would have to walk every bucket and a multi-type one would have
  // to dedupe edges carrying two of the named types; both are `hopValuesShortcut`'s other walks.
  if (hop.labels.length !== 1) {
    return undefined;
  }

  const filters = collectVertexFilters(steps.slice(1, at), graph);

  if (filters === undefined) {
    return undefined;
  }

  const proj = steps[at + 1];
  // ONE key, for `hopValuesShortcut`'s reason: `values()` with no key emits every property value
  // and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  type Far = { readonly id: string; readonly properties: Record<string, unknown> };
  let pick: (far: Far) => unknown;
  // `values(k)` DROPS a far vertex lacking `k`; a bare hop and `id()` drop nothing.
  let drops = false;
  let consumed: number;

  if (valueKey !== undefined) {
    pick = (far) => far.properties[valueKey];
    drops = true;
    consumed = at + 2;
  } else if (proj === undefined) {
    pick = (far) => far;
    consumed = at + 1;
  } else if (proj.kind === 'id') {
    pick = (far) => far.id;
    consumed = at + 2;
  } else {
    return undefined;
  }

  const [type] = hop.labels;
  const forward = hop.kind === 'out';
  const rest = steps.slice(consumed);
  // ⚠️ WALK `graph.vertices` AND TEST THE LABEL. Seeding from `graph.verticesByLabel.get(L)` is
  // what `count-shortcut.ts`'s `startFilteredHopCount` does, it is one line, and it is WRONG here —
  // for two reasons that a count cannot observe and a yielded stream can:
  //
  //   * ORDER. Gremlin stream order is a TinkerPop contract that the differential fuzzer compares
  //     ORDERED (unlike GQL, where row order is unspecified). The general pipeline reaches this
  //     shape as `filterStream(stream, v => step.labels.some(l => v.labels.has(l)))` over
  //     `graph.vertices` — see `dispatch.ts`'s `hasLabel` arm — so the admitted route must emit in
  //     GLOBAL vertex order, not label-bucket order.
  //   * STALENESS. The raw `labels` SETTER has never maintained `verticesByLabel`; only
  //     `addLabelToVertex`/`removeLabelFromVertex` index. `core`'s `label-box.test.ts` pins that
  //     behaviour on purpose ("the stale bucket entry is pre-existing behaviour"). So the bucket is
  //     neither a subset nor a superset of the truth after a setter write, and seeding from it would
  //     both over- and under-yield where `labels.has` is right.
  //
  // Testing it per vertex is the same work the pipeline does, and it is where the 2.78-4.30x comes
  // from anyway: the saving is the generator chain and the traverser machinery per EDGE, not the
  // per-vertex scan. Seeding is a separate question with its own correctness burden.
  const tests = filters;

  return {
    rest,
    values: {
      *[Symbol.iterator]() {
        for (const v of graph.vertices) {
          if (!survives(v, tests)) {
            continue;
          }

          // The vertex's OWN adjacency box, not a hash of its id into the graph's map
          // (items 162/321/591).
          const bucket = (forward ? v.adjFrom : v.adjTo)?.get(type);

          if (bucket === undefined) {
            continue;
          }

          for (const edge of bucket) {
            const value = pick(forward ? edge.to : edge.from);

            if (!drops || value !== undefined) {
              yield value;
            }
          }
        }
      },
      // The same loop, eager. Read only by `toArray`, and only when `rest` is empty (item 1412).
      drain() {
        const acc: unknown[] = [];

        for (const v of graph.vertices) {
          if (!survives(v, tests)) {
            continue;
          }

          const bucket = (forward ? v.adjFrom : v.adjTo)?.get(type);

          if (bucket === undefined) {
            continue;
          }

          for (const edge of bucket) {
            const value = pick(forward ? edge.to : edge.from);

            if (!drops || value !== undefined) {
              acc.push(value);
            }
          }
        }

        return acc;
      },
    },
  };
};

/**
 * The residual start filters, in WRITTEN ORDER, per vertex.
 *
 * Shared between the lazy and eager walks rather than inlined twice, which is the opposite of the
 * rule for the per-EDGE body: item 159 measured a shared module-scope walk at 1.29x because its
 * call sites go polymorphic across compiles, and the two bodies above keep their per-edge loops
 * separate for that reason. This runs once per VERTEX, above a loop over that vertex's whole
 * adjacency, so it is the cold side of the same trade `anyFarMatches` names on the GQL side.
 */
const survives = (v: Vertex, tests: readonly VertexFilter[]): boolean => {
  for (const step of tests) {
    const ok =
      step.kind === 'hasLabel'
        ? step.labels.some((l) => v.labels.has(l))
        : matches(step.pred, v.properties[step.key]);

    if (!ok) {
      return false;
    }
  }

  return true;
};
