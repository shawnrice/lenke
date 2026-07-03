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

wss.on('connection', (ws) => {
  const host = createSyncHost(store, { send: (m) => ws.send(JSON.stringify(m)) });
  hosts.set(ws, host);

  ws.on('message', (raw) => {
    host.receive(JSON.parse(String(raw)));
  });
  ws.on('close', () => {
    host.close();
    hosts.delete(ws);
  });
});

console.log(`listening on ws://localhost:${PORT} (${hosts.size} connections)`);
