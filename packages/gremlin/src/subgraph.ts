import { Graph, type Vertex } from '@pl-graph/core';

/**
 * The self-describing subgraph shape the native (Rust) gremlin engine emits for
 * a `subgraph(key).cap(key)` result (once parsed from JSON). The Rust `GVal`
 * model has no graph type, so it returns this record instead of a Graph;
 * {@link subgraphToGraph} rebuilds a real `Graph` from it, giving parity with the
 * TS engine — which returns a `Graph` directly.
 */
export type NativeSubgraph = {
  readonly vertices: ReadonlyArray<{
    readonly id: string;
    readonly labels: readonly string[];
    readonly properties: Record<string, unknown>;
  }>;
  readonly edges: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    /** Out-vertex (source) id. */
    readonly outV: string;
    /** In-vertex (target) id. */
    readonly inV: string;
    readonly properties: Record<string, unknown>;
  }>;
};

/**
 * Rebuild a `@pl-graph/core` `Graph` from a {@link NativeSubgraph} record.
 *
 * Vertices are added first so every edge's endpoints resolve; `addVertex` /
 * `addEdge` dedupe by id, so a record with repeats is harmless. An edge whose
 * endpoint is missing is skipped — that shouldn't happen, since a subgraph always
 * collects both endpoints of every edge.
 */
export const subgraphToGraph = (sub: NativeSubgraph): Graph => {
  const g = new Graph();
  for (const v of sub.vertices) {
    g.addVertex({
      id: v.id,
      labels: [...(v.labels ?? [])],
      properties: { ...(v.properties ?? {}) },
    });
  }
  for (const e of sub.edges) {
    const from: Vertex | null = g.getVertexById(e.outV);
    const to: Vertex | null = g.getVertexById(e.inV);
    if (!from || !to) {
      continue;
    }
    g.addEdge({ id: e.id, from, to, labels: [e.label], properties: { ...(e.properties ?? {}) } });
  }
  return g;
};
