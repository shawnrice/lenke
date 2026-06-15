import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';

import { assertAbi } from './abi.js';
import type { Backend, GraphHandle } from './backend.js';

// usize / pointer are 64-bit on the native targets we load (arm64 / x86_64);
// the wasm backend uses 32-bit equivalents and lives in its own module.
const U = FFIType.u64_fast;

const SYMBOLS = {
  plg_abi_version: { args: [], returns: FFIType.u32 },
  plg_graph_from_ndjson: { args: [FFIType.ptr, U, FFIType.u32], returns: FFIType.ptr },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_graph_vertex_count: { args: [FFIType.ptr], returns: U },
  plg_graph_edge_count: { args: [FFIType.ptr], returns: U },
  plg_query_rows: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_query_arrow: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_gremlin_json: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_encode_ndjson: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  plg_serialize: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_deserialize: { args: [FFIType.ptr, U, FFIType.ptr, U], returns: FFIType.ptr },
  plg_free_buf: { args: [FFIType.ptr, U], returns: FFIType.void },
  plg_free_arrow: { args: [FFIType.ptr, U], returns: FFIType.void },
} as const;

const encoder = new TextEncoder();

// A graph handle is an opaque token in the public contract (a JS `number` so the
// wasm offset and the native pointer share one type). At the bun boundary it is
// a branded `Pointer`; these two helpers cross that seam in one place.
const asPtr = (h: GraphHandle): Pointer => h as unknown as Pointer;
const asHandle = (p: Pointer | null): GraphHandle => p as unknown as GraphHandle;

/**
 * Load the native dynamic library over `bun:ffi`. Pass the absolute path to the
 * built `libpl_graph_core.{dylib,so,dll}` (see `build:rust`).
 */
export const createFfiBackend = (libPath: string): Backend => {
  const { symbols } = dlopen(libPath, SYMBOLS);

  const abiVersion = symbols.plg_abi_version();
  assertAbi(abiVersion);

  // A query/encode call returns a crate-owned buffer (pointer + out_len). Read
  // it into a JS-owned copy and hand the crate buffer straight back to its
  // matching free, so nothing leaks and the copy outlives the native memory.
  const takeBuf = (
    call: (outLen: Pointer) => Pointer | null,
    free: (ptr: Pointer, len: number | bigint) => void,
    op: string,
  ): Uint8Array => {
    const outLen = new BigUint64Array(1);
    const resPtr = call(ptr(outLen));
    if (!resPtr) {
      throw new Error(`pl-graph: ${op} failed (parse error or unsupported clause)`);
    }
    const len = Number(outLen[0]);
    const copy = new Uint8Array(toArrayBuffer(resPtr, 0, len)).slice();
    free(resPtr, len);
    return copy;
  };

  return {
    abiVersion,

    graphFromNdjson: (bytes, parallel) => {
      const h = symbols.plg_graph_from_ndjson(ptr(bytes), bytes.byteLength, parallel ? 1 : 0);
      if (!h) {
        throw new Error('pl-graph: graphFromNdjson failed (invalid UTF-8 NDJSON)');
      }
      return asHandle(h);
    },
    graphFree: (handle) => symbols.plg_graph_free(asPtr(handle)),
    vertexCount: (handle) => Number(symbols.plg_graph_vertex_count(asPtr(handle))),
    edgeCount: (handle) => Number(symbols.plg_graph_edge_count(asPtr(handle))),

    queryRows: (handle, query) => {
      const q = encoder.encode(query);
      return takeBuf(
        (outLen) => symbols.plg_query_rows(asPtr(handle), ptr(q), q.byteLength, outLen),
        symbols.plg_free_buf,
        'query',
      );
    },

    queryArrow: (handle, query) => {
      const q = encoder.encode(query);
      return takeBuf(
        (outLen) => symbols.plg_query_arrow(asPtr(handle), ptr(q), q.byteLength, outLen),
        symbols.plg_free_arrow,
        'queryArrow',
      );
    },

    gremlinJson: (handle, query) => {
      const q = encoder.encode(query);
      return takeBuf(
        (outLen) => symbols.plg_gremlin_json(asPtr(handle), ptr(q), q.byteLength, outLen),
        symbols.plg_free_buf,
        'gremlin',
      );
    },

    encodeNdjson: (handle) =>
      takeBuf(
        (outLen) => symbols.plg_encode_ndjson(asPtr(handle), outLen),
        symbols.plg_free_buf,
        'encodeNdjson',
      ),

    serialize: (handle, format) => {
      const f = encoder.encode(format);
      return takeBuf(
        (outLen) => symbols.plg_serialize(asPtr(handle), ptr(f), f.byteLength, outLen),
        symbols.plg_free_buf,
        `serialize(${format})`,
      );
    },

    deserialize: (input, format) => {
      const f = encoder.encode(format);
      const h = symbols.plg_deserialize(ptr(input), input.byteLength, ptr(f), f.byteLength);
      if (!h) {
        throw new Error(`pl-graph: deserialize(${format}) failed (unknown format or parse error)`);
      }
      return asHandle(h);
    },
  };
};
