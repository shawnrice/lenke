import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { chunked, collect } from '../streaming.js';
import type { PropertyValue } from '../value.js';
import { decode, decodeStream, encode, encodeStream, pgTextCodec } from './index.js';

const lines = (g: Graph): string[] => encode(g).split('\n');

describe('pg-text hardening: labels/keys with delimiters round-trip (no element forgery)', () => {
  const roundTrip = (g: Graph): Graph => decode(encode(g), new Graph());

  test('a label or key containing a newline cannot forge a new element on decode', () => {
    const g = new Graph();
    g.addVertex({
      id: 'n1',
      labels: ['ok', 'evil\n999 :Injected'], // a raw newline would split the line
      properties: { 'weird key\nx': 1 },
    });

    expect(encode(g).split('\n')).toHaveLength(1); // no raw newline in the node line

    const back = roundTrip(g);
    expect(back.vertexCount).toBe(1); // NOT 2 — no forged element
    const n1 = back.getVertexById('n1')!;
    expect([...n1.labels].sort()).toEqual(['evil\n999 :Injected', 'ok']);
    expect(n1.properties['weird key\nx']).toBe(1);
  });

  test('labels/keys with spaces, colons, and quotes round-trip', () => {
    const g = new Graph();
    g.addVertex({
      id: 'n1',
      labels: ['has space', 'has:colon', 'has"quote'],
      properties: { 'key with space': 'v', 'key:with:colons': 2, 'q"k': true },
    });

    const n1 = roundTrip(g).getVertexById('n1')!;
    expect([...n1.labels].sort()).toEqual(['has space', 'has"quote', 'has:colon']);
    expect(n1.properties['key with space']).toBe('v');
    expect(n1.properties['key:with:colons']).toBe(2);
    expect(n1.properties['q"k']).toBe(true);
  });

  test('a node whose first property key is quoted is not misread as an edge', () => {
    const g = new Graph();
    g.addVertex({ id: 'solo', labels: [], properties: { 'a b': 1 } }); // key needs quoting

    const back = roundTrip(g);
    expect(back.vertexCount).toBe(1);
    expect([...back.edges]).toHaveLength(0); // NOT parsed as an edge line
    expect(back.getVertexById('solo')!.properties['a b']).toBe(1);
  });
});

describe('pg-text: encoding shape', () => {
  test('a node line leads with its id, then :labels, then key:value', () => {
    const g = new Graph();
    g.addVertex({ id: 'n1', labels: ['Person', 'Admin'], properties: { name: 'Alice', age: 30 } });
    expect(lines(g)).toEqual([`n1 :Person :Admin name:"Alice" age:30`]);
  });

  test('an edge line is `from to :label key:value`', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: [], properties: {} });
    const b = g.addVertex({ id: 'b', labels: [], properties: {} });
    g.addEdge({ id: 'e', from: a, to: b, labels: ['KNOWS'], properties: { since: 2005 } });
    expect(lines(g).filter((l) => l.startsWith('a b'))).toEqual([`a b :KNOWS since:2005`]);
  });

  test('scalars encode bare except strings, which are always quoted', () => {
    const g = new Graph();
    g.addVertex({
      id: 'x',
      labels: [],
      properties: { s: 'hi', i: 7, f: 1.5, t: true, fa: false, nul: null },
    });
    expect(lines(g)[0]).toBe(`x s:"hi" i:7 f:1.5 t:true fa:false nul:null`);
  });

  test('quotes and backslashes in strings are escaped', () => {
    const g = new Graph();
    g.addVertex({ id: 'x', labels: [], properties: { v: 'a"b\\c' } });
    expect(lines(g)[0]).toBe(`x v:"a\\"b\\\\c"`);
  });

  test('ids containing a colon or space are quoted and round-trip', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a:b', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'c d', labels: ['N'], properties: {} });
    g.addEdge({ id: 'e', from: a, to: b, labels: ['R'], properties: {} });
    const back = decode(encode(g), new Graph());
    expect(back.vertexCount).toBe(2); // not mis-parsed into extra nodes
    expect(back.edgeCount).toBe(1); // not mis-classified as a node
    expect(back.getVertexById('a:b')).not.toBeNull();
    expect(back.getVertexById('c d')).not.toBeNull();
    const [edge] = [...back.edges];
    expect([edge.from.id, edge.to.id]).toEqual(['a:b', 'c d']);
  });

  test('newline/CR/tab in a string are escaped and round-trip (no line split)', () => {
    const g = new Graph();
    g.addVertex({ id: 'x', labels: ['N'], properties: { note: 'l1\nl2\tx"q\\b\r' } });
    // Encoded form stays a single physical line (no raw newline leaks out).
    expect(encode(g).replace(/\n+$/, '').split('\n')).toHaveLength(1);
    const back = decode(encode(g), new Graph());
    expect(back.getVertexById('x')!.properties.note).toBe('l1\nl2\tx"q\\b\r');
  });
});

describe('pg-text: decoding', () => {
  test('round-trips scalars including quoted strings with spaces and colons', () => {
    const g = new Graph();
    g.addVertex({
      id: 'n',
      labels: ['T'],
      properties: { url: 'http://x:8080', note: 'a b c', n: -3.5, ok: true, z: null },
    });
    const back = decode(encode(g), new Graph());
    const v = back.getVertexById('n')!;
    expect([...v.labels]).toEqual(['T']);
    expect(v.properties).toEqual({
      url: 'http://x:8080',
      note: 'a b c',
      n: -3.5,
      ok: true,
      z: null,
    });
  });

  test('distinguishes a one-token node from a two-id edge', () => {
    const back = decode(`solo :Lonely\nfrom to :REL`, new Graph());
    expect([...back.vertices].map((v) => v.id).sort()).toEqual(['from', 'solo', 'to']);
    expect([...back.edges]).toHaveLength(1);
    const [e] = [...back.edges];
    expect([e.from.id, e.to.id, [...e.labels][0]]).toEqual(['from', 'to', 'REL']);
  });

  test('edges create missing endpoints; node lines may come after edges', () => {
    const back = decode(`a b :R\na :A name:"Al"`, new Graph());
    expect(back.getVertexById('a')!.properties).toEqual({ name: 'Al' });
    expect(back.getVertexById('b')).not.toBeNull(); // created bare by the edge
  });

  test('comments and blank lines are ignored; bare foreign values parse as strings', () => {
    const back = decode(`# a comment\n\nn1 status:active`, new Graph());
    expect(back.getVertexById('n1')!.properties).toEqual({ status: 'active' });
  });

  test('repeated keys decode to a list; a single key is a scalar', () => {
    const back = decode(`n tags:1 tags:2 tags:3 one:5`, new Graph());
    expect(back.getVertexById('n')!.properties).toEqual({ tags: [1, 2, 3], one: 5 });
  });
});

describe('pg-text: documented lossiness', () => {
  test('an empty list is dropped (no key emitted)', () => {
    const g = new Graph();
    g.addVertex({ id: 'n', labels: [], properties: { tags: [] as PropertyValue[], keep: 1 } });
    expect(decode(encode(g), new Graph()).getVertexById('n')!.properties).toEqual({ keep: 1 });
  });

  test('a single-element list collapses to a scalar', () => {
    const g = new Graph();
    g.addVertex({ id: 'n', labels: [], properties: { tags: [42] as PropertyValue[] } });
    expect(decode(encode(g), new Graph()).getVertexById('n')!.properties).toEqual({ tags: 42 });
  });
});

// Deterministic round-trip over what PG-text can represent exactly: scalars and
// multi-element lists. Compared ignoring edge ids (the format has no edge-id
// slot). Node ids, labels, and properties must match.
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const scalar = (r: () => number): PropertyValue => {
  const k = r();

  if (k < 0.3) {
    return Math.floor(r() * 400) - 200;
  }

  if (k < 0.45) {
    return Math.round((r() * 400 - 200) * 100) / 100;
  }

  if (k < 0.62) {
    return r() < 0.5 ? 'plain text' : `s:${Math.floor(r() * 1000)}`;
  }

  if (k < 0.74) {
    return r() < 0.5;
  }

  return null;
};

const representableGraph = (seed: number): Graph => {
  const r = rng(seed);
  const g = new Graph();
  g.disableEvents();
  const nodes = [];
  const nodeCount = 3 + Math.floor(r() * 10);

  for (let i = 0; i < nodeCount; i += 1) {
    const labels = ['A', 'B', 'C'].filter(() => r() < 0.4);
    const properties: Record<string, PropertyValue> = {};

    for (const key of ['a', 'b', 'name', 'tags']) {
      if (r() < 0.5) {
        if (key === 'tags' && r() < 0.6) {
          const len = 2 + Math.floor(r() * 3); // multi-element only
          const arr: PropertyValue[] = [];

          for (let j = 0; j < len; j += 1) {
            arr.push(r() < 0.5 ? Math.floor(r() * 20) : 'x');
          }

          properties[key] = arr;
        } else {
          properties[key] = scalar(r);
        }
      }
    }

    nodes.push(g.addVertex({ id: `n${i}`, labels, properties }));
  }

  const edgeCount = Math.floor(r() * nodeCount * 2);

  for (let i = 0; i < edgeCount; i += 1) {
    const from = nodes[Math.floor(r() * nodes.length)];
    const to = nodes[Math.floor(r() * nodes.length)];
    const properties: Record<string, PropertyValue> = {};

    if (r() < 0.5) {
      properties.w = scalar(r);
    }

    g.addEdge({ from, to, labels: ['REL'], properties });
  }

  g.enableEvents();

  return g;
};

const canon = (labels: Iterable<string>, props: Record<string, unknown>): string =>
  `${JSON.stringify([...labels].sort())}|${JSON.stringify(
    Object.keys(props)
      .sort()
      .map((k) => [k, props[k]]),
  )}`;

/** Equal up to edge ids: nodes by id, edges as a multiset of endpoint+label+props. */
const equalUpToEdgeIds = (a: Graph, b: Graph): boolean => {
  const nodes = (g: Graph): Map<string, string> =>
    new Map([...g.vertices].map((v) => [String(v.id), canon(v.labels, v.properties)]));
  const na = nodes(a);
  const nb = nodes(b);

  if (na.size !== nb.size || ![...na].every(([k, v]) => nb.get(k) === v)) {
    return false;
  }

  const edges = (g: Graph): string[] =>
    [...g.edges].map((e) => `${e.from.id}->${e.to.id}|${canon(e.labels, e.properties)}`).sort();
  const ea = edges(a);
  const eb = edges(b);

  return ea.length === eb.length && ea.every((x, i) => x === eb[i]);
};

describe('pg-text: round-trip (representable subset)', () => {
  test('scalars + multi-element lists round-trip for 300 seeds', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const g = representableGraph(seed);
      const back = decode(encode(g), new Graph());
      expect(equalUpToEdgeIds(back, g), `seed=${seed}`).toBe(true);
    }
  });

  test('codec object encode/decode agrees', () => {
    const g = representableGraph(7);
    const back = pgTextCodec.decode(pgTextCodec.encode(g), new Graph());
    expect(equalUpToEdgeIds(back, g)).toBe(true);
  });

  test('throughput: ~10k elements encode + decode', () => {
    const g = new Graph();
    g.disableEvents();
    const nodes = [];

    for (let i = 0; i < 5000; i += 1) {
      nodes.push(g.addVertex({ id: `n${i}`, labels: ['N'], properties: { a: i, b: `s${i}` } }));
    }

    for (let i = 0; i < 5000; i += 1) {
      g.addEdge({
        from: nodes[i % 5000],
        to: nodes[(i + 1) % 5000],
        labels: ['R'],
        properties: { w: i },
      });
    }

    g.enableEvents();
    const start = performance.now();
    const decoded = decode(encode(g), new Graph());
    const ms = performance.now() - start;
    console.log(`pg-text throughput: 10000 elements in ${ms.toFixed(1)}ms`);
    expect([...decoded.vertices]).toHaveLength(5000);
    expect([...decoded.edges]).toHaveLength(5000);
  });
});

describe('pg-text: streaming', () => {
  test('encodeStream, collected, decodes back to the same graph', async () => {
    const g = representableGraph(11);
    const text = await collect(encodeStream(g));
    expect(equalUpToEdgeIds(decode(text, new Graph()), g)).toBe(true);
  });

  test('decodeStream from tiny (line-splitting) chunks equals decode', async () => {
    const g = representableGraph(12);
    const back = await decodeStream(chunked(encode(g), 3), new Graph());
    expect(equalUpToEdgeIds(back, g)).toBe(true);
  });

  test('encodeStream → 1-byte chunks → decodeStream round-trips, 100 seeds', async () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const g = representableGraph(seed);
      const text = await collect(encodeStream(g));
      const back = await decodeStream(chunked(text, 1), new Graph());
      expect(equalUpToEdgeIds(back, g), `seed=${seed}`).toBe(true);
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
      nodes.push(g.addVertex({ id: `n${i}`, labels: ['N'], properties: { a: i } }));
    }

    for (let i = 0; i < 25000; i += 1) {
      g.addEdge({ from: nodes[i], to: nodes[(i + 1) % 25000], labels: ['R'], properties: {} });
    }

    g.enableEvents();
    const start = performance.now();
    const back = await decodeStream(encodeStream(g), new Graph());
    console.log(
      `pg-text stream pipe: 50000 elements in ${(performance.now() - start).toFixed(1)}ms`,
    );
    expect([...back.vertices]).toHaveLength(25000);
    expect([...back.edges]).toHaveLength(25000);
  });
});
