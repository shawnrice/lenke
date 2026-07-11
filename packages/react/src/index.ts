// The in-process TypeScript `Graph` connector.
export { useGraphContext } from './GraphContext.js';
export { GraphProvider } from './GraphProvider.js';
export { useGraphSelector } from './useGraphSelector.js';
export { useGraphSubscription } from './useGraphSubscription.js';
export { useGraphTraversal } from './useGraphTraversal.js';
export type { GraphState } from './GraphContext.js';

// The wasm/native connector — drive React from a `@lenke/native` Store
// (createStore(graph)) instead of the in-process Graph. These modules import no
// engine code (only React), so a store-only consumer tree-shakes the TS
// core/gremlin engines away (the package is marked `sideEffects: false`).
export { StoreProvider } from './StoreProvider.js';
export { type LiveQueryHandle, type ReactiveStore, type Row, useStore } from './StoreContext.js';
export { useLiveQuery } from './useLiveQuery.js';

// The sync-client connector — drive React from a `@lenke/sync` client
// (createSyncClient / createReconnectingClient) whose snapshot carries
// completeness, demand-fill, and offline behavior. Structural client shape, so
// this adds no `@lenke/sync` dependency.
export { SyncClientProvider } from './SyncClientProvider.js';
export {
  type ClientLiveQueryHandle,
  type ClientLiveQueryOptions,
  type ClientSnapshot,
  type SyncClientLike,
  useSyncClient,
} from './SyncClientContext.js';
export { useClientLiveQuery } from './useClientLiveQuery.js';
