import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test } from 'vitest';

import { type ClientSnapshot, type SyncClientLike, useSyncClient } from './SyncClientContext.js';
import { SyncClientProvider } from './SyncClientProvider.js';
import { useClientLiveQuery } from './useClientLiveQuery.js';

// A fake client shaped like `@lenke/sync`'s createSyncClient(...): each
// liveQuery returns a stable snapshot until the test pushes a new one. Exercises
// the connector without a wire/host — the real client satisfies the same shape.
const makeFakeClient = (initial: ClientSnapshot) => {
  const listeners = new Set<() => void>();
  let snap = initial;
  let subscriptions = 0;

  const client: SyncClientLike = {
    liveQuery: () => {
      subscriptions += 1;

      return {
        subscribe: (onChange) => {
          listeners.add(onChange);

          return () => {
            listeners.delete(onChange);
          };
        },
        getSnapshot: () => snap,
      };
    },
  };

  return {
    client,
    get subscriptions() {
      return subscriptions;
    },
    push(next: ClientSnapshot) {
      snap = next;

      for (const l of listeners) {
        l();
      }
    },
  };
};

const skeleton: ClientSnapshot = { rows: [], complete: false };

const wrapperFor =
  (client: SyncClientLike) =>
  ({ children }: { children: React.ReactNode }) => (
    <SyncClientProvider client={client}>{children}</SyncClientProvider>
  );

describe('useClientLiveQuery', () => {
  test('returns the honest skeleton before the first push, then complete rows', () => {
    const fake = makeFakeClient(skeleton);
    const { result } = renderHook(
      () => useClientLiveQuery('MATCH (s:Service) RETURN s.name', { deps: null }),
      { wrapper: wrapperFor(fake.client) },
    );

    expect(result.current.complete).toBe(false);
    expect(result.current.rows).toEqual([]);

    act(() => fake.push({ rows: [{ 's.name': 'api' }], complete: true }));

    expect(result.current.complete).toBe(true);
    expect(result.current.rows).toEqual([{ 's.name': 'api' }]);
  });

  test('surfaces an error snapshot', () => {
    const fake = makeFakeClient(skeleton);
    const { result } = renderHook(() => useClientLiveQuery('BAD', { deps: null }), {
      wrapper: wrapperFor(fake.client),
    });

    act(() => fake.push({ rows: [], complete: false, error: { code: 'E_SYNTAX', message: 'no' } }));

    expect(result.current.error?.code).toBe('E_SYNTAX');
  });

  test('memoizes the subscription on input *content*, not object identity', () => {
    const fake = makeFakeClient(skeleton);
    const { rerender } = renderHook(
      // fresh deps/params objects every render — must not churn a new subscription
      () =>
        useClientLiveQuery('MATCH (s:Service) WHERE s.cluster = $c RETURN s.name', {
          deps: ['Service', 'name', 'cluster'],
          params: { c: 'prod-east' },
        }),
      { wrapper: wrapperFor(fake.client) },
    );

    expect(fake.subscriptions).toBe(1);
    rerender();
    rerender();
    expect(fake.subscriptions).toBe(1);
  });

  test('useSyncClient throws a helpful error outside a SyncClientProvider', () => {
    expect(() => renderHook(() => useSyncClient())).toThrow(/SyncClientProvider/);
  });
});
