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
  createSyncClient,
  createSyncEngine,
  encodeSnapshot,
  opfsStorage,
  readSnapshot,
  type GqlWrite,
  type SyncClient,
} from '@lenke/sync';

import wasmUrl from '../../crates/lenke-core/target/wasm32-unknown-unknown/release/lenke_core.wasm?url';
import { CLUSTERS } from './datagen.ts';

const SERVER_URL = 'ws://localhost:8787';
const SCHEMA_VERSION = 'service-map-v1';
const USER_ID = 'demo'; // a real app: the authenticated user, + a key for AES-GCM

// ---------------------------------------------------------------------------
// server link: a reconnecting protocol client
// ---------------------------------------------------------------------------
// The v1 client is bound to one connection (no resume) — so the link owns a
// "current client" and re-creates it per socket. Requests made while offline
// PARK (the returned promise settles after reconnect) rather than reject:
// that is what lets the engine's in-flight write survive an outage. This
// wrapper is exactly the reconnect helper the library doesn't ship yet — a
// deliberate tire-kick finding of this example.

type ServerLink = {
  query: SyncClient['query'];
  mutate: SyncClient['mutate'];
  connected: () => boolean;
  onConnectivity: (cb: (up: boolean) => void) => void;
};

const connectServer = (url: string): ServerLink => {
  let client: SyncClient | null = null;
  const waiters: ((c: SyncClient) => void)[] = [];
  const connectivityListeners = new Set<(up: boolean) => void>();

  const current = (): Promise<SyncClient> =>
    client
      ? Promise.resolve(client)
      : new Promise((resolve) => {
          waiters.push(resolve);
        });

  const dial = (): void => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      const fresh = createSyncClient({ send: (m) => ws.send(JSON.stringify(m)) });
      ws.onmessage = (e) => fresh.receive(JSON.parse(String(e.data)));
      client = fresh;
      waiters.splice(0).forEach((w) => w(fresh));
      connectivityListeners.forEach((cb) => cb(true));
    };
    ws.onclose = () => {
      client?.close();
      client = null;
      connectivityListeners.forEach((cb) => cb(false));
      setTimeout(dial, 1000); // keep dialing; parked requests settle on success
    };
    ws.onerror = () => ws.close();
  };

  dial();

  return {
    query: async (text, params) => (await current()).query(text, params),
    mutate: async (gql, params) => (await current()).mutate(gql, params),
    connected: () => client !== null,
    onConnectivity: (cb) => {
      connectivityListeners.add(cb);
    },
  };
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const boot = async () => {
  const storage = opfsStorage('service-map.lnks');
  const snap = await readSnapshot(storage, { schemaVersion: SCHEMA_VERSION, userId: USER_ID });

  const backend = await createWasmBackend(fetch(wasmUrl));
  const store = createStore(
    graphFromNdjson(backend, snap ? snap.ndjson : new TextEncoder().encode('')),
  );
  const server = connectServer(SERVER_URL);

  // One demand-fill collection per cluster, matched by a synthetic SCOPE TOKEN
  // ('cluster:prod-east') that tabs include in their subscription deps. Labels
  // alone can't distinguish value-scoped collections — every cluster shares
  // :Service/:CALLS — so scopes ride the deps channel as opaque strings.
  // (Another deliberate finding: the library should bless this pattern.)
  const collections = Object.fromEntries(
    CLUSTERS.map((cluster) => [
      cluster,
      {
        labels: [`cluster:${cluster}`],
        load: async (): Promise<GqlWrite[]> => {
          const services = await server.query(
            'MATCH (s:Service) WHERE s.cluster = $c RETURN s.sid, s.name, s.cluster, s.tier, s.status',
            { c: cluster },
          );
          const calls = await server.query(
            'MATCH (a:Service)-[t:CALLS]->(b:Service) WHERE a.cluster = $c RETURN t.cid, a.sid, b.sid, t.protocol, t.p95',
            { c: cluster },
          );

          return [
            ...services.map((r) => ({
              gql: 'INSERT (:Service {sid: $sid, name: $name, cluster: $cluster, tier: $tier, status: $status})',
              params: r as Record<string, unknown>,
            })),
            ...calls.map((r) => ({
              gql:
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
    ]),
  );

  const engine = createSyncEngine({
    store,
    collections,
    initiallyComplete: snap?.header.collections ?? [],
    initialWrites: snap?.pendingWrites ?? [],
    upstream: { push: (w) => server.mutate(w.gql, w.params) },
    retry: { attempts: Number.MAX_SAFE_INTEGER, baseMs: 500, maxMs: 5000 }, // outage ≠ poison: park, don't drop
  });

  // Snapshot on a debounce whenever anything moved (version, queue, loads).
  let lastSaved = -1;
  const save = async (): Promise<void> => {
    const loaded = CLUSTERS.filter((c) => engine.collectionState(c) === 'complete');
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
