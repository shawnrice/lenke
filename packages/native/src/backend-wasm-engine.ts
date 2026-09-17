/**
 * The WebAssembly backend over the STANDALONE engine's 16-symbol C ABI
 * (`lenke_engine.wasm`, built with `bun run build:wasm`). The wasm twin of
 * `backend-ffi-engine.ts`: everything is 32-bit linear-memory offsets, u64 returns
 * arrive as BigInt, and inputs are copied into the module's memory via `lnk_alloc`.
 * The marshalled ABI is handed to {@link buildEngineBackend}.
 */
import { ErrorCode, LenkeError } from '@lenke/errors';

import { assertAbi } from './abi.js';
import { buildEngineBackend, encodeInput, type EngineAbi } from './backend-engine.js';
import type { Backend } from './backend.js';
import { type ErrorReport, makeFail, parseErrorReport } from './marshal.js';

export type WasmSource =
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | Promise<Response>;

/* eslint-disable max-params -- the wasm `lnk_*` declarations mirror the C ABI arity 1:1; lnk_query legitimately takes 8 offset args and can't drop params */
export type WasmExports = {
  memory: WebAssembly.Memory;
  lnk_abi_version: () => number;
  lnk_alloc: (len: number) => number;
  lnk_dealloc: (ptr: number, len: number) => void;
  lnk_free: (ptr: number, len: number) => void;
  lnk_last_error_json: (outLen: number) => number;
  lnk_open: (ptr: number, len: number, format: number, threads: number) => number;
  lnk_close: (h: number) => void;
  lnk_clone: (h: number) => number;
  // `value` is u64 → an i64 wasm param, so it crosses the boundary as a BigInt.
  lnk_config: (h: number, id: number, value: bigint) => number;
  // returns u64 → BigInt.
  lnk_stat: (h: number, which: number) => bigint;
  lnk_query: (
    h: number,
    lang: number,
    qp: number,
    ql: number,
    pp: number,
    pl: number,
    format: number,
    outLen: number,
  ) => number;
  lnk_tx: (h: number, action: number) => number;
  lnk_schema_apply: (h: number, jp: number, jl: number) => number;
  lnk_schema_dump: (h: number, outLen: number) => number;
  lnk_encode: (h: number, format: number, outLen: number) => number;
  lnk_command: (
    h: number,
    np: number,
    nl: number,
    ip: number,
    il: number,
    outLen: number,
  ) => number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const instantiate = async (source: WasmSource): Promise<WebAssembly.Instance> => {
  if (source instanceof Response || source instanceof Promise) {
    const { instance } = await WebAssembly.instantiateStreaming(source, {});

    return instance;
  }

  const result = (await WebAssembly.instantiate(source as ArrayBuffer, {})) as unknown as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };

  return 'instance' in result ? result.instance : result;
};

const wasmAborted = (): LenkeError =>
  new LenkeError(
    'lenke: the wasm engine ran out of memory and aborted — the query needed more than ' +
      'WebAssembly linear memory could give it. This instance cannot be used again; ' +
      'create a fresh graph. To let the query through, bound it (a tighter `LIMIT`, a ' +
      'dedup of the frontier, a shorter `repeat`), or run it on the native backend, ' +
      'whose heap is not capped the same way.',
    { code: ErrorCode.ResourceExhausted },
  );

/**
 * Wrap every export so a wasm TRAP surfaces as a coded error instead of as
 * `WebAssembly.RuntimeError: unreachable`.
 *
 * The engine's anti-runaway guards (the trail budget, the intermediate-frontier
 * ceiling) stop a runaway query with a clear `E_RESOURCE_EXHAUSTED` — but they are
 * counted in ROWS, and wasm's linear memory is far smaller than the native heap
 * those thresholds were chosen for. A query whose working set fits on native can
 * therefore exhaust wasm memory BEFORE reaching the row budget, and a failed
 * allocation in wasm aborts the module: Rust cannot catch it, so the only thing
 * reaching the caller is a bare `unreachable`. That reads as a crash, tells you
 * nothing about which query did it, and gives no hint about what to change. The
 * budgets stay identical to native on purpose — lowering them here would make the
 * same query succeed on one backend and fail on the other, which is exactly what
 * `backend-parity-fuzz` exists to catch.
 *
 * Exported for its own test: forcing a REAL out-of-memory abort takes minutes of
 * fruitless graph walking, which is no way to guard a wrapper this small.
 *
 * A trapped module is also UNUSABLE afterwards: the abort happened wherever the
 * allocator gave up, so the heap and any live graph handles are in an unknown
 * state. Once one call traps, every later call fails the same way rather than
 * reading whatever is left in memory.
 */
export const trapGuarded = (ex: WasmExports): WasmExports => {
  let trapped = false;

  const guard = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
    return (...args: A): R => {
      if (trapped) {
        throw wasmAborted();
      }

      try {
        return fn(...args);
      } catch (e) {
        // A trap is a RuntimeError; anything else is a real JS-side fault and must
        // keep its own identity (a coded LenkeError from a guard above, say).
        if (e instanceof WebAssembly.RuntimeError) {
          trapped = true;

          throw wasmAborted();
        }

        throw e;
      }
    };
  };

  const out = { memory: ex.memory } as WasmExports;

  for (const [name, value] of Object.entries(ex)) {
    if (typeof value === 'function') {
      (out as unknown as Record<string, unknown>)[name] = guard(
        value as (...args: unknown[]) => unknown,
      );
    }
  }

  return out;
};

/** Instantiate the engine wasm backend from `lenke_engine.wasm`. */
export const createWasmEngineBackend = async (source: WasmSource): Promise<Backend> => {
  const instance = await instantiate(source);
  const ex = trapGuarded(instance.exports as unknown as WasmExports);

  const abiVersion = ex.lnk_abi_version();
  assertAbi(abiVersion);

  // memory.buffer is replaced when the heap grows, so views must be fresh on every
  // access — never cache a Uint8Array across a call that can allocate.
  const u8 = (): Uint8Array => new Uint8Array(ex.memory.buffer);
  const dv = (): DataView => new DataView(ex.memory.buffer);

  const writeBytes = (bytes: Uint8Array): number => {
    const p = ex.lnk_alloc(bytes.byteLength);
    u8().set(bytes, p);

    return p;
  };

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

  const readLastError = (): ErrorReport | null => {
    const outLenPtr = ex.lnk_alloc(4);

    try {
      const errPtr = ex.lnk_last_error_json(outLenPtr);

      if (!errPtr) {
        return null;
      }

      const len = dv().getUint32(outLenPtr, true);

      // Free the crate error buffer in a finally: a throwing `readBytes` (a corrupt
      // ptr/len escaping wasm memory) must not leak it. Mirrors the FFI twin.
      try {
        return parseErrorReport(decoder.decode(readBytes(errPtr, len, 'last-error')));
      } finally {
        ex.lnk_free(errPtr, len);
      }
    } finally {
      ex.lnk_dealloc(outLenPtr, 4);
    }
  };

  const fail = makeFail(readLastError);

  // A result-returning call whose only marshalling is the 4-byte out_len slot
  // (the arg-free reads: schema dump, encode).
  const resultCall = (call: (outLenPtr: number) => number, op: string): Uint8Array => {
    const outLenPtr = ex.lnk_alloc(4);

    try {
      const resPtr = call(outLenPtr);

      if (!resPtr) {
        return fail(op, ErrorCode.Ffi);
      }

      const len = dv().getUint32(outLenPtr, true);

      // Free the crate result buffer in a finally: if readBytes throws (a corrupt
      // length escaping wasm memory), the buffer would otherwise leak (the FFI twin
      // frees in a finally too).
      try {
        return readBytes(resPtr, len, op);
      } finally {
        ex.lnk_free(resPtr, len);
      }
    } finally {
      ex.lnk_dealloc(outLenPtr, 4);
    }
  };

  const abi: EngineAbi = {
    abiVersion,
    open: (bytes, format, threads = 1) => {
      const p = bytes ? writeBytes(bytes) : 0;

      try {
        // wasm has no threads; `threads` is passed for ABI shape and ignored engine-side.
        const h = ex.lnk_open(p, bytes ? bytes.byteLength : 0, format, threads);

        if (!h) {
          return fail('open', ErrorCode.InvalidJson);
        }

        return h;
      } finally {
        if (p) {
          ex.lnk_dealloc(p, bytes!.byteLength);
        }
      }
    },
    close: (handle) => ex.lnk_close(handle),
    clone: (handle) => {
      const c = ex.lnk_clone(handle);

      if (!c) {
        return fail('clone', ErrorCode.InvalidGraphOp);
      }

      return c;
    },
    config: (handle, id, value) => ex.lnk_config(handle, id, BigInt(value)),
    stat: (handle, which) => Number(ex.lnk_stat(handle, which)),
    query: (handle, lang, query, params, format) => {
      const q = encoder.encode(query);
      const p = params === null ? null : encoder.encode(params);
      const qp = writeBytes(q);
      const pp = p ? writeBytes(p) : 0;
      const outLenPtr = ex.lnk_alloc(4);

      try {
        const resPtr = ex.lnk_query(
          handle,
          lang,
          qp,
          q.byteLength,
          pp,
          p ? p.byteLength : 0,
          format,
          outLenPtr,
        );

        if (!resPtr) {
          return fail('query', ErrorCode.Ffi);
        }

        const len = dv().getUint32(outLenPtr, true);

        // Free the crate buffer in a finally — a throwing readBytes must not leak it.
        try {
          return readBytes(resPtr, len, 'query');
        } finally {
          ex.lnk_free(resPtr, len);
        }
      } finally {
        ex.lnk_dealloc(qp, q.byteLength);

        if (pp) {
          ex.lnk_dealloc(pp, p!.byteLength);
        }

        ex.lnk_dealloc(outLenPtr, 4);
      }
    },
    tx: (handle, action) => {
      if (ex.lnk_tx(handle, action) !== 0) {
        fail('tx', ErrorCode.Ffi);
      }
    },
    schemaApply: (handle, json) => {
      const j = encoder.encode(json);
      const jp = writeBytes(j);

      try {
        if (ex.lnk_schema_apply(handle, jp, j.byteLength) !== 0) {
          fail('schemaApply', ErrorCode.Ffi);
        }
      } finally {
        ex.lnk_dealloc(jp, j.byteLength);
      }
    },
    schemaDump: (handle) =>
      resultCall((outLenPtr) => ex.lnk_schema_dump(handle, outLenPtr), 'schemaDump'),
    encode: (handle, format) =>
      resultCall((outLenPtr) => ex.lnk_encode(handle, format, outLenPtr), 'encode'),
    command: (handle, name, input) => {
      const n = encoder.encode(name);
      const inBytes = encodeInput(input);
      const np = writeBytes(n);
      const ip = inBytes ? writeBytes(inBytes) : 0;
      const outLenPtr = ex.lnk_alloc(4);

      try {
        const resPtr = ex.lnk_command(
          handle,
          np,
          n.byteLength,
          ip,
          inBytes ? inBytes.byteLength : 0,
          outLenPtr,
        );

        if (!resPtr) {
          return fail('command', ErrorCode.Ffi);
        }

        const len = dv().getUint32(outLenPtr, true);

        // Free the crate buffer in a finally — a throwing readBytes must not leak it.
        try {
          return readBytes(resPtr, len, 'command');
        } finally {
          ex.lnk_free(resPtr, len);
        }
      } finally {
        ex.lnk_dealloc(np, n.byteLength);

        if (ip) {
          ex.lnk_dealloc(ip, inBytes!.byteLength);
        }

        ex.lnk_dealloc(outLenPtr, 4);
      }
    },
  };

  return buildEngineBackend(abi);
};
