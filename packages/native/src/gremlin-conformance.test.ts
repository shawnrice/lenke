// Differential conformance: the TS Gremlin engine (@lenke/gremlin, in-process)
// vs the Rust core (this package, over bun:ffi), driven from ONE source of
// truth — a TS `Plan` — so a case can't drift between the two forms.
//
//   author once:   plan
//   TS engine:     canonJson(toArray(plan, tsGraph))
//   Rust core:     canonJson(nativeRun(planToGremlin(plan)))
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
import { existsSync } from 'node:fs';

import { isElement } from '@lenke/core';
import {
  V,
  type By,
  branch,
  constant,
  count,
  createTestTinkerGraph,
  eq,
  gt,
  has,
  hasLabel,
  inject,
  label,
  math,
  order,
  out,
  type Plan,
  type Predicate,
  type Step,
  sum,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

import { createFfiBackend } from './backend-ffi.js';

// --- native library bootstrap (mirrors backend-ffi.test.ts) -----------------
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[gremlin-conformance] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
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

// --- planToGremlin: Plan → Groovy text --------------------------------------
//
// The reason a case can't be dual-authored by hand: this derives the Groovy
// string mechanically from the same Plan the TS engine runs. Unsupported kinds
// throw with a tag so the runner can classify (tsOnly) vs surface (emitter gap).

type UnsupportedKind = 'closure' | 'nonfinite' | 'unsupported';

class EmitUnsupported extends Error {
  constructor(
    readonly reason: UnsupportedKind,
    detail: string,
  ) {
    super(`planToGremlin: ${reason}: ${detail}`);
  }
}

/** True for the kinds that only exist in the TS superset (no native form). */
const isTsOnly = (e: unknown): e is EmitUnsupported =>
  e instanceof EmitUnsupported && e.reason !== 'unsupported';

const emitLiteral = (v: unknown): string => {
  if (typeof v === 'string') {
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  if (typeof v === 'boolean') {
    return String(v);
  }

  if (typeof v === 'number') {
    // NaN / ±Infinity have no Groovy literal and can't survive JSON — this is
    // exactly why the NaN drifts are unreachable through this boundary.
    if (!Number.isFinite(v)) {
      throw new EmitUnsupported('nonfinite', `${v} has no Groovy literal`);
    }

    return String(v);
  }

  throw new EmitUnsupported('unsupported', `literal of type ${typeof v}`);
};

const emitPredicate = (p: Predicate): string => {
  switch (p.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${p.op}(${emitLiteral(p.value)})`;
    case 'within':
    case 'without':
      return `${p.op}(${p.values.map(emitLiteral).join(', ')})`;
    case 'between':
    case 'inside':
    case 'outside':
      return `${p.op}(${emitLiteral(p.min)}, ${emitLiteral(p.max)})`;
    case 'not':
      return `not(${emitPredicate(p.predicate)})`;
    default:
      // startsWith/containing/regex/... — extend as the corpus grows.
      throw new EmitUnsupported('unsupported', `predicate ${p.op}`);
  }
};

const emitBy = (by: By): string => {
  switch (by.kind) {
    case 'identity':
      return by.direction ? `.by(${by.direction})` : '.by()';
    case 'key':
      return by.direction
        ? `.by(${emitLiteral(by.key)}, ${by.direction})`
        : `.by(${emitLiteral(by.key)})`;
    default:
      // traversal / token by()s — extend as the corpus grows.
      throw new EmitUnsupported('unsupported', `by(${by.kind})`);
  }
};

const emitStep = (step: Step): string => {
  switch (step.kind) {
    case 'V':
      return `V(${(step.ids ?? []).map(emitLiteral).join(', ')})`;
    case 'inject':
      return `inject(${step.values.map(emitLiteral).join(', ')})`;
    case 'out':
    case 'in':
    case 'both':
      return `${step.kind}(${step.labels.map(emitLiteral).join(', ')})`;
    case 'hasLabel':
      return `hasLabel(${step.labels.map(emitLiteral).join(', ')})`;
    case 'has':
      return `has(${emitLiteral(step.key)}, ${emitPredicate(step.pred)})`;
    case 'is':
      return `is(${emitPredicate(step.pred)})`;
    case 'values':
      return `values(${step.keys.map(emitLiteral).join(', ')})`;
    case 'dedupe':
      return `dedup(${(step.labels ?? []).map(emitLiteral).join(', ')})`;
    case 'constant':
      return `constant(${emitLiteral(step.value)})`;
    case 'count':
      return 'count()';
    case 'id':
    case 'label':
    case 'value':
    case 'sum':
    case 'min':
    case 'max':
    case 'mean':
    case 'fold':
    case 'unfold':
    case 'order':
    case 'identity':
      return `${step.kind}()`;
    // The TS-superset kinds: no native form. Classified tsOnly.
    case 'mapFn':
    case 'flatMapFn':
    case 'filterFn':
    case 'sideEffectFn':
    case 'foldFn':
      throw new EmitUnsupported('closure', step.kind);
    case 'math': {
      const bys = (step.bys ?? []).map(emitBy).join('');

      return `math(${emitLiteral(step.expr)})${bys}`;
    }
    case 'branch': {
      const opts = step.options
        .map((o) => `.option(${emitLiteral(o.match)}, ${emitSubPlan(o.plan)})`)
        .join('');
      const def = step.default ? `.option(none, ${emitSubPlan(step.default)})` : '';

      return `branch(${emitSubPlan(step.test)})${opts}${def}`;
    }
    default:
      throw new EmitUnsupported('unsupported', `step ${step.kind}`);
  }
};

// An anonymous sub-traversal (no `g.` prefix): `out('KNOWS').values('name')`.
const emitSubPlan = (p: Plan): string => p.steps.map(emitStep).join('.');

export const planToGremlin = (plan: Plan): string => `g.${plan.steps.map(emitStep).join('.')}`;

// --- canonJson: normalize a TS result to the Rust JSON-carrier shape --------
//
// `results_to_json` (exec.rs) emits: vertices/edges → {id, label}; lists →
// arrays; maps → string-keyed objects; and `Number::from_f64` maps non-finite
// → null. `canonJson` reproduces exactly that so the two sides are comparable.

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
    return { id: v.id, label: [...v.labels][0] ?? '' };
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
const backend = hasLib ? createFfiBackend(LIB) : null;
const decoder = new TextDecoder();

const nativeRun = (planStr: string): unknown[] => {
  const handle = backend!.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON), false);

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
  | { kind: 'bothThrow' }; //  both engines fault (parity of failure)

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
  // Type-fault: incomparable order — both engines throw (shared fault).
  {
    name: "inject(1, 'a').order()  [type fault]",
    plan: traversal(inject(1, 'a'), order()),
    verdict: { kind: 'bothThrow' },
  },
  // Non-finite literal: unreachable across the boundary — classified tsOnly by
  // the emitter (documents that `inject(NaN)` cannot reach the native engine).
  {
    name: 'inject(NaN).count()  [unreachable literal → tsOnly]',
    plan: traversal(inject(Number.NaN), count()),
    verdict: { kind: 'tsOnly' },
  },
];

suite('gremlin conformance: TS engine ⟷ Rust core (over ffi)', () => {
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
        expect(() => tsRun(c.plan)).toThrow();
        expect(() => nativeRun(groovy)).toThrow();

        return;
      }

      const expected = c.verdict.expected.map(canonJson);
      expect(tsRun(c.plan)).toEqual(expected);
      expect(nativeRun(groovy)).toEqual(expected);
    });
  }
});
