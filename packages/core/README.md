# @lenke/core

> A mutable, in-memory labeled-property graph for JavaScript and TypeScript.

`Graph` stores vertices and edges that each carry a set of labels and a bag of properties, with built-in indexes by label and opt-in secondary indexes over property values. Reach for it when you need an in-process graph you can mutate, query, observe, and feed to a query engine — without standing up an external database.

## Install

```bash
bun add @lenke/core
```

## Usage

```ts
import { Graph } from '@lenke/core';

const graph = new Graph();

// Add vertices: each carries labels and a property bag.
const alice = graph.addVertex({ labels: ['Person'], properties: { name: 'Alice', age: 34 } });
const bob = graph.addVertex({ labels: ['Person'], properties: { name: 'Bob', age: 28 } });

// Connect them with a directed, labeled edge.
graph.addEdge({ from: alice, to: bob, labels: ['KNOWS'], properties: { since: 2020 } });

// Query by label.
graph.getVerticesByLabel('Person'); // Set { alice, bob }

// Declare a secondary index, then query by property value or range.
graph.createVertexIndex('age');
graph.getVerticesByProperty('age', 34); // Set { alice }
graph.getVerticesByPropertyRange('age', { gte: 30 }); // Set { alice }

// Mutate properties through the element's methods (never write to `.properties`).
alice.setProperty('age', 35);
alice.getProperty('age'); // 35 (typed `unknown`)
alice.getProperty<number>('age'); // 35 (typed `number` — no cast)

// Traverse edges from a vertex by edge label.
alice.edgesFromByLabel('KNOWS'); // Set { the alice->bob edge }
```

## Vertices and edges

`Vertex` and `Edge` are concrete (non-generic) classes. Properties are typed as `Record<string, unknown>`; to read one without a cast, pass a type to `getProperty` — `vertex.getProperty<string>('name')` returns `string` (an opt-in, caller-side assertion — nothing is validated; use `<string | undefined>` if the key might be absent). Or cast the whole bag at the boundary (`vertex.properties as Person`).

The `.properties` getter returns the graph's live, frozen property bag — a top-level write throws. Mutate through the element instead:

```ts
vertex.setProperty(key, value);
vertex.setProperties({ a: 1, b: 2 });
vertex.removeProperty(key);
vertex.removeProperties(['a', 'b']);
vertex.addLabel(label);
vertex.removeLabel(label);
```

`Edge` exposes the same property and label methods, plus `from` / `to` vertex accessors. Every edge is directed and must carry at least one label; `addEdge` throws if an endpoint isn't in the graph or no label is given. Removing a vertex cascades to remove its incident edges.

## Property indexes

Secondary indexes are opt-in per key — declare a key with `createVertexIndex(key)` / `createEdgeIndex(key)` (backfilled from existing elements and kept current on every mutation), then query it:

- `getVerticesByProperty(key, value)` / `getEdgesByProperty(key, value)` — equality, an O(1) bucket lookup.
- `getVerticesByPropertyRange(key, bound)` / `getEdgesByPropertyRange(key, bound)` — range, where `bound` is a `RangeBound` (`{ gt?, gte?, lt?, lte? }`). Indexable values are `string | number | boolean | null`; ranges are clamped to the bound's value type.

Drop an index with `dropVertexIndex(key)` / `dropEdgeIndex(key)`, and list active indexes with `vertexIndexes()` / `edgeIndexes()`. Querying an unindexed key returns an empty set.

## Events and reactivity

Mutations emit typed graph events you can listen to with `graph.on(type, listener)` / `graph.once(...)`; **`graph.on` returns an unsubscribe function** (call it to detach). Events are **observation-only** — a notification that a write happened, for side effects and reactivity (there is no veto; enforce rules with constraints instead, below). Inside a `graph.transaction(...)` events are buffered and dispatched as one batch on commit (and discarded on rollback), so an emitted event always corresponds to a committed write.

**Read the payload off `event.value`, not off `event`.** Each listener receives an event whose `.value` is the payload object — a common trip-up is reaching for `event.previous` (which is `undefined`); it's `event.value.previous`:

```ts
const off = graph.on('@graph/VertexPropertyChanged', (event) => {
  const { vertex, key, value, previous } = event.value;
  //     ^element  ^key   ^new   ^old (undefined if the key was absent)
  console.log(`${vertex.id}.${key}: ${previous} → ${value}`);
});
off(); // detach
```

The singular property-change events (`VertexPropertyChanged` / `EdgePropertyChanged`) carry `previous` alongside `value` — enough to build an undo/redo stack purely from events. `graph.subscribe(callback)` registers a coalesced change callback (one deferred notification per tick) and returns an unsubscribe function. `graph.version` is a monotonic mutation counter, and `graph.epoch(name)` is a per-token (label / edge-type / property-key) change counter — both suited to `useSyncExternalStore`-style snapshots. Use `enableEvents()` / `disableEvents()` to toggle emission.

`graph.clone()` produces an independent deep copy; `graph.snapshot()` returns the live graph for reads; `graph.truncate()` empties the graph while keeping declared indexes.

## License

Apache-2.0
