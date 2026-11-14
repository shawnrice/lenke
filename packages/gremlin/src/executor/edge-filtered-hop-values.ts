import type { Edge, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { matches, specializePredicate } from '../predicates.js';
import type { HopValues } from './hop-values.js';

/**
 * `V().outE(T).has(k, pred).inV().values(j)` — a hop with a predicate on the EDGE, which every
 * existing rung declines (item 1882).
 *
 * ⚠️ THE WHOLE FAMILY WAS GENERIC, AND THE UNFILTERED TWIN WAS NOT. `gremlin-route-screen.mjs`'s
 * `edgef:` family (added at item 1882, when the screen turned out to have no edge-PREDICATE row at
 * all):
 *
 * ```text
 *   generic   edgef: outE has inV values       4 applyStep calls   [has inV outE values]
 *   generic   edgef: outE has inV count        4
 *   generic   edgef: outE has count            3
 *   generic   edgef: outE has values           3
 *   generic   edgef: outE eq inV values        4
 *   generic   edgef: inE has outV values       4
 *   generic   edgef: bothE has otherV count    4
 *   SHORTCUT  edgef: outE inV values           0   ⬅ the SAME walk without the predicate
 * ```
 *
 * The predicate is the entire difference — not the direction, not the projection, not the terminal.
 * `hopValuesShortcut` destructures `[source, hop, proj]` and takes only the vertex-moving
 * `out`/`in`/`both`; `startFilteredHopValues` admits filters on the hop's two VERTEX ends and
 * nothing between them. An edge predicate sits exactly in the gap.
 *
 * ⚠️ PRICED ONE SHAPE PER PROCESS BEFORE IT WAS BUILT, with the 80,000 `E` edges all three shapes
 * visit as the denominator — the filtered shape emits 46% of the rows, so a per-ROW ratio flatters
 * it, which is why item 1858 declined a target (`edge-filter-floor-1882.mjs`, 20,000 vertices,
 * fanout 5, median of 9, both orders):
 *
 * ```text
 *   V().outE(E).has(w, gt 3).inV().values(n)   18.04 ms   45,713 rows   225 ns/edge-visit
 *   V().outE(E).inV().values(n)                 2.44       80,000        31
 *   V().out(E).values(n)                        2.56       80,000        32
 * ```
 *
 * **7.2x per edge visit for one property read and one comparison** over the identical adjacency
 * walk. The floor is not a model: it is the same traversal with the `has` deleted, measured in its
 * own process. ~23% of the profile was the `iterLabeled`/`iterByLabel`/`outEdgesOf` generator
 * delegation chain this walk skips, and the rest the traverser machinery behind
 * `isVertexShaped`/`filterStream`/`projectValues`.
 *
 * ⚠️ A NEW MODULE RATHER THAN A GUARD RELAXED IN `hop-values.ts`, for `start-filtered-hop-values.ts`'s
 * stated reason: items 1441 and 1466 measured an edit to that file at up to 16% on UNRELATED rows,
 * arbitrarily signed, and item 1466 declined a 3.3x win on exactly that basis. The two existing
 * values walks stay byte-identical and this one is consulted only where they already declined.
 *
 * ⚠️ AND THE SCOPE IS NARROW ON PURPOSE, which is item 1527's rule against forking a walk per
 * spelling. This takes ONE named edge type on `outE`/`inE`, one or more `has` steps, and the
 * matching `inV`/`outV`. `bothE`/`otherV` is declined: its two buckets make "the other end" depend
 * on which bucket the edge came from, a self-loop appears in both, and it is one row of the census
 * rather than four — a separate item with its own numbers. A declined shape simply stays where it
 * already is.
 */
export const edgeFilteredHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  // `V` + the edge hop + at least one `has` + the vertex move. Anything shorter cannot be this
  // shape, and `edgef: outE inV values` (no predicate) is `hopValuesShortcut`'s plan.
  if (steps.length < 4) {
    return undefined;
  }

  const [source, hop] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  // ONE named type. An untyped `outE()` walks every bucket and a multi-type one has to dedupe an
  // edge carrying two of the named types (`iterLabeled`'s `seen` set) — both are other walks.
  if ((hop.kind !== 'outE' && hop.kind !== 'inE') || hop.labels.length !== 1) {
    return undefined;
  }

  // The `has` run between the edge step and the vertex move. One or more; a `hasLabel`/`hasId`/
  // `hasKey` ends the run and will fail the move check below, which declines the plan.
  let at = 2;

  while (at < steps.length && steps[at].kind === 'has') {
    at += 1;
  }

  if (at === 2) {
    return undefined;
  }

  const move = steps[at];
  // `outE` pairs with `inV` and `inE` with `outV`: the far end of the edge, which is what the
  // vertex-moving `out`/`in` reach in one step. The OTHER pairing (`outE().outV()`) walks back to
  // the vertex the traversal came from — a different question, and not this walk.
  const wanted = hop.kind === 'outE' ? 'inV' : 'outV';

  if (move?.kind !== wanted) {
    return undefined;
  }

  const proj = steps[at + 1];
  // ONE key, for `hopValuesShortcut`'s reason: `values()` with no key emits every property value
  // and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  const edgeTest = compileEdgeTests(steps.slice(2, at));
  const [type] = hop.labels;
  const outward = hop.kind === 'outE';
  const { pick, drops } = picked;

  return {
    rest: steps.slice(at + 1 + (proj === undefined ? 0 : 1)),
    values: walk(graph, { type, outward, edgeTest, pick, drops }),
  };
};

type Far = { readonly id: string; readonly properties: Record<string, unknown> };
type Picked = { pick: (far: Far) => unknown; drops: boolean };

/**
 * What the plan asks for about the far vertex. `undefined` means a projection this walk does not
 * serve, which declines the whole plan.
 *
 * `values(k)` DROPS a far vertex lacking `k`, which is `projectValues`'s own rule (`k in props`);
 * a bare move and `id()` drop nothing, and neither can produce `undefined` of its own, so the
 * sentinel cannot swallow a real value.
 */
const pickFor = (proj: Step | undefined, valueKey: string | undefined): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: (far) => far.properties[valueKey], drops: true };
  }

  if (proj === undefined) {
    return { pick: (far) => far, drops: false };
  }

  return proj.kind === 'id' ? { pick: (far) => far.id, drops: false } : undefined;
};

/**
 * The edge predicates, compiled ONCE PER QUERY into one closure.
 *
 * ⚠️ THE SINGLE-`has` ARM IS A SEPARATE CLOSURE, not a one-element loop, and this is the call site
 * where that matters most: a filter on the EDGE runs once per EDGE, so at fanout 5 it is hit
 * 1,000,000 times against a start filter's 200,000. Item 1631 priced exactly that asymmetry on the
 * far-vertex side.
 *
 * ⚠️ AND `fast === undefined ? matches(...) : fast(x)` IS `dispatch.ts`'s has arm VERBATIM, because
 * the admitted route must agree with the declined one about every predicate, including the ones
 * `specializePredicate` has no specialization for. Item 1492 hoisted that call out of the
 * per-element closure for the same megamorphism reason this closure exists.
 */
const compileEdgeTests = (hasSteps: readonly Step[]): ((edge: Edge) => boolean) => {
  const gates = hasSteps.map((s) => {
    const step = s as Extract<Step, { kind: 'has' }>;
    const fast = specializePredicate(step.pred);
    const { key, pred } = step;

    return fast === undefined
      ? (edge: Edge) => matches(pred, edge.properties[key])
      : (edge: Edge) => fast(edge.properties[key]);
  });

  if (gates.length === 1) {
    return gates[0];
  }

  return (edge: Edge) => {
    for (const gate of gates) {
      if (!gate(edge)) {
        return false;
      }
    }

    return true;
  };
};

type WalkSpec = {
  readonly type: string;
  readonly outward: boolean;
  readonly edgeTest: (edge: Edge) => boolean;
  readonly pick: (far: Far) => unknown;
  readonly drops: boolean;
};

/**
 * ⚠️ WALK `graph.vertices` AND READ THE PER-VERTEX BUCKET, which is `startFilteredHopValues`'s
 * shape and its reasoning applies unchanged. `v.adjFrom` is the memoized
 * `graph.edgesFromByLabel.get(v.id)` the generic `outEdgesOf` reads, so a single named type is
 * `byLabel.get(type)` — literally what `iterLabeled` yields for one label. Gremlin stream order is
 * a TinkerPop contract and the differential fuzzer compares ORDERED, so emitting in global vertex
 * order with each bucket in its own order is the requirement, not a liberty.
 *
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE. `ts-closure-size-is-load-bearing`: a walk defined
 * INSIDE the returned closure gave unrelated queries a new slow mode at 4x (item 1413's family), so
 * the body lives here and takes its spec as an argument.
 */
const walk = (graph: Graph, spec: WalkSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { type, outward, edgeTest, pick, drops } = spec;

    for (const v of graph.vertices) {
      const bucket = outward ? v.adjFrom?.get(type) : v.adjTo?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        if (!edgeTest(edge)) {
          continue;
        }

        const value = pick(outward ? edge.to : edge.from);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
});
