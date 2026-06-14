// Proves the native crate is callable from Bun over FFI (the bun:ffi half of
// "shared crate, both bindings"). Run: bun test crates/pl-graph-core/ffi-smoke.test.ts
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { describe, expect, test } from 'bun:test';

const lib = dlopen(
  new URL('./target/release/libpl_graph_core.dylib', import.meta.url).pathname,
  {
    plg_abi_version: { args: [], returns: FFIType.u32 },
    plg_build_csr: {
      args: [
        FFIType.ptr, // src
        FFIType.ptr, // dst
        FFIType.u64_fast, // e
        FFIType.u64_fast, // n
        FFIType.ptr, // out_offsets
        FFIType.ptr, // out_neighbors
        FFIType.u32, // simd
      ],
      returns: FFIType.i32,
    },
  },
);

describe('pl-graph-core over bun:ffi', () => {
  test('abi version probe', () => {
    expect(lib.symbols.plg_abi_version()).toBe(5);
  });

  test('build_csr groups edges by source, identical to the Rust unit test', () => {
    // 0->1, 0->2, 2->0, 1->2  over n=3
    const src = new Uint32Array([0, 0, 2, 1]);
    const dst = new Uint32Array([1, 2, 0, 2]);
    const n = 3;
    const e = src.length;
    const offsets = new Uint32Array(n + 1);
    const neighbors = new Uint32Array(e);

    const rc = lib.symbols.plg_build_csr(
      ptr(src),
      ptr(dst),
      BigInt(e),
      BigInt(n),
      ptr(offsets),
      ptr(neighbors),
      1, // NEON
    );

    expect(rc).toBe(0);
    expect([...offsets]).toEqual([0, 2, 3, 4]);
    expect([...neighbors.slice(0, 2)]).toEqual([1, 2]); // v0 -> {1,2}
    expect([...neighbors.slice(2, 3)]).toEqual([2]); // v1 -> {2}
    expect([...neighbors.slice(3, 4)]).toEqual([0]); // v2 -> {0}
  });
});
