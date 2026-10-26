import type { Graph } from '@lenke/core';

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
 * LAZY on purpose. `run` returns an iterable and the engines already differ on laziness under a
 * zero-row slice, so returning an eager array would change observable behaviour for a caller
 * that takes one value. One generator for the whole walk costs 10ns/row over the eager form,
 * which is the price of not touching that.
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
export type HopValues = { values: Iterable<unknown>; rest: readonly Step[] };

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
