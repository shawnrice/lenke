import type { Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { seenBefore } from './second-ask.js';

/**
 * `V().out(T).values(k)` over the CSR — the ONE-hop twin of the walk the TWO-hop rung has used since
 * item 1680 (item 1889).
 *
 * **THE TWO-HOP WALK IS 6.4x CHEAPER PER ROW THAN THE ONE-HOP WALK AT SCALE, WHILE DOING FOUR
 * TIMES THE ROWS.** That is the finding, and it is only visible at size — CLAUDE.md's "sweep the
 * size: cache-resident and not are different questions; the transition is between 200k and 1M
 * elements". Isolated, one shape per process, 200,000 vertices / 1,000,000 edges, median of 9:
 *
 * ```text
 *   V().out(E).values(n)              81.31 ms     800,000 rows   102 ns a row
 *   V().out(E).out(E).values(n)       51.45      3,200,000         16          <- FOUR times the
 *                                                                                 rows, a sixth of
 *                                                                                 the per-row cost
 *   V().optional(out(E)).values(n)   174.13        800,000        218
 * ```
 *
 * At the screens' usual 20,000 vertices the same two shapes read 54 and 17 ns a row — a third of the
 * gap — which is why six items of work on this surface never surfaced it. `hopValuesShortcut` walks
 * `v.adjFrom.get(T)` per vertex: a `Map` lookup and a `Set` iteration per vertex, both pointer-chasing
 * structures. `hopChainValuesShortcut` walks `chainCsrFor`'s flat `Int32Array` of neighbour SLOTS,
 * which is sequential memory. At 200,000 vertices the difference stops being a constant factor.
 *
 * IT IS CONSULTED **BEFORE** `hopValuesShortcut`, WHICH IS A DELIBERATE PRECEDENCE CHANGE — the
 * only one in this family. Item 1535's rule is that `??` order means no plan an earlier rung already
 * admits can change route, and every other rung here was added AFTER for exactly that reason. This
 * one is added FIRST because it is faster on the shapes it claims, so the gate is as narrow as the
 * claim: `V()` with no ids, ONE `out`/`in` hop with ONE label, and a single-key `values`, an `id()`
 * or nothing. `both`, a multi-type hop, an untyped hop, a filtered start or far end, and every other
 * projection decline and land on exactly the rung they land on today.
 *
 * `both` AND MULTI-TYPE ARE REFUSED FOR A CORRECTNESS REASON, not a scope one. `buildChainCsr`
 * appends one named bucket at a time and is sound only "because the multi-type guard has already
 * cleared", so an edge carrying two of the named types would be appended TWICE where `iterLabeled`
 * dedupes it; and `both` is two directions, which one CSR cannot express.
 *
 * THE ORDER IS THE BUCKET WALK'S, which the differential fuzzer compares ORDERED for Gremlin.
 * `far-mask-drain.ts` states the argument this inherits: "`chainCsrFor` numbers slots by
 * `graph.verticesById` iteration order and fills each slot's run from that vertex's own bucket in
 * set order, so walking slots in order and each run in order emits the identical sequence to the
 * generator walk. Nothing is hoisted across vertices."
 *
 * AND THE BUILD IS CACHED per graph per `topologyVersion` per shape, dropped WHOLE on any
 * topology write. Item 1695's criterion — safe iff the walk costs more than the rebuild — is checked
 * in the entry rather than assumed, including at the small size where the walk is cheapest.
 */
/**
 * The crossover above which testing EVERY slot beats visiting only the selected starts.
 *
 * **MEASURED, NOT ASSUMED** — item 1939's rule, and item 1870 is what happens without it: a
 * full-scan arm admitted unconditionally lost 1.93x / 3.35x / 7.98x / 46x / 678x as a label narrowed.
 * This arm has the same shape, so it got the same discipline. 20,000 vertices, FANOUT 5, 60 reps,
 * the arm forced ON and OFF at each coverage:
 *
 *     coverage   declining (seeded walk)   firing (this arm)   verdict
 *     1.0                 529.7 ms               159.1 ms      firing 3.33x
 *     0.5                 373.4                  105.0         firing 3.56x
 *     0.25                166.0                   67.7         firing 2.45x
 *     0.1                  58.3                   49.8         firing 1.17x
 *     0.02                 36.9                   39.0         DECLINING wins 1.05x
 *
 * The crossover is between 0.02 and 0.1: this arm pays ~39 ms of fixed cost walking every slot, which
 * a seeded walk over a few hundred starts undercuts. **0.1 sits ABOVE the crossover, so the gate can
 * only decline a win and never causes a regression** — exactly the reasoning
 * `EDGE_DRIVEN_MIN_COVERAGE = 0.4` records for its own swept band.
 */
const CSR_START_LABEL_MIN_COVERAGE = 0.1;

/**
 * The per-slot start predicate for a leading one-name `hasLabel`, or `undefined` when the label is
 * too selective for this arm to win.
 *
 * THE COVERAGE READ IS `verticesByLabel.get(name)?.size`, which is **the same read
 * `dropVacuousLabels` already performs** (it compares that size against the vertex count). So this
 * adds no new dependency on that index — which matters, because the public `v.labels = [...]` setter
 * leaves it stale and every NEW reader widens a known wrong-answer surface
 * ([[label-index-vs-setter]]). A different threshold on an existing read is not a new reader.
 */
const startTestFor = (
  labelStep: { readonly labels: readonly string[] } | undefined,
  graph: Graph,
): ((v: Element) => boolean) | undefined => {
  if (labelStep === undefined) {
    return undefined;
  }

  const [name] = labelStep.labels;
  const covered = graph.verticesByLabel.get(name)?.size ?? 0;
  const total = graph.vertexCount;

  if (total === 0 || covered / total < CSR_START_LABEL_MIN_COVERAGE) {
    return undefined;
  }

  // `hasLabel` is `labels.some(l => v.labels.has(l))`; with one name that is exactly this.
  return (v: Element): boolean => v.labels.has(name);
};

export const hopValuesCsr = (
  plan: Plan,
  graph: Graph,
  /* Optional, and only for the `[bag, values]` tail (item 2116) — without it that arm declines. */
  ctx?: { readonly sideEffects: Map<string, unknown[]> },
): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  /*
   * **A LEADING `hasLabel` IS ADMITTED AND TESTED PER SLOT (item 2040).** Without this the step
   * made the plan four steps long and this gate declined, sending it to `startFilteredHopValues`,
   * which walks PER-VERTEX ADJACENCY (`v.adjFrom?.get(type)` — a Map lookup then Set iteration per
   * vertex) where this walk makes one flat pass. Item 2039's profile DIFF priced that at
   * **drain 31.4 -> 258.1 ms, 8.2x**, and the labelled arm at **4.08x above the label-free floor the
   * engine already reaches on the same data** (529.7 against 130.0).
   *
   * ONE LABEL NAME ONLY. `hasLabel(a, b)` is a UNION (`labels.some(l => v.labels.has(l))`), so a
   * multi-name test is a different predicate; it declines rather than guessing.
   *
   * AND IT IS COVERAGE-GATED, because this arm tests EVERY slot while the walk it replaces visits
   * only the SELECTED starts. At low coverage that trade inverts — the same shape as item 1870's
   * refusal (a full scan loses 1.93x-678x as a label narrows) and item 1939's swept crossover. The
   * threshold is measured, not assumed; see {@link CSR_START_LABEL_MIN_COVERAGE}.
   */
  const [source] = steps;
  const labelStep =
    steps[1]?.kind === 'hasLabel' && steps[1].labels.length === 1 ? steps[1] : undefined;
  const hop = labelStep === undefined ? steps[1] : steps[2];
  const proj = labelStep === undefined ? steps[2] : steps[3];

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (hop === undefined) {
    return undefined;
  }

  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  /*
   * The `[bag, values(k)]` tail (item 2116). Requires a `ctx` for the bucket; without one this is
   * `undefined` and the element arm claims the bag step exactly as before.
   */
  const bagTail = ((): { bucket: unknown[]; key: string } | undefined => {
    if (ctx === undefined || (proj?.kind !== 'aggregate' && proj?.kind !== 'store')) {
      return undefined;
    }

    const after = steps[labelStep === undefined ? 3 : 4];

    // ONE key, for `valueKey`'s own reason: `values()` and `values(a, b)` are different shapes.
    if (after?.kind !== 'values' || after.keys.length !== 1) {
      return undefined;
    }

    if (!ctx.sideEffects.has(proj.key)) {
      ctx.sideEffects.set(proj.key, []);
    }

    return { bucket: ctx.sideEffects.get(proj.key)!, key: after.keys[0] };
  })();
  const picked = pickFor(proj, valueKey, bagTail);

  if (picked === undefined) {
    return undefined;
  }

  // THE SECOND-CALL POLICY, and it is what makes this arm safe to put FIRST — see `seenBefore`.
  if (!seenBefore(graph, hop.kind === 'out', hop.labels[0])) {
    return undefined;
  }

  const startTest = startTestFor(labelStep, graph);

  // A label step that is present but NOT worth testing per slot declines the whole arm, leaving the
  // seeded walk to serve it — the arm is only better where the label is broad.
  if (labelStep !== undefined && startTest === undefined) {
    return undefined;
  }

  return {
    // A `fold` IS NOT CONSUMED: it stays in `rest` for `fusedProjectedResidual` to fold over
    // the drained walk (item 1909), which is the whole point of admitting it here.
    // THE LABEL STEP SHIFTS EVERY INDEX BY ONE, `rest` included — it is CONSUMED by `startTest`.
    rest: steps.slice(2 + picked.consumes + (labelStep === undefined ? 0 : 1)),
    values: walk(graph, {
      forward: hop.kind === 'out',
      type: hop.labels[0],
      startTest,
      ...picked,
    }),
  };
};

export { seenBefore };

/**
 * `labels` IS PART OF THIS because the CSR's `vtx` array holds VERTICES only — both `pick` and
 * item 2040's per-slot `startTest` are called with `vtx[...]`, never with an edge. Narrowing it to
 * `{ id, properties }` was accurate until the start test needed the label.
 */
type Element = {
  readonly id: string;
  readonly properties: Record<string, unknown>;
  readonly labels: ReadonlySet<string>;
};
type Picked = {
  pick: (e: Element) => unknown;
  drops: boolean;
  /**
   * Does the projection step get CONSUMED, or stay in `rest` for the residual dispatch? (item 1911.)
   *
   * CARRIED HERE rather than re-derived at the `rest` slice: two copies of "which kinds are
   * consumed" is how one falls behind the other (item 606's reason), and a `rest` that disagreed
   * with the pick would either drop a step or run it twice.
   */
  /*
   * How many steps AFTER the hop this pick consumes (item 2116 widened this from a boolean).
   *
   * 0 leaves the projection in `rest` for the residual dispatch; 1 consumes a `values`/`id`; 2
   * consumes a `[bag, values]` PAIR. Carried here rather than re-derived at the `rest` slice for item
   * 1911's reason: two copies of "which kinds are consumed" is how one falls behind the other.
   */
  consumes: 0 | 1 | 2;
};

/**
 * What the plan asks for about the far vertex; `undefined` declines the plan.
 *
 * `values(k)` DROPS a far vertex lacking `k` — `projectValues`' own rule (`k in props`) — while a
 * bare hop yields the element and `id()` a string, neither of which can produce `undefined` of its
 * own, so the sentinel cannot swallow a real value. A property stored as `null` is PRESENT and is
 * emitted.
 */
const pickFor = (
  proj: Step | undefined,
  valueKey: string | undefined,
  /* The bucket and key for a `[bag, values(k)]` tail, or `undefined` when the shape is not that. */
  bagTail: { bucket: unknown[]; key: string } | undefined,
): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: (e) => e.properties[valueKey], drops: true, consumes: 1 };
  }

  /*
   * A `fold` PROJECTION IS THE BARE-ELEMENT PICK WITH THE FOLD LEFT IN `rest` (item 1910) — the
   * same named residual `hop-values.ts` admits, so the two rungs agree on which shapes they serve.
   * Without it this rung declined `V().out(T).fold()` and the shape fell to the SLOWER bucket walk:
   * 29.71 ms against 4.13 for the identical hop through this CSR, after item 1910's gate change had
   * already taken it from 99.53.
   */
  /*
   * **`[bag, values(k)]` AS ONE PICK — item 2116, and it must come BEFORE the element arm below,
   * which would otherwise claim the same `aggregate`/`store` and leave both steps in `rest`.**
   *
   * THAT RESIDUAL IS THE WHOLE COST. Both shapes already reach THIS rung — verified by instrumenting
   * its entry, where `hopValuesShortcut` is never even asked — so they share the CSR walk and differ
   * only in what runs over it:
   *
   * ```text
   *     hop + values           30 ms   480,000 rows   <- `consumes: 1`, emits VALUES, rest empty
   *     hop + store            15      600,000        <- the bag alone
   *     hop + store + values  138      480,000        <- 3.1x the SUM: a 2-step GENERIC residual
   * ```
   *
   * Items 2114 and 2115 attacked this in `hop-values.ts` and read 1.00x — because that file is NOT
   * CONSULTED for this shape at 200,000 vertices (this rung is first and claims it). Both of those
   * measurements were of dead code; their entries are corrected.
   *
   * THE ORDER INSIDE `pick` IS LOAD-BEARING: BAG FIRST, THEN THE VALUE. Item 2078's rule is that the
   * bag holds every element the walk VISITS while the rows hold only those carrying the key — "a vertex
   * lacking the projected key is BAGGED but not EMITTED". `drops: true` makes the walk's own
   * `value !== undefined` test drop the ROW after this has banked the ELEMENT.
   */
  if (bagTail !== undefined && (proj?.kind === 'aggregate' || proj?.kind === 'store')) {
    const { bucket, key } = bagTail;

    return {
      pick: (e) => {
        bucket.push(e);

        return e.properties[key];
      },
      drops: true,
      consumes: 2,
    };
  }

  if (
    proj === undefined ||
    proj.kind === 'fold' ||
    proj.kind === 'aggregate' ||
    proj.kind === 'store'
  ) {
    // `consumes: 0` — the step STAYS in `rest` for the residual dispatch to decide.
    // Carried on `Picked` rather than re-derived at the `rest` slice (item 1911): two copies of
    // "which kinds are consumed" is how one of them falls behind the other, which is item 606's
    // reason and the shape of the wrong answer item 1903 cost.
    return { pick: (e) => e, drops: false, consumes: 0 };
  }

  return proj.kind === 'id' ? { pick: (e) => e.id, drops: false, consumes: 1 } : undefined;
};

type WalkSpec = {
  readonly forward: boolean;
  readonly type: string;
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
  /**
   * An optional per-SLOT test on the start vertex (item 2040). `undefined` keeps the loop exactly as
   * it was — no branch is added to the unlabelled arm beyond one `!== undefined` per SLOT, not per
   * row, which is what makes this safe to put in the hot walk at all.
   */
  readonly startTest: ((v: Element) => boolean) | undefined;
};

/**
 * ONE LOOP OVER SEQUENTIAL MEMORY, PARAMETERIZED, AT MODULE SCOPE
 * ([[ts-closure-size-is-load-bearing]]). The inner loop reads `memo.flat` — an `Int32Array` of
 * neighbour slots — and indexes `vtx` once per row; there is no `Map` lookup and no `Set` iterator
 * anywhere in it, which is the whole difference from the bucket walk.
 */
const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
  *[Symbol.iterator]() {
    const { forward, type, pick, drops, startTest } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);

    for (let slot = 0; slot < vtx.length; slot += 1) {
      /*
       * PER SLOT, NOT PER ROW, and that is the whole economy of this arm (item 2040): one test per
       * START vertex skips its entire run. `vtx[slot]` is the start; `vtx[memo.flat[i]]` is the
       * neighbour — the two are easy to confuse and a mutant swapping them is in the battery.
       */
      if (startTest !== undefined && !startTest(vtx[slot])) {
        continue;
      }

      const from = memo.off[slot];
      const to = from + memo.len[slot];

      for (let i = from; i < to; i += 1) {
        const value = pick(vtx[memo.flat[i]]);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
  /**
   * THE EAGER FILL IS MOST OF THE WIN, AND MEASURING WITHOUT IT NEARLY SANK THE ITEM. With the
   * generator alone the CSR walk read **67.59 ms against the bucket walk's 81.31 — 1.20x**, which
   * is exactly the "no delegation left to remove" figure `hop-values.ts` records, and it looked
   * like the data structure was worth almost nothing. `toArray` is `drain()` when the walk offers
   * one (item 1412), and every arm of `hopValuesShortcut` offers one — so the arm this replaces was
   * being compared with its generator hand tied.
   *
   * IT NEVER REPLACES THE ITERABLE, which is `hop-values.ts`'s own rule: `run` stays exactly as
   * lazy as it was for a caller that `break`s out, and `drain` is read only where the shortcut
   * consumed the whole plan (`rest.length === 0`), so there is no downstream step to reason about.
   *
   * AND IT IS THE SAME LOOP OVER THE SAME ARRAYS, not a second derivation — item 169's rule, and
   * Gremlin results are compared ORDERED, so a reordering between the two fills would be a
   * cross-engine failure rather than an unspecified-order liberty.
   */
  drain() {
    const { forward, type, pick, drops, startTest } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);
    const out: unknown[] = [];

    for (let slot = 0; slot < vtx.length; slot += 1) {
      /*
       * THE SAME TEST, in the same position — item 169's rule, and Gremlin results are compared
       * ORDERED, so the two derivations must skip the identical slots.
       *
       * WRITTEN AS AN OPTIONAL CHAIN so it is TEXTUALLY DISTINCT from the iterator's
       * `startTest !== undefined && !startTest(...)`. Identical lines cannot be mutated
       * INDEPENDENTLY — item 2040's first round reported anchors=2 for every guard mutant, so a fault
       * in ONE derivation was untestable, which is exactly what the iterator/drain agreement test
       * exists to catch (item 2037 hit this too). The `=== false` is load-bearing, not a lint
       * violation: the chain yields `undefined` when there is no test, and `undefined` must NOT skip
       * the slot.
       */
      if (startTest?.(vtx[slot]) === false) {
        continue;
      }

      const from = memo.off[slot];
      const to = from + memo.len[slot];

      for (let i = from; i < to; i += 1) {
        const value = pick(vtx[memo.flat[i]]);

        if (!drops || value !== undefined) {
          out.push(value);
        }
      }
    }

    return out;
  },
});
