import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor, collectVertexFilters } from './count-shortcut.js';
import type { HopValues } from './hop-values.js';
import {
  type Gate,
  compileGates,
  isVertexFilterStep,
  survives,
} from './start-filtered-hop-values.js';

/**
 * `V().out(T).out(T).values(k)` — TWO hops answered by one nested walk instead of the traverser
 * pipeline (item 1614).
 *
 * ⚠️ A STRUCTURAL HOLE, not a known cost, and the reason it survived this long is worth stating:
 * EVERY two-hop shape in the profile corpus ends in `count()`, which `hopChainCount` answers from
 * degrees without walking at all (item 590). So the two-hop WALK had only ever been profiled in the
 * arm where it does not run. `hopValuesShortcut` takes `[V, hop, proj]` and declines at a second
 * hop, so one extra `out` dropped the whole query onto the pipeline:
 *
 * ```text
 *    V().out(E).values(k)              2.07 ms   79996 rows    25.9 ns/row   <- the fused walk
 *    V().out(E).out(E).values(k)      81.47     319972        254.6          <- the pipeline
 *    V().out(E).out(E).id()           76.01     319972        237.6
 *    the same nested walk BY HAND     12.25     319972         38.3          <- THE FLOOR
 *    ... id by hand                   11.23     319972         35.1
 * ```
 *
 * 6.65x of headroom, and the floor's per-row sits beside the ONE-hop fused walk's 25.9 — so the
 * fusion generalizes rather than merely applying twice. The profiles say the same thing: the one-hop
 * shape's frames are `drain` 15.9% and `pick` 8.9%, the two-hop shape's are `iterLabeled` 19.3%,
 * `otherEndpoint` 14.8%, `traverseToVertex` 11.3%, `unwrap` 3.1%, `extend` 1.6% — a different
 * machine entirely, not the same one doing twice the work.
 *
 * ORDER IS TINKERPOP'S OWN, by construction: `out` flatMaps per traverser, so the row sequence is
 * the depth-first nesting written literally below — per vertex, per out-edge in bucket order, per
 * out-edge of that far end. Gremlin streams are compared ORDERED by the differential fuzzer (unlike
 * GQL rows), so any cleverer structure — walking the edge index once, hoisting the far side — is a
 * cross-engine failure and not an optimization. That is the same limit items 167, 1431 and 1432 each
 * recorded; this walk removes DELEGATION only.
 *
 * ⚠️ NO DEDUPLICATION, and that is the contract rather than an omission. Two different paths reaching
 * the same far vertex are two rows, and a self-loop is a legitimate step. `dedupe()` would appear in
 * `rest` and run over the values, exactly as it does for the one-hop walk.
 *
 * NO MULTI-TYPE GUARD IS NEEDED because nothing is summed — each hop reads its own single bucket per
 * vertex, so a type appearing twice cannot double-count the way `degreeOfTypes` can (the guard
 * `hopChainShape` carries, for the COUNT rungs).
 *
 * ⚠️ AND A FILTER IN ANY OF THE THREE POSITIONS (item 1615), which this rung declined on its first
 * day and which left the only two shapes `gremlin-cliff-finder.ts` still read as `pipeline`. Both
 * profiles are the same delegation chain the walk above removes — `iterLabeled` + `iterByLabel` +
 * `outEdgesOf` + `otherEndpoint` + `traverseToVertex` is **53.7%** of the trailing shape and
 * **49.7%** of the mid one. The same instrument, PRE by reverting this file to its item-1614 state:
 *
 * ```text
 *    arm                              PRE      POST    verdict
 *    2 hop + TRAILING has, values   79.18    20.27     3.91x
 *    2 hop + MID has, values        45.44    16.93     2.68x
 *    2 hop + LEAD has, values       44.49    16.96     2.62x
 *    2 hop values  (no filter)      15.77    16.15     flat (control)
 *    2 hop id      (no filter)      11.69    11.70     flat (control)
 *    1 hop values                    2.23     2.47     flat (control)
 *    3 hop values  (declined)      385.60   361.18     flat (control)
 * ```
 *
 * The trailing shape cost **4.7x its own unfiltered neighbour for FIFTY TIMES FEWER ROWS** before
 * this, because it walked every traverser down the pipeline and filtered at the end. The three
 * unfiltered controls are flat because the `any*` booleans mean no call at all where a position has
 * no filter — item 1602's `anyStart` split.
 *
 * ⚠️ AND ANY DEPTH SINCE ITEM 1617 — three hops yielding went **3772.5 to 1047.6 ms on the
 * 1,000,000-edge bench (3.60x), from 3.3x behind native to PARITY (ts/nat 1.0)**, and 394.89 to
 * 103.79 on the isolated 20,000x4 probe (3.80x). Every other row in the sweep is flat. Depth 3 and
 * up take `stackedWalk` below; depth 2 keeps the literal nesting here because replacing it with the
 * stack measured a **1.29x regression** on the commonest shape in the family.
 *
 * ~~EXACTLY TWO HOPS~~ SINGLE-NAMED-TYPE, NON-`both` — a deliberate specialization, for `pairTypes`'
 * stated reason in `hop-values.ts`: a general N is a loop over a stack of iterators, which is the
 * per-vertex array that branch measured as the whole cost of the general form. Three hops are
 * ~~priced and left open~~ — **TAKEN AT ITEM 1617** (3.60x on the bench, 3.80x isolated). The hand
 * floor that priced it was 59.12 ms against the pipeline's 381.37 at 1,279,840 rows, 6.45x; the
 * shipped stacked walk reads 103.79, which is 1.36x its own floor and the same residual the depth-2
 * walk pays.
 */
export const hopChainValuesShortcut = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  // `V` + two hops at the very least.
  if (steps.length < 3) {
    return undefined;
  }

  const [source] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — `hopValuesShortcut`'s own refusal.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  /**
   * TWO OR MORE hops, anywhere in the plan, with a filter run between each neighbouring pair.
   *
   * A `both` declines outright (its contract is out-bucket then in-bucket per vertex, so nesting two
   * of them is four interleaved orders rather than one). The hop COUNT was capped at two until item
   * 1617 lifted it; see `stackedWalk` below for why depth 2 still gets its own loop.
   *
   * ⚠️ THE `both` CHECK IS REDUNDANT, and the mutant proves it rather than the reasoning doing so —
   * item 475's rule is that a survivor on a new guard means "redundant" as readily as "untested",
   * and the two have opposite fixes. `singleTypeHop` admits only `out`/`in`, so a `both` is never
   * pushed to `hops`; it then lands in a filter run, where `collectVertexFilters` refuses it. Kept
   * because it states the rung's shape where a reader looks for it, at one test per step per query.
   */
  const at: number[] = [];

  for (let i = 1; i < steps.length; i += 1) {
    const k = steps[i].kind;

    if (k === 'both') {
      return undefined;
    }

    if (k === 'out' || k === 'in') {
      at.push(i);
    }
  }

  if (at.length < 2) {
    return undefined; // one hop is `hopValuesShortcut`'s and `startFilteredHopValues`' shape
  }

  const hops: (readonly [string, boolean])[] = [];

  for (const i of at) {
    const h = singleTypeHop(steps[i]);

    if (h === undefined) {
      return undefined;
    }

    hops.push(h);
  }

  /**
   * ONE FILTER RUN BETWEEN EACH NEIGHBOURING PAIR — `at.length + 1` of them: before the first hop,
   * between each two, and after the last.
   *
   * ⚠️ `refuseSeekable` IS TRUE FOR THE LEAD RUN ONLY, and the asymmetry is `collectVertexFilters`'
   * own, stated at item 1603: the refusal exists because a seek seeds the SOURCE and the values
   * shortcuts run before `seedFromIndex`, so a walk that scanned would preempt a better route.
   * Nothing seeds from the far side of a hop — `seedForStep` reads the source step — so refusing
   * there would decline the shape on every indexed graph and gain nothing. Every INTERIOR run is a
   * far side too, which is the same split `interleavedHopChainCount` makes for its interior run.
   */
  const last = at[at.length - 1];
  // The final run ends at the first step that is not a vertex filter — the projection, or the residual.
  let farEnd = last + 1;

  while (farEnd < steps.length && isVertexFilterStep(steps[farEnd])) {
    farEnd += 1;
  }

  const runs: Gate[][] = [];

  for (let h = 0; h <= at.length; h += 1) {
    const from = h === 0 ? 1 : at[h - 1] + 1;
    const to = h === at.length ? farEnd : at[h];
    // ⚠️ `h === 0` — the LEAD run refuses a seekable `has`, every interior and trailing run admits
    // one. I wrote this `h !== 0` and item 1615's index test caught it immediately, which is the
    // only reason that test exists.
    const f = collectVertexFilters(steps.slice(from, to), graph, h === 0);

    if (f === undefined) {
      return undefined;
    }

    runs.push(compileGates(f));
  }

  const tail = projectionOf(steps[farEnd]);

  if (tail === undefined) {
    return undefined;
  }

  const { pick, drops, consumed } = tail;
  const rest = steps.slice(farEnd + consumed);

  if (walkKindFor(at.length) === 'stacked') {
    return { rest, values: stackedWalk(graph, hops, runs, pick, drops) };
  }

  const [[t0, fwd0], [t1, fwd1]] = hops;
  const [leadGates, midGates, farGates] = runs;
  /**
   * The `any*` booleans keep the unfiltered walk at its item-1614 cost: with no filters in a
   * position there is no call at all, not a call over an empty array. That is item 1602's `anyStart`
   * split, and it is what makes the unfiltered controls flat.
   *
   * `compileGates` (called in the parse above) is `start-filtered-hop-values.ts`'s, exported rather
   * than reimplemented — it is worth 1.93x on the label side and 1.16x on the predicate side (items
   * 1536/1492), and a second copy of a specialization table is exactly the drift this executor keeps
   * paying for.
   */
  const anyLead = leadGates.length > 0;
  const anyMid = midGates.length > 0;
  const anyFar = farGates.length > 0;

  /**
   * ⚠️ WRITTEN TWICE, LAZY AND EAGER, AS THE SAME LOOP — `hop-values.ts`'s rule, for its reason:
   * `run` returns an iterable a caller may `break` out of, so the walk stays lazy, while `toArray`
   * is `[...run(…)]` and already drains it in full, where the eager form is the same answer by a
   * cheaper route (item 1412 measured 53.8% on `V().out(E)`). `drain` is read only when `rest` is
   * empty, so no downstream step has to be reasoned about.
   *
   * A second DERIVATION is what must not happen, and does not: both loops nest the identical two
   * bucket reads in the identical order.
   */
  return {
    rest,
    values: {
      *[Symbol.iterator]() {
        for (const v of graph.vertices) {
          if (anyLead && !survives(v, leadGates)) {
            continue;
          }

          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const midV = fwd0 ? e0.to : e0.from;

            if (anyMid && !survives(midV, midGates)) {
              continue;
            }

            const b1 = (fwd1 ? midV.adjFrom : midV.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const farV = fwd1 ? e1.to : e1.from;

              if (anyFar && !survives(farV, farGates)) {
                continue;
              }

              const value = pick(farV);

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
          if (anyLead && !survives(v, leadGates)) {
            continue;
          }

          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const midV = fwd0 ? e0.to : e0.from;

            if (anyMid && !survives(midV, midGates)) {
              continue;
            }

            const b1 = (fwd1 ? midV.adjFrom : midV.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const farV = fwd1 ? e1.to : e1.from;

              if (anyFar && !survives(farV, farGates)) {
                continue;
              }

              const value = pick(farV);

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
};

/**
 * WHICH WALK A GIVEN HOP COUNT GETS. Depth 2 has its own literal nesting; 3 and up share the generic
 * stack.
 *
 * ⚠️ EXTRACTED AS A PURE FUNCTION BECAUSE A ROUTE CHOICE IS ANSWER-EQUIVALENT, so no differential
 * test can pin it — the mutant that sent depth 2 through the stack SURVIVED the whole suite, exactly
 * as `perf-gate-needs-its-own-test` says it would. The threshold is the only thing here that is a
 * PERFORMANCE claim rather than a correctness one, so it is unit-tested directly in
 * `hop-chain-values.test.ts`, with the numbers that chose it recorded on `stackedWalk` below.
 *
 * ⚠️ WHAT THE EXTRACTION BUYS IS NOT A GUARD AT THE CALL SITE. A mutant that inlines `at.length > 2`
 * back into the caller SURVIVES, and must: it is the same predicate written out, equivalent in both
 * answer and speed. What dies instead is a changed THRESHOLD — `hops > 1` and `hops > 3` are each
 * caught by this function's own test, where neither was caught by anything before the extraction.
 */
export const walkKindFor = (hops: number): 'literal' | 'stacked' =>
  hops > 2 ? 'stacked' : 'literal';

/**
 * ⚠️ THE GENERIC WALK, ANY DEPTH — now over FLAT SLOT RUNS rather than a stack of bucket
 * iterators (item 1680, replacing item 1617's stack). Used at depth 3 and above; depth 2 keeps its
 * literal nesting, and the split is MEASURED rather than assumed.
 *
 * `hop-chain-depth-floor.ts` prices the two ITERATOR shapes by hand, outside the engine so neither
 * inherits the other's inlining (items 1413/1440 measured an in-file A/B moving unrelated branches
 * ~16% in an arbitrary direction, which is why the pricing happens there):
 *
 * ```text
 *    depth 2  LITERAL nesting      13.06 ms    319972 rows    40.8 ns/row
 *    depth 2  ITERATOR STACK       16.87                      52.7          1.29x the literal
 *    depth 2  the engine           15.86                      49.6
 *    depth 3  LITERAL nesting      64.36      1279840         50.3
 *    depth 3  ITERATOR STACK       82.29                      64.3          1.28x the literal
 *    depth 3  the engine          394.89                     308.5          <- the pipeline
 * ```
 *
 * So the iterator stack cost a flat ~28% over literal nesting at both depths, which is why replacing
 * the depth-2 specialization with it would be a 1.29x REGRESSION on the commonest shape in the
 * family, and why both still exist. ⚠️ **That 28% is also what made the iterator protocol the
 * obvious suspect for item 1679's 6x row, and it was the WRONG suspect** — see below.
 *
 * ⚠️ AND `hop-values.ts`' PRIOR AGAINST A GENERAL FORM DOES NOT APPLY HERE, which is worth
 * stating because it nearly stopped item 1617. `pairTypes`' note says "a loop over N hoisted locals
 * is the array again", measured at item 1441 — but that array was allocated PER VERTEX, over the
 * whole graph. These are allocated ONCE per plan and reused across every source vertex.
 *
 * Item 1679 profiled `V().out()x3.values(age)`, the largest absolute cost in the gremlin corpus at
 * 6813 ms against 1134 native, and priced the replacement at 31.8x with materialization. ⚠️ **The
 * iterator protocol was NOT the cost** — the same Sets walked with `for..of` instead of explicit
 * `.next()` are only 1.27x of a 42x gap. What costs is the per-row chain of indirections, and the
 * CSR removes all of it: a `Map.get(label)` per vertex per visit, an `Edge` dereference, a `Vertex`
 * dereference, the `properties` getter and a string-keyed object lookup, for two `Int32Array` reads.
 *
 * ⚠️ ROW ORDER IS A CONTRACT HERE, NOT A COURTESY — Gremlin streams are compared ORDERED by the
 * differential fuzzer, which is the one property that could not be compromised. It is preserved, and
 * checkably rather than hopefully: `graph.vertices` IS `verticesById.values()`, which is the order
 * every CSR numbers its slots in, and within a slot the run holds that vertex's wanted bucket in
 * iteration order. So slot 0..V-1 crossed with each run's order reproduces the nested-`Set` order
 * edge for edge, depth-first PREORDER, exactly what the nested loops produce. The tests assert that
 * against the pipeline element for element rather than resting on this paragraph.
 *
 * ⚠️ THREE THINGS ARE PER-CALL AND MUST NOT BE CACHED ON `topologyVersion`, which is the split
 * item 1679 recorded as a design constraint. The CSR is topology; the GATES read labels and
 * properties, and the PROJECTION reads properties, and a property write deliberately does not bump
 * that signal (items 1674/1675) so that a `SET` does not discard an adjacency cache. Both are
 * therefore rebuilt per call.
 *
 * ⚠️ AND BOTH ARE MEMOIZED **LAZILY**, FOR CORRECTNESS BEFORE SPEED. Computing `pick` or a gate
 * over every vertex up front would call them on vertices the nested walk never reaches, so a `pick`
 * or predicate that throws on some unreached vertex would start throwing. Lazily, each is evaluated
 * exactly when the old walk would have evaluated it.
 *
 * The speed follows anyway and the PROJECTION memo is most of the win, which was measured rather
 * than assumed because it decides a semantic question (below): at 200,000 vertices and 25,000,000
 * rows each far vertex is reached ~125 times, so a per-slot memo turns 25,000,000 projections into
 * at most 200,000. On the corpus's `V().out()x3.values(age)` row:
 *
 * ```text
 *    the old iterator stack                  6813.3 ms
 *    the slot walk, pick called per ROW      2669.8        2.55x
 *    the slot walk, pick memoized per SLOT    467.8       14.56x
 * ```
 *
 * ⚠️ **THIS ROUTE THEREFORE SNAPSHOTS, WHERE THE DEPTH-2 LITERAL NESTING IS LIVE, and that is a
 * real behavioural difference rather than an implementation detail.** A caller may hold the LAZY
 * iterator and mutate the graph between rows. The old walk read `far.adjFrom.get(t)` per vertex and
 * called `pick` per row, so such a mutation was partly observable; here the CSR fixes the topology
 * at first touch and the memo fixes each projected value at first touch, so it is not. Both of this
 * route's caches have the same shape, so the semantics are at least coherent: the whole traversal
 * reads one snapshot.
 *
 * The three `pick` forms are all pure functions of the vertex — `far.properties[k]`, `far.id` and
 * `far` itself — so nothing here is unsound for a caller that does not mutate mid-iteration, which
 * is every caller in the engine: `toArray` goes through `drain`, which runs to completion. The
 * snapshot is pinned by a test rather than left to this paragraph, and the asymmetry with depth 2 is
 * recorded in `docs/reviews/CLOSED.md` as an owner decision rather than settled here.
 */
const stackedWalk = (
  graph: Graph,
  hops: readonly (readonly [string, boolean])[],
  runs: readonly Gate[][],
  pick: (far: Vertex) => unknown,
  drops: boolean,
): HopValues['values'] => {
  const depth = hops.length;
  const [leadGates] = runs;
  const anyLead = leadGates.length > 0;
  // One CSR per hop shape. They share a slot numbering because every one numbers by
  // `verticesById` order — see the note above.
  const csrs = hops.map(([t, fwd]) => chainCsrFor(graph, fwd, [t]));
  const [{ vtx }] = csrs;
  const n = vtx.length;

  /** 0 = not yet evaluated, 1 = passed, 2 = failed. One array per filter run. */
  const gateMask = runs.map((g) => (g.length > 0 ? new Uint8Array(n) : undefined));
  const passes = (slot: number, run: number): boolean => {
    const mask = gateMask[run];

    if (mask === undefined) {
      return true;
    }

    const seen = mask[slot];

    if (seen !== 0) {
      return seen === 1;
    }

    const ok = survives(vtx[slot], runs[run]);
    mask[slot] = ok ? 1 : 2;

    return ok;
  };

  /** The projection, memoized per slot — 0 = not yet evaluated. */
  const vals: unknown[] = Array.from({ length: n });
  const valSeen = new Uint8Array(n);
  const valueAt = (slot: number): unknown => {
    if (valSeen[slot] === 0) {
      vals[slot] = pick(vtx[slot]);
      valSeen[slot] = 1;
    }

    return vals[slot];
  };

  /**
   * ⚠️ STILL WRITTEN TWICE, LAZY AND EAGER, and the sink closure does not avoid it — a generator
   * cannot `yield` from inside a callback, so the lazy side has to be its own loop whatever the eager
   * side looks like. Item 1411 measured the generator protocol at 1.9-2.2x and item 1412 measured
   * `drain` at 53.8% of `V().out(E)`, so collapsing the pair trades a real cost for a cosmetic one.
   * What makes the duplication safe is item 1616's screen, which mutates BOTH halves of every such
   * loop in the executor: a drift between them is caught rather than reasoned about.
   *
   * The two cursors are a position per level: `cur[d]` is where level `d` has reached in its run,
   * `end[d]` where that run stops. That is the `Int32Array` equivalent of the old `its[d]` iterator.
   */
  const walk = (sink: (value: unknown) => void): void => {
    const cur = new Int32Array(depth);
    const end = new Int32Array(depth);

    for (let s = 0; s < n; s += 1) {
      if (anyLead && !passes(s, 0)) {
        continue;
      }

      const [c0] = csrs;
      cur[0] = c0.memo.off[s];
      end[0] = cur[0] + c0.memo.len[s];

      let d = 0;

      while (d >= 0) {
        if (cur[d] >= end[d]) {
          d -= 1;
          continue;
        }

        const far = csrs[d].memo.flat[cur[d]];
        cur[d] += 1;

        if (!passes(far, d + 1)) {
          continue;
        }

        if (d === depth - 1) {
          const value = valueAt(far);

          if (!drops || value !== undefined) {
            sink(value);
          }

          continue;
        }

        const cn = csrs[d + 1];
        const len = cn.memo.len[far];

        if (len === 0) {
          continue;
        }

        d += 1;
        cur[d] = cn.memo.off[far];
        end[d] = cur[d] + len;
      }
    }
  };

  return {
    *[Symbol.iterator]() {
      const cur = new Int32Array(depth);
      const end = new Int32Array(depth);

      for (let s = 0; s < n; s += 1) {
        if (anyLead && !passes(s, 0)) {
          continue;
        }

        const [c0] = csrs;
        cur[0] = c0.memo.off[s];
        end[0] = cur[0] + c0.memo.len[s];

        let d = 0;

        while (d >= 0) {
          if (cur[d] >= end[d]) {
            d -= 1;
            continue;
          }

          const far = csrs[d].memo.flat[cur[d]];
          cur[d] += 1;

          if (!passes(far, d + 1)) {
            continue;
          }

          if (d === depth - 1) {
            const value = valueAt(far);

            if (!drops || value !== undefined) {
              yield value;
            }

            continue;
          }

          const cn = csrs[d + 1];
          const len = cn.memo.len[far];

          if (len === 0) {
            continue;
          }

          d += 1;
          cur[d] = cn.memo.off[far];
          end[d] = cur[d] + len;
        }
      }
    },
    drain() {
      const acc: unknown[] = [];

      walk((value) => acc.push(value));

      return acc;
    },
  };
};

/** One named edge type in one direction, as `[type, forward]`; `undefined` for anything else. */
const singleTypeHop = (step: Step | undefined): readonly [string, boolean] | undefined => {
  if (step === undefined || (step.kind !== 'out' && step.kind !== 'in')) {
    return undefined;
  }

  // ⚠️ `both` IS DECLINED, and by the `kind` test above rather than here: its contract is out-bucket
  // then in-bucket PER VERTEX (`iterBoth`, and `hop-values.ts`'s `bothOneType` walk), so nesting two
  // of them is four interleaved orders rather than one. A correct `both` chain is a different walk.
  return step.labels.length === 1 ? [step.labels[0], step.kind === 'out'] : undefined;
};

/** What comes off the LAST far vertex, and how many steps that consumes — `hopValuesShortcut`'s set. */
const projectionOf = (
  proj: Step | undefined,
): { pick: (far: Vertex) => unknown; drops: boolean; consumed: number } | undefined => {
  // ONE key. `values()` with no key emits every property value and `values(a, b)` fans out per key;
  // both are different shapes. A monomorphic closure chosen ONCE per plan, not a per-edge branch.
  if (proj?.kind === 'values' && proj.keys.length === 1) {
    const [key] = proj.keys;

    // `values(k)` DROPS a far vertex lacking `k`, which is why `drops` belongs to the VALUE mode and
    // not to the walk — a bare hop and `id()` drop nothing.
    return { pick: (far) => far.properties[key], drops: true, consumed: 1 };
  }

  /**
   * A bare two-hop, with nothing to project off the far end.
   *
   * ⚠️ `consumed` COUNTS PROJECTION STEPS ONLY (0 or 1) since item 1615, because `rest` is now
   * measured from the end of the far filter run rather than from the start of the plan. Item 1614's
   * version counted from the start, which was fine while the step positions were fixed and is wrong
   * the moment a filter can sit anywhere — and the off-by-one would have been SILENT on the
   * unfiltered shapes, which are exactly the ones item 1614's tests covered.
   */
  if (proj === undefined) {
    return { pick: (far) => far, drops: false, consumed: 0 };
  }

  if (proj.kind === 'id') {
    return { pick: (far) => far.id, drops: false, consumed: 1 };
  }

  // Any other step declines the whole shortcut, as `hopValuesShortcut` does: treating an
  // unrecognised step as a residual over a bare hop would re-route a family nothing has measured.
  return undefined;
};
