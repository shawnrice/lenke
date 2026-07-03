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

- **No reconnect helper in the library** — the client is bound to one connection, so this example hand-rolls a ~40-line reconnecting server link whose requests _park_ (not reject) while offline. The library should ship this.
- **Scope tokens are load-bearing but unblessed** — per-_value_ collections (cluster = `prod-east`) can't be matched by labels alone; this example rides synthetic `cluster:<name>` strings through the deps channel. It works because deps are opaque strings end-to-end, but the pattern deserves first-class support.
- **The wire is GQL-only** — the engine's gremlin `repeat()` can't ride protocol v1, and the GQL subset has no variable-length paths, so blast radius is fixed-depth chained `MATCH`es merged client-side. Either grow the GQL engine (`[:CALLS*1..4]`) or add a traversal message.
- **Cold boot from empty bytes was an FFI fault** — fixed in `@lenke/native` (`graphFromNdjson` now treats empty input as an empty graph).
- **Status is push-on-change but poll-to-read in the tab** — a status _subscription_ (the doc calls status "a built-in subscription") would remove the 1 s poll in `StatusBar`.
- **Full-row pushes** — every status flip re-sends the whole cluster's rows. Fine at 60 rows; the diff extension (`key` column + upsert/remove) is where this goes next.
