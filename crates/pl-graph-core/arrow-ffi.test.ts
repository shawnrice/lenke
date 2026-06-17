// Proves the Apache Arrow columnar result crosses the FFI boundary and is read
// zero-copy from JS: run a query, view the returned blob's column buffers in
// place (no JSON, no parse), and check the values. This is also the reference
// for the browser consumer — the same descriptor parse + typed-array views, but
// over `wasm.memory.buffer` instead of a bun pointer.
//
// Run: bun test ./crates/pl-graph-core/arrow-ffi.test.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import { describe, expect, test } from 'bun:test';

const lib = dlopen(new URL('./target/release/libpl_graph_core.dylib', import.meta.url).pathname, {
  plg_graph_from_ndjson: {
    args: [FFIType.ptr, FFIType.u64_fast, FFIType.u32],
    returns: FFIType.ptr,
  },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_query_arrow: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.ptr,
  },
  plg_free_arrow: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
});

const T_FLOAT64 = 1;
const T_BOOL = 2;
const T_UTF8 = 3;

// Decode the ARW1 blob into { nrows, columns: [{ tag, name, values }] } by
// viewing the buffers in place — exactly what an apache-arrow `makeData` wrapper
// would do, minus the Vector object.
const decodeArrow = (buf: ArrayBuffer) => {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));

  if (magic !== 'ARW1') {
    throw new Error(`bad magic ${magic}`);
  }

  const nrows = Number(dv.getBigUint64(8, true));
  const ncols = Number(dv.getBigUint64(16, true));
  const u8 = new Uint8Array(buf);
  const validBit = (off: number, i: number) => (u8[off + (i >> 3)] & (1 << (i & 7))) !== 0;
  const columns = [];

  for (let j = 0; j < ncols; j++) {
    const d = 24 + j * 40;
    const tag = dv.getUint32(d, true);
    const nameOff = dv.getUint32(d + 8, true);
    const nameLen = dv.getUint32(d + 12, true);
    const valOff = dv.getUint32(d + 16, true);
    const valLen = dv.getUint32(d + 20, true);
    const b1Off = dv.getUint32(d + 24, true);
    const b2Off = dv.getUint32(d + 32, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, nameOff, nameLen));
    const valid = (i: number) => valLen === 0 || validBit(valOff, i);
    const values: (number | string | boolean | null)[] = [];

    if (tag === T_FLOAT64) {
      const view = new Float64Array(buf, b1Off, nrows); // zero-copy view over the column

      for (let i = 0; i < nrows; i++) {
        values.push(valid(i) ? view[i] : null);
      }
    } else if (tag === T_BOOL) {
      for (let i = 0; i < nrows; i++) {
        values.push(valid(i) ? validBit(b1Off, i) : null);
      }
    } else {
      const offs = new Int32Array(buf, b1Off, nrows + 1);
      const dec = new TextDecoder();

      for (let i = 0; i < nrows; i++) {
        values.push(
          valid(i) ? dec.decode(new Uint8Array(buf, b2Off + offs[i], offs[i + 1] - offs[i])) : null,
        );
      }
    }

    columns.push({ tag, name, values });
  }

  return { nrows, columns };
};

describe('Arrow columnar result over bun:ffi', () => {
  test('query → arrow blob → zero-copy read', () => {
    const nd = [
      '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}',
      '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
    ].join('\n');
    const ndBuf = new TextEncoder().encode(nd);
    const g = lib.symbols.plg_graph_from_ndjson(ptr(ndBuf), ndBuf.byteLength, 0);
    expect(g).not.toBe(0);

    const q = new TextEncoder().encode('MATCH (n:P) RETURN n.name, n.age ORDER BY n.age');
    const outLen = new BigUint64Array(1);
    const resPtr = lib.symbols.plg_query_arrow(g, ptr(q), q.byteLength, ptr(outLen));
    expect(resPtr).not.toBe(0);
    const len = Number(outLen[0]);

    // View the native result buffer in place (zero-copy) and decode.
    // resPtr is non-null here (asserted above); toArrayBuffer needs a Pointer.
    const buf = toArrayBuffer(resPtr!, 0, len);
    const { nrows, columns } = decodeArrow(buf);

    expect(nrows).toBe(2);
    expect(columns[0].name).toBe('n.name');
    expect(columns[0].tag).toBe(T_UTF8);
    expect(columns[1].tag).toBe(T_FLOAT64);
    expect(columns[0].values).toEqual(['vadas', 'marko']); // age-sorted
    expect(columns[1].values).toEqual([27, 29]);

    lib.symbols.plg_free_arrow(resPtr, len);
    lib.symbols.plg_graph_free(g);
  });
});
