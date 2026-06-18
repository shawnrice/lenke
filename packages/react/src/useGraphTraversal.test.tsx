import { traversal, V, values } from '@pl-graph/gremlin';
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test, vi } from 'vitest';

import { createTestTinkerGraph } from './fixtures/createTestTinkerGraph.js';
import { GraphProvider } from './GraphProvider.js';
import { useGraphTraversal } from './useGraphTraversal.js';

const createTinkerWrapper = () => {
  const tinkerGraph = createTestTinkerGraph();

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <GraphProvider graph={tinkerGraph}>{children}</GraphProvider>
  );

  return { tinkerGraph, wrapper };
};

const namesOf = (id: string) =>
  useGraphTraversal((g) => g.toArray(traversal(V(id), values('name'))) as string[]);

describe('useGraphTraversal Hooks', () => {
  test('we can query for marko', () => {
    const { wrapper } = createTinkerWrapper();

    const { result } = renderHook(() => namesOf('1'), { wrapper });

    expect(result.current).toEqual(['marko']);
  });

  test('mutating the graph works', async () => {
    vi.useFakeTimers();
    const { tinkerGraph, wrapper } = createTinkerWrapper();

    const { result } = renderHook(() => namesOf('15'), { wrapper });

    expect(result.current).toEqual([]);

    await act(async () => {
      tinkerGraph.addVertex({
        id: '15',
        labels: ['PERSON'],
        properties: {
          name: 'Shawn',
          age: 39,
        },
      });
      // markIsStale queues a microtask that schedules a timer; runAllTimersAsync
      // flushes microtasks between timer ticks so the chain (microtask → timer
      // → notify) actually completes before we assert.
      await vi.runAllTimersAsync();
    });

    expect(result.current).toEqual(['Shawn']);
  });

  test('we can unsubscribe when the component unmounts', () => {
    const { tinkerGraph, wrapper } = createTinkerWrapper();

    const { result, unmount } = renderHook(() => namesOf('1'), { wrapper });

    expect(result.current).toEqual(['marko']);
    // Accessing the private snapshot-listener set for test introspection.
    expect((tinkerGraph as unknown as { listeners: Set<unknown> }).listeners.size).toBe(1);

    unmount();

    expect((tinkerGraph as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });

  test('we can prevent default', () => {
    const { tinkerGraph, wrapper } = createTinkerWrapper();

    const preventNewVertices = vi.fn((event) => {
      if (event.type === '@graph/VertexAdded') {
        return event.preventDefault();
      }
    });

    tinkerGraph.on('@graph/VertexAdded', preventNewVertices);

    const { result } = renderHook(() => namesOf('15'), { wrapper });

    expect(result.current).toEqual([]);

    act(() => {
      tinkerGraph.addVertex({
        id: '15',
        labels: ['PERSON'],
        properties: {
          name: 'Shawn',
          age: 39,
        },
      });
      vi.runOnlyPendingTimers();
    });

    expect(result.current).toEqual([]);
    expect(preventNewVertices).toHaveBeenCalledTimes(1);
  });
});
