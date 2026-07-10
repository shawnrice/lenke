import { createStore, graphFromNdjson } from '@lenke/native';
import { createNodeBackend } from '@lenke/node/backend';
import { createSyncHost, type SyncHost } from '@lenke/sync';
// The authoritative server: the whole fleet in an embedded lenke store (the
// napi addon — the fast production Node path), one protocol host per
// WebSocket. Run: node server.ts   (Node 23+ type stripping; no build step)
//
// This is the doc's "server-embedded host" made concrete: the SAME
// createSyncHost that sits behind a Worker's postMessage serves sockets here —
// a WebSocket is structurally a port.
import { WebSocketServer, type WebSocket } from 'ws';

import { generateFleet } from './datagen.ts';

const PORT = Number(process.env.PORT ?? 8787);

const fleet = generateFleet();
const store = createStore(
  graphFromNdjson(createNodeBackend(), new TextEncoder().encode(fleet.ndjson)),
);

console.log(
  `service-map server: ${store.graph.vertexCount} services, ${store.graph.edgeCount} calls ` +
    `across ${fleet.clusters.join(', ')}`,
);

const wss = new WebSocketServer({ port: PORT });
const hosts = new Map<WebSocket, SyncHost>();

// Report the live connection count whenever it changes — the previous one-shot
// log printed `0` at boot and never updated, so it always looked like nobody
// was connected.
const reportConnections = (): void => {
  console.log(`  ${hosts.size} connection(s)`);
};

wss.on('connection', (ws) => {
  const host = createSyncHost(store, { send: (m) => ws.send(JSON.stringify(m)) });
  hosts.set(ws, host);
  reportConnections();

  ws.on('message', (raw) => {
    host.receive(JSON.parse(String(raw)));
  });
  ws.on('close', () => {
    host.close();
    hosts.delete(ws);
    reportConnections();
  });
  // An 'error' with no listener throws (EventEmitter semantics) and takes the
  // whole server down on any one socket's reset. 'close' follows 'error', so
  // the teardown above still runs.
  ws.on('error', () => ws.close());
});

console.log(`listening on ws://localhost:${PORT}`);
