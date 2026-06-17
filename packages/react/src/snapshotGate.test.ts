import { describe, expect, test } from 'vitest';

import { type CacheCell, nextSnapshot } from './snapshotGate.js';

// A minimal stand-in for the graph's reactive surface.
const fakeGraph = (init: { version?: number; epochs?: Record<string, number> } = {}) => {
  let version = init.version ?? 0;
  const epochs = new Map(Object.entries(init.epochs ?? {}));

  return {
    get version() {
      return version;
    },
    epoch: (name: string) => epochs.get(name) ?? 0,
    bump(tokens: string[] = []) {
      version += 1;

      for (const t of tokens) {
        epochs.set(t, (epochs.get(t) ?? 0) + 1);
      }
    },
  };
};

// Thread the cache like the hook's useRef does.
const gate = <T>(
  graph: ReturnType<typeof fakeGraph>,
  selector: (g: ReturnType<typeof fakeGraph>) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  deps?: readonly string[],
) => {
  let cell: CacheCell<T> | null = null;

  return () => {
    cell = nextSnapshot(cell, graph, selector, isEqual, deps);

    return cell.value;
  };
};

describe('snapshotGate.nextSnapshot', () => {
  test('coarse mode: runs the selector each call but stabilizes the ref via isEqual', () => {
    const graph = fakeGraph();
    let value = 0;
    const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const get = gate(graph, () => [value], eq);

    const a = get();
    const b = get();
    expect(a).toBe(b); // recomputed but equal → same reference (React won't re-render)
    expect(a).toEqual([0]);

    value = 1;
    const c = get();
    expect(c).not.toBe(a); // content changed → new reference
    expect(c).toEqual([1]);
  });

  test('deps mode: an unrelated token bump does NOT re-run the selector', () => {
    const graph = fakeGraph();
    let runs = 0;
    const get = gate(
      graph,
      (g) => {
        runs += 1;

        return g.epoch('age');
      },
      Object.is,
      ['age'],
    );

    get();
    expect(runs).toBe(1);

    graph.bump(['name']); // unrelated key — version moves, but 'age' epoch doesn't
    get();
    expect(runs).toBe(1); // selector skipped: selective invalidation

    graph.bump(['age']); // now a dependency moved
    get();
    expect(runs).toBe(2);
  });

  test('preserves the old reference when a bump produces an equal value', () => {
    const graph = fakeGraph();
    const get = gate(
      graph,
      () => ({ count: 1 }), // always structurally equal
      (a, b) => a.count === b.count,
    );

    const a = get();
    graph.bump();
    const b = get();
    expect(b).toBe(a); // value equal despite the version bump → same reference
  });
});
