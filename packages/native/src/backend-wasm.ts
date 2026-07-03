import { ErrorCode, LenkeError } from '@lenke/errors';

import { assertAbi } from './abi.js';
import type { Backend, GraphHandle } from './backend.js';
import { type ErrorReport, parseErrorReport } from './marshal.js';

// The wasm module exports the same `lnk_*` C ABI as the native library, but
// everything is 32-bit linear-memory offsets (usize → i32) and u64 returns
// arrive as BigInt. JS cannot point at its own heap, so inputs are copied into
// the module's memory via `lnk_alloc` first.
type WasmExports = {
  memory: WebAssembly.Memory;
  lnk_abi_version: () => number;
  lnk_alloc: (len: number) => number;
  lnk_dealloc: (ptr: number, len: number) => void;
  lnk_graph_from_ndjson: (ptr: number, len: number, parallel: number) => number;
  lnk_graph_free: (h: number) => void;
  lnk_graph_vertex_count: (h: number) => bigint;
  lnk_graph_edge_count: (h: number) => bigint;
  lnk_graph_version: (h: number) => bigint;
  lnk_graph_epoch: (h: number, name: number, nameLen: number) => bigint;
  lnk_query_rows: (
    h: number,
    q: number,
    qlen: number,
    p: number,
    plen: number,
    outLen: number,
  ) => number;
  lnk_query_arrow: (
    h: number,
    q: number,
    qlen: number,
    p: number,
    plen: number,
    outLen: number,
  ) => number;
  lnk_gremlin_json: (h: number, q: number, qlen: number, outLen: number) => number;
  lnk_encode_ndjson: (h: number, outLen: number) => number;
  lnk_serialize: (h: number, fmt: number, fmtLen: number, outLen: number) => number;
  lnk_deserialize: (ptr: number, len: number, fmt: number, fmtLen: number) => number;
  lnk_free_buf: (ptr: number, len: number) => void;
  lnk_free_arrow: (ptr: number, len: number) => void;
  // Exported unconditionally by the crate (the reader isn't feature-gated), so
  // the wasm backend can read the same structured last-error the FFI backend
  // does — error-code parity across both backends.
  lnk_last_error_json: (outLen: number) => number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A compiled module, raw bytes, or a streaming response — whatever the host has. */
export type WasmSource =
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | Promise<Response>;

const instantiate = async (source: WasmSource): Promise<WebAssembly.Instance> => {
  if (source instanceof Response || source instanceof Promise) {
    const { instance } = await WebAssembly.instantiateStreaming(source, {});

    return instance;
  }

  // `instantiate` returns an `Instance` for a Module and `{ instance, module }`
  // for raw bytes; lib typings disagree on the overloads, so normalize both
  // shapes at runtime instead of leaning on a single declared return type.
  const result = (await WebAssembly.instantiate(source as ArrayBuffer, {})) as unknown as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };

  return 'instance' in result ? result.instance : result;
};

/**
 * Instantiate the wasm backend. `source` is the `lenke_core.wasm` artifact
 * (see `build:wasm`) as a module, bytes, or fetch `Response` for streaming
 * compilation in the browser.
 */
export const createWasmBackend = async (source: WasmSource): Promise<Backend> => {
  const instance = await instantiate(source);
  const ex = instance.exports as unknown as WasmExports;

  const abiVersion = ex.lnk_abi_version();
  assertAbi(abiVersion);

  // memory.buffer is replaced whenever the heap grows, so views must be fresh
  // on every access — never cache a Uint8Array across a call that can allocate.
  const u8 = (): Uint8Array => new Uint8Array(ex.memory.buffer);
  const dv = (): DataView => new DataView(ex.memory.buffer);

  const writeBytes = (bytes: Uint8Array): number => {
    const p = ex.lnk_alloc(bytes.byteLength);
    u8().set(bytes, p);

    return p;
  };

  // Copy `len` bytes out of linear memory at `ptr`, checking the range sits
  // inside the current buffer. `out_len` is ours, but a range past the heap end
  // is a broken result contract — fail loudly rather than let `slice` silently
  // clamp to a short buffer. Re-reads `u8()` because the call that produced the
  // result may have grown (and replaced) the memory.
  const readBytes = (ptr: number, len: number, op: string): Uint8Array => {
    const mem = u8();

    if (ptr < 0 || len < 0 || ptr + len > mem.length) {
      throw new LenkeError(
        `lenke: ${op}: native result [${ptr}, ${ptr + len}) escapes wasm memory (${mem.length} bytes)`,
        { code: ErrorCode.Ffi, details: { ptr, len, memBytes: mem.length } },
      );
    }

    return mem.slice(ptr, ptr + len);
  };

  // Read (and clear) the crate's out-of-band last-error after a null return — the
  // wasm twin of the FFI backend's `readLastError`. The crate writes the report
  // into a fresh linear-memory buffer (which can grow the heap), so views are
  // taken fresh after the call. Returns null when nothing is pending.
  const readLastError = (): ErrorReport | null => {
    const outLenPtr = ex.lnk_alloc(4);

    try {
      const errPtr = ex.lnk_last_error_json(outLenPtr);

      if (!errPtr) {
        return null;
      }

      const len = dv().getUint32(outLenPtr, true);
      const json = decoder.decode(readBytes(errPtr, len, 'last-error'));
      ex.lnk_free_buf(errPtr, len);

      return parseErrorReport(json);
    } finally {
      ex.lnk_dealloc(outLenPtr, 4);
    }
  };

  // Turn a null return into a `LenkeError` carrying the shared code, identical
  // to the FFI backend — so `hasErrorCode(e, ErrorCode.Syntax)` matches the same
  // way whether the graph is server-side native or browser-side wasm. `fallback`
  // is used only if the crate left no report.
  const fail = (op: string, fallback: ErrorCode): never => {
    const report = readLastError();

    if (report) {
      throw new LenkeError(`lenke: ${op}: ${report.message}`, {
        code: report.code,
        details: report.details ?? undefined,
      });
    }

    throw new LenkeError(`lenke: ${op} failed`, { code: fallback });
  };

  // Run a buffer-returning call: stage the query string (and optional params
  // JSON — a zero pointer means "no params" on the crate side), give the crate
  // a 4-byte slot for out_len, copy the result back out, then free everything.
  const takeBuf = (
    handle: GraphHandle,
    query: string | null,
    params: string | null,
    call: (h: number, q: number, qlen: number, p: number, plen: number, outLen: number) => number,
    free: (ptr: number, len: number) => void,
    op: string,
  ): Uint8Array => {
    const q = query === null ? null : encoder.encode(query);
    const pr = params === null ? null : encoder.encode(params);
    const qPtr = q ? writeBytes(q) : 0;
    const pPtr = pr ? writeBytes(pr) : 0;
    const outLenPtr = ex.lnk_alloc(4);

    try {
      const resPtr = call(handle, qPtr, q?.byteLength ?? 0, pPtr, pr?.byteLength ?? 0, outLenPtr);

      if (!resPtr) {
        return fail(op, ErrorCode.Ffi);
      }

      const len = dv().getUint32(outLenPtr, true);
      const copy = readBytes(resPtr, len, op);
      free(resPtr, len);

      return copy;
    } finally {
      if (qPtr) {
        ex.lnk_dealloc(qPtr, q!.byteLength);
      }

      if (pPtr) {
        ex.lnk_dealloc(pPtr, pr!.byteLength);
      }

      ex.lnk_dealloc(outLenPtr, 4);
    }
  };

  return {
    abiVersion,

    graphFromNdjson: (bytes, parallel) => {
      const p = writeBytes(bytes);

      try {
        const h = ex.lnk_graph_from_ndjson(p, bytes.byteLength, parallel ? 1 : 0);

        if (!h) {
          return fail('graphFromNdjson', ErrorCode.InvalidJson);
        }

        return h;
      } finally {
        ex.lnk_dealloc(p, bytes.byteLength);
      }
    },
    graphFree: (handle) => ex.lnk_graph_free(handle),
    vertexCount: (handle) => Number(ex.lnk_graph_vertex_count(handle)),
    edgeCount: (handle) => Number(ex.lnk_graph_edge_count(handle)),
    version: (handle) => Number(ex.lnk_graph_version(handle)),
    epoch: (handle, name) => {
      const n = encoder.encode(name);
      const p = writeBytes(n);

      try {
        return Number(ex.lnk_graph_epoch(handle, p, n.byteLength));
      } finally {
        ex.lnk_dealloc(p, n.byteLength);
      }
    },

    queryRows: (handle, query, params) =>
      takeBuf(handle, query, params ?? null, ex.lnk_query_rows, ex.lnk_free_buf, 'query'),
    queryArrow: (handle, query, params) =>
      takeBuf(handle, query, params ?? null, ex.lnk_query_arrow, ex.lnk_free_arrow, 'queryArrow'),

    // gremlin takes no params doc: adapt away the unused (p, plen) slots.
    gremlinJson: (handle, query) =>
      takeBuf(
        handle,
        query,
        null,
        (h, q, qlen, _p, _plen, outLen) => ex.lnk_gremlin_json(h, q, qlen, outLen),
        ex.lnk_free_buf,
        'gremlin',
      ),

    // encode takes no query string: pass null and call with (handle, outLen).
    encodeNdjson: (handle) =>
      takeBuf(
        handle,
        null,
        null,
        (h, _q, _qlen, _p, _plen, outLen) => ex.lnk_encode_ndjson(h, outLen),
        ex.lnk_free_buf,
        'encodeNdjson',
      ),

    // serialize has the same (handle, string, outLen) shape as a query: the
    // format name rides the "query" slot.
    serialize: (handle, format) =>
      takeBuf(
        handle,
        format,
        null,
        (h, q, qlen, _p, _plen, outLen) => ex.lnk_serialize(h, q, qlen, outLen),
        ex.lnk_free_buf,
        `serialize(${format})`,
      ),

    deserialize: (input, format) => {
      const f = encoder.encode(format);
      const inPtr = writeBytes(input);
      const fPtr = writeBytes(f);

      try {
        const h = ex.lnk_deserialize(inPtr, input.byteLength, fPtr, f.byteLength);

        if (!h) {
          return fail(`deserialize(${format})`, ErrorCode.UnknownFormat);
        }

        return h;
      } finally {
        ex.lnk_dealloc(inPtr, input.byteLength);
        ex.lnk_dealloc(fPtr, f.byteLength);
      }
    },
  };
};
