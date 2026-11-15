import type { Edge, Graph, Vertex } from '@lenke/core';

import type { By, Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import { seenBefore } from './hop-values-csr.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { soleTypeBucket } from './movement.js';
import { valueDedupeFilter } from './runtime.js';

/**
 * `V().out(T).values(k).dedupe()` and `V().out(T).dedupe().by(k).values(k)` — the DISTINCT far values
 * of a hop, as one fused walk (item 1899).
 *
 * ⚠️⚠️ **FOUND BY PROFILING THE FAST SIDE, which is [[element-dedup-identity-vs-key]]'s transferable
 * lesson applied with the surfaces swapped.** That memo closed five failed mechanism guesses with:
 * "when one surface is much faster at the same question and the mechanism guesses keep failing,
 * PROFILE THE FAST SIDE. Its frames name the shortcut." Here GQL is the fast side, by an order of
 * magnitude — 200,000 vertices / 1,000,000 edges, one shape per process, median of 7:
 *
 * ```text
 *   GQL       MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.n AS n    21.42 ms   8 rows
 *   Gremlin   V().out(E).dedupe().by(n).values(n)                276.95      8   ⬅ 12.9x
 *   Gremlin   V().out(E).values(n).dedupe()                      131.48      8   ⬅  6.1x
 * ```
 *
 * GQL's number is lower than its own UNDEDUPED projection (26 ms after item 1895) because its rung
 * dedupes INSIDE the walk: eight rows are ever built. Gremlin's pipeline builds 800,000 traversers,
 * evaluates the `by` per traverser and keeps a `Set` beside them.
 *
 * ⚠️ BOTH SPELLINGS ARE ONE QUESTION AND GET ONE WALK, which is this repo's equivalent-spelling rule
 * rather than a convenience: `values(k).dedupe()` emits the distinct values of `k` in first-seen
 * order, and `dedupe().by(k).values(k)` keeps the first ELEMENT per `k` and then reads `k` off it —
 * the same values in the same order. `bun run spelling:gremlin` is where a divergence between them
 * would surface, so they must not take different routes.
 *
 * ⚠️ AND THE `by` KEY MUST EQUAL THE PROJECTED KEY. `dedupe().by('n').values('k')` keeps the first
 * element per `n` and projects `k` off it, which is NOT the distinct `k` values — a different
 * question, declined here.
 *
 * ⚠️ THE KEY SPACE IS `valueDedupeFilter`'S, IMPORTED (item 1869). It carries five spaces — a plain
 * `Set`, a composite string key with a `WeakSet` short-circuit, `LocalDate` on `days`, a nested
 * temporal container, and `NO_VALUE` — and items 1561/1562 each found a silent ANSWER change in this
 * area on the GQL side. A second keyer here would be the third.
 *
 * ⚠️ IT RIDES ITEM 1889'S CSR AND ITS SECOND-ASK POLICY where the hop is a directed single type, for
 * the reasons that item measured: the flat `Int32Array` run costs no `Map.get` per vertex, and the
 * build is deferred to the second ask so a one-shot query and a write-heavy workload never pay it.
 */
export const hopValuesDedupe = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 4) {
    return undefined;
  }

  const [source, hop, third, fourth] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  const keys = dedupedKey(third, fourth);

  if (keys === undefined) {
    return undefined;
  }

  return {
    rest: steps.slice(4),
    values: walk(graph, {
      forward: hop.kind === 'out',
      type: hop.labels[0],
      key: keys.key,
      projectKey: keys.projectKey,
      labels: hop.labels,
      kind: hop.kind,
    }),
  };
};

/**
 * The single property key both spellings reduce to, or `undefined` for every other shape.
 *
 * ⚠️ A `hasLabel` ON THE DEDUPE DECLINES. `dedupe(label)` is a scoped dedupe over labelled steps —
 * a different question from "distinct values" — and `nodeValuesDedupeShortcut` refuses it for the
 * same reason.
 */
const dedupedKey = (
  third: Step | undefined,
  fourth: Step | undefined,
): { readonly key: string; readonly projectKey: string } | undefined => {
  if (third === undefined || fourth === undefined) {
    return undefined;
  }

  // `values(k).dedupe()` — the dedupe is over the VALUE, so both keys are the same one.
  if (third.kind === 'values' && fourth.kind === 'dedupe') {
    return third.keys.length === 1 &&
      (fourth.labels?.length ?? 0) === 0 &&
      (fourth.bys?.length ?? 0) === 0
      ? { key: third.keys[0], projectKey: third.keys[0] }
      : undefined;
  }

  /*
   * `dedupe().by(k).values(j)` — item 1971 admits `j !== k`, which this rung used to decline.
   *
   * ⚠️ THE HEADER'S OBJECTION STANDS AND IS NOT BEING OVERRULED: `dedupe().by(k).values(j)` is NOT
   * "the distinct `j` values", and it is a different question from `values(j).dedupe()`. What item
   * 1971 observed is that being a different question does not make it unfusable — it keeps the
   * first element per distinct `k` and reads `j` off it, which this walk can do by reading two
   * properties instead of one. The two SPELLINGS still take different routes because they ask
   * different things, so `bun run spelling:gremlin` has nothing to flag.
   *
   * Measured at item 1970, 200,000 vertices / 1,000,000 edges, identical 97 rows either way:
   * **524 ns a visit against the same-key spelling's 253 — 2.07x**, with a both-fused control at
   * 1.05x proving the pairing sound.
   *
   * ⚠️ AND THE MISSING-KEY SEMANTICS ARE THE WHOLE RISK, so they were measured off the GENERIC
   * pipeline before anything was built (`dedupekeys-1971.mjs`): an element missing the DEDUPE key is
   * dropped entirely, while one missing the PROJECTED key still CONSUMES its dedupe slot and emits
   * nothing. The loops below reproduce exactly that, and this file's header is why it was checked —
   * items 1561/1562 each found a silent ANSWER change in this area.
   */
  if (third.kind === 'dedupe' && fourth.kind === 'values') {
    const by = byKey(third.bys);

    return by !== undefined && (third.labels?.length ?? 0) === 0 && fourth.keys.length === 1
      ? { key: by, projectKey: fourth.keys[0] }
      : undefined;
  }

  return undefined;
};

/**
 * The ONE plain property key a `by` modulator names, or `undefined`.
 *
 * ⚠️ ONLY A BARE PROPERTY KEY. A `by` may carry a traversal, a token, a column or a comparator in
 * this AST; anything but a single `{kind: 'key'}` is a different question and declines.
 *
 * ⚠️⚠️ **AND A `By` IS NEVER A STRING HERE, which is how this rung silently did nothing.** The first
 * cut tested `typeof by === 'string'`, because `.by('n')` is how a caller writes it — but
 * `makeByable`'s modulator normalizer (`steps/framework.ts`) turns that string into
 * `{kind: 'key', key: 'n', direction}` before it reaches the plan, so the test was always false and
 * the `dedupe().by(k)` spelling kept the generic pipeline: 257.50 ms against the other spelling's
 * 64.77 on the same build. ⚠️ The ONLY thing that caught it was measuring BOTH spellings in one
 * instrument and seeing one move; a route screen keyed on the rung firing at all would have passed.
 */
const byKey = (bys: readonly By[] | undefined): string | undefined => {
  if (bys?.length !== 1) {
    return undefined;
  }

  const [by] = bys;

  // A `direction` is an ordering instruction; it has no meaning on a dedupe and is not this shape.
  return by.kind === 'key' && by.direction === undefined ? by.key : undefined;
};

type WalkSpec = {
  readonly forward: boolean;
  readonly type: string;
  /** The key the DEDUPE is keyed on. */
  readonly key: string;
  /**
   * The key the row PROJECTS. Equal to {@link WalkSpec.key} for both spellings this rung served
   * before item 1971; different for `dedupe().by(k).values(w)`, which the header above describes.
   */
  readonly projectKey: string;
  readonly kind: 'out' | 'in';
  readonly labels: readonly string[];
};

/**
 * The far values of the hop, first-seen only.
 *
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE ([[ts-closure-size-is-load-bearing]]), and the eager
 * `drain` beside it for item 1412's reason — `toArray` prefers it, and items 1889/1891/1893 each
 * found the eager fill was most of the available win.
 *
 * ⚠️ THE ORDER IS THE PIPELINE'S: first-seen order over `graph.vertices` and each vertex's bucket,
 * which is what the generic `dedupe` emits. Gremlin results are compared ORDERED by the differential
 * fuzzer, so this is a requirement rather than a liberty.
 */
const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
  *[Symbol.iterator]() {
    const keep = valueDedupeFilter();
    const { key, projectKey } = spec;

    /*
     * ⚠️ `farElements` YIELDS THE ELEMENT, not the value, since item 1971 — because two keys have to
     * be read off the SAME element and a generator yielding a pair would allocate per element. The
     * three tests below are in the order the generic pipeline applies them, and that order is the
     * answer: a missing DEDUPE key drops the element without consuming a slot, while a missing
     * PROJECTED key consumes its slot and emits nothing (`dedupekeys-1971.mjs` measured both).
     */
    for (const far of farElements(graph, spec)) {
      const value = far.properties[key];

      if (value === undefined || !keep(value)) {
        continue;
      }

      const projected = far.properties[projectKey];

      if (projected !== undefined) {
        yield projected;
      }
    }
  },
  /*
   * ⚠️⚠️ **THE LOOP IS WRITTEN OUT RATHER THAN DELEGATED TO `farValues`, AND THAT IS WORTH 1.4x**
   * (item 1913). This drain used to be `for (const far of farValues(...))`, which is correct and
   * pays a generator frame per element. The same mistake in `tagged-hop-values.ts` measured
   * **76.50 ms against 39.17** on an 800,000-row shape; a profile put 44.7% in the generator body
   * with `generatorResume` only 3.8%, so the cost is the `function*` FRAME being optimized less
   * well than a plain loop — not the resumes.
   *
   * ⚠️ THE SAME LOOP TWICE IS ITEM 169'S NAMED HAZARD, and the cover is already here: the suite
   * spreads `run` to reach the lazy iterator, and `dedupe-mutants-1899.mjs` carries a per-arm
   * mutant for each copy.
   */
  drain() {
    const { forward, type, key, projectKey, kind, labels } = spec;
    const keep = valueDedupeFilter();
    const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;
    const out: unknown[] = [];

    if (csr !== undefined) {
      const { vtx, memo } = csr;

      for (let slot = 0; slot < vtx.length; slot += 1) {
        const to = memo.off[slot] + memo.len[slot];

        for (let i = memo.off[slot]; i < to; i += 1) {
          const far = vtx[memo.flat[i]];
          const value = far.properties[key];

          if (value !== undefined && keep(value)) {
            // The PROJECTED key off the element the dedupe just kept. Identical to the read this
            // loop always did when the two keys are the same.
            const projected = far.properties[projectKey];

            if (projected !== undefined) {
              out.push(projected);
            }
          }
        }
      }

      return out;
    }

    for (const v of graph.vertices) {
      const { set, forward: fwd } = soleTypeBucket(v, kind, labels) as {
        readonly set: ReadonlySet<Edge>;
        readonly forward: boolean;
      };

      for (const e of set) {
        const far = fwd ? e.to : e.from;
        const value = far.properties[key];

        if (value !== undefined && keep(value)) {
          const projected = far.properties[projectKey];

          if (projected !== undefined) {
            out.push(projected);
          }
        }
      }
    }

    return out;
  },
});

/**
 * Every far value the hop reaches, in pipeline order — the CSR run where item 1889's policy says the
 * flat index is worth it, and the per-vertex bucket otherwise.
 *
 * ⚠️ A MISSING KEY IS SKIPPED, NOT DEDUPED AS `undefined`: `projectValues` drops an element lacking
 * the key (`k in props`), so such a far vertex contributes no row at all — and therefore must not
 * occupy the dedupe set either, or the first missing key would swallow a later real `undefined`.
 */
const farElements = function* (graph: Graph, spec: WalkSpec): Iterable<Vertex> {
  const { forward, type, kind, labels } = spec;
  const csr = seenBefore(graph, forward, type) ? chainCsrFor(graph, forward, [type]) : undefined;

  if (csr !== undefined) {
    const { vtx, memo } = csr;

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const to = memo.off[slot] + memo.len[slot];

      for (let i = memo.off[slot]; i < to; i += 1) {
        yield vtx[memo.flat[i]];
      }
    }

    return;
  }

  for (const v of graph.vertices) {
    // ⚠️ NO `adjacentEdges` FALLBACK, AND IT IS NOT AN OMISSION. `soleTypeBucket` returns
    // `undefined` for exactly two inputs — `kind === 'both'` and a hop naming more than one label —
    // and the gate above refuses both, so a fallback branch here would be unreachable by
    // construction. ⚠️ Two mutants that disabled one SURVIVED the whole suite, which is how it was
    // found: an untestable branch and a dead branch look identical from the test side, so the
    // mutation run is what distinguishes them. The non-null assertion below is that proof, not a
    // convenience.
    const { set, forward: fwd } = soleTypeBucket(v, kind, labels) as {
      readonly set: ReadonlySet<Edge>;
      readonly forward: boolean;
    };

    for (const e of set) {
      yield fwd ? e.to : e.from;
    }
  }
};
