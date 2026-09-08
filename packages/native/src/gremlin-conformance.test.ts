// Differential conformance: the TS Gremlin engine (@lenke/gremlin, in-process)
// vs the Rust engine (this package, over bun:ffi), driven from ONE source of
// truth — a TS `Plan` — so a case can't drift between the two forms.
//
//   author once:   plan
//   TS engine:     canonJson(toArray(plan, tsGraph))
//   Rust engine:   canonJson(nativeRun(planToGremlin(plan)))
//   assert:        the two canonical results are equal
//
// `planToGremlin` is the Plan→Groovy emitter — the mirror of serialize.ts's
// `findClosures`: the kinds that can't cross the text boundary (JS closures and
// non-finite literals) THROW, so a case is classified `tsOnly` rather than
// silently skipped. Any emitter bug surfaces as a red diff here, and it
// transitively exercises the real `parse.rs`.
//
// Scope note (verified 2026-07): the Tier-3 value-semantic drifts (NaN in
// ordering/dedup) are NOT reachable through this boundary — `NaN`/`Infinity`
// aren't lexable as Groovy literals and JSON can't carry them, so `inject(NaN)`
// can't reach the native engine. Those drifts are pinned as TS-engine unit
// tests instead (see nan-semantics.test.ts in @lenke/gremlin). The type-fault
// cases (incomparable order, non-number sum) both THROW on both engines, so
// they're asserted as shared faults, not silent divergences.
//
// Run: bun test packages/native/src/gremlin-conformance.test.ts
import { describe, expect, test } from 'bun:test';

import { Edge, Graph, isElement } from '@lenke/core';
import { ErrorCode, hasErrorCode } from '@lenke/errors';
import {
  V,
  addE,
  addV,
  as_,
  branch,
  choose,
  connectedComponent,
  constant,
  identity,
  count,
  createTestTinkerGraph,
  dedupe,
  E,
  fail,
  fold,
  inE,
  gte,
  inV,
  isTsOnly,
  lte,
  bothE,
  not,
  otherV,
  outE,
  outV,
  planToGremlin,
  select,
  take,
  union,
  eq,
  gt,
  has,
  hasLabel,
  inject,
  label,
  map,
  math,
  order,
  Order,
  out,
  PageRank,
  pageRank,
  Operator,
  path,
  peerPressure,
  repeat,
  type Plan,
  project,
  property,
  sack,
  regex,
  sum,
  toArray,
  traversal,
  tree,
  values,
  within,
  withSack,
} from '@lenke/gremlin';

import { nativeBackend, NATIVE_LIB, nativeReady } from './conformance-harness.js';

// --- native backend bootstrap (via the drop-in harness: the engine backend;
// see conformance-harness.ts) -------------------------------------------------
const hasLib = nativeReady;

if (!hasLib) {
  console.warn(
    `[gremlin-conformance] skipping: ${NATIVE_LIB} not found — run \`bun run build:rust\`.`,
  );
}

const suite = hasLib ? describe : describe.skip;

// The canonical TinkerPop "modern" graph as NDJSON — the native mirror of
// `createTestTinkerGraph()`. Same ids/labels/properties, so both engines run
// over identical data.
const MODERN_NDJSON = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}',
].join('\n');

// planToGremlin now ships from @lenke/gremlin (see emit.ts) — it is the
// portability bridge, not a test fixture. Imported below with the steps.

// --- canonJson: normalize a TS result to the Rust JSON-carrier shape --------
//
// `results_to_json` (exec.rs) emits the RICH element form — a vertex as
// `{id, labels, properties}` and an edge as `{id, from, to, labels, properties}`,
// property keys sorted, the same shapes GQL uses for a returned node/edge; lists
// → arrays; maps → string-keyed objects; and `Number::from_f64` maps non-finite
// → null. `canonJson` reproduces exactly that so the two sides are comparable.
//
// This said `{id, label}` until 2026-07-31, which no test caught because no case
// returned a bare element — so element results were never compared across the two
// engines at all. The Gremlin fuzzer found it; the cases below now cover it.

export const canonJson = (v: unknown): unknown => {
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
    const properties: Record<string, unknown> = {};

    for (const k of Object.keys(v.properties).sort()) {
      properties[k] = canonJson(v.properties[k]);
    }

    const labels = [...v.labels].sort();

    // Key ORDER matters: these are compared as parsed JSON, but authoring them in
    // the engine's order keeps the corpus readable next to real output.
    return v instanceof Edge
      ? { id: v.id, from: v.from.id, to: v.to.id, labels, properties }
      : { id: v.id, labels, properties };
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

// --- engine runners ---------------------------------------------------------
const backend = hasLib ? nativeBackend() : null;
const decoder = new TextDecoder();

const nativeRun = (planStr: string): unknown[] => {
  const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

  try {
    const bytes = backend!.gremlinJson(handle, planStr);

    return JSON.parse(decoder.decode(bytes)) as unknown[];
  } finally {
    backend!.graphFree(handle);
  }
};

const tsGraph = createTestTinkerGraph();
const tsRun = (plan: Plan): unknown[] => toArray(plan, tsGraph).map(canonJson);

// --- corpus -----------------------------------------------------------------
//
// `expected` is authored as natural JS and canonicalized uniformly, so the
// corpus reads intuitively. Order-sensitive by default (Gremlin is ordered);
// cases are chosen so both engines share a deterministic order.

type Verdict =
  | { kind: 'agree'; expected: unknown[] }
  | { kind: 'tsOnly' } //  planToGremlin must throw a superset-kind error
  | { kind: 'bothThrow'; code?: ErrorCode }; //  both engines fault; optionally same code

type Case = {
  name: string;
  plan: Plan;
  verdict: Verdict;
};

const CORPUS: Case[] = [
  {
    name: 'V().count()',
    plan: traversal(V(), count()),
    verdict: { kind: 'agree', expected: [6] },
  },
  {
    name: "V().hasLabel('SOFTWARE').count()",
    plan: traversal(V(), hasLabel('SOFTWARE'), count()),
    verdict: { kind: 'agree', expected: [2] },
  },
  // Returning bare ELEMENTS — the shape the canonicalizer got wrong for months
  // because nothing exercised it. A vertex carries {id, labels, properties}; an
  // edge additionally carries {from, to}.
  {
    name: "V().has('name', eq('marko')) — a returned vertex is the rich form",
    plan: traversal(V(), has('name', eq('marko'))),
    verdict: {
      kind: 'agree',
      expected: [{ id: '1', labels: ['PERSON'], properties: { age: 29, name: 'marko' } }],
    },
  },
  {
    name: "V().has('name', eq('marko')).outE('KNOWS') — a returned edge carries from/to",
    plan: traversal(V(), has('name', eq('marko')), outE('KNOWS')),
    verdict: {
      kind: 'agree',
      expected: [
        { id: '7', from: '1', to: '2', labels: ['KNOWS'], properties: { weight: 0.5 } },
        { id: '8', from: '1', to: '4', labels: ['KNOWS'], properties: { weight: 1.0 } },
      ],
    },
  },
  {
    name: "V().hasLabel('SOFTWARE') — elements inside a list keep the rich form",
    plan: traversal(V(), hasLabel('SOFTWARE')),
    verdict: {
      kind: 'agree',
      expected: [
        { id: '3', labels: ['SOFTWARE'], properties: { lang: 'java', name: 'lop' } },
        { id: '5', labels: ['SOFTWARE'], properties: { lang: 'java', name: 'ripple' } },
      ],
    },
  },
  {
    name: "V().has('age', gt(30)).values('name')",
    plan: traversal(V(), has('age', gt(30)), values('name')),
    verdict: { kind: 'agree', expected: ['josh', 'peter'] },
  },
  {
    name: "V().has('name', eq('marko')).out('KNOWS').values('name')",
    plan: traversal(V(), has('name', eq('marko')), out('KNOWS'), values('name')),
    verdict: { kind: 'agree', expected: ['vadas', 'josh'] },
  },
  {
    name: "V().hasLabel('PERSON').values('age').sum()",
    plan: traversal(V(), hasLabel('PERSON'), values('age'), sum()),
    verdict: { kind: 'agree', expected: [123] },
  },
  {
    name: 'inject(3, 1, 2).order()',
    plan: traversal(inject(3, 1, 2), order()),
    verdict: { kind: 'agree', expected: [1, 2, 3] },
  },
  // math() — a TS-superset step now at native parity (Tier-2 fix).
  {
    name: "V().hasLabel('PERSON').values('age').math('_ * 2')",
    plan: traversal(V(), hasLabel('PERSON'), values('age'), math('_ * 2')),
    verdict: { kind: 'agree', expected: [58, 54, 64, 70] },
  },
  {
    name: "V().hasLabel('PERSON').math('_ + 1').by('age')  [by-projected operand]",
    plan: traversal(V(), hasLabel('PERSON'), math('_ + 1').by('age')),
    verdict: { kind: 'agree', expected: [30, 28, 33, 36] },
  },
  // math() functions + operators — every op is the shared f64 kernel, so the two
  // engines must agree to the bit. `expected` is authored via the same JS
  // primitive the TS engine uses; native must `toEqual` it in full precision.
  {
    name: "inject(0.7).math('sin(_)')  [trig, shared kernel]",
    plan: traversal(inject(0.7), math('sin(_)')),
    verdict: { kind: 'agree', expected: [Math.sin(0.7)] },
  },
  {
    name: "inject(0.7).math('cos(_) + tan(_)')  [multiple functions]",
    plan: traversal(inject(0.7), math('cos(_) + tan(_)')),
    verdict: { kind: 'agree', expected: [Math.cos(0.7) + Math.tan(0.7)] },
  },
  {
    name: "inject(0.5).math('atan2(_, 1) - asin(_)')  [2-arg + inverse trig]",
    plan: traversal(inject(0.5), math('atan2(_, 1) - asin(_)')),
    verdict: { kind: 'agree', expected: [Math.atan2(0.5, 1) - Math.asin(0.5)] },
  },
  {
    name: "inject(2).math('pow(_, 10) + log(_, 8)')  [pow + log(base,value)]",
    plan: traversal(inject(2), math('pow(_, 10) + log(_, 8)')),
    verdict: { kind: 'agree', expected: [2 ** 10 + Math.log(8) / Math.log(2)] },
  },
  {
    name: "inject(0.7).math('sqrt(_) + exp(_) + ln(_) + log10(_)')  [unary set]",
    plan: traversal(inject(0.7), math('sqrt(_) + exp(_) + ln(_) + log10(_)')),
    verdict: {
      kind: 'agree',
      expected: [Math.sqrt(0.7) + Math.exp(0.7) + Math.log(0.7) + Math.log10(0.7)],
    },
  },
  {
    name: "inject(-1.3).math('abs(_) + ceil(_) + floor(_) + signum(_)')  [rounding/sign]",
    plan: traversal(inject(-1.3), math('abs(_) + ceil(_) + floor(_) + signum(_)')),
    verdict: {
      kind: 'agree',
      expected: [Math.abs(-1.3) + Math.ceil(-1.3) + Math.floor(-1.3) + -1],
    },
  },
  {
    name: "inject(0).math('2 ^ 3 ^ 2')  [`^` right-associative → 512]",
    plan: traversal(inject(0), math('2 ^ 3 ^ 2')),
    verdict: { kind: 'agree', expected: [512] },
  },
  {
    name: "inject(0).math('2 * 3 ^ 2')  [`^` above `*` → 18]",
    plan: traversal(inject(0), math('2 * 3 ^ 2')),
    verdict: { kind: 'agree', expected: [18] },
  },
  {
    name: "inject(0).math('-2 ^ 2')  [unary tighter than `^` → 4]",
    plan: traversal(inject(0), math('-2 ^ 2')),
    verdict: { kind: 'agree', expected: [4] },
  },
  {
    name: "inject(10).math('_ % 3 + -_ % 4')  [modulo + unary]",
    plan: traversal(inject(10), math('_ % 3 + -_ % 4')),
    verdict: { kind: 'agree', expected: [(10 % 3) + (-10 % 4)] },
  },
  {
    name: "inject(0).math('2 * pi + e')  [constants pi/e]",
    plan: traversal(inject(0), math('2 * pi + e')),
    verdict: { kind: 'agree', expected: [2 * Math.PI + Math.E] },
  },
  {
    name: "inject(42).as('sin').math('sin + 1')  [variable shadows function name]",
    plan: traversal(inject(42), as_('sin'), math('sin + 1')),
    verdict: { kind: 'agree', expected: [43] },
  },
  {
    name: "inject(1).math('nope(_)')  [unknown function → bothThrow, same code]",
    plan: traversal(inject(1), math('nope(_)')),
    verdict: { kind: 'bothThrow', code: ErrorCode.InvalidValue },
  },
  // Bare/juxtaposition function form (`sin _` == `sin(_)`) — the byte-identity
  // break the paren-only corpus missed: native faulted E_INVALID_VALUE while TS
  // faulted E_UNSUPPORTED. Now both parse it and agree to the bit.
  {
    name: "inject(0.7).math('sin _')  [bare form == sin(_)]",
    plan: traversal(inject(0.7), math('sin _')),
    verdict: { kind: 'agree', expected: [Math.sin(0.7)] },
  },
  {
    name: "inject(0.7).math('sin _ + 1')  [bare binds tighter than +]",
    plan: traversal(inject(0.7), math('sin _ + 1')),
    verdict: { kind: 'agree', expected: [Math.sin(0.7) + 1] },
  },
  {
    name: "inject(0.7).math('sin _ * 2')  [bare binds tighter than *]",
    plan: traversal(inject(0.7), math('sin _ * 2')),
    verdict: { kind: 'agree', expected: [Math.sin(0.7) * 2] },
  },
  {
    name: "inject(0.7).math('-sin _')  [unary over bare application]",
    plan: traversal(inject(0.7), math('-sin _')),
    verdict: { kind: 'agree', expected: [-Math.sin(0.7)] },
  },
  {
    name: "inject(0).math('abs -3')  [bare arg allows a leading sign]",
    plan: traversal(inject(0), math('abs -3')),
    verdict: { kind: 'agree', expected: [3] },
  },
  {
    name: "inject(0.7).math('sin cos _')  [right-assoc chain == sin(cos(_))]",
    plan: traversal(inject(0.7), math('sin cos _')),
    verdict: { kind: 'agree', expected: [Math.sin(Math.cos(0.7))] },
  },
  {
    name: "inject(42).as('sin').math('sin')  [bound tag shadows bare fn name]",
    plan: traversal(inject(42), as_('sin'), math('sin')),
    verdict: { kind: 'agree', expected: [42] },
  },
  {
    name: "inject(1).math('atan2 _')  [bare form is unary-only → bothThrow, same code]",
    plan: traversal(inject(1), math('atan2 _')),
    verdict: { kind: 'bothThrow', code: ErrorCode.InvalidValue },
  },
  // branch() — a TS-superset control step now at native parity (Tier-2 fix).
  {
    name: "V().branch(label()).option('PERSON', values('name')).option('SOFTWARE', constant(...))",
    plan: traversal(
      V(),
      branch(label()).option('PERSON', values('name')).option('SOFTWARE', constant('a software')),
    ),
    verdict: {
      kind: 'agree',
      expected: ['marko', 'vadas', 'josh', 'peter', 'a software', 'a software'],
    },
  },
  {
    name: "V().hasLabel('PERSON').branch(values('age')).option(29, ...).none(...)  [default branch]",
    plan: traversal(
      V(),
      hasLabel('PERSON'),
      branch(values('age')).option(29, constant('young')).none(constant('older')),
    ),
    verdict: { kind: 'agree', expected: ['young', 'older', 'older', 'older'] },
  },
  // regex() predicate — a TS-superset predicate now at native parity (Tier-2 fix).
  {
    name: "V().has('name', regex('^ma')).values('name')  [anchored]",
    plan: traversal(V(), has('name', regex('^ma')), values('name')),
    verdict: { kind: 'agree', expected: ['marko'] },
  },
  {
    name: "V().has('name', regex('o')).values('name')  [unanchored search]",
    plan: traversal(V(), has('name', regex('o')), values('name')),
    verdict: { kind: 'agree', expected: ['marko', 'josh', 'lop'] },
  },
  // Adversarial string: quotes, backslash, slash, non-ASCII, astral char. Both
  // engines must round-trip it to parse-equal JSON. (canonJson JSON.parses both
  // sides, so this guards against *malformed* output; exact-byte escaping is
  // pinned by the Rust golden test results_json_escaping_and_structure.)
  {
    name: 'inject(adversarial string) — escaping round-trips to valid JSON',
    plan: traversal(inject('a"b\\c/dé\u{1F980}')),
    verdict: { kind: 'agree', expected: ['a"b\\c/dé\u{1F980}'] },
  },
  // OLAP algorithm steps — computed locally in both engines, byte-identical.
  // The scores/labels are order-sensitive (V() insertion order) and depend on
  // canonical f64 summation order; agreement here proves the whole gremlin path
  // (parse → run_with vs builder → runAlgorithmSync) matches, on top of the
  // algo-conformance differential over the engine's math.
  {
    name: "V().pageRank().values('…pageRank')  [scores, f64 byte-identity]",
    plan: traversal(V(), pageRank(), values('gremlin.pageRankVertexProgram.pageRank')),
    verdict: {
      kind: 'agree',
      expected: [
        0.11375485828122382, 0.14598540145985406, 0.14598540145985406, 0.11375485828122382,
        0.3047208266161827, 0.1757986539016618,
      ],
    },
  },
  {
    name: 'V().pageRank().count()  [pass-through: one traverser per source]',
    plan: traversal(V(), pageRank(), count()),
    verdict: { kind: 'agree', expected: [6] },
  },
  {
    name: "V().pageRank(0.85).with(propertyName,'pr').values('pr')  [custom property + alpha]",
    plan: traversal(V(), pageRank(0.85).with(PageRank.propertyName, 'pr'), values('pr')),
    verdict: {
      kind: 'agree',
      expected: [
        0.11375485828122382, 0.14598540145985406, 0.14598540145985406, 0.11375485828122382,
        0.3047208266161827, 0.1757986539016618,
      ],
    },
  },
  {
    name: "V().connectedComponent().values('…component').dedup()  [one WCC → root '1']",
    plan: traversal(
      V(),
      connectedComponent(),
      values('gremlin.connectedComponentVertexProgram.component'),
      dedupe(),
    ),
    verdict: { kind: 'agree', expected: ['1'] },
  },
  {
    name: "V().peerPressure().values('…cluster')  [cluster labels]",
    plan: traversal(V(), peerPressure(), values('gremlin.peerPressureVertexProgram.cluster')),
    verdict: { kind: 'agree', expected: ['1', '1', '1', '6', '6', '1'] },
  },
  // Mixed-type order(): lenke sorts by a TOTAL order (numbers before strings) rather
  // than faulting on incomparability the way stock TinkerPop does — a deliberate,
  // documented divergence that keeps both engines deterministic and byte-identical.
  // Both return [1, 'a'] here (number sorts ahead of the string), so they AGREE; this
  // is not a shared fault.
  {
    name: "inject(1, 'a').order()  [total order, not a fault]",
    plan: traversal(inject(1, 'a'), order()),
    verdict: { kind: 'agree', expected: [1, 'a'] },
  },
  // Non-finite literal: unreachable across the boundary — classified tsOnly by
  // the emitter (documents that `inject(NaN)` cannot reach the native engine).
  // --- step families the emitter could not previously express -----------------
  //
  // `planToGremlin` covered vertex-to-vertex traversal with scalar predicates
  // only: every edge step, and every literal that was not a string/number/bool,
  // threw `unsupported`. That meant no edge-PROPERTY predicate of any kind
  // crossed the bridge — and a bitemporal model stores every interval as an edge
  // property, so nothing bitemporal did either. These pin the round-trip, not
  // just the emission: each runs on both engines and the results must match.
  {
    name: "V().outE('CREATED').count()",
    plan: traversal(V(), outE('CREATED'), count()),
    verdict: { kind: 'agree', expected: [4] },
  },
  {
    name: "V().inE('KNOWS').count()",
    plan: traversal(V(), inE('KNOWS'), count()),
    verdict: { kind: 'agree', expected: [2] },
  },
  {
    name: "V().bothE('CREATED').count()",
    plan: traversal(V(), bothE('CREATED'), count()),
    verdict: { kind: 'agree', expected: [8] },
  },
  {
    name: "V().has('name', eq('marko')).outE('CREATED').inV().values('name')",
    plan: traversal(V(), has('name', eq('marko')), outE('CREATED'), inV(), values('name')),
    verdict: { kind: 'agree', expected: ['lop'] },
  },
  {
    name: "V().has('name', eq('lop')).inE('CREATED').outV().values('name')",
    plan: traversal(V(), has('name', eq('lop')), inE('CREATED'), outV(), values('name')),
    verdict: { kind: 'agree', expected: ['marko', 'josh', 'peter'] },
  },
  {
    name: "V().has('name', eq('marko')).outE('CREATED').otherV().values('name')",
    plan: traversal(V(), has('name', eq('marko')), outE('CREATED'), otherV(), values('name')),
    verdict: { kind: 'agree', expected: ['lop'] },
  },
  {
    name: 'E().count()',
    plan: traversal(E(), count()),
    verdict: { kind: 'agree', expected: [6] },
  },
  {
    name: "E().hasLabel('CREATED').count()",
    plan: traversal(E(), hasLabel('CREATED'), count()),
    verdict: { kind: 'agree', expected: [4] },
  },
  {
    name: "V().hasLabel('PERSON').values('age').order().limit(2)",
    plan: traversal(V(), hasLabel('PERSON'), values('age'), order(), take(2)),
    verdict: { kind: 'agree', expected: [27, 29] },
  },
  {
    name: "V().has('name', eq('marko')).union(out('KNOWS'), out('CREATED')).count()",
    plan: traversal(V(), has('name', eq('marko')), union(out('KNOWS'), out('CREATED')), count()),
    verdict: { kind: 'agree', expected: [3] },
  },
  {
    name: "V().not(hasLabel('PERSON')).values('name')",
    plan: traversal(V(), not(hasLabel('PERSON')), values('name')),
    verdict: { kind: 'agree', expected: ['lop', 'ripple'] },
  },
  {
    name: "V().has('name', eq('marko')).as('x').select('x').values('name')",
    plan: traversal(V(), has('name', eq('marko')), as_('x'), select('x'), values('name')),
    verdict: { kind: 'agree', expected: ['marko'] },
  },
  // sack — per-traverser state (withSack + sack + sack(op).by()). PERSON ages in
  // insertion order are [29,27,32,35] (the `math('_ * 2')` case pins that order).
  {
    name: "withSack(2).V().hasLabel('PERSON').sack(mult).by('age').sack()",
    plan: traversal(withSack(2), V(), hasLabel('PERSON'), sack(Operator.mult).by('age'), sack()),
    verdict: { kind: 'agree', expected: [58, 54, 64, 70] },
  },
  {
    name: "withSack(100).V().has('name', eq('marko')).sack(sum).by('age').sack()",
    plan: traversal(
      withSack(100),
      V(),
      has('name', eq('marko')),
      sack(Operator.sum).by('age'),
      sack(),
    ),
    verdict: { kind: 'agree', expected: [129] },
  },
  {
    name: "withSack(7).V().has('name', eq('marko')).sack()  [reads the default]",
    plan: traversal(withSack(7), V(), has('name', eq('marko')), sack()),
    verdict: { kind: 'agree', expected: [7] },
  },
  {
    name: "withSack(0).V().has('name', eq('marko')).sack(assign).by('age').sack()",
    plan: traversal(
      withSack(0),
      V(),
      has('name', eq('marko')),
      sack(Operator.assign).by('age'),
      sack(),
    ),
    verdict: { kind: 'agree', expected: [29] },
  },
  // `select(key)` on a Map traverser (a `project()` row) projects the entry — so
  // `project(...).order().by(select('age'),desc).select('name')` sorts the rows
  // rather than silently no-op'ing (an untagged sub-`select` used to drop every
  // row). Persons by age desc: peter 35, josh 32, marko 29, vadas 27.
  {
    name: "project('name','age').order().by(select('age'),desc).select('name')",
    plan: traversal(
      V(),
      hasLabel('PERSON'),
      project('name', 'age').by('name').by('age'),
      order().by(select('age'), Order.desc),
      select('name'),
    ),
    verdict: { kind: 'agree', expected: ['peter', 'josh', 'marko', 'vadas'] },
  },
  {
    name: 'inject(NaN).count()  [unreachable literal → tsOnly]',
    plan: traversal(inject(Number.NaN), count()),
    verdict: { kind: 'tsOnly' },
  },
  // `project().by(<bare body>)` — the no-navigation projecting/reducing forms. These are
  // standard TinkerPop and the TS engine accepts them; the native engine used to reject
  // any `by()` body that was not a key/id/label token or a single navigating hop.
  {
    name: "project('n').by(values('name')) — bare values() body",
    plan: traversal(V(), has('name', 'marko'), project('n').by(values('name'))),
    verdict: { kind: 'agree', expected: [{ n: 'marko' }] },
  },
  {
    name: "project('c').by(count()) — bare count() over one traverser is 1",
    plan: traversal(V(), has('name', 'marko'), project('c').by(count())),
    verdict: { kind: 'agree', expected: [{ c: 1 }] },
  },
  {
    name: "project('k').by(constant(42)) — constant body",
    plan: traversal(V(), has('name', 'marko'), project('k').by(constant(42))),
    verdict: { kind: 'agree', expected: [{ k: 42 }] },
  },
  {
    name: "values('age').math('_ / 0') — division by zero throws on both engines",
    plan: traversal(V(), has('name', 'marko'), values('age'), math('_ / 0')),
    verdict: { kind: 'bothThrow', code: ErrorCode.InvalidValue },
  },
  // `tree()` folds each traverser's vertex-hop path into a nested tree. It used to build a
  // JS Map (→ `{}` under JSON) on the TS side; it now builds nested plain objects keyed
  // exactly as native keys them (element canonical JSON, or the by-value), so the whole
  // tree is byte-identical. (`toEqual` compares trees structurally, so the root-key order
  // — which follows the unspecified V() iteration order — does not matter.)
  {
    name: "out().tree().by('name') — nested name-keyed tree",
    plan: traversal(V(), out(), tree().by('name')),
    verdict: {
      kind: 'agree',
      expected: [
        {
          marko: { lop: {}, vadas: {}, josh: {} },
          josh: { ripple: {}, lop: {} },
          peter: { lop: {} },
        },
      ],
    },
  },
  {
    name: "out().out().tree().by('name') — two-level nested tree",
    plan: traversal(V(), out(), out(), tree().by('name')),
    verdict: {
      kind: 'agree',
      expected: [{ marko: { josh: { ripple: {}, lop: {} } } }],
    },
  },
  {
    // Multiple by() modulators on a vertex-hop path cycle positionally (name, age, name…).
    name: "out().out().path().by('name').by('age') — round-robin by()",
    plan: traversal(V(), out(), out(), path().by('name').by('age')),
    verdict: {
      kind: 'agree',
      expected: [
        ['marko', 32, 'ripple'],
        ['marko', 32, 'lop'],
      ],
    },
  },
  {
    // `.with(<Algo>.edges, 'LABEL')` restricts the algorithm to that edge label; byte-
    // identical scores (ordered for determinism).
    name: "pageRank().with(PageRank.edges, 'KNOWS') restricts to KNOWS edges",
    plan: traversal(
      V(),
      pageRank().with(PageRank.edges, 'KNOWS'),
      values('gremlin.pageRankVertexProgram.pageRank'),
      order(Order.desc),
    ),
    verdict: {
      kind: 'agree',
      expected: [
        0.208029197080292, 0.208029197080292, 0.14598540145985403, 0.14598540145985403,
        0.14598540145985403, 0.14598540145985403,
      ],
    },
  },
  {
    // `has(k, not(<pred>))` negates the inner predicate — not(within(…)) ≡ without(…).
    // `.order()` makes the bag deterministic — values() order is otherwise unspecified.
    name: "has('name', not(within('vadas','marko'))).values('name').order()",
    plan: traversal(V(), has('name', not(within('vadas', 'marko'))), values('name'), order()),
    verdict: { kind: 'agree', expected: ['josh', 'lop', 'peter', 'ripple'] },
  },
  {
    // fail(msg) is an assertion barrier: a traverser reaching it throws E_FAIL in both
    // engines. `fold()` yields one (list) row, so fail() fires.
    name: "hasLabel('PERSON').has('name', eq('peter')).fold().fail('Test Fail')  [bothThrow E_FAIL]",
    plan: traversal(V(), hasLabel('PERSON'), has('name', eq('peter')), fold(), fail('Test Fail')),
    verdict: { kind: 'bothThrow', code: ErrorCode.Fail },
  },
  {
    // fail() never fires on an empty stream — no traverser reaches it, so both engines
    // return empty rather than throwing.
    name: "has('name', eq('nobody')).fail('should not fire')  [empty → no throw]",
    plan: traversal(V(), has('name', eq('nobody')), fail('should not fire')),
    verdict: { kind: 'agree', expected: [] },
  },
  {
    // fail() with no message uses the default; both engines throw E_FAIL.
    name: 'V().fail()  [default message → bothThrow E_FAIL]',
    plan: traversal(V(), fail()),
    verdict: { kind: 'bothThrow', code: ErrorCode.Fail },
  },
];

suite('gremlin conformance: TS engine ⟷ Rust engine (over ffi)', () => {
  for (const c of CORPUS) {
    test(c.name, () => {
      if (c.verdict.kind === 'tsOnly') {
        // The emitter must refuse this plan with a superset-kind reason.
        expect(() => planToGremlin(c.plan)).toThrow();

        try {
          planToGremlin(c.plan);
        } catch (e) {
          expect(isTsOnly(e)).toBe(true);
        }

        // The TS engine still runs it (that's what "superset" means).
        expect(() => tsRun(c.plan)).not.toThrow();

        return;
      }

      const groovy = planToGremlin(c.plan);

      if (c.verdict.kind === 'bothThrow') {
        const { code } = c.verdict;
        const caught = (fn: () => void): unknown => {
          try {
            fn();
          } catch (e) {
            return e;
          }

          throw new Error('expected a throw');
        };
        const tsErr = caught(() => tsRun(c.plan));
        const ntErr = caught(() => nativeRun(groovy));

        // Error-code parity: a byte-identity break hides as differing codes
        // (native E_INVALID_VALUE vs TS E_UNSUPPORTED was the bare-`sin _` bug).
        if (code !== undefined) {
          expect(hasErrorCode(tsErr, code)).toBe(true);
          expect(hasErrorCode(ntErr, code)).toBe(true);
        }

        return;
      }

      const expected = c.verdict.expected.map(canonJson);
      expect(tsRun(c.plan)).toEqual(expected);
      expect(nativeRun(groovy)).toEqual(expected);
    });
  }
});

// The bitemporal as-of shape, end to end across the bridge. Kept separate from
// CORPUS because it needs edges carrying temporal properties, and the shared
// "modern" fixture deliberately has none.
//
// The canonical case for this shape: an as-of read needs
// `vf <= t AND vt > t` on an EDGE, so it requires edge steps and temporal
// literals together. The emitter once refused it ("unsupported: step outE"),
// and even hand-written the dialect could not express `date(...)`.
suite('gremlin conformance: bitemporal as-of across the bridge', () => {
  const TEMPORAL_NDJSON = [
    { type: 'node', id: 'a', labels: ['E'], properties: { id: 'a' } },
    { type: 'node', id: 'b', labels: ['E'], properties: { id: 'b' } },
    { type: 'node', id: 'c', labels: ['E'], properties: { id: 'c' } },
    // a->b is current as of 2021-06-01; a->c expired in 2019.
    {
      type: 'edge',
      id: 'e1',
      from: 'a',
      to: 'b',
      labels: ['R'],
      properties: { vf: { '@date': '2020-01-01' }, vt: { '@date': '2099-12-31' } },
    },
    {
      type: 'edge',
      id: 'e2',
      from: 'a',
      to: 'c',
      labels: ['R'],
      properties: { vf: { '@date': '2018-01-01' }, vt: { '@date': '2019-01-01' } },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  const asOf = { '@date': '2021-06-01' };
  const plan = traversal(
    V(),
    has('id', eq('a')),
    outE('R'),
    has('vf', lte(asOf)),
    has('vt', gte(asOf)),
    inV(),
    values('id'),
  );

  test('emits edge steps and temporal literals, and both engines agree', () => {
    const groovy = planToGremlin(plan);

    expect(groovy).toContain("outE('R')");
    expect(groovy).toContain("date('2021-06-01')");

    // Same NDJSON both sides, with explicit element ids, so the engines cannot
    // synthesize different ids and make identical results look like a divergence.
    const g = new Graph();

    for (const line of TEMPORAL_NDJSON.split('\n')) {
      const r = JSON.parse(line) as {
        type: string;
        id: string;
        labels: string[];
        properties: Record<string, unknown>;
        from?: string;
        to?: string;
      };

      if (r.type === 'node') {
        g.addVertex({ id: r.id, labels: r.labels, properties: r.properties });
      } else {
        g.addEdge({
          id: r.id,
          from: g.getVertexById(r.from!)!,
          to: g.getVertexById(r.to!)!,
          labels: r.labels,
          properties: r.properties,
        });
      }
    }

    const handle = backend!.graphFromNdjson(new TextEncoder().encode(TEMPORAL_NDJSON));

    try {
      const native = JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[];

      expect(toArray(plan, g).map(canonJson)).toEqual(['b']);
      expect(native).toEqual(['b']);
    } finally {
      backend!.graphFree(handle);
    }
  });
});

// property(key, <traversal>) — "traversal-induced values" (standard TinkerPop).
// The child traversal is evaluated per element, rooted at the current traverser;
// its first output is written. Both engines must agree. A representative use is a
// message-passing write path that stores a computed degree (`property('deg', __.outE().count())`).
suite('gremlin conformance: property(key, traversal) — traversal-induced values', () => {
  const NDJSON = [
    { type: 'node', id: 'marko', labels: ['P'], properties: { id: 'marko' } },
    { type: 'node', id: 'a', labels: ['P'], properties: { id: 'a' } },
    { type: 'node', id: 'b', labels: ['P'], properties: { id: 'b' } },
    { type: 'edge', id: 'e1', from: 'marko', to: 'a', labels: ['KNOWS'], properties: {} },
    { type: 'edge', id: 'e2', from: 'marko', to: 'b', labels: ['KNOWS'], properties: {} },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  const build = (): Graph => {
    const g = new Graph();

    for (const line of NDJSON.split('\n')) {
      const r = JSON.parse(line) as {
        type: string;
        id: string;
        labels: string[];
        properties: Record<string, unknown>;
        from?: string;
        to?: string;
      };

      if (r.type === 'node') {
        g.addVertex({ id: r.id, labels: r.labels, properties: r.properties });
      } else {
        g.addEdge({
          id: r.id,
          from: g.getVertexById(r.from!)!,
          to: g.getVertexById(r.to!)!,
          labels: r.labels,
          properties: r.properties,
        });
      }
    }

    return g;
  };

  const cases: { name: string; plan: Plan; expected: unknown[] }[] = [
    {
      name: "property('flag', constant(1.0)) writes to every element",
      plan: traversal(V(), hasLabel('P'), property('flag', constant(1.0)), values('flag')),
      expected: [1, 1, 1],
    },
    {
      name: "property('deg', outE().count()) — traversal-induced out-degree",
      plan: traversal(
        V(),
        has('id', eq('marko')),
        property('deg', traversal(outE(), count())),
        values('deg'),
      ),
      expected: [2],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const groovy = planToGremlin(c.plan);
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(NDJSON));

      try {
        const native = JSON.parse(
          decoder.decode(backend!.gremlinJson(handle, groovy)),
        ) as unknown[];

        expect(toArray(c.plan, build()).map(canonJson)).toEqual(c.expected);
        expect(native).toEqual(c.expected);
      } finally {
        backend!.graphFree(handle);
      }
    });
  }
});

// A stored map/record property flows through the Gremlin value path in BOTH
// engines (native `value_to_gval` → GVal::Map; TS core → LenkeRecord) and
// serializes to the same canonical string-keyed object.
suite('gremlin conformance: stored map property', () => {
  const MAP_NDJSON = [
    {
      type: 'node',
      id: 'a',
      labels: ['P'],
      properties: { id: 'a', meta: { city: 'NYC', zip: '10001' } },
    },
    {
      type: 'node',
      id: 'b',
      labels: ['P'],
      properties: { id: 'b', meta: { city: 'LA', zip: '90001' } },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  const buildTs = (): Graph => {
    const g = new Graph();

    for (const line of MAP_NDJSON.split('\n')) {
      const r = JSON.parse(line) as {
        id: string;
        labels: string[];
        properties: Record<string, unknown>;
      };

      g.addVertex({ id: r.id, labels: r.labels, properties: r.properties });
    }

    return g;
  };

  test('values(meta) reads a stored map identically in both engines', () => {
    const plan = traversal(V(), values('meta'));
    const groovy = planToGremlin(plan);
    const ts = toArray(plan, buildTs()).map(canonJson);
    const handle = backend!.graphFromNdjson(new TextEncoder().encode(MAP_NDJSON));

    try {
      const native = JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[];

      expect(ts).toEqual(native);
      expect(ts).toEqual([
        { city: 'NYC', zip: '10001' },
        { city: 'LA', zip: '90001' },
      ]);
    } finally {
      backend!.graphFree(handle);
    }
  });

  // TinkerPop: addV is NOT terminal — a read step observes the created vertex. Native used
  // to reject any read after a write ("step `id` cannot follow a write step"); it now folds
  // the read into an InsertReturn, matching TS. Uses fresh graphs per case (writes mutate)
  // and reads that are byte-identical (label / a set-then-read property) — NOT id(), whose
  // value is engine-assigned (native dense id vs TS uuid).
  test('read-after-write: a read step after addV is byte-identical to native', () => {
    const cases: [Plan, unknown[]][] = [
      [traversal(addV('T'), label()), ['T']],
      [traversal(addV('T'), property('name', 'x'), values('name')), ['x']],
      [traversal(addV('T'), out('KNOWS')), []],
    ];

    for (const [plan, expected] of cases) {
      const groovy = planToGremlin(plan);
      const ts = toArray(plan, createTestTinkerGraph()).map(canonJson);
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

      try {
        const native = JSON.parse(
          decoder.decode(backend!.gremlinJson(handle, groovy)),
        ) as unknown[];

        expect(ts).toEqual(expected);
        expect(native).toEqual(expected);
      } finally {
        backend!.graphFree(handle);
      }
    }
  });

  test('per-traverser addV creates one vertex per row + bare addV() (byte-identical)', () => {
    // Terminal addV returns the created vertices; compare labels/properties (id is
    // engine-assigned). A read AFTER a per-traverser addV is deferred, so not tested here.
    const vshape = (rows: unknown[]): unknown =>
      rows.map((r) => {
        const { id, ...rest } = canonJson(r) as Record<string, unknown>;

        return rest;
      });
    const cases: [Plan, unknown][] = [
      // one SHADOW per PERSON (4 identical created vertices; V() order is unspecified but
      // they are identical, so the multiset matches).
      [
        traversal(V(), hasLabel('PERSON'), addV('SHADOW')),
        Array.from({ length: 4 }, () => ({ labels: ['SHADOW'], properties: {} })),
      ],
      // bare addV() → a label-less vertex (source form).
      [traversal(addV()), [{ labels: [], properties: {} }]],
      // trailing literal property folds onto the created vertex.
      [traversal(addV('S'), property('via', 'x')), [{ labels: ['S'], properties: { via: 'x' } }]],
    ];

    for (const [plan, expected] of cases) {
      const groovy = planToGremlin(plan);
      const ts = vshape(toArray(plan, createTestTinkerGraph()));
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

      try {
        const native = vshape(
          JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
        );

        expect(ts).toEqual(expected);
        expect(native).toEqual(expected);
      } finally {
        backend!.graphFree(handle);
      }
    }
  });

  // Per-traverser `addE` — native was a parse-time-static, numeric-id-only construct that
  // did not work on string-id graphs; it now creates one edge per row with runtime-resolved
  // endpoints (current traverser / V(id) / as()-tag), byte-identical to TS. The created
  // edge's id is engine-assigned (dense vs uuid), so compare from/to/labels only. Fresh
  // graphs per case (writes mutate).
  test('addE creates edges byte-identically to native (from/to/labels)', () => {
    // drop the engine-assigned edge id; the rest of the edge shape must match.
    const edges = (rows: unknown[]): unknown =>
      rows
        .map((r) => {
          const { id, properties, ...rest } = canonJson(r) as Record<string, unknown>;

          return rest;
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    const cases: [Plan, unknown][] = [
      // current-traverser FROM + V(id) TO.
      [
        traversal(V('1'), addE('NEMESIS').to(V('6'))),
        [{ from: '1', to: '6', labels: ['NEMESIS'] }],
      ],
      // source form: both endpoints explicit.
      [traversal(addE('LINK').from(V('1')).to(V('6'))), [{ from: '1', to: '6', labels: ['LINK'] }]],
      // as()-tag FROM, one edge per KNOWS neighbour (marko knows vadas + josh).
      [
        traversal(V('1'), as_('s'), out('KNOWS'), addE('META').from('s').to(V('6'))),
        [
          { from: '1', to: '6', labels: ['META'] },
          { from: '1', to: '6', labels: ['META'] },
        ],
      ],
    ];

    for (const [plan, expected] of cases) {
      const groovy = planToGremlin(plan);
      const ts = edges(toArray(plan, createTestTinkerGraph()));
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

      try {
        const native = edges(
          JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
        );

        expect(ts).toEqual(expected);
        expect(native).toEqual(expected);
      } finally {
        backend!.graphFree(handle);
      }
    }
  });

  test('addE with a literal property() folds it onto the created edge (byte-identical)', () => {
    const plan = traversal(V('1'), addE('KNOWS').to(V('6')), property('weight', 0.42));
    const groovy = planToGremlin(plan);
    // canonJson sorts property keys, so { weight } compares byte-identically.
    const edge = (rows: unknown[]): unknown =>
      rows.map((r) => {
        const { id, ...rest } = canonJson(r) as Record<string, unknown>;

        return rest;
      });
    const expected = [{ from: '1', to: '6', labels: ['KNOWS'], properties: { weight: 0.42 } }];
    const ts = edge(toArray(plan, createTestTinkerGraph()));
    const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

    try {
      const native = edge(
        JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
      );

      expect(ts).toEqual(expected);
      expect(native).toEqual(expected);
    } finally {
      backend!.graphFree(handle);
    }
  });

  test('addE to a missing endpoint faults with E_MISSING_VERTEX on both engines', () => {
    const plan = traversal(V('1'), addE('L').to(V('999')));
    const groovy = planToGremlin(plan);
    const tsErr = (() => {
      try {
        toArray(plan, createTestTinkerGraph());
      } catch (e) {
        return e;
      }
    })();
    expect(hasErrorCode(tsErr, ErrorCode.MissingVertex)).toBe(true);

    const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

    try {
      let natErr: unknown;

      try {
        backend!.gremlinJson(handle, groovy);
      } catch (e) {
        natErr = e;
      }

      expect(hasErrorCode(natErr, ErrorCode.MissingVertex)).toBe(true);
    } finally {
      backend!.graphFree(handle);
    }
  });

  test('repeat(<addV write>).times(N) creates N vertices, feeding forward (byte-identical)', () => {
    // `repeat` emits the final frontier: one PING vertex (the 3rd). The id is engine-
    // assigned, so compare labels/properties. (Emits via planToGremlin.)
    const plan = traversal(V('1'), repeat(addV('PING')).times(3));
    const groovy = planToGremlin(plan);
    const vshape = (rows: unknown[]): unknown =>
      rows.map((r) => {
        const { id, ...rest } = canonJson(r) as Record<string, unknown>;

        return rest;
      });
    const expected = [{ labels: ['PING'], properties: {} }];
    const ts = vshape(toArray(plan, createTestTinkerGraph()));
    const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

    try {
      const native = vshape(
        JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
      );

      expect(ts).toEqual(expected);
      expect(native).toEqual(expected);
    } finally {
      backend!.graphFree(handle);
    }
  });

  test('union / choose with write arms create + are byte-identical', () => {
    const vshape = (rows: unknown[]): unknown =>
      rows
        .map((r) => {
          const { id, ...rest } = canonJson(r) as Record<string, unknown>;

          return rest;
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const cases: [Plan, string, unknown][] = [
      // union runs each write arm over the SAME input (marko) → one A and one B.
      [
        traversal(V('1'), union(addV('A'), addV('B'))),
        "g.V('1').union(addV('A'), addV('B'))",
        [
          { labels: ['A'], properties: {} },
          { labels: ['B'], properties: {} },
        ],
      ],
      // choose(identity(), addV) — identity passes all 4 PERSON → 4 VISITED.
      [
        traversal(V(), hasLabel('PERSON'), choose(identity(), addV('VISITED'))),
        "g.V().hasLabel('PERSON').choose(identity(), addV('VISITED'))",
        Array.from({ length: 4 }, () => ({ labels: ['VISITED'], properties: {} })),
      ],
    ];

    for (const [plan, groovy, expected] of cases) {
      const ts = vshape(toArray(plan, createTestTinkerGraph()));
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

      try {
        const native = vshape(
          JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
        );

        expect(ts).toEqual(expected);
        expect(native).toEqual(expected);
      } finally {
        backend!.graphFree(handle);
      }
    }
  });

  test('map(<pure write>) creates one element per input traverser (byte-identical)', () => {
    // `planToGremlin` cannot yet emit `map(<sub-plan>)`, so the native side is authored as
    // Gremlin text directly (the TS side via the builder). map(write) lowers to the
    // per-traverser write step; the input is snapshot first (no write-while-scan loop).
    const plan = traversal(V(), hasLabel('PERSON'), map(addV('SHADOW')));
    const groovy = "g.V().hasLabel('PERSON').map(addV('SHADOW'))";
    const vshape = (rows: unknown[]): unknown =>
      rows.map((r) => {
        const { id, ...rest } = canonJson(r) as Record<string, unknown>;

        return rest;
      });
    // modern has 4 PERSON → 4 identical SHADOW vertices.
    const expected = Array.from({ length: 4 }, () => ({ labels: ['SHADOW'], properties: {} }));
    const ts = vshape(toArray(plan, createTestTinkerGraph()));
    const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

    try {
      const native = vshape(
        JSON.parse(decoder.decode(backend!.gremlinJson(handle, groovy))) as unknown[],
      );

      expect(ts).toEqual(expected);
      expect(native).toEqual(expected);
    } finally {
      backend!.graphFree(handle);
    }
  });

  test('read-after-write: a read step after a per-traverser addE/addV (byte-identical)', () => {
    const cases: [Plan, unknown[]][] = [
      // addE, then traverse into the new edge's target and read it — one query.
      [traversal(V('1'), addE('L').to(V('6')), inV(), values('name')), ['peter']],
      // addV per traverser, then read the created vertices' label in one query.
      [
        traversal(V(), hasLabel('PERSON'), addV('SHADOW'), label()),
        ['SHADOW', 'SHADOW', 'SHADOW', 'SHADOW'],
      ],
    ];

    for (const [plan, expected] of cases) {
      const groovy = planToGremlin(plan);
      const ts = toArray(plan, createTestTinkerGraph()).map(canonJson);
      const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON));

      try {
        const native = JSON.parse(
          decoder.decode(backend!.gremlinJson(handle, groovy)),
        ) as unknown[];

        expect(ts).toEqual(expected);
        expect(native).toEqual(expected);
      } finally {
        backend!.graphFree(handle);
      }
    }
  });
});
