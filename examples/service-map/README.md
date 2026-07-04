# service map — the vertical slice

A live **service-dependency map**: ~240 services across 4 clusters, `CALLS` edges between them, one editable `status` column. It exists to thread a single feature through every layer at once — React → `createSyncClient` → SharedWorker (`wasm` engine + OPFS + `createSyncEngine`) → WebSocket → Node server (`@lenke/node` addon + `createSyncHost`).

```
Tab(s) — dumb <table> over useSyncExternalStore
  └─ createSyncClient ── MessagePort ──► SharedWorker (one store per origin)
                                           ├─ wasm engine + createStore
                                           ├─ OPFS snapshot (warm boot, queue survival)
                                           ├─ createSyncEngine
                                           │    ├─ collections per cluster (scope tokens)
                                           │    └─ upstream: reconnecting WS
                                           └─ engine.createHost per tab port
Node server — @lenke/node addon, whole fleet, createSyncHost per socket
```

## Run it

```sh
# once: build the engine artifacts
bun run --cwd ../../packages/native build:wasm     # lenke_core.wasm
cd ../../packages/node && bunx napi build --platform --release --esm && cd -

bun run server    # terminal 1 → ws://localhost:8787
bun run dev       # terminal 2 → vite; open the printed URL (Chrome first: SharedWorker + OPFS)
```

Headless check without a browser: `bun run smoke` (spawns the real Node server, drives it with a protocol client over a real socket).

## The three demos

1. **Live everywhere** — open two tabs, pick a cluster, flip a service to `down` in one tab; the other updates instantly (one SharedWorker store, one host per tab, epoch-routed pushes). Click `?` → **blast radius** lists everything transitively upstream of the victim.
2. **Demand-fill** — switch to a cluster you haven't visited: `loading…` renders from `complete: false`, the worker fetches that cluster from the server (scope-token collections), rows land, `complete` flips.
3. **Pull the cable** — kill the server (Ctrl-C terminal 1). Edits still apply instantly and the status line counts unsynced changes. **Reload the tab while offline** — the OPFS snapshot warm-boots the store with your queued edits intact. Restart the server — the queue drains, counter hits 0.

## Findings (the point of the slice)

- **Reconnect helper — now in the library** — this example's server link used to be a ~40-line hand-rolled reconnecting client; it's now `createReconnectingClient` (re-dial with back-off, re-subscribe on reconnect, park writes while offline). The worker's whole transport is the `connect` callback — open a socket, wire its lifecycle. Durable writes still belong to the engine's queue, not the helper.
- **Value-scoped collections are first-class now** — one `services` collection declares `key: 'cluster'`, and the engine tracks completeness and demand-fill per bound value, reading it straight off the subscription's `$cluster` param. The former synthetic `cluster:<name>` token threaded through the deps channel is gone — no parallel namespace of magic strings, and the scope rides the real (first-class) params path.
- **Gremlin can't ride the wire yet** — the protocol carries a bare `query` string that the host runs through the GQL engine; a Gremlin traversal (or a live query) has no way across protocol v1. Not a blocker here: blast radius is a single **native GQL** variable-length query (`-[:CALLS]->{1,}`, `DISTINCT` to collapse multi-path callers), not the fixed-depth chained `MATCH`es an earlier draft of this demo used. When Gremlin does need to ride, it wants a `lang` discriminator on the message.
- **Cold boot from empty bytes was an FFI fault** — fixed in `@lenke/native` (`graphFromNdjson` now treats empty input as an empty graph).
- **Status is a subscription now** — the host already pushed `status` on every queue/connectivity change; the client wakes `onStatus` subscribers on each, so `StatusBar` is `useSyncExternalStore(client.onStatus, client.getStatus)` with no interval (the former 1 s poll is gone).
- **Full-row pushes** — every status flip re-sends the whole cluster's rows. Fine at 60 rows; the diff extension (`key` column + upsert/remove) is where this goes next.
