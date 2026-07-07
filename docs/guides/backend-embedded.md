# An embedded cache or view machine on the backend

**Engine:** Rust `lenke-core` via [`@lenke/node`](./native.md) (or bun:ffi) · **Runtime:** Node or Bun server.

Use this to hold a graph in a server process — a read cache, a materialized view, a projection of some source of truth that you query with GQL/Gremlin without standing up an external graph database. The [`examples/service-map`](../../examples/service-map) server is a worked instance (a fleet of services held in an N-API store, served over WebSocket). For how the engine loads per runtime, see [native](./native.md).

## Lifecycle

Build from bytes, query, mutate, release:

```ts
import { createNodeBackend } from '@lenke/node/backend';
import { createStore, graphFromNdjson } from '@lenke/native';

const backend = createNodeBackend();

// Build + bulk-load in one step (the NDJSON decoder is parallel by default):
const store = createStore(graphFromNdjson(backend, ndjsonBytes));

// Query:
store.graph.query`MATCH (s:Service) WHERE s.cluster = ${cluster} RETURN s.name`;

// Mutate (GQL DML through the same call, or a Gremlin traversal via .gremlin):
store.mutate((g) => g.query`INSERT (:Service {sid: ${id}, name: ${name}})`);

// Release (N-API is GC-managed, but this keeps one lifecycle across reach-paths):
store[Symbol.dispose]?.(); // or `using store = createStore(...)`
```

`createStore` wraps the graph as a reactive store (`store.mutate`, `store.liveQuery`, `store.version`) — the same store the [worker sync engine](./frontend-worker.md) and [React](./frontend-main-thread.md) drive. You can also work the raw `graph` directly for one-off queries.

There's no separate batch-insert API: **bulk load = decode from a serialized format**, one-at-a-time mutation = a GQL/Gremlin write. For a large ingest, prefer building from NDJSON over looping single writes.

## Loading and rebuilding from a source of truth

The Rust engine decodes serialized bytes directly (`graphFromNdjson`, or `graphFromFormat(backend, input, 'pg-json' | 'pg-text' | 'graphson' | 'csv' | 'ndjson')`). To rebuild the cache from your system of record, stream its rows out as NDJSON and decode:

```ts
const g = graphFromNdjson(backend, await pullSnapshotFromDb()); // Uint8Array of NDJSON
```

An empty input is treated as an empty graph (a cold boot), not an error.

## Persistence / warm-start

Round-trip the graph to warm-start a cache without re-reading the source:

```ts
const dump = store.graph.toNdjson(); // Uint8Array — persist to disk/blob
// … later …
const store2 = createStore(graphFromNdjson(backend, dump));
```

The OPFS/encryption snapshot tooling in `@lenke/sync` is browser-oriented; on a server, `toNdjson` / `graphFromNdjson` is the round-trip. (The service-map server doesn't persist at all — it regenerates its fleet each boot.)

## Multi-tenancy

There is **no tenancy primitive, and you don't need one.** Isolate tenants by giving each its own graph:

```ts
const tenants = new Map<string, Store>();

function storeFor(tenantId: string): Store {
  let s = tenants.get(tenantId);
  if (!s) {
    s = createStore(graphFromNdjson(backend, loadTenant(tenantId)));
    tenants.set(tenantId, s);
  }
  return s;
}
```

Each `Graph`/`Store` is fully self-contained — a mutation on one can't reach another (`clone()` makes the same guarantee explicit). lenke ships no registry, pool, or "tenant" concept; the `Map<tenantId, Store>` above is the whole pattern.

Note the distinction from _per-connection_ isolation: the service-map server keeps one shared graph and a protocol **host per socket** — every connection sees the same data. That's connection fan-out, not tenant isolation. For tenant isolation you want one graph per tenant, as above.

## Memory

Evicting a tenant means dropping it from the map **and** disposing its store — `store[Symbol.dispose]()` (or `.free()` on the graph). The facades make that one code path across ffi/N-API/wasm; what differs per reach-path (and the N-API reclamation-timing caveat) is covered in the [memory model](./choosing-your-build.md#memory-model).
