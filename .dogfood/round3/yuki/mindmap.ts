// Mind-map / org-chart domain model over the in-process @lenke/core Graph,
// plus the Gremlin layout traversals (ancestors / subtree / depth).
import { Graph, type Vertex } from '@lenke/core';
import { traversal, toArray, V, out, in_, repeat, dedupe, values, count } from '@lenke/gremlin';

export const NODE = 'Node';
export const CHILD = 'CHILD'; // parent -> child (tree edge)
export const LINK = 'LINK'; // cross-link edge (non-tree)

export type NodeShape = {
  title: string;
  kind: 'root' | 'topic' | 'task';
};

let nextId = 0;
const genId = (prefix: string) => `${prefix}-${nextId++}`;

/** Add a mind-map node. Returns the created Vertex. */
export function addNode(graph: Graph, shape: NodeShape, id = genId('n')): Vertex {
  return graph.addVertex({ id, labels: [NODE], properties: { ...shape } });
}

/** Connect parent -> child with a tree edge. */
export function addChild(graph: Graph, parent: Vertex, child: Vertex): void {
  graph.addEdge({ from: parent, to: child, labels: [CHILD], properties: {} });
}

/** A non-tree cross-link between two nodes (e.g. "relates to"). */
export function addLink(graph: Graph, from: Vertex, to: Vertex, note = ''): void {
  graph.addEdge({ from, to, labels: [LINK], properties: { note } });
}

// ---- Gremlin layout traversals -------------------------------------------

/** Direct + transitive descendants via CHILD edges (root excluded). */
export function subtreeTitles(graph: Graph, rootId: string): string[] {
  return toArray(
    traversal(V(rootId), repeat(out(CHILD)).emit(), dedupe(), values('title')),
    graph,
  ) as string[];
}

/** Ancestor chain (nearest -> furthest) via incoming CHILD edges. */
export function ancestorTitles(graph: Graph, nodeId: string): string[] {
  return toArray(
    traversal(V(nodeId), repeat(in_(CHILD)).emit(), dedupe(), values('title')),
    graph,
  ) as string[];
}

/** Depth = number of ancestors (root is depth 0). Computed with a count() terminal. */
export function depthOf(graph: Graph, nodeId: string): number {
  const [n] = toArray(
    traversal(V(nodeId), repeat(in_(CHILD)).emit(), dedupe(), count()),
    graph,
  ) as number[];
  return n ?? 0;
}
