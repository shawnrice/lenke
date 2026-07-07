# lenke

> A labeled-property-graph toolkit for JavaScript & TypeScript: an in-memory graph you query with **ISO-GQL** or **Gremlin** — as a pure-TypeScript library, or backed by a **Rust columnar engine** over FFI / WebAssembly.

lenke models data as a labeled property graph — vertices and edges that each carry a set of labels and a bag of properties — and lets you query it two ways without standing up an external database. The same data model and query surface come in two interchangeable engines:

- a **pure-TypeScript** implementation that runs anywhere, and
- a **Rust columnar core** for throughput, reachable from JS over `bun:ffi` (Bun) or **WebAssembly** (Node, Deno, browsers).

React bindings expose either engine as a reactive data store.

## How it fits together

- **Graph & queries (pure TS).** [`@lenke/core`](packages/core) is the in-memory graph; [`@lenke/gql`](packages/gql) and [`@lenke/gremlin`](packages/gremlin) query it; [`@lenke/serialization`](packages/serialization) reads and writes it.
- **Native engine (Rust).** [`lenke-core`](crates/lenke-core) is a columnar reimplementation of the graph and both query engines; [`@lenke/native`](packages/native) binds it to JS via FFI or wasm. Same query languages, more throughput.
- **React.** [`@lenke/react`](packages/react) drives components from either the in-process graph or the native store, re-rendering only when a relevant mutation changes what a component reads.
- **Building blocks.** Small standalone primitives the rest are built on.

## Packages

**Graph & queries**

| Package                                          | Description                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [`@lenke/core`](packages/core)                   | In-memory labeled-property graph with label and opt-in property indexes. |
| [`@lenke/gql`](packages/gql)                     | ISO-GQL (ISO/IEC 39075) query engine over a core graph.                  |
| [`@lenke/gremlin`](packages/gremlin)             | Apache TinkerPop-style Gremlin traversal engine over a core graph.       |
| [`@lenke/serialization`](packages/serialization) | Graph codecs: pg-json, pg-text, ndjson, GraphSON, CSV.                   |

**Native engine (Rust)**

| Package                            | Description                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| [`lenke-core`](crates/lenke-core)  | Rust columnar graph + GQL/Gremlin engines + Apache Arrow output, behind a C ABI. |
| [`@lenke/native`](packages/native) | JS/TS bindings to the Rust core via `bun:ffi` or WebAssembly.                    |

**React**

| Package                          | Description                                                              |
| -------------------------------- | ------------------------------------------------------------------------ |
| [`@lenke/react`](packages/react) | Hooks and providers exposing a graph (TS or native) as a reactive store. |

**Building blocks**

| Package                              | Description                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| [`@lenke/emitter`](packages/emitter) | Typed, cancelable, error-isolated event emitter.                    |
| [`@lenke/errors`](packages/errors)   | Stable `E_*` error codes and a shared `LenkeError` type.            |
| [`@lenke/fp`](packages/fp)           | Lazy, curried iterable combinators composed with `pipe`.            |
| [`@lenke/list`](packages/list)       | Lazy, iterator-backed `List<T>`.                                    |
| [`@lenke/tree`](packages/tree)       | `TreeNode` and `Trie` data structures.                              |
| [`@lenke/utils`](packages/utils)     | Small shared helpers.                                               |
| [`@lenke/dev`](packages/dev)         | Internal build & lint tooling (bundler, lint rules, shared config). |

Each package has its own README with a full API walkthrough.

## Guides

The package READMEs are the API reference; the **[deployment guides](docs/guides/)** are task-oriented — how to wire lenke up for each way you can run it. Every deployment is a point in three orthogonal choices (engine, query frontend, reach-path); [choosing-your-build](docs/guides/choosing-your-build.md) is the matrix.

- [pure-ts](docs/guides/pure-ts.md) — the TypeScript graph, anywhere, no native artifacts
- [native](docs/guides/native.md) / [wasm](docs/guides/wasm.md) — the Rust engine via N-API / bun:ffi / WebAssembly
- [frontend-main-thread](docs/guides/frontend-main-thread.md) / [frontend-worker](docs/guides/frontend-worker.md) — React on the main thread, or a worker-resident sync engine
- [backend-embedded](docs/guides/backend-embedded.md) — an embedded cache / view machine, and multi-tenancy

## Quick start

### Query a graph with GQL (pure TypeScript)

```ts
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const marko = g.addVertex({ labels: ['Person'], properties: { name: 'marko', age: 29 } });
const josh = g.addVertex({ labels: ['Person'], properties: { name: 'josh', age: 32 } });
g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: {} });

const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN b.name AS friend`);
// => [{ friend: 'josh' }]
```

The same graph can be traversed with Gremlin instead — see [`@lenke/gremlin`](packages/gremlin).

### Use it in React

```tsx
import { Graph } from '@lenke/core';
import { GraphProvider, useGraphSelector } from '@lenke/react';

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

For a native-backed store, drive components with `useLiveQuery` over a `@lenke/native` store instead — see [`@lenke/react`](packages/react).

### Run the Rust engine via WebAssembly (Node)

The WebAssembly backend needs no native addon, so it runs the Rust engine from plain Node (or Deno, or the browser):

```ts
import { readFile } from 'node:fs/promises';
import { createWasmBackend } from '@lenke/native/wasm';
import { graphFromNdjson } from '@lenke/native';

const backend = await createWasmBackend(await readFile('lenke_core.wasm'));

// The graph is heap-owned by the wasm module; `using` frees it at scope exit
// (or call `g.free()` explicitly). Same rule on the ffi and N-API backends.
using g = graphFromNdjson(backend, await readFile('graph.ndjson'));

const rows = g.query`MATCH (p:Person) RETURN p.name AS name`;
console.log(rows); // [{ name: 'marko' }, ...]
```

Under Bun, swap `@lenke/native/wasm` for `@lenke/native/ffi` (`createFfiBackend(libPath)`) to load the native dynamic library directly — the rest of the API is identical.

## Develop

A Bun + nx monorepo (`packages/*`) plus a Rust crate (`crates/lenke-core`).

```bash
bun install

bun run check    # typecheck + lint + format check (the pre-commit gate)
bun run build    # build all packages
bun run test     # run all package tests

# Rust core
cargo test --manifest-path crates/lenke-core/Cargo.toml
cargo build --release --manifest-path crates/lenke-core/Cargo.toml   # cdylib for bun:ffi
```

## License

[Apache-2.0](LICENSE)
