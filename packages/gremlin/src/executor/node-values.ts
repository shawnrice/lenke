// `V().values(k)` and `V().hasLabel(L).values(k)` — one property read per vertex, answered by a
// scan that builds no traverser.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A BRANCH IN `hop-values.ts`. Every edit to that file (and to
// `hop-projection.ts`) has measurably moved UNRELATED rows by up to ~16% in an arbitrary direction —
// items 1413, 1415, 1440, 1442, 1462 — which is why item 1466 declined a 3.3x walk outright. The
// perturbation is a consequence of editing the file, so a new file avoids it entirely. The only edit
// to a hot file here is one call site in `index.ts`, which items 1460 and 1479 both changed without
// the effect appearing.
//
// WHAT IT IS FOR. `hopValuesShortcut` eliminates the traverser pipeline for `V().out(T).values(k)`,
// but it requires a hop at `steps[1]`, so the NO-HOP forms never had a shortcut and ran the full
// pipeline. Item 1481's cross-surface probe measured `V().values('k')` against ISO-GQL's
// `MATCH (n:P) RETURN n.k` at **1.63x slower** over 200,000 vertices, and profiled the difference as
// traverser construction: `sourceFromIds` 17.3% + `extend` 9.1% + `startTraverser` 2.9% ~ 29% of the
// run, where GQL's node-projection walk builds none.
//
// ⚠️ THE VALUES MUST BE THE WHOLE ANSWER. This returns a plain iterable of values, so it is only
// offered when nothing follows the `values(k)`. A residual step would need a traverser to carry, and
// manufacturing one here would be slower than never having left the pipeline.
//
// ⚠️ `values(k)` DROPS A VERTEX LACKING `k`, it does not emit undefined — the same rule
// `hopValuesShortcut` states for its value mode, and `projectValues` implements with `k in props`.
// ⚠️ TWO DIFFERENT THINGS ARE CALLED "SEEDED" IN THIS ENGINE, and they are not the same rung.
// `seededNodeValuesShortcut` below is INDEX-seeded — `has(k, eq(v))` answered off a property index's
// bucket (item 1595). `idSeededValuesShortcut` is ID-seeded — `V(id, …)`, the element ids given in
// the query. They are disjoint by shape (one requires a `has`, the other requires ids on the source)
// and neither can take the other's plans. The same ambiguity exists in `count-shortcut.ts`, where
// `seededNodeCountShortcut` is index-seeded and `idSeededCount` is id-seeded (item 1649).
import type { Graph } from '@lenke/core';

import type { ID, Plan, Predicate, Step } from '../ast.js';
import { matches, specializePredicate } from '../predicates.js';
import { seedForStep } from './index-seed.js';
import { valueDedupeFilter } from './runtime.js';
import { asStringId } from './sources.js';
import { hasAdjacency, singleHopExistence } from './sub-plan-existence.js';

/** The same shape `hopValuesShortcut` returns, so `run` can treat both identically. */
export type NodeValues = Iterable<unknown> & {
  drain?: () => unknown[];
  /**
   * The row count WITHOUT materializing the rows (item 2062). Present only on walks where a tight
   * loop beats both `drain().length` and `countIterable` — see {@link nodeValuesWhereCount} for the
   * A/B that split in opposite directions across rows and why this is per-walk rather than global.
   */
  count?: () => number;
};

/**
 * `V()` with no explicit ids, optionally one `hasLabel`, then `values(k)` for exactly ONE key, and
 * nothing after it.
 *
 * `values()` with no key emits every property value and `values(a, b)` fans out per key — both are
 * different shapes, and each would need its own walk rather than this one.
 */
/**
 * The projection this rung can serve: one property, or the element id.
 *
 * 🔑 **`id` ADDED AT ITEM 2056, AND IT WAS THE SLOWER OF THE TWO DESPITE BEING THE CHEAPER READ.**
 * `V().values(k)` rode this rung at **4.42 ms** over 200,000 vertices while `V().id()` ran generically
 * at **8.29 — 1.88x** — even though an id is a field read and a property is a map lookup. The route
 * census named it unambiguously (`scan: id` generic, 1 dispatch `[id]`) where a timing alone would
 * have looked like noise on an 8 ms row.
 */
type ScanProjection = { readonly kind: 'values'; readonly key: string } | { readonly kind: 'id' };

const matchShape = (
  steps: readonly Step[],
): { label: Extract<Step, { kind: 'hasLabel' }> | undefined; proj: ScanProjection } | undefined => {
  const [source, second, third] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {
    return { label: undefined, proj: { kind: 'values', key: second.keys[0] } };
  }

  // ⚠️ `id()` TAKES NO MODULATOR and always yields, so there is no key to check and no row to drop —
  // which is why its walk below is a separate closure rather than a branch.
  if (steps.length === 2 && second?.kind === 'id') {
    return { label: undefined, proj: { kind: 'id' } };
  }

  if (
    steps.length === 3 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { label: second, proj: { kind: 'values', key: third.keys[0] } };
  }

  return undefined;
};

export const nodeValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = matchShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  /**
   * ⚠️⚠️ A `hasLabel` IS REFUSED SINCE ITEM 1870, AND IT USED TO BE THE RUNG'S HEADLINE CASE.
   * Item 1482 shipped this rung on exactly that shape at **2.39x** (PRE 13.11-14.18 ms, POST
   * 5.67-5.86). That measurement was right when it was taken and is now inverted: the PIPELINE
   * learned to seed a leading `hasLabel` from `graph.verticesByLabel` (`seedFromIndex`), so it
   * visits only the labelled vertices while this rung scans ALL of them and tests
   * `labels.some(...)` on each. Measured with a kill switch, one arm per build, at 200,000
   * vertices:
   *
   *     label covers    THIS RUNG    PIPELINE    pipeline faster by
   *     1 in 1             5.46 ms      5.61 ms   tie
   *     1 in 2             8.51         4.41      1.93x
   *     1 in 3            10.51         3.14      3.35x
   *     1 in 10            7.74         0.97      7.98x
   *     1 in 100           6.93         0.15      46x
   *     1 in 1000          6.78         0.01      678x
   *
   * The rung's cost is a FULL SCAN whatever the label matches; the pipeline's scales with the
   * label's size. So it loses for every selective label, ties when the label covers everything,
   * and **never wins** — which is why the refusal is unconditional rather than a crossover test.
   *
   * ⚠️ AN A/B's VERDICT DECAYS WHEN THE ARM IT BEAT GETS FASTER, and nothing here was watching.
   * The rung kept returning correct answers, and no test asserted it CLAIMED this shape — the
   * whole gremlin suite passes with the refusal in place — so a 678x regression sat in a shipped
   * rung invisibly. `node-values-label-refusal.test.ts` now pins the route so it cannot flip back
   * unnoticed.
   *
   * ⚠️ AND THIS ADDS NO READER OF `verticesByLabel`, which is the open owner decision it would
   * otherwise have run into (the public `v.labels = [...]` setter leaves that index stale).
   * Refusing simply lets `seedFromIndex`, which already reads it, do the work.
   */
  if (shape.label !== undefined) {
    return undefined;
  }

  const { proj } = shape;

  /*
   * ⚠️ ONE loop body, used by BOTH the iterator and `drain`. Writing `drain` as a second derivation
   * is item 169's lesson, and Gremlin results are compared ORDERED by the differential fuzzer, so a
   * divergence between the two would be a cross-engine failure rather than an unspecified-order
   * liberty.
   *
   * ⚠️⚠️ **TWO CLOSURES, NOT ONE WITH A BRANCH** — this file's own record is that "a branch in that
   * inner loop" cost 1.6x on the hot shape (item 159), and the hot shape here is the `values` one that
   * already rode this rung. The projection is chosen ONCE, outside the loop, so the `values` walk is
   * byte-for-byte the loop it was before item 2056.
   */
  const walkValues = function* (key: string): Generator<unknown> {
    for (const v of graph.vertices) {
      const props = v.properties;

      if (key in props) {
        yield props[key];
      }
    }
  };

  const walkIds = function* (): Generator<unknown> {
    for (const v of graph.vertices) {
      yield v.id;
    }
  };

  const walk = proj.kind === 'id' ? walkIds : (): Generator<unknown> => walkValues(proj.key);

  return {
    [Symbol.iterator]: walk,
    drain: () => [...walk()],
  };
};

/**
 * The scan walk for a `V().values(k)` PREFIX, with whatever follows returned as a RESIDUAL
 * (item 2021).
 *
 * ⚠️⚠️ **`nodeValuesShortcut` REQUIRES THE PLAN TO BE EXACTLY `V() + values(k)` — "and nothing after
 * it" — SO EVERY TRAILING STEP DROPPED THE WHOLE QUERY ONTO THE TRAVERSER PIPELINE.** That is why
 * `dedupe` needed a rung of its own below (item 1869, which priced the same gap at 11.96 against a
 * 5.81 floor), and it is why `order()` never got one. Measured at 200,000 vertices, one arm per
 * process, best of 9:
 *
 * ```text
 *     V().values(n)                      6.0 ms    30 ns/row   the fused scan
 *     V().values(n).order()             40.4      202          the PIPELINE
 *     the same by hand, collect + sort  11.8       59          ⬅ 3.4x off its own floor
 *     collect alone                      3.1       16
 * ```
 *
 * The profile of the slow arm is the generic pipeline end to end — `sortByBys` 23.8%, `orderStep`
 * 10.6%, `unwrap` 5.5%, `projectValues` 5.4%, `extend` 3.6%, `sourceFromIds` 3.3% — i.e. a traverser
 * allocated per value so `orderStep` can spread them back into an array.
 *
 * 🔑 **SO THE FIX IS NOT A RUNG PER RESIDUAL, WHICH IS THE SHAPE THIS FAMILY HAD BEEN GROWING.**
 * `fusedProjectedResidual` already handles a trailing `order()` (item 1630), `count()` (2020),
 * `fold()` (1909), `min`/`max` (1908) and `aggregate().cap()`/`store().cap()` (1911) for the HOP
 * walks. Handing it the scan walk too gives all five to this shape in one change.
 *
 * ⚠️ IT REUSES `nodeValuesShortcut` RATHER THAN RE-DERIVING THE WALK, by asking it about the prefix.
 * The alternative — hoisting that walk to module scope and sharing it — would edit the code path of
 * `V().values(k)` itself, which is a 6 ms row, and [[executor-edits-perturb]] prices that kind of
 * edit at up to 16% on unrelated shapes. This way the existing walk is untouched: one `Plan` object
 * and one `slice` per QUERY, not per row.
 *
 * ⚠️ A PLAN WITH NO RESIDUAL RETURNS `undefined`, so `nodeValuesShortcut` keeps owning its own
 * shape and this cannot shadow it. The `dedupe` rung also runs BEFORE this (both are inside
 * `scanValuesShortcut`), so `values(k).dedupe()` keeps its narrower, better path.
 */
export const scanValuesResidual = (
  plan: Plan,
  graph: Graph,
): { values: NodeValues; rest: readonly Step[] } | undefined => {
  const { steps } = plan;

  // `V()` + `values(k)` is two steps; with nothing after them the rung above owns the plan.
  if (steps.length <= 2) {
    return undefined;
  }

  const values = nodeValuesShortcut({ ...plan, steps: steps.slice(0, 2) }, graph);

  return values === undefined ? undefined : { values, rest: steps.slice(2) };
};

/**
 * ONE loop body for both the iterator and `drain`, AT MODULE SCOPE — the EXISTENCE-FILTERED scan
 * (item 2025). Module scope for this file's own recorded reason: a per-call generator definition
 * made the sibling vertex rung **1.2x SLOWER than the pipeline it replaces**.
 *
 * ⚠️ THE TEST IS `hasAdjacency`, NOT A SECOND DERIVATION. `sub-plan-existence.ts` already decides
 * "does this vertex have any adjacency the hop would take", and its gate is deliberately BROADER
 * than `soleTypeBucket`'s — `both`, a multi-type hop and an untyped one are all admissible for a
 * yes/no, because double-counting, self-loop duplicates and endpoint choice are unobservable in an
 * existence test. Re-deriving that here would be the one thing byte-identity cannot survive.
 */
/**
 * The COUNT of {@link nodeValuesWhereWalk}, as a tight loop (item 2062).
 *
 * ⚠️⚠️ **THIS EXISTS BECAUSE NEITHER EXISTING ARM WINS.** `countProjectedWalk` chooses between
 * `drain().length` and `countIterable`, and an A/B over the three rows that actually reach it split
 * in OPPOSITE directions:
 *
 * ```text
 *     where: sub-traversal count     drain 16.16   iterate 14.07   <- iterate 1.15x FASTER
 *     edge: outE.has(w).inV.count    drain 12.67   iterate 37.94   <- drain  2.99x faster
 *     edge: outE.has(w).count        drain 10.89   iterate 38.88   <- drain  3.57x faster
 * ```
 *
 * So a blanket flip would be a ~3x REGRESSION on two rows (item 1998's finding, larger than it was
 * measured there). The choice is a property of the WALK, not of the count — so the walk that can
 * count cheaply says so, and the others are untouched.
 *
 * 🔑 **AND A TIGHT LOOP BEATS BOTH ARMS, because neither avoids the generator.** `drain().length`
 * allocates a 200,000-element array for a query returning one number; `countIterable` skips the array
 * but still pays a `yield` per surviving row. This pays neither — item 2061's hand floor for exactly
 * this shape was 7.85 ms against the engine's 14.74.
 *
 * ⚠️ IT MUST STAY THE SAME PREDICATE AS THE WALK ABOVE, including the `key in props` drop that is
 * `values(k)`'s contract — a count that disagreed with the walk it claims to count would be a wrong
 * answer no row-count test on the walk alone could see. `where-haskey-count.test.ts` asserts the two
 * agree.
 */
const nodeValuesWhereCount = (
  graph: Graph,
  hop: ReturnType<typeof singleHopExistence> & object,
  key: string,
): number => {
  let n = 0;

  for (const v of graph.vertices) {
    if (!hasAdjacency(v, hop)) {
      continue;
    }

    if (key in v.properties) {
      n += 1;
    }
  }

  return n;
};

const nodeValuesWhereWalk = function* (
  graph: Graph,
  hop: ReturnType<typeof singleHopExistence> & object,
  key: string,
): Generator<unknown> {
  for (const v of graph.vertices) {
    if (!hasAdjacency(v, hop)) {
      continue;
    }

    const props = v.properties;

    // `values(k)` DROPS an element lacking `k` — `projectValues`' own `k in props` rule.
    if (key in props) {
      yield props[key];
    }
  }
};

/**
 * `V().where(<one hop>).values(k)` — the scan with its existence filter folded in (item 2025).
 *
 * ⚠️⚠️ **THE FILTER WAS ALREADY FUSED AND THE PLAN STILL WAS NOT.** `sub-plan-existence.ts` removed
 * the per-traverser SUB-PLAN dispatch (its header: this shape was **87.35 ms** at 200,000 vertices
 * against `V().values(n)`'s 4.17, the filter alone **404 ns a vertex**), which is why the row is no
 * longer catastrophic. But the plan still runs the traverser PIPELINE — a traverser per vertex, then
 * `projectValues` — because `where` sits BETWEEN `V()` and `values`, so `nodeValuesShortcut`'s
 * exact-shape gate declines and the scan rung never sees it. Item 2021 widened that gate for a
 * TRAILING step; this is the same gap one position to the left.
 *
 * MEASURED at 200,000 vertices, every vertex passing the filter so the arms are comparable on ROWS
 * as well as vertices (item 1858's trap), one arm per process, best of 9, digests identical:
 *
 * ```text
 *     V().where(out(E)).values(n)          29.3 ms   146 ns/vertex
 *     the same BY HAND                      9.2      46            ⬅ 3.19x
 *     V().values(n)   (the fused scan)      4.9      24
 *     the bucket test alone, counting       6.4      32
 * ```
 *
 * ⚠️ NO `hasLabel` ARM, deliberately — see `nodeValuesShortcut`'s note: a leading `hasLabel` is
 * refused there because `seedFromIndex` visits only the labelled vertices while a scan visits all,
 * and it **never wins** (up to 678x worse at 1-in-1000). An existence filter has no such index, so a
 * full scan is the only route and the refusal does not transfer.
 */
export const nodeValuesWhereShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const { steps } = plan;

  if (steps.length !== 3) {
    return undefined;
  }

  const [source, filter, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  // ONE key: `values()` with no key emits every property value and `values(a, b)` fans out per key.
  if (proj.kind !== 'values' || proj.keys.length !== 1) {
    return undefined;
  }

  /*
   * ⚠️ ONLY `where(<a sub-plan>)`. The step kind is overloaded — `where(pred)` and
   * `where(startKey, pred)` are value comparisons against a tagged step, not existence tests — and
   * `singleHopExistence` reads `plan`, so a `where` without one declines here by construction.
   */
  if (filter.kind !== 'where' || !('plan' in filter)) {
    return undefined;
  }

  const hop = singleHopExistence(filter.plan);

  return hop === undefined
    ? undefined
    : {
        [Symbol.iterator]: () => nodeValuesWhereWalk(graph, hop, proj.keys[0]),
        // ⚠️ THE COUNTING FAST PATH (item 2062), consumed by `countProjectedWalk` when a residual is
        // only a `count()`. Optional on the type, so every other walk is unaffected.
        count: () => nodeValuesWhereCount(graph, hop, proj.keys[0]),
        // ⚠️ THE EAGER FILL: `toArray` prefers `drain` (item 1412), and a walk without one is
        // measured against siblings that have it with its generator hand tied (item 1998's 1.55x).
        drain: () => [...nodeValuesWhereWalk(graph, hop, proj.keys[0])],
      };
};

/**
 * The EXISTENCE-FILTERED scan for a `V().where(<one hop>).values(k)` PREFIX, with whatever follows
 * returned as a RESIDUAL (item 2026).
 *
 * ⚠️⚠️ **THE CORNER LEFT BY WIDENING THE GATE FROM TWO SIDES.** Item 2021 let the plain scan carry a
 * trailing residual; item 2025 let it carry a leading existence filter. Neither admits BOTH, so the
 * route census read:
 *
 * ```text
 *     SHORTCUT  scan: where values
 *     generic   scan: where values order     [order values where]
 *     generic   scan: where values count     [count hasKey where]
 *     generic   scan: where values dedupe    [dedupe values where]
 * ```
 *
 * Priced at 200,000 vertices, every vertex passing the filter, against the SAME residual on the
 * already-fused prefix — so the question is what the residual costs when the prefix is fused rather
 * than whether a sort is expensive:
 *
 * ```text
 *                        with `where`   without   fused prefix + residual
 *     … .order()            49.5 ms      13.9      ~23.9   ⬅ ~2.1x available
 *     … .count()            19.3          2.3      ~12.3   ~1.6x
 *     … .dedupe()           18.6          4.4      ~14.4   ~1.3x
 *     … (no residual)       14.6          4.6
 * ```
 *
 * ⚠️ `dedupe` IS NOT COVERED and that is not an oversight: `fusedProjectedResidual` handles
 * `order`/`count`/`fold`/`min`/`max`/`cap`, while `dedupe` has its own rung
 * (`nodeValuesDedupeShortcut`, item 1869) which this prefix cannot reach. Its ~1.3x stays open and
 * is the smallest of the three.
 *
 * ⚠️ IT REUSES `nodeValuesWhereShortcut` BY ASKING IT ABOUT THE PREFIX — item 2021's pattern, for
 * item 2021's reason: the alternative edits the walk that serves the 3-step shape, and
 * [[executor-edits-perturb]] prices that kind of edit at up to 16% on unrelated rows. One `Plan`
 * object and one `slice` per QUERY, not per row. It also inherits every refusal that rung makes —
 * the predicate-`where` overload, the multi-key projection, the narrowed source — rather than
 * restating them.
 */
/**
 * The COUNT of the existence-filtered scan, reached through the `hasKey` spelling the engine's own
 * rewrite produces (item 2061).
 *
 * ⚠️⚠️ **A SOUND REWRITE WAS DEFEATING A BIGGER FUSION.** `index.ts` turns `values(k) … count()` into
 * `hasKey(k) … count()` so a count never materializes values — a good rewrite, and the reason this
 * route was expected to be CHEAP. But `scanWhereValuesResidual` matches on `values` in the projection
 * slot, so the rewritten plan declined and fell through to the full generic pipeline. Item 2060
 * measured the result: **counting cost MORE than counting AND materializing every value** (18.99
 * against 16.37 ms, emitting 1 row against 200,000), and the two arms shared NO profile frames —
 * `hopExistenceStep`, `filterStream`, `sourceFromIds`, `countStep`, `startTraverser` all count-only,
 * because the count arm allocated a traverser per vertex and re-evaluated the existence hop in each.
 *
 * ```text
 *     V where values count   -> residual claimed, rest=[count]
 *     V where hasKey count   -> DECLINED            <- what the engine actually hands the rung
 * ```
 *
 * 🔑 **THE EQUIVALENCE IS THE ENGINE'S OWN, NOT ONE INVENTED HERE.** The rewrite's comment states it:
 * `hasKey` is "exactly 'the property is present', i.e. what `values(k)` emitting nothing for a
 * missing key already means". So the number of rows a `values(k)` walk emits IS the `hasKey(k)` count,
 * and handing the prefix to `nodeValuesWhereShortcut` as a `values` step counts the right vertices.
 *
 * ⚠️⚠️ **GATED TO A `count` RESIDUAL AND NOTHING ELSE — ANY OTHER RESIDUAL WOULD BE A WRONG ANSWER.**
 * `hasKey` keeps ELEMENTS (vertices); `values` emits VALUES. A residual that only asks "how many" is
 * blind to the difference, but `order()`, `min()`, `max()` and `fold()` are not: substituting the
 * projection under those would sort or fold the VALUES where the plan asks for the VERTICES. That is
 * why this is a separate narrow rung rather than a `hasKey` arm inside `scanWhereValuesResidual`, and
 * `where-haskey-count.test.ts` asserts each of those still declines.
 */
export const scanWhereHasKeyCountResidual = (
  plan: Plan,
  graph: Graph,
): { values: NodeValues; rest: readonly Step[] } | undefined => {
  const { steps } = plan;

  // Exactly `V()` + `where` + `hasKey(k)` + `count()`. Anything longer carries a further residual
  // whose element type would matter, so it is not this shape.
  if (steps.length !== 4) {
    return undefined;
  }

  const [, , projection, tail] = steps;

  if (tail?.kind !== 'count' || projection?.kind !== 'hasKey' || projection.keys.length !== 1) {
    return undefined;
  }

  const asValues: Step = { kind: 'values', keys: [projection.keys[0]] };
  const values = nodeValuesWhereShortcut({ ...plan, steps: [steps[0], steps[1], asValues] }, graph);

  return values === undefined ? undefined : { values, rest: [tail] };
};

export const scanWhereValuesResidual = (
  plan: Plan,
  graph: Graph,
): { values: NodeValues; rest: readonly Step[] } | undefined => {
  const { steps } = plan;

  // `V()` + `where` + `values(k)` is three steps; with nothing after them the rung above owns it.
  if (steps.length <= 3) {
    return undefined;
  }

  const values = nodeValuesWhereShortcut({ ...plan, steps: steps.slice(0, 3) }, graph);

  return values === undefined ? undefined : { values, rest: steps.slice(3) };
};

/**
 * ONE loop body for both the iterator and `drain`, AT MODULE SCOPE — the fused scan DEDUPE walk
 * (item 1869).
 *
 * ⚠️ MODULE SCOPE FOR THE REASON THE NEXT NOTE SPELLS OUT: a per-call generator definition made the
 * sibling vertex rung **1.2x SLOWER than the pipeline it replaces**. The parameters carry what a
 * closure would have captured.
 *
 * ⚠️ THE DEDUPE PREDICATE IS THE ENGINE'S OWN, not a second derivation. `valueDedupeFilter` is the
 * exact code `dispatch.ts` runs — extracted at item 1869 rather than copied — so the dedup CLASSES
 * here are the pipeline's by construction, including the `LocalDate`-on-`days` space and the
 * composite `WeakSet` short-circuit. Re-deriving "which values are the same value" is the one thing
 * byte-identity against the Rust engine cannot survive.
 *
 * ⚠️ AND THE ORDER IS FIRST-OCCURRENCE, which is `dedupe()`'s contract and the pipeline's own
 * behaviour. It holds here because this scans `graph.vertices` in the same order the pipeline's
 * source does and filters in place — it does not collect a `Set` and emit its contents, which would
 * be insertion order only by accident of the implementation. Gremlin results are compared ORDERED
 * by the differential fuzzer, so the test file asserts the sequence rather than the set.
 */
const nodeValuesDedupeWalk = function* (
  graph: Graph,
  labels: readonly string[] | undefined,
  key: string,
): Generator<unknown> {
  const keep = valueDedupeFilter();

  for (const v of graph.vertices) {
    if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
      continue;
    }

    const props = v.properties;

    if (key in props && keep(props[key])) {
      yield props[key];
    }
  }
};

/**
 * `V()[.hasLabel(L)].values(k).dedupe()` — the fused scan projection with its dedupe folded in.
 *
 * ⚠️ FOUND BY A ROUTE SCREEN AND PRICED BEFORE IT WAS BUILT (items 1868/1869). `nodeValuesShortcut`
 * requires NOTHING after `values`, so a trailing `dedupe` fell to the traverser pipeline — which
 * builds a traverser per value to keep 997 of 200,000:
 *
 *     V().values(k)                  5.81 ms   200000 rows   the fused floor
 *     V().values(k).dedupe()        11.96        997 rows    the pipeline
 *     V().values(k).count()          2.42          1 row     a fused sibling
 *
 * ⚠️ AND THE GAP WAS ALREADY DIAGNOSED IN THE ENGINE'S OWN SOURCE. `dedupe`'s note records
 * `values(k).dedup()` at 3.4-3.6x the GQL `RETURN DISTINCT` spelling for num and str columns and
 * says in terms that this residual "is the TRAVERSAL STREAM'S own cost and not a keying defect".
 * That sentence is the whole nomination: removing the stream is exactly what this does, and the
 * keying is reused untouched.
 *
 * ⚠️ A LABELLED OR MODULATED `dedupe` IS REFUSED. `dedupe('a')` keys on tagged values and
 * `dedupe().by(k)` on something other than the element — the same refusal `distinctHopCount` and
 * `dedupedHopChainCount` make. Only the BARE form reaches this.
 */
export const nodeValuesDedupeShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const { steps } = plan;
  const last = steps[steps.length - 1];

  if (
    last?.kind !== 'dedupe' ||
    (last.labels?.length ?? 0) > 0 ||
    (last.bys?.length ?? 0) > 0
    // ⚠️ NO `scope` CHECK: `dedupe` has no local form in this AST (`{ kind, labels?, bys? }`), so a
    // `scope === 'local'` guard was written here and `tsc` rejected it. A gate nothing can observe
    // comes out rather than staying untested — item 1016's rule, and the typechecker caught this
    // one before a mutant could report it as a survivor.
  ) {
    return undefined;
  }

  // Everything before the `dedupe` must be exactly the shape the plain rung answers — reusing its
  // `matchShape` rather than restating the source/label/one-key conditions, so the two cannot
  // drift about which scans they claim.
  const shape = matchShape(steps.slice(0, -1));

  if (shape === undefined) {
    return undefined;
  }

  /**
   * ⚠️⚠️ A `hasLabel` IS REFUSED, AND THE REASON IS A MEASURED REGRESSION — admitting it made this
   * rung **2.3x SLOWER than the pipeline it replaces** (3.43 -> 7.91 ms at 200,000 vertices with
   * `U` on one in three).
   *
   * The pipeline SEEDS from the label index, so `V().hasLabel(U)` visits 66,667 vertices; a
   * whole-graph walk visits 200,000 and tests `labels.some(...)` on every one. No amount of saved
   * traverser allocation covers 3x the vertices. The unlabelled shape has no such alternative — a
   * bare `V()` scan IS the whole graph either way — which is why it wins 1.58x and this loses.
   *
   * ⚠️ AND SEEDING FROM `graph.verticesByLabel` IS NOT A FREE FIX. It is the index every GQL label
   * elision trusts and the public `v.labels = [...]` setter does NOT maintain — an OPEN owner
   * decision, with a wrong answer reachable through the public API. Adding another reader of it is
   * a thing to RAISE, not to slip into a speedup.
   *
   * ⚠️ IT ALSO MEANS `nodeValuesShortcut` BESIDE THIS ONE MAY CARRY THE SAME LATENT REGRESSION: it
   * accepts `hasLabel` and walks `graph.vertices`. Measured separately at item 1869 rather than
   * assumed from this result.
   */
  if (shape.label !== undefined) {
    return undefined;
  }

  /*
   * ⚠️ AN `id` PROJECTION DECLINES HERE, DELIBERATELY. `matchShape` learned `id()` at item 2056 for
   * the undeduped scan; this rung's walk dedupes PROPERTY VALUES, and `V().id().dedupe()` is a
   * different question (ids are already distinct, so the dedupe is a tautology this rung would pay
   * for). Declining leaves it to the general path rather than guessing — and [[hop-values-dedupe]]'s
   * header records that items 1561/1562 each found a silent ANSWER change from a second keyer in this
   * area.
   */
  if (shape.proj.kind !== 'values') {
    return undefined;
  }

  const { key } = shape.proj;

  return {
    [Symbol.iterator]: () => nodeValuesDedupeWalk(graph, undefined, key),
    drain: () => [...nodeValuesDedupeWalk(graph, undefined, key)],
  };
};

/**
 * ONE loop body for both the iterator and `drain`, AT MODULE SCOPE.
 *
 * ⚠️ MODULE SCOPE IS NOT STYLE, IT IS THE WHOLE WIN. Written as a closure inside the shortcut — so a
 * fresh generator function is defined on every call — this rung measured **1.2x SLOWER than the
 * traverser pipeline it replaces** (346 ns against 283), and the decomposition said why:
 * `drain()` cost **203 ns on a freshly constructed rung against 62.9 ns on a reused one**, all of it
 * the per-call closure. `ts-closure-size-is-load-bearing` records the same effect at 4x on an
 * unrelated shape. Hoisted, the parameters carry what the closure used to capture.
 *
 * It stays ONE body for both consumers for the reason the shortcut above states: Gremlin results are
 * compared ORDERED by the differential fuzzer, so two derivations that could drift would be a
 * cross-engine failure rather than an unspecified-order liberty (item 169).
 */
// EXPORTED FOR THE PROBE ONLY (item 1660's `rung-walkonly` arm, `gremlin-point-floor.ts`), which
// prices the shape match and the generator protocol separately. Nothing in the engine calls it from
// outside this module, and a probe that re-implemented the loop would be measuring its own copy.
export const seededIdWalk = function* (
  ids: readonly ID[],
  labels: readonly string[] | undefined,
  key: string,
  graph: Graph,
): Generator<unknown> {
  for (const id of ids) {
    const v = graph.getVertexById(asStringId(id));

    if (v === undefined || v === null) {
      continue;
    }

    if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
      continue;
    }

    const props = v.properties;

    if (key in props) {
      yield props[key];
    }
  }
};

/**
 * The same shape as {@link matchShape} but with the ids the source names — `V(id, …)` rather than
 * `V()`.
 */
const matchSeededShape = (
  steps: readonly Step[],
):
  | {
      ids: readonly ID[];
      label: Extract<Step, { kind: 'hasLabel' }> | undefined;
      key: string;
    }
  | undefined => {
  const [source, second, third] = steps;

  if (source?.kind !== 'V') {
    return undefined;
  }

  const { ids } = source;

  if (ids === undefined || ids.length === 0) {
    return undefined;
  }

  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {
    return { ids, label: undefined, key: second.keys[0] };
  }

  if (
    steps.length === 3 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { ids, label: second, key: third.keys[0] };
  }

  return undefined;
};

/**
 * `V(id, …)[.hasLabel(L)].values(k)` — THE POINT LOOKUP, answered by resolving the ids with no
 * traverser (item 1650).
 *
 * ⚠️ WHY THIS SHAPE, AND WHY NOW. Item 1642 decomposed this query and named the fix: "a closed-form
 * route for seeded by id + one projection that never builds a traverser". Item 1649 built the
 * `count()` half; this is the projection half, and it was the LAST arm of the point lookup. Measured
 * against a hand floor (`getVertexById` + a property read) on `gremlin-point-floor.ts`:
 *
 * ```text
 *   floor  getVertexById + props.k    15.7 ns
 *   V(id).values(k)                  286.3 ns     18.2x
 * ```
 *
 * where per-element work is negligible and the whole cost is per-call pipeline setup for an answer
 * of ONE value.
 *
 * ⚠️ `asStringId` RAISES ON A NON-STRING ID, AND IT MUST RAISE FROM INSIDE THE GENERATOR. Ids are
 * strings here, so `V(5)` is a type error rather than a coercion — and the general path raises it
 * lazily too, because `sourceFromIds` is itself a generator. `V('a', 5).values(k)` therefore yields
 * `a`'s value and THEN raises, on both routes. A rung that resolved ids eagerly would move the
 * fault earlier, which is observable to a caller that reads one value and stops.
 *
 * ⚠️ THE MULTIPLICITY IS THE ID LIST'S: a duplicate id yields its value twice, a missing id nothing.
 * Same rule as `idSeededCount` (item 1649), and the opposite of `hasId`'s, which filters the element
 * set instead.
 */
export const idSeededValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = matchSeededShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  const { ids, label, key } = shape;
  const labels = label?.labels;

  // ⚠️⚠️ THE GENERATOR ITSELF, NOT A `{ [Symbol.iterator], drain }` WRAPPER — 1.66x, and it also
  // removes a divergence (item 1651). The wrapper was **53% of the query's self time**: an object
  // with a COMPUTED SYMBOL KEY plus two closures, allocated per call, for a `drain` that only
  // spread the same generator and so bought nothing. (`drain`'s point, item 1412, is an EAGER walk
  // that skips the generator; this rung has none to skip.)
  //
  // ⚠️ AND ONE-SHOT IS THE ENGINE'S ACTUAL CONTRACT, which the wrapper quietly broke. `run`'s result
  // is a generator chain for nearly every plan, so iterating it twice yields nothing the second
  // time — measured: `V().values(k).identity()` gives `[1,2]` then `[]`. The wrapper made
  // `V(id).values(k)` re-iterable, so whether re-iteration worked depended on WHICH RUNG FIRED,
  // which is route-dependent observable behaviour. `nodeValuesShortcut` beside this one still has
  // it; see item 1651's entry in `CLOSED.md`.
  //
  // ⚠️⚠️ AND THE ONE-ID CASE IS EAGER ANYWAY — 1.9x, item 1660 — WHICH REVERSES THE PARAGRAPH
  // ABOVE FOR EXACTLY ONE ID AND NOTHING ELSE. Read both: the generator is still the route for every
  // other shape, and the reason is a RESULT-SIZE argument rather than a protocol one.
  //
  // ITEM 1660 DECOMPOSED THE WHOLE 125 ns CALL and the iterator protocol was its single biggest
  // term — bigger than `run`'s entire prologue:
  //
  // ```text
  //   the work itself (getVertexById + a property read)   16 ns   13%   hand floor
  //   this rung's bookkeeping (asStringId, key in props)  19 ns   15%
  //   THE ITERATOR/GENERATOR PROTOCOL                     54 ns   43%
  //   matchSeededShape + its per-call result object        9 ns    7%
  //   run's prologue (newContext 7, effectivePlan 19, …)  30 ns   24%
  // ```
  //
  // ⚠️⚠️ THAT 54 ns IS A PER-CALL FIXED COST, AND THAT IS THE WHOLE LICENCE FOR THIS BRANCH. It
  // dominates only when the answer is TINY. On `V().values(k)` over 200,000 vertices it is 54 ns
  // against 17.5 ms — 0.0003%, invisible — so eagerness there would buy nothing and would cost the
  // laziness that keeps the scan bounded. **So this generalizes to BOUNDED-RESULT rungs only, and
  // "move the hot path to eager arrays" is the memory regression it looks like.** `ids.length === 1`
  // with one key is 0 or 1 values: there is no walk to make eager and no early exit to destroy, and
  // the rung fires only when it answers the WHOLE plan, so there is no downstream step either.
  //
  // Measured, 2M calls, arms alternated twice: **104-114 ms against 202-217**, with RSS 54.1/54.6 MB
  // against 54.7/54.1 and heapUsed 2.2 MB against 2.3. Memory is FLAT-to-lower, because a V8
  // generator object carries a suspended frame and a register file and is the LARGER object — which
  // is the same reason the CPU halves.
  //
  // ⚠️ `typeof ids[0] === 'string'` IS THE LAZINESS GUARD, not a type narrowing. `asStringId` raises
  // on a non-string id and must raise from INSIDE the walk (see the contract above), so a non-string
  // id falls through to the generator and keeps raising exactly when it did. Dropping this test
  // would make `run(traversal(V(5), values('k')), g)` throw at CALL time instead of on first
  // `next()`, which `id-seeded-values.test.ts` pins.
  //
  // ⚠️ AND THE RESULT IS RE-ITERABLE, which is a DELIBERATE choice and not an oversight. It puts
  // this rung with the three routes that already behave that way in the shipped engine —
  // `V().values(k)` (the wrapper item 1651 left on `nodeValuesShortcut`), `V(id).count()` and
  // `V().count()` (both return a bare `[n]`) — against the general path and the multi-id walk, which
  // are one-shot. Item 1651's one-shot test is written on `V('a', 'b')`, TWO ids, so it never covered
  // this shape; `eager-one-id.test.ts` covers it now and states which way it goes.
  if (ids.length === 1 && typeof ids[0] === 'string') {
    const v = graph.getVertexById(ids[0]);

    if (v === undefined || v === null) {
      return [];
    }

    if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
      return [];
    }

    const props = v.properties;

    return key in props ? [props[key]] : [];
  }

  return seededIdWalk(ids, labels, key, graph);
};

/**
 * `V()[.hasLabel(L)].has(k, eq(v)).values(j)` — the SEEDED POINT LOOKUP, answered off the index
 * bucket with no traverser (item 1595).
 *
 * ⚠️ WHY THIS SHAPE. `bench:usage`'s builder rows put the TS Gremlin serving call at 2619 ns against
 * ISO-GQL's 650 for the identical seeded lookup — 4.0x — and item 1593 showed only ~400 ns of that
 * is plan construction. So ~2150 ns is per-call machinery for a result of ONE element, where
 * per-element work is negligible and setup is the entire cost. Item 1594 then established that
 * trimming individual frames out of that machinery does NOT convert: `countEquals` at 12.0% self
 * time surrendered nothing. A whole-plan shortcut is the remaining form, which is what this is — the
 * same answer `nodeValuesShortcut` gives for the unfiltered scan.
 *
 * ⚠️ THE BUCKET IS THE ANSWER SET, and that is the engine's own existing claim rather than a new
 * one: `seedForStep` returns `removable: true` for an `eq` predicate on a PLAIN `has` over an
 * indexed key, and `removable` means "dropping the owning step leaves an equivalent plan" — i.e.
 * the bucket is exactly the matching elements. Reusing `seedForStep` is what keeps this from
 * re-deriving equality semantics: index equality and `has` equality agreeing is already load-bearing
 * for `seedFromIndex`, so nothing here can drift from it independently.
 *
 * `removable: false` DECLINES — a range seed (`gt`/`lt`/`between`) narrows but does not decide, and
 * a `hasLabelAnd` carries a label the bucket does not capture. Both would need the predicate applied
 * per element, which is the pipeline this exists to skip.
 *
 * No cost check against a scan, deliberately: every element in the bucket is an element the answer
 * must visit anyway, so the seek cannot lose. That is not true of a range seed, which is one more
 * reason those decline.
 */
const seededShape = (
  steps: readonly Step[],
):
  | {
      label: Extract<Step, { kind: 'hasLabel' }> | undefined;
      has: Extract<Step, { kind: 'has' }>;
      key: string;
    }
  | undefined => {
  const [source, second, third, fourth] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (
    steps.length === 3 &&
    second?.kind === 'has' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { label: undefined, has: second, key: third.keys[0] };
  }

  if (
    steps.length === 4 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'has' &&
    fourth?.kind === 'values' &&
    fourth.keys.length === 1
  ) {
    return { label: second, has: third, key: fourth.keys[0] };
  }

  return undefined;
};

export const seededNodeValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = seededShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  // `0` is the cap meaning "exact seeds only": this path requires `removable`, which a range
  // candidate never is, so counting one is pure waste (item 1759 measured it at 1.62x).
  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex, 0);

  // `null` means the key is not indexed or the predicate is not seekable; `removable: false` means
  // the seed narrows without deciding. Either way this is not the shape.
  if (candidate === null || !candidate.removable) {
    return undefined;
  }

  const { label, key } = shape;
  const labels = label?.labels;
  const bucket = candidate.build();
  // ONE loop body for both the iterator and `drain`, as above — item 169's lesson, and Gremlin
  // results are compared ORDERED by the differential fuzzer, so two derivations could diverge.
  const walk = function* (): Generator<unknown> {
    for (const v of bucket) {
      if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
        continue;
      }

      const props = v.properties;

      if (key in props) {
        yield props[key];
      }
    }
  };

  return {
    [Symbol.iterator]: walk,
    drain: () => [...walk()],
  };
};

/**
 * `V()[.hasLabel(L)].has(k, eq(v)).count()` — the SEEDED COUNT, answered off the bucket's SIZE
 * (item 1596).
 *
 * ⚠️ WHY NOBODY ANSWERED THIS ALREADY, because it looks like `countShortcut`'s job.
 * `filterChainCount` declines a `has` the moment `seekWorthTaking` says a seek beats a scan —
 * deliberately, leaving the shape to the seeding path. But the seeding path then runs the TRAVERSER
 * PIPELINE over the seeded stream, so the shape falls between the two: recognised as seekable,
 * answered by neither in closed form.
 *
 * Measured over 20,000 indexed vertices, per operation, against ISO-GQL's
 * `MATCH (u:User) WHERE u.name = $v RETURN count(*)`:
 *
 * ```text
 *   count, unique key    gql 420 ns    gremlin 2486    5.92x   <- the worst ratio in the family
 *   values, unique key   gql 495       gremlin 1743    3.52x   (item 1595 took this one)
 * ```
 *
 * The seeded count was SLOWER than the seeded projection, which is the tell: a count should never
 * cost more than reading a property off the same elements.
 *
 * ⚠️ WITH NO LABEL IT IS O(1) — the bucket's `size`, no iteration at all. With a label it is one
 * pass over the bucket, which is still the minimum: a label is not in the index, so the elements
 * have to be looked at. Both rest on the same `removable` claim item 1595 documents — the bucket IS
 * the matching set for an `eq` on a plain `has` over an indexed key, which is `seedForStep`'s own
 * existing contract and not a new one.
 */
/**
 * A GLOBAL `count` terminal. `count(local)` counts within each element, which is a different
 * question — the same guard `countShortcut` states for its own terminal, and the distinction is
 * only visible once there are SEVERAL matches: on one match both scopes answer `[1]`, which is why
 * a mutant admitting `local` survived until the tests counted seven.
 *
 * At module scope because it captures nothing, so an inner definition would allocate per call —
 * and this file's whole reason for existing is per-call cost.
 */
const isGlobalCount = (step: Step | undefined): boolean =>
  step?.kind === 'count' && step.scope !== 'local';

const seededCountShape = (
  steps: readonly Step[],
): { labels: readonly string[] | undefined; has: Extract<Step, { kind: 'has' }> } | undefined => {
  const [source, second, third, fourth] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (steps.length === 3 && second?.kind === 'has' && isGlobalCount(third)) {
    return { labels: undefined, has: second };
  }

  if (
    steps.length === 4 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'has' &&
    isGlobalCount(fourth)
  ) {
    return { labels: second.labels, has: third };
  }

  return undefined;
};

/**
 * WHICH WALK a predicate takes, as a pure function so the choice can be TESTED (item 2059).
 *
 * ⚠️⚠️ **THIS EXISTS BECAUSE A MUTANT SURVIVED.** Forcing the rung to always take the general walk
 * changes NO answer — the two walks are answer-equivalent by construction, which is the whole point
 * of specializing — so every differential and unit test passed with the fast walk unreachable. That
 * is [[perf-gate-needs-its-own-test]] verbatim: "a route CHOICE is answer-equivalent, so every mutant
 * survives the differential tests; extract the arithmetic as a pure fn and unit-test it."
 */
export const pickScanWalk = (
  fast: ((value: unknown) => boolean) | undefined,
): 'fast' | 'general' => (fast === undefined ? 'general' : 'fast');

/*
 * TWO WALKS, NOT ONE WITH A BRANCH. Item 159 measured a branch in an inner loop like this at 1.6x,
 * and `specializePredicate` declines for a predicate whose operand is neither number nor string, so
 * both paths are genuinely reachable. The gate is evaluated ONCE per query, in the rung below.
 *
 * ⚠️ THE `in` TEST IS THE `values()` CONTRACT, NOT AN OPTIMISATION: a vertex that passes the filter
 * but lacks the PROJECTED key emits NO row, exactly as `V().values(k)` drops it. A walk that yielded
 * `undefined` there would add rows the generic route does not produce, and
 * [[toequal-blind-to-trailing-undefined]] is why that would survive a careless test.
 */
const hasValuesWalkFast = function* (
  graph: Graph,
  key: string,
  projKey: string,
  test: (value: unknown) => boolean,
): Generator<unknown> {
  for (const v of graph.vertices) {
    const props = v.properties;

    if (test(props[key]) && projKey in props) {
      yield props[projKey];
    }
  }
};

const hasValuesWalkGeneral = function* (
  graph: Graph,
  key: string,
  projKey: string,
  pred: Predicate,
): Generator<unknown> {
  for (const v of graph.vertices) {
    const props = v.properties;

    if (matches(pred, props[key]) && projKey in props) {
      yield props[projKey];
    }
  }
};

/**
 * The UNINDEXED `V().has(k, pred).values(key)` scan (item 2059).
 *
 * ⚠️⚠️ **THE GAP THIS FILLS WAS MIS-DIAGNOSED TWICE BEFORE IT WAS LOCATED.** Item 2057 read the `has`
 * row as 1.15x and called it correct-not-a-gap, because its filtered arm emitted 50x fewer rows than
 * the arm it was compared against. Item 2058 then put a RANGE predicate 14-23 ns a vertex AHEAD of an
 * EQUALITY — sign-consistent over three rounds — because all four arms shared `filterStream`'s
 * callback site in one process. One arm per process, emissions held equal, 200,000 vertices:
 *
 * ```text
 *     V().values(n)                     25.1 ns/vertex   the fused scan
 *     V().has('c', 1).values(n)         72.4             EQUALITY
 *     V().has('c', gte(0)).values(n)    72.7             RANGE — indistinguishable
 * ```
 *
 * 🔑 **SO THE PREDICATE KIND IS FREE AND THE ~47 ns IS THE ROUTE.** `specializePredicate` (item 1492)
 * already compiles both ops to a one-comparison closure, and
 * [[closure-dispatch-is-cheap-keyed-loads-are-not]] prices calling one at ~3 ns. The rest is the
 * generic pipeline's per-element plumbing: `filterStream`'s generator layer, the
 * `isVertex(v) || isEdge(v)` recheck on every element, and a traverser per surviving row.
 *
 * ⚠️⚠️ **UNINDEXED MEANS `isIndexed(key)` IS FALSE, AND PRECEDENCE ALONE WAS NOT ENOUGH — an existing
 * test caught that.** The first cut gated this rung only by sitting BELOW `seededNodeValuesShortcut`
 * in `index.ts`, reasoning that a seekable key would already have been claimed. That is wrong,
 * because **the seeded rung declines a RANGE predicate even on an indexed key** (its `seedForStep`
 * cap of `0` demands a `removable` candidate, which "a range candidate never is") while the PIPELINE
 * still seeds that range from the index. So a range on an indexed key fell through to this full scan
 * and changed the row SEQUENCE from bucket order to vertex order — which
 * `seeded-node-values.test.ts`'s "a RANGE predicate" case pins, and which failed:
 *
 * ```text
 *     (fail) the seeded shortcut agrees with the pipeline, in ORDER > a RANGE predicate
 * ```
 *
 * That test's own comment had said those cases "DECLINE the shortcut … the oracle and the subject
 * are then the same path", and this rung quietly broke that premise. 🔑 **The gate is now the direct
 * question — `!graph.vertexPropertyIndex.isIndexed(key)` — so an indexed key keeps the index seek
 * whatever its predicate kind**, which is both the ordering the test pins and the faster route.
 *
 * ⚠️ **A LEADING `hasLabel` IS REFUSED, inheriting item 1870's measurement rather than re-opening
 * it**: this rung is a FULL SCAN whatever the label matches, while the pipeline seeds from
 * `graph.verticesByLabel`, so the labelled form loses from 1.93x at one-in-two to 678x at
 * one-in-a-thousand and never wins.
 *
 * ⚠️ **ITS OWN WALK, NOT AN EDIT TO THE PLAIN SCAN'S.** Items 2021/2025/2026 all took the
 * reuse-by-prefix route for one reason — [[executor-edits-perturb]] prices a new variant inside an
 * existing walk at up to 16% on unrelated rows — but the filter here is INTERLEAVED with the
 * projection, so there is no prefix to delegate. A separate module-scope walk leaves
 * `V().values(k)`'s own 25 ns row untouched.
 */
export const unindexedHasValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const { steps } = plan;

  if (steps.length !== 3) {
    return undefined;
  }

  const [source, filter, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (filter.kind !== 'has') {
    return undefined;
  }

  // ONE key: `values()` with no key emits every property value and `values(a, b)` fans out per key.
  if (proj.kind !== 'values' || proj.keys.length !== 1) {
    return undefined;
  }

  const { key, pred } = filter;

  /*
   * ⚠️ THE INDEX CHECK IS THIS RUNG'S DEFINING GATE, not an optimisation — see the header. An
   * indexed key is seeded by the pipeline (and by the seeded rung when the predicate is seekable),
   * which visits only the matching bucket and emits in BUCKET order; a full scan here would be both
   * slower and a different row sequence. One `isIndexed` call per QUERY, not per row.
   */
  if (graph.vertexPropertyIndex.isIndexed(key)) {
    return undefined;
  }

  const [projKey] = proj.keys;
  const fast = specializePredicate(pred);
  const walk =
    pickScanWalk(fast) === 'general' || fast === undefined
      ? (): Generator<unknown> => hasValuesWalkGeneral(graph, key, projKey, pred)
      : (): Generator<unknown> => hasValuesWalkFast(graph, key, projKey, fast);

  return {
    [Symbol.iterator]: walk,
    // ⚠️ THE EAGER FILL: `toArray` prefers `drain` (item 1412), and a walk without one is measured
    // against siblings that have it with its generator hand tied (item 1998's 1.55x).
    drain: () => [...walk()],
  };
};

export const seededNodeCountShortcut = (plan: Plan, graph: Graph): number | undefined => {
  const shape = seededCountShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  // `0` is the cap meaning "exact seeds only": this path requires `removable`, which a range
  // candidate never is, so counting one is pure waste (item 1759 measured it at 1.62x).
  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex, 0);

  // `removable: false` means the bucket only NARROWS — a range seed, or a `hasLabelAnd` whose label
  // the bucket does not capture — so its size is not the answer.
  if (candidate === null || !candidate.removable) {
    return undefined;
  }

  const bucket = candidate.build();
  const { labels } = shape;

  if (labels === undefined) {
    return bucket.size;
  }

  let n = 0;

  for (const v of bucket) {
    // `hasLabel`'s own rule: ANY of the named labels is a pass, not all of them.
    if (labels.some((l) => v.labels.has(l))) {
      n += 1;
    }
  }

  return n;
};

/**
 * `E()[.hasLabel(L)].values(k)` — the EDGE twin of {@link nodeValuesShortcut}, item 1858.
 *
 * ⚠️ FOUND BY A ROUTE SCREEN, NOT A PROFILE, and the asymmetry is the whole finding: `E().count()`
 * is answered from a counter, `V().values(k)` rides the fused scan at **30 ns a row** — and
 * `E().values(k)` reached neither, at **77 ns a row** (15.34 ms over 200,000 edges). The vertex
 * shortcut's own `matchShape` requires a `V` source, so the edge spelling of the same question fell
 * to the traverser pipeline. 2.6x a row, on the shape that reads one property off every edge.
 *
 * ⚠️ THE GENERATOR IS AT MODULE SCOPE, which this file records as load-bearing rather than tidy: a
 * per-call generator definition made the vertex rung **1.2x SLOWER than the pipeline it replaces**
 * (346 ns against 283), all of it the closure. The parameters carry what it would have captured.
 *
 * ⚠️ AND ONE LOOP BODY SERVES BOTH `drain` AND ITERATION, for `nodeValuesShortcut`'s reason: Gremlin
 * results are compared ORDERED by the differential fuzzer, so two derivations that could drift
 * would be a cross-engine failure rather than an unspecified-order liberty (item 169).
 */
export const edgeValuesWalk = function* (
  labels: readonly string[] | undefined,
  key: string,
  graph: Graph,
): Generator<unknown> {
  for (const e of graph.edges) {
    if (labels !== undefined && !labels.some((l) => e.labels.has(l))) {
      continue;
    }

    const props = e.properties;

    if (key in props) {
      yield props[key];
    }
  }
};

/**
 * `E()` + an optional `hasLabel` + a single-key `values`, or `undefined`.
 *
 * A SEEDED `E(id, …)` is refused: it enumerates a given set rather than every edge, which is a
 * different walk and has its own rungs — the same refusal `countShortcut` makes at its source.
 */
const matchEdgeShape = (
  steps: readonly Step[],
): { label: Extract<Step, { kind: 'hasLabel' }> | undefined; key: string } | undefined => {
  const [source, second, third] = steps;

  if (source?.kind !== 'E' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {
    return { label: undefined, key: second.keys[0] };
  }

  if (
    steps.length === 3 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { label: second, key: third.keys[0] };
  }

  return undefined;
};

export const edgeValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = matchEdgeShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  const labels = shape.label?.labels;
  const { key } = shape;

  return {
    [Symbol.iterator]: () => edgeValuesWalk(labels, key, graph),
    drain: () => [...edgeValuesWalk(labels, key, graph)],
  };
};

/**
 * `V() + <seedable filter> + values(k)` — the `values` STEP fused onto `seedFromIndex`'s stream.
 *
 * 🔑 **WHY THIS IS THE SOUND HALF OF A 5.56x, AND WHAT IT DELIBERATELY LEAVES** (item 2037). One
 * ISOLATED off-label vertex makes `dropVacuousLabels` keep a `hasLabel` step, which declines
 * {@link nodeValuesShortcut}'s exact-shape gate, and the plan falls to the generic pipeline — a route
 * cliff the Gremlin route census caught as the ONLY one of 98 rows to change arm. Priced at 200,000
 * vertices, one MODE per process, controls at 1.01x:
 *
 *     V().hasLabel(T).values(k)   vacuous 107.0   mixed 193.4    1.81x cliff
 *
 * Split, to find where the 193.4 lives:
 *
 *     hasLabel BARE (seed + traverser wrapping)      78.8
 *     hasLabel values (plus the `values` step)      191.7   -> the STEP is 112.9 ms, 59%
 *     HAND bucket read (no traversers at all)        35.3
 *
 * So this fusion removes the 112.9 ms step and inherits the 78.8 ms seed: a ~2.26x ceiling. The
 * remaining ~2.2x is the TRAVERSER WRAPPING inside the seed, and reaching it needs a rung that reads
 * `graph.verticesByLabel` itself.
 *
 * ⚠️⚠️ **THAT READER IS AN OPEN OWNER DECISION AND IS NOT TAKEN HERE**: the public `v.labels = [...]`
 * setter leaves `verticesByLabel` stale, so every new reader widens a known wrong-answer surface.
 * This fusion consumes the stream `seedFromIndex` ALREADY produced, so it adds no reader and needs no
 * decision.
 *
 * ⚠️ AND IT IS NOT ITEM 1870's REFUSED RUNG. That one admitted `hasLabel` into the SCAN
 * (`graph.vertices` + `labels.some`), which is a full scan whatever the label matches and loses
 * 1.93x / 3.35x / 7.98x / 46x / 678x as coverage narrows — `node-values-label-refusal.test.ts` pins
 * it out. This rides the SEEDED candidate set, so it is proportional to the label's size exactly as
 * the pipeline is, and cannot degrade into that scan: it never looks at `graph.vertices`.
 * ⚠️ DISTINCT FROM `seededNodeValuesShortcut`, which is PROPERTY-index seeded: its `seededShape`
 * requires a `has(k, eq(v))` (with an optional `hasLabel` before it), so `V() + hasLabel + values(k)`
 * — no `has` at all — matches neither of its two forms and had no rung before this.
 */
export const labelSeededValuesFusion = (
  stream: Iterable<{ value: unknown }>,
  steps: readonly Step[],
  tracksPath: boolean,
): { values: NodeValues; rest: readonly Step[] } | undefined => {
  /*
   * ⚠️⚠️ **THIS RETURNS `{ values, rest }` RATHER THAN A BARE ITERABLE, AND ITEM 2041 IS WHY.** The
   * first cut required the seeded residual to be EXACTLY `[values]` (`steps.length !== 1`), so
   * `V().hasLabel(L).values(k).order()` had a two-step residual, fell through, and took item 1630's
   * IN-PLACE sort with it — profiled at `sorted` 58.5 ms against an `orderStep`/`sortByBys`/`unwrap`/
   * `projectValues` chain costing **144.6 ms, 2.31-2.36x on two fixtures**.
   *
   * 🔑 A TRAILING TERMINAL NOW RIDES `fusedProjectedResidual`, which is the pattern items 1956, 2027
   * and 2028 each established: **a terminal this walk does not project still gets the walk.** Three
   * prior items closed exactly this gap in three other rungs, and the rung I wrote at item 2037
   * reproduced it.
   */
  // The walk emits bare values and builds no path, so a plan that reads one cannot ride it — the
  // same gate every values walk in this file carries.
  if (tracksPath || steps.length === 0) {
    return undefined;
  }

  const [only] = steps;

  /*
   * ONE key only. `values()` with no key emits every property value and `values(a, b)` fans out per
   * key, so neither is one read per element — the same restriction {@link nodeValuesShortcut} states.
   */
  if (only?.kind !== 'values' || only.keys.length !== 1) {
    return undefined;
  }

  const [key] = only.keys;

  /*
   * ⚠️ A MISSING KEY IS DROPPED, NOT EMITTED AS `undefined`. That is what `valuesStep` does, and
   * bun's `toEqual` treats a trailing `undefined` as absent — so a mutant emitting it survives a
   * `toEqual` assertion ([[toequal-blind-to-trailing-undefined]]). The tests use `toStrictEqual`.
   */
  /*
   * ⚠️ ONE loop body, used by BOTH the iterator and `drain` — item 169's lesson, and Gremlin results
   * are compared ORDERED by the differential fuzzer, so a divergence between the two derivations
   * would be a cross-engine failure rather than an unspecified-order liberty.
   */
  const pick = (t: { value: unknown }): unknown =>
    (t.value as { properties?: Record<string, unknown> } | undefined)?.properties?.[key];

  const walk = function* (): Iterable<unknown> {
    for (const t of stream) {
      const value = pick(t);

      if (value !== undefined) {
        yield value;
      }
    }
  };

  /*
   * 🔑 **`drain` IS WHERE MOST OF THIS ITEM'S WIN LIVES, AND THE GENERATOR ALONE FELL SHORT.** The
   * fusion first shipped as the generator above and took the mixed row 193.4 -> 145.9 ms (1.33x)
   * against a ~85 ms ceiling — a yield per value is not free. `toArray` prefers `drain` when the walk
   * consumed the WHOLE plan, which is this gate's precondition (`steps.length === 1` and that step is
   * the `values`), so there is no downstream step to reason about: a trailing `limit` would land in
   * `steps` and decline above.
   *
   * ⚠️ `run` ITSELF STAYS AS LAZY AS IT WAS — a caller that `break`s out of the iterable still gets
   * the generator; only the already-eager terminal takes the eager route (item 1412's rule).
   */
  const out = walk() as NodeValues & { drain: () => unknown[] };

  out.drain = (): unknown[] => {
    const rows: unknown[] = [];

    for (const t of stream) {
      const value = pick(t);

      /*
       * ⚠️ WRITTEN AS AN EARLY `continue` SO THIS GUARD IS TEXTUALLY DISTINCT from the iterator's
       * `value !== undefined` above. Both derivations must drop a missing key identically, and a
       * mutation round cannot target either one while the two lines are identical — item 2037's
       * first round reported ANCHOR-DID-NOT-APPLY for exactly that reason, leaving the two guards
       * that `toStrictEqual` exists to protect untested against mutation.
       */
      if (value === undefined) {
        continue;
      }

      rows.push(value);
    }

    return rows;
  };

  /*
   * ⚠️ `rest` IS WHAT IS LEFT AFTER THE `values` STEP THIS WALK CONSUMED. An empty `rest` is the
   * item-2037 case (the walk answered the whole plan); a non-empty one is handed to
   * `fusedProjectedResidual`, which either fuses the terminal or declines — and declining leaves the
   * plan exactly where it was before this rung existed.
   */
  return { values: out, rest: steps.slice(1) };
};
