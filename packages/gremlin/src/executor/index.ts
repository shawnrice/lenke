// Public API of the gremlin executor.
//
// `run(plan, graph)` is the primary entry point — runs a plan and yields the
// final traverser values. `toArray` and `toSet` are eager terminals.
//
// Implementation lives in sibling files: `runtime.ts` for shared types
// and helpers, `dispatch.ts` for the kind-routing switch + recursive
// `applyPlanToStream`, and per-category files (`movement.ts`, `filters.ts`,
// `aggregation.ts`, etc.) for the step-impl generators.

import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Plan, Step } from '../ast.js';
import { countShortcut } from './count-shortcut.js';
import { applyStep } from './dispatch.js';
import { hopValuesShortcut } from './hop-values.js';
import { seedFromIndex, tailIsOrderFree } from './index-seed.js';
import { groupCountShortcut } from './projection.js';
import { newContext, planReadsPath, startTraverser, type Traverser, unwrap } from './runtime.js';
import { applySource } from './sources.js';

/**
 * Fault on a plan that is invalid whatever the data.
 *
 * `path().id()` cannot succeed on any graph: a path is not an Element, so it has
 * no id and no label. TinkerPop types `IdStep<S extends Element>` and does
 * `traverser.get().id()`, which on a path is a bare `ClassCastException` once
 * the generic is erased ("ImmutablePath cannot be cast to ...Element"). Both
 * engines used to return null instead — agreeing with each other, and with
 * nothing else.
 *
 * Checked on the STEP LIST rather than per traverser, so it costs one scan and
 * no walk. That is also what makes it expressible here at all: at RUNTIME a path
 * is a plain array, indistinguishable from what `fold()` produces, but the
 * `path` STEP is not.
 *
 * `DataException` — an ISO data exception covers "a type mismatch in an
 * operation", which is what this is. Not a syntax error: the traversal parses
 * fine. Not `InvalidValue`: that means a value outside the LPG property-value
 * model, and a path is a perfectly good value that simply has no id. The Rust
 * engine raises the same code from the same check.
 *
 * Only through steps that pass the traverser's value on UNCHANGED — `unfold()`
 * turns a path into its elements, and `id()` on those is fine, so a scan that
 * merely looked for a later `id()` would reject working traversals.
 */
/**
 * Fault, statically, on an aggregate/sort/vertex-move applied to the WRONG frontier
 * KIND — mirroring the native engine, whose parser rejects these at parse time.
 *
 * The engine is a static planner (it faults at parse); pure-TS is a streaming executor
 * that would otherwise fault only at RUNTIME when a bad value flows through — so the two
 * diverge on an EMPTY frontier (`g.V().out('NOPE').sum()` never sees a vertex, so a
 * runtime check gives null while the engine still faults). This pass restores symmetry by
 * classifying the frontier kind from the step chain (exactly what the engine's parser
 * does) and faulting up front, regardless of data:
 *
 *  - `sum`/`min`/`max`/`mean` (global) and a bare `order()` / direction-only `order().by(desc)`
 *    over a graph ELEMENT (vertex/edge): a Vertex/Edge is not a number and has no natural
 *    order — TinkerPop faults; project with `values('<key>')` / `order().by('<key>')`.
 *  - `inV`/`outV`/`bothV`/`otherV` on a NON-edge frontier: these move to an edge's endpoint,
 *    so they require an edge traverser (`g.V().otherV()` is invalid; use `outE().otherV()`).
 *
 * Conservative: the frontier is only 'vertex'/'edge'/'scalar' when KNOWN; branch/collection/
 * map producers reset it to 'unknown', where nothing faults — a missed fault is safe, a false
 * one would break a valid query. Code is `E_SYNTAX`, matching the engine's parse-time fault.
 */
type Frontier = 'vertex' | 'edge' | 'scalar' | 'path' | 'unknown';

// path()/tree() produce a Path/Tree — not an Element. An element step applied to one throws
// in TinkerPop (an ImmutablePath is not a Vertex/Edge), verified against gremlin-console:
// `path().out()`, `path().values('x')`, `path().sum()` all ClassCastException. `unfold()`
// turns the path into its elements and `count`/`fold`/`limit`/`order`/… consume/preserve it.
const PATH_PRODUCERS = new Set(['path', 'tree']);
const PATH_INCOMPATIBLE = new Set([
  'out',
  'in',
  'both',
  'outE',
  'inE',
  'bothE',
  'inV',
  'outV',
  'bothV',
  'otherV',
  'values',
  'value',
  'valueMap',
  'propertyMap',
  'properties',
  'property',
  'key',
  'id',
  'label',
  'has',
  'hasNot',
  'hasLabel',
  'hasId',
  'hasKey',
  'hasValue',
  'sum',
  'min',
  'max',
  'mean',
]);

const VERTEX_STEPS = new Set(['V', 'out', 'in', 'both', 'inV', 'outV', 'bothV', 'otherV', 'addV']);
const EDGE_STEPS = new Set(['E', 'outE', 'inE', 'bothE', 'addE']);
const SCALAR_STEPS = new Set([
  'values',
  'value',
  'id',
  'label',
  'count',
  'sum',
  'min',
  'max',
  'mean',
  'math',
  'loops',
  // inject() prepends literal values (strings/numbers) to the stream, so the frontier is
  // no longer purely elements — a following navigation/projection faults, exactly as native
  // rejects `inject('x').outV()` and TinkerPop throws (the literal is not an element).
  'inject',
]);

// Element-type algebra (rejected statically, matching native's parse-time rejection and
// TinkerPop's runtime ClassCastException — verified against gremlin-console):
//  - out/in/both (adjacency) + outE/inE/bothE (edge hops) navigate FROM a vertex.
//  - inV/outV/bothV/otherV (endpoints) move to an edge's endpoint, so need an edge.
//  - values/value/id/label/properties/… read off an ELEMENT.
// count/fold/sum/… are stream reducers, valid on ANY frontier (`V().count().count()` → [1]).
const ADJ_OR_HOP = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const PROJECTION = new Set([
  'values',
  'value',
  'id',
  'label',
  'properties',
  'propertyMap',
  'valueMap',
  'elementMap',
  'key',
]);
// Frontier-PRESERVING filters / barriers / side-effects / writes-that-pass-through.
const PRESERVE_STEPS = new Set([
  'has',
  'hasLabel',
  'hasId',
  'hasKey',
  'hasNot',
  'hasValue',
  'hasLabelAnd',
  'where',
  'and',
  'or',
  'not',
  'is',
  'dedupe',
  'take',
  'skip',
  'range',
  'tail',
  'order',
  'as',
  'simplePath',
  'cyclicPath',
  'aggregate',
  'store',
  'barrier',
  'sample',
  'sideEffect',
  'sideEffectFn',
  'filter',
  'filterFn',
  'identity',
  'none',
  'withSack',
  'drop',
  'property',
  'repeat',
]);

// Everything not classified (maps/collections/branches/OLAP/ambiguous) resets to 'unknown',
// where nothing faults — a missed fault is safe; a false positive would break a valid query.
const nextFrontier = (kind: Step['kind'], prev: Frontier): Frontier => {
  if (VERTEX_STEPS.has(kind)) {
    return 'vertex';
  }

  if (EDGE_STEPS.has(kind)) {
    return 'edge';
  }

  if (PATH_PRODUCERS.has(kind)) {
    return 'path';
  }

  if (SCALAR_STEPS.has(kind)) {
    return 'scalar';
  }

  return PRESERVE_STEPS.has(kind) ? prev : 'unknown';
};

const isElement = (f: Frontier): boolean => f === 'vertex' || f === 'edge';

// An optional()/branch body ALWAYS produces one output per element when it ends in an
// aggregate reducer (count/fold/sum/…, empty group → 0/[]/null) or is a bare id()/label()/
// path() projection — the identity fallback is then dead and the branch takes the body's
// frontier. (A leading hop can drop rows, so `out().id()` is NOT always-producing.)
const AGG_TERMINAL = new Set(['count', 'fold', 'sum', 'min', 'max', 'mean']);
const bodyAlwaysProduces = (steps: readonly Step[]): boolean => {
  if (steps.length === 0) {
    return false;
  }

  const last = steps[steps.length - 1].kind;

  if (AGG_TERMINAL.has(last)) {
    return true;
  }

  return steps.length === 1 && (last === 'id' || last === 'label' || last === 'path');
};

const EDGE_HOPS = new Set(['outE', 'inE', 'bothE']);

// Whether an EDGE is in scope for `inV`/`outV`/`otherV`, which move to an edge's endpoint
// and so require one. `true` = an edge is reachable, `false` = definitely none, `undefined`
// = unknown (a branch/collection producer — never fault). An edge step establishes it; a
// vertex step or vertex-move (out/inV/…) clears it (the edge, if any, was consumed reaching
// the vertex); a scalar projection (values/label/count) also CLEARS it — a scalar is not an
// edge, so `E().count().inV()` and `E().label().inV()` fault (TinkerPop throws), matching the
// frontier-based checks below. Preserving filters/barriers keep it.
type HasEdge = boolean | undefined;

const EDGE_SOURCE = new Set(['E', 'outE', 'inE', 'bothE', 'addE']);
const VERTEX_MOVE = new Set(['V', 'out', 'in', 'both', 'addV', 'inV', 'outV', 'bothV', 'otherV']);

const nextHasEdge = (kind: Step['kind'], prev: HasEdge): HasEdge => {
  if (EDGE_SOURCE.has(kind)) {
    return true;
  }

  if (VERTEX_MOVE.has(kind)) {
    return false;
  }

  // A scalar producer clears the edge scope (a number/string/id is not an edge).
  if (SCALAR_STEPS.has(kind)) {
    return false;
  }

  return PRESERVE_STEPS.has(kind) ? prev : undefined;
};

// Combine the ending edge-scope of a branch's arms: any arm that DEFINITELY yields a
// non-edge (`false`) makes a following `inV`/`outV` faultable; all-edge arms keep it in
// scope; anything unknown stays unknown (conservative — never fault).
const combineHasEdge = (arms: readonly HasEdge[]): HasEdge => {
  if (arms.some((a) => a === false)) {
    return false;
  }

  if (arms.length > 0 && arms.every((a) => a === true)) {
    return true;
  }

  return undefined;
};

const checkStep = (step: Step, f: Frontier, hasEdge: HasEdge, edgeHasOrigin: boolean): void => {
  const k = step.kind;

  // An element step (navigation / projection / has-filter / numeric reduce) on a PATH
  // frontier — `path().out()`, `path().values('x')`, `path().sum()`, and the same inside or
  // after a branch (`path().union(…, out())`, `coalesce(…, path().out())`). TinkerPop throws
  // (a Path is not an Element) and the native engine rejects it at parse; fault to match.
  if (f === 'path' && PATH_INCOMPATIBLE.has(k)) {
    throw new LenkeError(
      `${k}() is not defined on a path — a path is not an element; unfold() it into its ` +
        `elements first`,
      { code: ErrorCode.Syntax },
    );
  }

  // Adjacency (out/in/both) and edge hops (outE/inE/bothE) navigate FROM a vertex. On a
  // KNOWN edge or scalar frontier the value is not a vertex, so TinkerPop throws and native
  // rejects — fault to match. `unknown` (a branch output that MIGHT be a vertex) never faults.
  if (ADJ_OR_HOP.has(k) && (f === 'edge' || f === 'scalar')) {
    throw new LenkeError(
      `${k}() moves from a vertex, but the frontier is ${f === 'edge' ? 'an edge' : 'a scalar'} — ` +
        `${f === 'edge' ? 'use an endpoint step (inV()/outV()/otherV())' : 'project to a vertex'} ` +
        `before ${k}()`,
      { code: ErrorCode.Syntax },
    );
  }

  // Projections (values/id/label/properties/…) read off an ELEMENT. On a scalar frontier
  // (`V().id().values('x')`, `E().count().label()`) there is no element — TinkerPop throws.
  if (PROJECTION.has(k) && f === 'scalar') {
    throw new LenkeError(
      `${k}() reads from a graph element, but the frontier is a projected scalar ` +
        `(values()/id()/label()/count()/inject()); it has no ${k === 'id' || k === 'label' ? k : 'properties'}`,
      { code: ErrorCode.Syntax },
    );
  }

  if (
    (k === 'sum' || k === 'min' || k === 'max' || k === 'mean') &&
    (step as { scope?: string }).scope !== 'local' &&
    isElement(f)
  ) {
    throw new LenkeError(
      `${k}() over graph elements is not supported — a vertex/edge is not a number; ` +
        `project with values('<key>') first`,
      { code: ErrorCode.Syntax },
    );
  }

  if (k === 'order' && isElement(f)) {
    const o = step as { key?: string; bys?: readonly { kind: string }[]; scope?: string };
    // Sorts the RAW element when there is no key projection and either no `by` or a
    // direction-only `by(desc)` (an `identity` By). A `by('<key>')`/`by(<traversal>)`/
    // `by(T.id)` projects a comparable value, so it is fine.
    const sortsRawElement =
      o.scope !== 'local' &&
      !o.key &&
      (!o.bys || o.bys.length === 0 || o.bys.some((b) => b.kind === 'identity'));

    if (sortsRawElement) {
      throw new LenkeError(
        `order() over graph elements is not supported — elements have no natural order; ` +
          `use order().by('<key>')`,
        { code: ErrorCode.Syntax },
      );
    }
  }

  // `inV`/`outV`/`bothV`/`otherV` move to an edge's endpoint, so they require an edge in
  // scope. Fault iff there is DEFINITELY none (`g.V().otherV()`, `g.V().values('x').inV()`);
  // an edge frontier or an edge-derived scalar (`E().label().inV()`) is valid, and an
  // unknown frontier (a branch that might yield edges) never faults. Matches the native
  // engine's parse-time rejection.
  if ((k === 'inV' || k === 'outV' || k === 'bothV' || k === 'otherV') && hasEdge === false) {
    throw new LenkeError(
      `${k}() requires an edge — a vertex has no incident edge to move across; ` +
        `use an edge step (outE()/inE()/bothE()) before ${k}()`,
      { code: ErrorCode.Syntax },
    );
  }

  // `otherV()` is "the endpoint I did NOT arrive from" — it reads the path's reference
  // vertex. Off a BARE edge frontier (`g.E().otherV()`) there is no prior vertex, so it
  // is undefined; TinkerPop throws and the native engine rejects it. `inV`/`outV`/`bothV`
  // name a specific endpoint and stay valid off a bare edge.
  if (k === 'otherV' && f === 'edge' && !edgeHasOrigin) {
    throw new LenkeError(
      `otherV() has no reference vertex off a bare edge frontier — it returns the endpoint ` +
        `not arrived from, but E() provides no origin; reach the edge via a vertex ` +
        `(outE()/inE()/bothE()) first`,
      { code: ErrorCode.Syntax },
    );
  }
};

// Recurse into a step list, tracking the frontier kind. A branch step's sub-traversals
// (union/coalesce arms, an optional/choose body, a choose condition) each START from the
// frontier at the branch — so `V().union(inV(), …)` faults on the vertex-move exactly as
// the native engine's parser does, not just at the top level.
const checkSteps = (
  steps: readonly Step[],
  start: Frontier,
  startHasEdge: HasEdge,
  startEdgeHasOrigin: boolean,
): { f: Frontier; hasEdge: HasEdge } => {
  let f = start;
  let hasEdge = startHasEdge;
  // Whether the current edge frontier was reached THROUGH a vertex (so the path holds a
  // reference vertex for `otherV()`). An edge hop (`outE`/…) sets it; a bare `E()` source
  // clears it. A branch arm inherits it from the frontier at the branch.
  let edgeHasOrigin = startEdgeHasOrigin;

  for (const step of steps) {
    checkStep(step, f, hasEdge, edgeHasOrigin);

    const k = step.kind;

    // A branch's arms each START from the frontier at the branch; the branch's OUTPUT
    // edge-scope is the combination of the arms' endings (so `V().union(outE(), out()).inV()`
    // faults — one arm yields a non-edge — exactly as the native parser rejects it).
    if (k === 'union' || k === 'coalesce') {
      const ends = (step as { plans: readonly Plan[] }).plans.map((p) =>
        checkSteps(p.steps, f, hasEdge, edgeHasOrigin),
      );

      f = 'unknown';
      hasEdge = combineHasEdge(ends.map((e) => e.hasEdge));

      continue;
    }

    if (k === 'optional') {
      // The output is the matched (body) traversers AND the unmatched (pre-body) ones,
      // so combine the body's ending edge-scope with the pre-body scope — UNLESS the body
      // ALWAYS produces (an aggregate reducer, or a bare id()/label()/path()), in which case
      // the identity fallback is dead and optional(<always>) ≡ <always>: the frontier is the
      // body's, matching the native engine (`optional(count()).values('x')` faults on the
      // scalar in both, not just native).
      const bodySteps = (step as { plan: Plan }).plan.steps;
      const body = checkSteps(bodySteps, f, hasEdge, edgeHasOrigin);

      if (bodyAlwaysProduces(bodySteps)) {
        ({ f, hasEdge } = body);
      } else {
        f = 'unknown';
        hasEdge = combineHasEdge([hasEdge, body.hasEdge]);
      }

      continue;
    }

    if (k === 'choose') {
      const c = step as { test: Plan; thenPlan: Plan; elsePlan?: Plan };
      checkSteps(c.test.steps, f, hasEdge, edgeHasOrigin);
      const thenEnd = checkSteps(c.thenPlan.steps, f, hasEdge, edgeHasOrigin);
      const elseEnd = c.elsePlan
        ? checkSteps(c.elsePlan.steps, f, hasEdge, edgeHasOrigin)
        : { f, hasEdge };

      f = 'unknown';
      hasEdge = combineHasEdge([thenEnd.hasEdge, elseEnd.hasEdge]);

      continue;
    }

    if (EDGE_HOPS.has(k)) {
      edgeHasOrigin = true;
    } else if (k === 'E') {
      edgeHasOrigin = false;
    }

    f = nextFrontier(k, f);
    hasEdge = nextHasEdge(k, hasEdge);
  }

  return { f, hasEdge };
};

const assertFrontierTypes = (plan: Plan): void => {
  checkSteps(plan.steps, 'unknown', false, false);
};

// Steps that PASS A PATH THROUGH unchanged — the scan keeps looking past them for an
// element step. (KINDS, not names — `limit()` builds a `take`, `dedup()` a `dedupe`.)
const PATH_PASSTHROUGH = new Set([
  'take',
  'skip',
  'range',
  'tail',
  'sample',
  'dedupe',
  'order',
  'barrier',
  'as',
  'identity',
  'simplePath',
  'cyclicPath',
]);

// Steps that require an ELEMENT (a vertex/edge). Applied straight to a PATH they throw in
// TinkerPop (`ImmutablePath cannot be cast to Element/Edge/Vertex`) — a path is not an
// element. Verified on gremlin-console: `path().values(...)`, `.hasLabel(...)`, `.inV()`,
// `.out(...)`, `.id()`/`.label()` all ClassCastException. `unfold()` (turns a path into
// its elements), `count`/`fold`/etc CONSUME the path and end the scan.
const ELEMENT_STEP_ON_PATH = new Set([
  'out',
  'in',
  'both',
  'outE',
  'inE',
  'bothE',
  'inV',
  'outV',
  'bothV',
  'otherV',
  'values',
  'value',
  'valueMap',
  'propertyMap',
  'properties',
  'property',
  'key',
  'id',
  'label',
  'has',
  'hasNot',
  'hasLabel',
  'hasId',
  'hasKey',
  'hasValue',
]);

/**
 * Drop a single-label `hasLabel(L)` that keeps EVERY element — the plan-level form of the
 * tautology short-circuit the native engine's `IsLabeled` evaluator has (item E78).
 *
 * WHY HERE, AND WHY IT MATTERS SO MUCH. Every shortcut in `run` matches a plan PREFIX that starts
 * at the source: `countShortcut` wants `V()` plus one or two steps, `hopValuesShortcut` wants
 * exactly `V().out(T).values(k)`, `groupCountShortcut` wants `V().groupCount()`. A leading
 * `hasLabel` is one step too many for all of them, so it does not merely cost its own
 * per-element test — it drops the whole query onto the traverser pipeline. Measured at 100,000
 * vertices / 500,000 edges, one case per process (item 540):
 *
 * ```text
 *   V().out('KNOWS').values('age')                         65.24 ms
 *   V().hasLabel('Person').out('KNOWS').values('age')     134.40      2.1x
 *   V().out('KNOWS').dedupe().count()                       3.39
 *   V().hasLabel('Person').out('KNOWS').dedupe().count()  102.63     30.3x
 * ```
 *
 * Every vertex carries `Person`, so each pair asks the SAME question. Item 538's index seed does
 * remove the step, but only AFTER the shortcuts have already declined — which is why removing it
 * from the plan FIRST is the fix rather than another arm per shortcut.
 *
 * SOUNDNESS. `hasLabel(L)` keeps an element iff it carries `L`, so when the label's bucket holds
 * every live element the step keeps everything and removing it changes no answer. The bucket
 * holds only live elements (`deIndexEdgeLabel` removes an emptied entry), and `vertexCount` /
 * `edgeCount` are the live counts — the same pair `buildNodeCount` uses for its unconstrained
 * answer. A MULTI-label `hasLabel` is not considered: it is already a union and a vacuous one
 * would need every element to carry at least one of the names, which is a different test for a
 * rarer shape.
 *
 * GATED ON `tracksPath`, like `hopValuesShortcut`: with `path()` in the plan a step's output is
 * recorded, so removing one could change what a path contains. Nothing here is worth that.
 *
 * An EMPTY graph is left alone (`count === 0` would make every label vacuous, which is true but
 * means the plan is empty anyway) so the rule reads as "the bucket IS the whole set" rather than
 * as an accident of zero.
 *
 * WHAT MUTATION SAYS ABOUT THESE CONDITIONS, recorded because five of six mutants survived and a
 * survivor nobody explains is indistinguishable from a missing test. Exactly ONE is load-bearing:
 *
 *   - `bucket.size === total` — CAUGHT, and loudly (15 failures): without it every label is
 *     dropped and the filters stop filtering.
 *   - the single-label restriction — survives, and is conservatism. If `labels[0]`'s bucket is
 *     the whole set then so is the UNION, so dropping a multi-label whose first name is vacuous
 *     is sound; if it is not, the size test declines anyway. Kept because "a vacuous union" is a
 *     different test and this one would read as if it had performed it.
 *   - the LEADING-run restriction (`cut`) — survives. A vacuous VERTEX label is in fact droppable
 *     after a hop too, because the hop's endpoints are a subset of the vertices and a label every
 *     vertex carries keeps all of them. Kept because the reasoning depends on the stream still
 *     holding vertices, which this function does not check.
 *   - the `tracksPath` gate — survives. A filter step appends nothing to a path in either engine,
 *     so removing one is invisible there. Kept as the cheaper assumption.
 *   - using the EDGE bucket for an `E()` source — survives, because the vertex map simply misses
 *     on an edge-type name and the step is kept. Correct by accident rather than by the lookup,
 *     so the branch stays.
 *   - skipping the empty graph — survives, since every query over one answers empty anyway.
 */
/**
 * `or(has(k, a), has(k, b), …)` as the single step `has(k, within(a, b, …))`, or `undefined`
 * (item 1312).
 *
 * ⚠️ THIS IS ONE OF THE FOUR CANONICAL INDEX-SEEDING BUGS CLAUDE.md NAMES BY EXAMPLE —
 * "`k = $a OR k = $b` vs `k IN [$a, $b]`" — and it is the cross-surface asymmetry this repo keeps
 * paying for: ISO-GQL has folded it since item 1269 (`membershipFromEqChain`) and the Gremlin
 * surface never did. A user picks one language, so the gap cost half of them, exactly as items
 * 1035/1038 then 1043/1044 did for their lever.
 *
 * Item 1305's probe measured the pair at 7.15x net of its null control: the `or` runs a sub-plan
 * per branch per element where the membership form is one step the filter rungs recognise.
 *
 * EVERY BRANCH must be exactly one `has` on the SAME key with an `eq` predicate. Each condition
 * refuses a real non-equivalence rather than an unusual spelling: a branch on a different key is a
 * disjunction across keys and not a membership; a non-`eq` predicate (`gt`, `within`, a regex) does
 * not reduce to a value list; and a branch of two steps is a conjunction inside the disjunction.
 *
 * Equivalence verified against the or-chain on a fixture covering the cases that usually break a
 * value list — `null`, `NaN`, `0` against `false` (no coercion), mixed string/number, a
 * single-value `or`, and under `count()`. All nine agreed, which also confirms `within` and `eq`
 * share one equality: `has(k, v)` routes a bare value through `eq()` itself, so the step's
 * predicate is always a predicate object and never a raw value.
 */
const membershipFromOrChain = (step: Step): Step | undefined => {
  if (step.kind !== 'or' || step.plans.length < 2) {
    return undefined;
  }

  let key: string | undefined;
  const values: unknown[] = [];

  for (const branch of step.plans) {
    if (branch.steps.length !== 1) {
      return undefined;
    }

    const [only] = branch.steps;

    if (only.kind !== 'has' || only.pred?.op !== 'eq') {
      return undefined;
    }

    const { key: branchKey, pred } = only;

    if (key === undefined) {
      key = branchKey;
    } else if (key !== branchKey) {
      return undefined;
    }

    values.push(pred.value);
  }

  return key === undefined ? undefined : { kind: 'has', key, pred: { op: 'within', values } };
};

/**
 * Steps that keep or drop an element and NEVER replace it, add to the path, or run a sub-plan.
 *
 * This is deliberately narrower than `PRESERVE_STEPS` above, which also admits `where`, `and`,
 * `or`, `not`, barriers and pass-through writes. Splicing is only sound for steps whose entire
 * effect is "keep this element or do not", because a spliced step operates on the OUTER traverser
 * rather than inside a sub-traversal.
 */
const PURE_ELEMENT_FILTERS = new Set<Step['kind']>([
  'has',
  'hasLabel',
  'hasLabelAnd',
  'hasId',
  'hasKey',
  'hasNot',
  'hasValue',
]);

/**
 * A wrapper branch's steps after the other two rewrites have been applied to them, or `null` when
 * what comes out is not filter-only.
 *
 * It also owns the EMPTY-BODY guard that `pureFilterSteps` used to carry (`plan.steps.length === 0`
 * declines). That guard's mutant survives and is kept anyway: `filter()` with no body faults at run
 * time so it is not a usable plan, and `and()` with no branches is declined by the separate
 * `parts.length > 0` test — but if the surface ever admits an empty body, splicing nothing would
 * silently DELETE the step.
 *
 * ⚠️ THIS EXISTS BECAUSE A COMMENT OF MINE WAS FALSE. The `or`-to-membership fold was added to the
 * same loop as the wrapper flattening, with a comment claiming that an `or` nested inside an `and`
 * would therefore fold too. It would not have: the `and` arm tested branch PURITY first, and an
 * `or` is not a pure element filter, so such a branch was rejected before anything folded. Its own
 * test said so. Composing the rewrites per branch here is what makes the claim true — a branch is
 * normalised, THEN judged.
 */
const normalizedBranch = (plan: Plan): readonly Step[] | null => {
  if (plan.steps.length === 0) {
    return null;
  }

  const out: Step[] = [];

  for (const step of plan.steps) {
    pushSplit(out, membershipFromOrChain(step) ?? step);
  }

  return out.every((s) => PURE_ELEMENT_FILTERS.has(s.kind)) ? out : null;
};

/**
 * `filter(has(…))` becomes `has(…)`, and `and(has(…), hasLabel(…))` becomes the two steps chained
 * (item 1308).
 *
 * ONE CAUSE BEHIND SEVERAL FLAGS. Item 1305's probe flagged six small groups, and the per-arm
 * numbers at 200,000 vertices show they are the same defect wearing different spellings — every
 * WRAPPED filter is slower than the flat chain that means the same thing, because wrapping puts the
 * filters in a SUB-PLAN and the flat rungs (`filterChainCount` and the rest) stop matching, so the
 * whole query drops to the traverser pipeline:
 *
 * ```text
 *   has('age', gte(45))                 2.904 ms   vs  filter(has('age', gte(45)))  36.675 ms  12.6x
 *   has('k', gte(2)).hasLabel('Q')      6.364      vs  and(has(…), hasLabel(…))     58.731      9.2x
 * ```
 *
 * WHY SPLICING IS SOUND, and it rests on `PURE_ELEMENT_FILTERS` rather than on `filter`'s
 * semantics in general. `filter(body)` keeps a traverser when `body` yields at least one result.
 * If every step in `body` only keeps-or-drops the element, then `body` yields the element itself or
 * nothing, so "keeps a traverser when body yields something" IS "the element passed every filter"
 * — which is what the spliced chain computes, in the same order. `and(plans)` is the same argument
 * once per branch, and chaining the branches preserves the written order.
 *
 * A body that is NOT filter-only must decline, and `filter(out('T'))` is the case that shows why:
 * it keeps vertices that HAVE an outgoing `T` edge, where splicing `out('T')` would REPLACE each
 * vertex with its neighbours. Verified: `filter(out('T'))` answers `["v0"]` on a fixture where the
 * spliced form would answer the neighbour.
 *
 * `or` is NOT flattened and cannot be: a disjunction is not a chain. Its probe group (`within`
 * against an `or`-chain of equalities, 4.0x) needs a different mechanism — recognising the
 * disjunction as a membership — and is left open.
 *
 * RAISE PARITY was checked rather than assumed, because a splice that short-circuits where the
 * wrapper did not would change a fault into a row. On this surface a cross-type comparison returns
 * FALSE rather than raising — `has('s', gte(5))` on a string property answers empty, and the
 * chained, `and`-wrapped and `filter`-wrapped spellings all agree — so there is no fault to
 * reorder. (That differs from the GQL side's cross-type policy, which is why it was measured here
 * instead of carried over.)
 */
// EXPORTED for its own assertion, like `fuseEdgeHop` and `effectivePlan` beside it, and not
// from the package barrel.
/**
 * Append `step`, SPLITTING `has(label, key, pred)` into `hasLabel(label).has(key, pred)` (item
 * 1309). Returns whether it split.
 *
 * The three-argument `has` exists to say "this label AND this property" in one step, and it is
 * SLOWER than writing the two steps it fuses — 8.981 ms against 2.199 at 200,000 vertices, 4.1x,
 * both answering 33330. It builds a single `hasLabelAnd` step, and the rungs that answer a filter
 * CHAIN do not recognise it, so the shorthand drops the query to the traverser pipeline while the
 * longhand is served.
 *
 * Splitting rather than teaching the rungs a third shape is the choice items 1303, 1307 and 1308
 * made, and it is sound by construction: the step's whole meaning is the conjunction of a
 * single-label test and one property predicate, which is exactly those two steps. Verified at the
 * boundaries as well as the middle — a label no element carries, an absent key, and a projection
 * off the end all agree between the spellings.
 *
 * A FUNCTION rather than a branch in the loop below, because the splice paths must use it too. The
 * first cut put the split inline and CLAIMED in a comment that a `hasLabelAnd` coming out of an
 * `and(…)` branch would be split as well. It would not have been: the splice pushes branch steps
 * straight into the list without re-examining them, so the claim was false and its own test caught
 * it. Routing every push through here is what makes the claim true.
 */
const pushSplit = (steps: Step[], step: Step): boolean => {
  if (step.kind !== 'hasLabelAnd') {
    steps.push(step);

    return false;
  }

  steps.push(
    { kind: 'hasLabel', labels: [step.label] },
    { kind: 'has', key: step.key, pred: step.pred },
  );

  return true;
};

export const flattenFilterWrappers = (plan: Plan): Plan => {
  const steps: Step[] = [];
  let changed = false;

  for (const step of plan.steps) {
    if (step.kind === 'filter') {
      const inner = normalizedBranch(step.plan);

      if (inner !== null) {
        steps.push(...inner);
        changed = true;
        continue;
      }
    }

    // `or(has(k,a), has(k,b))` is not a chain — it is a MEMBERSHIP (item 1312). Handled here
    // rather than in its own pass so that an `or` nested inside an `and` is folded too: the `and`
    // arm below splices its branches through `pushSplit`, and a folded membership is a plain `has`
    // by then.
    if (step.kind === 'or') {
      const membership = membershipFromOrChain(step);

      if (membership !== undefined) {
        steps.push(membership);
        changed = true;
        continue;
      }
    }

    if (step.kind === 'and') {
      const parts = step.plans.map(normalizedBranch);

      // EVERY branch must be filter-only: splicing some and leaving others would conjoin a chain
      // with a residual `and`, which is still correct but is not what this rewrite claims, and the
      // partial form has not been measured.
      if (parts.length > 0 && parts.every((p) => p !== null)) {
        for (const part of parts) {
          steps.push(...part);
        }

        changed = true;
        continue;
      }
    }

    changed = pushSplit(steps, step) || changed;
  }

  return changed ? { ...plan, steps } : plan;
};

/**
 * The `both`-family step an ordered `(out, in)` or `(outE, inE)` pair collapses to, or `undefined`.
 *
 * MODULE SCOPE because it captures nothing — the linter asks for that, and it is right: this was a
 * closure rebuilt on every call inside {@link bothFromUnion}, which runs once per union step.
 */
const pairedBoth = (x: Step, y: Step): 'both' | 'bothE' | undefined => {
  if (x.kind === 'out' && y.kind === 'in') {
    return 'both';
  }

  if (x.kind === 'outE' && y.kind === 'inE') {
    return 'bothE';
  }

  return undefined;
};

/**
 * The step `union(out(L), in(L))` collapses to, or `undefined` — `both` for the vertex pair,
 * `bothE` for the edge pair (item 1311).
 *
 * Both branches must be EXACTLY one step, one `out`/`outE` and one `in`/`inE` in either written
 * order, carrying the IDENTICAL label list. Each condition refuses a real non-equivalence:
 * `union(out(T), in(S))` is not a `both` of anything, `union(out(T), out(T))` doubles one side, and
 * a branch with a second step is a different walk. Label order is compared positionally, which
 * declines a reordered pair — conservative, and cheaper than proving set equality.
 */
const bothFromUnion = (step: Step): Step | undefined => {
  if (step.kind !== 'union' || step.plans.length !== 2) {
    return undefined;
  }

  const [first, second] = step.plans;

  if (first.steps.length !== 1 || second.steps.length !== 1) {
    return undefined;
  }

  const [a] = first.steps;
  const [b] = second.steps;
  const kind = pairedBoth(a, b) ?? pairedBoth(b, a);

  if (kind === undefined) {
    return undefined;
  }

  const la = (a as Extract<Step, { labels: readonly string[] }>).labels;
  const lb = (b as Extract<Step, { labels: readonly string[] }>).labels;

  if (la.length !== lb.length || la.some((l, i) => l !== lb[i])) {
    return undefined;
  }

  return { kind, labels: la };
};

/**
 * Tails after which the union's EMISSION ORDER cannot be observed, so `union(out, in)` may become
 * `both` (item 1311).
 *
 * ⚠️ THIS LIST IS THE WHOLE SOUNDNESS ARGUMENT, and it is short on purpose. `both` and
 * `union(out, in)` are NOT sequence-equal — item 1308 measured it: on one fixture `both` emits
 * `["b","a","a","c","a","b"]` where the union emits `["b","a","c","a","a","b"]`, because `both`
 * finishes each vertex before moving on and the union does not. They ARE multiset-equal, so only a
 * tail that reads the multiset and not the sequence may ride this.
 *
 * `count` reads the multiset. `dedupe` then `count` reads the SET, which is coarser still — and
 * both were verified on a fixture carrying PARALLEL edges, a MULTI-LABEL edge and a SELF-LOOP,
 * where the pair agrees at 8 and 3 respectively, typed, untyped and multi-type.
 *
 * `sum` and `mean` are deliberately ABSENT even though they look order-free: this repo records
 * them as order-sensitive in the last ulp (`foldFor`'s own note), so a reordering is observable in
 * floating point. `min`/`max` would be safe but are not in the measured shape, so they are not
 * admitted on a guess.
 */
// MOVED to `index-seed.ts` at item 1317, which needs the same question answered for a different
// reason — see {@link tailIsOrderFree} there. One list, because two copies of "which tails are
// order-free" would drift apart and each would look authoritative.

/**
 * `union(out(T), in(T)).count()` becomes `both(T).count()` (item 1311).
 *
 * Item 1305's Gremlin spelling probe measured the pair at 128659x net of its null control — the
 * largest gap it found — because `both(T).count()` is answered from degree sums while the union
 * materialises one traverser per branch per vertex.
 *
 * ⚠️ IT IS NOT A GENERAL NORMALISATION, and item 1308 is why: the two spellings are multiset-equal
 * but NOT sequence-equal, so rewriting a row-returning traversal would change observable output
 * order. The win was measured on a `count()` terminal, where order is not observable at all, so
 * that is exactly what is admitted — see {@link ORDER_FREE_TAILS}.
 *
 * Only the TOP-LEVEL step list is rewritten, like `fuseEdgeHop` beside it; a `repeat()` body is
 * left for its own item.
 */
// EXPORTED for its own assertion, like `fuseEdgeHop` and `flattenFilterWrappers` beside it.
export const fuseUnionBoth = (plan: Plan): Plan => {
  for (let i = 0; i < plan.steps.length; i += 1) {
    const fused = bothFromUnion(plan.steps[i]);

    if (fused !== undefined && tailIsOrderFree(plan.steps.slice(i + 1))) {
      const steps = [...plan.steps];

      steps[i] = fused;

      return { ...plan, steps };
    }
  }

  return plan;
};

/**
 * `values(k).is(p).count()` becomes `has(k, p).count()` (item 1314).
 *
 * Item 1305's probe measured the pair at ~3.8x net of its null control: `values` materialises one
 * value per element and `is` filters the value stream, where `has` is a filter the count rungs
 * recognise.
 *
 * ⚠️ THE TWO SPELLINGS RETURN DIFFERENT THINGS, which is the whole reason the tail is `count` and
 * nothing else. `values(k).is(p)` emits VALUES; `has(k, p)` emits ELEMENTS. They agree on HOW MANY
 * only, and only because this surface's properties are single-valued — verified rather than
 * assumed: `values('k')` over four vertices (one holding `5`, one an ARRAY `[1,2,3]`, one with the
 * key absent, one holding `null`) emits exactly `[5, [1,2,3], null]`, so an array is ONE value, a
 * null IS a value, and a missing key emits nothing. `values(k).count()` and `has(k).count()` both
 * read 3.
 *
 * Three conditions, each refusing a measured non-equivalence rather than an unusual spelling:
 *
 *   * **ONE key.** `values(k, j)` emits one row PER KEY per element, so the pair reads 4 against 2.
 *   * **The tail is exactly `count`.** A `dedupe` before it is observable: distinct VALUES is 1
 *     where distinct ELEMENTS is 2 on a fixture where two elements share a value. That is the
 *     difference from item 1311, where `dedupe, count` IS admitted — there both spellings emit the
 *     same elements, so a coarser view stays equal; here the rewrite changes WHAT FLOWS.
 *   * **`count` is LAST.** Anything after it reads the count, not the stream, but a `count` that is
 *     not the terminal means the plan does something else with it and is not this shape.
 *
 * The predicate carries over unchanged because it means the same thing in both positions: `has(k,
 * p)` applies `p` to the property value and `is(p)` applies it to the value that `values` just
 * emitted, which IS the property value.
 */
// EXPORTED for its own assertion, like the other rewrites in this file.
export const fuseValuesIsCount = (plan: Plan): Plan => {
  const { steps } = plan;

  for (let i = 0; i + 2 < steps.length; i += 1) {
    const vals = steps[i];
    const test = steps[i + 1];
    const tail = steps[i + 2];

    if (
      vals.kind !== 'values' ||
      vals.keys.length !== 1 ||
      test.kind !== 'is' ||
      tail.kind !== 'count' ||
      i + 3 !== steps.length
    ) {
      continue;
    }

    const next = [...steps];

    next.splice(i, 2, { kind: 'has', key: vals.keys[0], pred: test.pred });

    return { ...plan, steps: next };
  }

  return plan;
};

/**
 * The plan the rungs actually see.
 *
 * Both rewrites here exist for the same reason — every shortcut matches a plan PREFIX beginning at
 * the source, so one extra step in front of a hop makes all of them decline — and they compose in
 * this order deliberately: `flattenFilterWrappers` is innermost so the filters it splices are
 * visible to everything after it, then `fuseEdgeHop`, so the label drop sees a ONE-step hop. A shortcut wanting `[V, hasLabel, out]` would still decline if the hop were two
 * steps at the moment the vacuous label was removed.
 *
 * ONE GUARD FOR BOTH, and it is why this is a function rather than two calls at the use site: a
 * plan that reads the traverser PATH must keep the spelling it was given, because the long hop puts
 * the EDGE in the path and the fused one does not. Had the guard been spelled out at the call site
 * it could be remembered for one rewrite and forgotten for the next.
 *
 * EXPORTED so the WIRING is assertable and not just the rewrites. Asserting `fuseEdgeHop` alone
 * leaves the mutant that simply stops CALLING it alive — the suite then answers identically by the
 * slow walk, which is the shape item 1303 measured.
 */
export const effectivePlan = (plan: Plan, graph: Graph, tracksPath: boolean): Plan =>
  tracksPath
    ? plan
    : dropVacuousLabels(
        fuseUnionBoth(fuseEdgeHop(flattenFilterWrappers(fuseValuesIsCount(plan)))),
        graph,
      );

/**
 * `outE(T).inV()` becomes `out(T)`, and `inE(T).outV()` becomes `in(T)` (item 1307).
 *
 * The long spelling is what a user writes when the edge is interesting on the way through, and it
 * is the same walk: for each vertex, for each incident edge of those types, the edge's far end.
 * Written the long way it had no rung at all, so the cost was not a constant factor:
 *
 * ```text
 *   V().out('T').count()               0.009 ms   <- a closed-form degree sum
 *   V().outE('T').inV().count()      ~204 ms      <- 400,000 materialised traversers
 * ```
 *
 * 18936-24433x on three isolated runs of item 1305's Gremlin spelling probe, and the twin
 * `union(out, in)` against `both` reads 228822x. Normalising rather than teaching the rungs about
 * the pair is the same choice item 1303 made on the GQL side: every rung already built for `out` —
 * the count shortcut, `hopValuesShortcut`, the seeded walks — reaches the long spelling at once.
 *
 * EQUIVALENCE IS MEASURED, NOT ASSUMED, because item 1306 is the cautionary tale: there the
 * analogous-looking rewrite of `V() + hasId(ids)` into `V(ids)` was unsound twice over (it raised
 * where the filter did not, and it did not dedupe). Checked on a fixture carrying PARALLEL edges
 * `a->b` twice, a MULTI-LABEL edge `['T','S']`, and a SELF-LOOP `a->a`, the two spellings agree on
 * the same multiset AND the same order for `count()`, for the elements themselves, for
 * `values(k)`, for the untyped `outE()`/`out()` pair, and for the incoming mirror.
 *
 * ⚠️ THEY DO NOT AGREE ON `path()`, and that is why this runs only when nothing reads the path.
 * The long spelling puts the EDGE in the traverser's path and `out` does not, so a plan that can
 * observe the path must keep the spelling it was given. `planReadsPath` is the test, and it is
 * conservative in the right direction: it recurses through every plan-bearing field and covers
 * `path`, `tree`, `simplePath`, `cyclicPath`, `otherV` and the closure steps, returning true when
 * in doubt. The caller applies this in the same `ctx.tracksPath` slot `dropVacuousLabels` uses, so
 * the guard cannot be forgotten at one call site and not the other.
 *
 * ADJACENCY is the second half of the guard, and it does more work than it looks. Any step between
 * the two — `as_('e')`, `aggregate`, `sack`, a filter on the edge — stops the match, which is
 * exactly right: those are the plans where the EDGE is observable for a reason other than the
 * path, and a fused hop would no longer have an edge to give them.
 *
 * `bothE(T).otherV()` is deliberately NOT fused, even though it looks like the third member of the
 * family: `otherV` is itself path-dependent (it reads the path to know which end it came from), so
 * it is already excluded by the guard above, and folding it to `both(T)` would need its own
 * argument rather than this one.
 *
 * Only the TOP-LEVEL step list is rewritten. A `repeat(outE(T).inV())` body is the same question
 * and is left for its own item: the body is reached through `subPlansOf`, and the win there is the
 * per-repetition walk rather than a shortcut this rewrite would unlock.
 */
// EXPORTED for its own assertion, the way `compileLinear` and `seedFromIndex` are on their
// sides, and not from the package barrel — the public surface is unchanged. It needs one
// because the fusion is answer-equivalent where it applies: with it disabled the suite
// returns identical rows by the slow walk, so only an assertion on the REWRITTEN PLAN can
// tell "it fused" from "it answered anyway" (item 1303 measured that distinction).
export const fuseEdgeHop = (plan: Plan): Plan => {
  const steps: Step[] = [];
  let fused = false;

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];
    const next = plan.steps[i + 1];

    if (next !== undefined && step.kind === 'outE' && next.kind === 'inV') {
      steps.push({ kind: 'out', labels: step.labels });
      fused = true;
      i += 1;
      continue;
    }

    if (next !== undefined && step.kind === 'inE' && next.kind === 'outV') {
      steps.push({ kind: 'in', labels: step.labels });
      fused = true;
      i += 1;
      continue;
    }

    steps.push(step);
  }

  return fused ? { ...plan, steps } : plan;
};

const dropVacuousLabels = (plan: Plan, graph: Graph): Plan => {
  const vertexSource = plan.steps[0]?.kind === 'V';
  const edgeSource = plan.steps[0]?.kind === 'E';

  if (!vertexSource && !edgeSource) {
    return plan;
  }

  const total = vertexSource ? graph.vertexCount : graph.edgeCount;

  if (total === 0) {
    return plan;
  }

  const vacuous = (step: Step): boolean => {
    if (step.kind !== 'hasLabel' || step.labels.length !== 1) {
      return false;
    }

    const bucket = vertexSource
      ? graph.verticesByLabel.get(step.labels[0])
      : graph.edgesByLabel.get(step.labels[0]);

    return bucket?.size === total;
  };

  // Only a LEADING run of them: a `hasLabel` after a hop tests the hop's endpoints, which are a
  // different set from the source and not what `vertexCount` counts.
  let cut = 1;

  while (cut < plan.steps.length && COMMUTING_SOURCE_FILTERS.has(plan.steps[cut].kind)) {
    cut += 1;
  }

  const kept = plan.steps.filter((step, i) => i === 0 || i >= cut || !vacuous(step));

  return kept.length === plan.steps.length ? plan : { ...plan, steps: kept };
};

/**
 * The leading filters a vacuous label may sit among — the same set `index-seed.ts` calls
 * COMMUTING_FILTERS, because the question is the same one: which steps only narrow the SOURCE
 * set, so that a label among them is still a label on the source.
 */
const COMMUTING_SOURCE_FILTERS = new Set<Step['kind']>([
  'has',
  'hasLabel',
  'hasLabelAnd',
  'hasId',
  'hasKey',
  'hasNot',
]);

const assertPlanIsSatisfiable = (plan: Plan): void => {
  for (let i = 0; i < plan.steps.length; i++) {
    if (plan.steps[i].kind !== 'path') {
      continue;
    }

    for (const later of plan.steps.slice(i + 1)) {
      if (ELEMENT_STEP_ON_PATH.has(later.kind)) {
        throw new LenkeError(
          `${later.kind}() is not defined on a path: a path is not an element ` +
            `(unfold() it into its elements first)`,
          { code: ErrorCode.DataException },
        );
      }

      if (!PATH_PASSTHROUGH.has(later.kind)) {
        break;
      }
    }
  }
};

/**
 * Run a plan against a graph. Always returns an `Iterable<unknown>` —
 * terminal steps (`count`, `fold`, `toList`) yield exactly one value; other
 * steps yield zero or more. This matches Gremlin's "every step is a stream"
 * model and keeps `pipe(count(), is(gt(5)))` composable.
 */
export const run = (plan: Plan, graph: Graph): Iterable<unknown> => {
  // Before anything runs: static faults the engine raises at parse time — a plan that
  // cannot succeed on any graph, and an aggregate/sort/vertex-move on the wrong frontier.
  assertPlanIsSatisfiable(plan);
  assertFrontierTypes(plan);

  // Decide once whether any step observes the path; if not, traversers skip
  // path bookkeeping for the whole run (see planReadsPath / startTraverser).
  const ctx = newContext(planReadsPath(plan));

  // Peel leading source-configuration steps (`withSack`) — like TinkerPop's
  // GraphTraversalSource config they precede the actual source (V()/E()/…), so
  // they set up the context rather than seed a stream.
  let head = 0;

  while (head < plan.steps.length && plan.steps[head].kind === 'withSack') {
    ctx.sackInit = { value: (plan.steps[head] as Extract<Step, { kind: 'withSack' }>).init };
    head++;
  }

  const sliced = head === 0 ? plan : { ...plan, steps: plan.steps.slice(head) };
  // A VACUOUS `hasLabel` is dropped before anything else looks at the plan. Every shortcut below
  // matches a plan PREFIX that begins at the source, so one extra step in front of the hop makes
  // all of them decline — and a label every element carries is exactly such a step while
  // excluding nothing. See `dropVacuousLabels` (item 540).
  const effective = effectivePlan(sliced, graph, ctx.tracksPath);

  // A `count()` the graph already keeps a counter or bucket for is a READ, not a
  // walk — see `countShortcut`. Checked before seeding because it answers the
  // whole plan rather than narrowing its start.
  const shortcut = countShortcut(effective, graph);

  if (shortcut !== undefined) {
    return [shortcut];
  }

  // `V().groupCount().by(k)` answers the whole plan too — a tally over the vertex set, 34.7ns a
  // vertex down to ~16. The gap it removes is the generator LAYERING and not the per-element
  // traverser, which measures free; see `groupCountShortcut` for the elimination.
  //
  // Unguarded by `tracksPath`, unlike the walk below: this plan is exactly `V()` + `groupCount`, so
  // there is no path-consuming step in it, and the step it replaces would discard any path it was
  // handed — a `groupCount` yields one Map and carries nothing forward.
  const grouped = groupCountShortcut(effective, graph);

  if (grouped !== undefined) {
    return [grouped];
  }

  // `V().out(T).values(k)` likewise answers the whole plan — one walk instead of the traverser
  // pipeline, 539ns/row down to 251 (see `hopValuesShortcut`). Only when nothing tracks path:
  // the walk emits bare values and builds no traverser, so it has no path to carry.
  const projected = ctx.tracksPath ? undefined : hopValuesShortcut(effective, graph);

  // NOTHING LEFT OVER is the shape this shortcut has always served: the values ARE the answer, so
  // they are returned without ever building a traverser. Unchanged, and it stays the fast path.
  if (projected?.rest.length === 0) {
    return projected.values;
  }

  // If the plan opens `V()`/`E()` + a seedable `has` on an indexed key, seed
  // from the index and apply only the residual steps; otherwise scan as usual.
  const seeded = projected === undefined ? seedFromIndex(effective, graph, ctx.tracksPath) : null;
  // A RESIDUAL RIDES THE SHORTCUT (item 608) rather than defeating it. The walk's values are
  // wrapped as traversers and the leftover steps run over them, exactly as a seeded plan's stream
  // feeds its own residual below. The wrapping is real work — but `V().values(k)` runs the WHOLE
  // pipeline for 200,000 values in 29.4 ms, so it is a few ms against the 114 ms that declining
  // the shortcut cost.
  //
  // `tracksPath` is still the gate: the walk emits bare values and builds no path, so a plan that
  // reads one cannot ride it, residual or not.
  let stream: Iterable<Traverser<unknown>> | null =
    projected !== undefined
      ? (function* () {
          for (const value of projected.values) {
            yield startTraverser(value, false);
          }
        })()
      : (seeded?.stream ?? null);
  const steps = projected !== undefined ? projected.rest : (seeded?.steps ?? effective.steps);

  for (const step of steps) {
    if (stream === null) {
      stream = applySource(step, graph, ctx.tracksPath);
      continue;
    }

    stream = applyStep(step, stream, graph, ctx);
  }

  return unwrap(stream ?? []);
};

/**
 * Eager terminal: run the plan and collect every emitted value into an array.
 *
 * Equivalent to `[...run(plan, graph)]`. Provided for parity with legacy and
 * because the intent ("I want the answer as an array, not a lazy iterable")
 * is common enough to deserve a name.
 */
export const toArray = (plan: Plan, graph: Graph): unknown[] => [...run(plan, graph)];

/**
 * Eager terminal: run the plan and collect emitted values into a Set, dropping
 * duplicates by JS reference/primitive equality.
 *
 * Equivalent to `new Set(run(plan, graph))`. For value-based de-duplication
 * over vertices/edges/objects, prefer the `dedupe()` step inside the plan —
 * a `Set` only de-dupes by `===`, so two distinct vertex objects with the same
 * `id` would both be retained.
 */
export const toSet = (plan: Plan, graph: Graph): Set<unknown> => new Set(run(plan, graph));
