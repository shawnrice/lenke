// `V().out(T).path()` — the whole plan claimed, so the path never has to be ACCUMULATED.
//
// WHY A NEW MODULE. `tagged-hop-values.ts` already walks this adjacency and builds a row per edge
// from `(from, far)`, so a path row looks like one more row builder there — but that module is built
// around HAVING an `as_` label (its gate reads `tag.kind !== 'as'` before anything else) and a path
// shape has none, so admitting it would change the module's entry condition rather than add a mode.
// `optional-hop.ts` and `sub-plan-existence.ts` are the precedent: a new module, one `dispatch`-side
// call site, and none of the toll item 1482 measured on edits to the hop files.
//
// WHAT IT IS FOR. `path()` makes `planReadsPath` TRUE, and EVERY fused walk in this package is gated
// on `!tracksPath` — the walks emit bare values and build no traverser, so a plan that reads the
// path cannot ride one. `path: hop path` was therefore the workload screen's TOP row:
//
//     124.55 ms for 600,000 rows, against the plain hop's 50.65
//
// Items 1912/1914 established how to ride past that guard, and the warrant is that the rung claims
// the ENTIRE plan: three steps, `rest` is always `[]`, so there is no downstream step left that
// could ask for a path. A fourth step declines.
//
// 🔑 THE LAYOUT WAS READ OFF THE ENGINE, NOT ASSUMED. `pathshape-probe-1920.mjs` printed it, because
// CLAUDE.md records hand oracles in this corpus being wrong four times in one stretch and a fusion
// built on a guessed path layout is a wrong answer no aggregate would show:
//
//     V().out(E).path()         [V:a V:b]  [V:b V:c]  [V:d V:d]      <- [near, far], per edge
//     V().in(E).path()          [V:b V:a]  [V:c V:b]  [V:d V:d]      <- near is still the SCAN
//                                                                       vertex, so `[from, far]`
//                                                                       serves both directions
//     V().outE(E).path()        [V:a E:e1]                           <- an EDGE in the path:
//                                                                       REFUSED, different layout
//     V().out(E).values(n).path()  [V:a V:b "b"]                     <- a SCALAR too: REFUSED
//     V().out(E).out(E).path()  [V:a V:b V:c]                        <- three deep: REFUSED
//
// ⚠️ A SELF-LOOP GIVES `[d, d]` AND THAT IS THE ANSWER, not a case to drop — the generic path does
// the same, and getting it wrong would be a wrong answer on one edge per vertex.
//
// ⚠️ THE CEILING WAS PRICED BEFORE ANY OF THIS WAS WRITTEN (`pathfuse-ceiling-1920.mjs`), because
// the rung must allocate one 2-element array per row where the plain hop allocates none, and if that
// ate the win there would be nothing to take:
//
//     hand walk, no row built      15.78 ms
//     hand walk, far vertex only   19.35
//     hand walk, [near, far]       26.11        <- the allocation is 6.75 ms, not the win
//     the engine, this shape      124.55        <- so up to 98.44 ms, 4.77x, is available
import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import { seenBefore } from './hop-values-csr.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { soleTypeBucket } from './movement.js';

type WalkSpec = {
  readonly forward: boolean;
  readonly type: string;
  /**
   * The single `by(k)` modulator's key, or `undefined` for a bare `path()` (item 1924).
   *
   * ⚠️ WITH A KEY THE ROW HOLDS THE PROJECTED VALUES, not the elements — `[near[k], far[k]]` — and
   * the two cases below are NOT interchangeable.
   */
  readonly byKey: string | undefined;
};

/**
 * One path position projected through a `by(k)` modulator, mirroring `evalBy`'s `'key'` arm exactly.
 *
 * ⚠️⚠️ AN ABSENT KEY AND A STORED NULL ARE DIFFERENT VALUES, and a probe is why rather than a
 * reading of the code: `pathby-shape-1924.mjs` prints `path().by(opt)` as `[1, undefined]` for a
 * vertex MISSING `opt` and `[1, null]` for one holding a stored `null`. ⚠️ The first version of that
 * probe used `JSON.stringify`, which renders `undefined` inside an array AS `null` — so it showed
 * both as `null` and hid the distinction entirely. A fusion building `null` for an absent key would
 * have been a wrong answer no JSON comparison could see.
 *
 * ⚠️ AND IT IS `Object.hasOwn`, NOT `in`: `evalBy`'s own note says an inherited name must never leak
 * a prototype function, and `path().by(toString)` answers `[undefined, undefined]`. Using `in` here
 * would put `function toString()` in the row. [[prototype-key-class-not-a-bug]].
 *
 * Hoisted to module scope ([[ts-closure-size-is-load-bearing]]).
 */
const byVal = (v: Vertex, key: string): unknown => {
  // Read the bag ONCE: `properties` is a getter doing a string-keyed lookup into the graph's whole
  // property store, which `evalBy` measures at ~225ns cold.
  const bag = v.properties;

  return Object.hasOwn(bag, key) ? bag[key] : undefined;
};

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE ([[ts-closure-size-is-load-bearing]]), with the eager
 * `drain` beside it for item 1412's reason — `toArray` prefers it, and items 1889/1891/1893 each
 * found the eager fill was most of the available win.
 *
 * ⚠️ THE ORDER IS THE PIPELINE'S: global vertex order, each vertex's adjacency in its own order,
 * which is what the generic walk emits. Gremlin results are compared ORDERED against the Rust
 * engine by the differential fuzzer, so this is a requirement and not a liberty.
 *
 * ⚠️⚠️ AND THE DRAIN'S LOOP IS WRITTEN OUT RATHER THAN DELEGATED TO `each`, which item 1913 priced
 * at 1.6-2.0x: a `drain` that iterates a `function*` helper pays the generator FRAME per element.
 * So this is the same loop twice — item 169's named hazard, where an off-by-one can live in one copy
 * and not the other — which is why `path-hop-values.test.ts` reaches BOTH arms on a fixture that can
 * tell them apart, and why the mutation battery carries a per-arm mutant for each.
 */
const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
  *[Symbol.iterator]() {
    yield* each(graph, spec);
  },
  drain() {
    const { forward, type, byKey } = spec;
    const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;
    const out: unknown[] = [];

    if (csr !== undefined) {
      const { vtx, memo } = csr;

      for (let slot = 0; slot < vtx.length; slot += 1) {
        const from = vtx[slot];
        const to = memo.off[slot] + memo.len[slot];

        for (let i = memo.off[slot]; i < to; i += 1) {
          const far = vtx[memo.flat[i]];

          out.push(byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)]);
        }
      }

      return out;
    }

    /*
     * ⚠️ `graph.vertices` IS A PROPERTY, NOT A METHOD — the first cut wrote `graph.vertices()` and
     * every admitted shape threw `TypeError: graph.vertices is not a function`, which the shape
     * probe caught immediately because it prints each case's answer rather than a total.
     *
     * ⚠️ AND `soleTypeBucket` NEVER RETURNS `undefined` HERE: the gate already restricted this to a
     * directed single-type hop, which is exactly what it serves, and an EMPTY bucket still returns a
     * shape (its own note says conflating that with "no such edge" would send a zero-degree vertex
     * down the general path for nothing). The cast mirrors `tagged-hop-values.ts`'s.
     */
    for (const v of graph.vertices) {
      const direct = soleTypeBucket(v, forward ? 'out' : 'in', [type]);

      if (direct === undefined) {
        continue;
      }

      for (const e of direct.set) {
        const far = direct.forward ? e.to : e.from;

        out.push(byKey === undefined ? [v, far] : [byVal(v, byKey), byVal(far, byKey)]);
      }
    }

    return out;
  },
});

/** The lazy twin of `drain`, for a consumer that does not offer to drain. */
const each = function* (graph: Graph, spec: WalkSpec): Iterable<unknown> {
  const { forward, type, byKey } = spec;
  const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;

  if (csr !== undefined) {
    const { vtx, memo } = csr;

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = vtx[slot];
      const to = memo.off[slot] + memo.len[slot];

      for (let i = memo.off[slot]; i < to; i += 1) {
        const far = vtx[memo.flat[i]];

        yield byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)];
      }
    }

    return;
  }

  for (const v of graph.vertices) {
    const direct = soleTypeBucket(v, forward ? 'out' : 'in', [type]);

    if (direct === undefined) {
      continue;
    }

    for (const e of direct.set) {
      const far = direct.forward ? e.to : e.from;

      yield byKey === undefined ? [v, far] : [byVal(v, byKey), byVal(far, byKey)];
    }
  }
};

/**
 * The `path()` form this rung serves: `'bare'`, or the single `by(k)` modulator's key (item 1924).
 *
 * ⚠️ EXACTLY ONE `by`, because they CYCLE round-robin across path positions: `path().by(n).by(opt)`
 * projects position 0 through `n` and position 1 through `opt`, which the probe shows as
 * `["a", undefined]`. Two keys is a different answer, so only one is admitted.
 *
 * ⚠️ AND ONLY A `'key'` BY. Item 1899 shipped a gate testing `typeof by === 'string'` when the AST
 * holds `{kind: 'key', key}`, and only measuring BOTH spellings caught it — so the kind is tested
 * here, and a `by(traversal(...))` or a bare `by()` identity falls through.
 */
const pathForm = (step: Step): 'bare' | { readonly key: string } | undefined => {
  if (step.kind !== 'path') {
    return undefined;
  }

  const bys = 'bys' in step ? step.bys : undefined;

  if ((bys?.length ?? 0) === 0) {
    return 'bare';
  }

  if (bys?.length !== 1) {
    return undefined;
  }

  const [by] = bys;

  return by.kind === 'key' && by.direction === undefined ? { key: by.key } : undefined;
};

/**
 * `V(), <one directed single-type vertex hop>, path()` — or `undefined` for every other plan.
 *
 * ⚠️ THE GATE IS A SHAPE TEST, NOT A CAPABILITY CLAIM, and each refusal has its own reason:
 *
 *   - **Exactly three steps.** The warrant for riding past `tracksPath` is that `rest` is `[]`, so
 *     nothing downstream can ask for a path. A fourth step breaks that and declines.
 *   - **`V()` with no ids.** `V(id, …)` enumerates a given set rather than the whole graph — the
 *     bound every values rung in this package has.
 *   - **`out`/`in` with exactly ONE label.** `both` walks two buckets and drops a self-loop's
 *     duplicate, and a multi-type hop needs the cross-bucket dedupe; `soleTypeBucket` refuses both
 *     for those reasons and this follows it rather than re-deriving them.
 *   - **A BARE `path()`.** `path().by(…)` projects each element through a cycling modulator, which
 *     is a different answer per element.
 */
export const pathHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length !== 3) {
    return undefined;
  }

  const [source, hop, tail] = steps;

  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  const form = pathForm(tail);

  if (form === undefined) {
    return undefined;
  }

  return {
    rest: [],
    values: walk(graph, {
      forward: hop.kind === 'out',
      type: hop.labels[0],
      byKey: form === 'bare' ? undefined : form.key,
    }),
  };
};
