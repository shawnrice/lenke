import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';
import { chunked, collect } from '../streaming.js';

import type { ChunkSource } from '../streaming.js';
import { graphContentEqual, randomLpgGraph } from '../testkit.js';
import {
  csvCodec,
  decode,
  decodeEdges,
  decodeNodes,
  encode,
  encodeEdges,
  encodeNodes,
  encodeStream,
} from './index.js';

const roundTripNodes = (graph: Graph): Graph => decodeNodes(encodeNodes(graph), new Graph());

describe('CSV escaping / quoting (RFC 4180)', () => {
  test('quotes fields containing commas, quotes, and newlines', () => {
    const g = new Graph();
    g.addVertex({
      id: 'n1',
      labels: ['Person'],
      properties: { note: 'a, b "c"\nd', plain: 'x' },
    });
    const csv = encodeNodes(g);
    expect(csv).toContain('"a, b ""c""\nd"');

    const back = roundTripNodes(g);
    expect(graphContentEqual(back, g)).toBe(true);
  });

  test('quotes list-context strings containing the ; separator', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { tags: ['a;b', 'c'] } });
    const back = roundTripNodes(g);
    expect(back.getVertexById('n1')!.properties.tags as string[]).toEqual(['a;b', 'c']);
  });
});

describe('typed headers', () => {
  test('emits key:type columns spanning the union of all node keys', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: ['A'], properties: { age: 30, active: true } });
    g.addVertex({ id: 'n2', labels: ['B'], properties: { ratio: 1.5, name: 'x' } });
    const header = encodeNodes(g).split('\n')[0]!;
    expect(header).toBe('id,:LABEL,age:integer,active:boolean,ratio:float,name:string');
  });

  test('list columns carry an element type and []', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { nums: [1, 2, 3], words: ['a'] } });
    const header = encodeNodes(g).split('\n')[0]!;
    expect(header).toBe('id,:LABEL,nums:integer[],words:string[]');
    const back = roundTripNodes(g);
    expect(graphContentEqual(back, g)).toBe(true);
  });

  test('integer vs float vs boolean vs string survive', () => {
    const g = new Graph();
    g.addVertex({
      id: 'n1',
      labels: [],
      properties: { i: 5, f: 5.5, b: false, s: '5' },
    });
    const back = roundTripNodes(g);
    const p = back.getVertexById('n1')!.properties;
    expect(p.i).toBe(5);
    expect(p.f).toBe(5.5);
    expect(p.b).toBe(false);
    expect(p.s).toBe('5');
  });
});

describe('null vs empty-string vs absent distinction', () => {
  test('null, empty string, and missing key are all distinct after round-trip', () => {
    const g = new Graph();
    g.addVertex({ id: 'hasNull', labels: [], properties: { x: null, anchor: 1 } });
    g.addVertex({ id: 'hasEmpty', labels: [], properties: { x: '', anchor: 1 } });
    g.addVertex({ id: 'hasMissing', labels: [], properties: { anchor: 1 } });

    const back = roundTripNodes(g);

    const nullNode = back.getVertexById('hasNull')!.properties;
    expect('x' in nullNode).toBe(true);
    expect(nullNode.x).toBe(null);

    const emptyNode = back.getVertexById('hasEmpty')!.properties;
    expect('x' in emptyNode).toBe(true);
    expect(emptyNode.x).toBe('');

    const missingNode = back.getVertexById('hasMissing')!.properties;
    expect('x' in missingNode).toBe(false);
  });

  test('a node lacking a key does not gain a spurious null', () => {
    const g = new Graph();
    g.addVertex({ id: 'a', labels: [], properties: { only: 1 } });
    g.addVertex({ id: 'b', labels: [], properties: { other: 2 } });
    const back = roundTripNodes(g);
    expect('other' in back.getVertexById('a')!.properties).toBe(false);
    expect('only' in back.getVertexById('b')!.properties).toBe(false);
  });
});

describe('sentinel-collision safety', () => {
  test('a literal string equal to the null token round-trips as a string', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { x: '\\N', y: '\\Ti:5' } });
    const back = roundTripNodes(g);
    const p = back.getVertexById('n1')!.properties;
    expect(p.x).toBe('\\N');
    expect(p.y).toBe('\\Ti:5');
  });

  test('heterogeneous list elements (mixed int/string) round-trip', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { mixed: [1, 'a', 2] } });
    const back = roundTripNodes(g);
    expect(back.getVertexById('n1')!.properties.mixed).toEqual([1, 'a', 2]);
  });

  test('a key that is a list on one node and a scalar on another round-trips', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { v: [1, 2] } });
    g.addVertex({ id: 'n2', labels: [], properties: { v: 'hello' } });
    g.addVertex({ id: 'n3', labels: [], properties: { v: 9 } });
    const back = roundTripNodes(g);
    expect(back.getVertexById('n1')!.properties.v).toEqual([1, 2]);
    expect(back.getVertexById('n2')!.properties.v).toBe('hello');
    expect(back.getVertexById('n3')!.properties.v).toBe(9);
  });

  test('empty list round-trips distinctly from absent', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: [], properties: { xs: [], anchorListType: [1] } });
    g.addVertex({ id: 'n2', labels: [], properties: { anchorListType: [2] } });
    const back = roundTripNodes(g);
    expect(back.getVertexById('n1')!.properties.xs).toEqual([]);
    expect('xs' in back.getVertexById('n2')!.properties).toBe(false);
  });
});

describe('labels', () => {
  test('multi-label nodes ;-join in :LABEL', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: ['Person', 'Admin'], properties: {} });
    g.addVertex({ id: 'n2', labels: [], properties: {} });
    const csv = encodeNodes(g);
    // The ; element separator forces RFC-4180 quoting of the label cell.
    expect(csv).toContain('n1,"Person;Admin"');
    expect(csv).toContain('n2,');
    const back = roundTripNodes(g);
    expect([...back.getVertexById('n1')!.labels].sort()).toEqual(['Admin', 'Person']);
    expect([...back.getVertexById('n2')!.labels]).toEqual([]);
  });
});

describe('edges', () => {
  test('round-trips endpoints, :TYPE label, and typed props', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: [], properties: {} });
    const b = g.addVertex({ id: 'b', labels: [], properties: {} });
    g.addEdge({ id: 'e1', from: a, to: b, labels: ['KNOWS'], properties: { since: 2020 } });
    g.addEdge({ id: 'e2', from: a, to: b, labels: ['KNOWS'], properties: {} }); // parallel

    const target = new Graph();
    decodeNodes(encodeNodes(g), target);
    decodeEdges(encodeEdges(g), target);
    expect(graphContentEqual(target, g)).toBe(true);
  });

  test('decodeEdges throws on a dangling endpoint', () => {
    const g = new Graph();
    expect(() => decodeEdges('id,:START_ID,:END_ID,:TYPE\ne1,x,y,KNOWS', g)).toThrow(
      /non-existent vertex/,
    );
  });
});

describe('codec single-string adapter', () => {
  test('encode/decode round-trips through the sentinel', () => {
    const g = randomLpgGraph(7);
    const back = decode(encode(g), new Graph());
    expect(graphContentEqual(back, g)).toBe(true);
    expect(csvCodec.name).toBe('csv');
    expect(encode(g)).toContain('=== EDGES ===');
  });
});

describe('round-trip property test', () => {
  test('graphContentEqual over 500 seeds', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const original = randomLpgGraph(seed);
      const back = csvCodec.decode(csvCodec.encode(original), new Graph());
      if (!graphContentEqual(back, original)) {
        throw new Error(`round-trip failed for seed ${seed}`);
      }
    }
    expect(true).toBe(true);
  });
});

describe('throughput smoke test', () => {
  test('encodes and decodes ~10k elements quickly', () => {
    const g = new Graph();
    g.disableEvents();
    const nodeCount = 5000;
    const verts = [];
    for (let i = 0; i < nodeCount; i += 1) {
      verts.push(
        g.addVertex({
          id: `n${i}`,
          labels: i % 2 === 0 ? ['Even', 'Num'] : ['Odd'],
          properties: { idx: i, ratio: i / 3, label: `node-${i}`, flag: i % 3 === 0 },
        }),
      );
    }
    for (let i = 0; i < 5000; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: verts[i % nodeCount]!,
        to: verts[(i * 7 + 1) % nodeCount]!,
        labels: ['LINK'],
        properties: { w: i * 0.5 },
      });
    }
    g.enableEvents();

    const start = performance.now();
    const str = encode(g);
    const back = decode(str, new Graph());
    const elapsed = performance.now() - start;

    expect(graphContentEqual(back, g)).toBe(true);
    expect(back.vertexCount).toBe(nodeCount);
    expect(back.edgeCount).toBe(5000);
    // eslint-disable-next-line no-console
    console.log(`csv throughput: 10k elements encode+decode in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('streaming', () => {
  test('decodeStream(encodeStream(g)) round-trips over 200 seeds', async () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const original = randomLpgGraph(seed);
      // A generator IS a ChunkSource — pipe it straight into decode.
      const back = await csvCodec.decodeStream!(encodeStream(original), new Graph());
      if (!graphContentEqual(back, original)) {
        throw new Error(`stream round-trip failed for seed ${seed}`);
      }
    }
    expect(true).toBe(true);
  });

  test('decode from adversarial tiny chunks equals non-streaming decode', async () => {
    const g = randomLpgGraph(42);
    const text = await collect(encodeStream(g));
    const streamed = await csvCodec.decodeStream!(chunked(text, 3), new Graph());
    const batched = decode(encode(g), new Graph());
    expect(graphContentEqual(streamed, g)).toBe(true);
    expect(graphContentEqual(streamed, batched)).toBe(true);
  });

  test('a multi-byte (emoji) value fed byte-by-byte as Uint8Array round-trips', async () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: ['Emoji'], properties: { face: '🦊 fox 日本語', tag: '✓' } });

    const text = await collect(encodeStream(g));
    const bytes = new TextEncoder().encode(text);
    const byteByByte: ChunkSource = {
      async *[Symbol.asyncIterator]() {
        for (const b of bytes) {
          yield new Uint8Array([b]);
        }
      },
    };

    const back = await csvCodec.decodeStream!(byteByByte, new Graph());
    expect(graphContentEqual(back, g)).toBe(true);
    expect(back.getVertexById('n1')!.properties.face).toBe('🦊 fox 日本語');
    expect(back.getVertexById('n1')!.properties.tag).toBe('✓');
  });

  test('large-graph pipe (25k nodes + 25k edges) through encodeStream → decodeStream', async () => {
    const g = new Graph();
    g.disableEvents();
    const nodeCount = 25000;
    const verts = [];
    for (let i = 0; i < nodeCount; i += 1) {
      verts.push(
        g.addVertex({
          id: `n${i}`,
          labels: i % 2 === 0 ? ['Even', 'Num'] : ['Odd'],
          properties: { idx: i, ratio: i / 3, label: `node-${i}`, tags: ['a', 'b'] },
        }),
      );
    }
    for (let i = 0; i < 25000; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: verts[i % nodeCount]!,
        to: verts[(i * 7 + 1) % nodeCount]!,
        labels: ['LINK'],
        properties: { w: i * 0.5 },
      });
    }
    g.enableEvents();

    const start = performance.now();
    const back = await csvCodec.decodeStream!(encodeStream(g), new Graph());
    const elapsed = performance.now() - start;

    expect(back.vertexCount).toBe(nodeCount);
    expect(back.edgeCount).toBe(25000);
    // eslint-disable-next-line no-console
    console.log(`csv stream throughput: 50k elements encode+decode in ${elapsed.toFixed(0)}ms`);
  });
});
