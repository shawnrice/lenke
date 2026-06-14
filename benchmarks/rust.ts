// Thin JS wrapper over the native pl-graph-core crate via bun:ffi.
// Exposes the same operations the TS engine offers so the harness can time
// them side by side: load (decode NDJSON -> graph handle), query, predicate
// scan (SIMD), and encode.
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';

const LIB = new URL(
  '../crates/pl-graph-core/target/release/libpl_graph_core.dylib',
  import.meta.url,
).pathname;

const { symbols } = dlopen(LIB, {
  plg_abi_version: { args: [], returns: FFIType.u32 },
  plg_graph_from_ndjson: { args: [FFIType.ptr, FFIType.u64_fast, FFIType.u32], returns: FFIType.ptr },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_graph_vertex_count: { args: [FFIType.ptr], returns: FFIType.u64_fast },
  plg_graph_edge_count: { args: [FFIType.ptr], returns: FFIType.u64_fast },
  plg_query: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  plg_query_batch: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64,
  },
  plg_query_rows: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.ptr,
  },
  plg_predicate_scan: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.f64, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  plg_encode_ndjson: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  plg_free_buf: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
  plg_write_ndjson: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast], returns: FFIType.i64 },
});

const enc = new TextEncoder();
const dec = new TextDecoder();

export const abiVersion = (): number => symbols.plg_abi_version();

/** Marshal NDJSON bytes into Rust and build the columnar graph. Returns a handle. */
export const loadGraph = (ndjson: Uint8Array, parallel: boolean): bigint => {
  const handle = symbols.plg_graph_from_ndjson(ptr(ndjson), BigInt(ndjson.length), parallel ? 1 : 0);
  if (!handle) {
    throw new Error('plg_graph_from_ndjson returned null');
  }
  return handle as bigint;
};

export const freeGraph = (handle: bigint): void => symbols.plg_graph_free(handle);
export const vertexCount = (handle: bigint): number => Number(symbols.plg_graph_vertex_count(handle));
export const edgeCount = (handle: bigint): number => Number(symbols.plg_graph_edge_count(handle));

const outCount = new BigUint64Array(1);
const outSum = new Float64Array(1);
const outChecksum = new BigUint64Array(1);

export type Sig = { count: number; sum: number; checksum: bigint };

export const runQuery = (handle: bigint, q: string): Sig => {
  const qb = enc.encode(q);
  const rc = symbols.plg_query(
    handle,
    ptr(qb),
    BigInt(qb.length),
    ptr(outCount),
    ptr(outSum),
    ptr(outChecksum),
  );
  if (rc !== 0) {
    throw new Error(`plg_query failed (rc=${rc}) for: ${q}`);
  }
  return { count: Number(outCount[0]), sum: outSum[0]!, checksum: outChecksum[0]! };
};

/** Run many queries in a single FFI crossing (amortizes the per-call tax). */
export const runQueryBatch = (handle: bigint, queries: readonly string[]): Sig[] => {
  const joined = enc.encode(queries.join('\n'));
  const k = queries.length;
  const counts = new BigUint64Array(k);
  const sums = new Float64Array(k);
  const checks = new BigUint64Array(k);
  const n = Number(
    symbols.plg_query_batch(
      handle,
      ptr(joined),
      BigInt(joined.length),
      ptr(counts),
      ptr(sums),
      ptr(checks),
    ),
  );
  if (n < 0) {
    throw new Error('plg_query_batch failed');
  }
  return Array.from({ length: k }, (_, i) => ({
    count: Number(counts[i]),
    sum: sums[i]!,
    checksum: checks[i]!,
  }));
};

export type RowSet = { columns: string[]; rows: unknown[][] };

/** Run a query and decode its real result rows (the row-returning counterpart
 * to `runQuery`, which only yields the fingerprint). One JSON buffer crossing. */
export const queryRows = (handle: bigint, q: string): RowSet => {
  const qb = enc.encode(q);
  const p = symbols.plg_query_rows(handle, ptr(qb), BigInt(qb.length), ptr(outLen));
  if (!p) {
    throw new Error(`plg_query_rows failed for: ${q}`);
  }
  const len = Number(outLen[0]);
  const json = dec.decode(toArrayBuffer(p, 0, len));
  symbols.plg_free_buf(p, BigInt(len));
  return JSON.parse(json) as RowSet;
};

export const predicateScan = (handle: bigint, key: string, thr: number, simd: boolean): Sig => {
  const kb = enc.encode(key);
  const rc = symbols.plg_predicate_scan(
    handle,
    ptr(kb),
    BigInt(kb.length),
    thr,
    simd ? 1 : 0,
    ptr(outCount),
    ptr(outSum),
  );
  if (rc !== 0) {
    throw new Error(`plg_predicate_scan failed (rc=${rc}) for key=${key}`);
  }
  return { count: Number(outCount[0]), sum: outSum[0]! };
};

const outLen = new BigUint64Array(1);

/** Encode the graph to an NDJSON string (copies the native buffer back, then frees it). */
export const encodeNdjson = (handle: bigint): string => {
  const p = symbols.plg_encode_ndjson(handle, ptr(outLen));
  const len = Number(outLen[0]);
  const buf = toArrayBuffer(p, 0, len);
  const str = dec.decode(buf);
  symbols.plg_free_buf(p, BigInt(len));
  return str;
};

/** Produce write-ready NDJSON bytes (no decode to a JS string). Returns byte length. */
export const encodeBytes = (handle: bigint): number => {
  const p = symbols.plg_encode_ndjson(handle, ptr(outLen));
  const len = Number(outLen[0]);
  symbols.plg_free_buf(p, BigInt(len));
  return len;
};

/** Serialize straight to a file natively — bytes never cross into JS. Returns bytes written. */
export const writeNdjson = (handle: bigint, path: string): number => {
  const pb = enc.encode(path);
  return Number(symbols.plg_write_ndjson(handle, ptr(pb), BigInt(pb.length)));
};
