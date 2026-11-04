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
  } else if (proj === undefined) {
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
