import { normalizeBag } from '../value.js';

import type { Graph } from '../../core/Graph.js';
import type { Codec } from '../codec.js';
import type { PropertyValue } from '../value.js';

/**
 * PG-JSON codec for the core LPG model.
 *
 * Wire shape (https://pg-format.readthedocs.io):
 *   {
 *     "nodes": [{ "id", "labels": [...], "properties": { ... } }],
 *     "edges": [{ "id"?, "from", "to", "undirected", "labels": [...], "properties": { ... } }]
 *   }
 *
 * This codec speaks the core `Graph` API directly — it never touches the GQL or
 * Gremlin layers — and encodes exactly the shared `PropertyValue` model. Values
 * are normalized at the boundary via `normalizeBag` (see `value.ts` for the
 * single definition of property-value lossiness).
 *
 * ## Lossiness vs. the core LPG model
 *
 * - **Property values.** Round-trip is faithful for the LPG scalar set
 *   (`string | boolean | number | null`) and arrays thereof. Anything outside
 *   that set is coerced by `normalizeValue` *before* it reaches JSON
 *   (`undefined`/`NaN`/`±Infinity` → `null`, `bigint` → `number` with possible
 *   precision loss, non-scalar objects throw). PG-JSON itself adds no further
 *   property lossiness.
 * - **Ids.** The core model uses **string** ids. The PG-JSON spec permits
 *   numeric ids; on import they are coerced to strings (`101` → `"101"`), so a
 *   foreign document with numeric ids does not round-trip back to numbers. Our
 *   own `encode` always emits string ids, so our round-trips are exact.
 * - **Edge ids.** Edge `id` is optional in the spec. We always emit it so
 *   parallel edges (same from/to/label) stay distinct across a round-trip. When
 *   importing foreign PG-JSON whose edges omit `id`, we synthesize a **unique**
 *   id per edge (label-tagged, plus a running index) so parallel edges do not
 *   collapse into one.
 * - **Direction.** The core model is strictly **directed**. We always emit
 *   `undirected: false`. On import the `undirected` field is accepted and
 *   ignored — an `undirected: true` edge is materialized as a single directed
 *   `from → to` edge (the reverse direction is not synthesized).
 * - **Label order.** Labels are sets in the core model; list order in the
 *   document is not significant and is not guaranteed to be preserved.
 */

/** A node entry in a PG-JSON document. */
type PGNode = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, PropertyValue>>;
};

/** An edge entry in a PG-JSON document. `id` is optional per spec. */
type PGEdge = {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly undirected: boolean;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, PropertyValue>>;
};

/** A parsed PG-JSON document. */
export type PGFormat = {
  readonly nodes: readonly PGNode[];
  readonly edges: readonly PGEdge[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');

const isNodeShape = (value: unknown): boolean =>
  isObject(value) &&
  (typeof value.id === 'string' || typeof value.id === 'number') &&
  isStringArray(value.labels) &&
  isObject(value.properties);

const isEdgeShape = (value: unknown): boolean =>
  isObject(value) &&
  (typeof value.from === 'string' || typeof value.from === 'number') &&
  (typeof value.to === 'string' || typeof value.to === 'number') &&
  isStringArray(value.labels) &&
  isObject(value.properties) &&
  (value.id === undefined || typeof value.id === 'string' || typeof value.id === 'number');

/**
 * Structural type guard for the PG-JSON document shape. `edges` may be omitted
 * (treated as empty); `nodes` is required and must be an array of node shapes.
 */
export const isPGFormat = (value: unknown): value is PGFormat =>
  isObject(value) &&
  Array.isArray(value.nodes) &&
  value.nodes.every(isNodeShape) &&
  (value.edges === undefined || (Array.isArray(value.edges) && value.edges.every(isEdgeShape)));

/**
 * Serialize a graph to a PG-JSON string. Single pass over vertices and edges;
 * builds the document object and hands it to native `JSON.stringify`.
 */
export const encode = (graph: Graph, space?: string | number): string => {
  const nodes: PGNode[] = [];
  for (const vertex of graph.vertices) {
    nodes.push({
      id: vertex.id,
      labels: [...vertex.labels],
      properties: normalizeBag(vertex.properties),
    });
  }

  const edges: PGEdge[] = [];
  for (const edge of graph.edges) {
    edges.push({
      id: edge.id,
      from: edge.from.id,
      to: edge.to.id,
      undirected: false,
      labels: [...edge.labels],
      properties: normalizeBag(edge.properties),
    });
  }

  return JSON.stringify({ nodes, edges }, null, space);
};

/**
 * Deserialize a PG-JSON string into `graph` (mutating it) and return it. Throws
 * on malformed JSON, a non-conforming document shape, or an edge referencing a
 * vertex id absent from `nodes`.
 */
export const decode = (input: string, graph: Graph): Graph => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    throw new Error('pg-json: input is not valid JSON', { cause });
  }

  if (!isPGFormat(parsed)) {
    throw new Error(
      'pg-json: input does not match the PG-JSON shape ' +
        '({ nodes: [{ id, labels, properties }], edges?: [...] })',
    );
  }

  const { nodes, edges = [] } = parsed;

  const eventsEnabled = graph.eventsEnabled();
  if (eventsEnabled) {
    graph.disableEvents();
  }

  for (const node of nodes) {
    graph.addVertex({
      id: String(node.id),
      labels: [...node.labels],
      properties: normalizeBag(node.properties),
    });
  }

  edges.forEach((edge, index) => {
    const fromId = String(edge.from);
    const toId = String(edge.to);
    const from = graph.getVertexById(fromId);
    const to = graph.getVertexById(toId);

    if (!from || !to) {
      throw new Error(
        `pg-json: edge references a non-existent vertex (from=${fromId}, to=${toId})`,
      );
    }

    // Preserve our own ids on round-trip. For foreign documents that omit `id`,
    // synthesize a unique id — the running index keeps parallel edges (same
    // from/to/label) distinct instead of collapsing into one.
    const id =
      edge.id === undefined
        ? `${fromId}-[${edge.labels.join(',')}]->${toId}#${index}`
        : String(edge.id);

    graph.addEdge({
      id,
      from,
      to,
      labels: [...edge.labels],
      properties: normalizeBag(edge.properties),
    });
  });

  if (eventsEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

export const pgJsonCodec: Codec = { name: 'pg-json', encode, decode };
