import type { Graph } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { Codec } from '../codec.js';
import { type ChunkSource, linesFromChunks } from '../streaming.js';
import { normalizeBag, type PropertyValue } from '../value.js';

/**
 * **NDJSON** (newline-delimited JSON) — one element per line, each a JSON object
 * tagged with `type`. The streaming-native JSON format: it round-trips the full
 * LPG value model like PG-JSON (JSON natively carries string/number/boolean/
 * null/list, and edges keep their id), but because each element is its own line
 * it streams incrementally — unlike a single JSON document, which can't be
 * `JSON.parse`d from a stream.
 *
 *   {"type":"node","id":"n0","labels":["Person"],"properties":{"name":"marko"}}
 *   {"type":"edge","id":"e0","from":"n0","to":"n1","labels":["CREATED"],"properties":{"weight":0.4}}
 *
 * Node and edge ids are preserved; an edge endpoint not declared as its own node
 * line is created as a bare node. Property values pass through `normalizeBag` at
 * the boundary (see `value.ts`). No lossiness within the LPG model.
 */

type NodeRecord = {
  type: 'node';
  id: string;
  labels: string[];
  properties: Record<string, PropertyValue>;
};
type EdgeRecord = {
  type: 'edge';
  id: string;
  from: string;
  to: string;
  labels: string[];
  properties: Record<string, PropertyValue>;
};

type VertexLike = { id: string; labels: Iterable<string>; properties: Record<string, unknown> };
type EdgeLike = VertexLike & { from: { id: string }; to: { id: string } };

const nodeLine = (vertex: VertexLike): string =>
  JSON.stringify({
    type: 'node',
    id: vertex.id,
    labels: [...vertex.labels],
    properties: normalizeBag(vertex.properties),
  });

const edgeLine = (edge: EdgeLike): string =>
  JSON.stringify({
    type: 'edge',
    id: edge.id,
    from: edge.from.id,
    to: edge.to.id,
    labels: [...edge.labels],
    properties: normalizeBag(edge.properties),
  });

/** Serialize a graph to NDJSON: a node line per vertex, then an edge line per edge. */
export const encode = (graph: Graph): string => {
  const lines: string[] = [];

  for (const vertex of graph.vertices) {
    lines.push(nodeLine(vertex));
  }

  for (const edge of graph.edges) {
    lines.push(edgeLine(edge));
  }

  return lines.join('\n');
};

/** Parse one NDJSON line into a record, or `null` for a blank line. */
const parseLine = (line: string): NodeRecord | EdgeRecord | null => {
  const trimmed = line.trim();

  if (trimmed === '') {
    return null;
  }

  let record: unknown;

  try {
    record = JSON.parse(trimmed);
  } catch (cause) {
    throw new PlGraphError(`ndjson: invalid JSON: ${trimmed.slice(0, 80)}`, {
      code: ErrorCode.InvalidJson,
      cause,
    });
  }

  if (typeof record !== 'object' || record === null) {
    throw new PlGraphError(
      `ndjson: each line must be a node or edge object: ${trimmed.slice(0, 80)}`,
      {
        code: ErrorCode.InvalidShape,
      },
    );
  }

  const { type } = record as { type?: unknown };

  if (type !== 'node' && type !== 'edge') {
    throw new PlGraphError(
      `ndjson: line is not a 'node' or 'edge' record: ${trimmed.slice(0, 80)}`,
      {
        code: ErrorCode.InvalidShape,
      },
    );
  }

  return record as NodeRecord | EdgeRecord;
};

const addNode = (graph: Graph, record: NodeRecord): void => {
  graph.addVertex({
    id: String(record.id),
    labels: record.labels ?? [],
    properties: normalizeBag(record.properties ?? {}),
  });
};

const ensureVertex = (graph: Graph, id: string) =>
  graph.getVertexById(id) ?? graph.addVertex({ id, labels: [], properties: {} });

const addEdge = (graph: Graph, record: EdgeRecord): void => {
  const from = ensureVertex(graph, String(record.from));
  const to = ensureVertex(graph, String(record.to));
  graph.addEdge({
    id: record.id != null ? String(record.id) : undefined,
    from,
    to,
    labels: record.labels ?? [],
    properties: normalizeBag(record.properties ?? {}),
  });
};

const apply = (graph: Graph, record: NodeRecord | EdgeRecord): void => {
  if (record.type === 'node') {
    addNode(graph, record);
  } else {
    addEdge(graph, record);
  }
};

/**
 * Deserialize an NDJSON string into `graph`. Two passes — nodes first, then
 * edges — so records may appear in any order; an edge endpoint without its own
 * node line is created bare.
 */
export const decode = (input: string, graph: Graph): Graph => {
  const wasEnabled = graph.eventsEnabled();

  if (wasEnabled) {
    graph.disableEvents();
  }

  const nodes: NodeRecord[] = [];
  const edges: EdgeRecord[] = [];

  for (const line of input.split('\n')) {
    const record = parseLine(line);

    if (record?.type === 'node') {
      nodes.push(record);
    } else if (record?.type === 'edge') {
      edges.push(record);
    }
  }

  for (const record of nodes) {
    addNode(graph, record);
  }

  for (const record of edges) {
    addEdge(graph, record);
  }

  if (wasEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

/** Stream the document in batched line chunks, without building the whole string. */
export async function* encodeStream(graph: Graph): AsyncGenerator<string> {
  const batchSize = 1024;
  let batch: string[] = [];

  for (const vertex of graph.vertices) {
    batch.push(nodeLine(vertex));

    if (batch.length >= batchSize) {
      yield `${batch.join('\n')}\n`;
      batch = [];
    }
  }

  for (const edge of graph.edges) {
    batch.push(edgeLine(edge));

    if (batch.length >= batchSize) {
      yield `${batch.join('\n')}\n`;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield `${batch.join('\n')}\n`;
  }
}

/**
 * Slurp a large graph from a chunk source one line at a time (memory bounded by
 * the longest line). Single pass, so — unlike `decode` — node records must
 * precede the edges that reference them (which `encodeStream` guarantees); an
 * as-yet-unseen endpoint is created as a bare node.
 */
export const decodeStream = async (source: ChunkSource, graph: Graph): Promise<Graph> => {
  const wasEnabled = graph.eventsEnabled();

  if (wasEnabled) {
    graph.disableEvents();
  }

  for await (const line of linesFromChunks(source)) {
    const record = parseLine(line);

    if (record) {
      apply(graph, record);
    }
  }

  if (wasEnabled) {
    graph.enableEvents();
    graph.snapshot();
  }

  return graph;
};

export const ndjsonCodec: Codec = { name: 'ndjson', encode, decode, encodeStream, decodeStream };
