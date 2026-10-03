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

import { Edge, isElement } from '@lenke/core';
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
  createTestTinkerGraph,
  choose,
  coalesce,
  inject,
  optional,
  union,
  type Plan,
} from '@lenke/gremlin';

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
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java"}}',
  // TWO labels. Every other vertex here carries exactly one, under which
  // "match any label" and "match the first label" are indistinguishable — which
  // is why this fuzzer ran for a long time without noticing that native's
  // `hasLabel` matched only the first and the TS engine matched any.
  '{"type":"node","id":"13","labels":["PERSON","SOFTWARE"],"properties":{"name":"hybrid","age":40,"lang":"rust"}}',
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
const slicedBeforeOrdering = (text: string): boolean => {
  const slice = text.search(SLICING_STEP);

  if (slice < 0) {
    return false;
  }

  const ordered = text.indexOf('.order(');

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
 * `a_zero_limit_does_not_cancel_an_upstream_side_effect`.
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
  const o = text.indexOf('order(');

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

  // NOT `[fold(), order(Scope.local)]` here, though that is the COLLECTION half of the step
  // and it belongs in this pool. It is red against two PRE-EXISTING divergences that this
  // generator found on its first run and that are bigger than a generator change — see audit
  // item 88. Adding it before they are fixed would land a knowingly-red oracle:
  //
  //   a list of ELEMENTS — TinkerPop throws `ClassCastException` for
  //   `g.E().fold().order(Scope.local)` and so does TS; native answers. Native already has a
  //   `fault_on_element` flag on the GLOBAL `OrderPage` for exactly this, so the fix has a
  //   precedent to follow.
  //
  //   a list containing NULLs — native ranks `Null` after `Str` (rank 7) and sorts them last,
  //   TS sorts them first. The engines are meant to share ONE total order, so one of them is
  //   wrong, and it is not confined to this step: any sort of a null-containing list has it.
  //   (TinkerPop cannot settle it — its `values()` skips a missing property rather than
  //   yielding null, so it never builds such a list.)

  if (p < 0.9) {
    // `groupCount()` was not generated at all, and its map is ORDER-observable
    // (first-seen), so a tally that agreed on the counts and not on the order
    // would have gone unnoticed. Native answers it two ways — straight off a
    // property column when the prefix lowers, otherwise through the stream — so
    // this has to cross-check both against the TS engine.
    return [values(pick(r, KEYS)), groupCount()];
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
        `  order(local)=${orderLocalGenerated}/${orderLocalNonEmpty} of ${ITERATIONS} ` +
          'generated/non-empty',
      );
      // Measured 20-40 generated and 15-35 of those non-empty, of 400.
      expect({
        orderLocalGenerated: orderLocalGenerated > 8,
        orderLocalNonEmpty: orderLocalNonEmpty > 5,
      }).toEqual({ orderLocalGenerated: true, orderLocalNonEmpty: true });

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
