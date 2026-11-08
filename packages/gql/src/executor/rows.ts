/**
 * ROWS AND KEYS: turning a binding into an output row, and a value into a comparable key.
 *
 * A leaf (item 1666): no value imports, five types. `projectRow` is the single place a `Binding`
 * becomes a `Row`, which is why three separate modules reached back into `core.ts` for it before
 * this file existed.
 *
 * ⚠️ `valueKey` IS A GROUPING KEY, NOT AN ORDERING ONE, and the two must not be confused —
 * `compareSort` in `values.ts` is the ordering side. A key is for equality and bucketing (DISTINCT,
 * GROUP BY), so it only has to be injective; the total order has to agree with the Rust engine
 * BYTE FOR BYTE or snapshots diverge. `temporalKey` and `keyReplacer` are here because they exist
 * to make a temporal value and a prototype-reserved name safe to use as a key.
 */

import {
  Duration,
  LenkeRecord,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
  ZonedTime,
  isTemporal,
} from '@lenke/core';
import type { Graph, Temporal } from '@lenke/core';

import type { CountValue, Expr } from '../ast.js';
import type { Projection } from '../ast.js';
import type { Binding, CProjection, EvalEnv, Params, Row } from './core.js';

// Resolve a `LIMIT` / `OFFSET` bound to a concrete count at execution: a literal
// passes through; a `$param` is read from the bound params (its value is already
// validated to be a non-negative integer up-front, in the plan closure).
export const resolveCount = (v: CountValue | undefined, params: Params): number | undefined => {
  if (v === undefined || typeof v === 'number') {
    return v;
  }

  return Number(params[v.param]);
};
/** Derive a column name for a RETURN item that has no explicit `AS` alias. */
export const columnName = (expr: Expr): string => {
  switch (expr.kind) {
    case 'var':
      return expr.name;
    case 'prop':
      return `${expr.variable}.${expr.key}`;
    case 'property_exists':
      return `property_exists(${expr.variable}, ${expr.key})`;
    default:
      return 'expr';
  }
};
// The replacer used only for nested containers (below): `JSON.stringify` maps
// NaN/±Infinity all to `null`, collapsing them with each other AND with real null —
// a byte-identity break vs the Rust `val_key`, which keys numbers by bit pattern
// (so `[NaN]`, `[Infinity]`, `[null]` are three groups). This tags non-finite
// numbers as bare `#…` tokens and prefixes every string with `$`, keeping the two
// key-spaces disjoint at any depth — a real string `"#Infinity"` (→ `"$#Infinity"`)
// can never collide with the number `Infinity` (→ `"#Infinity"`).
export const keyReplacer = (_k: string, val: unknown): unknown => {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : `#${val}`;
  }

  return typeof val === 'string' ? `$${val}` : val;
};
/**
 * Stable distinct/group key for a projected value, partitioning exactly as the
 * Rust `val_key`. Primitives and graph elements are keyed inline (the common
 * DISTINCT/GROUP BY case — no `JSON.stringify`, so it's off the hot path); only a
 * nested container (list/record/temporal/path — rare as a group key) pays the
 * `JSON.stringify` + `keyReplacer` cost, which is what makes nested non-finite safe.
 * Type-tag prefixes (`n`/`s`/`b`/`@`/`#`/`N`) keep the primitive key-spaces disjoint
 * from each other and from container JSON (which starts with `{`/`[`).
 */
/**
 * A temporal's DISTINCT/GROUP BY key from its own fields, or `undefined` when any field is
 * non-finite and the `JSON.stringify` fallback must keep its exact classing (item 843).
 *
 * Every field of every kind is included: dropping one would silently merge two distinct values
 * into one group, which is a wrong ANSWER rather than a slow one.
 */
export const temporalKey = (v: Temporal): string | undefined => {
  if (v instanceof LocalDate) {
    return Number.isFinite(v.days) ? `t0${v.days}` : undefined;
  }

  if (v instanceof Duration) {
    return Number.isFinite(v.months) &&
      Number.isFinite(v.days) &&
      Number.isFinite(v.secs) &&
      Number.isFinite(v.nanos)
      ? `t5${v.months}/${v.days}/${v.secs}.${v.nanos}`
      : undefined;
  }

  if (!Number.isFinite(v.secs) || !Number.isFinite(v.nanos)) {
    return undefined;
  }

  if (v instanceof LocalTime) {
    return `t1${v.secs}.${v.nanos}`;
  }

  if (v instanceof LocalDateTime) {
    return `t2${v.secs}.${v.nanos}`;
  }

  if (!Number.isFinite(v.offset)) {
    return undefined;
  }

  if (v instanceof ZonedDateTime) {
    return `t3${v.secs}.${v.nanos}+${v.offset}`;
  }

  if (v instanceof ZonedTime) {
    return `t4${v.secs}.${v.nanos}+${v.offset}`;
  }

  return undefined;
};
export const valueKey = (v: unknown): string => {
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) {
        return `#${v}`;
      }

      // `-0` and `0` are ONE group: `-0 = 0` is true, and the distinction is
      // normalized everywhere else (ORDER BY, sign(), the result JSON, the
      // property index), so keeping them apart here alone produced two groups
      // that both rendered as `0`. `String(-0)` is already "0", so the plain
      // template does it — mirrors the Rust `value::num_group_bits`.
      return `n${v}`;
    case 'string':
      return `s${v}`;
    case 'boolean':
      return v ? 'bT' : 'bF';
    case 'object':
      if (v === null) {
        return 'N';
      }

      if ('id' in v) {
        return `@${String(v.id)}`;
      }

      // Lists are native arrays (the common container key): recurse through the
      // inline keyer — no JSON.stringify, and nested non-finite is handled by the
      // element's own `#…` tag. `[` can't collide with a record's `{` (below) or
      // any primitive prefix. A manual loop (no `.map` intermediate) keeps this on
      // the hot path for large DISTINCT/GROUP BY over projected tuples.
      if (Array.isArray(v)) {
        let key = '[';

        for (const item of v) {
          key += `${valueKey(item)},`;
        }

        return `${key}]`;
      }

      // A record recurses through this keyer (like a list above), NOT through
      // JSON.stringify: stringify renders -0 as `0`, so `{b: -0}` and `{b: 0}`
      // collapsed into one DISTINCT group here while the native `value::group_key_into` —
      // which recurses and keys numbers by bit pattern — kept them apart. Mirrors
      // the Rust `Value::Map` arm's `{k=<key>,…}` shape.
      if (v instanceof LenkeRecord) {
        let key = '{';

        for (const [name, field] of v) {
          key += `${name}=${valueKey(field)},`;
        }

        return `${key}}`;
      }

      // A TEMPORAL keys off its own FIELDS (item 843). This arm used to fall through to the
      // `JSON.stringify` below with the comment "rarer as a group key" — an assumption a date in
      // a people-graph refutes, and one this repo's own domain made worth measuring:
      // `count(DISTINCT p.hired)` over 200,000 `LocalDate`s cost **81.3 ms against 4.2 for the
      // same query over a number, 19.5x**, and 15.6x against a STRING column, so it was not
      // "non-numeric is slower" but a stringify per row. (The native engine had the same defect
      // from a different cause and it was closed at items 840/841.)
      //
      // THE EQUIVALENCE CLASSES ARE UNCHANGED, which is what makes this a pure speedup rather
      // than a semantic change. `JSON.stringify` of one of these instances serializes exactly its
      // own enumerable fields — `kind` plus numbers — so a key built from the same fields groups
      // the same values. Each kind gets a distinct prefix because native's rule is "same kind AND
      // the same rendering", and `t` collides with no other prefix here (`n`/`s`/`b`/`N`/`@`/`[`/
      // `{`/`j`).
      //
      // A non-finite field falls BACK to the stringify, deliberately: `JSON.stringify` renders
      // `NaN` as `null`, so a hand-written template would group `LocalDate(NaN)` differently from
      // the way it is grouped today. That case is pathological, and keeping it bit-for-bit is
      // cheaper than arguing about it.
      if (isTemporal(v)) {
        const k = temporalKey(v);

        if (k !== undefined) {
          return k;
        }
      }

      // Path, or a temporal with a non-finite field.
      return JSON.stringify(v, keyReplacer) ?? 'undefined';
    default:
      // undefined / bigint / symbol are outside the value model; a stable fallback.
      return `j${String(v)}`;
  }
};
/**
 * `projectBinding`'s twin, writing the output ROW directly.
 *
 * The no-sort path built a projected `Map` and then had `mapToRow` copy it into a
 * plain object — two allocations and two iterations per row where one of each will
 * do. Nothing downstream of that path wants the `Map` form: it exists for the
 * ORDER BY overlay and for DISTINCT's row keys, and neither is present here.
 *
 * BYTE-IDENTITY. Column order is the output's observable shape, and it is
 * unchanged: `mapToRow` walks the `Map` in insertion order, which is
 * `proj.items` order (or the input binding's, under `*`), and this writes the
 * same keys in the same order. A repeated column name keeps its first position
 * in both a `Map` and an object, and `item.fn` is called in the same order, so a
 * projection that throws throws on the same row at the same point.
 *
 * REJECTED (item 836): hoisting the per-call `env` out of the caller's loop. Every
 * `projectRow` caller in `hop-projection.ts` passes a `Binding` allocated once and mutated in
 * place, so `{ binding, params, graph }` is invariant for a whole walk and is rebuilt per call
 * anyway — item 833 priced that object at 5.6 ns a row. It is not worth taking, because
 * `farDrivenHopWalk` already calls this once per far VERTEX and clones a template for the
 * vertex's whole bucket (item 167): the env is amortized over the degree, so the ceiling is
 * 5.6 / degree ns a row — 1.4 against ~70 at four edges a vertex, about 2%. Measured alongside:
 * at four edges a vertex the hop walk is 70.4 ns a row against a hand loop's 129.6, so it is
 * already PAST the hand floor. Do not re-derive this.
 */
export const projectRow = (
  proj: CProjection,
  binding: Binding,
  params: Params,
  graph: Graph,
): Row => {
  const row: Row = {};

  if (proj.star) {
    for (const [k, v] of binding) {
      row[k] = v;
    }

    return row;
  }

  const env: EvalEnv = { binding, params, graph };

  for (const item of proj.items) {
    row[item.name] = item.fn(env);
  }

  return row;
};
/**
 * `Row`s for the shape that needs no sort, no dedup and no paging — the same
 * five conditions `applyProjection` fast-paths (item 113). `undefined` means
 * "not this shape", and the caller falls back to the general
 * `map(mapToRow, applyProjection(…))`.
 *
 * Lazy, like the path it replaces: a row is projected when it is pulled.
 */
/**
 * `toArray(map(f, it))` without the intermediate generator — item 1508.
 *
 * `@lenke/fp`'s `map` is LAZY: it returns a generator that yields one mapped value per `next()`.
 * Composed into `toArray` (`Array.from`) that laziness is never observed — the array is
 * materialized immediately — so every row pays a generator resume and an iterator-result object
 * for nothing. This drives the SAME iterable with one `for…of` and pushes, which is what the
 * composition means.
 *
 * ⚠️ IT IS NOT A GENERAL REPLACEMENT FOR `map`. The mapper here is called with ONE argument;
 * `map`'s is called with `(value, index)`. Both call sites below pass a unary mapper (`mapToRow`
 * and a `projectRow` closure), checked before this was written. A mapper that reads an index would
 * silently receive `undefined`.
 *
 * ⚠️ AND IT MUST STAY STREAMING OVER ITS INPUT. `bindings` is lazy for every shape that matches —
 * consuming it with `for…of` pulls exactly as `Array.from` did, one binding at a time. Building an
 * intermediate array of bindings first would hold the whole match in memory, which is the eager-fill
 * failure of item 437.
 */
export const mapToArray = <T, R>(it: Iterable<T>, f: (x: T) => R): R[] => {
  const out: R[] = [];

  for (const x of it) {
    out.push(f(x));
  }

  return out;
};

/**
 * ⚠️ MOVED DOWN FROM `hop-projection.ts` (item 1666). `shortcuts.ts` needed this ONE symbol from
 * `hop-projection.ts` while `hop-projection.ts` needed nine back — one of the four mutual import
 * pairs that made this package cyclic, closed by moving the single thin-side symbol. It is a row
 * projection, so this was always its home.
 */
/** A projection that emits one row per binding: no folding, deduping, grouping or paging. */
/**
 * A projection with nothing but items: no `*`, no DISTINCT, no grouping, no ORDER BY, no paging.
 * Exported because item 528's `FOR` projection asks exactly the same question, and two copies of
 * this list is how one of them falls behind the other.
 */
export const plainRowProjection = (proj: Projection): boolean =>
  !proj.star &&
  !proj.distinct &&
  proj.groupBy === undefined &&
  proj.having === undefined &&
  (proj.orderBy?.length ?? 0) === 0 &&
  proj.skip === undefined &&
  proj.limit === undefined;

/**
 * ⚠️ MOVED DOWN FROM `clauses.ts` (item 1666), to close the LAST import cycle in the package.
 * Extracting `projection.ts` left `projection -> clauses` (for this one function) against
 * `clauses -> projection` (for `applyProjection` and `projectedRows`) — the third fresh cycle
 * `import/no-cycle` caught during this split rather than after it. `mapToRow` turns a binding into
 * a row, which is what this module is, so it was mis-filed rather than mis-moved.
 */
export const mapToRow = (b: Binding): Row => {
  const row: Row = {};

  for (const [k, v] of b) {
    row[k] = v;
  }

  return row;
};
