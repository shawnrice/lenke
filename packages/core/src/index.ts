export { Edge, Graph, isElement, Vertex } from './core/index.js';

export type {
  EdgeAddedEvent,
  EdgeRemovedEvent,
  Element,
  GraphElement,
  GraphEvents as GraphEvent,
  VertexAddedEvent,
  VertexRemovedEvent,
} from './core/index.js';

export {
  serialize,
  deserialize,
  codecs,
  pgJsonCodec,
  pgTextCodec,
  graphsonCodec,
  csvCodec,
  normalizeValue,
  normalizeBag,
} from './serialization/index.js';
export type { Codec, FormatName, PropertyValue, PropertyBag } from './serialization/index.js';
