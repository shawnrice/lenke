/**
 * `@lenke/sync` — the lenke sync engine's wire protocol and live-query host.
 *
 * v1 covers the doc's build-order steps 1–2 for the server side: the ~6-message
 * protocol as a structural contract ({@link ClientMessage} / {@link HostMessage})
 * and {@link createSyncHost}, the transport-agnostic host that serves standing
 * queries over any port-shaped channel (Worker `postMessage`, WebSocket, an
 * in-memory pair in tests). The sync *loop* (hydrate, demand-fill loaders,
 * write-back, OPFS persistence) layers on next.
 */

export {
  createSyncClient,
  type ClientLiveQuery,
  type ClientSnapshot,
  type SyncClient,
  type SyncClientOptions,
} from './client.js';
export { createSyncHost, type SyncHost, type SyncHostOptions } from './host.js';
export {
  isClientMessage,
  isHostMessage,
  type AckMessage,
  type ClientMessage,
  type HostMessage,
  type MutateMessage,
  type QueryMessage,
  type ResultMessage,
  type RowsMessage,
  type StatusMessage,
  type SubscribeMessage,
  type SyncMessage,
  type UnsubscribeMessage,
  type WireError,
} from './protocol.js';
