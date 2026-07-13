// Crown-jewel repro (standalone, fully instrumented): origin-skip is NOT stable
// across a reconnect, so a client re-ingests its OWN write from the CDC catch-up.
//
// Mechanism:
//  - Each connection's host calls writeLog.register() → a per-CONNECTION origin id.
//  - CDC origin-skip is `entry.origin !== thisHost.origin`.
//  - A real reconnect re-dials → a NEW host → a NEW origin id (exactly the README's
//    `onConnection((socket) => createSyncHost(store, { writeLog }))`).
//  - If a client's own write committed server-side but its ack + cursor-tick were
//    lost (socket dropped mid-response — the normal lost-ack race the dedup
//    registry exists for), the client's write-cursor is behind that write's seq.
//  - On reconnect, `subscribeWrites{ since }` replays the tail from the old cursor.
//    The client's own earlier write now carries a STALE origin id, so the new
//    host's origin-skip does NOT recognize it → it is forwarded back to the writer
//    → engine.ingest re-applies it. Double-apply.
//
// The server-side dedup registry plugs the MUTATE-replay path (re-ack, no
// re-apply). It does NOT plug this CDC path. There is no equivalent guard.
import { createStore, createEmptyGraph, type RustGraph, type Store } from '@lenke/native';
import {
  createSyncClient,
  createSyncHost,
  createSyncEngine,
  createWriteLog,
  createDedupRegistry,
  type SyncHost,
  type SyncWrite,
} from '@lenke/sync';

import { backend } from './lib.ts';

const log = (...a: unknown[]) => console.log(...a);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

type Wiring = {
  toHost: { send: (m: unknown) => void; retarget: (t: ((m: unknown) => void) | null) => void };
  fromHost: { send: (m: unknown) => void; retarget: (t: ((m: unknown) => void) | null) => void };
};
const link = (t: ((m: unknown) => void) | null) => {
  let target = t;
  return { send: (m: unknown) => target?.(m), retarget: (x: typeof t) => (target = x) };
};

async function repro(label: string, constrained: boolean) {
  log(`\n========== ${label} (constrained=${constrained}) ==========`);
  const schema = (g: RustGraph) => {
    if (constrained) g.createUniqueConstraint('Item', 'id');
  };
  const serverGraph = createEmptyGraph(backend);
  schema(serverGraph);
  const serverStore = createStore(serverGraph);
  const writeLog = createWriteLog();
  const dedup = createDedupRegistry();

  const count = (s: Store) =>
    s.mutate((g) => g.query<{ c: number }>('MATCH (n:Item) RETURN count(*) AS c')[0].c);

  // --- client A: optimistic engine + client, over cuttable links.
  const localGraph = createEmptyGraph(backend);
  schema(localGraph);
  const local = createStore(localGraph);

  const fromHost = link(null);
  let host: SyncHost = createSyncHost(serverStore, {
    send: (m) => fromHost.send(m),
    writeLog,
    dedup,
  });
  const toHost = link((m) => host.receive(m));
  const aClient = createSyncClient({ send: (m) => toHost.send(m) });
  fromHost.retarget((m) => aClient.receive(m));

  const engineReal = createSyncEngine({
    store: local,
    upstream: { push: (w: SyncWrite) => aClient.pushWrite(w) },
    retry: { attempts: 3, baseMs: 5 },
  });

  const ingested: string[] = [];
  aClient.subscribeWrites((writes) => {
    for (const w of writes) ingested.push(w.text);
    try {
      engineReal.ingest(writes);
    } catch (e) {
      log('  !! engine.ingest THREW:', (e as Error).message);
      throw e; // propagate exactly as the real client.receive would
    }
  });

  await settle();
  log('start: server', count(serverStore), 'A.local', count(local));

  // Cut host->client so A's write commits but its ack + cursor-tick are lost.
  fromHost.retarget(null);
  engineReal.mutate('INSERT (:Item {id: $id})', { id: 'x1' });
  await settle();
  log('after A writes x1 (fromHost cut): server', count(serverStore), 'A.local', count(local));
  log('  A write-cursor is behind its own write (ack+tick were dropped)');

  // Reconnect: fresh host (NEW origin), both links restored, replay.
  toHost.retarget(null);
  host = createSyncHost(serverStore, { send: (m) => fromHost.send(m), writeLog, dedup });
  fromHost.retarget((m) => aClient.receive(m));
  toHost.retarget((m) => host.receive(m));

  let replayThrew: string | null = null;
  try {
    aClient.replay();
  } catch (e) {
    replayThrew = (e as Error).message;
  }
  await settle();

  log('after reconnect+replay:');
  log('  writes A re-ingested from CDC:', ingested);
  log('  server Items :', count(serverStore), '(exactly-once via dedup → expect 1)');
  log('  A.local Items:', count(local), '(expect 1 — must not re-apply own write)');
  if (replayThrew) log('  replay() THREW (aborts reconnect):', replayThrew);

  const doubled = count(local) !== 1 || replayThrew !== null;
  log('  VERDICT:', doubled ? 'BUG — own write re-applied across reconnect' : 'ok');
}

await repro('Variant A: no constraint (silent divergence)', false);
await repro('Variant B: unique constraint (crash out of replay)', true);
