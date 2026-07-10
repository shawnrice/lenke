import { styleFor, type ColorOption } from './color.js';

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
  /** Indexed property keys, or `null` when the backend can't report them (the native/wasm store). */
  vertexIndexes: string[] | null;
  edgeIndexes: string[] | null;
};

// Structural shapes, so @lenke/inspect needn't depend on @lenke/core or
// @lenke/native: the pure-TS `Graph` exposes `stats` + index introspection; the
// native/wasm store exposes neither but can `query` itself; a `Store` wraps a
// queryable `graph`. Any of the three works.
type Counts = {
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly version: number;
};
type StatsGraph = Counts & {
  readonly stats: Record<'vertices' | 'edges', Record<string, number>>;
  vertexIndexes: () => readonly string[];
  edgeIndexes: () => readonly string[];
};
type QueryGraph = Counts & {
  query: (text: string) => ReadonlyArray<Record<string, unknown>>;
};
type StoreLike = { readonly graph: QueryGraph };

export type Inspectable = StatsGraph | QueryGraph | StoreLike;

const isStore = (input: Inspectable): input is StoreLike =>
  'graph' in input && typeof input.graph === 'object';

const isStats = (graph: StatsGraph | QueryGraph): graph is StatsGraph => 'stats' in graph;

const byCountDesc = (a: LabelCount, b: LabelCount): number =>
  b.count - a.count || a.label.localeCompare(b.label);

const labelCounts = (stat: Record<string, number>): LabelCount[] =>
  Object.entries(stat)
    .map(([label, count]) => ({ label, count }))
    .sort(byCountDesc);

// A label/type column value → the list of names it contributes: a `labels(n)`
// list as-is, a single `type(r)` string wrapped, a null/absent value nothing.
const asNames = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (value == null) {
    return [];
  }

  return [value];
};

// Tally a label/type column returned by the fallback queries (a vertex can carry
// several labels; an edge has exactly one type).
const tally = (
  rows: ReadonlyArray<Record<string, unknown>>,
  key: string,
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    for (const label of asNames(row[key])) {
      const name = String(label);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }

  return counts;
};

/**
 * A structured snapshot of a graph's shape: element counts, per-label
 * breakdowns (most-populated first), the indexed property keys (`null` on a
 * backend that can't report them), and the current version. Accepts the pure-TS
 * `Graph`, a native/wasm `RustGraph`, or a `Store`.
 */
export const describe = (input: Inspectable): GraphSummary => {
  const graph = isStore(input) ? input.graph : input;

  if (isStats(graph)) {
    return {
      vertices: graph.vertexCount,
      edges: graph.edgeCount,
      version: graph.version,
      vertexLabels: labelCounts(graph.stats.vertices),
      edgeLabels: labelCounts(graph.stats.edges),
      vertexIndexes: [...graph.vertexIndexes()],
      edgeIndexes: [...graph.edgeIndexes()],
    };
  }

  // Native/wasm store: no `stats`, so tally labels with two GQL queries the store
  // runs itself — `labels(n)` / `type(r)` are the same engine either way.
  return {
    vertices: graph.vertexCount,
    edges: graph.edgeCount,
    version: graph.version,
    vertexLabels: labelCounts(tally(graph.query('MATCH (n) RETURN labels(n) AS labels'), 'labels')),
    edgeLabels: labelCounts(tally(graph.query('MATCH ()-[r]->() RETURN type(r) AS type'), 'type')),
    vertexIndexes: null,
    edgeIndexes: null,
  };
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
export const formatGraph = (input: Inspectable, options: ColorOption = {}): string => {
  const style = styleFor(options.color);
  const summary = describe(input);

  const section = (title: string, rows: readonly LabelCount[]): string[] => {
    if (rows.length === 0) {
      return [style.bold(title), style.dim('  (none)')];
    }

    const width = Math.max(...rows.map((r) => r.label.length));

    return [
      style.bold(title),
      ...rows.map((r) => `  ${style.cyan(r.label.padEnd(width))}  ${r.count}`),
    ];
  };

  const indexes = (keys: string[] | null): string => {
    if (keys === null) {
      return style.dim('(not introspectable on this backend)');
    }

    return keys.length ? keys.join(', ') : style.dim('(none)');
  };

  return [
    style.bold(
      `Graph — ${summary.vertices} vertices, ${summary.edges} edges (version ${summary.version})`,
    ),
    '',
    ...section('Vertex labels', summary.vertexLabels),
    '',
    ...section('Edge labels', summary.edgeLabels),
    '',
    style.bold('Indexes'),
    `  vertices: ${indexes(summary.vertexIndexes)}`,
    `  edges:    ${indexes(summary.edgeIndexes)}`,
  ].join('\n');
};
