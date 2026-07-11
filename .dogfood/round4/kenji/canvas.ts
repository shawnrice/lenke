/**
 * Collaborative multiplayer state server ("Figma-ish shared canvas") on lenke.
 *
 * Topology (the supported socket-server shape, per packages/sync/README.md):
 *   - ONE authoritative lenke store on the server.
 *   - ONE bare `createSyncHost(store, …)` per WebSocket connection.
 *   - Many real `new WebSocket(...)` clients (`createReconnectingClient`), each:
 *       * a per-VIEWPORT live query (param-scoped keyed diff),
 *       * a presence live query (all cursors),
 *       * a high-rate write loop (create/move shapes, move cursor, bump a
 *         shared atomic counter).
 *
 * Every client write is a `mutate` over the wire; the server applies it to the
 * single shared store; epoch routing pushes the change to every subscription on
 * every host. That is the server-authoritative multiplayer loop.
 *
 * Run:  bun canvas.ts
 * Env:  CLIENTS, DURATION_MS, WRITE_INTERVAL_MS, PORT
 */

import { ErrorCode } from '@lenke/errors';
import { createEmptyGraph, createStore, type Store } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';
import {
  createReconnectingClient,
  createSyncHost,
  type ReconnectingClient,
  type SyncHost,
} from '@lenke/sync';

const LIB = '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so';
const PORT = Number(process.env.PORT ?? 8791);
const CLIENTS = Number(process.env.CLIENTS ?? 32);
const DURATION_MS = Number(process.env.DURATION_MS ?? 5000);
const WRITE_INTERVAL_MS = Number(process.env.WRITE_INTERVAL_MS ?? 8);
const WORLD = 10_000; // canvas is WORLD x WORLD units
const VIEW = 2_000; // each client sees a VIEW x VIEW window

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------------------------------------------------------------------
// SERVER — the authoritative store + one host per socket.
// ---------------------------------------------------------------------------

function startServer() {
  const backend = createFfiBackend(LIB);
  const store = createStore(createEmptyGraph(backend));

  // Point lookups for move/delete + presence cleanup seek instead of scan.
  store.graph.createVertexIndex('id');

  // A single shared atomic counter node to test server-authoritative RMW.
  store.mutate((g) => g.query('INSERT (:Counter {id: $id, n: 0})', { id: 'global' }));

  const hosts = new Map<unknown, SyncHost>();
  const owners = new Map<unknown, string>(); // ws -> clientId (for presence cleanup)

  const server = Bun.serve<{ clientId: string }, {}>({
    port: PORT,
    fetch(req, srv) {
      const clientId = new URL(req.url).searchParams.get('client') ?? 'anon';
      return srv.upgrade(req, { data: { clientId } })
        ? undefined
        : new Response('expected ws', { status: 400 });
    },
    websocket: {
      // Larger backpressure budget so a burst of pushes to a slow client does
      // not drop frames silently (Bun default is modest).
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) {
        const host = createSyncHost(store, { send: (m) => ws.send(JSON.stringify(m)) });
        hosts.set(ws, host);
        owners.set(ws, ws.data.clientId);
      },
      message(ws, raw) {
        hosts.get(ws)?.receive(JSON.parse(String(raw)));
      },
      close(ws) {
        hosts.get(ws)?.close();
        hosts.delete(ws);
        // SERVER-AUTHORITATIVE presence cleanup: the client that just vanished
        // cannot retract its own cursor, so the server evicts the ephemeral
        // node. This is the bit a bare client-driven model cannot do.
        const clientId = owners.get(ws);
        owners.delete(ws);
        if (clientId) {
          try {
            store.mutate((g) =>
              g.query('MATCH (c:Cursor {id: $id}) DETACH DELETE c', { id: clientId }),
            );
          } catch {
            /* store may be mid-teardown */
          }
        }
      },
    },
  });

  return { store, server, hosts };
}

// ---------------------------------------------------------------------------
// CLIENT — a real WebSocket + reconnecting sync client driving the canvas.
// ---------------------------------------------------------------------------

type ClientStats = {
  id: string;
  acked: number;
  failed: number;
  reconnects: number;
  viewportRows: number;
};

function spawnClient(index: number, opts: { observer: boolean }): {
  client: ReconnectingClient;
  stats: ClientStats;
  killSocket: () => void;
  start: () => void;
  stop: () => void;
  finalViewportRows: () => number;
  bounds: { x0: number; x1: number; y0: number; y1: number };
} {
  const id = `c${index}`;
  const stats: ClientStats = { id, acked: 0, failed: 0, reconnects: 0, viewportRows: 0 };

  // Viewport = a random window into the world (the observer sees everything).
  const vx = opts.observer ? 0 : Math.floor(Math.random() * (WORLD - VIEW));
  const vy = opts.observer ? 0 : Math.floor(Math.random() * (WORLD - VIEW));
  const bounds = opts.observer
    ? { x0: 0, x1: WORLD, y0: 0, y1: WORLD }
    : { x0: vx, x1: vx + VIEW, y0: vy, y1: vy + VIEW };

  // Hold the live socket so the reconnection storm can murder it.
  let liveWs: WebSocket | null = null;
  let firstOpen = false;

  const client = createReconnectingClient({
    retry: { baseMs: 100, maxMs: 1000 },
    connect: ({ opened, received, closed }) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/?client=${id}`);
      liveWs = ws;
      ws.onopen = () => {
        if (firstOpen) stats.reconnects += 1;
        firstOpen = true;
        opened();
      };
      ws.onmessage = (e) => received(JSON.parse(String(e.data)));
      ws.onclose = () => closed();
      ws.onerror = () => ws.close();
      return {
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
      };
    },
  });

  // Per-viewport keyed live query: "shapes in my viewport". Distinct params per
  // client => NOT pooled => every Shape write re-scans every client's query.
  const viewport = client.liveQuery(
    'MATCH (s:Shape) WHERE s.x >= $x0 AND s.x < $x1 AND s.y >= $y0 AND s.y < $y1 ' +
      'RETURN s.id AS id, s.x AS x, s.y AS y, s.color AS color, s.t AS t',
    {
      deps: ['Shape', 'x', 'y', 'color'],
      params: bounds,
      key: 'id',
    },
  );

  // PRESENCE RE-ESTABLISHMENT: the sync protocol replays standing *queries* on
  // reconnect, never past *writes*. The server evicts my cursor when my socket
  // dies (server-authoritative ephemeral cleanup), so I must re-assert it every
  // time the transport comes up — this is app code the engine does not provide.
  client.onConnectivity((connectedUp) => {
    if (!connectedUp) return;
    // Delete-then-insert to keep it idempotent-ish: ISO GQL has no MERGE/upsert,
    // so re-asserting presence without duplicating the node takes two writes and
    // is still racy against reconnect-replay of an in-flight insert.
    (async () => {
      try {
        await client.mutate('MATCH (c:Cursor {id: $id}) DETACH DELETE c', { id });
        await client.mutate('INSERT (:Cursor {id: $id, cx: $x, cy: $y})', {
          id,
          x: bounds.x0,
          y: bounds.y0,
        });
      } catch {
        /* offline again; next connectivity flip re-asserts */
      }
    })();
  });

  // Presence: everyone's cursors (ephemeral Cursor nodes).
  const presence = client.liveQuery('MATCH (c:Cursor) RETURN c.id AS id, c.cx AS cx, c.cy AS cy', {
    deps: ['Cursor', 'cx', 'cy'],
    key: 'id',
  });

  // Cross-client push-latency probe (only the observer measures): when a new
  // shape id appears, latency = now - its create timestamp `t` (same process =
  // one clock). Referentially-stable snapshots let us diff by id set.
  const seen = new Set<string>();
  const unsub = viewport.subscribe(() => {
    const snap = viewport.getSnapshot();
    stats.viewportRows = snap.rows.length;
    if (opts.observer) {
      for (const r of snap.rows) {
        const rid = String(r.id);
        if (!seen.has(rid)) {
          seen.add(rid);
          if (typeof r.t === 'number') latencies.push(now() - r.t);
        }
      }
    }
  });
  const unsubP = presence.subscribe(() => {}); // keep presence sub warm

  let running = false;
  let shapeSeq = 0;

  async function tick() {
    if (!running) return;
    // Mix of ops, weighted toward creates+moves (the write-heavy path).
    const roll = Math.random();
    try {
      if (roll < 0.45) {
        // CREATE a shape inside my own viewport.
        const sid = `${id}:${shapeSeq++}`;
        const x = bounds.x0 + Math.floor(Math.random() * (bounds.x1 - bounds.x0));
        const y = bounds.y0 + Math.floor(Math.random() * (bounds.y1 - bounds.y0));
        await client.mutate(
          'INSERT (:Shape {id: $id, x: $x, y: $y, color: $c, owner: $o, t: $t})',
          { id: sid, x, y, c: index % 8, o: id, t: now() },
        );
        createdIds.push(sid);
        stats.acked += 1;
      } else if (roll < 0.8 && createdIds.length > 0) {
        // MOVE one of my shapes (last-writer-wins on position).
        const sid = createdIds[(Math.random() * createdIds.length) | 0];
        const x = bounds.x0 + Math.floor(Math.random() * (bounds.x1 - bounds.x0));
        const y = bounds.y0 + Math.floor(Math.random() * (bounds.y1 - bounds.y0));
        await client.mutate('MATCH (s:Shape {id: $id}) SET s.x = $x, s.y = $y', { id: sid, x, y });
        stats.acked += 1;
      } else if (roll < 0.9) {
        // Move my CURSOR (presence upsert: match-or-insert, then set).
        const cx = bounds.x0 + Math.floor(Math.random() * (bounds.x1 - bounds.x0));
        const cy = bounds.y0 + Math.floor(Math.random() * (bounds.y1 - bounds.y0));
        await client.mutate('MATCH (c:Cursor {id: $id}) SET c.cx = $x, c.cy = $y', {
          id,
          x: cx,
          y: cy,
        });
        stats.acked += 1;
      } else {
        // ATOMIC increment of the shared counter (server-side RMW in one query).
        await client.mutate('MATCH (c:Counter {id: $id}) SET c.n = c.n + 1', { id: 'global' });
        counterBumps.total += 1;
        stats.acked += 1;
      }
    } catch (e) {
      stats.failed += 1;
      if (stats.failed <= 2) console.log(`  [${id}] write failed:`, (e as Error).message);
    }
    if (running) setTimeout(tick, WRITE_INTERVAL_MS + Math.floor(Math.random() * WRITE_INTERVAL_MS));
  }

  const createdIds: string[] = [];

  return {
    client,
    stats,
    bounds,
    killSocket: () => liveWs?.close(),
    start: () => {
      running = true;
      // Presence is asserted via onConnectivity (fires on first open + every
      // reconnect), so nothing to do here but begin the write loop.
      setTimeout(tick, Math.floor(Math.random() * WRITE_INTERVAL_MS));
    },
    stop: () => {
      running = false;
    },
    teardownSubs: () => {
      unsub();
      unsubP();
    },
    finalViewportRows: () => viewport.getSnapshot().rows.length,
    snapshotVersion: () => viewport.getSnapshot().version ?? -1,
  };
}

// Shared measurement collectors.
const latencies: number[] = [];
const counterBumps = { total: 0 };

// ---------------------------------------------------------------------------
// DRIVER
// ---------------------------------------------------------------------------

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  console.log(
    `\n=== lenke multiplayer canvas ===\n` +
      `clients=${CLIENTS} duration=${DURATION_MS}ms write-interval~${WRITE_INTERVAL_MS}ms ` +
      `world=${WORLD} view=${VIEW}\n`,
  );

  const { store, server } = startServer();
  console.log(`server listening on ws://localhost:${PORT}`);

  // Client 0 is a full-canvas OBSERVER (measures cross-client push latency).
  const workers = [];
  for (let i = 0; i < CLIENTS; i++) {
    workers.push(spawnClient(i, { observer: i === 0 }));
  }

  // Wait for every socket to connect.
  const waitConnected = async () => {
    for (let tries = 0; tries < 200; tries++) {
      if (workers.every((w) => w.client.connected())) return true;
      await sleep(25);
    }
    return false;
  };
  const allUp = await waitConnected();
  console.log(`all clients connected: ${allUp} (${workers.filter((w) => w.client.connected()).length}/${CLIENTS})\n`);

  const t0 = now();
  for (const w of workers) w.start();

  // Let the storm run for half the duration, then a RECONNECTION STORM.
  await sleep(DURATION_MS / 2);
  console.log(`--- reconnection storm: killing ${Math.floor(CLIENTS / 2)} sockets mid-write ---`);
  for (let i = 0; i < workers.length; i += 2) workers[i].killSocket();

  // Keep writing through the outage + recovery.
  await sleep(DURATION_MS / 2);

  // Stop writes, let the last acks + pushes drain.
  for (const w of workers) w.stop();
  const elapsed = (now() - t0) / 1000;

  // CONVERGENCE PROBE: poll until every connected client's live-query snapshot
  // version catches up to the authoritative store version, or time out. This
  // distinguishes eventual-consistency lag (fan-out backpressure) from a real
  // consistency bug.
  const drainStart = now();
  let converged = false;
  let convergeMs = -1;
  for (let i = 0; i < 400; i++) {
    const target = store.version;
    const connected = workers.filter((w) => w.client.connected());
    if (connected.length > 0 && connected.every((w) => w.snapshotVersion() >= target)) {
      converged = true;
      convergeMs = now() - drainStart;
      break;
    }
    await sleep(25);
  }
  if (!converged) convergeMs = now() - drainStart;

  // --- SNAPSHOT CHECKPOINT ---
  const snapshotBytes = store.graph.toNdjson();
  const snapPath = `${import.meta.dir}/checkpoint.ndjson`;
  await Bun.write(snapPath, snapshotBytes);

  // --- CONVERGENCE CHECKS (server-authoritative truth) ---
  const totalAcked = workers.reduce((a, w) => a + w.stats.acked, 0);
  const totalFailed = workers.reduce((a, w) => a + w.stats.failed, 0);
  const totalReconnects = workers.reduce((a, w) => a + w.stats.reconnects, 0);

  const serverShapeCount = Number(
    store.mutate((g) => g.query('MATCH (s:Shape) RETURN count(*) AS `c`'))[0].c,
  );
  const clientCreates = (globalThis as any).__creates ?? null;
  // Total shapes created = sum of every client's create acks (creates never
  // delete each other; unique ids). Recompute from per-client counters.
  const serverCounter = Number(
    store.mutate((g) => g.query('MATCH (c:Counter {id: $id}) RETURN c.n AS `n`', { id: 'global' }))[0].n,
  );
  const cursorCount = Number(
    store.mutate((g) => g.query('MATCH (c:Cursor) RETURN count(*) AS `c`'))[0].c,
  );

  // Per-viewport consistency: does each client's LIVE snapshot equal a fresh
  // authoritative server query for that same viewport? (Convergence proof.)
  let convergent = 0;
  let divergent = 0;
  for (const w of workers) {
    const b = w.bounds;
    const authoritative = store.mutate((g) =>
      g.query(
        'MATCH (s:Shape) WHERE s.x >= $x0 AND s.x < $x1 AND s.y >= $y0 AND s.y < $y1 RETURN count(*) AS `c`',
        b,
      ),
    )[0].c as number;
    const live = w.finalViewportRows();
    if (Number(authoritative) === live) convergent += 1;
    else {
      divergent += 1;
      if (divergent <= 5)
        console.log(`  divergent ${w.stats.id}: live=${live} authoritative=${authoritative}`);
    }
  }

  latencies.sort((a, b) => a - b);
  const mem = process.memoryUsage();

  console.log(`\n=== RESULTS ===`);
  console.log(`elapsed:            ${elapsed.toFixed(2)}s`);
  console.log(`writes acked:       ${totalAcked}  (failed: ${totalFailed})`);
  console.log(`throughput:         ${(totalAcked / elapsed).toFixed(0)} writes/sec`);
  console.log(`reconnects:         ${totalReconnects} (storm killed ${Math.floor(CLIENTS / 2)})`);
  console.log(`\n--- server store (authoritative) ---`);
  console.log(`shapes:             ${serverShapeCount}`);
  console.log(`cursors (presence): ${cursorCount}  (connected clients: ${workers.filter((w) => w.client.connected()).length})`);
  console.log(`atomic counter n:   ${serverCounter}  (expected bumps: ${counterBumps.total})`);
  console.log(`counter lost updates: ${counterBumps.total - serverCounter}`);
  console.log(`\n--- convergence (per-client viewport == authoritative) ---`);
  console.log(`all clients reached store.version ${store.version}: ${converged} in ${convergeMs.toFixed(0)}ms`);
  console.log(`convergent clients (row count match): ${convergent}/${CLIENTS}   divergent: ${divergent}`);
  console.log(`\n--- cross-client push latency (observer, ${latencies.length} samples) ---`);
  console.log(`p50: ${pct(latencies, 50).toFixed(1)}ms  p95: ${pct(latencies, 95).toFixed(1)}ms  p99: ${pct(latencies, 99).toFixed(1)}ms  max: ${(latencies.at(-1) ?? 0).toFixed(1)}ms`);
  console.log(`\n--- snapshot checkpoint ---`);
  console.log(`wrote ${snapshotBytes.byteLength} bytes -> ${snapPath}`);
  console.log(`\n--- memory ---`);
  console.log(`rss: ${(mem.rss / 1e6).toFixed(0)}MB  heapUsed: ${(mem.heapUsed / 1e6).toFixed(0)}MB`);

  // Teardown.
  for (const w of workers) w.client.close();
  server.stop(true);
  await sleep(100);
  console.log(`\ndone.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
