import { describe, expect, test } from 'bun:test';

import { Graph } from '../../core/Graph.js';
import { chunked, collect } from '../streaming.js';
import { graphContentEqual, randomLpgGraph } from '../testkit.js';
import { decode, decodeStream, encode, encodeStream, ndjsonCodec } from './index.js';

describe('ndjson: shape', () => {
  test('one JSON object per line, tagged node/edge, ids and props preserved', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'n0', labels: ['Person'], properties: { name: 'marko', age: 29 } });
    const b = g.addVertex({ id: 'n1', labels: ['Software'], properties: {} });
    g.addEdge({ id: 'e0', from: a, to: b, labels: ['CREATED'], properties: { weight: 0.4 } });
    const lines = encode(g).split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'node',
      id: 'n0',
      labels: ['Person'],
      properties: { name: 'marko', age: 29 },
    });
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      type: 'edge',
      id: 'e0',
      from: 'n0',
      to: 'n1',
      labels: ['CREATED'],
      properties: { weight: 0.4 },
    });
  });

  test('value types (bool/null/array) survive a round-trip', () => {
    const g = new Graph();
    g.addVertex({
      id: 'x',
      labels: [],
      properties: { b: true, no: false, nul: null, arr: [1, 'a', false] },
    });
    const v = decode(encode(g), new Graph()).getVertexById('x')!;
    expect(v.properties).toEqual({ b: true, no: false, nul: null, arr: [1, 'a', false] });
  });
});

describe('ndjson: validation', () => {
  test('rejects malformed JSON and non-record lines', () => {
    expect(() => decode('{not json}', new Graph())).toThrow(/invalid JSON/);
    expect(() => decode('{"type":"thing"}', new Graph())).toThrow(/node.*or.*edge/);
    expect(() => decode('42', new Graph())).toThrow();
  });

  test('blank lines are ignored', () => {
    const g = decode('\n{"type":"node","id":"a"}\n\n', new Graph());
    expect(g.getVertexById('a')).not.toBeNull();
  });

  test('an edge with an unseen endpoint creates a bare node', () => {
    const g = decode('{"type":"edge","id":"e","from":"a","to":"b","labels":["R"]}', new Graph());
    expect(g.getVertexById('a')).not.toBeNull();
    expect([...g.edges]).toHaveLength(1);
  });
});

describe('ndjson: round-trip (full fidelity)', () => {
  test('decode(encode(g)) equals g for 300 random graphs', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const g = randomLpgGraph(seed);
      expect(graphContentEqual(decode(encode(g), new Graph()), g), `seed=${seed}`).toBe(true);
    }
  });

  test('codec object agrees', () => {
    const g = randomLpgGraph(5);
    expect(graphContentEqual(ndjsonCodec.decode(ndjsonCodec.encode(g), new Graph()), g)).toBe(true);
  });
});

describe('ndjson: streaming', () => {
  test('decodeStream from tiny chunks equals decode', async () => {
    const g = randomLpgGraph(9);
    const back = await decodeStream(chunked(encode(g), 3), new Graph());
    expect(graphContentEqual(back, g)).toBe(true);
  });

  test('encodeStream → 1-byte chunks → decodeStream round-trips, 100 seeds', async () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const g = randomLpgGraph(seed);
      const text = await collect(encodeStream(g));
      const back = await decodeStream(chunked(text, 1), new Graph());
      expect(graphContentEqual(back, g), `seed=${seed}`).toBe(true);
    }
  });

  test('reassembles a multi-byte character split across byte chunks', async () => {
    const g = new Graph();
    g.addVertex({ id: 'n', labels: [], properties: { emoji: '🚀x—é' } });
    const bytes = new TextEncoder().encode(encode(g));
    const byteByByte: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (const b of bytes) {
          yield new Uint8Array([b]);
        }
      },
    };
    const back = await decodeStream(byteByByte, new Graph());
    expect(back.getVertexById('n')!.properties).toEqual({ emoji: '🚀x—é' });
  });

  test('pipes a 50k-element graph encodeStream → decodeStream (no full string)', async () => {
    const g = new Graph();
    g.disableEvents();
    const nodes = [];
    for (let i = 0; i < 25000; i += 1) {
      nodes.push(g.addVertex({ id: `n${i}`, labels: ['N'], properties: { a: i, t: i % 2 === 0 } }));
    }
    for (let i = 0; i < 25000; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: nodes[i]!,
        to: nodes[(i + 1) % 25000]!,
        labels: ['R'],
        properties: { w: i },
      });
    }
    g.enableEvents();
    const start = performance.now();
    const back = await decodeStream(encodeStream(g), new Graph());
    console.log(
      `ndjson stream pipe: 50000 elements in ${(performance.now() - start).toFixed(1)}ms`,
    );
    expect(graphContentEqual(back, g)).toBe(true);
  });
});
