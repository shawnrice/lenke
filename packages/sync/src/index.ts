/**
 * `@lenke/sync` — the lenke sync engine: wire protocol, hosts, client, loop.
 *
 * - {@link createSyncHost} — serves standing queries over any port-shaped
 *   channel (Worker `postMessage`, WebSocket; one host per connection).
 * - {@link createSyncClient} — the client registry the UI consumes
 *   (dedupe, refcounts, stable `useSyncExternalStore`-ready snapshots).
 * - {@link createReconnectingClient} — the same client with connection
 *   lifecycle: re-dial with back-off, re-subscribe on reconnect, park writes
 *   while offline (durability still belongs to the engine's write-back queue).
 * - {@link createSyncEngine} — the sync loop between store and network:
 *   per-collection completeness, demand-fill loaders, push ingestion, and the
 *   optimistic write-back queue. `engine.createHost()` wires a host into it.
 *
 * Persistence (OPFS snapshot + encryption) is the next layer; the engine is
 * deliberately persistence-agnostic (hydrate the store before building it).
 */

export {
  createSyncClient,
  type ClientLiveQuery,
  type ClientSnapshot,
  type SyncClient,
  type SyncClientOptions,
} from './client.js';
export {
  createSyncEngine,
  type CollectionDefinition,
  type CollectionScope,
  type CollectionState,
  type SyncWrite,
  type SyncEngine,
  type SyncEngineOptions,
} from './engine.js';
export { createSyncHost, type SyncHost, type SyncHostOptions } from './host.js';
// Re-exported so wire consumers can build safe Gremlin traversal strings (for
// `client.gremlin` / a `lang: 'gremlin'` live query) without importing native.
export { escapeGremlin, gremlin } from '@lenke/native';
export {
  createReconnectingClient,
  type ReconnectingClient,
  type ReconnectingClientOptions,
  type ReconnectingConnect,
  type ReconnectingConnection,
} from './reconnect.js';
export {
  decodeSnapshot,
  encodeSnapshot,
  importSnapshotKey,
  memorySnapshotStorage,
  opfsStorage,
  peekHeader,
  readSnapshot,
  type Snapshot,
  type SnapshotExpectation,
  type SnapshotHeader,
  type SnapshotStorage,
} from './snapshot.js';
export {
  isClientMessage,
  isHostMessage,
  type AckMessage,
  type ClientMessage,
  type HostMessage,
  type MutateMessage,
  type QueryMessage,
  type ResultMessage,
  type RowPatch,
  type RowsMessage,
  type StatusMessage,
  type SubscribeMessage,
  type SyncMessage,
  type UnsubscribeMessage,
  type WireError,
} from './protocol.js';
