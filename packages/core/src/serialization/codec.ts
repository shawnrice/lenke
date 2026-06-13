import type { Graph } from '../core/Graph.js';

/**
 * A serialization codec speaks the core `Graph` API directly — it never goes
 * through the GQL or Gremlin interfaces. `encode` reads `graph.vertices` /
 * `graph.edges` / element `properties`; `decode` rebuilds via `addVertex` /
 * `addEdge`. Codecs operate over the LPG `PropertyValue` model (see `value.ts`)
 * and must preserve element identity (node and edge ids) so that
 * `decode(encode(g))` reproduces `g`.
 *
 * Multi-part formats (e.g. CSV's nodes + edges) may expose a richer natural API
 * in addition to this single-string contract.
 */
export type Codec = {
  /** Short format name, e.g. `'pg-json'`, `'graphson'`, `'csv'`. */
  readonly name: string;
  /** Serialize a graph to a single string. */
  encode: (graph: Graph) => string;
  /** Deserialize into `graph` (mutating it) and return it. */
  decode: (input: string, graph: Graph) => Graph;
};
