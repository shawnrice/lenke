import * as React from 'react';

import { type SyncClientLike, SyncClientContext } from './SyncClientContext.js';

type SyncClientProviderProps = { client: SyncClientLike; children: React.ReactNode };

/**
 * Provides a {@link SyncClientLike} (e.g. `@lenke/sync`'s `createSyncClient` /
 * `createReconnectingClient`) to the sync-client hooks below it — the parallel
 * of {@link StoreProvider} for the port/WebSocket connector.
 */
export const SyncClientProvider = (props: SyncClientProviderProps): React.JSX.Element => {
  const { children, client } = props;

  return <SyncClientContext.Provider value={client}>{children}</SyncClientContext.Provider>;
};

SyncClientProvider.displayName = 'SyncClientProvider';
