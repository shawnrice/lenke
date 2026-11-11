// Differential fuzzer for GREMLIN. The GQL fuzzers cover reads and writes in the
// other language; Gremlin had a hand-written conformance corpus but no generator,
// and a corpus only covers what someone thought to write down.
//
// One source of truth per case, exactly like gremlin-conformance.test.ts: build a
// random `Plan`, run it on the TS engine directly, emit it to Groovy via
// `planToGremlin` and run THAT on the Rust ENGINE, then compare canonicalized JSON.
// Every iteration therefore also exercises the emitter and `parse.rs`.
//
// It immediately earned its keep: the conformance harness's `canonJson` claimed
// the engine emitted `{id, label}` for an element when it emits the rich
// `{id, labels, properties}` form, and no corpus case returned a bare element — so
// element results were never compared across engines at all. Fixed, with cases.
//
// Seed: random each run (FUZZ_SEED=<n> to replay); the failing seed is printed.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Edge, Graph, isElement } from '@lenke/core';
import {
  isTsOnly,
  cyclicPath,
  in_,
  V,
  E,
  both,
  bothE,
  count,
  dedupe,
  groupCount,
  eq,
  fold,
  gt,
  gte,
  has,
  hasLabel,
  id,
  inE,
  inV,
  label,
  limit,
  lt,
  lte,
  order,
  Order,
  Scope,
  out,
  outE,
  outV,
  otherV,
  path,
  planToGremlin,
  range,
  simplePath,
  skip,
  sum,
  toArray,
  traversal,
  values,
  aggregate,
  and,
  as_,
  barrier,
  cap,
  elementMap,
  hasId,
  hasNot,
  hasValue,
  index,
  match,
  none,
  or,
  pipe,
  properties,
  propertyMap,
  sample,
  select,
  sideEffect,
  store,
  subgraph,
  where,
  createTestTinkerGraph,
  choose,
  coalesce,
  inject,
  optional,
  union,
  type Plan,
} from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './backend-ffi-engine.js';

// Normalize a TS result to the Rust JSON-carrier shape (a copy of the
// conformance suite's `canonJson`; importing it from a *.test.ts pulls in
// `describe`, which only exists under the test runner).
const canonJson = (v: unknown): unknown => {
  // JS `undefined` (e.g. TS `label()` over a path) serializes to `null` in the final JSON, so
  // it is the SAME value both engines emit — normalize it here so `deepSort` sees `null` and not
  // a value whose `JSON.stringify` is `undefined` (which breaks its comparator and mis-sorts only
  // the TS side, reading as a false divergence on `coalesce(...).label().path()`).
  if (v === undefined) {
    return null;
  }

  if (v === null || typeof v === 'boolean' || typeof v === 'string') {
    return v;
  }

  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }

  if (typeof v === 'bigint') {
    return Number(v);
  }

  if (isElement(v)) {
    const props: Record<string, unknown> = {};

    for (const k of Object.keys(v.properties).sort()) {
      props[k] = canonJson(v.properties[k]);
    }

    const labels = [...v.labels].sort();

    return v instanceof Edge
      ? { id: v.id, from: v.from.id, to: v.to.id, labels, properties: props }
      : { id: v.id, labels, properties: props };
  }

  if (Array.isArray(v)) {
    return v.map(canonJson);
  }

  if (v instanceof Map) {
    const o: Record<string, unknown> = {};

    for (const [k, val] of v) {
      o[String(k)] = canonJson(val);
    }

    return o;
  }

  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};

    for (const [k, val] of Object.entries(v)) {
      o[k] = canonJson(val);
    }

    return o;
  }

  return v;
};

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXT}`,
  import.meta.url,
).pathname;
const suite = existsSync(LIB) ? describe : describe.skip;
const backend = existsSync(LIB) ? createFfiEngineBackend(LIB) : null;
const decoder = new TextDecoder();
const MODERN = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  // The second stored null, on a DIFFERENT key, so more than one draw from `KEYS` can reach
  // null placement. With only vertex 5's `age` null, `order(local)` saw a null in 1 run of
  // 400 — present but too thin to be a floor.
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27,"lang":null}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  // A STORED NULL, which is not the same thing as an absent property and is the only way a
  // null reaches a sort here. Measured on a 4-node probe: `g.V().count()` 4 against
  // `g.V().values('k').count()` 3, so an ABSENT key SKIPS the row (TinkerPop's behaviour)
  // while a stored null is YIELDED. Until this line the fixture had no stored null anywhere,
  // so `order(local)`'s null placement -- where native sorted nulls LAST against TS and
  // TinkerPop's FIRST -- was unreachable from this oracle no matter which key was drawn.
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java","age":null}}',
  // TWO labels. Every other vertex here carries exactly one, under which
  // "match any label" and "match the first label" are indistinguishable — which
  // is why this fuzzer ran for a long time without noticing that native's
  // `hasLabel` matched only the first and the TS engine matched any.
  '{"type":"node","id":"13","labels":["PERSON","SOFTWARE"],"properties":{"name":"hybrid","age":40,"lang":"rust"}}',
  // ⚠️ NO ASTRAL / U+E000 STRING IN THIS CORPUS, AND THAT IS A MEASURED DECISION (item 1712).
  // Every `name` here is ASCII, where UTF-16 order already equals code-point order -- so this
  // fuzzer cannot see a string-ordering bug, and it did not: TS Gremlin ordered by code UNIT while
  // the engine orders by code POINT, across 59 `order(` cases, until item 1711 found it by hand.
  //
  // Two vertices carrying U+1F600 and U+E000 WERE added here and then REVERTED, because adding to a
  // shared differential corpus is not free: it reweights every random draw. Nine vertices instead of
  // seven put `orderLocalWithNull` at 0-3 of 400 against its floor of >5 (and one run dropped
  // `orderLocalGenerated` to 4 against >8), so the fuzzer failed on the COUNTER, not on a
  // divergence -- the counter doing exactly its job. Adding stored nulls to both new vertices moved
  // it to 3 at best; the `order(local)` null coverage is thin by nature (8-17 generated of 400) and
  // cannot absorb a 29% change in vertex count.
  //
  // So the TS-side guard is `packages/gremlin/src/string-order.test.ts` (6 tests; 4 of them fail if
  // the fix is reverted, verified) and the three-way view including native is
  // `packages/native/gremlin-order-codepoint-probe.mjs`. ⚠️ STILL OPEN: nothing in CI compares TS
  // against NATIVE on an astral column. The fix for that is a dedicated case with its OWN small
  // corpus, not a second attempt at this one.
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}',
  // TWO types, for the same reason as vertex 13. The label indexes bucket an
  // edge under every type it carries, so `outE('KNOWS','CREATED')` walks one
  // bucket per name and would emit this edge twice, while native makes one
  // adjacency pass and emits it once. With every edge single-typed the two are
  // indistinguishable.
  '{"type":"edge","id":"14","from":"6","to":"1","labels":["KNOWS","CREATED"],"properties":{"weight":0.7}}',
].join('\n');

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Distinct `FUZZ_SEED`s must explore DISJOINT cases. `SEED + i` did not: seeds 1
// and 2 differ in one case out of four hundred, so running eight seeds was ~1.02x
// the coverage of running one, not 8x. Multiplying by a large odd constant gives
// each base seed its own region while keeping a reported seed reproducible.
const caseSeed = (base: number, i: number): number => base * 1_000_003 + i;
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const KEYS = ['name', 'age', 'lang', 'weight', 'missing'];
const VALUES: unknown[] = ['marko', 'lop', 'java', 29, 0.4, 0, -1, '', 'nope'];
// 'NOPE' names nothing (must match nothing, not everything); the rest are real,
// and vertex 13 carries PERSON *and* SOFTWARE so a label filter has to consider
// both of a vertex's labels rather than just the first.
const LABELS = ['PERSON', 'SOFTWARE', 'KNOWS', 'CREATED', 'NOPE'];
const preds = [eq, gt, gte, lt, lte];

// The edge types an adjacency step names. Naming several is a disjunction over
// ONE edge, so edge 14 (KNOWS *and* CREATED) must still be walked once — the
// case a single name can never expose.
// An adjacency step naming TWO OR MORE types, whether or not they all exist.
//
// It used to require a pair of real names, on the reasoning that `NOPE` resolves
// to nothing so `('KNOWS','NOPE')` "selects exactly what `('KNOWS')` does, in
// the same order". The selection is the same; the ORDER is not. What decides the
// order is how many names the step was GIVEN — the TS engine walks a bucket per
// name while native makes one adjacency pass — and that is true of a name that
// matches nothing just as much as one that matches. Measured:
// `g.V().both('KNOWS','NOPE').hasLabel('PERSON').fold()` returned the same six
// vertices from each engine in different orders, a false divergence that made
// this suite red about one run in fifty.
// A `both`/`bothE` step of ANY arity belongs here too, and for the same reason
// one step over: it walks TWO directions, and the engines disagree about which
// comes first (native makes one adjacency pass, out-edges then in-edges; the TS
// engine walks its own). `both('CREATED').values('name').groupCount()` returned
// the same three counts from each engine keyed in different FIRST-SEEN order —
// a false divergence, and one that needs no second type name to appear.
const MULTI_TYPE_STEP = /\b(?:out|in|both)E?\('[^']*'(?:,\s*'[^']*')+\)|\bbothE?\(/;

// coalesce/choose/optional RECONVERGE their arms per-element in TinkerPop and pure-TS (each
// source element's result is contiguous, in input order — a consequence of traverser-at-a-time
// streaming), while native's columnar Plan::Branch concatenates ARM-BY-ARM (all of arm 1, then
// arm 2). Identical multiset, deterministic-but-different order. TinkerPop guarantees output
// order ONLY through order(), so this is the same "order is unspecified" case as multi-type
// adjacency above — compare the shape as a multiset. (union() is arm-by-arm in BOTH engines, so
// it is NOT here; a top-level order() still forces the strict ordered compare.)
const RECONVERGING_BRANCH = /\b(?:coalesce|choose|optional)\(/;

/**
 * Sort a result list when its order is unspecified; otherwise leave it.
 *
 * Recursive, because `fold()` puts the whole result INSIDE a one-element list
 * and the unspecified order is in there. Skipped entirely when the plan orders
 * explicitly — `order()` fixes the order, and sorting would hide a real bug in
 * it.
 */
const deepSort = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    // A TOTAL order: return 0 for equal keys. The old `a < b ? -1 : 1` returned 1 for equal
    // elements, violating the sort contract — an inconsistent comparator gives JSC an
    // implementation-defined result that depends on the INPUT arrangement, so two engines'
    // IDENTICAL multisets sorted from different starting orders came out differently and read
    // as a divergence (`coalesce(...).path()` rows `[v, [v], null]` — same content, shuffled).
    return [...v].map(deepSort).sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);

      if (sa < sb) {
        return -1;
      }

      return sa > sb ? 1 : 0;
    });
  }

  // A map's keys are in FIRST-SEEN order, so when the stream that filled it had
  // no defined order neither do they — `groupCount()` after a multi-type step
  // returns the same tally keyed in a different sequence. Canonicalized only
  // here, for that reason: with a defined input order the two engines agree on
  // map key order exactly, and that comparison stays strict.
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, deepSort(val)]),
    );
  }

  return v;
};

const canonOrder = (rows: unknown, unordered: boolean): unknown =>
  unordered ? deepSort(rows) : rows;

/**
 * A step that takes a POSITIONAL slice of the stream. Over an unspecified order
 * the two engines can slice different elements — `range(0,2)` of seven edges is
 * two edges either way, but not the SAME two — so for those plans only the
 * shape (how many rows, of what kind) is a contract, not the contents. Sorting
 * cannot recover it: the slice already happened.
 */
// A positional slice — top-level (`.skip(1)`) OR at the start of a branch arm
// (`union(skip(1).id(), …)`, no leading dot). A slice over an unspecified order
// picks an unspecified SUBSET wherever it sits, so an arm-internal slice fed by a
// multi-type adjacency (`bothE('CREATED','KNOWS').union(skip(1).id(), dedup())`)
// is just as unspecified as a top-level one — match both spellings.
const SLICING_STEP = /(?:^|[.(,\s])(?:limit|skip|range|tail)\(/;

/**
 * Whether a positional slice happens BEFORE any `order()` — the case where the
 * slice's unspecified subset is what gets ordered, so ordering settles the
 * sequence without settling which rows are in it.
 *
 * An `order()` that comes FIRST does make the slice deterministic, and those
 * plans stay compared.
 */
/**
 * A GLOBAL `order(...)`. `order(local)` is deliberately excluded: `Scope.local` sorts WITHIN each
 * incoming element, so on a stream of scalars it is a NO-OP and leaves the stream order exactly
 * as unspecified as it was. Verified against a real TinkerPop console rather than reasoned about
 * (`podman run -i tinkerpop/gremlin-console`, `createModern()`):
 *
 *     V().id()                       -> [1, 2, 3, 4, 5, 6]
 *     V().order(local).id()          -> [1, 2, 3, 4, 5, 6]
 *     V().order(local).by(desc).id() -> [1, 2, 3, 4, 5, 6]
 *
 * Treating it as an ordering step made this gate INTERMITTENTLY red, roughly one full sweep in
 * three, on `g.V().order(local).by(desc).bothE('CREATED', 'KNOWS').limit(2)` (seed 100286502):
 * ts took edges 7 and 9, native 7 and 8. Both are correct — the slice is over an unspecified
 * order, which is precisely what this skip exists for; the plan slipped through because
 * `order(local)` LOOKED like it settled the sequence.
 */
const GLOBAL_ORDER = /\.order\((?!\s*local\s*\))/;

const slicedBeforeOrdering = (text: string): boolean => {
  const slice = text.search(SLICING_STEP);

  if (slice < 0) {
    return false;
  }

  const ordered = text.search(GLOBAL_ORDER);

  return ordered < 0 || slice < ordered;
};

/**
 * A zero-row slice sitting downstream of a step that can produce a row WITHOUT
 * evaluating the rest of the traversal — the ONE shape where the engines'
 * lazy-vs-eager split is observable.
 *
 * Native is eager: everything above the slice runs. The TS engine is lazy with a
 * one-element pull-ahead (`limit(n)` pulls `n + 1`), so its `limit(0)` normally
 * still touches the upstream and the two agree. They stop agreeing when that
 * single pull is satisfied by a step that yields early:
 *
 *     V().aggregate('x').limit(0).cap('x')            both → 6 vertices
 *     V().aggregate('x').inject(1).limit(1).cap('x')  both → 6 vertices
 *     V().aggregate('x').inject(1).limit(0).cap('x')  native → 6, TS → []
 *
 * `inject` shields the upstream by yielding an injected value first; a BRANCH
 * step shields its later branches by yielding the first branch's row, which is
 * how the second case turned up —
 * `V().union(out('KNOWS'), has('age', gte('lop')).label()).limit(0).values('age')`,
 * where the number-vs-string compare in the second branch faults natively and is
 * never reached in TS.
 *
 * So this is NOT a limit(0) rule and NOT confined to erroneous queries — the
 * middle case above is valid and the divergence is in the answer. Resolving it
 * means making native lazy or TS eager, which is architectural; until that is
 * decided the shape is skipped BY NAME (and counted) rather than either engine
 * changing quietly, and the Rust side pins its half in
 * the `p1_side_effect_*` tests in `tests/gremlin_ported.rs`. (The old name
 * `a_zero_limit_does_not_cancel_an_upstream_side_effect` is xref:gone.)
 *
 * Found by the fuzzer at seeds 4 and 24, both only reachable once distinct seeds
 * began exploring disjoint cases.
 */
const ZERO_SLICE = /\.(?:limit\(0\)|range\((\d+),\s*\1\))/;

/** Steps that can yield a row without evaluating what feeds them. */
const EARLY_YIELDING_STEP = /\.(?:inject|union|coalesce|choose|optional)\(/;

const zeroSliceFedByEarlyYield = (text: string): boolean => {
  const slice = text.search(ZERO_SLICE);

  if (slice < 0) {
    return false;
  }

  const shield = text.search(EARLY_YIELDING_STEP);

  return shield >= 0 && shield < slice;
};

/**
 * An `order()` at the TOP level of the traversal — not one nested inside a
 * sub-traversal.
 *
 * The distinction is load-bearing, and `text.includes('.order(')` got it wrong.
 * A multi-type adjacency step has unspecified per-vertex order, and a following
 * top-level `order()` settles it; an `order()` inside a BRANCH body does not,
 * because it sorts only within that branch while a sibling branch's rows keep the
 * unspecified order. `FUZZ_SEED=42` reported
 * `union(out('KNOWS').out('CREATED','KNOWS'), order().by(desc).order()).fold()`
 * as a divergence for exactly that reason: same twelve elements, three of them in
 * a different sequence, and the nested `order()` had switched the multiset
 * comparison off. Verified as NOT an engine difference — the lowered and streamed
 * routes return the same rows in the same order, so the two engines simply walked
 * a two-type adjacency differently, which is the case the flag exists for.
 */
const hasTopLevelOrder = (text: string): boolean => {
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (c === '(') {
      // `order(local)` is NOT a top-level order: it sorts WITHIN each traverser's value and
      // leaves the stream's order exactly as it found it. Counting it as one switched the
      // multiset comparison off for a multi-type hop whose adjacency order is unspecified, and
      // the suite then reported a false divergence — the same 7 elements in a different order
      // for `g.V().order(local).by(desc).out('KNOWS', 'CREATED')` (FUZZ_SEED=2907042784).
      if (
        depth === 0 &&
        text.startsWith('.order(', i - 6) &&
        !text.startsWith('.order(local', i - 6)
      ) {
        return true;
      }

      depth += 1;
    } else if (c === ')') {
      depth -= 1;
    }
  }

  return false;
};

// `order()` over a stream of PATHS (a path()/tree() before the order) has no cross-engine
// contract: a path contains graph elements, and elements have no natural order, so native
// (orders by element id) and the TS engine (stable / input order) legitimately disagree while
// TinkerPop specifies its own third order. The MULTISET of paths is identical, so compare it
// unordered — same policy as an unspecified adjacency / reconverging-branch order.
const orderOverPaths = (text: string): boolean => {
  const p = Math.min(
    ...['path()', 'tree()'].map((s) => {
      const i = text.indexOf(s);

      return i < 0 ? Infinity : i;
    }),
  );
  // The LAST `order(`, not the first (item 561). With TWO orders and a `path()` between them —
  // `g.V().label().order().by(desc).path().order().by(desc).fold()` — the first `order(` sits
  // BEFORE the path, so `indexOf` put `o` ahead of `p` and this answered false. The second order
  // is over a PATH STREAM all the same, and the suite then compared two unspecified orders as a
  // SEQUENCE and went red on a seed that replays: both engines returned the same seven paths in
  // different orders.
  //
  // Asking for the last one is the whole fix: if ANY `order(` follows a `path()`/`tree()`, the
  // stream being sorted is a path stream and its order is unspecified.
  const o = text.lastIndexOf('order(');

  return o >= 0 && p < o;
};

const etypes = (r: () => number): string[] =>
  pick(r, [
    ['KNOWS'],
    ['CREATED'],
    ['KNOWS', 'CREATED'],
    ['CREATED', 'KNOWS'],
    ['KNOWS', 'NOPE'],
    // EVERY name unknown. Distinct from the mixed case: the count shortcut takes
    // a different branch for "matches nothing", and it used to take it before
    // confirming the traversal was a count at all — so `g.V().outE('NOPE')` came
    // back as the NUMBER 0 rather than an empty stream. Nothing generated this.
    ['NOPE'],
    ['NOPE', 'ALSO_NOPE'],
  ]);

// A sub-traversal for the branching steps: one or two ordinary steps, and NEVER
// another branch. Bounded deliberately — a recursive generator produces traversals
// whose cost is exponential in the nesting depth, and the point here is coverage
// of the branch STEPS, not of arbitrarily deep nesting.
const subPlan = (r: () => number): Plan => {
  const n = 1 + Math.floor(r() * 2);

  return traversal(...(Array.from({ length: n }, () => step(r)) as never[]));
};

// The branching steps. None of these was generated at all, and neither was
// `inject` — so `union`/`coalesce`/`choose`/`optional` had no differential
// coverage whatever, and `coalesce`/`choose`/`optional` could not even be EMITTED
// as text until the cases were added to the emitter.
//
// Order matters and is part of what is being checked: `union` concatenates its
// branches in order, `coalesce` yields the first branch that emits anything, and
// `inject` ADDS to the stream rather than replacing it (so a sub-traversal that
// injects also passes its incoming traverser through).
const branchStep = (r: () => number): unknown => {
  const p = r();

  if (p < 0.35) {
    return union(subPlan(r), subPlan(r));
  }

  if (p < 0.6) {
    return coalesce(subPlan(r), subPlan(r));
  }

  if (p < 0.75) {
    return optional(subPlan(r));
  }

  if (p < 0.9) {
    // Both arities: the presence of an else branch is the meaning, not a detail.
    return r() < 0.5 ? choose(subPlan(r), subPlan(r)) : choose(subPlan(r), subPlan(r), subPlan(r));
  }

  return inject(...(pick(r, [['x'], [1], ['a', 'b'], [0]]) as never[]));
};

// Steps that move the traverser, filter it, or reshape it — everything that can
// cross the Groovy text boundary (no JS closures, no non-finite literals).
const step = (r: () => number): unknown => {
  const p = r();

  if (p < 0.13) {
    return out(...etypes(r));
  }

  if (p < 0.22) {
    return outE(...etypes(r));
  }

  if (p < 0.28) {
    return inE(...etypes(r));
  }

  if (p < 0.33) {
    return both(...etypes(r));
  }

  if (p < 0.37) {
    return bothE(...etypes(r));
  }

  if (p < 0.41) {
    return inV();
  }

  if (p < 0.45) {
    return outV();
  }

  if (p < 0.48) {
    return otherV();
  }

  if (p < 0.58) {
    return has(pick(r, KEYS), pick(r, preds)(pick(r, VALUES)));
  }

  if (p < 0.63) {
    return hasLabel(pick(r, LABELS));
  }

  if (p < 0.68) {
    return values(pick(r, KEYS));
  }

  if (p < 0.71) {
    return label();
  }

  if (p < 0.74) {
    return id();
  }

  if (p < 0.78) {
    return dedupe();
  }

  if (p < 0.82) {
    return limit(Math.floor(r() * 4));
  }

  if (p < 0.85) {
    return skip(Math.floor(r() * 3));
  }

  if (p < 0.88) {
    // The high bound must be >= the low one, or the step throws at BUILD time and the
    // plan is dropped before either engine sees it — 6 of every 400 were being wasted that
    // way. A zero-width window (`hi == lo`) is kept on purpose: it is legal, and the
    // `ZERO_SLICE` guard below has a principled reason for skipping those.
    const lo = Math.floor(r() * 2);

    return range(lo, lo + Math.floor(r() * 3));
  }

  if (p < 0.91) {
    return order(pick(r, [Order.asc, Order.desc]));
  }

  // NOT `simplePath()` here. Native supports it only "over a pure vertex-hop chain
  // (V-source + out/in/both)" and says so with a coded error; the general pool would place
  // it after `inE`, inside `coalesce`, or after `path()`, where TS's superset accepts it and
  // native rejects it. That is a capability gap already tracked in the deferred-feature
  // backlog, not something this fuzzer can decide, and generating it would bury the step's
  // real coverage under noise. `pureVertexChain` below generates it where BOTH engines
  // implement it.

  if (p < 0.97) {
    return path();
  }

  // `order(Scope.local)` — which NEITHER this fuzzer nor the 93-case conformance suite
  // generated: zero mentions of `local` between them. That gap let native silently return
  // ZERO rows for `g.V().order(local).out('R')` for as long as the step has existed, while TS
  // answered correctly (item 87, found by asking why a no-op cost 7.62ns a row).
  //
  // The step has two jobs and they need different inputs. Over a SCALAR frontier — a vertex,
  // an edge, a property value — it is a PASS-THROUGH, which is the half that was broken and
  // the half this pool reaches, since the frontier here is whatever the preceding steps left.
  // Over a COLLECTION it sorts, and `fold()` is how to get one: the pair below emits
  // `fold().order(local)` so both halves are drawn. `by(keys)`/`by(values)` only mean
  // something for a Map, so they sit with the Map-producing shapes rather than here.
  //
  // Placed last, above the fallback, so it takes no other arm's band.
  if (p < 0.99) {
    return r() < 0.5 ? order(Scope.local) : order(Scope.local).by(Order.desc);
  }

  return count();
};

/**
 * The COLLECTION half of `order(Scope.local)`.
 */
const orderLocalCollection = (r: () => number): unknown[] => {
  // The COLLECTION half of `order(Scope.local)` — a `fold()` makes the list it sorts, which
  // the step pool cannot reach on its own (its frontier is whatever came before, and that is
  // a scalar). Withheld when the arm was added (item 88) because it was red against two
  // pre-existing divergences; the element one is fixed (item 89) and `values(…)` keeps the
  // list free of elements, so what remains is a list of property VALUES.
  //
  // NOT a bare `fold()`: that folds the frontier itself, which is a list of ELEMENTS, and
  // both engines now correctly FAULT on ordering one — comparing two identical errors is no
  // coverage. `values(…)` first is what makes the list orderable.
  //
  // The key is DRAWN, not fixed. It used to be pinned to `name` on the belief that other
  // keys would inject nulls (then a live divergence) because some vertices lack them. That
  // reasoning was wrong twice over: an ABSENT property SKIPS the row rather than yielding
  // null, so a drawn key injected nothing; and the null divergence itself is fixed, with
  // `age` on vertex 5 now a STORED null so this arm reaches null placement deliberately.
  // BIASED toward the two keys that carry a stored null, because the unbiased draw did not
  // reach null placement reliably: one key in five, times a frontier that has to include
  // the right vertex, gave 2/0/1 nulls across seeds 1/7/42 — and a floor that a seed can
  // miss is not a floor. Every key is still reachable; this only shifts the weight.
  const k = r() < 0.6 ? pick(r, ['age', 'lang']) : pick(r, KEYS);

  return r() < 0.5
    ? [values(k), fold(), order(Scope.local)]
    : [values(k), fold(), order(Scope.local).by(Order.desc)];
};

const terminal = (r: () => number): unknown[] => {
  const p = r();

  if (p < 0.3) {
    return [count()];
  }

  if (p < 0.45) {
    return [fold()];
  }

  if (p < 0.6) {
    return [values(pick(r, KEYS))];
  }

  if (p < 0.7) {
    return [sum()];
  }

  if (p < 0.8) {
    return [dedupe(), count()];
  }

  if (p < 0.85) {
    return orderLocalCollection(r);
  }

  if (p < 0.9) {
    // `groupCount()` was not generated at all, and its map is ORDER-observable
    // (first-seen), so a tally that agreed on the counts and not on the order
    // would have gone unnoticed. Native answers it two ways — straight off a
    // property column when the prefix lowers, otherwise through the stream — so
    // this has to cross-check both against the TS engine.
    return [values(pick(r, KEYS)), groupCount()];
  }

  // A SECOND window for the collection arm, taken from the bare no-terminal tail and from
  // nothing else — every other terminal's weight is unchanged. At one window (5%) the arm
  // reached a list CONTAINING a null in 2/1/1 runs of 400 across seeds 1/7/42, because the
  // key has to be the null-bearing one AND the frontier has to still hold that vertex. A
  // floor a seed can miss is not a floor.
  if (p < 0.95) {
    return orderLocalCollection(r);
  }

  return [];
};

/**
 * A V-source followed only by vertex hops, then `simplePath()` or `cyclicPath()` — the one
 * position native implements those two in. Worth its own shape because they are otherwise
 * untested end-to-end: the emitter could not render them at all until this pass, so 28 of
 * every 400 plans were dropped before either engine saw them, and the step was never
 * compared.
 */
/**
 * `V()` straight into `values(<a key with a stored null>)`, `fold()` and `order(Scope.local)`,
 * with NOTHING in between.
 *
 * Its own shape for the reason `pureVertexChain` is: the general generator could not reach it
 * reliably. Null placement in a locally-sorted list was the second of the two divergences the
 * `order(local)` arm found, and it needs a list that actually CONTAINS a null — which needs
 * the null-bearing vertex still in the frontier. Through the ordinary pipeline the 1-4
 * intervening steps usually hop or filter it away: with the collection arm at twice its
 * weight, a list containing a null turned up 2/2/1/4/4/0/1/2 times in 400 across seeds
 * 1/7/42/2977/3/11/99/12345 — and seed 11 found NONE, so there was no floor to set. With no
 * steps in between the null is always in the list.
 */
const nullOrderLocalChain = (r: () => number): Plan => {
  const k = pick(r, ['age', 'lang']);

  return r() < 0.5
    ? traversal(V(), values(k), fold(), order(Scope.local))
    : traversal(V(), values(k), fold(), order(Scope.local).by(Order.desc));
};

const pureVertexChain = (r: () => number): Plan => {
  const hops = 1 + Math.floor(r() * 3);
  const steps = Array.from({ length: hops }, () =>
    pick(r, [() => out(), () => in_(), () => both()])(),
  );
  const filter = r() < 0.5 ? simplePath() : cyclicPath();
  const tail = r() < 0.5 ? [path()] : [count()];

  return traversal(V(), ...(steps as never[]), filter, ...(tail as never[]));
};

const genPlan = (r: () => number): Plan => {
  // One in eight plans is the pure vertex-hop shape, so the path filters get real
  // end-to-end coverage without crowding out everything else.
  if (r() < 0.125) {
    return pureVertexChain(r);
  }

  // One plan in twenty-five is the guaranteed-null local sort. See `nullOrderLocalChain`.
  if (r() < 0.04) {
    return nullOrderLocalChain(r);
  }

  const start = r() < 0.8 ? V() : E();
  const n = 1 + Math.floor(r() * 4);
  // A branch step in about a fifth of plans. Kept to at most one per plan: two
  // nested branches multiply the row count fast enough to dominate the run
  // without covering anything the single case does not.
  const branchAt = r() < 0.2 ? Math.floor(r() * n) : -1;
  const steps = Array.from({ length: n }, (_, i) => (i === branchAt ? branchStep(r) : step(r)));

  return traversal(start, ...(steps as never[]), ...(terminal(r) as never[]));
};

const nativeRun = (text: string): unknown[] => {
  const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN));

  try {
    return JSON.parse(decoder.decode(backend!.gremlinJson(handle, text))) as unknown[];
  } finally {
    backend!.graphFree(handle);
  }
};

suite('differential fuzz: gremlin (TS engine vs Rust ENGINE)', () => {
  // ONE fixture for both engines. The TS side used to build from
  // `createTestTinkerGraph()` while the native side decoded `MODERN`, so the two
  // definitions could drift and any drift read as a divergence — which is
  // exactly what happened when the multi-label vertex was added to only one of
  // them. `createTestTinkerGraph` is the canonical TinkerPop Modern graph and is
  // shared with the conformance suite, so the extra vertex is added HERE rather
  // than to it.
  const tsGraph = createTestTinkerGraph();

  // Mirrors the stored null on vertex 5 in `MODERN`. ONE fixture for both engines, so this
  // has to be patched on both sides or the drift itself reads as a divergence.
  tsGraph.getVertexById('5')!.setProperty('age', null);
  tsGraph.getVertexById('2')!.setProperty('lang', null);

  tsGraph.addVertex({
    id: '13',
    labels: ['PERSON', 'SOFTWARE'],
    properties: { name: 'hybrid', age: 40, lang: 'rust' },
  });
  tsGraph.addEdge({
    id: '14',
    from: tsGraph.getVertexById('6')!,
    to: tsGraph.getVertexById('1')!,
    labels: ['KNOWS', 'CREATED'],
    properties: { weight: 0.7 },
  });
  const SEED =
    process.env.FUZZ_SEED === undefined
      ? Math.floor(Math.random() * 0x1_0000_0000)
      : Number(process.env.FUZZ_SEED) >>> 0;
  const ITERATIONS = 400;

  test(`${ITERATIONS} random traversals agree across the engines`, () => {
    const divergences: string[] = [];
    // `order(local)` coverage. GENERATION IS NOT COVERAGE: the arm is in the step pool, but
    // the frontier it lands on is whatever the preceding steps left, so the non-empty count is
    // the one that means anything — a pass-through over an EMPTY frontier passes whatever the
    // step does.
    let orderLocalGenerated = 0;
    let orderLocalNonEmpty = 0;
    // A third floor, because the other two can both be met without a single null in sight —
    // which is exactly how the null placement stayed hidden while the arm was pinned to
    // `name`. This one counts a locally-sorted result that actually CONTAINED a null.
    // Measured 8-23 across thirteen seeds once both null bugs were fixed, so the floor
    // below sits under the observed minimum rather than at it.
    let orderLocalWithNull = 0;
    let skippedUnordered = 0;
    let skippedUnbuildable = 0;
    let skippedLazySlice = 0;

    for (let i = 0; i < ITERATIONS && divergences.length < 5; i++) {
      const r = mulberry32(caseSeed(SEED, i));
      let plan: Plan;
      let text: string;

      try {
        plan = genPlan(r);
        text = planToGremlin(plan);
      } catch (e) {
        // CLASSIFY, rather than swallow. Two very different things land here:
        //
        //   * a kind that cannot cross the text boundary by design — a closure, a
        //     non-finite literal — which only exists in the TS superset and has no native
        //     form. `isTsOnly` identifies exactly those, and the emitter exports it saying
        //     "so the runner can classify (tsOnly) vs surface (emitter gap)". The runner
        //     never did.
        //   * an EMITTER GAP, or a step the builder refuses to construct. Those are lost
        //     coverage wearing a skip's clothing. `order(desc)` threw for years ("Expected
        //     Scope.local or Scope.global"), so every plan the generator gave a direction
        //     to was dropped and the step was never compared against native at all. The
        //     emitter was also missing `simplePath`/`cyclicPath` — both fully implemented
        //     on BOTH sides — which cost 28 of every 400 plans until this check surfaced
        //     them.
        //
        // So the first is a skip and the second is a FINDING.
        if (isTsOnly(e)) {
          skippedUnbuildable += 1;

          continue;
        }

        divergences.push(
          `[seed ${caseSeed(SEED, i)}] a plan could not be BUILT, which is a generator or ` +
            `emitter gap rather than a skip: ${(e as Error).message}`,
        );

        continue;
      }

      const outcome = (run: () => unknown): string => {
        try {
          return JSON.stringify(run());
        } catch (e) {
          return `ERR ${(e as { code?: string }).code ?? 'throw'}`;
        }
      };

      if (text.includes('order(local)')) {
        orderLocalGenerated += 1;
      }

      // Naming two REAL edge types makes the per-vertex adjacency order
      // unspecified: the TS engine walks a bucket per name, native makes one
      // adjacency pass in insertion order, and neither is the contract (see the
      // engines' "order is unspecified" rule — like SQL without ORDER BY). What
      // IS the contract is WHICH elements come back and HOW MANY, so compare
      // those shapes as a multiset. A duplicated multi-type edge still shows up.
      const multiType = MULTI_TYPE_STEP.test(text);
      // Either an unspecified adjacency order (multi-type) OR a per-element reconverging
      // branch (coalesce/choose/optional) leaves the result order unspecified.
      const orderUnspecified = multiType || RECONVERGING_BRANCH.test(text);
      // A path-stream order() is unspecified even WITH a top-level order() (the order() IS the
      // unspecified step), so it forces `unordered` on its own.
      const unordered = (orderUnspecified && !hasTopLevelOrder(text)) || orderOverPaths(text);

      // A positional slice of an unspecified order picks an unspecified SUBSET,
      // and every step after it inherits that — not just the order but which
      // elements, and so the row count too. Nothing survives as a contract, so
      // these are skipped rather than compared. Counted, not silent.
      //
      // A later `order()` does NOT rescue it, which is why this asks about the
      // slice's POSITION rather than reusing `unordered` (that flag is switched
      // off by an `order()` anywhere in the text). Sorting an unspecified subset
      // gives a specified order over the wrong elements:
      // `outE('CREATED','KNOWS').skip(2).order().by(desc)` returned one edge from
      // each engine and they were DIFFERENT edges — a false divergence, and the
      // reason this suite went red about one run in fifteen.
      if (orderUnspecified && slicedBeforeOrdering(text)) {
        skippedUnordered += 1;

        continue;
      }

      // A path-stream `order()` is unspecified (sorting paths-of-elements has no total order),
      // and a slice around it — `path().path().order().by(desc).limit(1)` — then picks an
      // unspecified SUBSET, so even the multiset compare `unordered` grants cannot hold (the
      // dropped rows differ between engines). Skip when a path-order meets any positional slice.
      if (orderOverPaths(text) && SLICING_STEP.test(text)) {
        skippedUnordered += 1;

        continue;
      }

      if (zeroSliceFedByEarlyYield(text)) {
        skippedLazySlice += 1;

        continue;
      }

      const ts = outcome(() => canonOrder(toArray(plan, tsGraph).map(canonJson), unordered));
      const native = outcome(() => canonOrder(nativeRun(text), unordered));

      // NON-EMPTY is the floor that matters: `order(local)` over an empty frontier passes
      // whatever the step does, so only a run that actually carried rows through it is
      // coverage. `[]` and `[0]` (a count of nothing) are the empty answers here.
      if (text.includes('order(local)') && native !== '[]' && native !== '[0]') {
        orderLocalNonEmpty += 1;

        if (native.includes('null')) {
          orderLocalWithNull += 1;
        }
      }

      // Both failing is acceptable — each rejects the query. A divergence is one
      // side succeeding, or both succeeding with different results.
      if (ts !== native && !(ts.startsWith('ERR') && native.startsWith('ERR'))) {
        divergences.push(
          `[seed ${caseSeed(SEED, i)}] ${text}\n    ts:     ${ts}\n    native: ${native}`,
        );
      }
    }

    if (skippedUnbuildable > 0) {
      console.log(
        `  ${skippedUnbuildable}/${ITERATIONS} plans skipped: could not be built or emitted as text`,
      );
    }

    if (skippedLazySlice > 0) {
      console.log(
        `  ${skippedLazySlice}/${ITERATIONS} plans skipped: a zero-row slice below an ` +
          'early-yielding step — the engines differ on whether the upstream runs',
      );
    }

    if (skippedUnordered > 0) {
      console.log(
        `  order(local)=${orderLocalGenerated}/${orderLocalNonEmpty}/${orderLocalWithNull} of ${ITERATIONS} ` +
          'generated/non-empty/with-a-null',
      );
      // ⚠️ `orderLocalWithNull` WAS `> 5` AND FAILED A CLEAN RUN (item 1792). It reported a
      // coverage miss as a fuzzer failure on a GQL-only change, which is the worst thing a gate
      // can do: it costs a real investigation to clear. These three floors were set from a RANGE,
      // the method item 280 called unsafe and item 1098 replaced with mean − 4σ rounded down.
      // Measured over SIXTEEN runs of 400 (12 of the gremlin fuzzer alone plus 4 full sweeps):
      //
      //   band                    floor   min   mean  sigma   was      now
      //   orderLocalWithNull          5     5  16.75   5.60   2.10σ -> 0 (the limit)
      //   orderLocalNonEmpty          5    42  53.75   7.92   6.15  -> unchanged (over-safe)
      //   orderLocalGenerated         8    49  62.75   7.21   7.59  -> unchanged (over-safe)
      //
      // Four sigma below `withNull`'s mean is NEGATIVE, so 0 is the only floor it can carry — the
      // small-count case item 1098 hit with `subOr`: for a band this wide relative to its mean,
      // catching a collapse to ZERO is all a floor can safely do. The other two are 6σ and 7.5σ,
      // and an over-safe floor costs only its own irrelevance.
      expect({
        orderLocalGenerated: orderLocalGenerated > 8,
        orderLocalNonEmpty: orderLocalNonEmpty > 5,
        orderLocalWithNull: orderLocalWithNull > 0,
      }).toEqual({
        orderLocalGenerated: true,
        orderLocalNonEmpty: true,
        orderLocalWithNull: true,
      });

      console.log(
        `  ${skippedUnordered}/${ITERATIONS} plans skipped: a positional slice over an ` +
          'unspecified order has no comparable result',
      );
    }

    const report = divergences.length
      ? `FUZZ_SEED=${SEED} bun test <this file> to reproduce:\n\n${divergences.join('\n\n')}`
      : 'no divergences';

    expect(report).toBe('no divergences');
  });
});

/**
 * THE DENSE MULTI-HOP ROUTE, which nothing above this line can reach (item 1371).
 *
 * `slotChainCount` — the 3+ hop chain count over dense slots with a per-slot neighbour memo (items
 * 1110, 1152) — is DECLINED unless the seed is wider than `max(graph.vertexCount >> 4, 1024)`. The
 * suite above runs on the TinkerPop "modern" graph, about fourteen vertices, so the route is declined
 * on every seed of every run. Item 1370 proved that by mutation: `next[to] += m * 2`, which doubles
 * every 3+ hop count, SURVIVED all seven byte-identity fuzzers while `slot-chain-count.test.ts`
 * caught it. The largest row in `bench:gremlin` had no TS-versus-native coverage at all.
 *
 * This arm is ADDITIVE on purpose. The 400-plan random sweep keeps the small fixture, where it is
 * fast and where every one of its coverage floors was calibrated; widening that fixture would have
 * re-calibrated all of them and multiplied the sweep's cost by the same factor. The dense route
 * instead gets a fixed, small set of traversals on a graph just wide enough to admit it.
 *
 * ONE SOURCE OF TRUTH for the fixture, because the suite above records what two definitions cost:
 * its TS side is built by `createTestTinkerGraph()` and its native side from `MODERN`, and "the two
 * definitions could drift and any drift read as a divergence — which is exactly what happened when
 * the multi-label vertex was added to only one of them". So this generates NDJSON once and
 * deserializes BOTH engines from it.
 */
const DENSE_N = 1100;

/** Past `max(n >> 4, 1024)` — for n under 16384 that cut is a flat 1024, so 1100 admits the route. */
const DENSE_DOC = (() => {
  const lines: string[] = [];

  for (let i = 0; i < DENSE_N; i += 1) {
    lines.push(`{"type":"node","id":"w${i}","labels":["P"],"properties":{"k":${i % 7}}}`);
  }

  // Fanout 2 so a 3-hop count is a real product rather than a chain, and a MINORITY second edge
  // type so a labelled hop and an unlabelled one are different questions — without that, `out('T')`
  // and `out()` would agree for the wrong reason.
  for (let k = 0; k < DENSE_N * 2; k += 1) {
    const t = k % 5 === 0 ? 'U' : 'T';

    lines.push(
      `{"type":"edge","id":"we${k}","labels":["${t}"],` +
        `"from":"w${(k * 7) % DENSE_N}","to":"w${(k * 13 + 3) % DENSE_N}","properties":{}}`,
    );
  }

  return lines.join('\n');
})();

suite('differential fuzz: gremlin DENSE multi-hop route (TS engine vs Rust ENGINE)', () => {
  const tsDense = tsDeserialize(DENSE_DOC, 'ndjson', new Graph());
  const denseBytes = new TextEncoder().encode(DENSE_DOC);

  const nativeDense = (text: string): unknown[] => {
    const handle = backend!.graphFromNdjson(denseBytes);

    try {
      return JSON.parse(decoder.decode(backend!.gremlinJson(handle, text))) as unknown[];
    } finally {
      backend!.graphFree(handle);
    }
  };

  // THE FIXTURE MUST ADMIT THE ROUTE, asserted rather than assumed: this whole arm exists because
  // the suite above silently did not, and a fixture that drifted under the cut would make every
  // case below pass by taking the same generic route in both engines.
  test('the fixture is wide enough to admit the dense route', () => {
    expect(tsDense.vertexCount).toBe(DENSE_N);
    expect(tsDense.vertexCount).toBeGreaterThan(Math.max(tsDense.vertexCount >> 4, 1024));
  });

  const CASES: readonly [string, Plan][] = [
    ['out(T) x3', traversal(V(), out('T'), out('T'), out('T'), count())],
    ['out(T) x4', traversal(V(), out('T'), out('T'), out('T'), out('T'), count())],
    ['out() x3 [every type]', traversal(V(), out(), out(), out(), count())],
    ['in(T) x3', traversal(V(), in_('T'), in_('T'), in_('T'), count())],
    [
      'out(T,U) x3 [multi-type]',
      traversal(V(), out('T', 'U'), out('T', 'U'), out('T', 'U'), count()),
    ],
    // The CONTROL: two hops are answered by the degree inner product, a different rung that this
    // arm is not about. It must agree too, and if only this one ever diverges the cause is not the
    // dense walk.
    ['out(T) x2 [CONTROL: inner product]', traversal(V(), out('T'), out('T'), count())],
  ];

  for (const [name, plan] of CASES) {
    test(`${name} agrees across the engines`, () => {
      const text = planToGremlin(plan);
      const ts = canonJson(toArray(plan, tsDense));
      const native = canonJson(nativeDense(text));

      expect({ case: name, gremlin: text, result: ts }).toEqual({
        case: name,
        gremlin: text,
        result: native,
      });
    });
  }
});

/**
 * ⚠️ `match()` OVER A MULTIGRAPH — the case that would have caught item 1793's wrong answer, and
 * the TWO reasons the suite above could not.
 *
 *   1. **It never generates `match()` at all.** The step pool has no `match` arm, so no number of
 *      iterations reaches the solver.
 *   2. **Its corpus has no PARALLEL EDGES.** Every `(from, to, type)` in `MODERN` is unique, and
 *      item 1793's divergence needs exactly one repeat: the TS solver deduped a pattern's candidate
 *      end values, so two parallel edges collapsed into one solution where TinkerPop 3.7.3 and the
 *      Rust engine both emit two.
 *
 * ⚠️ A DEDICATED CASE RATHER THAN A WIDER SHARED CORPUS, which is the decision the suite above
 * records twice. Its coverage floors are calibrated on `MODERN`'s exact seven vertices — adding two
 * for the astral-string question put `orderLocalWithNull` at 0-3 against its floor and had to be
 * REVERTED, "the counter doing exactly its job". A parallel edge would reweight every draw the same
 * way for a question that needs four vertices, so this gets its own fixed corpus and its own fixed
 * plans, exactly as the DENSE route above does.
 *
 * ONE SOURCE OF TRUTH: the NDJSON below is deserialized for TS and decoded for native, so the two
 * definitions cannot drift.
 *
 * ⚠️ EVERY MATCH CASE HAS ITS CHAIN TWIN, and that pairing is the point rather than decoration.
 * TinkerPop answers the same number for both (verified against `gremlin-console:3.7.3` at item
 * 1793: `match(a-T->b).count()` and `out(T).count()` are both 3 on a one-parallel-edge chain), so a
 * divergence that moved BOTH engines together would still show up as the match and the chain
 * disagreeing — a second, independent reading of the same question.
 */
const MULTI_DOC = [
  '{"type":"node","id":"m1","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"m2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"m3","labels":["P"],"properties":{"n":3}}',
  // A SINK: no out-edges at all, so a pattern that must bind an end has somewhere to fail.
  '{"type":"node","id":"m4","labels":["P"],"properties":{"n":4}}',
  // THE PARALLEL PAIR — same endpoints, same type, different ids and weights. This is the whole
  // fixture: with only one of these the TS engine answered correctly for two years.
  '{"type":"edge","id":"me1","labels":["T"],"from":"m1","to":"m2","properties":{"w":1}}',
  '{"type":"edge","id":"me2","labels":["T"],"from":"m1","to":"m2","properties":{"w":2}}',
  '{"type":"edge","id":"me3","labels":["T"],"from":"m2","to":"m3","properties":{"w":3}}',
  // A SELF LOOP, where a pattern binds `a` and `b` to the same vertex.
  '{"type":"edge","id":"me4","labels":["T"],"from":"m3","to":"m3","properties":{"w":4}}',
  // A SECOND TYPE on the same endpoints as the parallel pair, so a typed pattern and an untyped
  // one are different questions — without it `out('T')` and `out()` would agree for the wrong
  // reason.
  '{"type":"edge","id":"me5","labels":["U"],"from":"m1","to":"m2","properties":{"w":5}}',
  // A 2-CYCLE, which is what reaches the solver's OTHER arm: when a later pattern's end tag is
  // ALREADY BOUND, the candidate list is not built at all and the pattern is a consistency test.
  // Parallel edges there are a separate multiplicity question from the one item 1793 fixed.
  '{"type":"edge","id":"me6","labels":["T"],"from":"m3","to":"m1","properties":{"w":6}}',
  '{"type":"edge","id":"me7","labels":["T"],"from":"m3","to":"m1","properties":{"w":7}}',
].join('\n');

suite('differential fuzz: gremlin MATCH over a MULTIGRAPH (TS engine vs Rust ENGINE)', () => {
  const tsMulti = tsDeserialize(MULTI_DOC, 'ndjson', new Graph());
  const multiBytes = new TextEncoder().encode(MULTI_DOC);

  const nativeMulti = (text: string): unknown[] => {
    const handle = backend!.graphFromNdjson(multiBytes);

    try {
      return JSON.parse(decoder.decode(backend!.gremlinJson(handle, text))) as unknown[];
    } finally {
      backend!.graphFree(handle);
    }
  };

  /**
   * ⚠️ THE FIXTURE MUST ACTUALLY BE A MULTIGRAPH, asserted rather than assumed — this whole suite
   * exists because a corpus that looked adequate was not, and a fixture that lost its parallel
   * edges would make every case below pass by answering an easier question.
   */
  test('the fixture has parallel edges, a self loop and a sink', () => {
    const pairs = new Map<string, number>();
    let loops = 0;

    for (const edge of tsMulti.edges) {
      if (!edge.labels.has('T')) {
        continue;
      }

      const key = `${edge.from.id}->${edge.to.id}`;

      pairs.set(key, (pairs.get(key) ?? 0) + 1);

      if (edge.from.id === edge.to.id) {
        loops += 1;
      }
    }

    const repeated = [...pairs.values()].filter((n) => n > 1).length;

    const sink = tsMulti.getVertexById('m4');

    expect({ repeated, loops, sinkOut: sink?.adjFrom?.size ?? 0 }).toEqual({
      repeated: 2, // m1->m2 twice and m3->m1 twice
      loops: 1,
      sinkOut: 0,
    });
  });

  const ONE = pipe(as_('a'), out('T'), as_('b'));
  const TWO = pipe(as_('b'), out('T'), as_('c'));
  const BACK = pipe(as_('c'), out('T'), as_('a')); // closes the cycle onto an ALREADY-BOUND tag
  const CASES: readonly [string, Plan][] = [
    // Item 1793's exact shape: TS answered the distinct (from, to) pairs, TinkerPop and native the
    // traversal results.
    ['match one pattern, count', traversal(V(), match(ONE), count())],
    ['CHAIN TWIN of one pattern', traversal(V(), out('T'), count())],
    ['match two patterns, count', traversal(V(), match(ONE, TWO), count())],
    ['CHAIN TWIN of two patterns', traversal(V(), out('T'), out('T'), count())],
    // A `select` tail reads a BINDING rather than the tag map, so it checks the multiplicity is the
    // solver's own rather than an artefact of counting the step's output value.
    ['match two patterns, select(c), count', traversal(V(), match(ONE, TWO), select('c'), count())],
    ['match two patterns, select(a,b)', traversal(V(), match(ONE, TWO), select('a', 'b'))],
    // ⚠️ THE OTHER SOLVER ARM: `a` is bound by the first pattern, so `BACK` never builds a
    // candidate list and takes the already-bound consistency path instead. Its multiplicity over
    // the two parallel `m3 -> m1` edges is a DIFFERENT question from the one item 1793 fixed, and
    // this case is here to answer it rather than to confirm it.
    ['match a CYCLE onto a bound tag', traversal(V(), match(ONE, TWO, BACK), count())],
    ['match a cycle, select(a)', traversal(V(), match(ONE, TWO, BACK), select('a'))],
    // Untyped and second-type patterns, so the parallel pair is reached by more than one spelling.
    ['match untyped hop', traversal(V(), match(pipe(as_('a'), out(), as_('b'))), count())],
    ['CHAIN TWIN untyped', traversal(V(), out(), count())],
    // The CONTROL: a pattern whose end can never bind, so every row drops. If only this diverges
    // the cause is not the multiplicity.
    ['CONTROL match from the sink', traversal(V(), hasLabel('P'), has('n', eq(4)), match(ONE))],
  ];

  for (const [name, plan] of CASES) {
    test(`${name} agrees across the engines`, () => {
      const text = planToGremlin(plan);
      const ts = canonJson(toArray(plan, tsMulti));
      const native = canonJson(nativeMulti(text));

      expect({ case: name, gremlin: text, result: ts }).toEqual({
        case: name,
        gremlin: text,
        result: native,
      });
    });
  }
});

/**
 * ⚠️ THE EIGHTEEN STEPS ITEM 1796 TAUGHT THE EMITTER TO WRITE, each compared against the engine for
 * the first time.
 *
 * Item 1795's census found 19 steps that BOTH engines implement and `planToGremlin` could not
 * render. A step the emitter cannot write has no differential coverage at all, because this fuzzer
 * feeds the Rust engine by emitting TEXT — that is how `match()` carried two wrong answers through
 * 20,000 queries a run (items 1793/1794).
 *
 * ⚠️ **EMITTING IS NOT EMITTING CORRECTLY, AND THAT IS WHAT THIS SUITE IS FOR.** A new arm can
 * render a syntactically valid query that means something ELSE, and the census cannot see it: it
 * only asks whether the parser accepted the text. Each case below runs the plan through TS and the
 * emitted text through native and compares the answers, so a wrong spelling fails here rather than
 * silently widening the corpus with a query nobody meant.
 *
 * The fixture is small and its own, for the reason the suite above records twice: `MODERN`'s
 * coverage floors are calibrated on its exact seven vertices.
 */
const ARMS_DOC = [
  '{"type":"node","id":"a1","labels":["P"],"properties":{"name":"ann","age":29,"city":"oslo"}}',
  '{"type":"node","id":"a2","labels":["P"],"properties":{"name":"bo","age":31}}',
  '{"type":"node","id":"a3","labels":["S"],"properties":{"name":"lib","lang":"rust"}}',
  // A stored null and an ABSENT key on the same graph, which is what `hasNot` has to tell apart.
  '{"type":"node","id":"a4","labels":["P"],"properties":{"name":"cy","age":null}}',
  '{"type":"edge","id":"ae1","labels":["KNOWS"],"from":"a1","to":"a2","properties":{"w":0.5}}',
  '{"type":"edge","id":"ae2","labels":["MADE"],"from":"a1","to":"a3","properties":{"w":0.4}}',
  '{"type":"edge","id":"ae3","labels":["KNOWS"],"from":"a2","to":"a4","properties":{"w":0.9}}',
].join('\n');

suite('differential fuzz: gremlin EMITTER ARMS (TS engine vs Rust ENGINE)', () => {
  const tsArms = tsDeserialize(ARMS_DOC, 'ndjson', new Graph());
  const armsBytes = new TextEncoder().encode(ARMS_DOC);

  const nativeArms = (text: string): unknown[] => {
    const handle = backend!.graphFromNdjson(armsBytes);

    try {
      return JSON.parse(decoder.decode(backend!.gremlinJson(handle, text))) as unknown[];
    } finally {
      backend!.graphFree(handle);
    }
  };

  const CASES: readonly [string, Plan][] = [
    // Filter combinators over sub-traversals — the same machinery that was wrong twice in
    // `match()`, so they are first.
    ['and', traversal(V(), and(pipe(out('KNOWS')), pipe(has('age'))), count())],
    ['or', traversal(V(), or(pipe(out('KNOWS')), pipe(has('lang'))), count())],
    ['where(sub-plan)', traversal(V(), where(pipe(out('KNOWS'))), count())],
    ['where negated by not', traversal(V(), where(pipe(out('MADE'))), count())],
    ['sideEffect', traversal(V(), sideEffect(pipe(out('KNOWS'))), count())],
    // Projections. `properties()` yields property elements, so its COUNT is the question rather
    // than its rendering, which the two engines format differently by design.
    ['properties(name) count', traversal(V(), properties('name'), count())],
    ['propertyMap() count', traversal(V(), propertyMap(), count())],
    ['elementMap() count', traversal(V(), elementMap(), count())],
    // Filters with values.
    ['hasId', traversal(V(), hasId('a1'), count())],
    ['hasNot(age)', traversal(V(), hasNot('age'), count())],
    ['hasValue', traversal(V(), properties('name'), hasValue('ann'), count())],
    // Side-effect collectors.
    ['store + count', traversal(V(), store('x'), count())],
    ['aggregate + count', traversal(V(), aggregate('x'), count())],
    ['store + cap', traversal(V(), store('x'), cap('x'))],
    ['subgraph', traversal(V(), outE(), subgraph('s'), count())],
    // Shape steps.
    ['barrier', traversal(V(), barrier(), count())],
    ['index', traversal(V(), values('name'), index())],
    ['none()', traversal(V(), none(), count())],
    // ⚠️ `sample(n)` picks n traversers and the choice is NOT specified, so only its CARDINALITY
    // is comparable. Asserting the rows would be asserting an unspecified order, which this repo
    // treats as a won't-fix question rather than a divergence.
    ['sample cardinality', traversal(V(), sample(2), count())],
    // CONTROLS: one step that already emitted, and one filter that admits nothing, so a universal
    // failure is distinguishable from an arm being wrong.
    ['CONTROL out', traversal(V(), out('KNOWS'), count())],
    ['CONTROL empty filter', traversal(V(), hasLabel('NOSUCH'), count())],
  ];

  for (const [name, plan] of CASES) {
    test(`${name} agrees across the engines`, () => {
      const text = planToGremlin(plan);
      const ts = canonJson(toArray(plan, tsArms));
      const native = canonJson(nativeArms(text));

      expect({ case: name, gremlin: text, result: ts }).toEqual({
        case: name,
        gremlin: text,
        result: native,
      });
    });
  }

  /**
   * ⚠️ **AN OPEN DIVERGENCE, FOUND BY THE FIRST ARM THAT COULD ASK THE QUESTION (item 1796),
   * AND IT IS STRUCTURAL RATHER THAN A SLIP.** `g.V().properties()` with NO key:
   *
   * ```text
   *   TinkerPop 3.7.3   8 on its own copy of this fixture (one traverser per PROPERTY)
   *   lenke TS          9 here — the same rule, plus the stored null `a4.age`
   *   lenke native      4      — one per VERTEX
   * ```
   *
   * The Rust side says why in its own comment: "The engine has no Property value; instead the
   * element stays current, present-filtered on the key(s)". With ONE key that coincides with
   * TinkerPop's count, which is why `properties('name')` above passes; with none or several there
   * is nothing to fan out to, so the element is kept.
   *
   * ⚠️ **`test.failing` RATHER THAN A REGISTRY ENTRY.** This is a `value` divergence — the two
   * engines answer a determinate question differently — and the divergence registry may never
   * excuse one: "if the engines disagree about the answer to a determinate question, that is a bug
   * in one of them". So it is pinned here as a KNOWN failure that will turn green and shout the
   * moment somebody gives the engine a Property value, rather than hidden.
   *
   * The fix is a feature, not a tick: native needs a Property value type, or `properties()` with
   * zero or many keys must fan out one row per property.
   */
  test.failing('properties() with NO key — OPEN: native has no Property value', () => {
    const plan = traversal(V(), properties(), count());
    const ts = canonJson(toArray(plan, tsArms));

    expect(ts).toEqual(canonJson(nativeArms(planToGremlin(plan))));
  });

  test('⚠️ the CONTROL for that divergence: each engine is self-consistent', () => {
    // Without this the failing test above could be read as "one engine is broken generally". TS
    // counts 9 properties over 4 vertices and native counts 4 elements, and BOTH agree on the
    // single-key spelling, which is what localizes the gap to the no-key fan-out.
    const all = traversal(V(), properties(), count());
    const named = traversal(V(), properties('name'), count());

    expect(canonJson(toArray(all, tsArms))).toEqual([9]);
    expect(canonJson(nativeArms(planToGremlin(all)))).toEqual([4]);
    expect(canonJson(toArray(named, tsArms))).toEqual(canonJson(nativeArms(planToGremlin(named))));
  });
});
