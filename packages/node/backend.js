// Adapter: expose the napi `Graph` class as the shared `Backend` contract from
// `@lenke/native`. The contract is handle-based (an opaque numeric token), while
// the addon hands back live `Graph` objects — so we keep a small id→object
// registry and let napi's GC reclaim a graph once its handle is dropped. The
// per-call Map lookup is nanoseconds against query compute; the doc's own
// measurements put the compute-to-transfer ratio around 2000:1.
import { Graph, abiVersion } from './index.js';

// The facade passes Uint8Array; the addon wants a Node Buffer. Wrap (no copy)
// rather than reallocate when we already hold a Uint8Array view.
const asBuffer = (u8) =>
  Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

/** @returns {import('@lenke/native').Backend} */
export function createNodeBackend() {
  /** @type {Map<number, InstanceType<typeof Graph>>} */
  const registry = new Map();
  let nextHandle = 1;

  const put = (graph) => {
    const handle = nextHandle++;
    registry.set(handle, graph);

    return handle;
  };
  const get = (handle) => {
    const graph = registry.get(handle);

    if (graph === undefined) {
      throw new Error(`lenke: invalid graph handle ${handle}`);
    }

    return graph;
  };

  return {
    abiVersion: abiVersion(),

    graphFromNdjson: (bytes, parallel) => put(Graph.fromNdjson(asBuffer(bytes), parallel)),
    // Drop the reference; the underlying lenke-core graph is freed when napi GCs
    // the object. No explicit native free to call.
    graphFree: (handle) => {
      registry.delete(handle);
    },

    vertexCount: (handle) => get(handle).vertexCount,
    edgeCount: (handle) => get(handle).edgeCount,
    version: (handle) => get(handle).version(),
    epoch: (handle, name) => get(handle).epoch(name),

    // `params` arrives pre-serialized (a flat JSON object of $name bindings)
    // per the Backend contract; the addon decodes it crate-side.
    queryRows: (handle, query, params) => get(handle).query(query, params),
    queryArrow: (handle, query, params) => get(handle).queryArrow(query, params),
    gremlinJson: (handle, query) => get(handle).gremlin(query),

    encodeNdjson: (handle) => get(handle).encodeNdjson(),
    serialize: (handle, format) => get(handle).serialize(format),
    deserialize: (bytes, format) => put(Graph.deserialize(asBuffer(bytes), format)),
  };
}
