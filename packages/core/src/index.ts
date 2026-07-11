export { Edge, Graph, isElement, PropertyIndex, Vertex } from './core/index.js';

export type {
  Element,
  GraphElement,
  GraphOptions,
  IndexableValue,
  RangeBound,
} from './core/index.js';
// The full graph-event surface: every per-event payload type (e.g.
// `VertexPropertyChanged`, `LabelAddedToVertex`), the `GraphEvents` map keyed by
// event name, the `GraphEvent` UNION of all payloads, and `GraphEventType`. (The
// old export mis-aliased the *map* as `GraphEvent` and omitted the payload
// types, so a typed reducer over the union wasn't writable.)
export type * from './core/GraphEvents.js';
