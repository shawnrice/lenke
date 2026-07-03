# @lenke/sync

> The lenke sync engine: the v1 live-query wire protocol and the transport-agnostic host that serves it.

The frontend asks **declaratively** — the primitive is a standing query, not a fetch. All messages are tagged plain data, so the same protocol rides any port-shaped channel: a Worker `postMessage` port in the browser, a WebSocket to a server. That symmetry is the design's core claim: **a WebSocket is structurally a port**, so the server-embedded host and the browser worker host are one implementation.

## Protocol v1 (~6 messages)

```
client → host:  subscribe   { sub, query, params?, deps?, window? }
host → client:  rows        { sub, rows, version, complete }   // now, then on change
client → host:  unsubscribe { sub }
client → host:  query       { req, query, params? }            // one-shot
host → client:  result      { req, rows | error }
client → host:  mutate      { req, gql, params? }
host → client:  ack         { req, ok, error? }                // UI effect arrives via rows pushes
host → client:  status      { connected, pendingWrites, protocol }
```

`params` is a flat object of `$name` bindings, on every query-carrying message. Values bind engine-side to already-parsed param slots and **never touch the GQL parser** — send values as params; never build query text from user input.

Conformance is **structural**: consumers may write these shapes down independently, with no dependency in either direction. Arrow-buffer frames, row diffs, and resumable subscriptions are extensions — not v1.

## The host

`createSyncHost(store, { send })` attaches one client connection to a `Store` (from `@lenke/native`). You hand it a `send` function and feed inbound messages to `receive` — which is the shape of every transport:

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
// wire subscription; the wire teardown is refcounted.
const live = client.liveQuery('MATCH (p:Person) WHERE p.age >= $min RETURN p.name', {
  params: { min: 18 },
});

// useSyncExternalStore-ready (no React dependency here):
const { rows, complete, error } = useSyncExternalStore(live.subscribe, live.getSnapshot);
// `complete` is false until the host answers — render skeletons, not lies.

await client.mutate('INSERT (:Person {name: $n})', { n: 'zoe' }); // resolves on ack
const rows = await client.query('MATCH (p:Person) RETURN p.name'); // one-shot
```

Snapshots are referentially stable between pushes. A handle whose refcount hits zero tears down its wire subscription but stays canonical — re-subscribing revives it with a fresh wire sub (React StrictMode's mount dance is safe). Mutation effects arrive through subscription pushes, exactly as if another client had written.

## v1 boundaries (deliberate)

- **`window` is carried but not interpreted** — re-subscribe with the same `sub` to replace a standing query (that is also how a windowed grid will scroll).
- **`complete` is always `true`** — it becomes meaningful when the demand-fill sync loop lands (partially-synced collections must distinguish "no results" from "not loaded").
- **Rows are JSON** — Arrow-buffer negotiation is an extension.
- **No auth/scoping** — a host serves its store; "the server syncs only what this user may see" is a store-construction concern for the sync loop, not a protocol concern.
- **No reconnect/resume** — a client is bound to one connection; resumable subscriptions are a protocol extension. On reconnect, build a new client (standing queries are cheap to re-declare).
