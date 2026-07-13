import { ErrorCode, LenkeError } from '@lenke/errors';

import { assertAbi } from './abi.js';
import type { Backend, GraphHandle, MergeReport } from './backend.js';
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
  lnk_merge_ndjson: (g: number, ptr: number, len: number, outLen: number) => number;
  lnk_graph_free: (h: number) => void;
  lnk_graph_vertex_count: (h: number) => bigint;
  lnk_graph_edge_count: (h: number) => bigint;
  lnk_graph_version: (h: number) => bigint;
  lnk_graph_epoch: (h: number, name: number, nameLen: number) => bigint;
  lnk_create_vertex_index: (h: number, key: number, keyLen: number) => number;
  lnk_create_edge_index: (h: number, key: number, keyLen: number) => number;
  lnk_create_unique_constraint: (
    h: number,
    label: number,
    labelLen: number,
    key: number,
    keyLen: number,
  ) => number;
  lnk_create_required_constraint: (
    h: number,
    label: number,
    labelLen: number,
    key: number,
    keyLen: number,
  ) => number;
  lnk_create_type_constraint: (
    h: number,
    label: number,
    labelLen: number,
    key: number,
    keyLen: number,
    type: number,
    typeLen: number,
  ) => number;
  lnk_create_edge_unique_constraint: (
    h: number,
    etype: number,
    etypeLen: number,
    key: number,
    keyLen: number,
  ) => number;
  lnk_create_edge_required_constraint: (
    h: number,
    etype: number,
    etypeLen: number,
    key: number,
    keyLen: number,
  ) => number;
  lnk_create_edge_type_constraint: (
    h: number,
    etype: number,
    etypeLen: number,
    key: number,
    keyLen: number,
    type: number,
    typeLen: number,
  ) => number;
  lnk_create_cardinality_constraint: (
    h: number,
    label: number,
    labelLen: number,
    etype: number,
    etypeLen: number,
    direction: number,
    min: number,
    // i64 param crosses the wasm boundary as a BigInt (-1n = unbounded).
    max: bigint,
  ) => number;
  lnk_drop_vertex_index: (h: number, key: number, keyLen: number) => number;
  lnk_drop_edge_index: (h: number, key: number, keyLen: number) => number;
  lnk_begin_tx: (h: number) => number;
  lnk_commit_tx: (h: number) => number;
  lnk_rollback_tx: (h: number) => number;
  lnk_vertex_indexes: (h: number, outLen: number) => number;
  lnk_edge_indexes: (h: number, outLen: number) => number;
  lnk_prepare: (q: number, qlen: number) => number;
  lnk_prepared_free: (p: number) => void;
  lnk_prepared_query_rows: (
    p: number,
    g: number,
    pr: number,
    prlen: number,
    outLen: number,
  ) => number;
  lnk_prepared_query_arrow: (
    p: number,
    g: number,
    pr: number,
    prlen: number,
    outLen: number,
  ) => number;
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
      // If `len` is corrupt (out of bounds) `readBytes` throws BEFORE this free —
      // intentional: the buffer's true size is unknown, so `lnk_free_buf(errPtr,
      // <wrong len>)` would be undefined behavior. Leaking once on broken ABI
      // data beats a bad dealloc; the `finally` still frees `outLenPtr`.
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
      // As in readLastError: a corrupt `len` makes `readBytes` throw before this
      // free, and `resPtr` is intentionally left unfreed — its true size is
      // unknown, so freeing with a wrong len would be UB. The outer `finally`
      // frees the arg pointers regardless.
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
    mergeNdjson: (handle, bytes) => {
      // The staged input buffer must outlive the call (the crate reads it, then
      // writes a fresh result buffer); free it after takeBuf copies the result.
      const inPtr = writeBytes(bytes);

      try {
        return JSON.parse(
          decoder.decode(
            takeBuf(
              handle,
              null,
              null,
              (_h, _q, _ql, _p, _pl, o) => ex.lnk_merge_ndjson(handle, inPtr, bytes.byteLength, o),
              ex.lnk_free_buf,
              'mergeNdjson',
            ),
          ),
        ) as MergeReport;
      } finally {
        ex.lnk_dealloc(inPtr, bytes.byteLength);
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
    createVertexIndex: (handle, key) => {
      const k = encoder.encode(key);
      const p = writeBytes(k);

      try {
        ex.lnk_create_vertex_index(handle, p, k.byteLength);
      } finally {
        ex.lnk_dealloc(p, k.byteLength);
      }
    },
    createUniqueConstraint: (handle, label, key) => {
      const l = encoder.encode(label);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);

      try {
        const r = ex.lnk_create_unique_constraint(handle, lp, l.byteLength, kp, k.byteLength);

        if (r === -2) {
          throw new LenkeError(
            `lenke: createUniqueConstraint(${label}, ${key}): existing data already violates the unique constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createUniqueConstraint failed', { code: ErrorCode.Ffi });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
      }
    },
    createRequiredConstraint: (handle, label, key) => {
      const l = encoder.encode(label);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);

      try {
        const r = ex.lnk_create_required_constraint(handle, lp, l.byteLength, kp, k.byteLength);

        if (r === -2) {
          throw new LenkeError(
            `lenke: createRequiredConstraint(${label}, ${key}): existing data already violates the required constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createRequiredConstraint failed', { code: ErrorCode.Ffi });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
      }
    },
    createTypeConstraint: (handle, label, key, type) => {
      const l = encoder.encode(label);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);
      const t = encoder.encode(type);
      const tp = writeBytes(t);

      try {
        const r = ex.lnk_create_type_constraint(
          handle,
          lp,
          l.byteLength,
          kp,
          k.byteLength,
          tp,
          t.byteLength,
        );

        if (r === -3) {
          throw new LenkeError(
            `lenke: createTypeConstraint(${label}, ${key}, ${type}): unknown scalar type`,
            { code: ErrorCode.InvalidValue },
          );
        }

        if (r === -2) {
          throw new LenkeError(
            `lenke: createTypeConstraint(${label}, ${key}, ${type}): existing data already violates the type constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createTypeConstraint failed', { code: ErrorCode.Ffi });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
        ex.lnk_dealloc(tp, t.byteLength);
      }
    },
    createEdgeUniqueConstraint: (handle, edgeType, key) => {
      const l = encoder.encode(edgeType);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);

      try {
        const r = ex.lnk_create_edge_unique_constraint(handle, lp, l.byteLength, kp, k.byteLength);

        if (r === -2) {
          throw new LenkeError(
            `lenke: createEdgeUniqueConstraint(${edgeType}, ${key}): existing data already violates the unique constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createEdgeUniqueConstraint failed', { code: ErrorCode.Ffi });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
      }
    },
    createEdgeRequiredConstraint: (handle, edgeType, key) => {
      const l = encoder.encode(edgeType);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);

      try {
        const r = ex.lnk_create_edge_required_constraint(
          handle,
          lp,
          l.byteLength,
          kp,
          k.byteLength,
        );

        if (r === -2) {
          throw new LenkeError(
            `lenke: createEdgeRequiredConstraint(${edgeType}, ${key}): existing data already violates the required constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createEdgeRequiredConstraint failed', {
            code: ErrorCode.Ffi,
          });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
      }
    },
    createEdgeTypeConstraint: (handle, edgeType, key, type) => {
      const l = encoder.encode(edgeType);
      const lp = writeBytes(l);
      const k = encoder.encode(key);
      const kp = writeBytes(k);
      const t = encoder.encode(type);
      const tp = writeBytes(t);

      try {
        const r = ex.lnk_create_edge_type_constraint(
          handle,
          lp,
          l.byteLength,
          kp,
          k.byteLength,
          tp,
          t.byteLength,
        );

        if (r === -3) {
          throw new LenkeError(
            `lenke: createEdgeTypeConstraint(${edgeType}, ${key}, ${type}): unknown scalar type`,
            { code: ErrorCode.InvalidValue },
          );
        }

        if (r === -2) {
          throw new LenkeError(
            `lenke: createEdgeTypeConstraint(${edgeType}, ${key}, ${type}): existing data already violates the type constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createEdgeTypeConstraint failed', { code: ErrorCode.Ffi });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(kp, k.byteLength);
        ex.lnk_dealloc(tp, t.byteLength);
      }
    },
    createCardinalityConstraint: (handle, label, edgeType, direction, min, max) => {
      const l = encoder.encode(label);
      const lp = writeBytes(l);
      const e = encoder.encode(edgeType);
      const ep = writeBytes(e);

      try {
        // direction: 0 = out, 1 = in; max: i64 with -1n = unbounded (null).
        const r = ex.lnk_create_cardinality_constraint(
          handle,
          lp,
          l.byteLength,
          ep,
          e.byteLength,
          direction === 'out' ? 0 : 1,
          min,
          BigInt(max ?? -1),
        );

        if (r === -1) {
          throw new LenkeError(
            `lenke: createCardinalityConstraint(${label}, ${edgeType}, ${direction}): existing data already violates the cardinality constraint`,
            { code: ErrorCode.ConstraintViolation },
          );
        }

        if (r !== 0) {
          throw new LenkeError('lenke: createCardinalityConstraint failed', {
            code: ErrorCode.Ffi,
          });
        }
      } finally {
        ex.lnk_dealloc(lp, l.byteLength);
        ex.lnk_dealloc(ep, e.byteLength);
      }
    },
    createEdgeIndex: (handle, key) => {
      const k = encoder.encode(key);
      const p = writeBytes(k);

      try {
        ex.lnk_create_edge_index(handle, p, k.byteLength);
      } finally {
        ex.lnk_dealloc(p, k.byteLength);
      }
    },
    dropVertexIndex: (handle, key) => {
      const k = encoder.encode(key);
      const p = writeBytes(k);

      try {
        ex.lnk_drop_vertex_index(handle, p, k.byteLength);
      } finally {
        ex.lnk_dealloc(p, k.byteLength);
      }
    },
    dropEdgeIndex: (handle, key) => {
      const k = encoder.encode(key);
      const p = writeBytes(k);

      try {
        ex.lnk_drop_edge_index(handle, p, k.byteLength);
      } finally {
        ex.lnk_dealloc(p, k.byteLength);
      }
    },
    beginTransaction: (handle) => {
      if (ex.lnk_begin_tx(handle) !== 0) {
        throw new LenkeError('lenke: beginTransaction failed', { code: ErrorCode.Ffi });
      }
    },
    commitTransaction: (handle) => {
      const r = ex.lnk_commit_tx(handle);

      // -1 == a deferred constraint check failed (already rolled back); -2 == no
      // open transaction. Mirrors the FFI backend and the TS core.
      if (r === -1) {
        throw new LenkeError('lenke: transaction commit failed a constraint check', {
          code: ErrorCode.ConstraintViolation,
        });
      }

      if (r === -2) {
        throw new LenkeError('lenke: commit called with no open transaction', {
          code: ErrorCode.InvalidGraphOp,
        });
      }

      if (r !== 0) {
        throw new LenkeError('lenke: commitTransaction failed', { code: ErrorCode.Ffi });
      }
    },
    rollbackTransaction: (handle) => {
      if (ex.lnk_rollback_tx(handle) !== 0) {
        throw new LenkeError('lenke: rollbackTransaction failed', { code: ErrorCode.Ffi });
      }
    },
    vertexIndexes: (handle) =>
      JSON.parse(
        decoder.decode(
          takeBuf(
            handle,
            null,
            null,
            (h, _q, _ql, _p, _pl, o) => ex.lnk_vertex_indexes(h, o),
            ex.lnk_free_buf,
            'vertexIndexes',
          ),
        ),
      ) as string[],
    edgeIndexes: (handle) =>
      JSON.parse(
        decoder.decode(
          takeBuf(
            handle,
            null,
            null,
            (h, _q, _ql, _p, _pl, o) => ex.lnk_edge_indexes(h, o),
            ex.lnk_free_buf,
            'edgeIndexes',
          ),
        ),
      ) as string[],

    queryRows: (handle, query, params) =>
      takeBuf(handle, query, params ?? null, ex.lnk_query_rows, ex.lnk_free_buf, 'query'),
    queryArrow: (handle, query, params) =>
      takeBuf(handle, query, params ?? null, ex.lnk_query_arrow, ex.lnk_free_arrow, 'queryArrow'),

    prepare: (text) => {
      const t = encoder.encode(text);
      const p = writeBytes(t);

      try {
        const h = ex.lnk_prepare(p, t.byteLength);

        return h ? h : fail('prepare', ErrorCode.Syntax);
      } finally {
        ex.lnk_dealloc(p, t.byteLength);
      }
    },
    preparedFree: (prepared) => ex.lnk_prepared_free(prepared),
    // takeBuf stages only the params buffer; the graph handle rides the closure
    // (the prepared handle takes takeBuf's `handle` slot).
    preparedQueryRows: (prepared, graph, params) =>
      takeBuf(
        prepared,
        null,
        params ?? null,
        (h, _q, _ql, pr, prlen, o) => ex.lnk_prepared_query_rows(h, graph, pr, prlen, o),
        ex.lnk_free_buf,
        'preparedQuery',
      ),
    preparedQueryArrow: (prepared, graph, params) =>
      takeBuf(
        prepared,
        null,
        params ?? null,
        (h, _q, _ql, pr, prlen, o) => ex.lnk_prepared_query_arrow(h, graph, pr, prlen, o),
        ex.lnk_free_arrow,
        'preparedQueryArrow',
      ),

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
