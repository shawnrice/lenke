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
      params: explicit && Object.keys(explicit).length ? JSON.stringify(explicit) : undefined,
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

  return { text, params: JSON.stringify(bindings) };
};

/** Serialize a prepared statement's `$name` bindings (empty/absent → no params). */
const serializeParams = (params?: QueryParams): string | undefined =>
  params && Object.keys(params).length ? JSON.stringify(params) : undefined;

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
 */
export const decodeArrow = (blob: Uint8Array): Row[] => {
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

  return rows;
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
  /** Drop a vertex / edge property index (no-op if absent). */
  dropVertexIndex: (key: string) => void;
  dropEdgeIndex: (key: string) => void;
  /** The vertex / edge property keys that currently carry a secondary index (sorted). */
  vertexIndexes: () => string[];
  edgeIndexes: () => string[];
  /**
   * Run a GQL query → decoded rows. Two safe, parameterized forms:
   * - tagged template — each `${sub}` compiles to a `$p<n>` **binding**, never
   *   spliced text: ``g.query`MATCH (p:Person) WHERE p.name = ${name} RETURN p` ``
   * - string + bindings — `g.query('… WHERE p.name = $name RETURN p', { name })`
   */
  query: {
    (text: string, params?: QueryParams): Row[];
    (strings: TemplateStringsArray, ...subs: unknown[]): Row[];
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
   * with `$name` params (no tagged-template form — the text is fixed).
   */
  prepare: (text: string) => PreparedQuery;
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
export type PreparedQuery = {
  /** Execute with optional `$name` bindings → decoded rows. */
  query: (params?: QueryParams) => Row[];
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
const makePrepared = (backend: Backend, live: () => GraphHandle, text: string): PreparedQuery => {
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
      decodeRows(backend.preparedQueryRows(prepLive(), live(), serializeParams(params))),
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
    dropVertexIndex: (key) => backend.dropVertexIndex(live(), key),
    dropEdgeIndex: (key) => backend.dropEdgeIndex(live(), key),
    vertexIndexes: () => backend.vertexIndexes(live()),
    edgeIndexes: () => backend.edgeIndexes(live()),
    query: (q: string | TemplateStringsArray, ...subs: unknown[]) => {
      const { text, params } = compileGql(q, subs);

      return decodeRows(backend.queryRows(live(), text, params));
    },
    queryArrow: (q: string | TemplateStringsArray, ...subs: unknown[]) => {
      const { text, params } = compileGql(q, subs);

      return backend.queryArrow(live(), text, params);
    },
    // `gremlin(...)` here is the module-level composer (safe escaping), not this
    // property — object keys don't bind in scope.
    gremlin: (q, ...subs) =>
      parseJson(backend.gremlinJson(live(), gremlin(q, ...subs)), 'gremlin') as unknown[],
    toNdjson: () => backend.encodeNdjson(live()),
    mergeNdjson: (bytes) => backend.mergeNdjson(live(), bytes),
    serialize: (format) => decoder.decode(backend.serialize(live(), format)),
    prepare: (text) => makePrepared(backend, live, text),
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
