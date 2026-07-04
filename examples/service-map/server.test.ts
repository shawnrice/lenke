// Cross-runtime smoke: spawn the REAL Node server (napi addon + ws) and drive
// it with a protocol client over a genuine socket from Bun — subscribe,
// demand-style one-shots, an edit, a blast-radius chain query. This is the
// worker's server link exercised without a browser.
// Run: bun test examples/service-map/server.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createSyncClient, type SyncClient } from '@lenke/sync';

import { CLUSTERS, generateFleet } from './datagen.ts';

const ADDON_BUILT = existsSync(new URL('../../packages/node/index.js', import.meta.url).pathname);

if (!ADDON_BUILT) {
  console.warn('[server.test] skipping: @lenke/node not built — run `napi build` first.');
}

const suite = ADDON_BUILT ? describe : describe.skip;
const PORT = 8987;

suite('service-map · Node server over a real socket', () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let ws: WebSocket;
  let client: SyncClient;

  beforeAll(async () => {
    proc = Bun.spawn(['node', 'server.ts'], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Dial until the server answers (Node boot + graph decode take a moment).
    for (let i = 0; ; i += 1) {
      try {
        ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(`ws://localhost:${PORT}`);
          socket.onopen = () => resolve(socket);
          socket.onerror = () => reject(new Error('not up yet'));
        });
        break;
      } catch {
        if (i > 100) {
          throw new Error('server never came up');
        }

        await new Promise((r) => {
          setTimeout(r, 100);
        });
      }
    }

    client = createSyncClient({ send: (m) => ws.send(JSON.stringify(m)) });
    ws.onmessage = (e) => client.receive(JSON.parse(String(e.data)));
  });

  afterAll(() => {
    ws?.close();
    proc?.kill();
  });

  test('serves the generated fleet', async () => {
    const fleet = generateFleet();
    const rows = await client.query('MATCH (s:Service) RETURN s.sid');
    expect(rows).toHaveLength(fleet.services.length);
  });

  test('the loader queries answer per cluster', async () => {
    const services = await client.query(
      'MATCH (s:Service) WHERE s.cluster = $c RETURN s.sid, s.name, s.tier, s.status',
      { c: CLUSTERS[0] },
    );
    expect(services.length).toBeGreaterThan(30);

    const calls = await client.query(
      'MATCH (a:Service)-[t:CALLS]->(b:Service) WHERE a.cluster = $c RETURN t.cid, a.sid, b.sid',
      { c: CLUSTERS[0] },
    );
    expect(calls.length).toBeGreaterThan(30);
  });

  test('a standing query hears a mutate from the same socket', async () => {
    const live = client.liveQuery("MATCH (s:Service) WHERE s.status = 'down' RETURN s.sid", {
      deps: ['Service', 'status'],
    });
    const waiters: (() => void)[] = [];
    const stop = live.subscribe(() => waiters.splice(0).forEach((w) => w()));
    const next = () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      });

    await next(); // initial push
    expect(live.getSnapshot().rows).toHaveLength(0);

    const target = (await client.query('MATCH (s:Service) RETURN s.sid'))[0]['s.sid'];
    const changed = next();
    await client.mutate('MATCH (s:Service) WHERE s.sid = $sid SET s.status = $st', {
      sid: target,
      st: 'down',
    });
    await changed;
    expect(live.getSnapshot().rows).toEqual([{ 's.sid': target }]);
    stop();
  });

  test('the blast-radius traversal runs server-side', async () => {
    // Pick a data-tier service — things call INTO it.
    const [victim] = await client.query("MATCH (s:Service) WHERE s.tier = 'data' RETURN s.sid");
    // The whole upstream cone in one variable-length GQL query (`->{1,}`).
    const upstream = await client.query(
      'MATCH (a:Service)-[:CALLS]->{1,}(x:Service) WHERE x.sid = $sid RETURN DISTINCT a.sid',
      { sid: victim['s.sid'] },
    );
    expect(upstream.length).toBeGreaterThan(0);
  });
});
