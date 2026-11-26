import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import { seenBefore } from './hop-values-csr.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { soleTypeBucket } from './movement.js';

/**
 * `V().as_(k).out(T).select(k)` and `V().as_(k).out(T).where(neq(k))` — the two TAGGED hop shapes
 * that are tag-FREE computations (item 1912).
 *
 * **THESE RIDE DESPITE `tracksPath`, WHICH NO OTHER FUSED RUNG DOES, AND THE WHOLE SAFETY
 * ARGUMENT IS THAT THEY CLAIM THE ENTIRE PLAN.** `fusedProjectedValues` is guarded on
 * `!tracksPath` for a stated reason — its rungs emit bare values and build no traverser, so a plan
 * that reads the path must not ride one. Item 1900 measured the consequence: the Gremlin surface's
 * four largest shapes all make `planReadsPath` true and so could not reach any fusion, and it
 * recorded their cost as "a question about that bookkeeping rather than a missing rung".
 *
 * **THE PROFILE SAYS THE BOOKKEEPING IS THE MINORITY.** At 50,000 vertices, where the query
 * dominates the fixture, `as_(a).out(E).select(a)` is **39.2% `generatorResume` + 25.2% the
 * adjacency generator** and only ~15% in the tag machinery (`asStep` 8.6%, `extend` 2.1%, `Map`
 * 1.4%, `cloneObject` 2.6%). So the cost is running the HOP generically, which a fused walk fixes —
 * the tags were never the expensive part.
 *
 * **AND BOTH SHAPES ARE TAG-FREE, verified on a fixture before any code was written:**
 *
 * ```text
 *   V().as_(a).out(E).select(a)       ->  the NEAR vertex, once per out-edge  (a,a,b,c)
 *   V().as_(a).out(E).where(neq(a))   ->  the FAR vertices that are not the near one  (b,c,c)
 *   V().out(E)                        ->  (b,c,c,c)   — the same walk, for comparison
 * ```
 *
 * `select(k)` repeats the near vertex by its degree and `where(neq(k))` is the bare hop minus
 * self-loops. Neither needs a tag MAP: the walk holds the near vertex already.
 *
 * FOUR STEPS EXACTLY, AND `rest` IS ALWAYS EMPTY. That is what makes riding past `tracksPath`
 * sound rather than lucky: there is no downstream step left to ask for a path. A fifth step — even
 * `limit(1)` — declines the whole rung and the plan runs generically, because a residual would be
 * handed a stream of bare values whose traversers never existed.
 *
 * AND IT RIDES ITEM 1889'S CSR AND ITS SECOND-ASK POLICY where the hop is a directed single
 * type, for that item's reasons: the flat `Int32Array` run costs no `Map.get` per vertex, and the
 * build is deferred to the second ask so a one-shot or write-heavy workload never pays it.
 */
export const taggedHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  /*
   * FOUR STEPS, OR FIVE WITH A TRAILING SINGLE-KEY `values(k)` — and `rest` is empty either way,
   * which is the whole warrant (see the header).
   *
   * THE FIFTH STEP IS NOT A CONVENIENCE: it is the spelling the workload screen measures and
   * the one an application writes, because you want a PROPERTY off the tagged element rather than
   * the element itself. The four-step rung alone moved the isolated shapes 17.6x and 10.9x and left
   * the screen's rows at 406 and 196 ms untouched — a win that did not reach the shape anyone had
   * flagged. The screen's own definitions are what showed it.
   */
  if (steps.length !== 4 && steps.length !== 5) {
    return undefined;
  }

  const [source, tag, hop, tail, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (tag.kind !== 'as') {
    return undefined;
  }

  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  /*
   * THE PAIR SHAPE HAS A DIFFERENT LAYOUT, so it is resolved before the single-tag modes:
   * `[V, as_(a), hop, as_(b), select(a, b)]` tags BOTH ends and projects a two-key object. It was
   * the workload screen's largest row at **264.93 ms** once item 1912 took the single-tag shapes,
   * and item 1912 recorded it as "a different question — it projects a MAP of two tags, not a
   * repeat of one". It is a different question and it is equally tag-free: for each near/far pair
   * the object is `{a: near, b: far}`, which the walk can build directly.
   */
  const pair = pairMode(tail, proj, tag.label);

  if (pair !== undefined) {
    return {
      rest: [],
      values: walk(graph, {
        forward: hop.kind === 'out',
        type: hop.labels[0],
        kind: hop.kind,
        labels: hop.labels,
        near: false,
        valueKey: undefined,
        pair,
      }),
    };
  }

  const mode = tailMode(tail, tag.label);

  if (mode === undefined) {
    return undefined;
  }

  // ONE key. `values()` with no key emits every property value and `values(a, b)` fans out per
  // key — both are different shapes, which is `hopValuesShortcut`'s own bound.
  const valueKey = proj === undefined ? undefined : soleValuesKey(proj);

  if (proj !== undefined && valueKey === undefined) {
    return undefined;
  }

  return {
    rest: [],
    values: walk(graph, {
      forward: hop.kind === 'out',
      type: hop.labels[0],
      kind: hop.kind,
      labels: hop.labels,
      near: mode === 'near',
      valueKey,
      pair: undefined,
    }),
  };
};

/**
 * Which of the two shapes the last step is, or `undefined` for everything else.
 *
 * `select(k)` MUST NAME EXACTLY THE TAG AND NOTHING ELSE. `select(a, b)` projects a MAP, a `by`
 * modulates the projection, and a `pop` of `'all'` yields a LIST — each a different answer, and the
 * tag is bound once here so `'first'` and `'last'` agree and both are admitted.
 *
 * `where(neq(k))` MUST BE THE PREDICATE-ONLY FORM whose operand is the tag's own label. The
 * two-tag form (`where('b', neq('a'))`) reads a second tag this shape does not bind, and any other
 * operator is a different question — `eq` would keep only the self-loops, which is a shape nobody
 * has measured and not what this rung computes.
 */
const tailMode = (tail: Step, label: string): 'near' | 'far' | undefined => {
  if (tail.kind === 'select') {
    const onlyTag = tail.labels.length === 1 && tail.labels[0] === label;
    const plain = (tail.bys?.length ?? 0) === 0 && tail.pop !== 'all';

    return onlyTag && plain ? 'near' : undefined;
  }

  if (tail.kind !== 'where' || !('pred' in tail) || 'startKey' in tail) {
    return undefined;
  }

  const { pred } = tail;

  return pred.op === 'neq' && 'value' in pred && pred.value === label ? 'far' : undefined;
};

/**
 * `[as_(b), select(a, b)]` as the two output keys in the SELECT's order, or `undefined`.
 *
 * **THE KEY ORDER IS THE SELECT'S, NOT A FIXED ONE.** `select('y','x')` answers
 * `{y: …, x: …}`, and [[column-order-is-observable]] makes that part of the answer rather than a
 * detail — row ORDER is unspecified in places, column order never is. So the walk is told which of
 * the two keys comes first and which end each names.
 *
 * BOTH LABELS MUST BE THE TWO TAGS, EACH ONCE. `select('a','a')` projects the same end twice —
 * a different answer this rung does not compute — and a third label names a tag nothing binds.
 *
 * AND NO `by` OR `pop: 'all'`, for `tailMode`'s reasons: a `by` modulates each projection and
 * `'all'` yields lists. Both tags are bound exactly once here, so `'first'` and `'last'` agree.
 */
const pairMode = (
  tail: Step,
  proj: Step | undefined,
  startLabel: string,
): { readonly keys: readonly [string, string]; readonly firstIsNear: boolean } | undefined => {
  if (tail.kind !== 'as' || proj?.kind !== 'select') {
    return undefined;
  }

  const farLabel = tail.label;

  if (farLabel === startLabel || proj.labels.length !== 2) {
    return undefined;
  }

  if ((proj.bys?.length ?? 0) > 0 || proj.pop === 'all') {
    return undefined;
  }

  const [k0, k1] = proj.labels;

  if (k0 === startLabel && k1 === farLabel) {
    return { keys: [k0, k1], firstIsNear: true };
  }

  return k0 === farLabel && k1 === startLabel ? { keys: [k0, k1], firstIsNear: false } : undefined;
};

/**
 * The ONE property key a trailing `values` names, or `undefined` for anything else.
 *
 * A `values` STEP IS THE ONLY FIFTH STEP ADMITTED. Any other — a `limit`, an `order`, a `path` —
 * declines the whole rung, because `rest` must stay empty for this fusion to ride past the
 * `tracksPath` guard.
 */
const soleValuesKey = (proj: Step): string | undefined =>
  proj.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;

type WalkSpec = {
  readonly forward: boolean;
  readonly type: string;
  readonly kind: 'out' | 'in';
  readonly labels: readonly string[];
  /** `true` emits the NEAR vertex per edge (`select`); `false` the FAR one, minus self (`neq`). */
  readonly near: boolean;
  /**
   * A trailing `values(k)`, folded into the pick — `undefined` emits the element itself.
   *
   * IT DROPS an element lacking `k`, which is `projectValues`' own rule (`k in props`) and NOT
   * nullishness: a STORED null is a present value and IS emitted. `hop-values.ts` records the
   * TinkerPop console check behind that distinction.
   */
  readonly valueKey: string | undefined;
  /**
   * The two-key object shape, for the `select(a, b)` pair — `undefined` for the single-tag modes.
   *
   * THE KEYS ARE STORED COMPUTED, not as a literal, so the row gets a transitioning hidden class
   * rather than one shape. Item 1897 measured that gap at **2.8x** for a five-column row and found
   * it CODEGEN-BLOCKED: reaching a literal's shape needs a generated constructor, and
   * [[no-runtime-codegen]] is firm because it forces `unsafe-eval` into every embedder's CSP. The
   * win here is the generator chain and the tag maps, not the row shape.
   */
  readonly pair:
    | { readonly keys: readonly [string, string]; readonly firstIsNear: boolean }
    | undefined;
};

/**
 * The two-key row for the `select(a, b)` pair, in the SELECT's key order.
 *
 * AT MODULE SCOPE, so neither walk closure grows ([[ts-closure-size-is-load-bearing]]), and the
 * self-loop is INCLUDED — `select` emits every edge's pair, unlike `where(neq)` which drops it.
 */
const pairRow = (
  pair: { readonly keys: readonly [string, string]; readonly firstIsNear: boolean },
  from: Vertex,
  far: Vertex,
): Record<string, unknown> => {
  const [k0, k1] = pair.keys;

  return pair.firstIsNear ? { [k0]: from, [k1]: far } : { [k0]: far, [k1]: from };
};

/**
 * ONE LOOP, PARAMETERIZED, AT MODULE SCOPE ([[ts-closure-size-is-load-bearing]]), with the eager
 * `drain` beside it for item 1412's reason — `toArray` prefers it, and items 1889/1891/1893 each
 * found the eager fill was most of the available win.
 *
 * THE ORDER IS THE PIPELINE'S: global vertex order, each vertex's adjacency in its own order,
 * which is what the generic walk emits. Gremlin results are compared ORDERED by the differential
 * fuzzer, so this is a requirement rather than a liberty.
 */
const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
  *[Symbol.iterator]() {
    yield* each(graph, spec);
  },
  /*
   * **THE DRAIN'S LOOP IS WRITTEN OUT, NOT DELEGATED TO `each`, AND THAT IS WORTH 1.8x**
   * (item 1913). The first cut had `for (const v of each(...)) out.push(v)` — correct, and it paid
   * a generator frame per element: `where(neq(a)).values(n)` measured **76.50 ms against the plain
   * hop's 42.50** on nearly identical row counts, for what is otherwise one pointer compare more.
   * The profile put 44.7% in `each` and 7.7% in `drain` with `generatorResume` only 3.8%, so the
   * cost is the generator BODY rather than the resumes — a `function*` frame is optimized less
   * well than a plain loop, and `hop-values-csr.ts` writes both arms out for exactly this reason.
   *
   * SO THIS IS THE SAME LOOP TWICE, which is item 169's named hazard — an off-by-one can live in
   * one copy and not the other. `tagged-hop-values.test.ts` spreads `run` to reach the iterator, and
   * `fold-mutants-1909.mjs` carries a per-arm mutant for each.
   */
  drain() {
    const { forward, type, kind, labels, near, valueKey, pair } = spec;
    const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;
    const out: unknown[] = [];

    if (csr !== undefined) {
      const { vtx, memo } = csr;

      for (let slot = 0; slot < vtx.length; slot += 1) {
        const from = vtx[slot];
        const to = memo.off[slot] + memo.len[slot];

        for (let i = memo.off[slot]; i < to; i += 1) {
          const far = vtx[memo.flat[i]];

          if (pair !== undefined) {
            out.push(pairRow(pair, from, far));
            continue;
          }

          if (!near && far === from) {
            continue;
          }

          const held = near ? from : far;

          if (valueKey === undefined) {
            out.push(held);
            continue;
          }

          const value = held.properties[valueKey];

          if (value !== undefined) {
            out.push(value);
          }
        }
      }

      return out;
    }

    for (const v of graph.vertices) {
      const direct = soleTypeBucket(v, kind, labels) as {
        readonly set: ReadonlySet<{ from: Vertex; to: Vertex }>;
        readonly forward: boolean;
      };

      for (const e of direct.set) {
        const far = direct.forward ? e.to : e.from;

        if (pair !== undefined) {
          out.push(pairRow(pair, v, far));
          continue;
        }

        if (!near && far === v) {
          continue;
        }

        const held = near ? v : far;

        if (valueKey === undefined) {
          out.push(held);
          continue;
        }

        const value = held.properties[valueKey];

        if (value !== undefined) {
          out.push(value);
        }
      }
    }

    return out;
  },
});

/**
 * Every emitted element, in pipeline order — the CSR run where item 1889's policy says the flat
 * index is worth it, and the per-vertex bucket otherwise.
 *
 * A SELF-LOOP IS THE ONLY THING THE `near` ARMS DIFFER ON, and it is why the fixture that
 * verified these shapes has one: `select(k)` emits the near vertex for EVERY edge including a
 * self-loop, while `where(neq(k))` drops exactly those. Getting that backwards is a wrong answer on
 * one edge in a graph, which no aggregate would show.
 */
const each = function* (graph: Graph, spec: WalkSpec): Iterable<unknown> {
  const { forward, type, kind, labels, near, valueKey, pair } = spec;
  const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;

  if (csr !== undefined) {
    const { vtx, memo } = csr;

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = vtx[slot];
      const to = memo.off[slot] + memo.len[slot];

      for (let i = memo.off[slot]; i < to; i += 1) {
        const far = vtx[memo.flat[i]];

        if (pair !== undefined) {
          yield pairRow(pair, from, far);
          continue;
        }

        if (!near && far === from) {
          continue;
        }

        const held = near ? from : far;

        if (valueKey === undefined) {
          yield held;
          continue;
        }

        const value = held.properties[valueKey];

        if (value !== undefined) {
          yield value;
        }
      }
    }

    return;
  }

  for (const v of graph.vertices) {
    // The gate admits only a directed single-type hop, so `soleTypeBucket` always answers —
    // item 1899 found and deleted a dead `adjacentEdges` fallback in exactly this position.
    const direct = soleTypeBucket(v, kind, labels) as {
      readonly set: ReadonlySet<{ from: Vertex; to: Vertex }>;
      readonly forward: boolean;
    };

    for (const e of direct.set) {
      const far = direct.forward ? e.to : e.from;

      if (pair !== undefined) {
        yield pairRow(pair, v, far);
        continue;
      }

      if (!near && far === v) {
        continue;
      }

      const held = near ? v : far;

      if (valueKey === undefined) {
        yield held;
        continue;
      }

      const value = held.properties[valueKey];

      if (value !== undefined) {
        yield value;
      }
    }
  }
};
