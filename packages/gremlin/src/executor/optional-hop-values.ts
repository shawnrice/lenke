import type { Edge, Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { type ChainCsr, chainCsrFor } from './count-shortcut.js';
import type { HopValues } from './hop-values.js';
import { adjacentEdges, otherEndpoint, soleTypeBucket } from './movement.js';
import { optionalSingleHop } from './optional-hop.js';

/**
 * `V().optional(out(T)).values(k)` — the left-join idiom projected to bare values (item 1884).
 *
 * ⚠️ THE STEP IS ALREADY FUSED; THE PLAN IS NOT. `optional-hop.ts` (items 1480/1483/1628) removed
 * `optionalStep`'s per-traverser sub-plan — a one-element input array, a 103-arm dispatch, a
 * generator per step and a full materialization just to test non-emptiness — and took the adjacency
 * bucket directly for a directed single type. What remains is that the whole plan still runs in the
 * TRAVERSER pipeline: a traverser is allocated per row, handed to `projectValues`, and unwrapped.
 * Its fused twin `V().out(T).values(k)` allocates none of that.
 *
 * ⚠️ PRICED BEFORE IT WAS BUILT, one shape per process, both orders
 * (`optional-hop-floor-1884.mjs`, 20,000 vertices / 100,000 edges, median of 9). On this fixture
 * every vertex has an out-edge, so `optional` never takes its empty branch and the two shapes do
 * the SAME walk over the SAME rows:
 *
 * ```text
 *   V().optional(out(E)).values(n)   10.24 / 8.99 ms   80,000 rows   128 / 112 ns a row
 *   V().out(E).values(n)              3.13 / 2.55                      39 /  32
 *   V().optional(out(E)).id()         7.24 / 7.17                      91 /  90
 * ```
 *
 * **3.3-3.5x**, and the profile says where it goes (150 reps, query 80% of the process):
 * `optionalHopStep` 25.1%, `projectValues` 12.8%, `toArray` 11.3%, `unwrap` 7.6%,
 * `isVertexShaped` 6.5%, `get properties` 4.5%, `extend` 1.4% — the traverser machinery and the
 * generator boundaries, not the walk.
 *
 * ⚠️ THE EMPTY BRANCH IS THE WHOLE POINT OF `optional` AND IT IS MIRRORED EXACTLY, including the
 * subtle part: `optionalHopStep` sets `any` per EDGE, before the projection. So a vertex that HAS
 * edges whose far vertices all lack `k` emits **nothing** — not itself. Deciding emptiness from
 * whether any VALUE survived would be a different (and wrong) answer, and the fixture in the test
 * file has a vertex built to tell the two apart.
 *
 * ⚠️ A NEW MODULE, NOT A GUARD RELAXED IN `hop-values.ts` — items 1441/1466 measured an edit to that
 * file at up to 16% on UNRELATED rows, arbitrarily signed, and item 1466 declined a 3.3x win on
 * that basis. `optional-hop.ts`'s own header opens with the same reasoning. The gate is reused from
 * there (`optionalSingleHop`) rather than restated, so the two cannot drift about which sub-plan
 * shapes are a single hop.
 *
 * ⚠️ AND THE WALK CALLS THE SAME HELPERS THE STEP CALLS (`soleTypeBucket`, `adjacentEdges`,
 * `otherEndpoint`), not a second derivation of them. Gremlin stream order is a TinkerPop contract
 * and the differential fuzzer compares Gremlin results ORDERED, so a reordering here is a
 * cross-engine failure rather than an unspecified-order liberty.
 */
export const optionalHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, wrapper] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (wrapper.kind !== 'optional') {
    return undefined;
  }

  const hop = optionalSingleHop(wrapper.plan);
  // ⚠️ THE CHAIN IS TRIED SECOND, so the single-hop walk above keeps every plan it already served:
  // `hopChain` requires TWO OR MORE steps, so the two are disjoint by length and the order is for
  // reading. See `optionalHopChainValues` for what the extra width costs and why `any` moves.
  const chain = hop === undefined ? hopChain(wrapper.plan) : undefined;

  if (hop === undefined && chain === undefined) {
    return undefined;
  }

  const [, , proj] = steps;
  // ONE key, for `hopValuesShortcut`'s reason: `values()` with no key emits every property value
  // and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  return {
    rest: steps.slice(proj === undefined ? 2 : 3),
    values:
      chain === undefined
        ? walk(graph, { hop: hop as Hop, ...picked })
        : chainValues(graph, { hops: chain, ...picked }),
  };
};

/** One vertex-moving step, as `optionalSingleHop` reports it. */
type Hop = { kind: 'out' | 'in' | 'both'; labels: readonly string[] };

/**
 * The sub-plan as a CHAIN of two or more vertex steps, or `undefined` for every other shape
 * (item 1887).
 *
 * ⚠️ TWO OR MORE. One step is `optionalSingleHop`'s and must stay there — the walks differ in more
 * than width (see `chainWalk`), so overlapping them would be two routes for one shape.
 */
const hopChain = (plan: Plan): readonly Hop[] | undefined => {
  if (plan.steps.length < 2) {
    return undefined;
  }

  const hops: Hop[] = [];

  for (const step of plan.steps) {
    if (step.kind !== 'out' && step.kind !== 'in' && step.kind !== 'both') {
      return undefined;
    }

    hops.push({ kind: step.kind, labels: step.labels });
  }

  return hops;
};

/**
 * The far end of `e` for this hop, given the bucket shape `soleTypeBucket` reported.
 *
 * ⚠️ A PLAIN FUNCTION, NOT A GENERATOR, and that distinction is measured: reading each hop's targets
 * through a function that YIELDS put a generator frame back per vertex per hop and measured
 * **73.13 ms against the 68.75 of plain `adjacentEdges`**. This one is called per EDGE and returns a
 * vertex, so it inlines — and it exists at all only because the nested ternary it replaces is a
 * lint error.
 */
const farEnd = (
  hop: Hop,
  bucket: { readonly forward: boolean } | undefined,
  e: Edge,
  from: Vertex,
): Vertex => {
  if (bucket === undefined) {
    return otherEndpoint(hop.kind, e, from);
  }

  return bucket.forward ? e.to : e.from;
};

type ChainSpec = {
  readonly hops: readonly Hop[];
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * `V().optional(out(T), out(T)).values(k)` and deeper — item 1887.
 *
 * ⚠️ IT IS THE LARGEST GENERIC SHAPE THE GREMLIN ROUTE SCREEN HAD LEFT, by a factor of eight
 * (`gremlin-generic-floor-1887.mjs`, 20,000 vertices / 100,000 edges, one shape per process, median
 * of 20 less 3 warm-up):
 *
 * ```text
 *   optional(out(E), out(E)).values(n)   92.42 ms   320,000 rows   289 ns a row
 *   optional(out(E)).values(n)            6.41       80,000         80          ⬅ item 1884's twin
 *   outE(E).has(w, gt 3).count()         11.41            1 row
 *   outE(E).has(w, gt 3).values(w)       11.42       45,713
 *   outE(E).values(w)        [FUSED]     11.49       80,000         ⬅ at PARITY, so not a target
 * ```
 *
 * ⚠️⚠️ AND THE OBVIOUS FIX WAS BUILT FIRST, MEASURED NEUTRAL, AND REVERTED — which is the finding
 * worth keeping. The route screen reads this shape as **4,002 `applyStep` calls for 2,000
 * vertices**, i.e. item 1480's per-traverser sub-plan dispatch in full: a one-element input array, a
 * 103-arm dispatch and a generator per step, then the whole output materialized just to test
 * non-emptiness. Fusing the STEP — the exact change item 1480 made for one hop — took 92.42 ms to
 * **91.64**. The dispatch count is not the cost at this width; the 320,000 TRAVERSERS are, and only
 * a whole-plan rung emitting bare values removes those. A dispatch count is a route fact, not a
 * price.
 *
 * ⚠️ `any` MOVES TO THE END OF THE CHAIN, and that is a correctness difference rather than a loop
 * shape. At one hop every adjacent edge produces an output, so "has an edge" and "produced a row"
 * are the same question; at two they are not — a vertex whose neighbours have no out-edges produces
 * NOTHING and must therefore emit ITSELF. The single-hop walk's `any = true` sits inside its edge
 * loop and must stay there; this one sets it only where a row is actually emitted.
 *
 * ⚠️ NO TRAVERSER AND NO PATH, like every walk in this file, which is what the `tracksPath` guard in
 * `run` pays for: the chain's INTERMEDIATE vertices are on the general path's `path()` and are not
 * materialized here at all.
 */
/**
 * Every hop as a DIRECTED SINGLE TYPE, which is what the CSR can answer — or `undefined`.
 *
 * ⚠️ `both` AND MULTI-TYPE ARE REFUSED, and the second is a correctness refusal rather than a
 * coverage one: `buildChainCsr` appends one named bucket at a time and is sound only because "the
 * multi-type guard has already cleared", so an edge carrying two of the named types would be
 * appended TWICE where `iterLabeled` dedupes it. `hop-chain-values.ts` passes a single type per hop
 * for the same reason. An UNTYPED hop is refused too: it would walk every bucket, and the same
 * double-append argument applies to an edge carrying two types.
 */
const csrShape = (
  hops: readonly Hop[],
): readonly { forward: boolean; label: string }[] | undefined => {
  const out: { forward: boolean; label: string }[] = [];

  for (const hop of hops) {
    if (hop.kind === 'both' || hop.labels.length !== 1) {
      return undefined;
    }

    out.push({ forward: hop.kind === 'out', label: hop.labels[0] });
  }

  return out;
};

/**
 * The chain over the CSR: one flat `Int32Array` of neighbour SLOTS per hop, walked depth-first with
 * an explicit index stack (item 1888).
 *
 * ⚠️ IT IS THE SAME STRUCTURE `hopChainValuesShortcut` USES, and that is why it is worth having:
 * item 1887 left this walk at **44.83 ms against the two-hop fused walk's 3.77** for comparable
 * rows, and named the gap as the CSR. `chainCsrFor` is cached per graph per `topologyVersion` per
 * shape, so the build amortizes across calls and is dropped WHOLE on any topology write.
 *
 * ⚠️ THE ORDER IS THE GENERATOR WALK'S, which the differential fuzzer compares ORDERED for Gremlin.
 * `far-mask-drain.ts` states the argument this inherits: "`chainCsrFor` numbers slots by
 * `graph.verticesById` iteration order and fills each slot's run from that vertex's own bucket in
 * set order, so walking slots in order and each run in order emits the identical sequence to the
 * generator walk. Nothing is hoisted across vertices."
 *
 * ⚠️ AN EXPLICIT STACK, NOT RECURSION AND NOT NESTED GENERATORS. Item 1887 measured the three
 * shapes: nested generators 78.78 ms, an unrolled double loop 68.75, and a per-hop helper that
 * YIELDS **73.13 — worse than plain adjacency**. The frame is the cost, so there are none here: two
 * `Int32Array`s hold the cursor and the bound per level.
 */
const csrChainWalk = (
  graph: Graph,
  spec: ChainSpec,
  shape: readonly { forward: boolean; label: string }[],
): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { pick, drops } = spec;
    const csrs: ChainCsr[] = shape.map((h) => chainCsrFor(graph, h.forward, [h.label]));
    const [{ vtx }] = csrs;
    const last = csrs.length - 1;
    // One cursor and one bound per LEVEL, allocated once per query rather than per vertex.
    const cur = new Int32Array(csrs.length);
    const end = new Int32Array(csrs.length);

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const start = vtx[slot];
      let any = false;
      let level = 0;

      cur[0] = csrs[0].memo.off[slot];
      end[0] = cur[0] + csrs[0].memo.len[slot];

      while (level >= 0) {
        if (cur[level] >= end[level]) {
          level -= 1;

          if (level >= 0) {
            cur[level] += 1;
          }

          continue;
        }

        const target = csrs[level].memo.flat[cur[level]];

        if (level === last) {
          any = true;

          const value = pick(vtx[target]);

          if (!drops || value !== undefined) {
            yield value;
          }

          cur[level] += 1;
          continue;
        }

        level += 1;
        cur[level] = csrs[level].memo.off[target];
        end[level] = cur[level] + csrs[level].memo.len[target];
      }

      if (!any) {
        const value = pick(start);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
});

/** The CSR walk where every hop is a directed single type, and the generator walk otherwise. */
const chainValues = (graph: Graph, spec: ChainSpec): Iterable<unknown> => {
  const shape = csrShape(spec.hops);

  return shape === undefined ? chainWalk(graph, spec) : csrChainWalk(graph, spec, shape);
};

const chainWalk = (graph: Graph, spec: ChainSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { hops, pick, drops } = spec;
    // Hoisted once per QUERY, not per vertex: which arm runs is a property of the plan.
    const two = hops.length === 2 ? hops : undefined;

    for (const v of graph.vertices) {
      let any = false;

      /**
       * ⚠️ DEPTH TWO IS A DOUBLE LOOP, NOT THE RECURSION, AND THE DIFFERENCE IS MOST OF THE WIN.
       * The recursive `descend` below is correct and was the whole walk at first: it took the shape
       * from **92.42 ms to 78.78**, 1.17x, where the fused two-hop values walk does 320,000 rows in
       * ~4.4 ms. The cost is the GENERATOR per vertex per hop plus a `yield*` delegation per row —
       * 100,000 generator objects on this fixture — which is the same delegation chain
       * `hop-values.ts` and `hop-chain-values.ts` each removed by hand-walking. Two hops is the
       * spelling anyone writes, so it gets the loop and deeper chains keep the recursion.
       */
      if (two !== undefined) {
        const b1 = soleTypeBucket(v, two[0].kind, two[0].labels);
        // ⚠️ A `Set` IS DIRECTLY ITERABLE, so taking the bucket costs NO generator frame — which is
        // the whole point of this arm. Reading it through a helper that yields (the first cut) put
        // the frame straight back and measured WORSE than plain `adjacentEdges`: 73.13 ms against
        // 68.75. The branch is per vertex, not per edge.
        const edges1 =
          b1 === undefined ? adjacentEdges(two[0].kind, graph, v, two[0].labels) : b1.set;

        for (const e1 of edges1) {
          const mid = farEnd(two[0], b1, e1, v);
          const b2 = soleTypeBucket(mid, two[1].kind, two[1].labels);
          const edges2 =
            b2 === undefined ? adjacentEdges(two[1].kind, graph, mid, two[1].labels) : b2.set;

          for (const e2 of edges2) {
            any = true;

            const value = pick(farEnd(two[1], b2, e2, mid));

            if (!drops || value !== undefined) {
              yield value;
            }
          }
        }
      } else {
        for (const far of descend(v, hops, 0, graph)) {
          any = true;

          const value = pick(far);

          if (!drops || value !== undefined) {
            yield value;
          }
        }
      }

      if (!any) {
        const value = pick(v);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
});

/**
 * The chain walked DEPTH-FIRST from `v`, yielding each path's far endpoint.
 *
 * ⚠️ DEPTH-FIRST IS WHAT REPRODUCES THE GENERAL PATH'S ORDER, which the differential fuzzer compares
 * ORDERED for Gremlin: the generic route runs hop 2 over hop 1's output through lazily-pulled
 * generators, so the emitted sequence is the depth-first one. It calls `adjacentEdges` and
 * `otherEndpoint` — the same helpers the general step calls — rather than re-deriving adjacency
 * order.
 *
 * ⚠️ AT MODULE SCOPE ([[ts-closure-size-is-load-bearing]]). The recursion depth is the sub-plan's
 * step count, two or three in any spelling anyone writes, not the graph's.
 */
const descend = function* (
  v: Vertex,
  hops: readonly Hop[],
  at: number,
  graph: Graph,
): Iterable<Vertex> {
  const hop = hops[at];
  const last = at === hops.length - 1;

  for (const e of adjacentEdges(hop.kind, graph, v, hop.labels)) {
    const far = otherEndpoint(hop.kind, e, v);

    if (last) {
      yield far;
    } else {
      yield* descend(far, hops, at + 1, graph);
    }
  }
};

type Element = { readonly id: string; readonly properties: Record<string, unknown> };
type Picked = { pick: (e: Element) => unknown; drops: boolean };

/**
 * What the plan asks for about each emitted element. `undefined` declines the plan.
 *
 * `values(k)` DROPS an element lacking `k`, which is `projectValues`' own rule (`k in props`); a
 * bare `optional` yields the element and `id()` a string, so neither can produce `undefined` of its
 * own and the sentinel cannot swallow a real value. A property stored as `null` is PRESENT and is
 * emitted — `null !== undefined` — which is the engine's null-as-a-value policy.
 */
const pickFor = (proj: Step | undefined, valueKey: string | undefined): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: (e) => e.properties[valueKey], drops: true };
  }

  if (proj === undefined) {
    return { pick: (e) => e, drops: false };
  }

  return proj.kind === 'id' ? { pick: (e) => e.id, drops: false } : undefined;
};

type WalkSpec = {
  readonly hop: { kind: 'out' | 'in' | 'both'; labels: readonly string[] };
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE. `ts-closure-size-is-load-bearing`: a walk defined
 * INSIDE the returned closure gave unrelated queries a new slow mode at 4x, so the body lives here
 * and takes its spec as an argument.
 *
 * ⚠️ THE TWO ARMS ARE `optionalHopStep`'s TWO ARMS, for item 1628's reason: `soleTypeBucket` refuses
 * `both`, a multi-type hop and an untyped one, and those keep `adjacentEdges` exactly as the step
 * calls it. Three duplicated lines against a generator chain that is most of the shape.
 */
const walk = (graph: Graph, spec: WalkSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { hop, pick, drops } = spec;
    const { kind, labels } = hop;

    for (const v of graph.vertices) {
      const direct = soleTypeBucket(v, kind, labels);
      // ⚠️ `any` IS SET PER EDGE, BEFORE THE PROJECTION — `optionalHopStep`'s own order. A vertex
      // with edges whose far ends all lack the key emits NOTHING, not itself.
      let any = false;

      if (direct !== undefined) {
        const { set, forward } = direct;

        for (const e of set) {
          any = true;

          const value = pick(forward ? e.to : e.from);

          if (!drops || value !== undefined) {
            yield value;
          }
        }
      } else {
        for (const e of adjacentEdges(kind, graph, v, labels)) {
          any = true;

          const value = pick(otherEndpoint(kind, e, v));

          if (!drops || value !== undefined) {
            yield value;
          }
        }
      }

      if (!any) {
        const value = pick(v);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
});
