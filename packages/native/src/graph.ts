import type { Backend, GraphHandle } from './backend.js';

/** A decoded result row: column name → cell value. */
export type Row = Record<string, unknown>;

type RowSetJson = { columns: string[]; rows: unknown[][] };

const decoder = new TextDecoder();

const decodeRows = (bytes: Uint8Array): Row[] => {
  const { columns, rows } = JSON.parse(decoder.decode(bytes)) as RowSetJson;

  return rows.map((row) => {
    const out: Row = {};
    columns.forEach((col, i) => {
      out[col] = row[i];
    });

    return out;
  });
};

const isTemplate = (x: unknown): x is TemplateStringsArray =>
  Array.isArray((x as TemplateStringsArray)?.raw);

// Accept both the tagged-template form g\`MATCH ...\` and a plain string, mirroring
// the @pl-graph/gql `gql(g)` runner so consumers feel no seam between engines.
const toText = (q: string | TemplateStringsArray, subs: unknown[]): string => {
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
  /** Run a GQL query (tagged-template or string) → decoded rows. */
  query: (q: string | TemplateStringsArray, ...subs: unknown[]) => Row[];
  /** Run a GQL query → raw Arrow ("ARW1") columnar blob (decode with apache-arrow). */
  queryArrow: (q: string | TemplateStringsArray, ...subs: unknown[]) => Uint8Array;
  /** Run a textual Gremlin query → JSON-decoded result stream. */
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
  query: (q, ...subs) => decodeRows(backend.queryRows(handle, toText(q, subs))),
  queryArrow: (q, ...subs) => backend.queryArrow(handle, toText(q, subs)),
  gremlin: (q, ...subs) =>
    JSON.parse(decoder.decode(backend.gremlinJson(handle, toText(q, subs)))) as unknown[],
  toNdjson: () => backend.encodeNdjson(handle),
  serialize: (format) => decoder.decode(backend.serialize(handle, format)),
  free: () => backend.graphFree(handle),
});

/** Decode NDJSON bytes into a graph and return a {@link RustGraph} facade. */
export const graphFromNdjson = (
  backend: Backend,
  bytes: Uint8Array,
  opts: { parallel?: boolean } = {},
): RustGraph => attachGraph(backend, backend.graphFromNdjson(bytes, opts.parallel ?? true));

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
