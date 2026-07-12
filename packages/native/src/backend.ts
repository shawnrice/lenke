/**
 * The backend contract. Defined in terms of *logical operations* — never raw
 * pointers — so the facade is identical across environments. Each backend hides
 * its own memory marshalling:
 *   - the FFI backend hands the crate a pointer to a JS-owned buffer and reads
 *     results in place (then frees the crate-owned result buffer);
 *   - the wasm backend copies bytes into linear memory via `lnk_alloc`, calls,
 *     then copies results back out.
 *
 * A graph handle is opaque: a native pointer or a wasm linear-memory offset,
 * both representable as a JS `number`. Treat it as a token, never arithmetic.
 */
export type GraphHandle = number;

/** An opaque handle to a compiled, reusable GQL query (see {@link Backend.prepare}). */
export type PreparedHandle = number;

/**
 * What a {@link Backend.mergeNdjson} applied vs. skipped — so a caller sees
 * anything that didn't land cleanly. Empty `*Skipped`/`phantomVertices` arrays
 * mean a fully clean merge.
 */
export type MergeReport = {
  /** Vertices actually inserted. */
  nodesAdded: number;
  /** Edges actually inserted. */
  edgesAdded: number;
  /** Batch node ids skipped because the id already existed (first-wins). */
  nodesSkipped: string[];
  /** Batch edge ids dropped because that explicit id already existed. */
  edgesSkipped: string[];
  /** Ids referenced as an edge endpoint but never declared as a node — created as bare vertices. */
  phantomVertices: string[];
};

export type Backend = {
  /** Value of `lnk_abi_version()` for the loaded artifact. */
  readonly abiVersion: number;

  /** Decode NDJSON bytes into a graph; returns an owning handle. */
  graphFromNdjson: (bytes: Uint8Array, parallel: boolean) => GraphHandle;
  /**
   * Bulk-append NDJSON bytes into an existing graph — a `COPY FROM` for a live
   * store. Ingests at bulk speed (no per-`INSERT` parse); a node whose id
   * already exists is first-wins-skipped. Returns a {@link MergeReport} of what
   * applied vs. skipped. Throws a coded error on a parse fault.
   */
  mergeNdjson: (handle: GraphHandle, bytes: Uint8Array) => MergeReport;
  /** Release a handle from `graphFromNdjson`. */
  graphFree: (handle: GraphHandle) => void;

  vertexCount: (handle: GraphHandle) => number;
  edgeCount: (handle: GraphHandle) => number;

  /** Monotonic mutation counter — O(1) change signal for reactive snapshots. */
  version: (handle: GraphHandle) => number;
  /** Per-token change epoch (label / edge-type / property-key) for finer invalidation. */
  epoch: (handle: GraphHandle, name: string) => number;

  /**
   * Declare an opt-in secondary index over a vertex / edge property `key`
   * (backfills existing elements, then stays current). Idempotent; turns
   * `WHERE x.key = …` constraints into index seeks instead of full scans.
   */
  createVertexIndex: (handle: GraphHandle, key: string) => void;
  createEdgeIndex: (handle: GraphHandle, key: string) => void;
  /**
   * Declare a UNIQUE constraint on `(label, key)`. Throws `ConstraintViolation`
   * if the current data already violates it. See docs/design/gql-extensions.md §3.
   */
  createUniqueConstraint: (handle: GraphHandle, label: string, key: string) => void;
  createRequiredConstraint: (handle: GraphHandle, label: string, key: string) => void;
  createTypeConstraint: (handle: GraphHandle, label: string, key: string, type: string) => void;
  /** Drop a vertex / edge property index (no-op if absent). */
  dropVertexIndex: (handle: GraphHandle, key: string) => void;
  dropEdgeIndex: (handle: GraphHandle, key: string) => void;
  /** The currently-indexed vertex / edge property keys (sorted). */
  vertexIndexes: (handle: GraphHandle) => string[];
  edgeIndexes: (handle: GraphHandle) => string[];

  /**
   * Run a GQL query; returns the `{columns, rows}` JSON document as bytes.
   * `params` is an optional pre-serialized flat JSON object of `$name`
   * bindings — values bind to already-parsed param slots at execute time and
   * never touch the GQL parser (the injection-safety contract).
   */
  queryRows: (handle: GraphHandle, query: string, params?: string) => Uint8Array;
  /** Run a GQL query; returns the Arrow ("ARW1") columnar blob bytes. Same optional `params`. */
  queryArrow: (handle: GraphHandle, query: string, params?: string) => Uint8Array;
  /** Run a textual Gremlin query; returns the JSON-array result bytes. */
  gremlinJson: (handle: GraphHandle, query: string) => Uint8Array;

  /** Serialize the whole graph back to NDJSON bytes. */
  encodeNdjson: (handle: GraphHandle) => Uint8Array;

  /** Serialize the graph in a named format (`pg-json | pg-text | graphson | csv | ndjson`). */
  serialize: (handle: GraphHandle, format: string) => Uint8Array;
  /** Deserialize bytes in a named format into a new graph handle. */
  deserialize: (input: Uint8Array, format: string) => GraphHandle;

  /**
   * Compile a GQL query into a reusable prepared statement (lex/parse/lower
   * once). Graph-independent; execute it against any graph with fresh params via
   * {@link Backend.preparedQueryRows}. Throws a coded error on a syntax error.
   */
  prepare: (text: string) => PreparedHandle;
  /** Release a handle from {@link Backend.prepare}. */
  preparedFree: (prepared: PreparedHandle) => void;
  /** Execute a prepared statement against `graph` → the `{columns, rows}` JSON bytes. */
  preparedQueryRows: (prepared: PreparedHandle, graph: GraphHandle, params?: string) => Uint8Array;
  /** Execute a prepared statement against `graph` → the Arrow ("ARW1") blob bytes. */
  preparedQueryArrow: (prepared: PreparedHandle, graph: GraphHandle, params?: string) => Uint8Array;
};
