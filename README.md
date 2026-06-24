# pl-graph

> A labeled-property-graph toolkit for JavaScript & TypeScript: an in-memory graph you query with **ISO-GQL** or **Gremlin** — as a pure-TypeScript library, or backed by a **Rust columnar engine** over FFI / WebAssembly.

pl-graph models data as a labeled property graph — vertices and edges that each carry a set of labels and a bag of properties — and lets you query it two ways without standing up an external database. The same data model and query surface come in two interchangeable engines:

- a **pure-TypeScript** implementation that runs anywhere, and
- a **Rust columnar core** for throughput, reachable from JS over `bun:ffi` (Bun) or **WebAssembly** (Node, Deno, browsers).

React bindings expose either engine as a reactive data store.

## How it fits together

- **Graph & queries (pure TS).** [`@pl-graph/core`](packages/core) is the in-memory graph; [`@pl-graph/gql`](packages/gql) and [`@pl-graph/gremlin`](packages/gremlin) query it; [`@pl-graph/serialization`](packages/serialization) reads and writes it.
- **Native engine (Rust).** [`pl-graph-core`](crates/pl-graph-core) is a columnar reimplementation of the graph and both query engines; [`@pl-graph/native`](packages/native) binds it to JS via FFI or wasm. Same query languages, more throughput.
- **React.** [`@pl-graph/react`](packages/react) drives components from either the in-process graph or the native store, re-rendering only when a relevant mutation changes what a component reads.
- **Building blocks.** Small standalone primitives the rest are built on.

## Packages

**Graph & queries**

| Package | Description |
| --- | --- |
| [`@pl-graph/core`](packages/core) | In-memory labeled-property graph with label and opt-in property indexes. |
| [`@pl-graph/gql`](packages/gql) | ISO-GQL (ISO/IEC 39075) query engine over a core graph. |
| [`@pl-graph/gremlin`](packages/gremlin) | Apache TinkerPop-style Gremlin traversal engine over a core graph. |
| [`@pl-graph/serialization`](packages/serialization) | Graph codecs: pg-json, pg-text, ndjson, GraphSON, CSV. |

**Native engine (Rust)**

| Package | Description |
| --- | --- |
| [`pl-graph-core`](crates/pl-graph-core) | Rust columnar graph + GQL/Gremlin engines + Apache Arrow output, behind a C ABI. |
| [`@pl-graph/native`](packages/native) | JS/TS bindings to the Rust core via `bun:ffi` or WebAssembly. |

**React**

| Package | Description |
| --- | --- |
| [`@pl-graph/react`](packages/react) | Hooks and providers exposing a graph (TS or native) as a reactive store. |

**Building blocks**

| Package | Description |
| --- | --- |
| [`@pl-graph/emitter`](packages/emitter) | Typed, cancelable, error-isolated event emitter. |
| [`@pl-graph/errors`](packages/errors) | Stable `E_*` error codes and a shared `PlGraphError` type. |
| [`@pl-graph/fp`](packages/fp) | Lazy, curried iterable combinators composed with `pipe`. |
| [`@pl-graph/list`](packages/list) | Lazy, iterator-backed `List<T>`. |
| [`@pl-graph/tree`](packages/tree) | `TreeNode` and `Trie` data structures. |
| [`@pl-graph/utils`](packages/utils) | Small shared helpers. |
| [`@pl-graph/dev`](packages/dev) | Internal build & lint tooling (bundler, lint rules, shared config). |

Each package has its own README with a full API walkthrough.

## Quick start

### Query a graph with GQL (pure TypeScript)

```ts
import { Graph } from '@pl-graph/core';
import { query } from '@pl-graph/gql';

const g = new Graph();
const marko = g.addVertex({ labels: ['Person'], properties: { name: 'marko', age: 29 } });
const josh = g.addVertex({ labels: ['Person'], properties: { name: 'josh', age: 32 } });
g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: {} });

const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN b.name AS friend`);
// => [{ friend: 'josh' }]
```

The same graph can be traversed with Gremlin instead — see [`@pl-graph/gremlin`](packages/gremlin).

### Use it in React

```tsx
import { Graph } from '@pl-graph/core';
import { GraphProvider, useGraphSelector } from '@pl-graph/react';

const graph = new Graph();
graph.addVertex({ labels: ['Person'], properties: { name: 'marko' } });

function PeopleCount() {
  // `deps` scopes invalidation to the 'Person' label, so unrelated mutations
  // don't re-run the selector or re-render this component.
  const count = useGraphSelector((g) => g.getVerticesByLabel('Person').size, Object.is, ['Person']);
  return <p>{count} people</p>;
}

export function App() {
  return (
    <GraphProvider graph={graph}>
      <PeopleCount />
    </GraphProvider>
  );
}
```

For a native-backed store, drive components with `useLiveQuery` over a `@pl-graph/native` store instead — see [`@pl-graph/react`](packages/react).

### Run the Rust engine via WebAssembly (Node)

The WebAssembly backend needs no native addon, so it runs the Rust engine from plain Node (or Deno, or the browser):

```ts
import { readFile } from 'node:fs/promises';
import { createWasmBackend } from '@pl-graph/native/wasm';
import { graphFromNdjson } from '@pl-graph/native';

const backend = await createWasmBackend(await readFile('pl_graph_core.wasm'));
const g = graphFromNdjson(backend, await readFile('graph.ndjson'));

const rows = g.query`MATCH (p:Person) RETURN p.name AS name`;
console.log(rows); // [{ name: 'marko' }, ...]

g.free(); // the graph is heap-owned by the wasm module; release it explicitly
```

Under Bun, swap `@pl-graph/native/wasm` for `@pl-graph/native/ffi` (`createFfiBackend(libPath)`) to load the native dynamic library directly — the rest of the API is identical.

## Develop

A Bun + nx monorepo (`packages/*`) plus a Rust crate (`crates/pl-graph-core`).

```bash
bun install

bun run check    # typecheck + lint + format check (the pre-commit gate)
bun run build    # build all packages
bun run test     # run all package tests

# Rust core
cargo test --manifest-path crates/pl-graph-core/Cargo.toml
cargo build --release --manifest-path crates/pl-graph-core/Cargo.toml   # cdylib for bun:ffi
```

## License

[Apache-2.0](LICENSE)
