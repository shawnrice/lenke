// Exercises the port lifecycle helper `servePort` (the worker-side piece of a
// SharedWorker app) over a real MessageChannel. serveSharedWorker /
// connectSharedWorker need SharedWorker DOM globals (self.onconnect, pagehide),
// absent under Bun — so we drive the underlying servePort directly, which is
// what serveSharedWorker calls per connection.
// Run: bun port-test.ts

import { createFfiBackend } from '@lenke/native/ffi';
import { createEmptyGraph, createStore } from '@lenke/native';
import { createSyncEngine, createSyncClient, servePort, type SyncHost } from '@lenke/sync';

const LIB = '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so';
const backend = createFfiBackend(LIB);
const log = (...a: unknown[]) => console.log(...a);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const store = createStore(createEmptyGraph(backend));
  store.mutate((g) => g.query("INSERT (:Task {id: 't1', title: 'hello', done: false})"));
  const engine = createSyncEngine({ store });

  // Wrap engine.createHost so we can observe host lifecycle (create/teardown).
  const hosts: SyncHost[] = [];
  const factory = {
    createHost: (opts: Parameters<typeof engine.createHost>[0]) => {
      const h = engine.createHost(opts);
      hosts.push(h);
      return h;
    },
  };

  const { port1, port2 } = new MessageChannel(); // port2 = worker side, port1 = tab side
  const served = servePort(factory, port2 as any);

  const client = createSyncClient({ send: (m) => port1.postMessage(m) });
  port1.onmessage = (e) => client.receive(e.data);
  port1.start?.();

  const live = client.liveQuery('MATCH (t:Task) RETURN t.id AS id, t.title AS title', {
    deps: ['Task'],
  });
  await tick();
  log('hosts created:', hosts.length);
  log('rows over the port:', live.getSnapshot().rows);
  log('worker host subscriptionCount:', hosts[0]!.subscriptionCount());

  // Tab says goodbye (what connectSharedWorker posts on pagehide):
  log('\n-> tab posts { type: "bye" }');
  port1.postMessage({ type: 'bye' });
  await tick();
  log('host subscriptionCount after bye (torn down):', hosts[0]!.subscriptionCount());

  // A bye'd port that speaks again revives a fresh host (bfcache path):
  log('\n-> tab re-subscribes after bye (bfcache revival)');
  client.replay();
  await tick();
  log('hosts created total (revived fresh):', hosts.length);
  log('rows after revival:', hosts.length > 1 ? live.getSnapshot().rows : '(no revival)');

  served.close();
  store[Symbol.dispose]();
  log('\n=== PORT DONE ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
