import * as React from 'react';

import { type ReactiveStore, StoreContext } from './StoreContext.js';

type StoreProviderProps = { store: ReactiveStore; children: React.ReactNode };

/**
 * Provides a {@link ReactiveStore} (e.g. `@pl-graph/native`'s `createStore`) to
 * the wasm/native hooks below it — the parallel of {@link GraphProvider} for the
 * TypeScript `Graph`.
 */
export const StoreProvider = (props: StoreProviderProps): React.JSX.Element => {
  const { children, store } = props;

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
};

StoreProvider.displayName = 'StoreProvider';
