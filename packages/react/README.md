# @pl-graph/react

> React bindings that turn a `@pl-graph` labeled-property graph into a reactive data store for React components.

Provide a graph through context, then read derived values, run Gremlin traversals, or run live GQL queries from your components. Each hook re-renders only when a mutation actually changes the value it reads — change tracking is gated on the graph's O(1) version/epoch signals, so unrelated mutations don't trigger work. Reach for it when component state lives in a property graph and you want the usual selector/subscription ergonomics over it.

## Install

```bash
bun add @pl-graph/react
```

## Usage

```tsx
import { Graph } from '@pl-graph/core';
import { traversal, V, values } from '@pl-graph/gremlin';
import { GraphProvider, useGraphSelector, useGraphTraversal } from '@pl-graph/react';

// Build a graph once, outside the component tree.
const graph = new Graph();
graph.addVertex({ id: '1', labels: ['Person'], properties: { name: 'marko', age: 29 } });
graph.addVertex({ id: '2', labels: ['Person'], properties: { name: 'vadas', age: 27 } });

function PersonCount() {
  // A derived value. `deps` scopes invalidation to the 'Person' label, so a
  // mutation to an unrelated label won't re-run the selector.
  const count = useGraphSelector((g) => [...g.vertices].length, Object.is, ['Person']);

  return <p>{count} people</p>;
}

function Name({ id }: { id: string }) {
  // A Gremlin traversal against the current snapshot, re-run on each change.
  const names = useGraphTraversal((g) => g.toArray(traversal(V(id), values('name'))) as string[]);

  return <p>{names[0]}</p>;
}

export function App() {
  return (
    <GraphProvider graph={graph}>
      <PersonCount />
      <Name id="1" />
    </GraphProvider>
  );
}
```

## Hooks

### In-process `Graph` connector

- `GraphProvider({ graph, children })` — supplies a `@pl-graph/core` `Graph` to the hooks below.
- `useGraphContext(): GraphState` — reads the `{ graph }` from context.
- `useGraphSelector<T>(selector, isEqual?, deps?): T` — subscribes to a value derived from the graph. `selector: (graph: Graph) => T`. The result is stabilized by `isEqual` (default `Object.is`) so an equal value preserves the cached reference and React skips the re-render. Pass `deps` (label / edge-type / property-key names the selector reads) for selective invalidation; omit it for the always-correct coarse mode (recompute on any mutation). `deps` is not inferred — under-declaring it risks a stale value.
- `useGraphTraversal<T>(query, isEqual?): T` — runs a Gremlin query against the current snapshot, re-running on each change. `query: (g: GremlinBound) => T` receives a facade closed over the latest snapshot; call `g.toArray(plan)`, `g.toSet(plan)`, or iterate `g.query(plan)`. Default `isEqual` is elementwise equality for arrays, otherwise `Object.is`.
- `useGraphSubscription(listener: () => void): void` — runs a side-effect callback once per graph mutation. Returns nothing; for render-driving values use `useGraphSelector`.

### wasm/native `Store` connector

These hooks drive React from a `@pl-graph/native` store (`createStore(graph)`) instead of the in-process `Graph`. They import no engine code, so a store-only consumer tree-shakes the TypeScript core/gremlin engines away.

- `StoreProvider({ store, children })` — supplies a `ReactiveStore` (any value exposing `liveQuery`, satisfied structurally by `@pl-graph/native`'s `Store`).
- `useStore(): ReactiveStore` — reads the store from context; throws if there is no `StoreProvider` ancestor.
- `useLiveQuery(text, opts?): Row[]` — subscribes to a live GQL query string, returning the current rows and re-rendering only when the result changes. `opts.deps` scopes invalidation to the named label / edge-type / property-key tokens.

```tsx
const rows = useLiveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
```

## License

Apache-2.0
