import type { Temporal } from '@lenke/core';

/**
 * The traversal AST. A `Plan` is a sequence of `Step`s. The DSL constructors
 * build these declaratively; strategies rewrite them; an executor runs them
 * against a backend graph.
 *
 * Two design rules:
 *   1. Every node is plain data — no closures, no generators. This makes the
 *      AST serializable and reorderable.
 *   2. Predicates are also data, not functions. Same reason.
 */

export type ID = string | number;

export type Direction = 'out' | 'in' | 'both';

/** Runtime `Direction` enum (TinkerPop `Direction.OUT`/`IN`/`BOTH`), e.g.
 *  `shortestPath().with(ShortestPath.edges, Direction.OUT)`. */
export const Direction = { OUT: 'out', IN: 'in', BOTH: 'both' } as const;

/** What an ordering predicate can be compared against. Temporals are admitted
 *  alongside numbers and strings: a stored DATE/DATETIME orders chronologically,
 *  and the predicate constructors lift a tagged literal (`{"@date": …}`) to an
 *  instance so `lt(D('2021-01-01'))` reaches the temporal comparator instead of
 *  falling through to the incomparable-types throw. */
export type Orderable = number | string | Temporal;

export type Predicate =
  // Item 1140. PRESENCE, and the only variant that does not read a value: true iff the element
  // carries the key at all, counting a STORED PRESENT-NULL. It is never produced by surface
  // syntax — `has('k')` builds a `hasKey` step, which is what a user writes — and exists so the
  // count shortcut's `hasChain` can carry a single-key `hasKey` through machinery that is keyed
  // on `has`. See `count-shortcut.ts`: admitting the step without this was impossible because
  // every OTHER predicate reads the value, and synthesising e.g. `neq(sentinel)` would drop a
  // present-null through `predCmp`'s NaN path — the `present_at` vs `has_value_at` distinction
  // that cost a mutant verdict in the Rust engine at item 1136.
  | { op: 'present' }
  | { op: 'eq'; value: unknown }
  | { op: 'neq'; value: unknown }
  | { op: 'gt'; value: Orderable }
  | { op: 'gte'; value: Orderable }
  | { op: 'lt'; value: Orderable }
  | { op: 'lte'; value: Orderable }
  // Gremlin semantics: half-open [first, second). To match, our `between`
  // is inclusive on `min` and exclusive on `max`.
  | { op: 'between'; min: Orderable; max: Orderable }
  // Strict open (first, second) — exclusive on both ends.
  | { op: 'inside'; min: Orderable; max: Orderable }
  // Strict complement: value < min || value > max.
  | { op: 'outside'; min: Orderable; max: Orderable }
  | { op: 'within'; values: readonly unknown[] }
  | { op: 'without'; values: readonly unknown[] }
  | { op: 'startsWith'; value: string }
  // TextP-style string predicates.
  | { op: 'endingWith'; value: string }
  | { op: 'containing'; value: string }
  | { op: 'notContaining'; value: string }
  | { op: 'regex'; value: string }
  // Negation: `has('name', not(within('a','b')))` — built via the
  // polymorphic `not(...)` step constructor when called with a predicate.
  | { op: 'not'; predicate: Predicate };

/**
 * The `by()` modulator. Attached to a parent step (path, order, dedupe,
 * group, groupCount, project, select, tree) to specify how to project each
 * value before the parent step uses it.
 *
 * Forms:
 *   - `identity`: `by()` — use the value as-is
 *   - `key`:      `by('name')` — read a property by name (vertex/edge only;
 *                  primitives pass through unchanged)
 *   - `traversal`: `by(outE().count())` — run a sub-plan with the value as
 *                  the starting traverser; project to the first result
 *
 * Comparator forms (`by(Order.asc)`, `by('age', Order.desc)`) carry an optional
 * `direction`; token forms (`by(T.id)`, `by(T.label)`) use the `token` kind.
 */
// A single `by()` call produces one of these. `direction` is meaningful only
// for `order()` (Gremlin's `by(asc)` / `by(key, desc)` / etc.); other steps
// ignore it. We attach it to every variant so the AST stays a single union.
// A `sack(op)` merge operator: `newSack = op(currentSack, projectedValue)`.
export type SackOp = 'assign' | 'sum' | 'mult' | 'min' | 'max';

export type By =
  | { kind: 'identity'; direction?: 'asc' | 'desc' }
  | { kind: 'key'; key: string; direction?: 'asc' | 'desc' }
  | { kind: 'traversal'; plan: Plan; direction?: 'asc' | 'desc' }
  // Tokens project to well-known facets of an element rather than a property.
  // Mirrors Gremlin's `T.id`, `T.label`, `T.key`, `T.value`.
  | { kind: 'token'; token: 'id' | 'label' | 'key' | 'value'; direction?: 'asc' | 'desc' }
  // `Column.keys` / `Column.values` — in `order(local)` selects whether a Map's
  // entries sort by their key or value.
  | { kind: 'column'; column: 'keys' | 'values'; direction?: 'asc' | 'desc' };

// --- Closure types passed to user-supplied steps ---
// These functions are opaque to the optimizer and break plan serialization.
type CTraverser = {
  readonly value: unknown;
  readonly path: readonly unknown[];
  readonly loopCount: number;
  /**
   * Per-traverser tags assigned via `as(label)`. A label can carry multiple
   * values inside iterative steps (e.g. `repeat(out().as('a'))`).
   */
  readonly tags: ReadonlyMap<string, unknown>;
  /**
   * Per-run side-effect bags (the same Map that backs `aggregate(key)` /
   * `store(key)` / `cap(key)`). Closures can read but should not mutate;
   * the runtime hands out a read-only view of the live map.
   */
  readonly sideEffects: ReadonlyMap<string, readonly unknown[]>;
};
export type MapClosure = (value: unknown, t: CTraverser) => unknown;
export type FlatMapClosure = (value: unknown, t: CTraverser) => Iterable<unknown>;
export type FilterClosure = (value: unknown, t: CTraverser) => boolean;
export type SideEffectClosure = (value: unknown, t: CTraverser) => void;
export type ReducerClosure = (acc: unknown, value: unknown, t: CTraverser) => unknown;

/**
 * Steps that produce, transform, or consume traversers. Each variant is a
 * pure data description — no execution semantics live here.
 */
export type Step =
  // Sources
  | { kind: 'V'; ids?: readonly ID[] }
  | { kind: 'E'; ids?: readonly ID[] }
  // Movement (vertex → vertex via edges)
  | { kind: 'out'; labels: readonly string[] }
  | { kind: 'in'; labels: readonly string[] }
  | { kind: 'both'; labels: readonly string[] }
  // Movement (vertex → edge)
  | { kind: 'outE'; labels: readonly string[] }
  | { kind: 'inE'; labels: readonly string[] }
  | { kind: 'bothE'; labels: readonly string[] }
  // Movement (edge → vertex)
  | { kind: 'outV' }
  | { kind: 'inV' }
  | { kind: 'bothV' }
  | { kind: 'otherV' }
  // Filters
  | { kind: 'has'; key: string; pred: Predicate }
  | { kind: 'hasLabel'; labels: readonly string[] }
  | { kind: 'hasId'; ids: readonly ID[] }
  | { kind: 'hasKey'; keys: readonly string[] }
  | { kind: 'simplePath' }
  | { kind: 'cyclicPath' }
  // `labels` dedupes on the tuple of values tagged at those `as_` labels;
  // `bys` is the projection modulator (e.g. `dedupe().by('name')` dedupes on the
  // `name` property). With neither, dedupes on the value itself.
  | { kind: 'dedupe'; labels?: readonly string[]; bys?: readonly By[] }
  // Cardinality. With `scope: 'local'`, the operation slices each
  // traverser's iterable value in place (typical use: after `fold()` or on
  // list-shaped values from `valueMap`/`select(...all)`). With `scope:
  // 'global'` (default, omitted), the operation slices the stream of
  // traversers itself.
  | { kind: 'take'; n: number; scope?: 'global' | 'local' }
  | { kind: 'skip'; n: number; scope?: 'global' | 'local' }
  | { kind: 'range'; start: number; end: number; scope?: 'global' | 'local' } // end < 0 means open-ended
  | { kind: 'tail'; n: number; scope?: 'global' | 'local' }
  // Iteration
  | {
      kind: 'repeat';
      body: Plan;
      until?: Plan;
      emit?: Plan;
      // TinkerPop placement: `repeat(body).emit(...)` (post-form) emits AFTER
      // each body application; `emit(...).repeat(body)` (pre-form, our
      // `.emitBefore()`) emits BEFORE each body application, including the
      // input traverser at level 0.
      emitBefore?: boolean;
      // TinkerPop `until` placement: `repeat(body).until(cond)` (post-form, the
      // default `.until()`) checks the condition AFTER the body — do-while, the
      // body runs at least once. `until(cond).repeat(body)` (pre-form, our
      // `.untilBefore()`) checks BEFORE the body — while-do, a satisfier never
      // enters the body.
      untilBefore?: boolean;
      times?: number;
    }
  // Predicates on the current value
  | { kind: 'is'; pred: Predicate }
  // Identity / no-op
  | { kind: 'identity' }
  // Filter every traverser out, ending the stream with no results.
  //
  // This step has narrow direct uses: in classic TinkerPop it's primarily a
  // signal to a remote server that `iterate()` was called and downstream
  // results are not wanted. Locally it's mostly an explicit "drop everything"
  // marker. If you find yourself reaching for it elsewhere, the traversal
  // probably wants to be rewritten — e.g. an upstream `filter`/`where` that
  // simply yields no traversers.
  //
  // Anything chained after `none()` will see an empty stream.
  //
  // With a `pred` (TinkerPop 3.8): list-predicate filter — keep the traverser
  // iff no element of its iterable value satisfies the predicate.
  | { kind: 'none'; pred?: Predicate }
  // Inject literals into the stream (source or mid-stream)
  | { kind: 'inject'; values: readonly unknown[] }
  // Unfold one level of an iterable (excluding strings)
  | { kind: 'unfold' }
  // Projection
  | { kind: 'values'; keys: readonly string[] }
  // `includeTokens` (from `valueMap(true)`) prepends `id` and `label` to the map,
  // like a token-bearing `elementMap()` but without an edge's IN/OUT submaps.
  | { kind: 'valueMap'; keys?: readonly string[]; includeTokens?: boolean }
  | { kind: 'properties'; keys: readonly string[] }
  | { kind: 'id' }
  | { kind: 'label' }
  // `bys` cycles across path elements: `path().by('name').by('age')` projects
  // the 1st, 3rd, 5th... element via 'name' and the 2nd, 4th... via 'age'.
  | { kind: 'path'; bys?: readonly By[] }
  // Terminals (executor produces a scalar). With `scope: 'local'` (Gremlin's
  // `Scope.local`), the aggregate is computed over each traverser's iterable
  // VALUE rather than across the stream — useful after `fold()` or on
  // list-shaped projections. Default is `'global'` (across the stream).
  | { kind: 'count'; scope?: 'global' | 'local' }
  | { kind: 'fold' }
  | { kind: 'toList' }
  // Numeric/comparable aggregates — return a one-element stream (Gremlin semantics)
  | { kind: 'sum'; scope?: 'global' | 'local' }
  | { kind: 'min'; scope?: 'global' | 'local' }
  | { kind: 'max'; scope?: 'global' | 'local' }
  | { kind: 'mean'; scope?: 'global' | 'local' }
  // Sort. Legacy `key` projects each element to a comparable property; `bys`
  // is the modulator form (`order().by('age')`). The first `by` projects;
  // additional `by`s are tie-breakers (Gremlin semantics). `desc` flips order
  // (applies to all `by`s for now — comparator-per-by would need closures).
  // `cap` is set only by `fuseOrderTake` (item 1574): a fused `take(n)` bound that lets the sort
  // take a bounded top-k instead of sorting everything and slicing. Never set by a step builder.
  | {
      kind: 'order';
      key?: string;
      desc?: boolean;
      bys?: readonly By[];
      scope?: 'local' | 'global';
      cap?: number;
    }
  // Stop the stream with an error.
  | { kind: 'fail'; message?: string }
  // Sub-traversal filters: keep traverser if the sub-plan produces ≥1 result.
  // `where` has two shapes that share the same `kind`. TS narrows on the
  // presence of `plan` vs `startKey` so the executor can dispatch without
  // nullable fields.
  //
  //  - `where(subPlan)`: filter traversers whose sub-plan emits anything.
  //  - `where(startKey, predicate)`: compare the value tagged at `startKey`
  //    to the value tagged at `pred.value` (treated as another `as_` label
  //    name), via the predicate's op. Optional `bys` apply round-robin to
  //    the start- and end-tag values.
  | { kind: 'where'; plan: Plan }
  | { kind: 'where'; startKey: string; pred: Predicate; bys?: readonly By[] }
  //  - `where(predicate)`: compare the CURRENT traverser value to the value tagged
  //    at `pred.value` (a step label), via the predicate's op — e.g.
  //    `where(neq('me'))`. Narrowed by having `pred` but no `startKey`/`plan`.
  | { kind: 'where'; pred: Predicate }
  // Logical combinators over sub-plans (each plan starts from the current traverser).
  | { kind: 'and'; plans: readonly Plan[] }
  | { kind: 'or'; plans: readonly Plan[] }
  | { kind: 'not'; plan: Plan }
  // Run each sub-plan starting from the current traverser; merge outputs in order.
  | { kind: 'union'; plans: readonly Plan[] }
  // Try plans in order; yield the first non-empty plan's results per traverser.
  | { kind: 'coalesce'; plans: readonly Plan[] }
  // Run sub-plan; if it yields nothing, fall back to yielding the input traverser.
  | { kind: 'optional'; plan: Plan }
  // If the test plan yields ≥1 result, run thenPlan; else elsePlan (if present).
  | { kind: 'choose'; test: Plan; thenPlan: Plan; elsePlan?: Plan }
  // Filter: same shape as `where`. Distinct name for self-documenting traversals.
  | { kind: 'filter'; plan: Plan }
  // Inverse of `has`: keep elements WITHOUT any of the given property keys.
  // Accepts variadic keys: matches if NONE of the listed keys exist.
  | { kind: 'hasNot'; keys: readonly string[] }
  // 3-arg `has`: filter by both label and key/pred. Common shorthand.
  | { kind: 'hasLabelAnd'; label: string; key: string; pred: Predicate }
  // Like `valueMap` but also includes id and label as `T.id` / `T.label` keys.
  | { kind: 'elementMap'; keys?: readonly string[] }
  // Like `properties` but yields a single map of {key: [values]} rather than per-property.
  | { kind: 'propertyMap'; keys?: readonly string[] }
  // Replace each traverser's value with a constant.
  | { kind: 'constant'; value: unknown }
  // Inside a `repeat` body, the current loop count (number of iterations so far).
  | { kind: 'loops' }
  // Tag the current traverser's value with `label` so a downstream `select`
  // can recall it. Stored on the traverser itself; not a side effect.
  | { kind: 'as'; label: string }
  // Pull labeled positions back out. With one label, replaces the traverser
  // value with the tagged value. With multiple labels, yields an object
  // `{[label]: value}`. Traversers missing any selected label are dropped.
  // `pop` selects which tag to recall when a label was tagged multiple times
  // (e.g. inside `repeat(out().as('a'))`). Defaults to `'last'`.
  | {
      kind: 'select';
      labels: readonly string[];
      pop?: 'first' | 'last' | 'all';
      // Modulator: project each labeled position via `bys[i]`. If `bys` has
      // fewer entries than labels, the extra labels project as identity.
      bys?: readonly By[];
    }
  // `select(Column.keys)` / `select(Column.values)`: extract a Map's keys or values
  // as a list, preserving entry order (the observable reader for `order(local)`).
  | { kind: 'selectColumn'; column: 'keys' | 'values' }
  // Aggregation: collect the entire stream into one Map<key, value[]>.
  // `keyBy` / `valueBy` are property names for now; full sub-traversal `by()`
  // lands later. Without `keyBy`, group by the value itself; without
  // `valueBy`, the lists hold the elements themselves.
  // Legacy `keyBy`/`valueBy` are property names. `bys[0]` overrides keyBy and
  // `bys[1]` overrides valueBy via the modulator form (`group().by(k).by(v)`).
  | { kind: 'group'; keyBy?: string; valueBy?: string; bys?: readonly By[] }
  // Aggregation: like `group`, but values are counts. Legacy `by` is a
  // property name; `bys[0]` is the modulator form.
  | { kind: 'groupCount'; by?: string; bys?: readonly By[] }
  // Per-traverser: yield a `{ [key]: value }` object. `bys[i]` corresponds to
  // `keys[i]` and is a property name; an undefined `by` projects the traverser
  // value itself for that key.
  // `bys[i]` projects the value for `keys[i]`. A missing entry projects the
  // traverser value itself.
  | { kind: 'project'; keys: readonly string[]; bys?: readonly By[] }
  // --- Closure-bearing variants ---
  // These are NOT JSON-serializable. Use `serialize(plan)` to detect this
  // at the boundary if you need to ship a plan over the wire.
  // Each has a sibling sub-plan form (above); the DSL's `map`/`filter`/etc.
  // dispatch on whether the user passed a `StepFn` or a raw closure.
  | { kind: 'mapFn'; fn: MapClosure }
  | { kind: 'flatMapFn'; fn: FlatMapClosure }
  | { kind: 'filterFn'; fn: FilterClosure }
  | { kind: 'sideEffectFn'; fn: SideEffectClosure }
  | { kind: 'foldFn'; seed: unknown; fn: ReducerClosure }
  // Run a sub-plan for its effect and pass the original traverser through unchanged.
  | { kind: 'sideEffect'; plan: Plan }
  // Run a sub-plan as a "barrier": the body sees only the current traverser,
  // not the whole stream. Useful for `local(out().count())` semantics.
  | { kind: 'local'; plan: Plan }
  // Side-effect: collect each traverser into a named bag in the run's
  // sideEffects map. Pass the traverser through unchanged.
  | { kind: 'aggregate'; key: string }
  // Like `aggregate`, but lazy/eager-agnostic alias name. In TinkerPop,
  // `store` is the lazy form (no barrier); `aggregate` collects with a
  // barrier. In v2 our `aggregate` is already lazy (per-traverser yield), so
  // `store` is a semantic alias today. Kept distinct in the AST so a future
  // optimizer pass can introduce the barrier on `aggregate` without breaking
  // `store` semantics.
  | { kind: 'store'; key: string }
  // Read back from the sideEffects map. Replaces the stream with the bag.
  | { kind: 'cap'; key: string }
  // Materialization point: drain the upstream into a list, then re-emit. With
  // bulk traversers this would also collapse duplicates; v2 has no bulk, so
  // `barrier()` is a forced eager-evaluation marker. Useful before steps that
  // depend on full upstream availability (e.g. before a sub-plan that closes
  // over side-effects populated upstream).
  | { kind: 'barrier' }
  // Terminal: collect all traversers' paths into a nested map. Each path
  // becomes a chain of map keys (path[0] -> path[1] -> ... -> {}). `bys` project
  // each path element before it becomes a key (cycling, as in `path().by(...)`).
  | { kind: 'tree'; bys?: readonly By[] }
  // Switch over a sub-plan's first result. Per traverser, run `test`; route
  // to the first option whose `match` equals that result, else `default`.
  | {
      kind: 'branch';
      test: Plan;
      options: readonly { match: unknown; plan: Plan }[];
      default?: Plan;
    }
  // Replace each traverser's value with all outputs of the sub-plan
  // (zero or more per traverser).
  | { kind: 'flatMap'; plan: Plan }
  // Replace each traverser's value with the first output of the sub-plan.
  // Drops the traverser if the sub-plan yields nothing.
  | { kind: 'map'; plan: Plan }
  // Random subset of N traversers. Materializes the stream.
  | { kind: 'sample'; n: number }
  // Yield the value of a property/edge as if already projected. For Vertex/Edge
  // this is the value as-is; for `{key, value}` property objects (from
  // `properties()`), unwrap to the value field.
  | { kind: 'value' }
  // Annotate stream with positional indexes: each traverser becomes
  // `[value, index]`.
  | { kind: 'index' }
  // Evaluate an arithmetic expression on traverser values. `_` references the
  // current traverser value; other identifiers reference `as_`-bound labels.
  // `bys` project each operand (by first-appearance order, cycling) — e.g.
  // `math('a + b').by('age')` sums the `age` of the values tagged `a` and `b`.
  | { kind: 'math'; expr: string; bys?: readonly By[] }
  // Filter property objects (`{key, value}`) by their `value` field.
  | { kind: 'hasValue'; values: readonly unknown[] }
  // Declarative pattern match across labeled positions.
  | { kind: 'match'; patterns: readonly Plan[] }
  // Side-effect: accumulate matching edges into a named subgraph.
  | { kind: 'subgraph'; key: string }
  // Emit the shortest vertex path(s) from each source vertex. `target` (set via
  // `.with(ShortestPath.target, …)`) filters which vertices are destinations;
  // absent ⇒ every reachable vertex. `direction` (set via `.with(ShortestPath.edges,
  // Direction.OUT|IN|BOTH)`) picks which incident edges the BFS follows — `'both'`
  // (default, TinkerPop-conformant undirected), `'out'`, or `'in'`.
  | { kind: 'shortestPath'; target?: Plan; direction?: Direction }
  // --- OLAP graph algorithms (computed locally) -------------------------
  //
  // Each step runs a whole-graph algorithm and writes a per-vertex result to a
  // property, then passes the incoming traversers through so a downstream step
  // reads it (`g.V().pageRank().order().by('gremlin.pageRankVertexProgram.pageRank')`).
  // `property` overrides the default TinkerPop column name (via
  // `.with(<Algo>.propertyName, …)`); `times` sets the iteration count
  // (`.with(<Algo>.times, …)`); PageRank's `alpha` is the damping factor.
  // `withComputer()` is accepted upstream as a no-op — lenke always computes
  // in-process — so it leaves no step.
  | { kind: 'pageRank'; property?: string; times?: number; alpha?: number; edgeLabel?: string }
  | { kind: 'connectedComponent'; property?: string; edgeLabel?: string }
  | { kind: 'peerPressure'; property?: string; times?: number; edgeLabel?: string }
  // --- Mutation (graph-write) -------------------------------------------
  //
  // `addV(label?)` inserts a fresh vertex into the graph. The output stream
  // contains the new vertex. Subsequent `property(...)` calls bind values to
  // it. With no label, the vertex is created label-less.
  | { kind: 'addV'; label?: string }
  // `addE(label).from(X).to(Y)` inserts an edge between two vertex endpoints.
  // Each endpoint is one of:
  //   - undefined   → fall back to the current traverser value
  //   - tag string  → recall a previously `as(label)`-tagged vertex
  //   - sub-plan    → run a sub-plan and use its first emitted vertex
  // If both `from` and `to` are undefined the current traverser is treated as
  // the OUT (from) endpoint and the executor throws — IN must be specified.
  // The output stream contains the new edge.
  | {
      kind: 'addE';
      label: string;
      from?: AddEEndpoint;
      to?: AddEEndpoint;
    }
  // `property(key, value)` overwrites a single property on the current
  // vertex/edge. Output stream contains the (mutated) element.
  // `cardinality` is recorded for spec parity but v2 stores properties as
  // `Record<string, unknown>` (single-valued); `'list'` and `'set'` currently
  // behave the same as `'single'`. Once multi-cardinality lands, this is the
  // hook the executor will read.
  | {
      kind: 'property';
      key: string;
      value: unknown;
      cardinality?: 'single' | 'list' | 'set';
    }
  // `drop()` removes the current vertex/edge from the graph and emits nothing
  // for that traverser. Dropping a vertex cascades through any edges
  // attached to it (per `Graph.removeVertex`).
  | { kind: 'drop' }
  // `withSack(init)` enables the per-traverser sack (default `init`).
  | { kind: 'withSack'; init: unknown }
  // `sack()` emits the current sack; `sack(op).by(proj)` merges the projected
  // value into the sack via `op` and passes the traverser through.
  | { kind: 'sack'; op?: SackOp; bys?: readonly By[] };

/**
 * Endpoint specification for `addE(...).from(X)` / `.to(X)`.
 *  - `'tag'`  — recall a previously `as(label)`-tagged vertex by name
 *  - `'plan'` — run a sub-plan and use its first emitted vertex
 */
export type AddEEndpoint = { kind: 'tag'; label: string } | { kind: 'plan'; plan: Plan };

export type Plan = {
  readonly steps: readonly Step[];
  /**
   * Does any step anywhere in this plan tree read the traverser path?
   *
   * ⚠️ CARRIED BY CONSTRUCTION, NOT COMPUTED AT EXECUTION (item 1504). `toArray` used to answer
   * this by walking the whole plan tree on EVERY call, which item 1503 measured as part of a
   * 315-456 ns per-call overhead on shapes whose graph work is 2-5 ns. That item also tried the
   * obvious fix — a `WeakMap<Plan, boolean>` memo — and rejected it: 1.52-1.61x for a REUSED plan
   * but **1.07-1.15x WORSE for a REBUILT one**, because a freshly built plan never hits the memo
   * and pays the set. An application that constructs its traversal in the request handler would
   * have paid for a win it never collected.
   *
   * Computing it here wins both arms. Every combinator already allocates a new `Plan`, so the
   * marginal cost is one OR per step — and the recursion disappears: a nested plan was built
   * FIRST, so its own flag is already true or false and the parent just reads it. No walk, no
   * cache, nothing to invalidate.
   *
   * ⚠️ CONSERVATIVE IN THE SAFE DIRECTION. A plan rewritten by `effectivePlan` keeps this flag via
   * `{ ...plan, steps }`, and a rewrite can only MERGE or REMOVE steps — never introduce a
   * path-dependent one that was not already inside the step it replaced. So a carried-over `true`
   * may be stale, which merely declines an optimisation; a stale `false` is unreachable.
   */
  readonly readsPath: boolean;
  /**
   * Which GATE KINDS appear among this plan's OWN top-level steps, as a bitmask.
   *
   * ⚠️ IT EXISTS SO `effectivePlan` CAN SKIP PASSES THAT CANNOT FIRE (item 1505). After item 1504
   * removed the path walk, a profile of a reused plan put `effectivePlan`'s six rewrite passes at
   * **32.2%** of a 208 ns call — and for a plan like `V().count()` every one of them walks the step
   * list looking for a `local`, a `union`, an edge step or a `values` that is not there. The bit
   * says "do not bother" in one test.
   *
   * ⚠️ TOP-LEVEL ONLY, DELIBERATELY. Each gated pass iterates `plan.steps` and never recurses, so a
   * `union` buried in a sub-plan is not something they can fuse — including it would make the mask
   * pessimistic and the gate useless. This is why, unlike {@link Plan.readsPath}, there is no
   * inner-plan propagation here.
   *
   * ⚠️ AND IT MUST BE RECOMPUTED BY ANY PASS THAT CHANGES THE STEPS. `fuseLocal` runs first and
   * INLINES a sub-plan's steps into the top level, so it can introduce a `union` or a `values` that
   * was not there before; a later gate reading the original mask would wrongly skip. Every rewrite
   * that returns a new plan therefore recomputes via {@link maskOfSteps} — which costs nothing in
   * the common case, because a pass that fuses nothing returns the plan it was given.
   */
  readonly kinds: number;
  /**
   * Can `checkStep` raise for any step in this plan's own top-level steps?
   *
   * ⚠️ A BOOLEAN RATHER THAN A BIT, because the gate set is 25 kinds and the mask is already 13
   * bits deep — JS bitwise operators are 32-bit, so there is no room and no reason to crowd it.
   *
   * When false, `checkSteps`' entire frontier walk is skippable: it exists only to decide which
   * frontier each step sees, and nothing downstream of it can fault. That walk was **27.5%** of a
   * 123 ns reused-plan call (`checkStep` 12.8% + `nextHasEdge` 6.9% + `checkSteps` 5.2% +
   * `assertFrontierTypes` 2.6%) — the largest group left after items 1504-1506.
   */
  readonly mayFault: boolean;
};

/**
 * The step kinds that gate a rewrite pass in `effectivePlan`, one bit each.
 *
 * Only these kinds get a bit: the mask is a gate, not an index of the plan. `flattenFilterWrappers`
 * and `dropVacuousLabels` are absent on purpose — the first can fold a PRESENCE filter at any
 * element position (item 1141), so its precondition is not a kind set, and the second is already
 * gated cheaply on `steps[0]` being `V`/`E`.
 */
export const KIND_BITS: Readonly<Record<string, number>> = {
  local: 1,
  union: 2,
  values: 4,
  outE: 8,
  inE: 16,
  bothE: 32,
  // Item 1506. `dropVacuousLabels` only ever drops a label from a `hasLabel` step, so a plan
  // without one has nothing for it to do — and that pass was 10.7% of a 175 ns reused-plan call,
  // plus 2.3% more in the `graph.vertexCount` read it does before looking.
  hasLabel: 64,
  // Item 1506. `flattenFilterWrappers` folds exactly FIVE kinds, and the fifth is the one a reading
  // of the function body misses: `pushSplit` runs on EVERY step at the bottom of the loop and
  // splits `hasLabelAnd` into `hasLabel` + `has` (item 1309). My first gate listed four and the
  // suite failed in two places — the kinds below are enumerated from the code, not from a comment:
  //
  //   not          `presenceFoldOf` — `not(hasNot(k))` <-> `hasKey(k)`
  //   filter       a `filter` around a normalisable branch
  //   or           an `or` chain that is really a membership (items 1312/1332)
  //   and          an `and` whose branches all splice
  //   hasLabelAnd  `pushSplit`, unconditionally per step
  //
  // Nothing else can make the pass change a plan, so a plan with none of these five skips it —
  // which also skips the per-step `streamStaysElements` call that tracks element position (6.8% of
  // a 175 ns reused-plan call) and `pushSplit` itself (3.0%).
  not: 128,
  filter: 256,
  or: 512,
  and: 1024,
  hasLabelAnd: 2048,
  // Item 1507. `assertPlanIsSatisfiable` scans for a `path` step and checks what follows it; with
  // no `path` in the plan its outer loop walks every step and does nothing. It was 7.8% of a 123 ns
  // reused-plan call, with ZERO audit mentions — exactly what an untouched frame looks like.
  path: 4096,
  // Item 1572. `dropUnreadAs` only ever removes an `as` step, so a plan without one has nothing for
  // it to do — the same gate reasoning as `hasLabel` above, and for the same measured reason: a pass
  // that runs on every query shows up in a reused-plan call.
  as: 8192,
  // Item 1643. `seedSingleHasId` turns `V().hasId(x)` into the seeded source `V(x)`, so a plan with
  // no `hasId` has nothing for it to do — the same gate reasoning as `as` and `hasLabel` above.
  hasId: 16_384,
};

/** Every bit an edge-hop fusion cares about. */
export const EDGE_STEP_BITS = KIND_BITS.outE | KIND_BITS.inE | KIND_BITS.bothE;

/** Every bit {@link flattenFilterWrappers} can act on — see the four entries above. */
export const FILTER_WRAPPER_BITS =
  KIND_BITS.not | KIND_BITS.filter | KIND_BITS.or | KIND_BITS.and | KIND_BITS.hasLabelAnd;

/**
 * Step kinds for which `checkStep` can raise. A plan containing NONE of them cannot fault in
 * `checkSteps`, so the whole frontier walk is skippable — see {@link Plan.mayFault}.
 *
 * ⚠️ DERIVED FROM `checkStep`'s SEVEN THROW SITES, each of which needs BOTH a kind and a frontier
 * state. The kind sets alone would be far wider: the first site tests `PATH_INCOMPATIBLE`, which
 * includes `out`, `has`, `values` and `hasLabel` — but it also requires `f === 'path'`, and the ONLY
 * way the frontier becomes `path` is a `path` step. So `path` covers that whole site, and
 * `PATH_INCOMPATIBLE` does not belong here. The remaining six sites each need their own kind
 * present:
 *
 *   ADJ_OR_HOP at an edge/scalar frontier       out, in, both, outE, inE, bothE
 *   PROJECTION at a scalar frontier             values, value, id, label, properties,
 *                                               propertyMap, valueMap, elementMap, key
 *   a non-local numeric reduce over elements    sum, min, max, mean
 *   order over elements                         order
 *   a vertex move with no edge                  inV, outV, bothV, otherV
 *   otherV off a bare edge frontier             otherV
 *
 * ⚠️ BEING WRONG HERE LOSES A FAULT, not an answer — a plan that should raise would run. That is
 * why this is a list read off the throw sites rather than an inference from the kind sets, and why
 * the fault tests in this package are the real gate on it.
 */
const MAY_FAULT_KINDS: ReadonlySet<string> = new Set([
  'path',
  'out',
  'in',
  'both',
  'outE',
  'inE',
  'bothE',
  'values',
  'value',
  'id',
  'label',
  'properties',
  'propertyMap',
  'valueMap',
  'elementMap',
  'key',
  'sum',
  'min',
  'max',
  'mean',
  'order',
  'inV',
  'outV',
  'bothV',
  'otherV',
]);

/**
 * Can this ONE step make `checkStep` raise — counting its nested plans by their own flags?
 *
 * ⚠️ IT MUST PROPAGATE INWARD, unlike {@link Plan.kinds}. `assertFrontierTypes` RECURSES into
 * sub-plans: `V().union(inV())` faults on the vertex-move inside the union arm, exactly as the
 * native engine's parser does. A top-level-only flag would have skipped that check and silently
 * LOST the fault — which is the hole this comment exists to stop being re-opened. Same shape as
 * {@link stepReadsPath}, and for the same reason: a nested plan is built first, so its own flag is
 * already settled.
 */
export const stepMayFault = (step: Step): boolean => {
  if (MAY_FAULT_KINDS.has(step.kind)) {
    return true;
  }

  const fields = step as unknown as Record<string, unknown>;

  for (const name of SUBPLAN_FIELDS) {
    const sub = fields[name] as Plan | undefined;

    if (sub?.mayFault === true) {
      return true;
    }
  }

  if (Array.isArray(fields.plans)) {
    for (const sub of fields.plans as Plan[]) {
      if (sub.mayFault) {
        return true;
      }
    }
  }

  if (Array.isArray(fields.bys)) {
    for (const by of fields.bys as By[]) {
      if (by.kind === 'traversal' && by.plan.mayFault) {
        return true;
      }
    }
  }

  return false;
};

/** Can any step in `steps` make `checkStep` raise? See {@link stepMayFault}. */
export const anyMayFault = (steps: readonly Step[]): boolean => steps.some(stepMayFault);

/** The gate bits present among `steps` — recomputed by any rewrite that changes the step list. */
export const maskOfSteps = (steps: readonly Step[]): number => {
  let mask = 0;

  for (const step of steps) {
    mask |= KIND_BITS[step.kind] ?? 0;
  }

  return mask;
};

export const emptyPlan: Plan = { steps: [], readsPath: false, kinds: 0, mayFault: false };

/**
 * Step kinds that read a traverser's accumulated path. The first five touch `t.path` directly; the
 * closure-bearing kinds hand it to user code via `closureView`, so they are conservatively assumed
 * to read it.
 *
 * ⚠️ MOVED HERE FROM THE EXECUTOR at item 1504, because the flag above is computed at construction
 * and this is AST-level knowledge (which step KINDS are path-dependent), not execution-level. It is
 * exhaustive against every `.path` read in the executor — keep it in sync if a new path-consuming
 * step is added, since a missed entry would silently drop paths.
 */
export const PATH_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
  'path',
  'tree',
  'simplePath',
  'cyclicPath',
  'otherV',
  'mapFn',
  'flatMapFn',
  'filterFn',
  'sideEffectFn',
  'foldFn',
]);

/**
 * Step kinds that provably CANNOT observe a traverser's tags: they read the value (or its structure)
 * and nothing else, carry no user closure, and hold no nested plan.
 *
 * ⚠️ THIS IS AN ALLOWLIST AND THE DEFAULT IS "OBSERVED", which is the opposite direction from
 * {@link PATH_DEPENDENT_KINDS}. The path flag can be a denylist because a missed entry degrades to
 * `NO_PATH` and the suite notices; a missed tag reader would instead read a tag map that
 * `match()`'s solver is still rewriting, which is a SILENT WRONG ANSWER. So a kind earns its place
 * here by inspection, and anything unlisted is assumed to read tags.
 *
 * Deliberately absent, each for a reason:
 *
 *   - `select`, `selectColumn`, `where`, `math`, `match`, `addE` — the actual tag readers.
 *   - `as` — it COPIES `t.tags` to extend it, which is a read of the live map.
 *   - every `*Fn` kind — a user closure receives the traverser and can read anything.
 *   - `group`, `groupCount`, `order`, `project`, `dedupe` — these can carry a `by` traversal, and
 *     `by` is NOT in {@link SUBPLAN_FIELDS}, so the nested-plan check below would not catch it.
 *   - `path`, `tree`, `simplePath`, `cyclicPath`, `otherV` — path-dependent, and `cyclicPath`
 *     shares a dispatch case with `dedupe`.
 */
const TAG_BLIND_KINDS: ReadonlySet<string> = new Set([
  // Terminal aggregates.
  'count',
  'sum',
  'max',
  'min',
  'mean',
  'fold',
  'toList',
  // Value and structure reads.
  'id',
  'label',
  'values',
  'value',
  'valueMap',
  'elementMap',
  'propertyMap',
  'properties',
  'unfold',
  'constant',
  // Predicate filters: the predicate receives the VALUE, never the traverser.
  'has',
  'hasId',
  'hasKey',
  'hasLabel',
  'hasLabelAnd',
  'hasNot',
  'hasValue',
  'is',
  // Hops.
  'out',
  'in',
  'both',
  'outE',
  'inE',
  'bothE',
  'outV',
  'inV',
  // Slicing and no-ops.
  'range',
  'skip',
  'tail',
  'take',
  'barrier',
  'identity',
  'none',
  'drop',
  'fail',
]);

/**
 * Can any step in `steps` from index `from` onward observe a traverser's tags?
 *
 * `match()` asks this of its own suffix so it can skip the per-solution tag snapshot when nothing
 * downstream could read it (item 1560). Conservative in the safe direction: an unlisted kind, a
 * nested plan, or a labelled `dedupe` all answer `true`.
 */
export const tagsObservedFrom = (steps: readonly Step[], from: number): boolean => {
  for (let i = from; i < steps.length; i++) {
    const step = steps[i];

    if (!TAG_BLIND_KINDS.has(step.kind)) {
      return true;
    }

    const fields = step as unknown as Record<string, unknown>;

    for (const name of SUBPLAN_FIELDS) {
      if (fields[name] !== undefined) {
        return true;
      }
    }

    if (Array.isArray(fields.plans) && fields.plans.length > 0) {
      return true;
    }
  }

  return false;
};

/** The step fields that hold a nested plan. */
const SUBPLAN_FIELDS = ['body', 'until', 'emit', 'plan', 'test', 'thenPlan', 'elsePlan'] as const;

/**
 * Does this ONE step read the path, counting its nested plans by their own already-computed flags?
 *
 * No recursion: a nested plan is built before the step that holds it, so `sub.readsPath` is already
 * settled. That is what turns a tree walk per execution into one OR per construction.
 */
export const stepReadsPath = (step: Step): boolean => {
  if (PATH_DEPENDENT_KINDS.has(step.kind)) {
    return true;
  }

  const fields = step as unknown as Record<string, unknown>;

  for (const name of SUBPLAN_FIELDS) {
    const sub = fields[name] as Plan | undefined;

    if (sub?.readsPath === true) {
      return true;
    }
  }

  if (Array.isArray(fields.plans)) {
    for (const sub of fields.plans as Plan[]) {
      if (sub.readsPath) {
        return true;
      }
    }
  }

  if (Array.isArray(fields.bys)) {
    for (const by of fields.bys as By[]) {
      if (by.kind === 'traversal' && by.plan.readsPath) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Brand applied to every DSL-produced `(plan: Plan) => Plan` so the runtime
 * can distinguish a sub-traversal from a user-supplied closure of the same
 * arity. See the dispatch in `steps.ts`'s overloaded constructors (`map`,
 * `filter`, etc.).
 */
export const STEP_FN: unique symbol = Symbol.for('@lenke/gremlin/StepFn');

export type StepFn = ((plan: Plan) => Plan) & { readonly [STEP_FN]: true };

/**
 * Both step flags in ONE walk of the sub-plan fields.
 *
 * ⚠️ IT EXISTS BECAUSE TWO WALKS MEASURED AS A REGRESSION (item 1507). `stepReadsPath` and
 * `stepMayFault` each scan the seven plan-bearing fields plus the two array fields, and calling
 * both per append cost the REBUILT arm 1.12x on a three-step hop (978 → 1094 ns) — handing back a
 * chunk of what the gates had just won on the reused arm. One pass, two booleans, and the rebuilt
 * arm comes back.
 *
 * The two flags keep their own exported functions for callers that need just one (`match.ts` wants
 * `readsPath` over a step SLICE, and the tests assert each independently); this is the hot path's
 * version.
 */
const analyzeStep = (step: Step): { reads: boolean; faults: boolean } => {
  let reads = PATH_DEPENDENT_KINDS.has(step.kind);
  let faults = MAY_FAULT_KINDS.has(step.kind);

  if (reads && faults) {
    return { reads, faults };
  }

  const fields = step as unknown as Record<string, unknown>;

  // ⚠️ EARLY-OUT FOR THE STEPS THAT HAVE NO SUB-PLAN AT ALL, which is almost every step in a real
  // traversal (`out`, `has`, `count`, `values`). Without it the walk below reads nine fields off a
  // step that has none of them, per append — and that cost showed up as a 1.07x regression on the
  // REBUILT arm of a three-step hop, where `out` can fault so the gate cannot pay it back.
  //
  // ⚠️ THE PREMISE IS CHECKED, NOT ASSUMED: every `Step` variant in this file that declares ANY
  // sub-plan field also declares one of these five. Verified by scanning the union — `until`/`emit`
  // only appear on `repeat` (which has `body`), and `thenPlan`/`elsePlan` only on `choose` (which
  // has `test`). A variant that broke that would lose a nested flag, so a new sub-plan-bearing step
  // must carry one of these five or be added here.
  if (
    fields.body === undefined &&
    fields.plan === undefined &&
    fields.plans === undefined &&
    fields.test === undefined &&
    fields.bys === undefined
  ) {
    return { reads, faults };
  }

  const visit = (sub: Plan | undefined): void => {
    if (sub === undefined) {
      return;
    }

    reads = reads || sub.readsPath;
    faults = faults || sub.mayFault;
  };

  for (const name of SUBPLAN_FIELDS) {
    visit(fields[name] as Plan | undefined);
  }

  if (Array.isArray(fields.plans)) {
    for (const sub of fields.plans as Plan[]) {
      visit(sub);
    }
  }

  if (Array.isArray(fields.bys)) {
    for (const by of fields.bys as By[]) {
      if (by.kind === 'traversal') {
        visit(by.plan);
      }
    }
  }

  return { reads, faults };
};

export const appendStep = (step: Step): StepFn => {
  // Computed ONCE per step constructor, not per plan the step is appended to — and in ONE walk.
  const { reads, faults } = analyzeStep(step);
  const bit = KIND_BITS[step.kind] ?? 0;
  const fn = (plan: Plan): Plan => ({
    steps: [...plan.steps, step],
    readsPath: plan.readsPath || reads,
    kinds: plan.kinds | bit,
    mayFault: plan.mayFault || faults,
  });
  // ⚠️ A PLAIN ASSIGNMENT, NOT `Object.defineProperty` — which was **73% of plan construction**
  // (item 1577). Building `traversal(V(id))` went 0.235 -> 0.064 us/op and a three-step plan
  // 0.627 -> 0.137, which is 1.69x on a whole small `V(id)` call since construction is ~30% of it.
  // Gremlin pays this on EVERY call whose value varies, because it has no parameter binding: the id
  // is baked into the step, so there is no plan to reuse the way GQL's `$n` plus its parse/plan
  // cache reuses one.
  //
  // ⚠️ THE `enumerable: false` IT REPLACED BOUGHT NOTHING OBSERVABLE, which is why this is safe:
  // `STEP_FN` is a SYMBOL, and symbols are already excluded from `Object.keys`, `for…in` and
  // `JSON.stringify`. The only way an enumerable symbol escapes is `Object.assign`/spread with the
  // step function as the SOURCE, and every `Object.assign` in this package passes `fn` as the
  // TARGET. `step-fn-marker.test.ts` pins both halves of that claim.
  (fn as unknown as Record<symbol, boolean>)[STEP_FN] = true;

  return fn as StepFn;
};

export const isStepFn = (x: unknown): x is StepFn =>
  typeof x === 'function' && (x as { [STEP_FN]?: boolean })[STEP_FN] === true;

/**
 * Type-only view of a runtime traverser, exposed to user closures. Closures
 * receive the current value AND a read-only view of the carrying traverser
 * so they can read tags, path, loop count.
 */
export type TraverserView = {
  readonly value: unknown;
  readonly path: readonly unknown[];
  readonly loopCount: number;
  readonly tags: ReadonlyMap<string, unknown>;
  readonly sideEffects: ReadonlyMap<string, readonly unknown[]>;
};
