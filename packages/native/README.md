# @lenke/native

> JavaScript/TypeScript bindings to the Rust `lenke-core` columnar graph engine, with a single facade over native (FFI) and WebAssembly backends.

Loads a labeled-property graph into the native columnar core and runs GQL or Gremlin queries against it from JS/TS. One C ABI is exposed through two interchangeable backends behind a shared `Backend` contract: a native dynamic library loaded over `bun:ffi` (server/CLI, requires Bun) and a WebAssembly module instantiated from bytes or a `fetch` response (browser). Reach for this when you want the Rust engine's query performance from JS without reimplementing it. The backend modules are split behind subpath exports so importing the package in a browser never pulls in the Bun-only `bun:ffi` builtin.

## Install

```bash
bun add @lenke/native
```

## Usage

```ts
import { createFfiBackend } from '@lenke/native/ffi';
import { graphFromNdjson } from '@lenke/native';

// Load the native library built from `crates/lenke-core`
// (liblenke_core.{dylib,so,dll}).
const backend = createFfiBackend('/path/to/liblenke_core.dylib');

// Decode an NDJSON document into a graph.
const g = graphFromNdjson(backend, await Bun.file('graph.ndjson').bytes());

console.log(g.vertexCount, g.edgeCount);

// GQL via tagged template (or a plain string) → decoded rows.
const rows = g.query`MATCH (p:Person) RETURN p.name AS name`;
for (const row of rows) {
  console.log(row.name);
}

// Gremlin against the same graph.
const result = g.gremlin`g.V().hasLabel('Person').count()`;

// The graph is heap-owned by the native module; release it when done.
g.free();
```

In the browser, swap the backend for the wasm one; the rest of the API is identical:

```ts
import { createWasmBackend } from '@lenke/native/wasm';
import { graphFromNdjson } from '@lenke/native';

const backend = await createWasmBackend(fetch('/lenke_core.wasm'));
const g = graphFromNdjson(backend, ndjsonBytes);
```

## Loading a backend

The entry point (`@lenke/native`) is environment-neutral: it exports the `RustGraph` facade, the graph constructors, and the reactive store. The backend itself comes from a subpath:

- `@lenke/native/ffi` — `createFfiBackend(libPath: string): Backend`. Requires **Bun** (uses `bun:ffi`). Pass the absolute path to the built `liblenke_core.{dylib,so,dll}`.
- `@lenke/native/wasm` — `createWasmBackend(source): Promise<Backend>`. `source` is a `WebAssembly.Module`, `ArrayBuffer`, `ArrayBufferView`, or a (promise of a) `fetch` `Response`.

Both assert that the loaded artifact's ABI version matches the exported `ABI_VERSION`, throwing on mismatch. `isBun` is exported as a convenience flag (`true` when running under Bun, where the FFI backend is available).

## Graph API

`graphFromNdjson(backend, bytes, { parallel? })` and `graphFromFormat(backend, input, format)` deserialize a document into a `RustGraph`. `attachGraph(backend, handle)` wraps an existing backend + handle. A `RustGraph` exposes:

- `vertexCount` / `edgeCount` — counts (numbers).
- `version` — monotonic mutation counter for O(1) change detection.
- `epoch(name)` — per-token change epoch (by label / edge-type / property-key).
- `query(q, ...subs)` — run GQL (tagged template or string) → `Row[]`, where `Row` is `Record<string, unknown>`.
- `queryArrow(q, ...subs)` — run GQL → raw Arrow (`ARW1`) columnar blob as `Uint8Array` (decode with `apache-arrow`).
- `gremlin(q, ...subs)` — run textual Gremlin → JSON-decoded `unknown[]`.
- `toNdjson()` — serialize back to NDJSON bytes.
- `serialize(format)` — serialize to a named format (`pg-json | pg-text | graphson | csv | ndjson`).
- `free()` — release the underlying graph; the handle is invalid afterward and is **not** garbage-collected, so call it explicitly.

## Reactive store

`createStore(graph)` builds a framework-agnostic store designed for React's `useSyncExternalStore` (the package has no React dependency). `store.liveQuery(text, { deps? })` returns a `{ subscribe, getSnapshot }` pair whose snapshot reference is stable until a relevant mutation occurs; `store.mutate(fn)` runs a mutating callback and notifies subscribers only if the graph's `version` actually changed. With `deps` (label / edge-type / property-key tokens) a live query recomputes only when one of its dependency epochs moves; `inferDeps(text)` best-effort extracts those tokens from a query string.

## License

Apache-2.0
