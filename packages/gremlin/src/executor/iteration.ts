import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Plan, Step } from '../ast.js';
import { applyPlanToStream } from './dispatch.js';
import { soleTypeBucket } from './movement.js';
import { optionalSingleHop } from './optional-hop.js';
import {
  extend,
  hasAny,
  incLoops,
  isEmptyPlan,
  isVertex,
  type RunContext,
  type Traverser,
  tupleKey,
} from './runtime.js';

/**
 * Per-`repeat()` cap on the total traversers its body produces. A
 * `repeat(both())` with no `until`/`times` on a cyclic or dense graph grows the
 * frontier multiplicatively each level (bounded only by the 100-iteration cap,
 * which bounds depth, not work), so it can exhaust memory long before it stops.
 * Past this budget we raise `ResourceExhausted` rather than hang/OOM.
 */
const REPEAT_BUDGET = 1_000_000;

export const unionStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // union() runs each branch over the WHOLE incoming stream and concatenates the results
  // arm-by-arm — NOT per element. A reducing barrier in an arm (`count()`, `limit(1)`,
  // `fold()`) therefore reduces the whole stream: `V().union(limit(1), count())` yields one
  // vertex then the total count, matching TinkerPop and the native branch. (coalesce/choose/
  // optional below stay PER-ELEMENT — they route each traverser individually.)
  const all = [...stream];

  for (const plan of plans) {
    yield* applyPlanToStream(plan, all, graph, ctx);
  }
};

/**
 * `coalesce`'s FIRST arm, when it is a single vertex step — the fused half (item 1629).
 *
 * ⚠️ WHY ONLY THE FIRST. `coalesce` emits the output of the first arm that produces anything, so
 * only arm 0 runs for every incoming traverser; the rest run just for the rows arm 0 missed. On the
 * shape that matters — `coalesce(out(T), identity())`, the "hop or keep what you had" spelling — arm
 * 0 succeeds for every vertex with an out-edge, so fusing it reaches almost every row while fusing
 * the others would reach almost none.
 *
 * Item 1480 measured `V().coalesce(out(T), identity()).values(k)` at **20.2x** the unwrapped hop
 * (item 1628 re-measured it at 12.4x) and identified the cause: the sub-plan runs the generic
 * traverser pipeline, and the fused walks are source-anchored so they structurally cannot reach it.
 * `optionalSingleHop` + `soleTypeBucket` are the composable form items 1627/1628 built.
 *
 * ⚠️ `plans[0]` IS LOAD-BEARING AND WAS NOT TESTED UNTIL THE MUTANT SAID SO. Reading the LAST arm
 * instead survived the whole file, because in every shape there the last arm is `identity()`, which
 * this refuses — so the fast arm never engaged and the two readings agreed. The separating shape has
 * a first arm the fusion refuses and a last arm it would accept
 * (`coalesce(out(E).out(E), out(F))`), where the mutant runs arm 1's hop as if it were arm 0 and the
 * two-hop arm never runs. Pinned now.
 */
const coalesceFirstHop = (
  plans: readonly Plan[],
): { kind: 'out' | 'in' | 'both'; labels: readonly string[] } | undefined =>
  plans.length === 0 ? undefined : optionalSingleHop(plans[0]);

export const coalesceStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const firstHop = coalesceFirstHop(plans);

  for (const t of stream) {
    /**
     * ⚠️ THE FAST ARM IS LAZY WHERE THE GENERAL LOOP IS EAGER, and that is safe for THIS shape only
     * — `optional-hop.ts`'s argument, which applies verbatim. The eager `[...]` below means the
     * whole arm runs before any row is yielded, so making it lazy reorders side effects relative to
     * downstream consumption; item 1480 declined exactly that for the general case and
     * `sideeffect-in-branch.test.ts` exists because the interaction matters. A single vertex step
     * has no side effects, so for this shape the two orders are indistinguishable.
     *
     * ⚠️ AND AN EMPTY BUCKET FALLS THROUGH TO THE REMAINING ARMS, NOT TO ALL OF THEM. Re-running arm
     * 0 would be answer-equivalent and wasteful; `plans.slice(1)` is what the general loop does after
     * arm 0 produces nothing. The `from` index is the whole correctness question in this branch.
     */
    /**
     * ⚠️ `isVertex` IS A FALLBACK AND IT IS REDUNDANT — the mutant removing it SURVIVED, correctly. A
     * non-vertex has no `adjFrom`/`adjTo`, so the bucket is empty and the fast arm falls through to
     * arm 1; and arm 0 IS that hop, which yields nothing for a non-vertex on the general path too
     * (`traverseToVertex` is lenient). Kept because that agreement rests on `traverseToVertex` being
     * lenient — documented in `optional-hop.ts` and able to change — and item 475's rule is that
     * "redundant" and "untested" have opposite fixes.
     */
    const direct =
      firstHop === undefined || !isVertex(t.value)
        ? undefined
        : soleTypeBucket(t.value, firstHop.kind, firstHop.labels);
    let from = 0;

    if (direct !== undefined) {
      const { set, forward } = direct;
      let any = false;

      for (const e of set) {
        any = true;

        yield extend(t, forward ? e.to : e.from);
      }

      if (any) {
        continue; // arm 0 produced output — `coalesce` takes the first that does
      }

      from = 1; // arm 0 was empty; the general loop would move on to arm 1
    }

    for (let i = from; i < plans.length; i++) {
      const out = [...applyPlanToStream(plans[i], [t], graph, ctx)];

      if (out.length > 0) {
        yield* out;
        break;
      }
    }
  }
};

export const optionalStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const out = [...applyPlanToStream(plan, [t], graph, ctx)];

    if (out.length > 0) {
      yield* out;
    } else {
      yield t;
    }
  }
};

export const chooseStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  thenPlan: Plan,
  elsePlan: Plan | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const branch = hasAny(applyPlanToStream(test, [t], graph, ctx)) ? thenPlan : elsePlan;

    if (branch) {
      yield* applyPlanToStream(branch, [t], graph, ctx);
    } else {
      // Per TinkerPop spec: if test fails and no elsePlan, traverser passes
      // through unchanged (identity behavior).
      yield t;
    }
  }
};

// --- Repeat -------------------------------------------------------------

export const repeatStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'repeat' }>,
  graph: Graph,
  // The enclosing run's context — threaded into the body (and until/emit)
  // sub-plans so a side-effect step inside the loop (`subgraph`/`store`/
  // `aggregate`) writes to the OUTER side-effect scope a downstream `cap(key)`
  // reads. Without it the body ran in a fresh context and its side-effects
  // silently vanished (a transitive-`subgraph` blast radius came back empty).
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // Cap iterations to `times` if given; else 100 to avoid runaway. `times(n)` is a plain
  // count here (a while-do bound), so `times(0)` runs ZERO iterations. This DELIBERATELY
  // differs from TinkerPop, where a `.times()` placed AFTER `repeat(...)` is do-while and
  // `repeat(out()).times(0)` runs ONE iteration (a well-known TinkerPop surprise). lenke
  // keeps the intuitive count semantics; only `times(0)` observes the difference (`times`
  // ≥ 1 agree). Both lenke engines match each other.
  const maxIterations = step.times ?? 100;
  // `until(plan)` empty means "no until" — let `times` be the only stopper.
  // `emit(plan)` empty means "emit every traverser at every level".
  const hasUntil = step.until !== undefined && !isEmptyPlan(step.until);
  const hasEmit = step.emit !== undefined;
  const emitAll = hasEmit && step.emit !== undefined && isEmptyPlan(step.emit);
  const emitBefore = step.emitBefore === true;

  const matchesEmit = (t: Traverser<unknown>): boolean => {
    if (emitAll) {
      return true;
    }

    return hasAny(applyPlanToStream(step.emit!, [t], graph, ctx));
  };

  // `until` placement (TinkerPop): pre-form `until(cond).repeat(body)` checks
  // BEFORE the body (while-do — a satisfier never enters the body); the default
  // post-form `repeat(body).until(cond)` checks AFTER the body (do-while — the
  // body runs at least once). Distinguished by the AST `untilBefore` flag.
  const untilBefore = hasUntil && step.untilBefore === true;
  const untilAfter = hasUntil && !untilBefore;
  const untilMatches = (t: Traverser<unknown>): boolean =>
    hasAny(applyPlanToStream(step.until!, [t], graph, ctx));

  let frontier: Traverser<unknown>[] = [...stream].map(incLoops);
  let work = 0;

  for (let i = 0; i < maxIterations && frontier.length > 0; i++) {
    // Pre-form emit (TinkerPop's `emit(...).repeat(body)`): emit before each
    // body application, including the input traverser at level 0.
    if (hasEmit && emitBefore) {
      for (const t of frontier) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }

    // while-do: check `until` BEFORE the body — a satisfier exits without ever
    // running the body.
    let advancing = frontier;

    if (untilBefore) {
      advancing = [];

      for (const t of frontier) {
        if (untilMatches(t)) {
          yield t;
        } else {
          advancing.push(t);
        }
      }
    }

    // Advance the frontier through the body (in the ENCLOSING ctx, so
    // side-effects inside the body reach the outer scope).
    const stepped: Traverser<unknown>[] = [];

    for (const t of applyPlanToStream(step.body, advancing, graph, ctx)) {
      work += 1;

      if (work > REPEAT_BUDGET) {
        throw new LenkeError(
          'repeat() exceeded the traversal budget; add a tighter until()/times()',
          { code: ErrorCode.ResourceExhausted },
        );
      }

      stepped.push(incLoops(t));
    }

    // Post-form emit (TinkerPop's default `repeat(body).emit(...)`): emit every
    // body output. The final iteration's output is emitted here, so with an
    // until stopper no additional post-loop yield is needed.
    if (hasEmit && !emitBefore) {
      for (const t of stepped) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }

    // do-while: check `until` AFTER the body — a satisfier exits; the rest loop.
    if (untilAfter) {
      const cont: Traverser<unknown>[] = [];

      for (const t of stepped) {
        if (untilMatches(t)) {
          yield t;
        } else {
          cont.push(t);
        }
      }

      frontier = cont;
    } else {
      frontier = stepped;
    }
  }

  // Post-loop yield rules:
  //   - With `until()` (either placement): traversers exit via the until-yield
  //     above; nothing more.
  //   - With post-form emit: every body output was already emitted; nothing more.
  //   - With pre-form emit: pre-emit caught input + intermediates, but the
  //     final body output never had a "next iteration" to be pre-emitted, so
  //     yield it here.
  //   - With no emit: yield the final frontier (the natural repeat result).
  if (!hasUntil && (!hasEmit || emitBefore)) {
    yield* frontier;
  }
};

// `local` runs the sub-plan against each traverser independently, so steps
// like `count()` or `fold()` operate per-traverser instead of over the whole
// stream.
export const localStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield* applyPlanToStream(plan, [t], graph, ctx);
  }
};

// `branch(test).option(v, plan)...none(plan)` — per traverser, run the test
// plan, take its first result, and route to the matching option's plan
// (deep-equality on `match`), else `default` if present.
export const branchStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  options: readonly { match: unknown; plan: Plan }[],
  defaultPlan: Plan | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // Match option keys by VALUE, not identity — TinkerPop keys `.option()` through a
  // Map (Java `.equals`), so a list/map/temporal pick token matches a structurally-equal
  // option key even though it is a distinct object. `tupleKey` is the same value-keying
  // dedup/group use (sorted-key maps, one numeric type), so equal values share a key.
  // Precomputed once per branch, not per traverser.
  const optionKeys = options.map((opt) => tupleKey([opt.match]));

  for (const t of stream) {
    let testResult: unknown = undefined;
    let sawResult = false;

    for (const r of applyPlanToStream(test, [t], graph, ctx)) {
      testResult = r.value;
      sawResult = true;
      break;
    }

    let matched: Plan | undefined;

    if (sawResult) {
      const key = tupleKey([testResult]);
      const i = optionKeys.indexOf(key);

      if (i !== -1) {
        matched = options[i].plan;
      }
    }

    const target = matched ?? defaultPlan;

    if (target) {
      yield* applyPlanToStream(target, [t], graph, ctx);
    }
  }
};
