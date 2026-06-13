/**
 * Shared streaming primitives for the line-oriented codecs (pg-text, CSV). The
 * point is to slurp a large serialized graph from a chunked source — a file
 * stream, socket, `Bun.file().stream()`, a Web `ReadableStream`, or just an
 * array of strings — without ever holding the whole document in memory.
 */

/** Anything you can `for await` over chunks of: text or bytes. */
export type ChunkSource = AsyncIterable<string | Uint8Array>;

/**
 * Buffer chunks and yield complete lines, retaining the partial trailing line
 * across chunk boundaries. A streaming `TextDecoder` reassembles a multi-byte
 * character that straddles two byte chunks. Memory is bounded by the longest
 * single line, not the document.
 */
export async function* linesFromChunks(source: ChunkSource): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lastNewline = buffer.lastIndexOf('\n');
    if (lastNewline === -1) {
      continue; // no complete line yet
    }
    const complete = buffer.slice(0, lastNewline);
    buffer = buffer.slice(lastNewline + 1);
    for (const line of complete.split('\n')) {
      yield line;
    }
  }
  buffer += decoder.decode(); // flush any trailing bytes
  if (buffer.length > 0) {
    yield buffer;
  }
}

/** Collect an async string iterable into one string — handy for tests and small inputs. */
export const collect = async (chunks: AsyncIterable<string>): Promise<string> => {
  const parts: string[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
  }
  return parts.join('');
};

/**
 * Turn a string into a `ChunkSource` of fixed-size slices — for exercising
 * streaming decoders against adversarial chunk boundaries in tests.
 */
export const chunked = (text: string, size: number): ChunkSource => ({
  async *[Symbol.asyncIterator]() {
    for (let i = 0; i < text.length; i += size) {
      yield text.slice(i, i + size);
    }
  },
});
