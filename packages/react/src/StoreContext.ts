import * as React from 'react';

/** A live-query result row — a column-name → value record (mirrors `@lenke/native`'s `Row`). */
export type Row = Record<string, unknown>;

/**
 * A live query handle — the `useSyncExternalStore`-shaped subset `useLiveQuery`
 * consumes: a stable `getSnapshot` (referentially stable until a relevant
 * mutation) and a `subscribe`.
 */
export type LiveQueryHandle<R extends Row = Row> = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => R[];
};

/**
 * The minimal reactive-store shape the native connector drives. Satisfied by
 * `@lenke/native`'s `Store` (from `createStore(graph)`) — declared
 * *structurally* rather than imported so this connector doesn't hard-depend on
 * `@lenke/native`: any value exposing `liveQuery` works, and the real native
 * `Store` matches by shape. (It also keeps the browser bundle free of the native
 * package's surface.)
 */
export type ReactiveStore = {
  liveQuery: <R extends Row = Row>(
    text: string,
    // Matches `@lenke/native`'s `Store.liveQuery`: `opts` is required and `deps`
    // is `string[] | null` (null = recompute-always). Declaring it optional here
    // made the canonical `<StoreProvider store={createStore(graph)}>` fail to
    // typecheck (the real store requires `opts`, so it wasn't assignable).
    opts: { deps: readonly string[] | null; params?: Record<string, unknown> },
  ) => LiveQueryHandle<R>;
};

/**
 * React context for the **wasm/native** connector — it holds a
 * {@link ReactiveStore} (e.g. `@lenke/native`'s `createStore(graph)`), the
 * reactive wrapper over a Rust-backed graph behind the FFI boundary.
 *
 * This is the parallel of {@link GraphContext}, which holds the in-process
 * TypeScript `Graph`. The two connectors are deliberately separate: a TS-`Graph`
 * selector is an arbitrary JS closure over a live object, whereas a native
 * "selector" is a query string that crosses the FFI boundary and returns
 * materialized rows — so they don't share a hook surface.
 *
 * There's no sensible default store (a store owns a live graph handle), so this
 * defaults to `null` and {@link useStore} throws a clear error when a hook is
 * used outside a {@link StoreProvider}.
 */
export const StoreContext = React.createContext<ReactiveStore | null>(null);
StoreContext.displayName = 'StoreContext';

/**
 * Read the {@link ReactiveStore} from context. Throws if there is no
 * {@link StoreProvider} ancestor — a missing provider is a wiring error, so it
 * fails loudly with an actionable message rather than silently doing nothing.
 */
export const useStore = (): ReactiveStore => {
  const store = React.useContext(StoreContext);

  if (!store) {
    throw new Error(
      'useStore (and useLiveQuery) must be used within a <StoreProvider>. ' +
        'Create a store with `createStore(graph)` from @lenke/native and pass it as <StoreProvider store={store}>.',
    );
  }

  return store;
};
