import type {
  AlgorithmConfig,
  ComponentRow,
  DegreeRow,
  LabelRow,
  PageRankRow,
  ScalarTypeName,
  ShortestPathRow,
} from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Backend, GraphHandle, MergeReport, PreparedHandle } from './backend.js';
import { ensureDisposeSymbol } from './dispose.js';

/** A decoded result row: column name → cell value. */
export type Row = Record<string, unknown>;

type RowSetJson = { columns: string[]; rows: unknown[][] };

const decoder = new TextDecoder();

// Decode a JSON carrier the crate handed back. The bytes are ours, but a decode
// failure here means the FFI result contract drifted — surface it as a coded
// `Ffi` fault rather than a bare `SyntaxError` with no provenance.
const parseJson = (bytes: Uint8Array, op: string): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new LenkeError(`lenke: ${op} returned a non-JSON carrier`, {
      code: ErrorCode.Ffi,
      cause,
    });
  }
};

const isRowSet = (doc: unknown): doc is RowSetJson =>
  typeof doc === 'object' &&
  doc !== null &&
  Array.isArray((doc as RowSetJson).columns) &&
  Array.isArray((doc as RowSetJson).rows);

const decodeRows = (bytes: Uint8Array): Row[] => {
  const doc = parseJson(bytes, 'query');

  if (!isRowSet(doc)) {
    throw new LenkeError('lenke: query result was not a {columns, rows} document', {
      code: ErrorCode.Ffi,
    });
  }

  return doc.rows.map((row) => {
    const out: Row = {};
    doc.columns.forEach((col, i) => {
      out[col] = row[i];
    });

    return out;
  });
};

const isTemplate = (x: unknown): x is TemplateStringsArray =>
  Array.isArray((x as TemplateStringsArray)?.raw);

/** GQL bindings for the string-call form: `g.query('… $name', { name })`. */
export type QueryParams = Record<string, unknown>;

/**
 * Compile a GQL call into `(text, paramsJson)`. This is the injection-safety
 * seam: template substitutions become `$p0…$pn` **bindings**, serialized as a
 * flat JSON object and decoded by the crate — a value never touches the GQL
 * parser, so quotes/operators/keywords in it stay inert data. (The old
 * behavior spliced `String(sub)` into the query text.)
 *
 * The string form takes an optional explicit bindings object referencing its
 * own `$name`s. Templates own the `$p<n>` namespace — don't hand-write `$p0`
 * inside a template that also has `${}` substitutions.
 */
const compileGql = (
  q: string | TemplateStringsArray,
  subs: unknown[],
): { text: string; params: string | undefined } => {
  if (!isTemplate(q)) {
    const explicit = subs[0] as QueryParams | undefined;

    return {
      text: q,
      params: explicit && Object.keys(explicit).length ? stringifyParams(explicit) : undefined,
    };
  }

  if (subs.length === 0) {
    return { text: q.join(''), params: undefined };
  }

  const bindings: QueryParams = {};
  const text = q.reduce((acc, part, i) => {
    if (i >= subs.length) {
      return acc + part;
    }

    bindings[`p${i}`] = subs[i];

    return `${acc + part}$p${i}`;
  }, '');

  return { text, params: stringifyParams(bindings) };
};

// `JSON.stringify` throws a raw `TypeError` on a bigint value; surface a coded
// error instead. (Serializing a bigint as a JSON number would silently lose
// precision above 2^53, so a param rejects it rather than corrupt it — pass such
// a value as a string, or as a number if it is within the safe integer range.)
const stringifyParams = (params: object): string =>
  JSON.stringify(params, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      throw new LenkeError(
        'lenke: a bigint parameter cannot cross the native boundary without precision loss — pass it as a string or a safe-range number',
        { code: ErrorCode.InvalidValue },
      );
    }

    return value;
  });

/** Serialize a prepared statement's `$name` bindings (empty/absent → no params). */
const serializeParams = (params?: QueryParams): string | undefined =>
  params && Object.keys(params).length ? stringifyParams(params) : undefined;

/**
 * Serialize a JS scalar to a **safe** Gremlin literal — the injection-proof way
 * to put a value into traversal text, since Gremlin has no engine-side param
 * binding (unlike GQL's `$name`). Strings are single-quoted with `\` and `'`
 * escaped exactly as the lexer decodes them, so a value can never break out of
 * the literal; finite non-exponential numbers and `bigint`s pass through;
 * booleans map to `true`/`false`. `null`/`undefined` and non-scalars throw —
 * the engine has no literal for them.
 */
export const escapeGremlin = (value: unknown): string => {
  switch (typeof value) {
    case 'string':
      return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'number': {
      const text = String(value);

      // The lexer's number grammar is `-?[0-9.]+` — no exponent form, no NaN.
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new LenkeError(`lenke: gremlin cannot embed the number ${text} as a literal`, {
          code: ErrorCode.InvalidGraphOp,
        });
      }

      return text;
    }
    default:
      throw new LenkeError(
        `lenke: gremlin cannot embed a ${value === null ? 'null' : typeof value} value as a literal`,
        { code: ErrorCode.InvalidGraphOp },
      );
  }
};

/**
 * Build Gremlin traversal text with each `${value}` escaped via
 * {@link escapeGremlin} — the safe way to construct a traversal string for the
 * wire (e.g. to hand to a sync client). As a plain string it is a pass-through
 * (nothing to escape). This is Gremlin's answer to GQL parameter binding.
 */
export const gremlin = (q: string | TemplateStringsArray, ...subs: unknown[]): string => {
  if (!isTemplate(q)) {
    return q;
  }

  return q.reduce(
    (acc, part, i) => acc + part + (i < subs.length ? escapeGremlin(subs[i]) : ''),
    '',
  );
};

// ARW1 column type tags (mirrors crates/lenke-core/src/arrow.rs).
const ARW_FLOAT64 = 1;
const ARW_BOOL = 2;
const ARW_UTF8 = 3;

/**
 * Decode an ARW1 columnar blob (from {@link RustGraph.queryArrow} /
 * `lnk_query_arrow`) back into {@link Row}s. The blob is a 24-byte header
 * (`"ARW1" | version | nrows | ncols`) + `ncols` × 40-byte descriptors + the
 * referenced Apache-Arrow little-endian buffers; this reads them in place (no
 * Arrow dependency). Its purpose on the wire: ship/transfer the columnar bytes
 * instead of JSON rows, and materialize here only when a consumer wants objects.
 *
 * **Scalar columns only.** ARW1 has three column types — float64, bool, utf8 —
 * so a projection of scalars (numbers, booleans, strings) round-trips
 * byte-identical to the JSON `query` path. A column holding a **list** (e.g.
 * `collect_list(...)`) or a whole **element** (`RETURN n`) is flattened into its
 * text form in the utf8 column, so it does NOT reconstruct as the structured
 * array/object the JSON path returns. Use `query()` (JSON) for non-scalar
 * projections; reserve `queryArrow`/`decodeArrow` for scalar analytical columns.
 *
 * Pass a row shape to type the result: `decodeArrow<{ n: string }>(blob)`.
 */
export const decodeArrow = <R extends Row = Row>(blob: Uint8Array): R[] => {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const td = new TextDecoder();

  if (blob.length < 24 || td.decode(blob.subarray(0, 4)) !== 'ARW1') {
    throw new LenkeError('lenke: not an ARW1 arrow blob', { code: ErrorCode.Ffi });
  }

  const nrows = Number(dv.getBigUint64(8, true));
  const ncols = Number(dv.getBigUint64(16, true));
  const rows: Row[] = Array.from({ length: nrows }, () => ({}));

  for (let c = 0; c < ncols; c += 1) {
    const d = 24 + c * 40;
    const type = dv.getUint32(d, true);
    const nameOff = dv.getUint32(d + 8, true);
    const nameLen = dv.getUint32(d + 12, true);
    const validityOff = dv.getUint32(d + 16, true);
    const validityLen = dv.getUint32(d + 20, true);
    const buf1Off = dv.getUint32(d + 24, true);
    const buf2Off = dv.getUint32(d + 32, true);
    const name = td.decode(blob.subarray(nameOff, nameOff + nameLen));

    // LSB-first validity bitmap; length 0 ⇒ every row valid (no nulls). The
    // column type is invariant, so decide it ONCE and run a tight per-row loop
    // (rather than re-testing the type on every one of the nrows cells).
    const isNull = (i: number): boolean =>
      validityLen !== 0 && (blob[validityOff + (i >> 3)] & (1 << (i & 7))) === 0;

    if (type === ARW_FLOAT64) {
      for (let i = 0; i < nrows; i += 1) {
        rows[i][name] = isNull(i) ? null : dv.getFloat64(buf1Off + i * 8, true);
      }
    } else if (type === ARW_BOOL) {
      for (let i = 0; i < nrows; i += 1) {
        rows[i][name] = isNull(i) ? null : (blob[buf1Off + (i >> 3)] & (1 << (i & 7))) !== 0;
      }
    } else if (type === ARW_UTF8) {
      for (let i = 0; i < nrows; i += 1) {
        if (isNull(i)) {
          rows[i][name] = null;
          continue;
        }

        const start = dv.getInt32(buf1Off + i * 4, true);
        const end = dv.getInt32(buf1Off + (i + 1) * 4, true);
        rows[i][name] = td.decode(blob.subarray(buf2Off + start, buf2Off + end));
      }
    } else {
      throw new LenkeError(`lenke: arrow column '${name}' has unknown type ${type}`, {
        code: ErrorCode.Ffi,
      });
    }
  }

  return rows as R[];
};

/**
 * An ergonomic handle over a Rust-backed graph. Wraps a {@link Backend} and an
 * opaque graph handle; decodes the JSON/Arrow carriers the crate returns.
 *
 * The underlying graph is heap-owned by the native/wasm module (and pinned by
 * the napi backend's id→object registry), so it must be released. Three ways,
 * uniform across the ffi / napi / wasm backends:
 *   - `using g = graphFromNdjson(...)` — released at scope exit (preferred);
 *   - `g.free()` — release explicitly (idempotent; the handle is dead after);
 *   - forget both — a {@link FinalizationRegistry} backstop reclaims the handle
 *     when the wrapper is collected. Best-effort (the GC may never run it before
 *     exit), so it is a leak-net, not a substitute for `using`/`free()`.
 */
export type RustGraph = {
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** Monotonic mutation counter — O(1) "did anything change?" for snapshots. */
  readonly version: number;
  /** Per-token change epoch (label / edge-type / property-key) for finer invalidation. */
  epoch: (name: string) => number;
  /**
   * Declare an opt-in secondary index over a vertex / edge property `key`
   * (backfills existing elements, then stays current). Idempotent. Turns
   * `WHERE x.key = …` / `x.key IN […]` / range constraints into index seeks
   * instead of full scans — a large win for repeated point lookups (e.g. bulk
   * edge inserts that `MATCH` their endpoints by id).
   */
  createVertexIndex: (key: string) => void;
  createEdgeIndex: (key: string) => void;
  /**
   * Declare a UNIQUE constraint on `(label, key)`: at most one vertex carrying
   * `label` may hold a given non-null value for `key`. Index-backed. Throws
   * `ConstraintViolation` if the current data already violates it. The Pattern-B
   * primitive `_MERGE` keys on; see docs/design/gql-extensions.md §3.
   */
  createUniqueConstraint: (label: string, key: string) => void;
  createRequiredConstraint: (label: string, key: string) => void;
  createTypeConstraint: (label: string, key: string, type: ScalarTypeName) => void;
  /**
   * Declare a UNIQUE / REQUIRED / TYPE constraint on `(edgeType, key)` — the edge
   * analogue of the vertex constraints above, keyed by edge type and enforced
   * against edge properties. Throws `ConstraintViolation` (or `InvalidValue` for
   * an unknown type name) exactly as the vertex forms do.
   */
  createEdgeUniqueConstraint: (edgeType: string, key: string) => void;
  createEdgeRequiredConstraint: (edgeType: string, key: string) => void;
  createEdgeTypeConstraint: (edgeType: string, key: string, type: ScalarTypeName) => void;
  /**
   * Declare a CARDINALITY constraint bounding the degree of every vertex carrying
   * `label` over `edgeType` in `direction` (`out` = source, `in` = target) to
   * `min..=max` (`max: null` unbounded). Throws `ConstraintViolation` if the
   * current data already violates it. Max is enforced at each statement's
   * auto-commit; min is commit-time only. See docs/design/r-tx.md.
   */
  createCardinalityConstraint: (
    label: string,
    edgeType: string,
    direction: 'out' | 'in',
    min: number,
    max: number | null,
  ) => void;
  /**
   * Declare a custom VALIDATOR on `label` (a vertex label OR an edge type): every
   * element carrying the label must satisfy the GQL boolean `predicate` (pure ISO
   * WHERE-clause syntax), with the element bound to `varName`
   * (`g.createValidator('User', 'u', 'u.age >= 0 AND u.age < 150')`). SQL-`CHECK`
   * semantics — rejected only on a definite `false`; a null/unknown result passes.
   * Throws `ConstraintViolation` if existing data already violates it, or `Syntax`
   * if the predicate can't be parsed. The native twin of `@lenke/gql`'s
   * `createValidator`, enforced byte-identically in the Rust GQL evaluator.
   */
  createValidator: (label: string, varName: string, predicate: string) => void;
  /**
   * Declare a graph-level INVARIANT `name` = a whole-graph GQL `query` (`MATCH …
   * RETURN`) that must hold after every write transaction — the cross-write twin
   * of a per-element validator (`g.createInvariant('balanced', 'MATCH (a:Acct)
   * RETURN sum(a.balance) = 0')`). Evaluated ONCE per commit against the fully-
   * staged graph; `false`-only-fails: VIOLATED iff any result cell is boolean
   * `false` (`true`/`null`/non-boolean/empty all hold). Throws
   * `ConstraintViolation` if existing data already violates it, or `Syntax` if the
   * query can't be parsed. The native twin of `@lenke/gql`'s `createInvariant`,
   * enforced byte-identically in the Rust GQL evaluator.
   */
  createInvariant: (name: string, query: string) => void;
  /** Drop a vertex / edge property index (no-op if absent). */
  dropVertexIndex: (key: string) => void;
  dropEdgeIndex: (key: string) => void;
  /** The vertex / edge property keys that currently carry a secondary index (sorted). */
  vertexIndexes: () => string[];
  edgeIndexes: () => string[];
  /**
   * Run `fn` as one atomic transaction (R-TX). Every write inside applies to the
   * graph immediately (so reads see their own writes), but if `fn` throws — or a
   * deferred constraint check fails at commit — the whole batch rolls back and
   * nothing persists. On success the writes commit together. Returns whatever
   * `fn` returns. Nesting joins the outer transaction (flat, savepoint-less): the
   * outermost frame owns commit/rollback. The engine-neutral transaction surface,
   * mirroring the TS core (`packages/core/src/core/Graph.ts`).
   */
  transaction: <T>(fn: (graph: RustGraph) => T) => T;
  /**
   * Lower-level transaction handle mirroring TinkerPop's `graph.tx()`: the
   * transaction opens now; call `commit()` or `rollback()` explicitly. Prefer
   * {@link RustGraph.transaction} for the common auto-managed case.
   */
  tx: () => { commit: () => void; rollback: () => void };
  /** Open a transaction frame. Nesting increments depth; the outermost frame owns commit/rollback. */
  beginTransaction: () => void;
  /**
   * Close the current frame. The outermost commit runs the deferred constraint
   * checks against the fully-staged graph and throws `ConstraintViolation` (after
   * rolling the whole transaction back) if one fails.
   */
  commitTransaction: () => void;
  /** Roll the current transaction back: reverse every staged write. No-op if none open. */
  rollbackTransaction: () => void;
  /**
   * Run a GQL query → decoded rows. Two safe, parameterized forms:
   * - tagged template — each `${sub}` compiles to a `$p<n>` **binding**, never
   *   spliced text: ``g.query`MATCH (p:Person) WHERE p.name = ${name} RETURN p` ``
   * - string + bindings — `g.query('… WHERE p.name = $name RETURN p', { name })`
   *
   * Pass a row shape to type the result — `g.query<{ name: string }>('…')` — an
   * opt-in, caller-side assertion (rows are `Record<string, unknown>` at
   * runtime; nothing is validated). Defaults to {@link Row}.
   */
  query: {
    <R extends Row = Row>(text: string, params?: QueryParams): R[];
    <R extends Row = Row>(strings: TemplateStringsArray, ...subs: unknown[]): R[];
  };
  /** Run a GQL query → raw Arrow ("ARW1") columnar blob. Same two forms as {@link RustGraph.query}. */
  queryArrow: {
    (text: string, params?: QueryParams): Uint8Array;
    (strings: TemplateStringsArray, ...subs: unknown[]): Uint8Array;
  };
  /**
   * Run a textual Gremlin query → JSON-decoded result stream. Gremlin has no
   * engine param surface, so template `${}` values are escaped into safe
   * literals via {@link escapeGremlin} (not raw-spliced) — so
   * ``g.gremlin`g.V().has('name', ${userInput})` `` is injection-safe. Build a
   * traversal string for elsewhere with the {@link gremlin} tag.
   */
  gremlin: (q: string | TemplateStringsArray, ...subs: unknown[]) => unknown[];
  /**
   * Degree centrality — per-vertex count of incident edges, run natively over the
   * whole graph in one call → `{ node, degree }` rows in insertion order. `config`
   * selects the `direction` (`'out'` default / `'in'` / `'both'`) and an optional
   * `edgeLabel` filter; a `writeProperty` config writes each degree back to that
   * vertex property (readable from GQL/Gremlin over the same graph). Data-first
   * (the graph is `this`); the data-last twin is `degree` in `@lenke/core`.
   */
  degree: (config?: AlgorithmConfig) => DegreeRow[];
  /**
   * Weakly-connected components — union-find over the whole graph in one call →
   * `{ node, componentId }` rows in insertion order, where `componentId` is the
   * external id of the component's first-inserted vertex. `config` takes an
   * optional `edgeLabel` filter and a `writeProperty`. Data-first (graph is
   * `this`); the data-last twin is `connectedComponents` in `@lenke/core`.
   */
  connectedComponents: (config?: AlgorithmConfig) => ComponentRow[];
  /**
   * Synchronous label propagation (community detection) — every vertex starts
   * labelled with its own external id and each of `config.iterations` rounds
   * (default 10) adopts the most-frequent neighbour label (edges undirected),
   * ties broken by the smallest label string. `config` also takes an optional
   * `edgeLabel` filter and `writeProperty`. Data-first (graph is `this`); the
   * data-last twin is `labelPropagation` in `@lenke/core`.
   */
  labelPropagation: (config?: AlgorithmConfig) => LabelRow[];
  /**
   * PageRank — the whole fixed-iteration computation runs natively in one call →
   * `{ node, score }` rows in insertion order. `config` takes `iterations`
   * (default 20), `dampingFactor` (default 0.85), an optional `weightProperty`,
   * an `edgeLabel` filter, and a `writeProperty`. Data-first (graph is `this`);
   * the data-last twin is `pagerank` in `@lenke/core`.
   */
  pagerank: (config?: AlgorithmConfig) => PageRankRow[];
  /**
   * Single-source shortest path — from `config.source` (an external id), following
   * out-edges, run natively in one call → `{ node, distance }` rows for every
   * reachable vertex (source at 0), in insertion order. Unweighted → BFS hop
   * distance; set `weightProperty` for weighted Dijkstra. `config` also takes an
   * `edgeLabel` filter and a `writeProperty`. Data-first (graph is `this`); the
   * data-last twin is `shortestPath` in `@lenke/core`.
   */
  shortestPath: (config?: AlgorithmConfig) => ShortestPathRow[];
  /** Serialize the graph back to NDJSON bytes. */
  toNdjson: () => Uint8Array;
  /**
   * Bulk-append NDJSON bytes into this graph — a `COPY FROM` for a live store.
   * Ingests at bulk speed (no per-`INSERT` parse); a node whose id already
   * exists is first-wins-skipped, edge endpoints resolve against the graph.
   * Equivalent to `deserialize(bytes, 'ndjson', existingGraph)` on the TS core.
   * Returns a {@link MergeReport} of what applied vs. skipped.
   */
  mergeNdjson: (bytes: Uint8Array) => MergeReport;
  /** Serialize the graph in a named format (`pg-json | pg-text | graphson | csv | ndjson`). */
  serialize: (format: string) => string;
  /**
   * Compile a GQL query once into a reusable {@link PreparedQuery}, bound to this
   * graph — parse/lower is paid once, then each `.query(params)` skips it. The
   * win over `query()` is the ~per-call parse cost; results are identical. A
   * syntax error throws here, at prepare time. `prepare` takes a plain string
   * with `$name` params (no tagged-template form — the text is fixed). Pass a
   * row shape to type `.query(params)`'s result.
   */
  prepare: <R extends Row = Row>(text: string) => PreparedQuery<R>;
  /** Release the underlying graph. Idempotent; the handle is invalid afterwards. */
  free: () => void;
  /** `using`-compatible alias of {@link RustGraph.free} (Explicit Resource Management). */
  [Symbol.dispose]: () => void;
};

/**
 * A compiled GQL query bound to a graph (from {@link RustGraph.prepare}). Rerun
 * it cheaply with fresh `$name` params. `free()` releases the compiled plan; the
 * graph it was prepared on must still be live at execute time.
 */
export type PreparedQuery<R extends Row = Row> = {
  /** Execute with optional `$name` bindings → decoded rows. */
  query: (params?: QueryParams) => R[];
  /** Execute → the raw Arrow ("ARW1") columnar blob. */
  queryArrow: (params?: QueryParams) => Uint8Array;
  /** Release the compiled plan. Idempotent; the prepared query is dead afterwards. */
  free: () => void;
  /** `using`-compatible alias of {@link PreparedQuery.free}. */
  [Symbol.dispose]: () => void;
};

// GC backstop for a leaked RustGraph. The crate owns the graph's heap and the
// napi backend's registry pins it, so a wrapper collected without free() would
// leak. This reclaims the handle when the wrapper becomes unreachable — a
// leak-net only (the GC is not guaranteed to run it). Skipped on runtimes with
// no FinalizationRegistry; free()/`using` still work there.
const reclaim: FinalizationRegistry<() => void> | undefined =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<() => void>((release) => {
        release();
      })
    : undefined;

type DisposalState = { freed: boolean };

// Disposal state shared per (backend, handle) — NOT per wrapper — so two
// wrappers attached to the same handle share one freed-once guard: a.free()
// then b.free() (or b's GC backstop) reaches backend.graphFree exactly once,
// never a double-free. Entries are removed on free, so a backend that recycles
// a handle value hands the next attachment a fresh state; the per-backend Map
// lives inside a WeakMap and dies with its backend.
const disposal = new WeakMap<Backend, Map<GraphHandle, DisposalState>>();

const stateFor = (backend: Backend, handle: GraphHandle): DisposalState => {
  let states = disposal.get(backend);

  if (!states) {
    states = new Map();
    disposal.set(backend, states);
  }

  let state = states.get(handle);

  if (!state) {
    state = { freed: false };
    states.set(handle, state);
  }

  return state;
};

// Dev-only leak signal. The GC backstop firing at all means a wrapper was
// collected without free()/`using`: the handle still gets reclaimed below, but
// that relies on the GC running the finalizer — which the spec never
// guarantees — so a leak may sit unreleased indefinitely. Warn once to nudge
// the caller toward deterministic disposal. Silent in production and when
// LENKE_SILENCE_LEAK_WARNING is set; the reclaim itself is never affected.
let leakWarned = false;

const leakWarningsEnabled = (): boolean => {
  // Browser/worker builds have no `process` — keep the dev aid on there, since
  // there is no NODE_ENV to mark a production bundle. Node/Bun honor both the
  // explicit opt-out and NODE_ENV=production.
  if (typeof process === 'undefined') {
    return true;
  }

  const { env } = process;

  return !env.LENKE_SILENCE_LEAK_WARNING && env.NODE_ENV !== 'production';
};

const warnLeak = (): void => {
  if (leakWarned || !leakWarningsEnabled()) {
    return;
  }

  leakWarned = true;
  console.warn(
    'lenke: a RustGraph was garbage-collected without free() — the handle was ' +
      'reclaimed by a GC backstop, but finalizers are not guaranteed to run, so ' +
      'leaked graphs can sit unreleased. Dispose deterministically with ' +
      '`using g = ...` or an explicit g.free(). ' +
      '(Set LENKE_SILENCE_LEAK_WARNING to silence this warning.)',
  );
};

// Test-only: clear the one-shot latch. Tests share a single process, so a graph
// leaked by an earlier test can reclaim and consume the once-per-process warning
// before the dedicated leak test runs — leaving it with nothing to observe.
// Resetting first makes that test deterministic. Not part of the public surface.
export const __resetLeakWarnedForTests = (): void => {
  leakWarned = false;
};

// Built at module scope so the registered thunk closes over `backend` /
// `handle` / `state` only — never the wrapper — or it would pin the very
// object it exists to reclaim. Only ever invoked from the GC backstop (free()
// unregisters its token), so a live `!freed` here is, by construction, a leak.
const reclaimThunk = (backend: Backend, handle: GraphHandle, state: DisposalState) => (): void => {
  if (!state.freed) {
    warnLeak();
    state.freed = true;
    disposal.get(backend)?.delete(handle);
    backend.graphFree(handle);
  }
};

/** Wrap an existing backend + handle as a {@link RustGraph}. */
/**
 * Build a {@link PreparedQuery} over `backend`, bound to the graph guarded by
 * `live`. Owns its own compiled-plan handle (freed independently of the graph);
 * `live()` still guards the graph, so a prepared query on a freed graph throws.
 */
const makePrepared = <R extends Row = Row>(
  backend: Backend,
  live: () => GraphHandle,
  text: string,
): PreparedQuery<R> => {
  ensureDisposeSymbol();
  const prepHandle: PreparedHandle = backend.prepare(text); // throws on a syntax error
  let freed = false;

  const prepLive = (): PreparedHandle => {
    if (freed) {
      throw new LenkeError('lenke: prepared query used after free()', {
        code: ErrorCode.InvalidGraphOp,
      });
    }

    return prepHandle;
  };

  const free = (): void => {
    if (freed) {
      return;
    }

    backend.preparedFree(prepHandle);
    freed = true;
  };

  return {
    query: (params) =>
      decodeRows(backend.preparedQueryRows(prepLive(), live(), serializeParams(params))) as R[],
    queryArrow: (params) => backend.preparedQueryArrow(prepLive(), live(), serializeParams(params)),
    free,
    [Symbol.dispose]: free,
  };
};

export const attachGraph = (backend: Backend, handle: GraphHandle): RustGraph => {
  ensureDisposeSymbol(); // so the [Symbol.dispose] key below resolves on any runtime

  // Shared with every other wrapper on this (backend, handle). Note free()
  // deletes the map entry, so attaching AFTER a free gets fresh state — that is
  // deliberate: a backend may recycle handle values (ffi handles are pointers),
  // and a recycled handle is a brand-new graph, not a freed one.
  const state = stateFor(backend, handle);
  const token = {};

  // Every member passes the handle through this gate: a freed graph answers
  // with a coded error instead of handing the backend a dangling handle (on
  // the ffi backend that read would be a native use-after-free, not a throw).
  const live = (): GraphHandle => {
    if (state.freed) {
      throw new LenkeError('lenke: graph used after free()', { code: ErrorCode.InvalidGraphOp });
    }

    return handle;
  };

  const free = (): void => {
    if (state.freed) {
      return;
    }

    // Release FIRST, mark after: if graphFree throws, the state stays live so
    // a retry (or the GC backstop) can still reclaim the graph.
    backend.graphFree(handle);
    state.freed = true;
    disposal.get(backend)?.delete(handle);
    reclaim?.unregister(token);
  };

  const graph: RustGraph = {
    get vertexCount() {
      return backend.vertexCount(live());
    },
    get edgeCount() {
      return backend.edgeCount(live());
    },
    get version() {
      return backend.version(live());
    },
    epoch: (name) => backend.epoch(live(), name),
    createVertexIndex: (key) => backend.createVertexIndex(live(), key),
    createEdgeIndex: (key) => backend.createEdgeIndex(live(), key),
    createUniqueConstraint: (label, key) => backend.createUniqueConstraint(live(), label, key),
    createRequiredConstraint: (label, key) => backend.createRequiredConstraint(live(), label, key),
    createTypeConstraint: (label, key, type) =>
      backend.createTypeConstraint(live(), label, key, type),
    createEdgeUniqueConstraint: (edgeType, key) =>
      backend.createEdgeUniqueConstraint(live(), edgeType, key),
    createEdgeRequiredConstraint: (edgeType, key) =>
      backend.createEdgeRequiredConstraint(live(), edgeType, key),
    createEdgeTypeConstraint: (edgeType, key, type) =>
      backend.createEdgeTypeConstraint(live(), edgeType, key, type),
    createCardinalityConstraint: (label, edgeType, direction, min, max) =>
      backend.createCardinalityConstraint(live(), label, edgeType, direction, min, max),
    createValidator: (label, varName, predicate) =>
      backend.createValidator(live(), label, varName, predicate),
    createInvariant: (name, query) => backend.createInvariant(live(), name, query),
    dropVertexIndex: (key) => backend.dropVertexIndex(live(), key),
    dropEdgeIndex: (key) => backend.dropEdgeIndex(live(), key),
    vertexIndexes: () => backend.vertexIndexes(live()),
    edgeIndexes: () => backend.edgeIndexes(live()),
    beginTransaction: () => backend.beginTransaction(live()),
    commitTransaction: () => backend.commitTransaction(live()),
    rollbackTransaction: () => backend.rollbackTransaction(live()),
    tx: () => {
      backend.beginTransaction(live());

      return {
        commit: () => backend.commitTransaction(live()),
        rollback: () => backend.rollbackTransaction(live()),
      };
    },
    transaction: <T>(fn: (graph: RustGraph) => T): T => {
      backend.beginTransaction(live());

      let result: T;

      try {
        result = fn(graph);
      } catch (error) {
        backend.rollbackTransaction(live());

        throw error;
      }

      backend.commitTransaction(live()); // may throw ConstraintViolation after rolling back

      return result;
    },
    query: <R extends Row = Row>(q: string | TemplateStringsArray, ...subs: unknown[]): R[] => {
      const { text, params } = compileGql(q, subs);

      return decodeRows(backend.queryRows(live(), text, params)) as R[];
    },
    queryArrow: (q: string | TemplateStringsArray, ...subs: unknown[]) => {
      const { text, params } = compileGql(q, subs);

      return backend.queryArrow(live(), text, params);
    },
    // `gremlin(...)` here is the module-level composer (safe escaping), not this
    // property — object keys don't bind in scope.
    gremlin: (q, ...subs) =>
      parseJson(backend.gremlinJson(live(), gremlin(q, ...subs)), 'gremlin') as unknown[],
    degree: (config) =>
      decodeRows(backend.algo(live(), 'degree', config && JSON.stringify(config))) as DegreeRow[],
    connectedComponents: (config) =>
      decodeRows(
        backend.algo(live(), 'connectedComponents', config && JSON.stringify(config)),
      ) as ComponentRow[],
    labelPropagation: (config) =>
      decodeRows(
        backend.algo(live(), 'labelPropagation', config && JSON.stringify(config)),
      ) as LabelRow[],
    pagerank: (config) =>
      decodeRows(
        backend.algo(live(), 'pagerank', config && JSON.stringify(config)),
      ) as PageRankRow[],
    shortestPath: (config) =>
      decodeRows(
        backend.algo(live(), 'shortestPath', config && JSON.stringify(config)),
      ) as ShortestPathRow[],
    toNdjson: () => backend.encodeNdjson(live()),
    mergeNdjson: (bytes) => backend.mergeNdjson(live(), bytes),
    serialize: (format) => decoder.decode(backend.serialize(live(), format)),
    prepare: <R extends Row = Row>(text: string) => makePrepared<R>(backend, live, text),
    free,
    [Symbol.dispose]: free,
  };

  reclaim?.register(graph, reclaimThunk(backend, handle, state), token);

  return graph;
};

/**
 * Decode NDJSON bytes into a graph and return a {@link RustGraph} facade.
 * Empty input yields an empty graph (a cold boot), not an FFI fault — the
 * boundary can't take a zero-length buffer, so it crosses as one newline,
 * which the decoder treats as zero elements.
 */
export const graphFromNdjson = (
  backend: Backend,
  bytes: Uint8Array,
  opts: { parallel?: boolean } = {},
): RustGraph =>
  attachGraph(
    backend,
    backend.graphFromNdjson(
      bytes.byteLength === 0 ? new TextEncoder().encode('\n') : bytes,
      opts.parallel ?? true,
    ),
  );

/**
 * A fresh, empty {@link RustGraph} to `INSERT` / `mergeNdjson` into — the
 * self-documenting cold boot. (Equivalent to `graphFromNdjson(backend, <empty>)`
 * without the encode-an-empty-buffer incantation.)
 */
export const createEmptyGraph = (backend: Backend): RustGraph =>
  graphFromNdjson(backend, new Uint8Array(0));

/**
 * Deserialize a document in a named format (`pg-json | pg-text | graphson | csv |
 * ndjson`) into a {@link RustGraph}. Accepts a string or raw bytes.
 */
export const graphFromFormat = (
  backend: Backend,
  input: string | Uint8Array,
  format: string,
): RustGraph => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;

  return attachGraph(backend, backend.deserialize(bytes, format));
};
