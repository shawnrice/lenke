import type { Edge, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { adjacentEdges, otherEndpoint } from './movement.js';

/**
 * `V().out(T).values(k)` (and `in`/`both`) answered by one walk instead of the traverser
 * pipeline — the biggest remaining TS Gremlin number, 528ms against native's 32 (audit item 170).
 *
 * Priced against its own floors over 1,000,000 edges before building anything:
 *
 *   V().out(T).values(age)  -- the pipeline            539ns/row
 *   one generator, the same walk by hand (SHIPPED)     251ns/row
 *   the same eager, no generator                       241ns/row
 *   push a constant (array growth alone)                68ns/row
 *   count the edges (adjacency alone)                   60ns/row
 *
 * So 288ns/row is pipeline machinery and ~180ns is the far vertex's property read, which is a
 * random-order lookup and irreducible AT THIS ORDER (item 164). The order is not negotiable
 * here: TinkerPop guarantees `V()`-then-adjacency and the differential fuzzer compares Gremlin
 * results ORDERED, so item 167's vertex-side flip is unavailable — which is exactly why this is
 * a fused walk rather than a reordering.
 *
 * LAZY on purpose, and that half still holds. `run` returns an iterable and the engines already
 * differ on laziness under a zero-row slice, so returning an eager array would change observable
 * behaviour for a caller that takes one value.
 *
 * ⚠️ BUT THE PRICE WAS WRONG BY 38x, and the wrong number is what kept the lever shut. This said
 * "one generator for the whole walk costs 10ns/row over the eager form, which is the price of not
 * touching that". Re-measured at item 1411 on a three-arm floor — the same body as a loop, as a
 * generator, and the real engine — the generator protocol is **1.9-2.2x**, not 4%: 416 ns/row
 * against 795 at 1,000,000 edges, holding at scale rather than vanishing into it. And the engine
 * sat at **1.00x** that generator, so the protocol was the entire gap.
 *
 * The argument's other half was also narrower than it read. It is about `run`, which stays exactly
 * as lazy as it was. `toArray` is defined as `[...run(plan, graph)]` and therefore ALREADY drains
 * the walk in full, so an eager fill there is the same answer by a cheaper route — see `drain`
 * below, item 1412, measured at 53.8% on `V().out(E)` and 49.1% on the projected form.
 *
 * ORDER AND ENDPOINT COME FROM THE ENGINE'S OWN HELPERS — `adjacentEdges` and `otherEndpoint`, the
 * same two `movement.ts` uses — rather than from a second derivation here. That is what makes
 * the row sequence identical by construction for every label set, `both` and self-loops
 * included, and it is the lesson item 169 paid for: a second derivation of something the engine
 * already decides is exactly the drift that makes two spellings disagree.
 */
/**
 * What the shortcut claims: the values its three-step prefix produces, plus the steps LEFT OVER.
 *
 * Returning a residual (item 608) is the mechanism `seedFromIndex` already uses in this executor,
 * and it is what lets a trailing step ride the shortcut instead of defeating it. The gate used to
 * be `steps.length !== 3`, so `V().out(T).values(k).order()` was four steps and dropped the WHOLE
 * query onto the traverser pipeline: 28.9 ms became 172.5. The file's own note said this in
 * general terms for a LEADING step — "a leading `hasLabel` is one step too many for all of them,
 * so it does not merely cost its own per-element test — it drops the whole query onto the
 * traverser pipeline."
 *
 * WHY A RESIDUAL IS SOUND HERE, not just faster. This prefix yields exactly the values the general
 * pipeline would, in the same order — that is the argument the shortcut already rests on. So
 * feeding them to the remaining steps is the same computation the pipeline would have done, and
 * every step's semantics come from its own implementation. In particular `order` keeps `desc`,
 * `by(...)`, `Scope.local` and its runtime fault on ordering raw elements, which a sort inlined
 * here would have had to re-derive — and re-deriving a comparator is the one thing byte-identity
 * cannot survive (item 606 had just finished removing one such duplicate).
 */
/**
 * An EAGER drain for a walk that is already going to be drained in full (item 1412).
 *
 * ⚠️ `drain` NEVER REPLACES THE ITERABLE. `run` returns an `Iterable` and callers may `break` out of
 * it, so making the walk eager would change observable behaviour — this file's own header says so
 * ("LAZY on purpose") and `eager-tail-cache` records a **473x** and a **3680x** from filling eagerly
 * under a LIMIT. The iterable stays exactly as it was.
 *
 * `toArray` is a different question. It is defined as `[...run(plan, graph)]`, so it ALREADY drains
 * the whole walk — eagerness there is not a behaviour change, it is the same answer by a cheaper
 * route. And because `drain` is only read when the shortcut left `rest.length === 0`, there is no
 * downstream step to reason about: a trailing `limit` would appear in `rest` and the route is not
 * taken at all. So the step allowlist this seemed to need does not exist.
 *
 * ⚠️ IT MUST YIELD THE SAME ROWS IN THE SAME ORDER as the generator beside it, which is why each
 * `drain` is written as the same loop over the same helpers rather than as a second derivation —
 * item 169's lesson, and Gremlin results are compared ORDERED by the differential fuzzer, so a
 * reordering here is a cross-engine failure rather than an unspecified-order liberty.
 */
export type HopWalk = Iterable<unknown> & { drain?: () => unknown[] };

export type HopValues = { values: HopWalk; rest: readonly Step[] };

export const hopValuesShortcut = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, hop, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (hop.kind !== 'out' && hop.kind !== 'in' && hop.kind !== 'both') {
    return undefined;
  }

  // WHAT COMES OFF THE FAR VERTEX, and how many steps that consumes (item 881).
  //
  // This used to require exactly a `values(k)` third step, so the two commonest hops in the
  // language went down the traverser pipeline while the projected form rode a fused walk —
  // and ADDING A STEP made the query 1.9x FASTER. Measured over 1,000,000 edges (item 880):
  //
  //   V().out(T)              325.21 ms   no shortcut: the full pipeline
  //   V().out(T).id()         322.60      no shortcut either — so it is not the vertex
  //   V().out(T).values(age)  169.93      the fused walk
  //
  // `pick` is a monomorphic closure chosen ONCE per plan, not a per-edge branch. The file's own
  // warning above is about generator DELEGATION (375.6 against 251), not about a call.
  //
  // Any OTHER third step still declines the whole shortcut, exactly as before. Treating an
  // unrecognised step as a residual over a bare hop would quietly re-route a large family of
  // plans that nothing here has measured, which is a different change.
  // ONE key. `values()` with no key emits every property value and `values(a, b)` fans out per
  // key — both are different shapes, not this one.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  /**
   * ⚠️ PRICED AND OPEN (items 1693/1694): a `topologyVersion`-keyed CSR drain for THIS walk, the way
   * item 1692 built one for the far-FILTERED hop at 38.08x.
   *
   * ⚠️ ITEM 1693 REFUTED IT AT 1.58x AND THAT REFUTATION IS WITHDRAWN. It was measured on a
   * GROUPED-insertion fixture — a vertex's edges added consecutively — which is the best case for a
   * pointer-chasing walk and therefore the worst case for the lever that replaces it. On the
   * Gremlin bench's own scattered layout, item 1694 measured the identical arms at:
   *
   * ```text
   *    engine id            139.18 ms    1.00x
   *    handGen               95.78       1.45x
   *    handCsr               23.21       6.00x   <- against 1.58x on the grouped fixture
   *    handCsrPlusBuild     167.00       0.83x   the FIRST query only; the CSR is cached
   * ```
   *
   * Edge INSERTION ORDER alone is worth 2.26x on the same graph (61.59 grouped against 139.18
   * scattered, identical edges and bucket order), so a probe that groups its inserts understates
   * this walk by ~2.3x. Most probes in this corpus group.
   *
   * The open question for the build is NOT the warm number but the CSR's invalidation: it is keyed
   * on `topologyVersion`, the build costs ~144 ms on a scattered layout, and a write-heavy workload
   * pays that repeatedly. The first query is a 1.20x regression either way.
   *
   * The reading below stands as measured, on the grouped fixture, and is kept because the 1.20x hand
   * floor it establishes is a fact about DELEGATION that the layout does not change:
   *
   * ```text
   *    engineValues       132.27 ms    1.00x
   *    handGen            110.69       1.20x   this walk's data access, by hand
   *    handCsr             83.81       1.58x   the same walk over flat slot runs
   *    handCsrPlusBuild   173.11       0.76x   ⚠️ with the CSR build in the timed region: a LOSS
   * ```
   *
   * The engine is within **1.20x of its own hand-written walk**, so there is no delegation left to
   * remove — item 1614's 6.65x and item 1631's 3.91x were both removing delegation, and that work is
   * done. What remains is the DATA STRUCTURE, and on that fixture it cost ~89 ms to build against
   * the ~48 it saved.
   *
   * ⚠️ Item 1692's arm still wins COLD where this one cannot, and for a reason the layout does not
   * change: its filter drops 99% of the rows before anything is materialized, so its build is
   * amortized against work that disappears, while this shape materializes every row either way.
   *
   * (The `order()` row above this one is NOT a route for it either: items 879/890 settled that the
   * 1M-value sort costs 88 ms, the ordering contract is free, and the residual was refuted at 1.04x
   * "matched exactly by an unreachable control".)
   */
  // A far vertex, structurally — enough for all three pickers and nothing more.
  type Far = { readonly id: string; readonly properties: Record<string, unknown> };
  let pick: (far: Far) => unknown;
  // `values(k)` DROPS a far vertex lacking `k`; a bare hop and `id()` drop nothing, so the
  // emptiness test belongs to the VALUE mode rather than to the walk.
  let drops = false;
  let consumed: number;

  if (valueKey !== undefined) {
    pick = (far) => far.properties[valueKey];
    drops = true;
    consumed = 3;
  } else if (proj === undefined || proj.kind === 'order') {
    /**
     * ⚠️ `order` RIDES AS A RESIDUAL OVER THE BARE HOP (item 1783), which is the one other step
     * kind this shortcut names.
     *
     * `V().out(T).order().by(k)` was the heaviest row on the Gremlin bench at **1537.5 ns/row**
     * (item 1782's ranking) for a reason that is entirely routing: an unrecognised third step
     * declined the WHOLE shortcut, so the row fell to the generic traverser pipeline and paid the
     * generator chain per edge. Route markers put it at `projected=UNDEFINED`, and the profile put
     * **70% of the row in the traversal** — `iterLabeled` 32.7% alone — while `hopbare` performs
     * the IDENTICAL `V().out('E')` walk in 8.5 ms against this row's ~43. Five times the cost for
     * the same walk, which is the generator chain `gremlin-values-is-the-floor` records.
     *
     * Treated exactly like `proj === undefined`: the walk emits far ELEMENTS and the `order` plus
     * anything after it becomes the residual, which item 608's path wraps as traversers and runs
     * normally. So the sort itself is untouched — same `orderStep`, same `sortByBys`, same key
     * evaluation and the same comparator (item 1713's) — and ONLY the source of the frontier
     * changes, from the generic pipeline to the fused walk. That is what makes it
     * answer-equivalent: the file's own note on iterating the adjacency `Set` directly is that it
     * is "the SAME order and the same edges — not a second derivation".
     *
     * ⚠️ NAMED, NOT "ANYTHING UNRECOGNISED", and the distinction is this file's own warning a few
     * lines above: treating an unrecognised step as a residual over a bare hop "would quietly
     * re-route a large family of plans that nothing here has measured". One named step kind, with
     * its own measurement, is the bounded version of that change.
     *
     * ⚠️ AND IT DOES NOT MAKE AN ILLEGAL SORT LEGAL. `order()` over graph ELEMENTS throws by
     * contract, and `assertFrontierTypes` raises at PLAN-CHECK time, before any route is chosen —
     * so the bare `V().out(T).order()` spelling still throws, by the same mechanism, whichever
     * route this gate would have picked. What rides here is `order().by(k)`, which sorts by a
     * property and is legal on either route. `fusableProjectedOrder` still declines this shape
     * (its last consumed step is the hop, not a `values`), so the VALUE-mode fusion is untouched.
     */
    pick = (far) => far;
    consumed = 2;
  } else if (proj.kind === 'id') {
    pick = (far) => far.id;
    consumed = 3;
  } else {
    return undefined;
  }

  const rest = steps.slice(consumed);
  const { kind, labels } = hop;

  // A SINGLE named type on `out`/`in` is the common shape, and for it the engine's adjacency
  // iterator reduces to one `Set`: `iterLabeled` is literally `yield* byLabel.get(labels[0]) ?? []`
  // when `labels.length === 1`, and `otherEndpoint` is `edge.to` / `edge.from`. Iterating that
  // Set directly is therefore the SAME order and the same edges — not a second derivation — and
  // it skips two generator delegation layers per edge.
  //
  // That is worth having rather than tidy: going through the helpers for everything measured
  // 375.6ms where the hand walk measured 251, because `iterByLabel` `yield*`s into
  // `iterLabeled`. My first probe inlined what the shipped code has to call, and over-promised
  // by 1.5x — `harness-must-resemble-caller`, again.
  const oneType = labels.length === 1 && kind !== 'both' ? labels[0] : undefined;

  // THE MULTI-LABEL HAND WALK (item 1389), which this had only for a single name. `out('E','F')`
  // measured **209.5 ms against `out('E')`'s 139.3 — 1.50x** over the identical 20,000 rows, and the
  // profile put **33.1%** of the multi arm in the generator chain the single arm skips:
  // `iterLabeled` 20.3%, `iterByLabel` 7.9%, `outEdgesOf` 4.9%. The single-name comment above
  // already prices that chain at 375.6 against 251 — the same 1.50x — so the gap is the delegation,
  // not the disjunction.
  //
  // ⚠️ LABEL-ARG ORDER IS PRESERVED, and this is where this twin DIVERGES from the GQL one. The
  // buckets are walked in the order the traversal named them, exactly as `iterLabeled` does and as
  // `graph-queries.ts` documents on purpose. GQL's `edgesOfManyTypes` sorts largest-bucket-first
  // (item 1384) to close an equivalent-spelling gap; doing that here would reorder rows for a
  // property this file states deliberately, and there is no gap to close — `out('F','E')` measured
  // 211.0 against `out('E','F')`'s 209.5, because every bucket is walked either way.
  //
  // EARLIER BUCKETS, not a `seen` Set. An edge can only repeat if it sits in two of the named
  // buckets, so for bucket `i` a duplicate is exactly an edge already in some bucket `j < i` — and
  // those buckets are in hand. Same substitution item 1377 made in GQL, where the Set ablated at
  // 60.7% of a multi-type hop count; item 1378 measured it at NOTHING on the Gremlin COUNT path,
  // which is a different function from this one.
  const manyTypes = labels.length > 1 && kind !== 'both' ? labels : undefined;
  /**
   * EXACTLY TWO TYPES, with both bucket lookups HOISTED and no per-vertex array (item 1442).
   *
   * ⚠️ THE PER-VERTEX `buckets` ARRAY IS THE COST OF `manyTypes`, and three other candidates are
   * refuted. `out('E','F')` measured **1.86x** `out('E')` on a graph with no `F` edge at all — an
   * identical edge set, identical row count, which is the equivalent-spelling class CLAUDE.md says
   * returns the right answer and costs 100-300x elsewhere. Item 1441 priced it against hand floors
   * OUTSIDE this file, because any edit here moves unrelated branches ~16% in an arbitrary direction
   * (items 1413 and 1440 measured that in both signs), so no in-file A/B could resolve it:
   *
   *   floor-single        5.11 ms   one bucket
   *   floor-multi-pair    5.25      two types, gets hoisted, NO array  -> 1.03x single
   *   engine-multi        9.57      this walk before the specialization -> 1.82x the pair
   *
   * So the gap essentially CLOSES at 1.03x, with 45.1% headroom against the engine. What it is NOT:
   * not the earlier-buckets dedupe (item 1413 measured skipping it at **−0.5%**), not pushing
   * `undefined` for absent types (item 1440 built that and item 1441 measured its floor at **11.81
   * against the array floor's 11.81** — identical), and not engine overhead, since `engine-multi`
   * sat BELOW its own hand floor. The array itself is the term, which is why item 1440's "lean"
   * version bought nothing: it kept the array.
   *
   * TWO TYPES RATHER THAN A GENERAL N. A loop over N hoisted locals is the array again, so this is
   * deliberately a specialization and 3+ types keep `manyTypes`. `out('E','F')` is the overwhelmingly
   * common multi-type spelling.
   *
   * ⚠️ ORDER IS A TINKERPOP CONTRACT HERE, unlike GQL's unspecified row order — the differential
   * fuzzer compares Gremlin streams ORDERED, which is also why item 1431's edge-index trick is
   * available to GQL's undirected hop and not to `both`. This emits bucket 0 in full, then bucket 1
   * minus bucket 0, which is exactly what the `i`/`j` loops do at `labels.length === 2`.
   *
   * `out('E','E')` is admitted and correct: the two lookups return the same Set, so every edge in
   * bucket 1 is found in bucket 0 and dropped, leaving one emission each.
   */
  const pairTypes = manyTypes?.length === 2 ? manyTypes : undefined;
  /**
   * `both(T)` BY HAND — the third walk, and the only one left going through the helpers (item 1432).
   *
   * `both` is admitted by this shortcut but had no hand walk: `oneType` and `manyTypes` both exclude
   * it, so it fell to the general `adjacentEdges` tail and paid a FOUR-DEEP generator chain.
   * `hopbothyield` is **181 ms at 100,000 vertices — the heaviest row in either bench**, and it had
   * no bench row at all until this item. Its profile:
   *
   *   `iterLabeled` 33.0% + `iterByLabel` 11.5% + `bothEdgesOf` 9.9% + `iterBoth` 2.5% = **56.9%**
   *   in the delegation chain, plus `otherEndpoint` 12.4% resolving the far end.
   *
   * This file's own header already priced that chain for the single-direction case: going through
   * the helpers measured 375.6 ms where the hand walk measured 251, "because `iterByLabel` `yield*`s
   * into `iterLabeled`". Item 1411 then measured ONE generator layer at 2.1x; this shape has four.
   *
   * ⚠️ THE EDGE-INDEX ROUTE IS UNAVAILABLE HERE, and that is a semantic limit rather than an
   * oversight. Item 1431 took GQL's undirected hop from 53.02 to 15.57 ms by iterating
   * `edgesByLabel` ONCE — but that emits rows in EDGE order, and `iterBoth`'s contract is
   * **out-edges then in-edges, per vertex**, matching TinkerPop's `both` ordering. GQL row order is
   * unspecified; Gremlin stream order is a TinkerPop contract the differential fuzzer compares
   * ORDERED. So the structure that won 3.4x there cannot be used here, exactly as item 167's
   * vertex-side flip could not.
   *
   * What IS available is removing the delegation while keeping that order: out-bucket then
   * in-bucket, per vertex, which is what `iterBoth` produces and nothing more. A SELF-LOOP is in
   * both buckets and is yielded TWICE, which is what the helpers do and what TinkerPop does — the
   * GQL walk's single-emission rule is ITS contract, not this one.
   */
  const bothOneType = labels.length === 1 && kind === 'both' ? labels[0] : undefined;

  if (bothOneType !== undefined) {
    return {
      rest,
      values: {
        *[Symbol.iterator]() {
          for (const v of graph.vertices) {
            const outBucket = v.adjFrom?.get(bothOneType);

            if (outBucket !== undefined) {
              for (const edge of outBucket) {
                const value = pick(edge.to);

                if (!drops || value !== undefined) {
                  yield value;
                }
              }
            }

            const inBucket = v.adjTo?.get(bothOneType);

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
        // The same loop, eager — read only by `toArray` (item 1412).
        drain() {
          const acc: unknown[] = [];

          for (const v of graph.vertices) {
            const outBucket = v.adjFrom?.get(bothOneType);

            if (outBucket !== undefined) {
              for (const edge of outBucket) {
                const value = pick(edge.to);

                if (!drops || value !== undefined) {
                  acc.push(value);
                }
              }
            }

            const inBucket = v.adjTo?.get(bothOneType);

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

  if (pairTypes !== undefined) {
    const forward = kind === 'out';
    // Hoisted out of the per-vertex loop, which is the whole point of this branch.
    const [t0, t1] = pairTypes as readonly [string, string];

    return {
      rest,
      values: {
        *[Symbol.iterator]() {
          for (const v of graph.vertices) {
            const byLabel = forward ? v.adjFrom : v.adjTo;

            if (byLabel === undefined) {
              continue;
            }

            const b0 = byLabel.get(t0);
            const b1 = byLabel.get(t1);

            if (b0 !== undefined) {
              for (const edge of b0) {
                const value = pick(forward ? edge.to : edge.from);

                if (!drops || value !== undefined) {
                  yield value;
                }
              }
            }

            if (b1 === undefined) {
              continue;
            }

            for (const edge of b1) {
              // The earlier-buckets rule at two buckets: one membership test against bucket 0.
              if (b0?.has(edge) === true) {
                continue;
              }

              const value = pick(forward ? edge.to : edge.from);

              if (!drops || value !== undefined) {
                yield value;
              }
            }
          }
        },
        // The same loop, eager. Read only by `toArray`, and only when `rest` is empty.
        drain() {
          const acc: unknown[] = [];

          for (const v of graph.vertices) {
            const byLabel = forward ? v.adjFrom : v.adjTo;

            if (byLabel === undefined) {
              continue;
            }

            const b0 = byLabel.get(t0);
            const b1 = byLabel.get(t1);

            if (b0 !== undefined) {
              for (const edge of b0) {
                const value = pick(forward ? edge.to : edge.from);

                if (!drops || value !== undefined) {
                  acc.push(value);
                }
              }
            }

            if (b1 === undefined) {
              continue;
            }

            for (const edge of b1) {
              if (b0?.has(edge) === true) {
                continue;
              }

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
  }

  if (manyTypes !== undefined) {
    const forward = kind === 'out';

    return {
      rest,
      values: {
        *[Symbol.iterator]() {
          const buckets: (ReadonlySet<Edge> | undefined)[] = [];

          for (const v of graph.vertices) {
            const byLabel = forward ? v.adjFrom : v.adjTo;

            if (byLabel === undefined) {
              continue;
            }

            buckets.length = 0;

            for (const t of manyTypes) {
              buckets.push(byLabel.get(t));
            }

            for (let i = 0; i < buckets.length; i += 1) {
              const bucket = buckets[i];

              if (bucket === undefined) {
                continue;
              }

              for (const edge of bucket) {
                let earlier = false;

                for (let j = 0; j < i; j += 1) {
                  if (buckets[j]?.has(edge) === true) {
                    earlier = true;

                    break;
                  }
                }

                if (earlier) {
                  continue;
                }

                const value = pick(forward ? edge.to : edge.from);

                if (!drops || value !== undefined) {
                  yield value;
                }
              }
            }
          }
        },
        // The same loop, eager — including the earlier-buckets dedupe and the label-arg ORDER,
        // which is a TinkerPop contract the differential fuzzer compares ordered. Read only by
        // `toArray`, and only when `rest` is empty.
        drain() {
          const acc: unknown[] = [];
          const buckets: (ReadonlySet<Edge> | undefined)[] = [];

          for (const v of graph.vertices) {
            const byLabel = forward ? v.adjFrom : v.adjTo;

            if (byLabel === undefined) {
              continue;
            }

            buckets.length = 0;

            for (const t of manyTypes) {
              buckets.push(byLabel.get(t));
            }

            for (let i = 0; i < buckets.length; i += 1) {
              const bucket = buckets[i];

              if (bucket === undefined) {
                continue;
              }

              for (const edge of bucket) {
                let earlier = false;

                for (let j = 0; j < i; j += 1) {
                  if (buckets[j]?.has(edge) === true) {
                    earlier = true;

                    break;
                  }
                }

                if (earlier) {
                  continue;
                }

                const value = pick(forward ? edge.to : edge.from);

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

  if (oneType !== undefined) {
    const forward = kind === 'out';

    return {
      rest,
      values: {
        *[Symbol.iterator]() {
          for (const v of graph.vertices) {
            // The vertex's OWN box rather than `edgesFromByLabel.get(v.id)` (item 591), the same
            // change `filteredHopCount` takes. The saving here is ONE string-keyed `Map.get` per
            // VERTEX, and this row's cost is dominated by the per-EDGE work below it, so expect
            // percent rather than multiples — the measurement is in the audit entry either way.
            const bucket = (forward ? v.adjFrom : v.adjTo)?.get(oneType);

            if (bucket === undefined) {
              continue;
            }

            for (const edge of bucket) {
              const far = forward ? edge.to : edge.from;
              const value = pick(far);

              if (!drops || value !== undefined) {
                yield value;
              }
            }
          }
        },
        // The same loop, eager. Read only by `toArray`, and only when `rest` is empty.
        drain() {
          const acc: unknown[] = [];

          for (const v of graph.vertices) {
            const bucket = (forward ? v.adjFrom : v.adjTo)?.get(oneType);

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
  }

  return {
    rest,
    values: {
      *[Symbol.iterator]() {
        for (const v of graph.vertices) {
          for (const edge of adjacentEdges(kind, graph, v, labels)) {
            const value = pick(otherEndpoint(kind, edge, v));

            // `values(k)` DROPS an element lacking `k` rather than emitting null — verified
            // against a real TinkerPop console (`V().count()` 6 against
            // `V().values('age').count()` 4). A STORED null is a present value and IS emitted,
            // which is why this tests `undefined` and not nullishness. A bare hop and `id()`
            // drop nothing, which is what `drops` carries.
            if (!drops || value !== undefined) {
              yield value;
            }
          }
        }
      },
    },
  };
};
