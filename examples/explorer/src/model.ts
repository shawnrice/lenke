import type { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

// The render-facing shape: plain data extracted from a @lenke/core Graph.
export type GNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GEdge = { id: string; from: string; to: string; labels: string[] };
export type GraphModel = { nodes: GNode[]; edges: GEdge[] };

export const toModel = (graph: Graph): GraphModel => ({
  nodes: [...graph.vertices].map((v) => ({
    id: v.id,
    labels: [...v.labels],
    properties: v.properties,
  })),
  edges: [...graph.edges].map((e) => ({
    id: e.id,
    from: e.from.id,
    to: e.to.id,
    labels: [...e.labels],
  })),
});

// Run a GQL query and collect the vertex ids to highlight: any returned value
// that IS a vertex (a node object carries `.id`) or that equals a vertex id (so
// `RETURN p`, `RETURN element_id(p)`, and `RETURN p.id AS id` all light up the
// matched nodes). Property-only returns (`RETURN p.name`) highlight nothing —
// there's no node to point at.
export const highlightFromQuery = (graph: Graph, text: string): Set<string> => {
  const rows = query(graph, text);
  const valid = new Set([...graph.vertices].map((v) => v.id));
  const ids = new Set<string>();

  const consider = (value: unknown): void => {
    if (typeof value === 'string' && valid.has(value)) {
      ids.add(value);

      return;
    }

    if (value && typeof value === 'object' && 'id' in value) {
      const { id } = value as { id: unknown };

      if (typeof id === 'string' && valid.has(id)) {
        ids.add(id);
      }
    }
  };

  for (const row of rows) {
    for (const value of Object.values(row)) {
      consider(value);
    }
  }

  return ids;
};
