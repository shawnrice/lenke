import { createEmptyGraph, createStore } from '@lenke/native';
/**
 * Priya's dogfood slice: an offline-first "team tasks" app on @lenke/sync.
 *
 * Simulates the worker<->UI wire in-process (a fake MessagePort pair), so
 * there's no real Worker/WebSocket. Exercises:
 *   - createStore over the FFI backend (real liblenke_core.so)
 *   - createSyncEngine with a demand-fill, project-keyed CollectionDefinition
 *   - a fake upstream.push (the "server")
 *   - engine.createHost + createSyncClient across an in-process port
 *   - a liveQuery with deps + optimistic mutate
 *   - offline queue-then-drain
 *
 * Run: bun tasks.ts
 */
import { createFfiBackend } from '@lenke/native/ffi';
import { createSyncClient, createSyncEngine, type SyncWrite } from '@lenke/sync';

const LIB = '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so';

const log = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => log(`\n──────── ${t} ────────`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The "server": the source of truth the worker demand-fills from and pushes to.
// Tasks live per project. We record every upstream push to prove offline drain.
type Task = { id: string; project: string; title: string; done: boolean };
const serverTasks: Record<string, Task[]> = {
  'proj-alpha': [
    { id: 't1', project: 'proj-alpha', title: 'Design wire protocol', done: false },
    { id: 't2', project: 'proj-alpha', title: 'Write loader', done: true },
  ],
  'proj-beta': [{ id: 't9', project: 'proj-beta', title: 'Unrelated beta task', done: false }],
};
const upstreamLog: SyncWrite[] = [];
let online = true; // the fake network switch

// ── Worker side: real FFI store + sync engine ────────────────────────────────
const backend = createFfiBackend(LIB);
const store = createStore(createEmptyGraph(backend));

let loadCount = 0;
const engine = createSyncEngine({
  store,
  collections: {
    // A project-keyed collection: demand-fills per distinct `project` param value.
    tasks: {
      labels: ['Task'],
      key: 'project',
      load: async (scope) => {
        loadCount += 1;
        const project = scope.project as string;
        log(`  [loader] demand-fill for project=${project} (load #${loadCount})`);
        await sleep(10); // simulate a network fetch
        const rows = serverTasks[project] ?? [];
        return rows.map((t) => ({
          text: 'INSERT (:Task {id: $id, proj: $project, title: $title, done: $done})',
          params: { id: t.id, project: t.project, title: t.title, done: t.done },
        }));
      },
    },
  },
  upstream: {
    push: async (w) => {
      if (!online) throw new Error('offline'); // network is down -> ret/queue
      await sleep(5);
      upstreamLog.push(w);
      log(`  [upstream] pushed: ${w.text.slice(0, 40)}… params=${JSON.stringify(w.params)}`);
    },
  },
  retry: { attempts: 8, baseMs: 20 },
  onWriteError: (w, e) => log(`  [onWriteError] dropped ${JSON.stringify(w)}: ${e}`),
  onLoadError: (c, e) => log(`  [onLoadError] collection '${c}' failed: ${e}`),
});

// ── In-process port: two ends that hand messages to each other synchronously.
//    This stands in for worker.postMessage / ws.send.
const host = engine.createHost({ send: (m) => queueMicrotask(() => client.receive(m)) });
const client = createSyncClient({ send: (m) => queueMicrotask(() => host.receive(m)) });

// ── UI side: a standing query for one project's tasks ────────────────────────
async function main() {
  hr('1. DEMAND-FILL: live query over an unloaded, project-scoped collection');
  // deps name the label the query reads; params carry the collection key.
  const alpha = client.liveQuery(
    'MATCH (t:Task) WHERE t.proj = $project RETURN t.id AS id, t.title AS title, t.done AS done ORDER BY t.id',
    { deps: ['Task'], params: { project: 'proj-alpha' } },
  );

  let snaps = 0;
  alpha.subscribe(() => {
    snaps += 1;
    const s = alpha.getSnapshot();
    log(
      `  [ui] push #${snaps}: complete=${s.complete} rows=${JSON.stringify(
        s.rows.map((r) => `${r.id}:${r.title}${r.done ? '✓' : ''}`),
      )}`,
    );
  });

  log('  [ui] initial snapshot (before any push):', JSON.stringify(alpha.getSnapshot()));
  await sleep(60); // let subscribe -> ensure(load) -> push settle
  log(
    `  engine.collectionState('tasks', {project:'proj-alpha'}) = ${engine.collectionState('tasks', { project: 'proj-alpha' })}`,
  );

  hr('2. OPTIMISTIC WRITE while ONLINE');
  await client.mutate('INSERT (:Task {id: $id, proj: $project, title: $title, done: $done})', {
    id: 't3',
    project: 'proj-alpha',
    title: 'Ship the slice',
    done: false,
  });
  await sleep(40);
  log(
    `  upstream received ${upstreamLog.length} write(s), pendingWrites=${engine.pendingWrites()}`,
  );

  hr('3. OFFLINE: queue writes while the network is down');
  online = false;
  log('  network -> OFFLINE');
  // These apply locally (optimistic) but can't reach upstream.
  await client.mutate('INSERT (:Task {id: $id, proj: $project, title: $title, done: $done})', {
    id: 't4',
    project: 'proj-alpha',
    title: 'Offline edit A',
    done: false,
  });
  await client.mutate('INSERT (:Task {id: $id, proj: $project, title: $title, done: $done})', {
    id: 't5',
    project: 'proj-alpha',
    title: 'Offline edit B',
    done: false,
  });
  await sleep(60);
  log(`  local rows now show optimistic writes; engine.pendingWrites()=${engine.pendingWrites()}`);
  log(`  upstream still has ${upstreamLog.length} write(s) (t4/t5 NOT yet replicated)`);
  const oneShot = await client.query(
    'MATCH (t:Task) WHERE t.proj = $project RETURN count(t) AS n',
    { project: 'proj-alpha' },
  );
  log(`  one-shot count of alpha tasks (local): ${JSON.stringify(oneShot)}`);

  hr('4. DRAIN: reconnect and watch the FIFO queue flush');
  online = true;
  log('  network -> ONLINE (queue pumps on next mutate OR immediately via retry backoff)');
  // The pump is already retrying with backoff; just wait for it to succeed.
  await sleep(300);
  log(`  engine.pendingWrites()=${engine.pendingWrites()}`);
  log(`  upstream now has ${upstreamLog.length} write(s):`);
  for (const w of upstreamLog) log(`    - ${JSON.stringify(w.params)}`);

  hr('5. DEMAND-FILL a SECOND project scope (proves per-key demand-fill)');
  const beta = client.liveQuery(
    'MATCH (t:Task) WHERE t.proj = $project RETURN t.id AS id, t.title AS title ORDER BY t.id',
    { deps: ['Task'], params: { project: 'proj-beta' } },
  );
  beta.subscribe(() => {
    const s = beta.getSnapshot();
    log(`  [ui/beta] complete=${s.complete} rows=${JSON.stringify(s.rows.map((r) => r.id))}`);
  });
  await sleep(60);
  log(`  loadCount total = ${loadCount} (alpha + beta, alpha NOT reloaded on writes)`);

  hr('SUMMARY');
  log(`  demand-fill loads: ${loadCount}`);
  log(`  upstream writes replicated: ${upstreamLog.length}`);
  log(`  final pendingWrites: ${engine.pendingWrites()}`);
  log(`  client status:`, JSON.stringify(client.getStatus()));

  client.close();
  host.close();
  store[Symbol.dispose](); // Store has no .free(); disposal frees the graph
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
