# @lenke/sync

> The lenke sync engine: the v1 live-query wire protocol and the transport-agnostic host that serves it.

The frontend asks **declaratively** — the primitive is a standing query, not a fetch. All messages are tagged plain data, so the same protocol rides any port-shaped channel: a Worker `postMessage` port in the browser, a WebSocket to a server. That symmetry is the design's core claim: **a WebSocket is structurally a port**, so the server-embedded host and the browser worker host are one implementation.

## Protocol v1 (~6 messages)

```
client → host:  subscribe   { sub, query, deps, params?, key?, lang?, window? }
host → client:  rows        { sub, rows | (patch, remove, order) | values, version, complete }
client → host:  unsubscribe { sub }
client → host:  query       { req, query, params?, lang?, format? }   // one-shot (gql | gremlin)
host → client:  result      { req, rows | values | arrow | error }
client → host:  mutate      { req, text, lang?, params? }             // gql | gremlin
host → client:  ack         { req, ok, error? }                // UI effect arrives via rows pushes
host → client:  status      { connected, pendingWrites, protocol }
```

`params` is a flat object of `$name` bindings, on every GQL-carrying message. Values bind engine-side to already-parsed param slots and **never touch the GQL parser** — send values as params; never build query text from user input. `lang: 'gremlin'` runs the text through the Gremlin engine instead (results ride `values`); Gremlin has no param binding, so interpolate values with the `gremlin` tag / `escapeGremlin`.

Conformance is **structural**: consumers may write these shapes down independently, with no dependency in either direction. Two backward-compatible extensions ride the same protocol: **keyed row diffs** (declare `key` on subscribe → `patch`/`remove`/`order` pushes instead of full rows) and **Arrow one-shots** (`format: 'arrow'` over a binary transport). Resumable subscriptions and Arrow on the push path are out of v1's scope.

## The host

`createSyncHost(store, { send })` attaches one client connection to a `Store` (from `@lenke/native`). You hand it a `send` function and feed inbound messages to `receive` — which is the shape of every transport:

> **Bare host vs. engine host.** `createSyncHost(store, …)` alone serves a **complete, local-only** store — every subscription is trivially `complete: true`, no demand-fill. For per-collection completeness and demand-fill you want `engine.createHost(…)` (see [The sync engine](#the-sync-engine) below), which wires the same host into a `createSyncEngine`. Reach for the bare host only when the store already holds all the data.

```ts
// Server — WebSocket (Bun.serve shown; `ws` on Node is the same three lines):
Bun.serve({
  fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
  websocket: {
    open(ws) {
      hosts.set(ws, createSyncHost(store, { send: (m) => ws.send(JSON.stringify(m)) }));
    },
    message(ws, raw) {
      hosts.get(ws)?.receive(JSON.parse(String(raw)));
    },
    close(ws) {
      hosts.get(ws)?.close();
      hosts.delete(ws);
    },
  },
});

// Browser — Worker (the identical host, different port):
const host = createSyncHost(store, { send: (m) => self.postMessage(m) });
self.onmessage = (e) => host.receive(e.data);
```

Change routing is epoch-driven: any write through `store.mutate` — this connection's, another connection's on the same store, or a future CDC ingest — bumps the graph version; each subscription's epoch-gated snapshot recomputes only if its dependency tokens moved; a push goes out only when the snapshot reference actually changed. The write path never knows subscriptions exist.

## The client

`createSyncClient({ send })` is `liveQuery`'s port-crossing shadow — the registry the UI consumes. Same transport seam as the host:

```ts
const client = createSyncClient({ send: (m) => ws.send(JSON.stringify(m)) });
ws.onmessage = (e) => client.receive(JSON.parse(String(e.data)));

// A standing query. N consumers of the same (query, params, deps) share ONE
// wire subscription; the wire teardown is refcounted. The dedupe signature
// normalizes formatting (whitespace/comments; values untouched) and treats
// deps as a set — but never folds case (labels/properties are case-sensitive).
// `deps` is REQUIRED (the client does no inference): the label / edge-type /
// property-key tokens whose epochs re-run this query. Pass `null` to recompute
// on every change, or derive it with `inferDeps(query)` (re-exported here). It's
// also load-bearing for demand-fill — the collection is keyed off these tokens.
const live = client.liveQuery('MATCH (p:Person) WHERE p.age >= $min RETURN p.name', {
  deps: ['Person', 'name'],
  params: { min: 18 },
});

// useSyncExternalStore-ready (no React dependency here):
const { rows, complete, error } = useSyncExternalStore(live.subscribe, live.getSnapshot);
// `complete` is false until the host answers — render skeletons, not lies.

await client.mutate('INSERT (:Person {name: $n})', { n: 'zoe' }); // resolves on ack
await client.mutateGremlin`g.addV('Person').property('name', ${name})`; // Gremlin write, values escaped
const rows = await client.query('MATCH (p:Person) RETURN p.name'); // one-shot
const vals = await client.gremlin`g.V().has('name', ${name}).values('age')`; // one-shot Gremlin
```

Snapshots are referentially stable between pushes. A handle whose refcount hits zero tears down its wire subscription and retires into a bounded LRU (`maxInactiveQueries`, default 64) — a quick re-subscribe revives it warm with a fresh wire sub (React StrictMode's mount dance is safe), while an entry evicted past the cap simply re-subscribes cold on next use (a re-query against the host's store, not a refetch). Mutation effects arrive through subscription pushes, exactly as if another client had written.

## The sync loop

`createSyncEngine` is the worker-side machinery between the local store and the network — one producer and one mechanism per arrow:

```
frontend declares interest      →  host onSubscribe fires ensure(deps)
worker fills what that implies  →  collection loaders write into the graph
server pushes what changed      →  engine.ingest(writes); epochs route
local writes go back up         →  engine.mutate: optimistic + FIFO queue w/ backoff
```

```ts
const engine = createSyncEngine({
  store,
  collections: {
    // A collection = an app scope + the labels it covers + how to load it.
    // Demand-fill needs no protocol addition: a subscription's deps already
    // name the labels it reads, so intersecting collections load on demand.
    people: {
      labels: ['Person', 'REPORTS_TO'],
      load: async () => {
        const res = await fetch('/api/people').then((r) => r.json());
        return res.map((p) => ({
          text: 'INSERT (:Person {name: $n, age: $a})',
          params: { n: p.name, a: p.age },
        }));
      },
    },
    // A KEYED collection tracks completeness + demand-fills per distinct VALUE
    // of `key`, read straight off the subscription's params. A subscription for
    // `WHERE t.proj = $proj` with `params: { proj: 'apollo' }` fills only the
    // apollo scope; a different `$proj` is a separate fill. `key` (a value
    // partition) is distinct from `deps` (label intersection) — you need both.
    tasks: {
      labels: ['Task'],
      key: 'proj',
      load: async ({ proj }) => {
        const res = await fetch(`/api/tasks?proj=${proj}`).then((r) => r.json());
        return res.map((t) => ({
          text: 'INSERT (:Task {id: $id, proj: $p})',
          params: { id: t.id, p: proj },
        }));
      },
    },
  },
  initiallyComplete: ['people'], // when the boot snapshot already covers it
  upstream: { push: (w) => api.mutate(w.text, w.params, w.lang) }, // write-back target — forward the lang!
  retry: { attempts: 5, baseMs: 250 },
  onWriteError: (w, e) => report(w, e),
});

// One wired host per client connection:
const host = engine.createHost({ send: (m) => ws.send(JSON.stringify(m)) });
```

Semantics worth knowing:

- **Answer now, fill after** — a subscription over an unloaded collection gets its local (possibly stale) rows immediately with `complete: false`; the loader's writes land in one `store.mutate`, epochs route the push, and `complete` flips. An **empty scope still flips** `complete` (same rows, new truth).
- **A failed load surfaces as a retryable error, not a forever-skeleton** — if a loader throws, the subscribing client's snapshot gets `{ complete: false, error }` (the subscription stays alive; the next demand re-attempts and clears it), and the worker-side `onLoadError(collection, err)` also fires. The wire `error.code` is whatever the loader threw — throw a `LenkeError` (coded) from your loader if you want a meaningful `code`, else it's `'Unknown'` with the thrown message.
- **Loaders return writes** (`SyncWrite[]` — `{ text, params? }` for GQL, `{ text, lang: 'gremlin' }` for a Gremlin traversal), not graphs — values stay on the params path, and the engine stays ignorant of your fetch/decode shape.
- **Write-back is optimistic** — local readers see a mutation before upstream answers; the queue is FIFO, one in flight, exponential backoff; a write that exhausted its retries is dropped and reported (`onWriteError`) — rollback-and-correct is out of v1's scope (it needs server cursors). A mutation that changed nothing replicates nothing (version-gated).
- **`ingest` never echoes** — server-pushed writes apply locally and route by epoch, with no path back into the queue.

## Snapshots (warm boot)

The load-bearing rule: the local snapshot is **warmth, never truth** — every failure mode (eviction, tamper, wrong key, version/user mismatch, corruption) reads as _absent_ and the app cold-boots. The one exception is the **pending-write queue** (truth-on-client until acked), which rides inside the snapshot.

`createSnapshotStore` is the enforced path — the **key decides where the snapshot lives**, so plaintext can't reach disk:

```ts
const key = await importSnapshotKey(rawKeyFromAuth); // worker memory only, never persisted
// key present → AES-GCM-sealed + durable on OPFS; key omitted → memory-only,
// NEVER written to disk (warm within a SharedWorker's life; gone on its exit).
const snapshots = createSnapshotStore({ filename: 'lenke.snapshot', key });

// Save (on an interval, on visibilitychange — the app decides):
await snapshots.save(engine.store, {
  schemaVersion: 'v3',
  userId: session.userId,
  serverCursor: stream.cursor, // resume point for the app's sync stream
  collections: ['people'], // scopes this snapshot covers
  pendingWrites: engine.queuedWrites(), // unsynced changes survive the reload
});

// Boot:
const snap = await snapshots.load({ schemaVersion: 'v3', userId: session.userId });
const store = createStore(
  snap
    ? graphFromNdjson(backend, snap.ndjson) // warm: answer subscriptions now, reconcile after
    : createEmptyGraph(backend),
); // cold: demand-fill does the rest
const engine = createSyncEngine({
  store,
  collections,
  initiallyComplete: snap?.header.collections ?? [],
  initialWrites: snap?.pendingWrites ?? [], // stranded writes resume replication immediately
  upstream,
});
// resume the push stream from snap?.header.serverCursor ?? '' — a cursor-too-old
// answer means: snapshots.clear(), cold boot.
```

**Storage sink (browser vs. server).** `createSnapshotStore({ filename, key })` defaults its durable sink to `opfsStorage(filename)`, which throws off-browser. On Node/Bun pass a `durable` override — `SnapshotStorage` is just `{ read, write, delete }` over bytes:

```ts
import { readFile, writeFile, rm } from 'node:fs/promises';

const fileStorage = (path: string): SnapshotStorage => ({
  read: () => readFile(path).catch(() => null),
  write: (bytes) => writeFile(path, bytes),
  delete: () => rm(path, { force: true }),
});
const snapshots = createSnapshotStore({
  filename: 'ignored',
  key,
  durable: fileStorage('./state.lnks'),
});
```

Encryption is **secure-by-default and structural**: `createSnapshotStore` writes durably only when it holds a key; without one the snapshot stays in memory and never touches disk. And the durable sink enforces this on its own — `opfsStorage.write` **refuses an unencrypted snapshot** (a one-byte crypto flag in the format lets it check without a key), so plaintext can't reach disk even through the raw primitives. The lower-level `encodeSnapshot`/`decodeSnapshot`/`readSnapshot` each still take a required, explicit `{ key }` or `{ unencrypted: true }` — there's no "pass nothing" path, because an unencrypted snapshot carries no authentication at all.

Format: a **plaintext header** `{ formatVersion, schemaVersion, userId, serverCursor, collections }` — the invalidation tier, checked before any decryption (`peekHeader` reads it without the key) — then a gzip payload, optionally AES-GCM-sealed (compress-then-encrypt; authenticated, so tamper — payload _or_ the header, bound in as AEAD `additionalData` — reads as absent; fresh IV per save; revocation = drop the key — crypto-shredding). `readSnapshot`/`load` **delete** a snapshot they can't decode on the way out — and this is intentional: a wrong key or a tampered/authentication-failing payload is treated as "invalid, drop it" (a security property — a snapshot you can't open is a snapshot you evict, not keep). So do NOT probe a key against your live snapshot to "test" it — a failed load destroys it. Use `peekHeader` (reads the plaintext header without the key) for a non-destructive check. Logout should still answer with `Clear-Site-Data: "storage"` — the browser wipes the origin without trusting app code to clean up.

## v1 boundaries (deliberate)

- **`window` is carried but not interpreted** — re-subscribe with the same `sub` to replace a standing query (that is also how a windowed grid will scroll).
- **Rows are JSON** — Arrow-buffer negotiation is an extension.
- **No auth/scoping** — a host serves its store; "the server syncs only what this user may see" is a store-construction concern for the sync loop, not a protocol concern.
- **No resume** — resumable subscriptions (server-side cursor catch-up) are a protocol extension. Reconnect itself is handled: `createReconnectingClient` wraps the client with re-dial/backoff and replays every standing query and parked one-shot over the fresh transport (at-least-once — exactly-once needs server-side request-id dedupe).
