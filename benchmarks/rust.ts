// Thin JS wrapper over the native lenke-core crate via bun:ffi.
// Exposes the same operations the TS engine offers so the harness can time
// them side by side: load (decode NDJSON -> graph handle), query, and encode.
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';

const LIB = new URL('../crates/lenke-core/target/release/liblenke_core.dylib', import.meta.url)
  .pathname;

const { symbols } = dlopen(LIB, {
  lnk_abi_version: { args: [], returns: FFIType.u32 },
  lnk_graph_from_ndjson: {
    args: [FFIType.ptr, FFIType.u64_fast, FFIType.u32],
    returns: FFIType.ptr,
  },
  lnk_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  lnk_graph_vertex_count: { args: [FFIType.ptr], returns: FFIType.u64_fast },
  lnk_graph_edge_count: { args: [FFIType.ptr], returns: FFIType.u64_fast },
  lnk_query: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  lnk_query_batch: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64,
  },
  lnk_query_rows: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.ptr,
  },
  lnk_encode_ndjson: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  lnk_free_buf: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
  lnk_write_ndjson: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast], returns: FFIType.i64 },
});

const enc = new TextEncoder();
const dec = new TextDecoder();

export const abiVersion = (): number => symbols.lnk_abi_version();

/** Marshal NDJSON bytes into Rust and build the columnar graph. Returns a handle. */
export const loadGraph = (ndjson: Uint8Array, parallel: boolean): Pointer => {
  const handle = symbols.lnk_graph_from_ndjson(
    ptr(ndjson),
    BigInt(ndjson.length),
    parallel ? 1 : 0,
  );

  if (!handle) {
    throw new Error('lnk_graph_from_ndjson returned null');
  }

  return handle;
};

export const freeGraph = (handle: Pointer): void => symbols.lnk_graph_free(handle);
export const vertexCount = (handle: Pointer): number =>
  Number(symbols.lnk_graph_vertex_count(handle));
export const edgeCount = (handle: Pointer): number => Number(symbols.lnk_graph_edge_count(handle));

const outCount = new BigUint64Array(1);
const outSum = new Float64Array(1);
const outChecksum = new BigUint64Array(1);

export type Sig = { count: number; sum: number; checksum: bigint };

export const runQuery = (handle: Pointer, q: string): Sig => {
  const qb = enc.encode(q);
  const rc = symbols.lnk_query(
    handle,
    ptr(qb),
    BigInt(qb.length),
    ptr(outCount),
    ptr(outSum),
    ptr(outChecksum),
  );

  if (rc !== 0) {
    throw new Error(`lnk_query failed (rc=${rc}) for: ${q}`);
  }

  return { count: Number(outCount[0]), sum: outSum[0], checksum: outChecksum[0] };
};

/** Run many queries in a single FFI crossing (amortizes the per-call tax). */
export const runQueryBatch = (handle: Pointer, queries: readonly string[]): Sig[] => {
  const joined = enc.encode(queries.join('\n'));
  const k = queries.length;
  const counts = new BigUint64Array(k);
  const sums = new Float64Array(k);
  const checks = new BigUint64Array(k);
  const n = Number(
    symbols.lnk_query_batch(
      handle,
      ptr(joined),
      BigInt(joined.length),
      ptr(counts),
      ptr(sums),
      ptr(checks),
    ),
  );

  if (n < 0) {
    throw new Error('lnk_query_batch failed');
  }

  return Array.from({ length: k }, (_, i) => ({
    count: Number(counts[i]),
    sum: sums[i],
    checksum: checks[i],
  }));
};

export type RowSet = { columns: string[]; rows: unknown[][] };

/** Run a query and decode its real result rows (the row-returning counterpart
 * to `runQuery`, which only yields the fingerprint). One JSON buffer crossing. */
export const queryRows = (handle: Pointer, q: string): RowSet => {
  const qb = enc.encode(q);
  const p = symbols.lnk_query_rows(handle, ptr(qb), BigInt(qb.length), ptr(outLen));

  if (!p) {
    throw new Error(`lnk_query_rows failed for: ${q}`);
  }

  const len = Number(outLen[0]);
  const json = dec.decode(toArrayBuffer(p, 0, len));
  symbols.lnk_free_buf(p, BigInt(len));

  return JSON.parse(json) as RowSet;
};

const outLen = new BigUint64Array(1);

/** Encode the graph to an NDJSON string (copies the native buffer back, then frees it). */
export const encodeNdjson = (handle: Pointer): string => {
  const p = symbols.lnk_encode_ndjson(handle, ptr(outLen));

  if (!p) {
    throw new Error('lnk_encode_ndjson returned null');
  }

  const len = Number(outLen[0]);
  const buf = toArrayBuffer(p, 0, len);
  const str = dec.decode(buf);
  symbols.lnk_free_buf(p, BigInt(len));

  return str;
};

/** Produce write-ready NDJSON bytes (no decode to a JS string). Returns byte length. */
export const encodeBytes = (handle: Pointer): number => {
  const p = symbols.lnk_encode_ndjson(handle, ptr(outLen));
  const len = Number(outLen[0]);
  symbols.lnk_free_buf(p, BigInt(len));

  return len;
};

/** Serialize straight to a file natively — bytes never cross into JS. Returns bytes written. */
export const writeNdjson = (handle: Pointer, path: string): number => {
  const pb = enc.encode(path);

  return Number(symbols.lnk_write_ndjson(handle, ptr(pb), BigInt(pb.length)));
};
