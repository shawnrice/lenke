# @pl-graph/native

The Rust columnar core (`crates/pl-graph-core`), callable from JS/TS. One C ABI,
two backends behind a single `Backend` contract:

| Backend | Import | Environment | How memory crosses |
| --- | --- | --- | --- |
| FFI | `@pl-graph/native/ffi` | Bun / server / CLI | `bun:ffi` points at JS-owned buffers, reads results in place |
| WASM | `@pl-graph/native/wasm` | Browser | copies in/out of linear memory via `plg_alloc` |

The root entry (`@pl-graph/native`) is environment-neutral — shared types plus
the `RustGraph` facade — so importing it in a browser never pulls in the
Bun-only `bun:ffi` builtin.

## Usage

```ts
// Bun / server
import { createFfiBackend } from '@pl-graph/native/ffi';
import { graphFromNdjson } from '@pl-graph/native';

const backend = createFfiBackend('/path/to/libpl_graph_core.dylib');
const g = graphFromNdjson(backend, await Bun.file('graph.ndjson').bytes());

g.query`MATCH (a:Person) RETURN a.name`;          // GQL → rows
g.gremlin("g.V().has('name','marko').out()");      // textual Gremlin → values
g.queryArrow('MATCH (n) RETURN n.age');            // Arrow ("ARW1") blob
g.serialize('graphson');                           // → pg-json|pg-text|graphson|csv|ndjson
g.toNdjson();                                      // serialize back out (ndjson bytes)
g.free();                                          // release the native graph
```

```ts
// Load a graph from any supported format (string or bytes)
import { graphFromFormat } from '@pl-graph/native';
const g = graphFromFormat(backend, csvText, 'csv');
```

```ts
// Browser
import { createWasmBackend } from '@pl-graph/native/wasm';
import { graphFromNdjson } from '@pl-graph/native';

const backend = await createWasmBackend(fetch('/pl_graph_core.wasm'));
const g = graphFromNdjson(backend, ndjsonBytes);
```

## Building the artifacts

```sh
bun run build:rust    # native dylib/so  → crates/.../target/release/
bun run build:wasm    # pl_graph_core.wasm → target/wasm32-unknown-unknown/release/
bun run build         # the TS package (dist/)
```

The package asserts `plg_abi_version()` matches `ABI_VERSION` on load; bump both
together when the C ABI changes.

## Status / TODO

- Both backends are tested end-to-end (`backend-ffi.test.ts`,
  `backend-wasm.test.ts`) — query, Gremlin, all five serialization formats, and
  a wasm memory-grow path.
- Arrow results currently surface as the raw `ARW1` blob (`queryArrow`). A typed
  `apache-arrow` `Table` wrapper (see `crates/.../arrow-ffi.test.ts` for the
  decode) is the natural next step.
- Mutation helpers (`addVertex`/`addEdge`/index management) are reachable today
  through GQL/Gremlin strings; a typed builder API could come later.
- `wasm-opt -O3` on the artifact (build is ~1 MB unoptimized).
- A Node (non-Bun) FFI backend via `koffi` if Node support is needed.
