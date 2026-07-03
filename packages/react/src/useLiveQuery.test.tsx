import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test } from 'vitest';

import { type ReactiveStore, type Row, useStore } from './StoreContext.js';
import { StoreProvider } from './StoreProvider.js';
import { useLiveQuery } from './useLiveQuery.js';

// A fake store shaped like `@lenke/native`'s `createStore(graph)` result:
// each liveQuery caches its rows and only re-materializes when the test-driven
// version moves; `mutate` advances the version and notifies subscribers. This
// lets the connector be tested without a built wasm artifact — the real native
// `Store` satisfies the same `ReactiveStore` shape.
const makeFakeStore = (initialRows: Row[]) => {
  const listeners = new Set<() => void>();
  let rows = initialRows;
  let version = 0;
  let materializations = 0;

  const store: ReactiveStore = {
    liveQuery: () => {
      let seenVersion = -1;
      let cached: Row[] = [];

      return {
        subscribe: (onChange) => {
          listeners.add(onChange);

          return () => {
            listeners.delete(onChange);
          };
        },
        getSnapshot: () => {
          if (version === seenVersion) {
            return cached; // stable reference until the version moves
          }

          seenVersion = version;
          materializations += 1;
          cached = rows;

          return cached;
        },
      };
    },
  };

  return {
    store,
    get materializations() {
      return materializations;
    },
    mutate(next: Row[]) {
      rows = next;
      version += 1;

      for (const l of listeners) {
        l();
      }
    },
  };
};

const wrapperFor =
  (store: ReactiveStore) =>
  ({ children }: { children: React.ReactNode }) => (
    <StoreProvider store={store}>{children}</StoreProvider>
  );

describe('useLiveQuery', () => {
  test('returns the current rows', () => {
    const fake = makeFakeStore([{ 'p.name': 'ann' }]);
    const { result } = renderHook(() => useLiveQuery('MATCH (p:Person) RETURN p.name'), {
      wrapper: wrapperFor(fake.store),
    });

    expect(result.current).toEqual([{ 'p.name': 'ann' }]);
  });

  test('re-renders with new rows after a mutation', () => {
    const fake = makeFakeStore([{ 'p.name': 'ann' }]);
    const { result } = renderHook(() => useLiveQuery('MATCH (p:Person) RETURN p.name'), {
      wrapper: wrapperFor(fake.store),
    });

    act(() => fake.mutate([{ 'p.name': 'ann' }, { 'p.name': 'bob' }]));

    expect(result.current).toEqual([{ 'p.name': 'ann' }, { 'p.name': 'bob' }]);
  });

  test('the snapshot reference is stable when nothing changed', () => {
    const fake = makeFakeStore([{ 'p.name': 'ann' }]);
    const { result, rerender } = renderHook(() => useLiveQuery('MATCH (p:Person) RETURN p.name'), {
      wrapper: wrapperFor(fake.store),
    });

    const first = result.current;
    rerender();

    expect(result.current).toBe(first); // same reference → React short-circuits
  });

  test('memoizes the live query on deps *content*, not array identity', () => {
    const fake = makeFakeStore([{ x: 1 }]);
    const { rerender } = renderHook(
      // a fresh `deps` array every render — must not churn a new live query
      () => useLiveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] }),
      { wrapper: wrapperFor(fake.store) },
    );

    expect(fake.materializations).toBe(1); // materialized once on mount
    rerender();
    rerender();
    expect(fake.materializations).toBe(1); // not re-created → cache preserved
  });

  test('useStore throws a helpful error outside a StoreProvider', () => {
    expect(() => renderHook(() => useStore())).toThrow(/StoreProvider/);
  });
});
