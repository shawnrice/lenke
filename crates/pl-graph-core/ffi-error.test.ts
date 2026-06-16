// Proves the out-of-band error channel: a failing plg_* call returns its null
// sentinel, and plg_last_error_json hands back a {code,message,details} report
// carrying the *shared* ErrorCode (E_SYNTAX et al.) — the same vocabulary the TS
// packages throw. Also pins the two safety properties: take-on-read (a failure
// is reported once) and clear-on-entry (a success wipes any stale error), and
// that the binary Arrow path reports errors through this side channel too.
//
// Run: bun test ./crates/pl-graph-core/ffi-error.test.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import { describe, expect, test } from 'bun:test';

const lib = dlopen(new URL('./target/release/libpl_graph_core.dylib', import.meta.url).pathname, {
  plg_graph_from_ndjson: { args: [FFIType.ptr, FFIType.u64_fast, FFIType.u32], returns: FFIType.ptr },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_query_rows: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr], returns: FFIType.ptr },
  plg_query_arrow: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr], returns: FFIType.ptr },
  plg_gremlin_json: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr], returns: FFIType.ptr },
  plg_serialize: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr], returns: FFIType.ptr },
  plg_deserialize: { args: [FFIType.ptr, FFIType.u64_fast, FFIType.ptr, FFIType.u64_fast], returns: FFIType.ptr },
  plg_free_buf: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
  plg_free_arrow: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
  plg_last_error_json: { args: [FFIType.ptr], returns: FFIType.ptr },
});

const enc = new TextEncoder();
const dec = new TextDecoder();

type Report = { code: string; message: string; details: { pos?: number } | null };

// Retrieve + clear the crate's last error (null when none is pending).
const lastError = (): Report | null => {
  const outLen = new BigUint64Array(1);
  const p = lib.symbols.plg_last_error_json(ptr(outLen));
  if (!p) {
    return null;
  }
  const len = Number(outLen[0]);
  const json = dec.decode(new Uint8Array(toArrayBuffer(p, 0, len)).slice());
  lib.symbols.plg_free_buf(p, len);
  return JSON.parse(json) as Report;
};

const queryRows = (g: number, q: string): number => {
  const qb = enc.encode(q);
  const outLen = new BigUint64Array(1);
  return lib.symbols.plg_query_rows(g, ptr(qb), qb.byteLength, ptr(outLen)) as number;
};

const queryArrow = (g: number, q: string): number => {
  const qb = enc.encode(q);
  const outLen = new BigUint64Array(1);
  return lib.symbols.plg_query_arrow(g, ptr(qb), qb.byteLength, ptr(outLen)) as number;
};

describe('FFI error channel', () => {
  const nd = '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}';
  const ndBuf = enc.encode(nd);
  const g = lib.symbols.plg_graph_from_ndjson(ptr(ndBuf), ndBuf.byteLength, 0) as number;

  test('a syntax error returns null and carries the shared E_SYNTAX code + pos', () => {
    const res = queryRows(g, '@@@ not gql');
    expect(res).toBeNull(); // null sentinel

    const err = lastError();
    expect(err?.code).toBe('E_SYNTAX');
    expect(typeof err?.message).toBe('string');
    expect(typeof err?.details?.pos).toBe('number'); // structured offset survived the boundary
  });

  test('take-on-read: the same failure is reported only once', () => {
    expect(queryRows(g, '@@@')).toBeNull();
    expect(lastError()?.code).toBe('E_SYNTAX');
    expect(lastError()).toBeNull(); // slot was taken
  });

  test('clear-on-entry: a successful query wipes any stale error', () => {
    expect(queryRows(g, '@@@')).toBeNull(); // sets an error, left unread

    const qb = enc.encode('MATCH (n:P) RETURN n.name');
    const outLen = new BigUint64Array(1);
    const ok = lib.symbols.plg_query_rows(g, ptr(qb), qb.byteLength, ptr(outLen)) as number;
    expect(ok).not.toBeNull(); // success
    lib.symbols.plg_free_buf(ok, Number(outLen[0])); // free with the real length

    expect(lastError()).toBeNull(); // the success's begin() cleared the stale error
  });

  test('the binary Arrow path reports errors through the same side channel', () => {
    const res = queryArrow(g, '@@@ not gql');
    expect(res).toBeNull(); // null — error never rides the Arrow data pointer
    expect(lastError()?.code).toBe('E_SYNTAX');
  });

  test('a Gremlin parse error carries E_SYNTAX', () => {
    const q = enc.encode('g.V(.broken(');
    const outLen = new BigUint64Array(1);
    const res = lib.symbols.plg_gremlin_json(g, ptr(q), q.byteLength, ptr(outLen));
    expect(res).toBeNull();
    expect(lastError()?.code).toBe('E_SYNTAX');
  });

  test('serialize with an unknown format name carries E_UNKNOWN_FORMAT', () => {
    const fmt = enc.encode('no-such-format');
    const outLen = new BigUint64Array(1);
    const res = lib.symbols.plg_serialize(g, ptr(fmt), fmt.byteLength, ptr(outLen));
    expect(res).toBeNull();
    expect(lastError()?.code).toBe('E_UNKNOWN_FORMAT');
  });

  test('deserialize splits unknown-format from a known-format parse failure', () => {
    // Unknown format name → UnknownFormat.
    const bad = enc.encode('whatever');
    const fmtBad = enc.encode('no-such-format');
    expect(lib.symbols.plg_deserialize(ptr(bad), bad.byteLength, ptr(fmtBad), fmtBad.byteLength)).toBeNull();
    expect(lastError()?.code).toBe('E_UNKNOWN_FORMAT');

    // Known format (pg-json) but the payload isn't valid for it → InvalidShape.
    const garbage = enc.encode('this is not pg-json');
    const fmtOk = enc.encode('pg-json');
    expect(lib.symbols.plg_deserialize(ptr(garbage), garbage.byteLength, ptr(fmtOk), fmtOk.byteLength)).toBeNull();
    expect(lastError()?.code).toBe('E_INVALID_SHAPE');
  });
});
