# @lenke/native

> JavaScript/TypeScript bindings to the Rust `lenke-core` columnar graph engine, with a single facade over native (FFI) and WebAssembly backends.

Loads a labeled-property graph into the native columnar core and runs GQL or Gremlin queries against it from JS/TS. One C ABI is exposed through interchangeable backends behind a shared `Backend` contract: a native dynamic library loaded over `bun:ffi` (server/CLI, requires Bun), a WebAssembly module instantiated from bytes or a `fetch` response (browser), and — for plain Node — the prebuilt N-API addon in the sibling `@lenke/node` package (`createNodeBackend()`). Reach for this when you want the Rust engine's query performance from JS without reimplementing it. The backend modules are split behind subpath exports so importing the package in a browser never pulls in the Bun-only `bun:ffi` builtin.

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
- **Node** — use the sibling `@lenke/node` package's `createNodeBackend()`, a prebuilt N-API addon. It's the intended production backend under plain Node (no Bun, no wasm overhead) and plugs into this same `Backend` contract.

All assert that the loaded artifact's ABI version matches the exported `ABI_VERSION`, throwing on mismatch. `isBun` is exported as a convenience flag (`true` when running under Bun, where the FFI backend is available).

## Graph API

`graphFromNdjson(backend, bytes, { parallel? })` and `graphFromFormat(backend, input, format)` deserialize a document into a `RustGraph`; `createEmptyGraph(backend)` cold-boots a blank one to `INSERT` / `mergeNdjson` into; `attachGraph(backend, handle)` wraps an existing backend + handle. A `RustGraph` exposes:

- `vertexCount` / `edgeCount` — counts (numbers).
- `version` — monotonic mutation counter for O(1) change detection.
- `epoch(name)` — per-token change epoch (by label / edge-type / property-key).
- `query(q, ...subs)` — run GQL (tagged template or string) → `Row[]`, where `Row` is `Record<string, unknown>`.
- `queryArrow(q, ...subs)` — run GQL → raw `ARW1` columnar blob as `Uint8Array`. Decode it with the exported `decodeArrow<R>(blob)` (a compact custom framing, **not** Arrow IPC — no `apache-arrow` dependency needed or usable). **Scalar columns only:** ARW1 carries float64/bool/utf8, so a list column (`collect_list`) or an element column (`RETURN n`) is flattened to text and won't reconstruct as a structured array/object — use the JSON `query` for those; reserve Arrow for scalar analytical columns.
- `gremlin(q, ...subs)` — run textual Gremlin → JSON-decoded `unknown[]`.
- `toNdjson()` — serialize back to NDJSON bytes.
- `serialize(format)` — serialize to a named format (`pg-json | pg-text | graphson | csv | ndjson`).
- `mergeNdjson(bytes)` — bulk-append an NDJSON batch into this live graph (a `COPY FROM`; no per-record round-trip, indexes stay current). Returns a `MergeReport` (`{ nodesAdded, edgesAdded, nodesSkipped, edgesSkipped, phantomVertices }`) so a conflicting/partial merge is auditable.
- `createVertexIndex(key)` / `createEdgeIndex(key)` (+ `drop*Index`, `vertexIndexes()` / `edgeIndexes()`) — opt-in property indexes; a `WHERE v.k = $x` / inline `{k: $x}` point lookup then seeks instead of scanning. Host-API only (no GQL `CREATE INDEX`).
- `free()` — release the underlying graph; the handle is invalid afterward. A `FinalizationRegistry` reclaims a leaked handle as a **best-effort backstop** (and warns once in dev), but GC timing is not guaranteed — prefer an explicit `free()` or a `using` binding for prompt, deterministic release.
- `prepare(text)` — parse/lower a GQL query once into a `PreparedQuery` (`.query(params)` / `.queryArrow(params)`). It has **no GC backstop** (unlike the graph handle): release it with `free()` or a `using` binding, or it leaks.
- `pagerank(config?)` / `connectedComponents(config?)` / `labelPropagation(config?)` / `peerPressure(config?)` / `degree(config?)` / `shortestPath(config?)` — the in-engine graph algorithms, run on a **libuv threadpool thread** (genuinely off the JS thread, keeping the engine's rayon parallelism). Each returns a `Promise<Row[]>` (`{ node, score }`, `{ node, componentId }`, …); a `writeProperty` config writes each result back onto its vertex. **Single-flight:** while the promise is pending the graph is locked — any other call throws `E_INVALID_GRAPH_OP` until it settles, so `await` before the next call. The `config` shape and results are identical to the `@lenke/core` free functions, and the algorithms are equally reachable from GQL (`CALL pagerank() YIELD node, score`) and Gremlin (`g.V().pageRank()`).

```ts
const scores = await g.pagerank({ iterations: 20, writeProperty: 'pr' });
```

## Reactive store

`createStore(graph)` builds a framework-agnostic store designed for React's `useSyncExternalStore` (the package has no React dependency). `store.liveQuery(text, { deps, params? })` returns a `{ subscribe, getSnapshot }` pair whose snapshot reference is stable until a relevant mutation occurs; `store.mutate(fn)` runs a mutating callback and notifies subscribers only if the graph's `version` actually changed. `deps` is required — the label / edge-type / property-key tokens whose epochs re-run the query (`null` = recompute on any change); `inferDeps(text)` best-effort extracts them from a query string. `params` binds `$name` placeholders safely.

Release the store (and its underlying graph handle) with a `using` binding or an explicit `store[Symbol.dispose]()` — the store has no `free()` method (unlike the raw graph); disposing it frees the graph.

## License

Apache-2.0
