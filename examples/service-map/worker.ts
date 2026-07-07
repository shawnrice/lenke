// The SharedWorker: one lenke store per origin, shared by every tab.
//
// Boot order: OPFS snapshot (warm) or empty graph (cold) → sync engine with
// per-cluster demand-fill collections → one protocol host per connecting tab
// (the SharedWorker `connect` event hands us a MessagePort per tab — exactly
// the protocol's one-host-per-connection shape). The server link is a
// reconnecting WebSocket speaking the same protocol: loaders are one-shot
// `query`s against it, write-back is `mutate` (its ack settles the queue).
//
// Offline is not a special mode: while the socket is down, upstream.push
// simply doesn't settle — the engine's write stays queued (and counted in
// every tab's status bar), OPFS snapshots keep it across reloads, and the
// queue drains on reconnect.

import { createStore, graphFromNdjson } from '@lenke/native';
import { createWasmBackend } from '@lenke/native/wasm';
import {
  createReconnectingClient,
  createSyncEngine,
  encodeSnapshot,
  opfsStorage,
  readSnapshot,
  type CollectionDefinition,
  type SyncWrite,
} from '@lenke/sync';

import wasmUrl from '../../crates/lenke-core/target/wasm32-unknown-unknown/release/lenke_core.wasm?url';
import { CLUSTERS } from './datagen.ts';

const SERVER_URL = 'ws://localhost:8787';
const SCHEMA_VERSION = 'service-map-v1';
const USER_ID = 'demo'; // a real app: the authenticated user, + a key for AES-GCM

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
//
// The server link used to be a ~40-line hand-rolled reconnecting client right
// here (the tire-kick finding that motivated it). It now IS the library's
// `createReconnectingClient`: loaders are its `query`, write-back its `mutate`,
// both parking while offline and replaying on reconnect; `onConnectivity`
// nudges every tab's status line. The whole transport is the `connect`
// callback below — open a socket, wire its lifecycle, hand back send/close.

const boot = async () => {
  const storage = opfsStorage('service-map.lnks');
  const snap = await readSnapshot(storage, { schemaVersion: SCHEMA_VERSION, userId: USER_ID });

  const backend = await createWasmBackend(fetch(wasmUrl));
  const store = createStore(
    graphFromNdjson(backend, snap ? snap.ndjson : new TextEncoder().encode('')),
  );
  const server = createReconnectingClient({
    connect: ({ opened, received, closed }) => {
      const ws = new WebSocket(SERVER_URL);
      ws.onopen = opened;
      ws.onmessage = (e) => received(JSON.parse(String(e.data)));
      ws.onclose = closed;
      ws.onerror = () => ws.close();

      return { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
    },
    retry: { baseMs: 500, maxMs: 5000 },
  });

  // ONE demand-fill collection, sliced by the `cluster` param. Every cluster
  // shares the :Service/:CALLS labels, so labels alone can't tell prod-east
  // from prod-west — but the subscription already carries the value as a param
  // (`WHERE s.cluster = $cluster`), so the collection just declares `cluster`
  // its scope key and the engine tracks completeness / demand-fill per value.
  // No synthetic token, no magic string on the deps channel.
  const collections: Record<string, CollectionDefinition> = {
    services: {
      labels: ['Service'],
      key: 'cluster',
      load: async ({ cluster }): Promise<SyncWrite[]> => {
        const services = await server.query(
          'MATCH (s:Service) WHERE s.cluster = $cluster RETURN s.sid, s.name, s.cluster, s.tier, s.status',
          { cluster },
        );
        const calls = await server.query(
          'MATCH (a:Service)-[t:CALLS]->(b:Service) WHERE a.cluster = $cluster RETURN t.cid, a.sid, b.sid, t.protocol, t.p95',
          { cluster },
        );

        return [
          // The server RETURNs columns named `s.sid`, `s.cluster`, … so remap
          // them to the INSERT's `$sid` / `$cluster` param names (a raw `params:
          // r` would bind nothing — every property would land null).
          ...services.map((r) => ({
            text: 'INSERT (:Service {sid: $sid, name: $name, cluster: $cluster, tier: $tier, status: $status})',
            params: {
              sid: r['s.sid'],
              name: r['s.name'],
              cluster: r['s.cluster'],
              tier: r['s.tier'],
              status: r['s.status'],
            },
          })),
          ...calls.map((r) => ({
            text:
              'MATCH (a:Service), (b:Service) WHERE a.sid = $from AND b.sid = $to ' +
              'INSERT (a)-[:CALLS {cid: $cid, protocol: $protocol, p95: $p95}]->(b)',
            params: {
              cid: r['t.cid'],
              from: r['a.sid'],
              to: r['b.sid'],
              protocol: r['t.protocol'],
              p95: r['t.p95'],
            },
          })),
        ];
      },
    },
  };

  const engine = createSyncEngine({
    store,
    collections,
    // Snapshot header stores the cluster names it covered; restore each as a
    // scoped slice of the one `services` collection.
    initiallyComplete: (snap?.header.collections ?? []).map((cluster) => ({
      name: 'services',
      scope: { cluster },
    })),
    initialWrites: snap?.pendingWrites ?? [],
    upstream: { push: (w) => server.mutate(w.text, w.params) },
    retry: { attempts: Number.MAX_SAFE_INTEGER, baseMs: 500, maxMs: 5000 }, // outage ≠ poison: park, don't drop
  });

  // Snapshot on a debounce whenever anything moved (version, queue, loads).
  let lastSaved = -1;
  const save = async (): Promise<void> => {
    const loaded = CLUSTERS.filter(
      (c) => engine.collectionState('services', { cluster: c }) === 'complete',
    );
    await storage.write(
      await encodeSnapshot(store, {
        schemaVersion: SCHEMA_VERSION,
        userId: USER_ID,
        collections: loaded,
        pendingWrites: engine.queuedWrites(),
      }),
    );
    lastSaved = store.version;
  };

  setInterval(() => {
    if (store.version !== lastSaved || engine.pendingWrites() > 0) {
      void save();
    }
  }, 3000);

  // Nudge every tab's status line when the server link flips.
  server.onConnectivity(() => {
    for (const h of tabHosts) {
      h.sendStatus();
    }
  });

  return engine;
};

const engineReady = boot();
const tabHosts = new Set<ReturnType<Awaited<ReturnType<typeof boot>>['createHost']>>();

// Each tab connecting to the SharedWorker gets its own protocol host over its
// own MessagePort — one host per connection, identical to the WS server side.
(globalThis as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => {
  const [port] = e.ports;

  void engineReady.then((engine) => {
    const host = engine.createHost({ send: (m) => port.postMessage(m) });
    tabHosts.add(host);
    port.onmessage = (msg) => host.receive(msg.data);
    port.start?.();
  });
};
