# A React UI on the main thread

**Package:** `@lenke/react` · **Engine:** either (TS `@lenke/core` or a native/wasm store).

Use this when the graph lives on the UI thread and you want components to re-render only when the part of the graph they read actually changes. `@lenke/react` ships **two connectors** — one per engine — that share a reactivity model but have distinct hooks, because a TS-graph selector is an arbitrary JS closure while a native "selector" is a query string that crosses the FFI/wasm boundary. If the graph should instead live in a worker, see [frontend-worker](./frontend-worker.md).

Both connectors bottom out in React's `useSyncExternalStore` and gate recomputation on the engine's `epoch` signal, so a component subscribed to `['Person']` doesn't re-run when an unrelated label changes.

## Connector A — the TS `Graph`

Build a `@lenke/core` `Graph`, hand the instance to `GraphProvider`, and read it with hooks.

```tsx
import { Graph } from '@lenke/core';
import { traversal, V, values } from '@lenke/gremlin';
import { GraphProvider, useGraphSelector, useGraphTraversal } from '@lenke/react';

const graph = new Graph();
graph.addVertex({ id: '1', labels: ['Person'], properties: { name: 'marko', age: 29 } });

function PeopleCount() {
  // `deps` scopes invalidation to the 'Person' label — an unrelated mutation
  // won't re-run this selector or re-render the component.
  const count = useGraphSelector((g) => g.getVerticesByLabel('Person').size, Object.is, ['Person']);
  return <p>{count} people</p>;
}

function Name({ id }: { id: string }) {
  const names = useGraphTraversal((g) => g.toArray(traversal(V(id), values('name'))) as string[]);
  return <p>{names[0]}</p>;
}

export function App() {
  return (
    <GraphProvider graph={graph}>
      <PeopleCount />
      <Name id="1" />
    </GraphProvider>
  );
}
```

- `useGraphSelector(selector, isEqual?, deps?)` — run an arbitrary selector over the graph. Declare `deps` (label / edge-type / property-key tokens) and the selector is skipped entirely unless one of those epochs moves. Without `deps` it runs on every change and relies on `isEqual` to preserve the reference.
- `useGraphTraversal(query, isEqual?)` — the Gremlin-shaped twin.
- `useGraphSubscription(listener)` — a side-effect escape hatch (fires once per mutation, returns nothing).

You mutate the `Graph` directly (`graph.addVertex(...)`); its coalesced `notify()` wakes the hooks. `deps` is **not** inferred — under-declaring risks a stale snapshot, so declare the tokens a selector reads.

## Connector B — a native/wasm store

Drive components from the Rust engine's reactive `Store` (from `@lenke/native`, `createStore(graph)`). Here a "query" is GQL text that returns materialized rows across the boundary.

```tsx
import { createStore } from '@lenke/native';
import { StoreProvider, useLiveQuery } from '@lenke/react';

const store = createStore(graph); // graph = a @lenke/native RustGraph (ffi or wasm)

function People() {
  const rows = useLiveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={i}>{String(r['p.name'])}</li>
      ))}
    </ul>
  );
}

export const App = () => (
  <StoreProvider store={store}>
    <People />
  </StoreProvider>
);
```

`useLiveQuery(text, { deps })` is a thin `useSyncExternalStore` wrapper over the store's own epoch-gated live query — the gating lives inside the store (across the boundary), so the hook just subscribes. Because the store connector imports no engine code (`ReactiveStore` is a structural type), a store-only app tree-shakes the TS core/gremlin engines out of the bundle entirely.

## Picking a connector

- **TS `Graph`** — smallest setup, direct object access, no native artifact. Best for small-to-medium graphs on the main thread.
- **native/wasm store** — the columnar engine's throughput, GQL/Gremlin, Arrow. Best for large data or heavy queries you still want on the main thread.

## When to move to a worker

Main-thread is right until the graph is large enough that loading or querying it janks the UI. At that point, move the graph into a worker with [`@lenke/sync`](./frontend-worker.md): the UI thread stays responsive and renders from pushed query results, while fetch/decode/query happen off-thread. Note that `@lenke/react` does not wire `@lenke/sync` for you — the worker pattern uses the sync client with `useSyncExternalStore` directly (the [`examples/service-map`](../../examples/service-map) app shows it).
