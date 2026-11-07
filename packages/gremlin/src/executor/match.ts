import type { Graph } from '@lenke/core';
// match() — declarative pattern matching across `as`-bound labels.
//
// Each pattern is a traversal `as(start) … [as(end)]`. match() treats it as a
// constraint: from the value bound to `start`, run the inner traversal; the
// result must equal the value bound to `end` (if `end` is already bound) or
// *bind* `end` to it (if not). A pattern with no trailing `as` is a pure filter
// on `start`; a pattern wrapped in `not(...)` (or `where(...)`) is a filter that
// must (not) hold. match() emits one traverser per consistent assignment of
// values to labels, carrying the bindings as tags so `select(...)` reads them.
//
// The solver is a depth-first join: seed the "source" label from the incoming
// traverser, then repeatedly run any pattern whose start label is already
// bound (preferring binding patterns over filters), branching the stream per
// candidate, until every pattern has been applied.
import { ErrorCode, LenkeError } from '@lenke/errors';

import { anyMayFault, EFF_CHECKED, EFF_PREFIX, maskOfSteps, stepReadsPath } from '../ast.js';
import type { Plan, Step } from '../ast.js';
import { applyPlanToStream } from './dispatch.js';
import { soleTypeBucket } from './movement.js';
import {
  extend,
  hasAny,
  isEdge,
  isVertex,
  recallTag,
  type RunContext,
  type Traverser,
  tupleKey,
  unwrap,
} from './runtime.js';

/** A match pattern lowered to its solver shape. */
type Pattern = {
  /** Label whose bound value seeds the inner traversal. */
  readonly startKey: string;
  /** Label the inner traversal's output binds/filters; absent ⇒ pure filter. */
  readonly endKey?: string;
  /** Steps between the leading `as(start)` and trailing `as(end)`. */
  readonly inner: Plan;
  /** `not(...)`-wrapped: the constraint must NOT hold. */
  readonly negated: boolean;
};

/** Identity for graph elements (by id), strict equality otherwise. */
/**
 * A plan from a step slice, with `readsPath` recomputed over those steps (item 1504).
 *
 * ⚠️ IT MUST BE RECOMPUTED, NOT INHERITED. A `match` pattern's inner plan is a SLICE of a larger
 * step list, so the enclosing plan's flag describes a different set of steps — carrying it over
 * would be wrong in the unsafe direction for a slice that dropped the path-reading step, and
 * needlessly pessimistic for one that kept it. `stepReadsPath` reads each step's nested plans by
 * their own flags, so this is one pass over the slice and no recursion.
 */
const planOfSteps = (steps: readonly Step[]): Plan => ({
  steps,
  readsPath: steps.some(stepReadsPath),
  kinds: maskOfSteps(steps),
  mayFault: anyMayFault(steps),
  // Items 1647/1648's cache slots, present from birth so every plan has one hidden class.
  [EFF_PREFIX]: undefined,
  [EFF_CHECKED]: undefined,
});

const sameValue = (a: unknown, b: unknown): boolean => {
  if ((isVertex(a) || isEdge(a)) && (isVertex(b) || isEdge(b))) {
    return a.id === b.id;
  }

  return a === b;
};

/** Lower one pattern plan into a {@link Pattern}. */
const parsePattern = (plan: Plan): Pattern => {
  const { steps } = plan;
  const [first] = steps;

  // `not(inner)` / `where(inner)` filter wrappers: parse the inner pattern and
  // flip negation (where keeps it positive). These don't bind new labels.
  if (
    steps.length === 1 &&
    first &&
    (first.kind === 'not' || (first.kind === 'where' && 'plan' in first))
  ) {
    const inner = parsePattern((first as Extract<Step, { kind: 'not' }>).plan);

    return { ...inner, negated: first.kind === 'not' ? !inner.negated : inner.negated };
  }

  if (first?.kind !== 'as') {
    throw new LenkeError('a match() pattern must begin with as(label)', {
      code: ErrorCode.Syntax,
    });
  }

  const startKey = first.label;
  const last = steps[steps.length - 1];

  if (steps.length >= 2 && last.kind === 'as') {
    return { startKey, endKey: last.label, inner: planOfSteps(steps.slice(1, -1)), negated: false };
  }

  return { startKey, inner: planOfSteps(steps.slice(1)), negated: false };
};

/**
 * The label that seeds the join: a pattern *start* that is never a binding
 * *end* (a source). The incoming traverser's value binds here. Falls back to the
 * first pattern's start when every start is also an end (a fully-cyclic match).
 */
const computeStartLabel = (patterns: readonly Pattern[]): string => {
  const ends = new Set<string>();

  for (const p of patterns) {
    if (!p.negated && p.endKey !== undefined) {
      ends.add(p.endKey);
    }
  }

  for (const p of patterns) {
    if (!ends.has(p.startKey)) {
      return p.startKey;
    }
  }

  return patterns[0].startKey;
};

/** A traverser identical to `t` but with `value` reset to a label's bound value. */
const fromBinding = (t: Traverser<unknown>, value: unknown): Traverser<unknown> => ({
  value,
  path: t.path,
  loopCount: t.loopCount,
  tags: t.tags,
});

/**
 * What one pattern does to the current branch. ⚠️ THIS IS A DESCRIPTOR, NOT A TRAVERSER LIST, and
 * that is the whole of item 1559's 5.3x.
 *
 * `applyPattern` used to return the bound traversers, built by a `bind` helper that did
 * `new Map(t.tags)` per branch. The solver is a depth-first join, so that is an O(bindings) copy at
 * every node of the DFS — and an ablation that simply skipped the copy (wrong answers, ceiling only)
 * took `matched` from 14781 to 2604 ms. **82% of the shape was copying the tag map.**
 *
 * So the solver now carries ONE mutable map down the DFS and undoes each binding on the way out.
 * Returning a descriptor is what lets it: the binding is applied by `solve`, around the recursion,
 * rather than baked into a traverser the caller has to copy to build.
 *
 * Two ablations that did NOT pay, recorded so they are not re-attempted:
 *
 *   * `new Set(done).add(idx)` per DFS node, replaced by a shared mutable set — **flat** (15386 /
 *     14940 / 15162 against a 14781 baseline). The `done` set copy is not a cost; only the TAG map
 *     copy is, because `done` holds one small int per pattern while the tags hold boxed values.
 *   * `{ ...t, tags }` replaced by an explicit `{ value, path, loopCount, tags }` literal —
 *     **WORSE**, 15858 / 17275 / 15885. The spread is not the problem and hand-writing the literal
 *     loses whatever shape the spread was preserving.
 */
type PatternOutcome =
  | { readonly kind: 'drop' }
  | { readonly kind: 'keep' }
  | { readonly kind: 'bind'; readonly key: string; readonly values: readonly unknown[] };

/** Shared singletons: the two non-binding outcomes carry no data, so they allocate nothing. */
const DROP: PatternOutcome = { kind: 'drop' };
const KEEP: PatternOutcome = { kind: 'keep' };

/**
 * Apply one pattern to a traverser, returning the consistent continuations
 * (zero or more). A binding pattern branches per distinct candidate; a filter
 * or already-bound end keeps `t` once iff the constraint holds; a negated
 * pattern keeps `t` iff the constraint does NOT hold.
 */
/**
 * ONE SINGLE-TYPE DIRECTED HOP, as the `[type, forward]` pair, or `undefined` for every other inner
 * plan (item 1627).
 *
 * ⚠️ WHY `applyPattern` WANTS THIS. `match()` expands each pattern by running its inner plan through
 * `applyPlanToStream`, which for a hop means the generic `out` step and therefore the generator
 * chain `hop-values.ts` exists to avoid — its header prices that chain at **375.6 ms against a hand
 * walk's 251, 1.50x**, and items 1614/1617 removed it from the fused walks. A profile of the
 * two-pattern join at 20,000 x 5 puts the chain at **37.7%**:
 *
 * ```text
 *    solve            23.2%     iterLabeled      11.8%
 *    applyPattern     19.7%     iterByLabel       4.1%
 *    otherEndpoint    15.4%     outEdgesOf        2.6%
 *                              traverseToVertex  3.8%
 * ```
 *
 * `matched2` is **351 ms a rep** — 702 ns a solution against the fused two-hop walk's ~50 — and it
 * is the largest shape in the Gremlin probe by an order of magnitude.
 *
 * ⚠️ IT REFUSES EVERYTHING ELSE, which is what keeps this safe. `both` reaches a vertex from either
 * side, a multi-type hop needs `expand`'s cross-bucket dedupe, and any longer inner plan is an
 * arbitrary traversal — all of them keep `applyPlanToStream` exactly as they are today. The same
 * narrow admission `hopValuesShortcut` and `directedBucket` make, for the same reason.
 */
const soleHop = (inner: Plan): readonly [string, boolean] | undefined => {
  if (inner.steps.length !== 1) {
    return undefined;
  }

  const [step] = inner.steps;

  if (step.kind !== 'out' && step.kind !== 'in') {
    return undefined;
  }

  return step.labels.length === 1 ? [step.labels[0], step.kind === 'out'] : undefined;
};

/**
 * The far endpoints of one single-type hop from `from`, straight off the adjacency bucket.
 *
 * ⚠️ NOT A GENERATOR, AND ITEM 1622 IS WHY. That item replaced one generator layer with another and
 * measured 1.006x — the per-edge allocation went away and the per-edge RESUME did not. Returning a
 * plain object whose `[Symbol.iterator]` closes over the bucket's own iterator means the caller's
 * `for...of` advances a native Set iterator with one endpoint read per step.
 */
const bucketEnds = (
  from: unknown,
  type: string,
  forward: boolean,
): Iterable<unknown> | undefined => {
  /**
   * ⚠️ A FALLBACK, NOT A GUARD — and REDUNDANT, which the mutant proves rather than the reasoning
   * doing so: removing it SURVIVED. A non-vertex has no `adjFrom`/`adjTo`, so `?.get` yields
   * `undefined` and the walk is empty either way; and the general path is lenient for exactly the
   * same values (`traverseToVertex` yields nothing for a non-vertex rather than throwing), so both
   * arms answer nothing. An EDGE is the realistic case that reaches here — it has `from`/`to` and no
   * adjacency — and it is pinned at 0 both ways.
   *
   * Kept because the two arms agreeing is a property of `traverseToVertex` being lenient, which is
   * documented in `optional-hop.ts` and could reasonably change; item 475's rule is that a survivor
   * on a new guard means "redundant" as readily as "untested", and the two have opposite fixes.
   */
  if (!isVertex(from)) {
    return undefined;
  }

  // ⚠️ `soleTypeBucket` IS THE SHARED PRIMITIVE (item 1628): `movement.ts` owns the "one bucket for a
  // directed single type" rule, and `optionalHopStep` reads it too. Item 1627 had this inline; a
  // second copy of the box choice is how the two would drift on `both` or a multi-type hop.
  const direct = soleTypeBucket(from, forward ? 'out' : 'in', [type]);
  const bucket = direct?.set;

  return {
    [Symbol.iterator]: (): Iterator<unknown> => {
      if (bucket === undefined) {
        return EMPTY_ITER;
      }

      const it = bucket[Symbol.iterator]();

      return {
        next: (): IteratorResult<unknown> => {
          const step = it.next();

          return step.done === true
            ? { done: true, value: undefined }
            : { done: false, value: forward ? step.value.to : step.value.from };
        },
      };
    },
  };
};

const EMPTY_ITER: Iterator<unknown> = { next: () => ({ done: true, value: undefined }) };

const applyPattern = (
  p: Pattern,
  t: Traverser<unknown>,
  graph: Graph,
  ctx: RunContext,
): PatternOutcome => {
  const start = recallTag(t.tags, p.startKey, 'last');

  if (!start.ok) {
    return DROP;
  }

  /**
   * ⚠️ THE BRANCHES BELOW READ VALUES, NOT TRAVERSERS, and that is the whole shape of this change.
   * Each of the four already used only `o.value`, so taking an `Iterable<unknown>` lets the fast arm
   * hand them the bucket's endpoints directly while the general arm maps the traverser stream —
   * one definition of each branch, no duplication, and nothing about the solver's logic moved.
   */
  const hop = soleHop(p.inner);
  const fast = hop === undefined ? undefined : bucketEnds(start.value, hop[0], hop[1]);
  const out: Iterable<unknown> =
    // ⚠️ `unwrap` IS ALREADY THIS, in `runtime.ts` — a traverser stream as plain values. My first
    // version added a local `valuesOf` doing the identical thing, which is the duplication this
    // executor keeps paying for; asked rather than rewritten.
    fast ?? unwrap(applyPlanToStream(p.inner, [fromBinding(t, start.value)], graph, ctx));

  const boundEnd = p.endKey !== undefined ? recallTag(t.tags, p.endKey, 'last') : undefined;

  if (p.negated) {
    // The inner constraint is satisfiable when some output matches the bound
    // end (or, if the end is unbound/absent, when any output exists at all).
    let satisfiable = false;

    for (const v of out) {
      if (boundEnd?.ok ? sameValue(v, boundEnd.value) : true) {
        satisfiable = true;
        break;
      }
    }

    return satisfiable ? DROP : KEEP;
  }

  if (p.endKey === undefined) {
    return hasAny(out) ? KEEP : DROP; // pure filter on start
  }

  if (boundEnd?.ok) {
    for (const v of out) {
      if (sameValue(v, boundEnd.value)) {
        return KEEP; // end already bound and consistent
      }
    }

    return DROP;
  }

  // The end label's distinct candidate values. `solve` binds each one in turn.
  const seen = new Set<string>();
  const values: unknown[] = [];

  for (const v of out) {
    const k = tupleKey([v]);

    if (seen.has(k)) {
      continue;
    }

    seen.add(k);
    values.push(v);
  }

  return values.length === 0 ? DROP : { kind: 'bind', key: p.endKey, values };
};

/** Pick a not-yet-applied pattern whose start is bound, preferring binders. */
const pickRunnable = (
  patterns: readonly Pattern[],
  done: ReadonlySet<number>,
  t: Traverser<unknown>,
): number => {
  let negatedIdx = -1;

  for (let i = 0; i < patterns.length; i++) {
    if (done.has(i) || !t.tags.has(patterns[i].startKey)) {
      continue;
    }

    if (!patterns[i].negated) {
      return i; // run binders/filters before negated constraints
    }

    if (negatedIdx === -1) {
      negatedIdx = i;
    }
  }

  return negatedIdx;
};

export const matchStep = function* (
  stream: Iterable<Traverser<unknown>>,
  patternPlans: readonly Plan[],
  graph: Graph,
  ctx: RunContext,
  /**
   * Can anything downstream read the emitted traversers' tags? Defaults to `true`, so every caller
   * that has not thought about it stays correct and merely unoptimized — the same default-safe
   * direction as `RunContext.tracksPath`. `applyPlanToStream` computes it from this step's own
   * suffix via `tagsObservedFrom`.
   */
  tagsObserved = true,
): Iterable<Traverser<unknown>> {
  const patterns = patternPlans.map(parsePattern);
  const startLabel = computeStartLabel(patterns);

  /**
   * One mutable tag map travels the whole depth-first search; `tags` and `t.tags` are the SAME
   * object, passed separately only because `Traverser.tags` is a `ReadonlyMap` and this needs to
   * write to it without casting at every site.
   */
  const solve = function* (
    t: Traverser<unknown>,
    done: ReadonlySet<number>,
    tags: Map<string, readonly unknown[]>,
  ): Iterable<Traverser<unknown>> {
    if (done.size === patterns.length) {
      // Emit the binding map as the value (TinkerPop-faithful); tags carry the
      // bindings for any following select(...).
      const bindings = new Map<string, unknown>();

      for (const [label, values] of tags) {
        bindings.set(label, values[values.length - 1]);
      }

      // ⚠️ THE SNAPSHOT IS THE WHOLE COST, AND IT IS OFTEN DEAD. `extend` propagates `tags` BY
      // REFERENCE, so an emitted traverser would otherwise share the map the search keeps
      // rewriting and a later `select(...)` would read whatever state the solver had reached. But
      // when nothing downstream can read tags — `match(…).count()` is the common case — the copy
      // is pure waste, and it is 82% of the shape (item 1559 measured the ceiling by simply
      // deleting it: 14781 -> 2604 ms). `tagsObserved` is the plan's answer, default `true`.
      //
      // ⚠️ Deferring the copy here WITHOUT the skip is worth NOTHING, measured flat on three
      // shapes at item 1559: the old code copied once per BIND and this copies once per SOLUTION,
      // and in a branching search the leaves outnumber the internal nodes. The refactor is the
      // PREREQUISITE for the skip, not a win of its own — do not re-derive it as one.
      yield tagsObserved ? extend({ ...t, tags: new Map(tags) }, bindings) : extend(t, bindings);

      return;
    }

    const idx = pickRunnable(patterns, done, t);

    if (idx === -1) {
      return; // no runnable pattern: this branch is stuck, drop it
    }

    const outcome = applyPattern(patterns[idx], t, graph, ctx);

    if (outcome.kind === 'drop') {
      return;
    }

    const next = new Set(done).add(idx);

    if (outcome.kind === 'keep') {
      yield* solve(t, next, tags);

      return;
    }

    // Bind each candidate in turn and UNDO on the way out, so sibling branches never see each
    // other's binding. `match()` binds a label once, so there is nothing to restore in practice —
    // but `pickRunnable` only requires the START label to be bound, so a pattern CAN be reached
    // with its end label already set; the saved value keeps that case honest rather than assuming.
    const had = tags.has(outcome.key);
    const prev = tags.get(outcome.key);

    for (const value of outcome.values) {
      tags.set(outcome.key, [value]);

      yield* solve(t, next, tags);
    }

    if (had) {
      tags.set(outcome.key, prev as readonly unknown[]);
    } else {
      tags.delete(outcome.key);
    }
  };

  for (const t of stream) {
    // ONE copy per incoming traverser: the caller's map belongs to the caller, and everything below
    // mutates. Seed the source label from the incoming value (unless already bound).
    const work = new Map<string, readonly unknown[]>(t.tags);

    if (!work.has(startLabel)) {
      work.set(startLabel, [t.value]);
    }

    yield* solve({ ...t, tags: work }, new Set(), work);
  }
};
