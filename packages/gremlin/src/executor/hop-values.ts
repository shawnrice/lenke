import type { Graph } from '@lenke/core';

import type { Plan } from '../ast.js';
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
export const hopValuesShortcut = (plan: Plan, graph: Graph): Iterable<unknown> | undefined => {
  const { steps } = plan;

  if (steps.length !== 3) {
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

  // ONE key. `values()` with no key emits every property value and `values(a, b)` fans out per
  // key — both are different shapes, not this one.
  if (proj.kind !== 'values' || proj.keys.length !== 1) {
    return undefined;
  }

  const [key] = proj.keys;
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
    const index = kind === 'out' ? graph.edgesFromByLabel : graph.edgesToByLabel;
    const forward = kind === 'out';

    return {
      *[Symbol.iterator]() {
        for (const v of graph.vertices) {
          const bucket = index.get(v.id)?.get(oneType);

          if (bucket === undefined) {
            continue;
          }

          for (const edge of bucket) {
            const far = forward ? edge.to : edge.from;
            const value = far.properties[key];

            if (value !== undefined) {
              yield value;
            }
          }
        }
      },
    };
  }

  return {
    *[Symbol.iterator]() {
      for (const v of graph.vertices) {
        for (const edge of adjacentEdges(kind, graph, v, labels)) {
          const value = otherEndpoint(kind, edge, v).properties[key];

          // `values(k)` DROPS an element lacking `k` rather than emitting null — verified
          // against a real TinkerPop console (`V().count()` 6 against
          // `V().values('age').count()` 4). A STORED null is a present value and IS emitted,
          // which is why this tests `undefined` and not nullishness.
          if (value !== undefined) {
            yield value;
          }
        }
      }
    },
  };
};
