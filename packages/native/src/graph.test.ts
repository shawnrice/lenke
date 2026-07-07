import { describe, expect, test } from 'bun:test';

import type { Backend, GraphHandle } from './backend.js';
import { attachGraph } from './graph.js';
import { createStore } from './store.js';

// A do-nothing backend that only records graphFree calls — enough to exercise
// the disposal wiring in attachGraph without a built native/wasm artifact.
const countingBackend = (): { backend: Backend; freed: GraphHandle[] } => {
  const freed: GraphHandle[] = [];
  const backend: Backend = {
    abiVersion: 9,
    graphFromNdjson: () => 1,
    graphFree: (handle) => {
      freed.push(handle);
    },
    vertexCount: () => 0,
    edgeCount: () => 0,
    version: () => 0,
    epoch: () => 0,
    queryRows: () => new Uint8Array(),
    queryArrow: () => new Uint8Array(),
    gremlinJson: () => new Uint8Array(),
    encodeNdjson: () => new Uint8Array(),
    serialize: () => new Uint8Array(),
    deserialize: () => 1,
  };

  return { backend, freed };
};

describe('RustGraph disposal', () => {
  test('free() releases the handle once', () => {
    const { backend, freed } = countingBackend();
    const g = attachGraph(backend, 7);

    g.free();

    expect(freed).toEqual([7]);
  });

  test('free() is idempotent — a second call does not double-free', () => {
    const { backend, freed } = countingBackend();
    const g = attachGraph(backend, 7);

    g.free();
    g.free();

    expect(freed).toEqual([7]);
  });

  test('[Symbol.dispose] is the same freed-once path as free()', () => {
    const { backend, freed } = countingBackend();
    const g = attachGraph(backend, 3);

    g[Symbol.dispose]();
    g.free(); // already disposed → no-op

    expect(freed).toEqual([3]);
  });

  test('`using` frees at scope exit', () => {
    const { backend, freed } = countingBackend();

    {
      using g = attachGraph(backend, 5);
      expect(g.vertexCount).toBe(0); // touch it so nothing tree-shakes the binding
      expect(freed).toEqual([]);
    }

    expect(freed).toEqual([5]);
  });

  test('disposing a store frees its underlying graph', () => {
    const { backend, freed } = countingBackend();
    const store = createStore(attachGraph(backend, 9));

    store[Symbol.dispose]();

    expect(freed).toEqual([9]);
  });
});
