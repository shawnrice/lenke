import type { Graph } from '@pl-graph/core';
import type { Codec } from './codec.js';
import { csvCodec } from './csv/index.js';
import { graphsonCodec } from './graphson/index.js';
import { ndjsonCodec } from './ndjson/index.js';
import { pgJsonCodec } from './pg-json/index.js';
import { pgTextCodec } from './pg-text/index.js';
import { type ChunkSource, yieldToEventLoop } from './streaming.js';

export type { Codec } from './codec.js';
export type { PropertyValue, PropertyBag } from './value.js';
export { normalizeValue, normalizeBag } from './value.js';
export type { ChunkSource } from './streaming.js';
export { linesFromChunks, collect, chunked, yieldToEventLoop } from './streaming.js';

export { pgJsonCodec } from './pg-json/index.js';
export { pgTextCodec } from './pg-text/index.js';
export { ndjsonCodec } from './ndjson/index.js';
export { graphsonCodec } from './graphson/index.js';
export { csvCodec } from './csv/index.js';

/** The registered serialization formats, keyed by name. */
export const codecs: Readonly<Record<string, Codec>> = {
  'pg-json': pgJsonCodec,
  'pg-text': pgTextCodec,
  ndjson: ndjsonCodec,
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

/** Slice a string into chunks, yielding the event loop a macrotask between each. */
const yieldingChunks = async function* (text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
    await yieldToEventLoop();
  }
};

const DECODE_CHUNK = 1 << 16; // 64 KiB between event-loop yields

/**
 * Serialize without blocking the event loop. For line-oriented formats it drives
 * the streaming encoder, handing a macrotask back to the loop between batches.
 * Single-document JSON (pg-json/graphson) can only yield once around the atomic
 * `JSON.stringify` — use `ndjson` for genuinely non-blocking JSON.
 */
export const serializeAsync = async (graph: Graph, format: FormatName): Promise<string> => {
  const codec = codecFor(format);
  if (codec.encodeStream) {
    const parts: string[] = [];
    for await (const chunk of codec.encodeStream(graph)) {
      parts.push(chunk);
      await yieldToEventLoop();
    }
    return parts.join('');
  }
  await yieldToEventLoop();
  return codec.encode(graph);
};

/**
 * Deserialize without blocking the event loop. For line-oriented formats it feeds
 * the input through the streaming decoder in 64 KiB slices, yielding a macrotask
 * between slices. Single-document JSON yields once around the atomic `JSON.parse`.
 */
export const deserializeAsync = async (
  input: string,
  format: FormatName,
  graph: Graph,
): Promise<Graph> => {
  const codec = codecFor(format);
  if (codec.decodeStream) {
    return codec.decodeStream(yieldingChunks(input, DECODE_CHUNK), graph);
  }
  await yieldToEventLoop();
  return codec.decode(input, graph);
};
