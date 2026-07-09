import type { Graph } from '@lenke/core';

export type LabelCount = {
  label: string;
  count: number;
};

export type GraphSummary = {
  vertices: number;
  edges: number;
  version: number;
  vertexLabels: LabelCount[];
  edgeLabels: LabelCount[];
  vertexIndexes: string[];
  edgeIndexes: string[];
};

const byCountDesc = (a: LabelCount, b: LabelCount): number =>
  b.count - a.count || a.label.localeCompare(b.label);

const labelCounts = (stat: Record<string, number>): LabelCount[] =>
  Object.entries(stat)
    .map(([label, count]) => ({ label, count }))
    .sort(byCountDesc);

/**
 * A structured snapshot of a graph's shape: element counts, per-label
 * breakdowns (most-populated first), the indexed property keys, and the current
 * version. The machine-readable half of the inspectors.
 */
export const describe = (graph: Graph): GraphSummary => {
  const { stats } = graph;

  return {
    vertices: graph.vertexCount,
    edges: graph.edgeCount,
    version: graph.version,
    vertexLabels: labelCounts(stats.vertices),
    edgeLabels: labelCounts(stats.edges),
    vertexIndexes: graph.vertexIndexes(),
    edgeIndexes: graph.edgeIndexes(),
  };
};

const indexes = (keys: readonly string[]): string => (keys.length ? keys.join(', ') : '(none)');

const section = (title: string, rows: readonly LabelCount[]): string[] => {
  if (rows.length === 0) {
    return [title, '  (none)'];
  }

  const width = Math.max(...rows.map((r) => r.label.length));

  return [title, ...rows.map((r) => `  ${r.label.padEnd(width)}  ${r.count}`)];
};

/**
 * `describe()` rendered for a human — a `console.log`-friendly summary:
 *
 * ```text
 * Graph — 240 vertices, 389 edges (version 12)
 *
 * Vertex labels
 *   Service  240
 *
 * Edge labels
 *   CALLS    389
 *
 * Indexes
 *   vertices: (none)
 *   edges:    (none)
 * ```
 */
export const formatGraph = (graph: Graph): string => {
  const summary = describe(graph);

  return [
    `Graph — ${summary.vertices} vertices, ${summary.edges} edges (version ${summary.version})`,
    '',
    ...section('Vertex labels', summary.vertexLabels),
    '',
    ...section('Edge labels', summary.edgeLabels),
    '',
    'Indexes',
    `  vertices: ${indexes(summary.vertexIndexes)}`,
    `  edges:    ${indexes(summary.edgeIndexes)}`,
  ].join('\n');
};
