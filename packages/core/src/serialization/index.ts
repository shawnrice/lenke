import type { Graph } from '../core/Graph.js';
import type { Codec } from './codec.js';
import { csvCodec } from './csv/index.js';
import { graphsonCodec } from './graphson/index.js';
import { pgJsonCodec } from './pg-json/index.js';
import { pgTextCodec } from './pg-text/index.js';
import type { ChunkSource } from './streaming.js';

export type { Codec } from './codec.js';
export type { PropertyValue, PropertyBag } from './value.js';
export { normalizeValue, normalizeBag } from './value.js';
export type { ChunkSource } from './streaming.js';
export { linesFromChunks, collect, chunked } from './streaming.js';

export { pgJsonCodec } from './pg-json/index.js';
export { pgTextCodec } from './pg-text/index.js';
export { graphsonCodec } from './graphson/index.js';
export { csvCodec } from './csv/index.js';

/** The registered serialization formats, keyed by name. */
export const codecs: Readonly<Record<string, Codec>> = {
  'pg-json': pgJsonCodec,
  'pg-text': pgTextCodec,
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

/** Stream-serialize a graph in the named format (line-oriented formats only). */
export const serializeStream = (graph: Graph, format: FormatName): AsyncGenerator<string> => {
  const codec = codecFor(format);
  if (!codec.encodeStream) {
    throw new Error(`Format '${format}' does not support streaming`);
  }
  return codec.encodeStream(graph);
};

/** Stream-deserialize from a chunk source into `graph` (line-oriented formats only). */
export const deserializeStream = (
  source: ChunkSource,
  format: FormatName,
  graph: Graph,
): Promise<Graph> => {
  const codec = codecFor(format);
  if (!codec.decodeStream) {
    throw new Error(`Format '${format}' does not support streaming`);
  }
  return codec.decodeStream(source, graph);
};
