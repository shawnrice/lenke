import type { Graph } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { Codec } from '../codec.js';
import { normalizeBag } from '../value.js';
import type { PropertyValue } from '../value.js';

/**
 * GraphSON v3.0 (Apache TinkerPop) codec for the `@pl-graph/core` LPG model.
 *
 * The whole graph is serialized as a single JSON document
 * `{ "vertices": [ <g:Vertex> ... ], "edges": [ <g:Edge> ... ] }`. This is a
 * clean whole-graph wrapper rather than TinkerPop's inline `outE`/`inE`
 * adjacency, but each element uses standard GraphSON v3 typed values of the
 * form `{ "@type": <type>, "@value": <value> }`.
 *
 * LPG ↔ GraphSON mapping and lossiness
 * ------------------------------------
 *   - **Single-value properties.** TinkerPop allows multi-properties and
 *     meta-properties; our LPG models exactly one value per key. We therefore
 *     emit each vertex property key as a *single-element* `g:VertexProperty`
 *     array, and read back only the first element. Documents that carry true
 *     multi-properties lose all but the first value on decode.
 *   - **Multi-label `::` convention.** GraphSON's `label` is a single string,
 *     but our vertices carry a `Set<string>` of labels. To preserve round-trip
 *     fidelity we join multiple labels with `::` (TinkerPop's multi-label
 *     convention) and split on decode; an empty label set encodes as `""` and
 *     decodes back to `[]`. Single-label graphs are therefore standard
 *     GraphSON; only multi/zero-label graphs use the convention.
 *   - **int/float inference.** JS has a single `number` type. We infer the
 *     GraphSON scalar type from the runtime value: `Number.isInteger(n)` →
 *     `g:Int64`, otherwise `g:Double`. A whole-valued float (e.g. `2.0`) thus
 *     round-trips through `g:Int64`; the LPG model does not distinguish the two.
 *   - **Ids** are strings in our model and are preserved exactly, wrapped as
 *     plain JSON strings.
 */

const VERTICES = 'vertices';
const EDGES = 'edges';

type Typed = { '@type': string; '@value': unknown };

/** Encode a single LPG scalar/list value as a GraphSON v3 typed value. */
const encodeValue = (value: PropertyValue): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { '@type': 'g:Int64', '@value': value }
      : { '@type': 'g:Double', '@value': value };
  }

  // Array → g:List of typed values.
  return { '@type': 'g:List', '@value': value.map(encodeValue) };
};

/** Decode a GraphSON v3 typed value (or plain JSON scalar) back to an LPG value. */
const decodeValue = (node: unknown): PropertyValue => {
  if (node === null || typeof node === 'string' || typeof node === 'boolean') {
    return node;
  }

  if (typeof node === 'number') {
    // A bare JSON number (untyped) — accept it as-is.
    return node;
  }

  const typed = node as Typed;

  switch (typed['@type']) {
    case 'g:Int64':
    case 'g:Int32':
    case 'g:Double':
    case 'g:Float':
      return typed['@value'] as number;
    case 'g:List':
      return (typed['@value'] as unknown[]).map(decodeValue);
    default:
      // Unknown wrapper: fall back to the raw @value, normalized loosely.
      return typed['@value'] as PropertyValue;
  }
};

const LABEL_SEP = '::';

/** Join an LPG label set into a GraphSON single-label string (`::` convention). */
const joinLabels = (labels: Iterable<string>): string => [...labels].join(LABEL_SEP);

/** Split a GraphSON label string back into an LPG label list. */
const splitLabels = (label: string): string[] => (label === '' ? [] : label.split(LABEL_SEP));

export const encode = (graph: Graph): string => {
  const vertices: unknown[] = [];

  for (const vertex of graph.vertices) {
    const bag = normalizeBag(vertex.properties);
    const properties: Record<string, unknown[]> = {};

    for (const key of Object.keys(bag)) {
      properties[key] = [
        {
          '@type': 'g:VertexProperty',
          '@value': {
            id: `${vertex.id}/${key}`,
            value: encodeValue(bag[key]),
            label: key,
          },
        },
      ];
    }

    vertices.push({
      '@type': 'g:Vertex',
      '@value': {
        id: vertex.id,
        label: joinLabels(vertex.labels),
        properties,
      },
    });
  }

  const edges: unknown[] = [];

  for (const edge of graph.edges) {
    const bag = normalizeBag(edge.properties);
    const properties: Record<string, unknown> = {};

    for (const key of Object.keys(bag)) {
      properties[key] = {
        '@type': 'g:Property',
        '@value': { key, value: encodeValue(bag[key]) },
      };
    }

    edges.push({
      '@type': 'g:Edge',
      '@value': {
        id: edge.id,
        label: joinLabels(edge.labels),
        inV: edge.to.id,
        outV: edge.from.id,
        properties,
      },
    });
  }

  return JSON.stringify({ [VERTICES]: vertices, [EDGES]: edges });
};

type VertexValue = {
  id: string;
  label: string;
  properties?: Record<string, Array<{ '@value': { value: unknown } }>>;
};

type EdgeValue = {
  id: string;
  label: string;
  inV: string;
  outV: string;
  properties?: Record<string, { '@value': { value: unknown } }>;
};

export const decode = (input: string, graph: Graph): Graph => {
  const doc = JSON.parse(input) as {
    vertices?: Array<{ '@value': VertexValue }>;
    edges?: Array<{ '@value': EdgeValue }>;
  };

  graph.disableEvents();

  for (const wrapper of doc.vertices ?? []) {
    const v = wrapper['@value'];
    const properties: Record<string, PropertyValue> = {};

    for (const key of Object.keys(v.properties ?? {})) {
      const entries = v.properties![key];
      // LPG is single-value: read only the first element of the array.
      const [first] = entries;

      if (first !== undefined) {
        properties[key] = decodeValue(first['@value'].value);
      }
    }

    graph.addVertex({ id: v.id, labels: splitLabels(v.label), properties });
  }

  for (const wrapper of doc.edges ?? []) {
    const e = wrapper['@value'];
    const from = graph.getVertexById(e.outV);
    const to = graph.getVertexById(e.inV);

    if (from === null || to === null) {
      throw new PlGraphError(
        `GraphSON edge ${e.id} references missing vertex (outV=${e.outV}, inV=${e.inV})`,
        {
          code: ErrorCode.MissingVertex,
          details: { id: e.id, outV: e.outV, inV: e.inV },
        },
      );
    }

    const properties: Record<string, PropertyValue> = {};

    for (const key of Object.keys(e.properties ?? {})) {
      properties[key] = decodeValue(e.properties![key]['@value'].value);
    }

    graph.addEdge({ id: e.id, from, to, labels: splitLabels(e.label), properties });
  }

  graph.enableEvents();

  return graph;
};

export const graphsonCodec: Codec = { name: 'graphson', encode, decode };
