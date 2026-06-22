import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';

import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import { assertAbi } from './abi.js';
import type { Backend, GraphHandle } from './backend.js';
import { asByteLength, type ErrorReport, parseErrorReport } from './marshal.js';

// usize / pointer are 64-bit on the native targets we load (arm64 / x86_64);
// the wasm backend uses 32-bit equivalents and lives in its own module.
const U = FFIType.u64_fast;

const SYMBOLS = {
  plg_abi_version: { args: [], returns: FFIType.u32 },
  plg_graph_from_ndjson: { args: [FFIType.ptr, U, FFIType.u32], returns: FFIType.ptr },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_graph_vertex_count: { args: [FFIType.ptr], returns: U },
  plg_graph_edge_count: { args: [FFIType.ptr], returns: U },
  plg_graph_version: { args: [FFIType.ptr], returns: U },
  plg_graph_epoch: { args: [FFIType.ptr, FFIType.ptr, U], returns: U },
  plg_query_rows: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_query_arrow: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_gremlin_json: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_encode_ndjson: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  plg_serialize: { args: [FFIType.ptr, FFIType.ptr, U, FFIType.ptr], returns: FFIType.ptr },
  plg_deserialize: { args: [FFIType.ptr, U, FFIType.ptr, U], returns: FFIType.ptr },
  plg_free_buf: { args: [FFIType.ptr, U], returns: FFIType.void },
  plg_free_arrow: { args: [FFIType.ptr, U], returns: FFIType.void },
  plg_last_error_json: { args: [FFIType.ptr], returns: FFIType.ptr },
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

  // Read (and clear) the crate's out-of-band last-error after a null/-1 return.
  // The error rides this side channel, never the data return — so the binary
  // Arrow carrier stays a pure column blob. Returns null if nothing is pending.
  const readLastError = (): ErrorReport | null => {
    const outLen = new BigUint64Array(1);
    const errPtr = symbols.plg_last_error_json(ptr(outLen));

    if (!errPtr) {
      return null;
    }

    const len = asByteLength(outLen[0], 'last-error');
    const json = decoder.decode(new Uint8Array(toArrayBuffer(errPtr, 0, len)).slice());
    symbols.plg_free_buf(errPtr, len);

    // A malformed report is itself an FFI fault; `parseErrorReport` returns null
    // and `fail` falls back to a generic code.
    return parseErrorReport(json);
  };

  // Turn a failure sentinel into a `PlGraphError` carrying the shared code, so a
  // consumer matches `hasErrorCode(e, ErrorCode.Syntax)` identically whether the
  // error came from the TS engine or this native one. `fallback` is used only if
  // the crate left no report (e.g. an older lib, or a non-instrumented path).
  const fail = (op: string, fallback: ErrorCode): never => {
    const report = readLastError();

    if (report) {
      throw new PlGraphError(`pl-graph: ${op}: ${report.message}`, {
        code: report.code,
        details: report.details ?? undefined,
      });
    }

    throw new PlGraphError(`pl-graph: ${op} failed`, { code: fallback });
  };

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
      return fail(op, ErrorCode.Ffi);
    }

    const len = asByteLength(outLen[0], op);
    const copy = new Uint8Array(toArrayBuffer(resPtr, 0, len)).slice();
    free(resPtr, len);

    return copy;
  };

  return {
    abiVersion,

    graphFromNdjson: (bytes, parallel) => {
      const h = symbols.plg_graph_from_ndjson(ptr(bytes), bytes.byteLength, parallel ? 1 : 0);

      if (!h) {
        return fail('graphFromNdjson', ErrorCode.InvalidJson);
      }

      return asHandle(h);
    },
    graphFree: (handle) => symbols.plg_graph_free(asPtr(handle)),
    vertexCount: (handle) => Number(symbols.plg_graph_vertex_count(asPtr(handle))),
    edgeCount: (handle) => Number(symbols.plg_graph_edge_count(asPtr(handle))),
    version: (handle) => Number(symbols.plg_graph_version(asPtr(handle))),
    epoch: (handle, name) => {
      const n = encoder.encode(name);

      return Number(symbols.plg_graph_epoch(asPtr(handle), ptr(n), n.byteLength));
    },

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
        return fail(`deserialize(${format})`, ErrorCode.UnknownFormat);
      }

      return asHandle(h);
    },
  };
};
