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

### React (`useSyncExternalStore`)

`createStore` bridges the mutable native graph to React's immutable-snapshot
contract. `getSnapshot` is referentially stable (version-gated), so it won't
re-render-loop; declaring `deps` makes a query recompute only when one of its
tokens (label / edge-type / property-key) actually changed.

```ts
import { createStore } from '@pl-graph/native';
const store = createStore(g);

// in a component
const people = store.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
const rows = useSyncExternalStore(people.subscribe, people.getSnapshot);

// mutate — notifies subscribers only if the graph actually changed
store.mutate((g) => g.query("INSERT (:Person {name: 'zoe'})"));
```

Omit `deps` for coarse mode (recompute on any mutation — always correct; use it
for whole-element returns like `RETURN n`). `inferDeps(text)` is a best-effort
extractor (over-grabs safely; prefer explicit `deps` when correctness matters).
Backed by the engine's O(1) `version` counter and per-token `epoch`s — available
even in the minimal `gql`-only wasm build.

## Building the artifacts

```sh
bun run build:rust       # native dylib/so (all features) → target/release/
bun run build:wasm       # full-browser wasm (gql+gremlin+ndjson+codecs+arrow)
bun run build:wasm:min   # minimal frontend wasm (gql only) — ~40% smaller
bun run build            # the TS package (dist/)
```

### Composable features (smaller wasm)

The Rust crate is feature-gated so a frontend can ship only what it uses. The
big lever is `serde_json`: only the JSON-carrying surfaces pull it in, so a
GQL-only build drops it entirely. Measured `wasm32-unknown-unknown --release`:

| feature set | size | notes |
| --- | --- | --- |
| `gql,gremlin,ndjson,codecs,arrow` | ~1020 KB | everything (server/full) |
| `gql,ndjson` | ~700 KB | query + snapshot load |
| `gql` | ~615 KB | **minimal frontend** — no serde_json |
| (core only) | ~165 KB | graph + fingerprint query, no engines |

Features: `gql` (ISO-GQL engine, serde-free), `gremlin`, `ndjson` (load/
snapshot), `codecs` (pg-json/pg-text/graphson/csv; implies `ndjson`), `arrow`
(implies `gql`), `parallel` (rayon, native only). `default = full`.

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
