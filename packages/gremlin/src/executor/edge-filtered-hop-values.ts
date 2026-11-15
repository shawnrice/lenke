import type { Edge, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { matches, specializePredicate } from '../predicates.js';
import { edgeFlatFor } from './edge-flat.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { seenBefore } from './second-ask.js';

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
  /*
   * 🔑 THE MOVE IS OPTIONAL (item 1957). Without it the stream STAYS ON THE EDGE, which this rung
   * used to decline outright — so `V().outE(E).has(w, gt 3).values(w)` and the same plan with
   * `.count()` ran the generic chain at three `applyStep` calls each, while their MOVED sibling was
   * fused. Measured at 200,000 vertices / 1,000,000 edges, ns per EDGE VISITED (item 1955):
   *
   * ```text
   *   outE has values   193 ns   against a hand walk's 41.1   4.59x
   *   outE has count    173                          38.9     4.45x
   * ```
   *
   * Nothing about the WALK changes for them: the adjacency enumeration and the edge tests are
   * identical, and only what is picked out of each surviving edge differs. That is why this is one
   * walk with five picks rather than a second module — the fork item 1527 warns against. A step at
   * this position that is NEITHER the matching move NOR a projection this rung serves still
   * declines, because `pickFor` returns undefined for it.
   */
  const moved = move?.kind === wanted;
  // The projection sits after the move when there is one, and in the move's place when there isn't.
  const projAt = moved ? at + 1 : at;
  const proj = steps[projAt];
  // ONE key, for `hopValuesShortcut`'s reason: `values()` with no key emits every property value
  // and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const outward = hop.kind === 'outE';
  const picked = pickFor(proj, valueKey, moved, outward);

  if (picked === undefined) {
    return undefined;
  }

  const edgeTest = compileEdgeTests(steps.slice(2, at));
  const [type] = hop.labels;
  const { pick, drops } = picked;

  /*
   * ⚠️⚠️ **THE FLAT ARM IS BEHIND THE SECOND-ASK POLICY IN ITS OWN NAMESPACE** (item 2016). Item
   * 1889's policy, for its reasons verbatim — a one-shot query never builds, a write-every-read
   * workload never reaches a second ask on one topology version so it never builds either, and a
   * repeated read pays the build once. The `'e'` namespace matters: the nine vertex-CSR callers
   * share the default one DELIBERATELY because they all build `chainCsrFor` from that key, and
   * sharing it here would mark `>E` as seen and arm each of THEIR builds on its own first ask —
   * the 1.64x first-query regression the policy exists to prevent. See `second-ask.ts`.
   */
  const flat = seenBefore(graph, outward, type, 'e');

  return {
    // `consumed` rather than `proj === undefined`: an unconsumed terminal must stay in `rest`.
    rest: steps.slice(projAt + (picked.consumed ? 1 : 0)),
    values: walk(graph, { type, outward, edgeTest, pick, drops, flat }),
  };
};

/*
 * ⚠️ `pick` TAKES THE EDGE, NOT THE FAR VERTEX (item 1957). It used to take the far end, with the
 * walk doing `pick(outward ? edge.to : edge.from)` — which hard-wired the assumption that every
 * served shape projects the FAR side. The edge-valued shapes do not, so the endpoint deref moved
 * into the far-reading picks themselves. The hot loop got SIMPLER (`pick(edge)`) and the `outward`
 * branch is now captured once per closure instead of re-tested per edge.
 */
type Picked = {
  pick: (edge: Edge) => unknown;
  drops: boolean;
  /**
   * Did `pickFor` CONSUME the step it was given? `values(k)` and `id()` do; a terminal this walk
   * does not project (item 1956's `count()`) does not, and must be left in `rest` to run over the
   * walk's own stream. Before this field the two cases were conflated by `proj === undefined`,
   * which is why a `count()` terminal declined the whole plan.
   */
  consumed: boolean;
};

/**
 * What the plan asks for about the far vertex. `undefined` means a projection this walk does not
 * serve, which declines the whole plan.
 *
 * `values(k)` DROPS a far vertex lacking `k`, which is `projectValues`'s own rule (`k in props`);
 * a bare move and `id()` drop nothing, and neither can produce `undefined` of its own, so the
 * sentinel cannot swallow a real value.
 */
/*
 * ⚠️ THE DIRECTION AND THE SUBJECT ARE FOLDED IN AT COMPILE TIME, NOT COMPOSED — and item 1957
 * measured the difference. The first cut built one `subject` closure and wrapped it
 * (`(edge) => subject(edge).properties[key]`), which is TWO closure calls per edge where the code
 * before the item had one. On the already-fused `inV().values(k)` row that cost **+10% in the
 * shape's FAST mode** (80.5 -> 89.3 ms), while its slow mode and its MEDIAN were flat — the median
 * even improved, because the post arm happened to land in fast mode more often. Only a
 * mode-by-mode comparison showed it (item 1956's rule, earning itself one item later).
 *
 * Built this way each pick is ONE call, and `outward` is resolved per QUERY rather than per edge —
 * so the walk no longer evaluates `outward ? edge.to : edge.from` a million times either. That is
 * strictly less per-edge work than before the item, not merely equal.
 */
const valuePick = (key: string, moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge.properties[key];
  }

  return outward ? (edge) => edge.to.properties[key] : (edge) => edge.from.properties[key];
};

const elementPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge;
  }

  return outward ? (edge) => edge.to : (edge) => edge.from;
};

const idPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge.id;
  }

  return outward ? (edge) => edge.to.id : (edge) => edge.from.id;
};

const pickFor = (
  proj: Step | undefined,
  valueKey: string | undefined,
  moved: boolean,
  outward: boolean,
): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: valuePick(valueKey, moved, outward), drops: true, consumed: true };
  }

  if (proj === undefined) {
    return { pick: elementPick(moved, outward), drops: false, consumed: false };
  }

  if (proj.kind === 'id') {
    return { pick: idPick(moved, outward), drops: false, consumed: true };
  }

  /*
   * 🔑 A TERMINAL THIS WALK DOES NOT PROJECT STILL GETS THE WALK (item 1956). `count()` after the
   * vertex move used to decline the ENTIRE plan here, so
   * `V().outE(E).has(w, gt 3).inV().count()` ran the four-call generic generator chain while its
   * `values(n)` sibling — strictly MORE work, since a count needs no cell, no row and no result
   * stream — was fused by this same rung. The route screen is what showed it:
   *
   * ```text
   *   SHORTCUT  edgef: outE has inV values      0 applyStep calls
   *   generic   edgef: outE has inV count       4
   * ```
   *
   * Measured at 200,000 vertices / 1,000,000 edges, ns per EDGE VISITED (item 1955): the generic
   * count 188 against a hand count's 39, a 4.83x gap, while the fused values row sat at 84.
   *
   * ⚠️ IT IS NOT CONSUMED, deliberately. This walk has nothing to contribute to a count beyond
   * yielding the surviving far vertices, so `count` stays in `rest` and runs over this stream
   * instead of over the generic chain. Admitting the plan is the whole change; the step still
   * executes where it did.
   */
  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: false }
    : undefined;
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
  readonly pick: (edge: Edge) => unknown;
  readonly drops: boolean;
  /**
   * ⚠️ TAKE THE FLAT EDGE ARRAY? Decided ONCE per plan by the second-ask policy, so the walk never
   * re-asks and a one-shot query never pays a build. `run`'s lazy iterator ignores it: only `drain`
   * reads it, which is why there is no generator twin of the flat pass.
   */
  readonly flat: boolean;
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
/**
 * THE SAME WALK OVER A FLAT EDGE ARRAY — one linear pass, no per-vertex loop (item 2016).
 *
 * 🔑 **THE PER-VERTEX LOOP WAS DOING NOTHING BUT FINDING THE NEXT BUCKET.** This shape reads the
 * predicate off the edge's own bag and the projection off `edge.to`, so the vertex is never used —
 * which means 200,000 `adjFrom.get(type)` lookups and 200,000 `Set` iterators exist purely to
 * enumerate edges that a flat array enumerates with an index. Over 1,000,000 edges, one shape per
 * process, best of 9, same 571,428 rows:
 *
 * ```text
 *     the bucket walk above (shipped since item 1883)   122 ns/edge-visit
 *     THIS — the flat array, linear                       101             1.28x  (medians)
 *     the same walk BY HAND over the same Sets             86
 *     a flat edge array, two closures, DYNAMIC key         79   ⬅ the reachable floor
 *     the same, LITERAL property key                       56   ⬅ 1.41x is the KEYED LOAD
 * ```
 *
 * ⚠️ THE 1.41x KEYED-LOAD TERM IS UNREACHABLE RATHER THAN PENDING: the key is plan data, so
 * `edge.properties[key]` cannot become a literal access without runtime codegen, and
 * [[no-runtime-codegen]] is FIRM. Closure dispatch — the obvious suspect — measured ~3 ns. See
 * `edge-flat.ts` for the full decomposition.
 *
 * ⚠️⚠️ **THE ROW ORDER IS IDENTICAL BY CONSTRUCTION, NOT BY COINCIDENCE, and that is the whole
 * correctness argument.** `edgeFlatFor` appends each bucket in `graph.vertices` order, so position
 * `i` of the flat array is the `i`-th edge the nested loop would have visited. Gremlin rows are
 * compared ORDERED against the Rust engine for a single-type step, so a reordering here is a
 * cross-engine failure rather than an unspecified-order liberty — and a checksum cannot see it
 * (item 1955), which is why `edge-flat-order-2016.mjs` compares the two arms POSITIONALLY.
 *
 * ⚠️ NO GENERATOR TWIN. The bucket walk above offers both an iterator and a `drain` because it is
 * the only arm; this one is reached only from `drain`, so `run` keeps the lazy bucket walk and a
 * caller that `break`s out is unaffected — `hop-values.ts`'s rule. See the gate for why.
 */
const flatDrain = (graph: Graph, spec: WalkSpec): unknown[] => {
  const { type, outward, edgeTest, pick, drops } = spec;
  const flat = edgeFlatFor(graph, outward, type);
  const out: unknown[] = [];

  /*
   * ⚠️ `for...of` OVER THE ARRAY, AND IT IS NOT A CONCESSION TO THE LINT — it was MEASURED against
   * the indexed form and the two are indistinguishable: for-of 86.7/90.0 best and 102.9/100.2
   * median across two rounds, indexed 88.9/98.7 and 95.8/105.7, each winning one metric in each
   * round. V8 lowers a for-of over a plain array to an indexed walk, so there is no iterator to
   * remove. The win in this function is losing the 200,000 `adjFrom.get(type)` lookups and the
   * 200,000 `Set` iterators, not the loop form.
   */
  for (const edge of flat) {
    if (!edgeTest(edge)) {
      continue;
    }

    const value = pick(edge);

    if (!drops || value !== undefined) {
      out.push(value);
    }
  }

  return out;
};

const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
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

        const value = pick(edge);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
  /**
   * ⚠️ THE EAGER FILL, AND IT IS HALF THIS SHAPE'S COST (item 1893). `toArray` prefers `drain` when
   * the walk offers one (item 1412) and every arm of `hopValuesShortcut` offers one — so this rung
   * was spreading a GENERATOR over 457,142 rows where its neighbours fill an array. Priced against a
   * hand-written walk over the same `Set`s at 200,000 vertices / 1,000,000 edges:
   *
   * ```text
   *   the engine's rung, generator only   129.40 ms
   *   the same walk BY HAND               62.23      ⬅ 2.08x, all of it delegation
   *   the same walk over a flat array     34.69      ⬅ what an edge-indexed CSR could add
   * ```
   *
   * ⚠️ IT NEVER REPLACES THE ITERABLE, which is `hop-values.ts`'s rule: `run` stays as lazy as it
   * was for a caller that `break`s out, and `drain` is read only where the shortcut consumed the
   * whole plan. And it is the SAME loop written twice (item 169), because Gremlin results are
   * compared ORDERED.
   */
  drain() {
    /*
     * ⚠️ THE ROUTE CHOICE IS MADE ONCE, HERE, OUTSIDE THE LOOP — not per vertex and not per edge.
     * `spec.flat` was decided by the second-ask policy when the plan was admitted.
     */
    if (spec.flat) {
      return flatDrain(graph, spec);
    }

    const { type, outward, edgeTest, pick, drops } = spec;
    const out: unknown[] = [];

    for (const v of graph.vertices) {
      const bucket = outward ? v.adjFrom?.get(type) : v.adjTo?.get(type);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        if (!edgeTest(edge)) {
          continue;
        }

        const value = pick(edge);

        if (!drops || value !== undefined) {
          out.push(value);
        }
      }
    }

    return out;
  },
});
