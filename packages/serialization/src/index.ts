import { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Codec } from './codec.js';
import { csvCodec } from './csv/index.js';
import { graphsonCodec } from './graphson/index.js';
import { ndjsonCodec } from './ndjson/index.js';
import { pgJsonCodec } from './pg-json/index.js';
import { pgTextCodec } from './pg-text/index.js';
import { type ChunkSource, yieldToEventLoop } from './streaming.js';

export type { Codec } from './codec.js';
// Verify a round trip: `graphContentEqual(deserialize(serialize(g, fmt), fmt), g)`.
export { graphContentEqual } from './equality.js';
export type { PropertyValue, PropertyBag } from './value.js';
export { normalizeValue, normalizeBag } from './value.js';
export type { ChunkSource } from './streaming.js';
export { linesFromChunks, collect, chunked, yieldToEventLoop } from './streaming.js';

export { pgJsonCodec } from './pg-json/index.js';
export { pgTextCodec } from './pg-text/index.js';
export { ndjsonCodec } from './ndjson/index.js';
export { graphsonCodec } from './graphson/index.js';
export { csvCodec } from './csv/index.js';
// The CSV codec's node/edge halves — for Neo4j-`admin-import`-style paired files
// (a nodes CSV + an edges CSV). `decode*` mutate-and-return the passed graph.
export {
  decodeEdges,
  decodeEdgesStream,
  decodeNodes,
  decodeNodesStream,
  encodeEdges,
  encodeNodes,
} from './csv/index.js';

// `as const satisfies` (not a widening `Record<string, Codec>` annotation) so
// `keyof typeof codecs` stays the literal union `'pg-json' | 'ndjson' | …`
// rather than collapsing to `string`. That gives every entry point below real
// autocomplete and compile-time typo protection (`serialize(g, 'ndsjon')` is a
// type error, not a runtime throw).
/** The registered serialization formats, keyed by name. */
export const codecs = {
  'pg-json': pgJsonCodec,
  'pg-text': pgTextCodec,
  ndjson: ndjsonCodec,
  graphson: graphsonCodec,
  csv: csvCodec,
} as const satisfies Record<string, Codec>;

export type FormatName = keyof typeof codecs;

/**
 * The registered format names as a runtime array — for building a `--format`
 * CLI flag, a `<select>`, or validating input without reaching into `codecs`.
 * Order is stable (matches {@link codecs}).
 */
export const FORMATS: readonly FormatName[] = Object.keys(codecs) as FormatName[];

const codecFor = (format: string): Codec => {
  // Indexed by a plain `string` (callers pass `FormatName`, but the runtime
  // guard also fields arbitrary input), so widen past the literal keys here.
  const codec = (codecs as Record<string, Codec | undefined>)[format];

  if (!codec) {
    throw new LenkeError(
      `Unknown serialization format '${format}' (have: ${Object.keys(codecs).join(', ')})`,
      { code: ErrorCode.UnknownFormat, details: { format } },
    );
  }

  return codec;
};

/** Serialize a graph in the named format (`'pg-json' | 'graphson' | 'csv'`). */
export const serialize = (graph: Graph, format: FormatName): string =>
  codecFor(format).encode(graph);

/**
 * Deserialize a string in the named format into `graph`, mutating and returning
 * it. `graph` is optional: omit it to parse into a fresh graph (the common
 * case), or pass an existing one to append/merge the input into it.
 */
export const deserialize = (input: string, format: FormatName, graph: Graph = new Graph()): Graph =>
  codecFor(format).decode(input, graph);

/**
 * Parse a string in the named format into a NEW graph — sugar for the common
 * `deserialize(input, format)` with no target. Use {@link deserialize} directly
 * when you want to append into an existing graph.
 */
export const parse = (input: string, format: FormatName): Graph => deserialize(input, format);

/** Stream-serialize a graph in the named format (line-oriented formats only). */
export const serializeStream = (graph: Graph, format: FormatName): AsyncGenerator<string> => {
  const codec = codecFor(format);

  if (!codec.encodeStream) {
    throw new LenkeError(`Format '${format}' does not support streaming`, {
      code: ErrorCode.Unsupported,
      details: { format },
    });
  }

  return codec.encodeStream(graph);
};

/** Stream-deserialize from a chunk source into `graph` (line-oriented formats only). */
export const deserializeStream = (
  source: ChunkSource,
  format: FormatName,
  graph: Graph = new Graph(),
): Promise<Graph> => {
  const codec = codecFor(format);

  if (!codec.decodeStream) {
    throw new LenkeError(`Format '${format}' does not support streaming`, {
      code: ErrorCode.Unsupported,
      details: { format },
    });
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
  graph: Graph = new Graph(),
): Promise<Graph> => {
  const codec = codecFor(format);

  if (codec.decodeStream) {
    return codec.decodeStream(yieldingChunks(input, DECODE_CHUNK), graph);
  }

  await yieldToEventLoop();

  return codec.decode(input, graph);
};
