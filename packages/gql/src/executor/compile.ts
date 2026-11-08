/**
 * `compile` and `execute` — the GQL executor's ENTRY POINTS, and the top of its module layering.
 *
 * ⚠️ THIS IS A SEPARATE MODULE SO THAT THE PLANNER CAN BE ONE TOO (item 1663). `compile` is the
 * only caller of `compileLinear` outside the planner family itself. While it lived in
 * `executor/core.ts`, extracting the planner would have made `core.ts` import `compileLinear`
 * UPWARD from `rewrites.ts` while `rewrites.ts` imported 33 helpers back DOWN — a real module
 * cycle, where every other arrangement of the same code has none. Moving these two functions out
 * leaves `core.ts` with no reference into the planner at all.
 *
 * So the layering reads: `core.ts` (helpers) <- `rewrites.ts` (the planner) <- this file, with the
 * `executor.ts` barrel above all three and nothing below importing it.
 */

import { fromTaggedJson, isTemporal } from '@lenke/core';
import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import { isTxControl } from '../ast.js';
import type { Query, SetOp, Statement } from '../ast.js';
import { combineRows, queryHasWrite, runLinear, runTxControl } from './clauses.js';
import {
  bumpExecEpoch,
  countParamCollector,
  memoUncorrelated,
  paramCollector,
  setCollectors,
  setMemoUncorrelated,
  unknownFnCollector,
} from './compile-state.js';
import type { CLinear, Params, Plan, Row } from './core.js';
import { checkLinearScope, compileLinear } from './core.js';

// --- compile & execute -------------------------------------------------------

/** A whole compiled query: its linear parts and the set operators joining them. */
type CQuery = { parts: readonly CLinear[]; ops: readonly SetOp[] };

/**
 * Revive a single param value: a single-key tagged-temporal object
 * (`{'@date':'…'}`) becomes its `Temporal`, a list has its elements revived
 * (mirroring the Rust param parser, which revives tagged temporals inside a list
 * too), anything else passes through unchanged.
 */
const reviveParamValue = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(reviveParamValue);
  }

  return fromTaggedJson(v) ?? v;
};

/**
 * A param value of `undefined`, a function, or a symbol is dropped by the native
 * FFI's `JSON.stringify` param marshalling, so its binding reads as MISSING there
 * (→ `E_MISSING_PARAMETER`). The TS engine must agree instead of silently
 * evaluating `$name` to `undefined` (which returns `[]` for `WHERE n.x = $name`
 * with no error). (D2)
 */
const isEffectivelyMissing = (v: unknown): boolean =>
  v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * Validate one already-revived param value against the LPG param model, matching
 * the native FFI param decoder (`gql/params.rs`) so both engines accept and reject
 * exactly the same inputs (D3). Accepts a scalar (`string | number | boolean |
 * null`), a revived tagged-temporal instance, or a FLAT list of those. Rejects:
 *   - a `bigint` → `E_INVALID_VALUE` (float64 model; native rejects it JS-side in
 *     `stringifyParams` before the FFI crossing)
 *   - a nested list, or a plain (non-temporal) object → `E_INVALID_VALUE` (native:
 *     "nested arrays are not valid param values" / "the only valid object param
 *     value is a tagged temporal"). These parse as JSON perfectly well and then
 *     break a rule about what a binding may HOLD, so they are value errors, not
 *     JSON ones — and on this engine a param is a JS object with no JSON in
 *     sight. `E_INVALID_JSON` stays for a genuinely malformed document.
 * A tagged-temporal object is already a `Temporal` instance by this point
 * (`reviveParams` ran first), so it passes as a scalar — never mistaken for a
 * rejected plain object.
 */
/**
 * Does `s` contain a lone (unpaired) UTF-16 surrogate? Mirrors
 * `@lenke/serialization`'s `hasLoneSurrogate` (duplicated to avoid a package
 * dependency): the native store is UTF-8 and rejects a lone surrogate as it
 * JSON-decodes a param crossing the FFI boundary, so the TS param path must
 * reject it too for byte-identity (a JS string can carry one; native cannot).
 */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) {
      // `charCodeAt` past the end is NaN; the positive-form test treats an
      // end-of-string high surrogate (no following low) as lone.
      const next = s.charCodeAt(i + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }

  return false;
};

const validateParamScalar = (name: string, v: unknown): void => {
  if (typeof v === 'string') {
    if (hasLoneSurrogate(v)) {
      throw new LenkeError(
        `parameter $${name} is a string containing a lone (unpaired) UTF-16 surrogate, ` +
          `which is not a valid Unicode scalar in the LPG string model`,
        { code: ErrorCode.InvalidJson, details: { param: name } },
      );
    }

    return;
  }

  if (v === null || typeof v === 'boolean' || typeof v === 'number' || isTemporal(v)) {
    return;
  }

  if (typeof v === 'bigint') {
    throw new LenkeError(
      `a bigint parameter ($${name}) is not supported: the numeric model is float64 — ` +
        `pass Number(x) or a string`,
      { code: ErrorCode.InvalidValue, details: { param: name } },
    );
  }

  throw new LenkeError(
    `parameter $${name} is outside the LPG param model: only a scalar, a flat list ` +
      `of scalars, or a tagged-temporal object is a valid param value`,
    { code: ErrorCode.InvalidValue, details: { param: name } },
  );
};

const validateParamValue = (name: string, v: unknown): void => {
  if (Array.isArray(v)) {
    for (const el of v) {
      if (Array.isArray(el)) {
        throw new LenkeError(`parameter $${name}: nested arrays are not valid param values`, {
          code: ErrorCode.InvalidValue,
          details: { param: name },
        });
      }

      validateParamScalar(name, el);
    }

    return;
  }

  validateParamScalar(name, v);
};

/** Revive every param value, sharing the input object when nothing changed. */
const reviveParams = (params: Params): Params => {
  let out: Params | null = null;

  for (const key of Object.keys(params)) {
    const revived = reviveParamValue(params[key]);

    if (revived !== params[key]) {
      out ??= { ...params };
      out[key] = revived;
    }
  }

  return out ?? params;
};

/**
 * Compile a parsed query into a reusable `Plan`. All graph/param-independent
 * work — operator dispatch, aggregate detection, alias resolution, label-seed
 * selection — happens here, once. Run the returned plan against any graph and
 * params; it never re-parses or re-analyzes.
 */
export const compile = <R extends Row = Row>(query: Query): Plan<R> => {
  // Eager scope validation: a reference to an unbound variable faults NOW (at compile),
  // matching the native engine and ISO GQL / Cypher — not a silent null at run time. Each
  // set-op part is its own scope (starts empty).
  for (const part of query.parts) {
    checkLinearScope(part.clauses, new Set());
  }

  const referenced = new Set<string>();
  const unknownFns = new Set<string>();
  const countParams = new Set<string>();
  const prevParam = paramCollector;
  const prevUnknown = unknownFnCollector;
  const prevCount = countParamCollector;
  const prevMemo = memoUncorrelated;
  setCollectors(referenced, unknownFns, countParams);
  // A WRITE anywhere in the query can change an uncorrelated subquery's answer between rows,
  // so the whole query opts out rather than trying to reason about clause order.
  setMemoUncorrelated(!queryHasWrite(query));

  let compiled: CQuery;

  try {
    compiled = { parts: query.parts.map(compileLinear), ops: query.ops };
  } finally {
    setCollectors(prevParam, prevUnknown, prevCount);
    setMemoUncorrelated(prevMemo);
  }

  // Eager unknown-function rejection: a name the query references that resolves
  // to no scalar (or aggregate) function is never valid — throw NOW, at compile
  // time, before the plan runs, so `compile(parse(q))` / `query(...)` faults
  // identically over zero rows, one row, or a never-taken branch. Matches the
  // Rust engine, which raises the same coded error — `E_UNKNOWN_FUNCTION` — from
  // `gql::Parser::call`, at parse rather than at compile. The message names the offending
  // function(s) verbatim.
  if (unknownFns.size > 0) {
    const named = [...unknownFns].map((n) => `${n}()`).join(', ');

    throw new LenkeError(`call to an unknown or unimplemented function: ${named}`, {
      code: ErrorCode.UnknownFunction,
    });
  }

  const names = [...referenced];
  const countNames = [...countParams];

  // Rows are `Row` at runtime; `R` is the caller's asserted shape (see `Plan`).
  const plan: Plan = (graph, rawParams = {}) => {
    // Revive any single-key tagged-temporal object param (`{'@date':'…'}`,
    // `@datetime`, `@localtime`, `@zoned_time`, `@zoned_datetime`, `@duration`)
    // into its temporal value, so the engine's OWN tagged output round-trips as
    // an input param. The Rust engine already does this while parsing its param
    // string (`ndjson::json_value`, reached from `ndjson::params_from_obj` — a
    // single-key `{"@<tag>":"<iso>"}` object is a tagged temporal); this closes the
    // byte-identity gap.
    const params = reviveParams(rawParams);

    // A new run: invalidate anything this plan's closures cached for the LAST run
    // (see `execEpoch` — currently the `in` arm's hashed closed haystack). Bumped
    // before any row is produced, so the haystack is rebuilt from THIS call's params.
    //
    // Only plan execution needs this. `compileValidator` passes `params: {}`, so a
    // validator's closed haystack is either all-literal (hashed at compile time and
    // never re-read) or an unbound param, whose value is the same on every call.
    bumpExecEpoch();

    // Eager param validation: a `$name` the query references but the caller
    // didn't bind is a programming error — throw before running, not a silent
    // empty result. (The Rust engine does the same in `positional`.)
    for (const name of names) {
      const present = Object.hasOwn(params, name);
      const value = present ? params[name] : undefined;

      // The reserved `$__now` (from a bare `current_*` function) is optional: an
      // unsupplied `now` reads as NULL (so `current_date` → null), not an error.
      // A bound value of `undefined`/function/symbol counts as MISSING too (D2),
      // because native's `JSON.stringify` param marshalling drops such keys.
      if (name !== '__now' && (!present || isEffectivelyMissing(value))) {
        throw new LenkeError(`missing parameter: $${name}`, {
          code: ErrorCode.MissingParameter,
          details: { param: name },
        });
      }

      // Validate the value against the LPG param model — the same rules the native
      // FFI decoder enforces (D3): a bigint is rejected (float64 model), and a
      // nested list / plain (non-temporal) object is rejected rather than reaching
      // the engine as a silent no-op. Skips `$__now` when it wasn't supplied.
      if (present && !isEffectivelyMissing(value)) {
        validateParamValue(name, value);
      }
    }

    // Eager LIMIT/OFFSET bound-value validation: a `$param` used as a bound must
    // resolve to a non-negative integer. Checked here, before any row is produced,
    // so a bad bound faults identically over zero rows or many — mirroring
    // `gql::Parser::usize_lit`. (Missing/bigint binds are already caught above.)
    for (const name of countNames) {
      const v = params[name];

      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new LenkeError('a LIMIT/OFFSET parameter must resolve to a non-negative integer', {
          code: ErrorCode.InvalidValue,
          details: { param: name },
        });
      }
    }

    let rows = runLinear(compiled.parts[0], graph, params);
    compiled.ops.forEach((op, i) => {
      rows = combineRows(op, rows, runLinear(compiled.parts[i + 1], graph, params));
    });

    return rows;
  };

  return plan as Plan<R>;
};

/**
 * Compile and run a parsed statement in one call (no plan reuse). A
 * transaction-control command (`START TRANSACTION`/`COMMIT`/`ROLLBACK`) drives the
 * session's transaction frame and returns no rows; a linear query compiles and
 * runs as usual. READ ONLY enforcement lives here, at the statement level: a write
 * statement (any INSERT/MERGE/SET/REMOVE/DELETE) run while the active transaction
 * is READ ONLY is rejected *before* it applies — no mutator is touched.
 */
/**
 * Compiled plans by their AST, so a repeated statement is compiled once.
 *
 * Item 228 cached PARSE; `compile` is the other ~3.5us of a cheap query's fixed cost. Together they
 * take an indexed point lookup from ~8.8us to ~0.8us.
 *
 * ### Why reuse is sound
 *
 * `compile(query: Query): Plan` takes NO GRAPH — the type says a plan cannot depend on one — and a
 * plan's validation stays per-execution: reusing one with a missing parameter still raises
 * `E_MISSING_PARAMETER`, exactly as a fresh compile does. Verified alongside reuse with different
 * parameters and across two different graphs before this was written.
 *
 * ### Why a WeakMap, and why item 228's admission filter is NOT needed here
 *
 * Item 228 needed one because a `Map` RETAINS: it kept ~2KB statements alive across 64 further
 * allocations, which tenured them and cost 16% on a miss-heavy workload. A `WeakMap` key is weak,
 * so a plan lives exactly as long as the AST it was compiled from — a single-use statement's plan
 * dies with it, at the end of the call. No cap, no eviction, no admission: the plans retained are
 * bounded by whatever retains ASTs, which is item 228's 64-entry parse cache.
 *
 * That reasoning was NOT taken on trust. An all-miss workload (a value interpolated into the text,
 * so every call is a fresh AST) measures **0.99x with ranges overlapping** — flat. An earlier
 * reading of 0.76x on a growing-graph INSERT drove a whole redesign before the workload itself was
 * checked and found to span 7.13-31.25us, which cannot resolve a 20% effect. The redesign was
 * reverted; see the audit entry, because the lesson is worth more than the code was.
 *
 * The guards below stay per-call on purpose: transaction control and the read-only check are
 * properties of the graph and the moment, not of the statement, and must never be cached.
 */
const planCache = new WeakMap<Query, Plan<Row>>();

export const execute = <R extends Row = Row>(
  stmt: Statement,
  graph: Graph,
  params: Params = {},
): R[] => {
  if (isTxControl(stmt)) {
    runTxControl(stmt, graph);

    return [];
  }

  if (graph.isReadOnlyTransaction() && queryHasWrite(stmt)) {
    throw new LenkeError('write statement rejected: the active transaction is READ ONLY', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const hit = planCache.get(stmt);

  if (hit !== undefined) {
    return hit(graph, params) as R[];
  }

  // `R` is phantom — `compile` casts rather than reading it — so one stored plan serves every
  // caller's row type.
  const plan = compile<Row>(stmt);

  planCache.set(stmt, plan);

  return plan(graph, params) as R[];
};
