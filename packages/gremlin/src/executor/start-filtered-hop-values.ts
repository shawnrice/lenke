import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { matches, specializePredicate } from '../predicates.js';
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

  // The hop is the first `out`/`in`/`both` after the source. Everything between has to be a vertex
  // filter, which `collectVertexFilters` decides below — so this scan only finds the boundary.
  let at = 1;

  while (at < steps.length && !isHop(steps[at])) {
    at += 1;
  }

  if (at >= steps.length) {
    return undefined;
  }

  // ⚠️ `at === 1` — NO leading filter — IS NO LONGER A DECLINE (item 1603), and the reason the old
  // guard existed no longer covers the case. It read "at `length === 3` with no filter,
  // `hopValuesShortcut` already owns the plan and this one is never consulted", which is true only
  // when the hop is immediately followed by the projection: that shortcut destructures exactly
  // `[source, hop, proj]`, so a FAR-SIDE filter makes it decline too and the plan reached neither.
  // `V().out(T).has(k,p).values(j)` is the measured spelling — 15.7-16.4 ms on 20,000 vertices —
  // and it is the common one, because `effectivePlan`'s `dropVacuousLabels` DELETES a leading
  // `hasLabel` whenever every vertex carries it, turning the filtered spelling into this one.
  //
  // The decline moved to the pair below rather than being dropped: with no filter on EITHER side
  // this is `hopValuesShortcut`'s plan and must stay there, since it reaches it first through
  // `??` and has four walks this module deliberately does not fork (see the header).
  const leadCount = at - 1;

  const hop = steps[at];

  if (hop.kind !== 'out' && hop.kind !== 'in' && hop.kind !== 'both') {
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

  // ⚠️ ITEM 1603: a FAR-SIDE filter run between the hop and the projection. `V().out(T).has(k,p)
  // .values(j)` reached NEITHER values shortcut — `hopValuesShortcut` destructures exactly
  // `[source, hop, proj]` and this module scanned only the steps BEFORE the hop — so it fell to the
  // traverser pipeline at **15.7-16.4 ms** on 20,000 vertices / 80,000 edges, where its own count
  // sibling (`filteredHopCount`) answers in closed form. Every neighbouring spelling was admitted,
  // which is exactly why the hole survived: the same shape as item 1602 found on the count side.
  let farEnd = at + 1;

  while (farEnd < steps.length && isVertexFilterStep(steps[farEnd])) {
    farEnd += 1;
  }

  const farFilters =
    farEnd === at + 1
      ? []
      : // `refuseSeekable: false` — nothing seeds from the far side of a hop, so the refusal the
        // START run makes would decline this shape on every indexed graph and gain nothing. The
        // admission rule itself is still `collectVertexFilters`'s, not a second copy.
        collectVertexFilters(steps.slice(at + 1, farEnd), graph, false);

  if (farFilters === undefined) {
    return undefined;
  }

  // Neither side filtered is `hopValuesShortcut`'s plan — see the note at `leadCount`.
  if (leadCount === 0 && farFilters.length === 0) {
    return undefined;
  }

  const proj = steps[farEnd];
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
    consumed = farEnd + 1;
  } else if (proj === undefined) {
    pick = (far) => far;
    consumed = farEnd;
  } else if (proj.kind === 'id') {
    pick = (far) => far.id;
    consumed = farEnd + 1;
  } else {
    return undefined;
  }

  /**
   * The far filters FOLDED INTO `pick`, which is what keeps every walk below byte-identical.
   *
   * ⚠️ NOT A TEST ADDED TO THE LOOPS. There are three of them (the `both` iterator, its `drain`,
   * and the `out`/`in` arm), and this module exists because items 1441/1466 measured an edit to a
   * hot values walk at up to 16% on UNRELATED rows — item 1466 declined a 3.3x win on that basis.
   * Composing `pick` once per QUERY leaves all three loop bodies exactly the code they were, and a
   * plan with no far filter gets the unwrapped `pick` it had.
   *
   * `undefined` AS THE DROP SENTINEL IS SOUND FOR ALL THREE PROJECTIONS, and that is worth stating
   * because it looks like a conflation. `values(k)` already drops on `undefined` and must (a far
   * vertex lacking `k` yields nothing, which is also the right answer for one the filter rejects);
   * a bare hop picks the far VERTEX and `id()` picks a string, so neither can produce `undefined`
   * of its own and forcing `drops` cannot swallow a real value.
   */
  const farTests = farFilters.length === 0 ? undefined : compileGates(farFilters);

  if (farTests !== undefined) {
    const inner = pick;
    /**
     * ONE `has` FAR FILTER IS COLLAPSED INTO A SINGLE CLOSURE (item 1631) — the common shape, and
     * the one with the measurable cost. A FAR filter runs one test per EDGE where a start filter
     * runs one per VERTEX, so at fanout 5 this call site is hit 1,000,000 times against the start
     * side's 200,000, and the layers add up differently there.
     *
     * The general composition below is three invocations per edge: `pick`, then `survives`
     * iterating a one-element array, then the gate, then `specializePredicate`'s `fast` inside it.
     * This arm is two — `pick` and `fast` — reading the property directly, which is exactly what
     * the gate's own body would have done.
     *
     * ⚠️ PRICED FIRST, and the headroom is narrow (`far-filter-one-shape.ts`, 200,000 vertices /
     * 999,996 edges, median of **12** reps less three warm-up): the engine's filtered walk is
     * **86.7 ms against a hand floor of 57.44 — 1.51x**, so 30 ns/edge is the whole budget and no
     * part of this can be worth more than that. It recovers ~7, for **1.06-1.077x** with every POST
     * reading below every PRE reading across five processes an arm on three shapes.
     *
     * ⚠️ TWELVE REPS, NOT NINE, AND THAT CHANGED THE VERDICT'S SIGN. At `REPS=9, DROP=3` the
     * always-true arm read a POST median of 162-164 against a PRE of 123-128 — a 1.30x REGRESSION
     * that does not exist. This arm's JIT settles in 3-7 reps where the PRE arm's settles in 1-3, so
     * a 9-rep window was measuring the warm-up as the steady state. At 12 reps it is 1.08x BETTER.
     *
     * ⚠️ AND THE 1.67x THAT NOMINATED IT WAS MY OWN INSTRUMENT. `far-filter-values-floor.ts` runs
     * eight arms in ONE process and read `id()` at 144.15 ms against `values(n)`'s 86.48 on the
     * identical route — but `pick` is called through a closure VARIABLE in the loops below, so
     * several arms in one process make that call site polymorphic. Isolated, one shape per process,
     * the two are 86.7 and 88.03: within 1.5%. Item 1558 is the same error on a GQL spelling.
     *
     * ⚠️ NOT A TEST ADDED TO THE LOOPS, and not a dedicated loop either. This file's header records
     * a dedicated single-gate LOOP measuring WORSE (719.7 -> 731, and `both` 458 -> 507), and items
     * 1441/1466 measured an edit to a hot values walk at up to 16% on unrelated rows. Composing
     * `pick` once per QUERY is the sanctioned place to change: all three loop bodies stay byte for
     * byte the code they were.
     *
     * A `hasLabel` far filter, or more than one filter, keeps the general path. Those are the rarer
     * spellings and the collapse has nothing to offer a label test, which is already one
     * `labels.has`.
     */
    const only = farFilters.length === 1 ? farFilters[0] : undefined;
    const fastOne = only?.kind === 'has' ? specializePredicate(only.pred) : undefined;

    if (fastOne !== undefined && only?.kind === 'has') {
      const { key } = only;

      pick = (far) => (fastOne(far.properties[key]) ? inner(far) : undefined);
    } else {
      pick = (far) => (survives(far as unknown as Vertex, farTests) ? inner(far) : undefined);
    }

    drops = true;
  }

  const [type] = hop.labels;
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
  const tests = compileGates(filters);

  if (hop.kind === 'both') {
    return {
      rest,
      values: {
        *[Symbol.iterator]() {
          for (const v of graph.vertices) {
            if (!survives(v, tests)) {
              continue;
            }

            const outBucket = v.adjFrom?.get(type);

            if (outBucket !== undefined) {
              for (const edge of outBucket) {
                const value = pick(edge.to);

                if (!drops || value !== undefined) {
                  yield value;
                }
              }
            }

            const inBucket = v.adjTo?.get(type);

            if (inBucket !== undefined) {
              for (const edge of inBucket) {
                const value = pick(edge.from);

                if (!drops || value !== undefined) {
                  yield value;
                }
              }
            }
          }
        },
        drain() {
          const acc: unknown[] = [];

          for (const v of graph.vertices) {
            if (!survives(v, tests)) {
              continue;
            }

            const outBucket = v.adjFrom?.get(type);

            if (outBucket !== undefined) {
              for (const edge of outBucket) {
                const value = pick(edge.to);

                if (!drops || value !== undefined) {
                  acc.push(value);
                }
              }
            }

            const inBucket = v.adjTo?.get(type);

            if (inBucket !== undefined) {
              for (const edge of inBucket) {
                const value = pick(edge.from);

                if (!drops || value !== undefined) {
                  acc.push(value);
                }
              }
            }
          }

          return acc;
        },
      },
    };
  }

  const forward = hop.kind === 'out';

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
const isHop = (step: Step): boolean =>
  step.kind === 'out' || step.kind === 'in' || step.kind === 'both';

/**
 * Could this step be a vertex filter? Only the KINDS are tested here — whether the step is
 * admissible (and whether a seekable `has` defers to the index) is `collectVertexFilters`'s
 * judgement, which this must not restate. It exists to find the far run's BOUNDARY (item 1603).
 *
 * ⚠️ `values` IS NOT ON THIS LIST, where `count-shortcut.ts`'s `farFilters` treats a trailing
 * single-key `values(k)` as a PRESENCE filter (item 1141). On this module's shape a trailing
 * `values(k)` is the PROJECTION, so reusing that reader would consume the projection as a filter
 * and then find nothing to project.
 */
export const isVertexFilterStep = (step: Step): boolean =>
  step.kind === 'hasLabel' || step.kind === 'has';

export const survives = (v: Vertex, tests: readonly Gate[]): boolean => {
  for (const gate of tests) {
    if (!gate(v)) {
      return false;
    }
  }

  return true;
};

export type Gate = (v: Vertex) => boolean;

/**
 * The start filters as closures, compiled ONCE per plan.
 *
 * ⚠️ THIS IS WORTH 1.93x AND IT IS NOT AN OBVIOUS COST (item 1536). The straightforward per-vertex
 * form — `step.labels.some((l) => v.labels.has(l))` with a `matches` call beside it — allocates a
 * closure and makes a megamorphic call PER VERTEX, over the whole graph rather than over the
 * survivors. On the 200,000-vertex fixture that measured `hasLabel(Q).out(E).values(k)` at 732
 * ns/row against 379 for the same walk with the scan skipped, which is most of the gap this module
 * was built to close.
 *
 * `specializePredicate` is item 1492's lever on the `has` side, where it measured 1.92x for the
 * same reason: one monomorphic closure instead of a megamorphic `matches`. The single-label
 * `hasLabel` case gets the same treatment by hand — it is the overwhelmingly common spelling and
 * `Set.has` on the label box needs no closure at all.
 */
/**
 * ⚠️ THREE CURES FOR THE RESIDUAL GAP, ALL REFUTED WITH NUMBERS (item 1537). Do not re-attempt
 * without reading the scaling study in that entry.
 *
 * `hasLabel(Q).out(E).values(k)` costs 719.7 ns/row against the unfiltered `out(E).values(k)`'s
 * 387.6 — 1.86x for per-row work that is IDENTICAL in the two walks. Seeding from the label bucket
 * closes most of it (417) and cannot ship (see `tests` below). What was tried instead:
 *
 * ```text
 *   compiled gates (the code below)              732 -> 738   nothing on this shape
 *   materialize [...graph.vertices] per plan     719.7 -> 757.7 / 766.1   WORSE
 *   a dedicated loop for the single-gate case    719.7 -> 731, and `both` 458 -> 507   WORSE
 * ```
 *
 * AND THE PER-VERTEX SCAN IS NOT THE EXPLANATION, which is what makes all three miss. Varying the
 * filter's selectivity holds the vertex count at 200,000 and shrinks the rows:
 *
 * ```text
 *   VLABEL=2    100,000 rows   73.46 ms   734.6 ns/row
 *   VLABEL=5     40,000        31.21      780.1
 *   VLABEL=10    20,000        18.35      917.3
 *   VLABEL=20    10,000         9.35      934.6
 * ```
 *
 * Total time tracks ROWS, not visits: the same 200,000 visits that take 73 ms at VLABEL=2 take
 * 9.35 ms at VLABEL=20, so a visit plus its gate is ~40 ns. The gate is not the cost, and neither
 * is the iteration source. `pick` shows as its own 20.5% self-time frame, so the gap is an INLINING
 * decision that differs between the two walks' loop bodies — the class
 * `ts-closure-size-is-load-bearing` describes, where item 1466 declined 3.3x rather than perturb
 * these files. Settling it means attributing inlining by deleting the use, not by reasoning.
 *
 * `compileGates` is kept because it IS a win on the predicate shape — `has(k, gt(48))` went
 * 701.3 -> 606.6 with every control flat — not because it closed the gap it was written for.
 *
 * ⚠️ EVERY NUMBER ABOVE IS THE START SIDE — one test per VERTEX — and item 1631 found the FAR side
 * behaves differently for a structural reason: a far filter runs one test per EDGE, so at fanout 5
 * the same composition is invoked 1,000,000 times rather than 200,000. Collapsing `survives` plus
 * the gate into one closure there is worth **1.06-1.077x** where the start-side levers listed above
 * measured nothing. So do not read this list as "gate composition is a dead end"; read it as "it is
 * a dead end where the test count is the vertex count". The collapse is at the `farTests`
 * composition below.
 */
export const compileGates = (filters: readonly VertexFilter[]): Gate[] =>
  filters.map((step) => {
    if (step.kind === 'hasLabel') {
      if (step.labels.length === 1) {
        const [only] = step.labels;

        return (v) => v.labels.has(only);
      }

      const { labels } = step;

      return (v) => labels.some((l) => v.labels.has(l));
    }

    const { key, pred } = step;
    const fast = specializePredicate(pred);

    return fast === undefined
      ? (v) => matches(pred, v.properties[key])
      : (v) => fast(v.properties[key]);
  });
