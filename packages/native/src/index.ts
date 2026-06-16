/**
 * `@pl-graph/native` — the Rust columnar core, callable from JS/TS.
 *
 * One C ABI, two backends behind a single {@link Backend} contract. The
 * backends live behind subpath exports so that loading this package in a
 * browser never pulls in the Bun-only `bun:ffi` builtin:
 *   - `@pl-graph/native/ffi` → `createFfiBackend` loads the native dynamic
 *     library over `bun:ffi` (server / CLI), and
 *   - `@pl-graph/native/wasm` → `createWasmBackend` instantiates the wasm
 *     artifact (browser).
 *
 * This entry is environment-neutral: shared types plus the engine-neutral
 * {@link RustGraph} facade — GQL via `query`, Gremlin via `gremlin`, both with
 * the same tagged-template ergonomics as `@pl-graph/gql`.
 *
 * @example bun / server
 * ```ts
 * import { createFfiBackend } from '@pl-graph/native/ffi';
 * import { graphFromNdjson } from '@pl-graph/native';
 * const backend = createFfiBackend('/path/to/libpl_graph_core.dylib');
 * const g = graphFromNdjson(backend, await Bun.file('graph.ndjson').bytes());
 * g.query`MATCH (a:Person) RETURN a.name`;
 * ```
 *
 * @example browser
 * ```ts
 * import { createWasmBackend } from '@pl-graph/native/wasm';
 * import { graphFromNdjson } from '@pl-graph/native';
 * const backend = await createWasmBackend(fetch('/pl_graph_core.wasm'));
 * const g = graphFromNdjson(backend, ndjsonBytes);
 * ```
 */

export { ABI_VERSION } from './abi.js';
export type { Backend, GraphHandle } from './backend.js';
export {
  attachGraph,
  graphFromFormat,
  graphFromNdjson,
  type RustGraph,
  type Row,
} from './graph.js';
export { createStore, inferDeps, type Store, type LiveQuery } from './store.js';

/** True when running under Bun, where the native FFI backend is available. */
export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
