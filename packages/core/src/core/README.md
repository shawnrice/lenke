# `core/` — the graph domain model

The in-memory labeled-property graph, one concern per file. This is a map for
reading the source; the package-level [`@lenke/core`](../../README.md) README is
the consumer-facing API reference.

- **`Graph.ts`** — the graph itself: the vertex/edge stores, label and property
  indexes, the mutation API, event emission, and versioning / snapshots.
- **`Element.ts`** — the `Element` type (`Vertex | Edge`), the `isElement` type
  guard, and the `Cardinality` enum shared by both element kinds.
- **`Vertex.ts` / `Edge.ts`** — the two element kinds: their labels, properties,
  and (for edges) endpoints, plus the index-maintaining property setters.
- **`VertexProperty.ts`** — a single property value modeled as an addressable
  element (`implements GraphElement`), i.e. a Gremlin-style vertex property.
- **`PropertyIndex.ts`** — the opt-in value index behind
  `getVerticesByProperty(...)` / `...ByPropertyRange(...)`. See
  [`PropertyIndex.md`](./PropertyIndex.md) for the design.
- **`GraphEvents.ts`** — the typed change events the graph emits (added/removed,
  label and property changes); what the store and React bindings subscribe to.
- **`validate.ts`** — well-formedness checks for labels and property keys,
  applied at the mutation boundary so a malformed name can't enter the graph.
- **`index.ts`** — the barrel this directory exposes to the rest of the package.

Querying and traversal are **not** here — they live in the separate
[`@lenke/gql`](../../../gql) and [`@lenke/gremlin`](../../../gremlin) packages.
This directory is only the mutable graph they read and write.
