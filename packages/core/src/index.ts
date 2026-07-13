export { Edge, Graph, isElement, PropertyIndex, Vertex } from './core/index.js';
export { validateLabel, validatePropertyKey, validatePropertyValue } from './core/index.js';

export type {
  CardinalityConstraint,
  Element,
  GraphElement,
  GraphOptions,
  IndexableValue,
  InvariantInfo,
  RangeBound,
  ScalarTypeName,
  ValidatorInfo,
} from './core/index.js';
// The full graph-event surface: every per-event payload type (e.g.
// `VertexPropertyChanged`, `LabelAddedToVertex`), the `GraphEvents` map keyed by
// event name, the `GraphEvent` UNION of all payloads, and `GraphEventType`. (The
// old export mis-aliased the *map* as `GraphEvent` and omitted the payload
// types, so a typed reducer over the union wasn't writable.)
export type * from './core/GraphEvents.js';

// ISO temporal values (DATE / LOCAL DATETIME / DURATION) — the value-model
// foundation shared by the serialization codecs and the query engines.
export {
  LocalDate,
  LocalDateTime,
  Duration,
  isTemporal,
  coerceTemporal,
  temporalTag,
  temporalFormat,
  temporalParse,
  temporalCmpTotal,
  temporalRelCmp,
  temporalArith,
  durationBetween,
  graphsonType,
  graphsonTag,
  fromTaggedJson,
  parseDate,
  parseDateTime,
  parseDuration,
} from './temporal.js';
export type { Temporal } from './temporal.js';
