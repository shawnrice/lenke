import { Graph } from '@lenke/core';
import { renderHook } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test } from 'vitest';

import { useGraphContext } from './GraphContext.js';
import { GraphProvider } from './GraphProvider.js';
import { useStore } from './StoreContext.js';
import { useGraphSelector } from './useGraphSelector.js';

/*
 * Item 2520: `GraphContext` carries a MODULE-LEVEL default Graph, so the graph hooks used outside a
 * `<GraphProvider>` neither throw nor get their own graph — they all share ONE instance.
 *
 *     const defaultGraph = new Graph();
 *     export const GraphContext = React.createContext<GraphState>({ graph: defaultGraph });
 *
 * Two separate questions, measured separately below, because they have different answers:
 *
 * 1. **Loud vs silent.** `useStore` and `useSyncClient` THROW on a missing provider, and
 *    `StoreContext`'s own comment states the rationale: "a missing provider is a wiring error, so it
 *    fails loudly with an actionable message rather than silently doing nothing." The graph hooks do
 *    exactly the silent thing instead, with no comment justifying the difference. Whether that is
 *    right is a judgement about the surface (a default context value is a legitimate React pattern),
 *    so these rows RECORD it rather than assert a preferred answer.
 *
 * 2. **The default is a SINGLETON, and that is hazardous under either answer.** `defaultGraph` is
 *    created once per module, so every provider-less component in a process shares it — including
 *    its MUTABLE state. A write made through one component is visible to an unrelated other, and
 *    state leaks between tests in the same file. That is true whether or not the hooks are supposed
 *    to work without a provider.
 *
 * These tests pin CURRENT behaviour so the decision in (1) is made deliberately rather than
 * discovered. If the owner chooses to throw, rows marked PINS CURRENT are the ones that change.
 */
describe('GraphContext default (item 2520)', () => {
  test('PINS CURRENT: a graph hook outside a provider does NOT throw', () => {
    expect(() => renderHook(() => useGraphSelector((g) => g.vertexCount))).not.toThrow();
  });

  test('useStore outside its provider DOES throw — the sibling contract', () => {
    expect(() => renderHook(() => useStore())).toThrow(/StoreProvider/);
  });

  /*
   * THE SINGLETON. Both hooks run with NO provider, so both see `defaultGraph`. If the default were
   * per-subscriber (or absent), a vertex added through the first would be invisible to the second.
   */
  test('PINS CURRENT: two provider-less hooks share ONE module-level graph', () => {
    const first = renderHook(() => useGraphContext());
    const second = renderHook(() => useGraphContext());

    expect(first.result.current.graph).toBe(second.result.current.graph);

    const before = second.result.current.graph.vertexCount;

    first.result.current.graph.addVertex({ id: 'leaked-2520', labels: ['L'], properties: {} });

    // The write through `first` is visible through `second`: shared mutable state.
    expect(second.result.current.graph.vertexCount).toBe(before + 1);

    // Leave the shared default as we found it, or this test poisons its neighbours — which is
    // itself the hazard being recorded.
    second.result.current.graph.removeVertex('leaked-2520');
    expect(second.result.current.graph.vertexCount).toBe(before);
  });

  /* THE PRODUCTIVE CONTROL: inside a provider, each tree gets exactly the graph it was given. */
  test('inside a provider each tree sees its OWN graph, not the default', () => {
    const mine = new Graph();

    mine.addVertex({ id: 'a', labels: ['P'], properties: {} });

    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <GraphProvider graph={mine}>{children}</GraphProvider>
    );

    const { result } = renderHook(() => useGraphContext(), { wrapper });

    expect(result.current.graph).toBe(mine);
    expect(result.current.graph.vertexCount).toBe(1);

    const bare = renderHook(() => useGraphContext());

    expect(bare.result.current.graph).not.toBe(mine);
  });
});
