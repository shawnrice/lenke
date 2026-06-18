import { Graph } from '@pl-graph/core';
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test, vi } from 'vitest';

import { GraphProvider } from './GraphProvider.js';
import { useGraphSelector } from './useGraphSelector.js';

const wrapperFor =
  (graph: Graph) =>
  ({ children }: { children: React.ReactNode }) => (
    <GraphProvider graph={graph}>{children}</GraphProvider>
  );

const settle = () => act(async () => vi.runAllTimersAsync());

describe('useGraphSelector', () => {
  test('coarse mode re-renders on any mutation', async () => {
    vi.useFakeTimers();
    const graph = new Graph();
    const { result } = renderHook(() => useGraphSelector((g) => g.vertexCount), {
      wrapper: wrapperFor(graph),
    });
    expect(result.current).toBe(0);

    graph.addVertex({ id: 'a', labels: ['Person'], properties: {} });
    await settle();
    expect(result.current).toBe(1);
  });

  test('deps mode: an unrelated mutation neither re-runs the selector nor re-renders', async () => {
    vi.useFakeTimers();
    const graph = new Graph();
    let runs = 0;

    // The selector is scoped to the `Person` token only.
    const { result } = renderHook(
      () =>
        useGraphSelector(
          (g) => {
            runs += 1;

            return g.vertexCount;
          },
          Object.is,
          ['Person'],
        ),
      { wrapper: wrapperFor(graph) },
    );

    const runsAfterMount = runs;
    expect(result.current).toBe(0);

    // Mutate an UNRELATED token (a Widget with a `color` key) — no `Person` epoch
    // change, so the selector must be skipped and the value stay put.
    await act(async () => {
      graph.addVertex({ id: 'w', labels: ['Widget'], properties: { color: 'red' } });
      await vi.runAllTimersAsync();
    });
    expect(runs).toBe(runsAfterMount); // selector NOT re-run
    expect(result.current).toBe(0); // stale-but-intended: not a dependency

    // Now mutate a `Person` — the dependency moves, so it recomputes.
    await act(async () => {
      graph.addVertex({ id: 'p', labels: ['Person'], properties: {} });
      await vi.runAllTimersAsync();
    });
    expect(runs).toBeGreaterThan(runsAfterMount); // re-run
    expect(result.current).toBe(2); // both vertices counted now
  });
});
