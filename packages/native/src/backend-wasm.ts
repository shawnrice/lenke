import { assertAbi } from './abi.js';
import type { Backend, GraphHandle } from './backend.js';

// The wasm module exports the same `plg_*` C ABI as the native library, but
// everything is 32-bit linear-memory offsets (usize → i32) and u64 returns
// arrive as BigInt. JS cannot point at its own heap, so inputs are copied into
// the module's memory via `plg_alloc` first.
type WasmExports = {
  memory: WebAssembly.Memory;
  plg_abi_version: () => number;
  plg_alloc: (len: number) => number;
  plg_dealloc: (ptr: number, len: number) => void;
  plg_graph_from_ndjson: (ptr: number, len: number, parallel: number) => number;
  plg_graph_free: (h: number) => void;
  plg_graph_vertex_count: (h: number) => bigint;
  plg_graph_edge_count: (h: number) => bigint;
  plg_graph_version: (h: number) => bigint;
  plg_graph_epoch: (h: number, name: number, nameLen: number) => bigint;
  plg_query_rows: (h: number, q: number, qlen: number, outLen: number) => number;
  plg_query_arrow: (h: number, q: number, qlen: number, outLen: number) => number;
  plg_gremlin_json: (h: number, q: number, qlen: number, outLen: number) => number;
  plg_encode_ndjson: (h: number, outLen: number) => number;
  plg_serialize: (h: number, fmt: number, fmtLen: number, outLen: number) => number;
  plg_deserialize: (ptr: number, len: number, fmt: number, fmtLen: number) => number;
  plg_free_buf: (ptr: number, len: number) => void;
  plg_free_arrow: (ptr: number, len: number) => void;
};

const encoder = new TextEncoder();

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
 * Instantiate the wasm backend. `source` is the `pl_graph_core.wasm` artifact
 * (see `build:wasm`) as a module, bytes, or fetch `Response` for streaming
 * compilation in the browser.
 */
export const createWasmBackend = async (source: WasmSource): Promise<Backend> => {
  const instance = await instantiate(source);
  const ex = instance.exports as unknown as WasmExports;

  const abiVersion = ex.plg_abi_version();
  assertAbi(abiVersion);

  // memory.buffer is replaced whenever the heap grows, so views must be fresh
  // on every access — never cache a Uint8Array across a call that can allocate.
  const u8 = (): Uint8Array => new Uint8Array(ex.memory.buffer);
  const dv = (): DataView => new DataView(ex.memory.buffer);

  const writeBytes = (bytes: Uint8Array): number => {
    const p = ex.plg_alloc(bytes.byteLength);
    u8().set(bytes, p);
    return p;
  };

  // Run a buffer-returning call: stage the query string, give the crate a 4-byte
  // slot for out_len, copy the result back out, then free both crate + input.
  const takeBuf = (
    handle: GraphHandle,
    query: string | null,
    call: (h: number, q: number, qlen: number, outLen: number) => number,
    free: (ptr: number, len: number) => void,
    op: string,
  ): Uint8Array => {
    const q = query === null ? null : encoder.encode(query);
    const qPtr = q ? writeBytes(q) : 0;
    const outLenPtr = ex.plg_alloc(4);
    try {
      const resPtr = q
        ? call(handle, qPtr, q.byteLength, outLenPtr)
        : call(handle, 0, 0, outLenPtr);
      if (!resPtr) {
        throw new Error(`pl-graph: ${op} failed (parse error or unsupported clause)`);
      }
      const len = dv().getUint32(outLenPtr, true);
      const copy = u8().slice(resPtr, resPtr + len);
      free(resPtr, len);
      return copy;
    } finally {
      if (qPtr) {
        ex.plg_dealloc(qPtr, q!.byteLength);
      }
      ex.plg_dealloc(outLenPtr, 4);
    }
  };

  return {
    abiVersion,

    graphFromNdjson: (bytes, parallel) => {
      const p = writeBytes(bytes);
      try {
        const h = ex.plg_graph_from_ndjson(p, bytes.byteLength, parallel ? 1 : 0);
        if (!h) {
          throw new Error('pl-graph: graphFromNdjson failed (invalid UTF-8 NDJSON)');
        }
        return h;
      } finally {
        ex.plg_dealloc(p, bytes.byteLength);
      }
    },
    graphFree: (handle) => ex.plg_graph_free(handle),
    vertexCount: (handle) => Number(ex.plg_graph_vertex_count(handle)),
    edgeCount: (handle) => Number(ex.plg_graph_edge_count(handle)),
    version: (handle) => Number(ex.plg_graph_version(handle)),
    epoch: (handle, name) => {
      const n = encoder.encode(name);
      const p = writeBytes(n);
      try {
        return Number(ex.plg_graph_epoch(handle, p, n.byteLength));
      } finally {
        ex.plg_dealloc(p, n.byteLength);
      }
    },

    queryRows: (handle, query) =>
      takeBuf(handle, query, ex.plg_query_rows, ex.plg_free_buf, 'query'),
    queryArrow: (handle, query) =>
      takeBuf(handle, query, ex.plg_query_arrow, ex.plg_free_arrow, 'queryArrow'),
    gremlinJson: (handle, query) =>
      takeBuf(handle, query, ex.plg_gremlin_json, ex.plg_free_buf, 'gremlin'),

    // encode takes no query string: pass null and call with (handle, outLen).
    encodeNdjson: (handle) =>
      takeBuf(
        handle,
        null,
        (h, _q, _qlen, outLen) => ex.plg_encode_ndjson(h, outLen),
        ex.plg_free_buf,
        'encodeNdjson',
      ),

    // serialize has the same (handle, string, outLen) shape as a query: the
    // format name rides the "query" slot.
    serialize: (handle, format) =>
      takeBuf(handle, format, ex.plg_serialize, ex.plg_free_buf, `serialize(${format})`),

    deserialize: (input, format) => {
      const f = encoder.encode(format);
      const inPtr = writeBytes(input);
      const fPtr = writeBytes(f);
      try {
        const h = ex.plg_deserialize(inPtr, input.byteLength, fPtr, f.byteLength);
        if (!h) {
          throw new Error(`pl-graph: deserialize(${format}) failed (unknown format or parse error)`);
        }
        return h;
      } finally {
        ex.plg_dealloc(inPtr, input.byteLength);
        ex.plg_dealloc(fPtr, f.byteLength);
      }
    },
  };
};
