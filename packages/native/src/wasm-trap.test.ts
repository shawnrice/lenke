// A wasm TRAP must reach the caller as a coded, explanatory error — not as the bare
// `WebAssembly.RuntimeError: unreachable` the module aborts with.
//
// The engine's anti-runaway guards are counted in ROWS, at thresholds chosen for the
// native heap. wasm's linear memory is much smaller, so a query can exhaust it before
// reaching the row budget, and a failed allocation in wasm aborts the module — Rust
// cannot catch it, so without translation the only thing a user sees is "unreachable".
// That was the CLI's worst failure mode, the CLI being wasm-only.
//
// The translation itself is driven through `trapGuarded` directly. Provoking a REAL
// abort is not something a test should wait for — and, usefully, a small `limits.trail`
// is enough to make the engine's own guard fire first, which is the case that matters
// for users: the last test here proves the guard trips cleanly and catchably ON WASM in
// milliseconds, so most runaway queries never reach the allocator at all. The end-to-end
// abort path was verified by hand through the CLI:
//
//   lenke samples/modern.ndjson -q "g.V().repeat(both()).until(has('name','ripple'))
//                                     .limit(1).path().by('name')"
//   before: unreachable
//   after:  lenke: the wasm engine ran out of memory and aborted — …
//
// Run: bun test packages/native/src/wasm-trap.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { hasErrorCode } from '@lenke/errors';

import { createWasmEngineBackend, trapGuarded, type WasmExports } from './backend-wasm-engine.js';
import { graphFromNdjson } from './graph.js';

const WASM = new URL(
  '../../../crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm',
  import.meta.url,
).pathname;

/** A stub export table: `boom` traps, `fine` returns, `coded` throws a normal error. */
const stub = (boom: () => unknown) =>
  trapGuarded({
    memory: { buffer: new ArrayBuffer(8) } as WebAssembly.Memory,
    lnk_abi_version: () => 17,
    lnk_alloc: boom,
    lnk_free: () => undefined,
  } as unknown as WasmExports) as unknown as {
    memory: WebAssembly.Memory;
    lnk_abi_version: () => number;
    lnk_alloc: () => unknown;
    lnk_free: () => void;
  };

describe('trapGuarded (wasm abort translation)', () => {
  test('a RuntimeError becomes a coded, explanatory LenkeError', () => {
    const ex = stub(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    let thrown: unknown;

    try {
      ex.lnk_alloc();
    } catch (e) {
      thrown = e;
    }

    expect(hasErrorCode(thrown, 'E_RESOURCE_EXHAUSTED')).toBe(true);
    expect((thrown as Error).message).toContain('ran out of memory');
    expect((thrown as Error).message).not.toBe('unreachable');
    expect(thrown).not.toBeInstanceOf(WebAssembly.RuntimeError);
  });

  test('the instance is poisoned: every later call fails the same way', () => {
    const ex = stub(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    expect(() => ex.lnk_alloc()).toThrow(/ran out of memory/);
    // A trapped module's heap is in an unknown state — reading it would be worse
    // than refusing, so an unrelated export must refuse too.
    expect(() => ex.lnk_free()).toThrow(/cannot be used again/);
    expect(() => ex.lnk_abi_version()).toThrow(/cannot be used again/);
  });

  test('a non-trap error keeps its own identity', () => {
    // Only an abort is translated. A coded fault thrown by one of our own guards
    // (a length that escapes wasm memory, say) must pass through unchanged, or the
    // real cause is replaced by a misleading out-of-memory story.
    const original = new TypeError('not a trap');
    const ex = stub(() => {
      throw original;
    });

    expect(() => ex.lnk_alloc()).toThrow(original);
    // …and it does NOT poison the instance.
    expect(ex.lnk_abi_version()).toBe(17);
  });

  test('memory is passed through, not wrapped', () => {
    // `memory.buffer` is re-read on every access (it is replaced when the heap
    // grows); wrapping it as a function would break every view.
    const ex = stub(() => 0);

    expect(ex.memory.buffer.byteLength).toBe(8);
  });
});

// The TinkerPop "modern" shape: `both()` over it fans out fast enough that an
// unbounded `repeat` outgrows wasm memory at the default 1M trail budget. A 3-cycle
// does NOT — each node has degree 2, so the walk crawls — which is the kind of
// fixture detail that quietly turns this into a test of nothing.
const MODERN = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"name":"marko"}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"name":"vadas"}}',
  '{"type":"node","id":"3","labels":["S"],"properties":{"name":"lop"}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"name":"josh"}}',
  '{"type":"node","id":"5","labels":["S"],"properties":{"name":"ripple"}}',
  '{"type":"node","id":"6","labels":["P"],"properties":{"name":"peter"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["K"],"properties":{}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["K"],"properties":{}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["C"],"properties":{}}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["C"],"properties":{}}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["C"],"properties":{}}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["C"],"properties":{}}',
].join('\n');

(existsSync(WASM) ? describe : describe.skip)('the row budget fires before the allocator', () => {
  test('a runaway repeat() trips a catchable E_RESOURCE_EXHAUSTED on wasm', async () => {
    const backend = await createWasmEngineBackend(await Bun.file(WASM).arrayBuffer());
    // The small `trail` is the whole point: at the 1M default this same query
    // outgrows wasm memory first and the module aborts (~seconds, and the instance
    // is gone). At 1000 the engine's own guard wins the race, in milliseconds.
    using g = graphFromNdjson(backend, new TextEncoder().encode(MODERN), {
      limits: { trail: 1000 },
    });

    let thrown: unknown;

    try {
      g.gremlin("g.V().repeat(both()).until(has('name','ripple')).limit(1).path().by('name')");
    } catch (e) {
      thrown = e;
    }

    expect(hasErrorCode(thrown, 'E_RESOURCE_EXHAUSTED')).toBe(true);
    expect((thrown as Error).message).toContain('trail limit');
    // Caught, not aborted — so the instance is still alive afterwards.
    expect(g.gremlin('g.V().count()')).toEqual([6]);
  });
});
