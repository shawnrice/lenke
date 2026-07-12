// Priya's offline-first "team tasks" slice on lenke's sync engine.
// Run: bun main.ts
//
// Exercises: FFI store, createSyncEngine with a demand-fill CollectionDefinition
// keyed by project, engine.createHost <-> createSyncClient over a fake wire,
// a liveQuery with deps+params, an optimistic mutate, and offline queue->drain.
// Plus: what a subscriber sees when a demand-fill LOAD fails.

import { createEmptyGraph, createStore } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';
import { createSyncEngine, createSyncClient, type SyncWrite } from '@lenke/sync';

import { makeServer } from './server.ts';
import { makeWire, tick } from './wire.ts';

const LIB = '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so';

const log = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => log(`\n=== ${t} ===`);

const server = makeServer();
const loadErrors: Array<{ collection: string; error: string }> = [];
const writeErrors: SyncWrite[] = [];

// --- Worker side: store + engine ---------------------------------------------
const store = createStore(createEmptyGraph(backend()));
function backend() {
  return createFfiBackend(LIB);
}

const engine = createSyncEngine({
  store,
  collections: {
    // One collection, keyed by the `project` param → demand-fills per project.
    tasks: {
      labels: ['Task'],
      key: 'proj',
      load: async (scope) => {
        const project = String(scope.proj);
        const tasks = await server.fetchTasks(project);
        return tasks.map<SyncWrite>((t) => ({
          text: 'INSERT (:Task {id: $id, proj: $proj, title: $title, done: $done})',
          params: { id: t.id, proj: project, title: t.title, done: t.done },
        }));
      },
    },
  },
  upstream: { push: (w) => server.push(w) },
  retry: { attempts: 20, baseMs: 25, maxMs: 200 },
  onLoadError: (collection, error) =>
    loadErrors.push({ collection, error: String((error as Error)?.message ?? error) }),
  onWriteError: (w) => writeErrors.push(w),
});

// --- The wire: engine host <-> sync client -----------------------------------
const wire = makeWire();
const host = engine.createHost({ send: (m) => wire.hostSend(m) });
const client = createSyncClient({ send: (m) => wire.clientSend(m) });
wire.attachHost({ receive: (m) => host.receive(m) });
wire.attachClient({ receive: (m) => client.receive(m) });
// NOTE: engine.createHost() internally wires host.refresh() on loads/queue changes,
// so the app does NOT need engine.onChange(() => host.refresh()) — verified: the
// demand-fill `complete` flip works without it.

const snap = (lq: { getSnapshot: () => unknown }) => lq.getSnapshot();

// ============================================================================
async function main() {
  // -- 1. Demand-fill ---------------------------------------------------------
  hr('1. DEMAND-FILL (subscribe to project=apollo)');
  const apollo = client.liveQuery(
    'MATCH (t:Task) WHERE t.proj = $proj RETURN t.id AS id, t.title AS title, t.done AS done',
    { deps: ['Task', 'title', 'done'], params: { proj: 'apollo' } },
  );
  log('immediately after subscribe:', snap(apollo)); // skeleton: complete:false
  await tick(30);
  log('after demand-fill landed:', snap(apollo));
  log('collectionState(tasks, apollo):', engine.collectionState('tasks', { proj: 'apollo' }));
  log('server.fetchCalls:', server.fetchCalls);

  // -- 2. Optimistic write ----------------------------------------------------
  hr('2. OPTIMISTIC WRITE (add a task to apollo)');
  await client.mutate('INSERT (:Task {id: $id, proj: $proj, title: $title, done: $done})', {
    id: 'a3',
    proj: 'apollo',
    title: 'Ship the demo',
    done: false,
  });
  await tick(30);
  log('apollo rows after optimistic insert:', snap(apollo));
  log('server.received (replicated up):', server.received.length, 'write(s)');
  log('engine.pendingWrites():', engine.pendingWrites());

  // -- 3. Offline queue -> drain ---------------------------------------------
  hr('3. OFFLINE QUEUE -> DRAIN');
  server.online = false;
  log('-> server offline; issuing two optimistic writes');
  await client.mutate('INSERT (:Task {id: $id, proj: $proj, title: $title, done: $done})', {
    id: 'a4',
    proj: 'apollo',
    title: 'Handle reconnect',
    done: false,
  });
  await client.mutate('INSERT (:Task {id: $id, proj: $proj, title: $title, done: $done})', {
    id: 'a5',
    proj: 'apollo',
    title: 'Drain the queue',
    done: false,
  });
  await tick(60);
  log('local rows while offline:', (snap(apollo) as { rows: unknown[] }).rows.length, 'tasks');
  log('engine.pendingWrites() (queued):', engine.pendingWrites());
  log('server.received so far:', server.received.length);

  log('-> server back online; waiting for queue to drain...');
  server.online = true;
  // Wait for backoff-scheduled retries to fire.
  for (let i = 0; i < 40 && engine.pendingWrites() > 0; i++) await tick(30);
  log('engine.pendingWrites() after reconnect:', engine.pendingWrites());
  log('server.received total:', server.received.length);
  log('writeErrors (dropped):', writeErrors.length);

  // -- 4. Failed demand-fill LOAD --------------------------------------------
  hr('4. FAILED DEMAND-FILL LOAD (subscribe to project=ghost)');
  const ghost = client.liveQuery('MATCH (t:Task) WHERE t.proj = $proj RETURN t.id AS id', {
    deps: ['Task', 'title', 'done'],
    params: { proj: 'ghost' },
  });
  log('immediately:', snap(ghost));
  await tick(60);
  log('after load throws:', snap(ghost));
  log('collectionState(tasks, ghost):', engine.collectionState('tasks', { proj: 'ghost' }));
  log('onLoadError fired:', loadErrors);

  // -- Wrap up ----------------------------------------------------------------
  hr('DONE');
  log('client.subscriptionCount():', client.subscriptionCount());
  store[Symbol.dispose]();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
