# The Rust engine in WebAssembly

**Engine:** Rust `lenke-core` · **Reach-path:** WebAssembly (`@lenke/native/wasm`) · **Runtime:** browser, and anything with a `WebAssembly` global (Node, Deno, Bun).

Use this to run the columnar Rust engine in a browser with no native addon — or in any host where you'd rather ship a `.wasm` than a platform binary. Same `RustGraph` API as the [native](./native.md) reach-paths; the differences are an **async load**, no threads, and that you build and ship the `.wasm` yourself.

## Loading

`createWasmBackend` is async and accepts `.wasm` bytes, a `Response`, or a compiled `Module`:

```ts
import { createWasmBackend } from '@lenke/native/wasm';
import { graphFromNdjson } from '@lenke/native';

// Browser — stream-compile from a fetch:
const backend = await createWasmBackend(fetch(new URL('./lenke_core.wasm', import.meta.url)));

// Node — from bytes:
// import { readFile } from 'node:fs/promises';
// const backend = await createWasmBackend(await readFile('lenke_core.wasm'));

using g = graphFromNdjson(backend, ndjsonBytes);
const rows = g.query`MATCH (p:Person) RETURN p.name AS name`;
```

There's no `wasm-bindgen`/`wasm-pack` glue and no import object, so no special bundler wasm-loader config is required — a bundler that turns the `.wasm` into a URL or bytes is enough. The `./wasm` subpath export is separate from `./ffi` precisely so a browser bundle never pulls in the Bun-only `bun:ffi` builtin.

## Memory

The wasm graph is heap-owned by the module (its handle is a linear-memory offset) — release it with `using` or `g.free()`, exactly as for ffi. The `FinalizationRegistry` backstop applies here too, as a leak-net only. See the [memory model](./choosing-your-build.md#memory-model).

One wasm-specific caveat if you drop below the facade: the module's `memory.buffer` is replaced when the heap grows, so never cache a typed-array view across a call that can allocate. The `RustGraph`/`Backend` facade handles this for you — you only need to know it if you call the raw exports.

## Building the `.wasm`

```bash
# in packages/native
bun run build:wasm      # gql, gremlin, ndjson, codecs, arrow — no threads
bun run build:wasm:min  # gql only — the smallest bundle
```

This is `cargo build --release --target wasm32-unknown-unknown --no-default-features --features …`. `--no-default-features` deliberately drops `rayon`: wasm has no threads, so NDJSON decode runs serially.

### Trim it to your query language

The feature flags are how you shrink the bundle to what you actually use — this is the [query-frontend choice](./choosing-your-build.md#axis-2--the-query-frontend) expressed as a compile-time option. A Gremlin-only shop builds `--features gremlin,ndjson` and leaves GQL out; a GQL-only read cache uses `build:wasm:min`. You ship only the engine surface you query.

## Packaging (roadmap)

Today, **you build the `.wasm` and hand its bytes/`Response` to `createWasmBackend` yourself** — `@lenke/native` does not yet bundle or publish a prebuilt artifact, and there's no packaging step that copies it into a `dist/`. A packaged distribution (so you can `import` the wasm without a manual build) is planned but **not yet built**. Until then, wire the build output into your app's bundler (the [`examples/service-map`](../../examples/service-map) worker imports it with a Vite `?url` import).

## In a worker

The common browser deployment runs this wasm engine inside a web worker, driven by [`@lenke/sync`](./frontend-worker.md) so the graph lives off the main thread. See that guide for the wiring.
