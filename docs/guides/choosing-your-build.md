# Choosing your build

Three independent choices — **engine**, **query frontend**, **reach-path** — plus one cross-cutting concern, **memory**. This page is the matrix; the topology guides ([pure-ts](./pure-ts.md), [native](./native.md), [wasm](./wasm.md), and the frontend/backend guides) show each in context.

## Axis 1 — the engine

The graph substrate comes in two complete, interchangeable implementations. You pick one; you don't stack them (there's no "Rust storage behind a TS frontend" hybrid — that's nonsense, and lenke doesn't do it).

|                 | pure-TS — `@lenke/core`                                                                                                          | Rust core — `lenke-core`                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **What it is**  | A mutable in-memory labeled-property graph, driven by method calls (`addVertex`, `getVerticesByLabel`, opt-in property indexes). | A columnar graph you drive with a query language (GQL DML for writes, GQL/Gremlin for reads). |
| **Runs on**     | Anything that runs JS — browser, Node, Deno, Bun. No native artifact.                                                            | Reached from JS via one of three reach-paths (below).                                         |
| **Query**       | Bring a frontend: [`@lenke/gql`](../../packages/gql) or [`@lenke/gremlin`](../../packages/gremlin) over the core `Graph`.        | GQL and Gremlin compiled into the crate; also Apache Arrow columnar output.                   |
| **Strengths**   | Zero native deps, smallest footprint, trivial to embed, direct object access.                                                    | Throughput on large graphs and heavy queries; columnar scans; Arrow transfer.                 |
| **Use it when** | Small-to-medium graphs, quick embedding, or anywhere you can't ship a native/wasm artifact.                                      | Large data, query-heavy workloads, or anywhere you want the columnar engine.                  |

The two engines deliberately share only their **reactive change signal** — a monotonic `version` and per-token `epoch(name)` — which is what lets the React store and the sync engine work identically over either. See [pure-ts](./pure-ts.md) for the TS engine and [native](./native.md)/[wasm](./wasm.md) for the Rust one.

## Axis 2 — the query frontend

The graph is **query-language-agnostic**. A shop standardizes on GQL _or_ Gremlin — rarely both — so lenke lets you take only the one you use.

- **On the TS engine**, the frontend is a package you install over `@lenke/core`:
  - GQL → [`@lenke/gql`](../../packages/gql): `query(graph, 'MATCH …')`.
  - Gremlin → [`@lenke/gremlin`](../../packages/gremlin): `graph.toArray(traversal(V(id), values('name')))`.
  - Install one, tree-shake the other out entirely.
- **On the Rust engine**, the frontend is a **Cargo feature** compiled into the crate. Build with `--features gql` _or_ `--features gremlin` and drop the other. Same intent as the npm choice, coarser mechanism (you rebuild rather than re-install). This is also how you shrink a wasm bundle — see [wasm](./wasm.md).

GQL and Gremlin are faithful to their own ontologies, so where the two query models genuinely differ, semantics differ; otherwise they run over the same substrate and see the same data.

## Axis 3 — the reach-path (Rust engine only)

The Rust core is one crate reachable three ways. All three present the **same JS surface** — a `Backend` contract and the `RustGraph`/`Store` facades over it — so your code is identical regardless of which one loads.

|              | bun:ffi                                                                          | N-API                                                                                            | WebAssembly                                                                                           |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Package**  | `@lenke/native/ffi`                                                              | [`@lenke/node`](../../packages/node)                                                             | `@lenke/native/wasm`                                                                                  |
| **Load**     | `createFfiBackend(libPath)` — synchronous `dlopen`; you supply the library path. | `createNodeBackend()` (facade) or raw `Graph` — synchronous `require` of a per-platform `.node`. | `await createWasmBackend(source)` — **async**; `source` is `.wasm` bytes / a `Response` / a `Module`. |
| **Artifact** | `liblenke_core.{so,dylib,dll}`                                                   | `lenke-node.<triple>.node`                                                                       | `lenke_core.wasm`                                                                                     |
| **Build**    | `bun run build:rust` (in `@lenke/native`)                                        | `napi build --platform --release --esm` (in `@lenke/node`)                                       | `bun run build:wasm` (in `@lenke/native`)                                                             |
| **Runtime**  | Bun only (`bun:ffi`)                                                             | Node (the fast production path)                                                                  | Browser — and anything with a `WebAssembly` global (Node, Deno, Bun)                                  |
| **Threads**  | rayon (parallel NDJSON decode)                                                   | rayon                                                                                            | none — wasm has no threads, so the parallel decoder falls back to serial                              |

Guides: [native](./native.md) covers bun:ffi + N-API (server/CLI); [wasm](./wasm.md) covers WebAssembly (browser/universal).

## Memory model

The Rust engine's graph is heap-owned and must be released. lenke makes this **one rule across all three reach-paths**:

```ts
// Preferred — released at scope exit on ffi, N-API, and wasm alike:
using g = graphFromNdjson(backend, bytes);
// ... use g ...
// (freed automatically here)

// Explicit — works on any build target, including older bundler outputs:
const g = graphFromNdjson(backend, bytes);
try {
  // ... use g ...
} finally {
  g.free(); // idempotent
}
```

- `using` needs a modern build target (TS ≥ 5.2 / esbuild down-levels it to `try/finally` and shims `Symbol.dispose`); `free()` is the universal fallback. lenke polyfills `Symbol.dispose` for runtimes that predate it, so `using` is safe to ship to browsers.
- A `Store` is disposable too: `using store = createStore(g)` frees the underlying graph.
- If you forget both, a `FinalizationRegistry` backstop reclaims the handle when the wrapper is garbage-collected. It's a leak-net (the GC may never run it before exit), **not** a substitute for `using`/`free()`.
- The pure-TS `@lenke/core` graph and the raw `@lenke/node` `Graph` class are ordinary GC-managed objects — nothing to free. The `RustGraph`/`Store` facades give even the N-API path a uniform `free()`/`using` (a no-op-ish release that also drops the facade's handle registry), so you can write one lifecycle for all builds.

## Putting it together

A few common combinations:

- **Browser, GQL, local-first** → Rust engine · GQL · wasm, driven through [`@lenke/sync`](./frontend-worker.md) in a worker.
- **Node service cache, Gremlin** → Rust engine · Gremlin (`--features gremlin`) · N-API, embedded per [backend-embedded](./backend-embedded.md).
- **Anywhere, no native artifact** → TS engine · your frontend of choice, per [pure-ts](./pure-ts.md).
