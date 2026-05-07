import { Edge } from './Edge.js';
import { Vertex } from './Vertex.js';

/**
 * An element is either a vertex or an edge in a graph.
 */
export type Element = Vertex | Edge;

/**
 * Alias of `Element` to avoid clashing with the global HTMLElement.
 */
export type GraphElement = Element;

export const isElement = (x: unknown): x is Element => {
  return Vertex.isVertex(x) || Edge.isEdge(x);
};
