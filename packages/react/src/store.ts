/**
 * `@pl-graph/react/store` — the **wasm/native** connector.
 *
 * Hooks for driving React from a `@pl-graph/native` {@link Store} (a reactive
 * wrapper over a Rust-backed graph behind the FFI boundary). This is the
 * parallel of the package's main entry (`@pl-graph/react`), which connects to
 * the in-process TypeScript `Graph`.
 *
 * Kept behind a subpath export so a consumer using only the TS `Graph` never
 * pulls in the `@pl-graph/native` types, and vice versa.
 *
 * @example
 * ```tsx
 * import { createStore, graphFromNdjson } from '@pl-graph/native';
 * import { createWasmBackend } from '@pl-graph/native/wasm';
 * import { StoreProvider, useLiveQuery } from '@pl-graph/react/store';
 *
 * const backend = await createWasmBackend(fetch('/pl_graph_core.wasm'));
 * const store = createStore(graphFromNdjson(backend, bytes));
 *
 * const App = () => (
 *   <StoreProvider store={store}>
 *     <People />
 *   </StoreProvider>
 * );
 *
 * const People = () => {
 *   const rows = useLiveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
 *   return <ul>{rows.map((r) => <li key={String(r['p.name'])}>{String(r['p.name'])}</li>)}</ul>;
 * };
 * ```
 */

export { StoreProvider } from './StoreProvider.js';
export { type LiveQueryHandle, type ReactiveStore, type Row, useStore } from './StoreContext.js';
export { useLiveQuery } from './useLiveQuery.js';
