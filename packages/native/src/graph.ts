import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Backend, GraphHandle } from './backend.js';

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

// Gremlin has no engine-side params surface, so its tagged template still
// splices text. CAUTION: never build Gremlin from untrusted values — prefer
// GQL (parameterized) for anything carrying user input.
const spliceText = (q: string | TemplateStringsArray, subs: unknown[]): string => {
  if (isTemplate(q)) {
    return q.reduce((acc, part, i) => acc + part + (i < subs.length ? String(subs[i]) : ''), '');
  }

  return q;
};

/**
 * An ergonomic handle over a Rust-backed graph. Wraps a {@link Backend} and an
 * opaque graph handle; decodes the JSON/Arrow carriers the crate returns. Call
 * {@link RustGraph.free} when done — the underlying graph is heap-owned by the
 * native/wasm module and is not garbage-collected.
 */
export type RustGraph = {
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** Monotonic mutation counter — O(1) "did anything change?" for snapshots. */
  readonly version: number;
  /** Per-token change epoch (label / edge-type / property-key) for finer invalidation. */
  epoch: (name: string) => number;
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
   * params surface: template `${}` values are SPLICED into the text — never
   * feed it untrusted input (use parameterized GQL for that).
   */
  gremlin: (q: string | TemplateStringsArray, ...subs: unknown[]) => unknown[];
  /** Serialize the graph back to NDJSON bytes. */
  toNdjson: () => Uint8Array;
  /** Serialize the graph in a named format (`pg-json | pg-text | graphson | csv | ndjson`). */
  serialize: (format: string) => string;
  /** Release the underlying graph. The handle is invalid afterwards. */
  free: () => void;
};

/** Wrap an existing backend + handle as a {@link RustGraph}. */
export const attachGraph = (backend: Backend, handle: GraphHandle): RustGraph => ({
  get vertexCount() {
    return backend.vertexCount(handle);
  },
  get edgeCount() {
    return backend.edgeCount(handle);
  },
  get version() {
    return backend.version(handle);
  },
  epoch: (name) => backend.epoch(handle, name),
  query: (q: string | TemplateStringsArray, ...subs: unknown[]) => {
    const { text, params } = compileGql(q, subs);

    return decodeRows(backend.queryRows(handle, text, params));
  },
  queryArrow: (q: string | TemplateStringsArray, ...subs: unknown[]) => {
    const { text, params } = compileGql(q, subs);

    return backend.queryArrow(handle, text, params);
  },
  gremlin: (q, ...subs) =>
    parseJson(backend.gremlinJson(handle, spliceText(q, subs)), 'gremlin') as unknown[],
  toNdjson: () => backend.encodeNdjson(handle),
  serialize: (format) => decoder.decode(backend.serialize(handle, format)),
  free: () => backend.graphFree(handle),
});

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
