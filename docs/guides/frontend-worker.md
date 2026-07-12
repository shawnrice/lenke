# A local-first UI with the graph in a worker

**Package:** `@lenke/sync` (over a native/wasm `@lenke/native` store) · **Runtime:** browser (web worker) + your UI thread.

Use this when the graph is big enough — or the interaction local-first enough — that you want it resident in a **web worker**: fetch, decode, query, and optimistic writes all happen off the main thread, and the UI renders from pushed query results. `@lenke/sync` is the machinery for that. It is **not** a database server and it does **not** fetch for you — it's a sync _loop_ you drive against **your own** backend API through two seams (loaders and an upstream push). You supply the business logic; the engine orchestrates when to run it.

There's no lenke server to stand up. The design's symmetry — the same host code serves a worker `postMessage` channel or a WebSocket — means you _could_ put a host behind a socket, but the intended shape for a frontend is: the worker fetches from your existing API and uses the sync engine to manage local state.

## Why a worker (and not a "prebuilt worker")

`@lenke/sync` ships no worker bootstrap, by design. A generic prebuilt worker would force you to fetch on the main thread and transfer data in — the opposite of the point. Instead you write a small worker that fetches and runs the engine; wiring the host/client across the boundary is about two lines each side.

## The wiring

The host and client are transport-agnostic: you hand each a `send` and feed it inbound messages via `receive`. Over a worker, `send` is `postMessage`.

**Worker side** — the graph, the sync engine, and a host:

```ts
import { createStore, graphFromNdjson } from '@lenke/native';
import { createWasmBackend } from '@lenke/native/wasm';
import { createSyncEngine } from '@lenke/sync';

const backend = await createWasmBackend(fetch(new URL('./lenke_core.wasm', import.meta.url)));
const store = createStore(graphFromNdjson(backend, seedBytes));

const engine = createSyncEngine({
  store,
  // Demand-fill: a subscription whose deps name these labels triggers `load`,
  // which fetches from YOUR API and returns writes that materialize the scope.
  collections: {
    people: {
      labels: ['Person'],
      load: async () => {
        const res = await fetch('/api/people');
        return (await res.json()).map((p) => ({
          text: 'INSERT (:Person {id: $id, name: $name})',
          params: { id: p.id, name: p.name },
        }));
      },
    },
  },
  // Optimistic local writes replicate here (omit for a local-only engine):
  upstream: {
    push: (w) =>
      fetch('/api/mutate', { method: 'POST', body: JSON.stringify(w) }).then(() => undefined),
  },
});

const host = engine.createHost({ send: (m) => self.postMessage(m) });
self.onmessage = (e) => host.receive(e.data);
```

**UI side** — a client next to React:

```ts
import { createSyncClient } from '@lenke/sync';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const client = createSyncClient({ send: (m) => worker.postMessage(m) });
worker.onmessage = (e) => client.receive(e.data);

// Standing query — pushed now and on every relevant change. `deps` must list
// every label AND property key the query reads: `p.name` reads the `name` key,
// so an in-place `SET p.name` only invalidates the query if `name` is declared.
const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
// live.subscribe / live.getSnapshot plug straight into useSyncExternalStore.

// Optimistic writes — the effect returns via subscription pushes:
await client.mutate('INSERT (:Person {id: $id, name: $name})', { id: '7', name: 'zoe' });
await client.mutateGremlin`g.addV('Person').property('name', ${"o'brien"})`; // Gremlin, value-safe
```

That's the whole boundary. React integration is `useSyncExternalStore(live.subscribe, live.getSnapshot)` — `@lenke/react` doesn't wrap the sync client, so the [`examples/service-map`](../../examples/service-map) app hand-rolls a one-line `useLive` hook.

## Both query languages

Reads and writes are bilingual. Reads: `client.liveQuery(text, { deps, lang: 'gremlin' })` or the standing GQL form; one-shots via `client.query` / `client.gremlin`. Writes: `client.mutate` (GQL) or `client.mutateGremlin` (a Gremlin traversal, values escaped safely — Gremlin has no param binding). Loaders and the upstream push carry a `lang` too, so a Gremlin shop can demand-fill and replicate entirely in Gremlin. Pick the [one language](./choosing-your-build.md#axis-2--the-query-frontend) your shop uses.

## What crosses the boundary

Not the graph — **query results**. A subscription pushes either the full row set (keyless) or, if you declare a `key`, keyed diffs (`patch` / `remove` / `order`) so only what changed crosses. One-shot `query` can answer with a zero-copy Arrow blob (`{ format: 'arrow' }`) over a binary-capable port. The graph itself only crosses a boundary as an NDJSON snapshot for **persistence** (below), never across the thread boundary.

## Warm-start persistence

`@lenke/sync` can snapshot the worker's graph to OPFS (gzip, optional AES-GCM at rest) and warm-boot from it, re-enqueueing any un-acked offline writes:

`createSnapshotStore` makes the security posture structural: the **key**, not a storage choice, decides where a snapshot lives. Pass a per-user `CryptoKey` and snapshots are AES-GCM-sealed and written durably to OPFS; omit it and they stay **in memory only, never on disk** — plaintext can't leak to durable storage. (In this SharedWorker the in-memory buffer warms every tab that reconnects across the worker's life; a dedicated worker would lose it on unload.)

```ts
import { createSnapshotStore } from '@lenke/sync';

// key present → sealed + durable (OPFS); key omitted → memory-only, never disk.
const snapshots = createSnapshotStore({ filename: 'graph.snap', key });
const snap = await snapshots.load({ schemaVersion: '1', userId });
const store = createStore(graphFromNdjson(backend, snap ? snap.ndjson : seedBytes));
// … build the engine with initialWrites: snap?.pendingWrites ?? [] …
// … then `await snapshots.save(store, { schemaVersion: '1', userId, … })` on change.
```

The lower-level `encodeSnapshot`/`decodeSnapshot`/`readSnapshot` primitives are still exported for advanced use; each takes an explicit `{ key }` or `{ unencrypted: true }` (no silent keyless path).

This tooling is browser-oriented (OPFS, `CompressionStream`, WebCrypto). A server would reuse `toNdjson`/`graphFromNdjson` but not `opfsStorage`.

## Shipped vs. planned

The protocol, host, client, sync loop, and snapshotting are shipped. A few pieces are plumbed but not yet fully realized — don't build UI that assumes them:

- **`complete` (honest partial-sync)** — under a `createSyncEngine` host the flag reflects real per-collection completeness (a bare host is trivially `complete: true`); skeleton-UI states just aren't exercised end-to-end yet.
- **Windowed reads for grids** — a keyless subscription may carry `{ offset, limit }` and the host pages the result; keyed-diff windowing is still reserved. `complete` reflects the whole scope, so scrolling is a re-subscribe with a new window.
- **Resumable subscriptions / server-cursor catch-up** — reconnect replays standing queries from scratch (correct under the snapshot model, but not a cursor resume).
- **Write reconciliation (rollback-and-correct)** — a write that exhausts its retries is dropped and reported (`onWriteError`); true reconciliation needs server cursors.

For flaky-network transports (a WebSocket rather than a worker port), `createReconnectingClient` adds re-dial/backoff and parks writes while offline.
