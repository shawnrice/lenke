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

export type Backend = {
  /** Value of `lnk_abi_version()` for the loaded artifact. */
  readonly abiVersion: number;

  /** Decode NDJSON bytes into a graph; returns an owning handle. */
  graphFromNdjson: (bytes: Uint8Array, parallel: boolean) => GraphHandle;
  /** Release a handle from `graphFromNdjson`. */
  graphFree: (handle: GraphHandle) => void;

  vertexCount: (handle: GraphHandle) => number;
  edgeCount: (handle: GraphHandle) => number;

  /** Monotonic mutation counter — O(1) change signal for reactive snapshots. */
  version: (handle: GraphHandle) => number;
  /** Per-token change epoch (label / edge-type / property-key) for finer invalidation. */
  epoch: (handle: GraphHandle, name: string) => number;

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
};
