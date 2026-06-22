import { Graph } from '@pl-graph/core';
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test, vi } from 'vitest';

import { GraphProvider } from './GraphProvider.js';
import { useGraphSubscription } from './useGraphSubscription.js';

const wrapperFor =
  (graph: Graph) =>
  ({ children }: { children: React.ReactNode }) => (
    <GraphProvider graph={graph}>{children}</GraphProvider>
  );

// Subscriber notification is debounced behind a timer; flush it.
const settle = (): Promise<void> => act(async () => void (await vi.runAllTimersAsync()));

describe('useGraphSubscription', () => {
  test('fires the listener once per mutation', async () => {
    vi.useFakeTimers();
    const graph = new Graph();
    let fired = 0;

    renderHook(
      () =>
        useGraphSubscription(() => {
          fired += 1;
        }),
      { wrapper: wrapperFor(graph) },
    );

    graph.addVertex({ labels: ['Person'], properties: {} });
    await settle();

    expect(fired).toBe(1);
  });

  test('unsubscribes on unmount (no fire after teardown)', async () => {
    vi.useFakeTimers();
    const graph = new Graph();
    let fired = 0;

    const { unmount } = renderHook(
      () =>
        useGraphSubscription(() => {
          fired += 1;
        }),
      { wrapper: wrapperFor(graph) },
    );

    unmount();
    graph.addVertex({ labels: ['Person'], properties: {} });
    await settle();

    expect(fired).toBe(0); // the effect cleanup ran graph's unsubscribe
  });

  // NOTE: a *throwing* subscriber being isolated (one bad listener can't break
  // the others) is a guarantee of `Graph.notify` itself, verified in
  // `@pl-graph/core`'s `Graph.reactive.test.ts`. It isn't re-tested here because
  // these hooks forward listeners verbatim, and the worktree resolves
  // `@pl-graph/core` to its built (cross-checkout) copy rather than this source.
});
