import type { Graph } from '../core/Graph.js';
import type { Codec } from './codec.js';
import { csvCodec } from './csv/index.js';
import { graphsonCodec } from './graphson/index.js';
import { pgJsonCodec } from './pg-json/index.js';

export type { Codec } from './codec.js';
export type { PropertyValue, PropertyBag } from './value.js';
export { normalizeValue, normalizeBag } from './value.js';

export { pgJsonCodec } from './pg-json/index.js';
export { graphsonCodec } from './graphson/index.js';
export { csvCodec } from './csv/index.js';

/** The registered serialization formats, keyed by name. */
export const codecs: Readonly<Record<string, Codec>> = {
  'pg-json': pgJsonCodec,
  graphson: graphsonCodec,
  csv: csvCodec,
};

export type FormatName = keyof typeof codecs;

const codecFor = (format: string): Codec => {
  const codec = codecs[format];
  if (!codec) {
    throw new Error(
      `Unknown serialization format '${format}' (have: ${Object.keys(codecs).join(', ')})`,
    );
  }
  return codec;
};

/** Serialize a graph in the named format (`'pg-json' | 'graphson' | 'csv'`). */
export const serialize = (graph: Graph, format: FormatName): string =>
  codecFor(format).encode(graph);

/** Deserialize a string in the named format into `graph` (mutating it). */
export const deserialize = (input: string, format: FormatName, graph: Graph): Graph =>
  codecFor(format).decode(input, graph);
