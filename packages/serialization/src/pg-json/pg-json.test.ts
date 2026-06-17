import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';
import { graphContentEqual, randomLpgGraph } from '../testkit.js';
import { decode, encode, isPGFormat, pgJsonCodec } from './index.js';

describe('serialization/pg-json: shape', () => {
  test('encode produces a spec-shaped document', () => {
    const g = new Graph();
    g.disableEvents();
    const a = g.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'Alice' } });
    const b = g.addVertex({ id: 'b', labels: ['Person', 'Student'], properties: {} });
    g.addEdge({ id: 'e1', from: a, to: b, labels: ['KNOWS'], properties: { since: 2020 } });

    const doc = JSON.parse(encode(g));
    expect(isPGFormat(doc)).toBe(true);
    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0]).toMatchObject({
      id: 'e1',
      from: 'a',
      to: 'b',
      undirected: false,
      labels: ['KNOWS'],
      properties: { since: 2020 },
    });
  });

  test('round-trips the full LPG value model (bool/null/array/float)', () => {
    const g = new Graph();
    g.disableEvents();
    g.addVertex({
      id: 'v',
      labels: ['T'],
      properties: {
        s: 'str',
        b: true,
        f: false,
        n: null,
        num: 3.14,
        arr: [1, 'a', false, null],
      },
    });

    const out = decode(encode(g), new Graph());
    expect(out.getVertexById('v')?.properties).toEqual({
      s: 'str',
      b: true,
      f: false,
      n: null,
      num: 3.14,
      arr: [1, 'a', false, null],
    });
  });
});

describe('serialization/pg-json: validation', () => {
  test('throws on malformed JSON', () => {
    expect(() => decode('{not json', new Graph())).toThrow(/not valid JSON/);
  });

  test('throws when nodes is missing', () => {
    expect(() => decode(JSON.stringify({ edges: [] }), new Graph())).toThrow(/PG-JSON shape/);
  });

  test('throws when a node is malformed', () => {
    const bad = JSON.stringify({ nodes: [{ id: 'a', labels: 'nope', properties: {} }] });
    expect(() => decode(bad, new Graph())).toThrow(/PG-JSON shape/);
  });

  test('throws when an edge references a non-existent vertex', () => {
    const bad = JSON.stringify({
      nodes: [{ id: 'a', labels: [], properties: {} }],
      edges: [{ from: 'a', to: 'ghost', undirected: false, labels: ['X'], properties: {} }],
    });
    expect(() => decode(bad, new Graph())).toThrow(/non-existent vertex/);
  });

  test('accepts a document with edges omitted', () => {
    const doc = JSON.stringify({ nodes: [{ id: 'a', labels: ['T'], properties: {} }] });
    const out = decode(doc, new Graph());
    expect(out.getVertexById('a')).toBeDefined();
    expect(out.edgeCount).toBe(0);
  });

  test('coerces numeric ids to strings', () => {
    const doc = JSON.stringify({
      nodes: [
        { id: 101, labels: ['Person'], properties: {} },
        { id: 102, labels: ['Person'], properties: {} },
      ],
      edges: [{ from: 101, to: 102, undirected: false, labels: ['KNOWS'], properties: {} }],
    });
    const out = decode(doc, new Graph());
    expect(out.getVertexById('101')).toBeDefined();
    expect(out.getVertexById('102')).toBeDefined();
  });
});

describe('serialization/pg-json: parallel-edge import', () => {
  test('foreign edges without ids do not collapse', () => {
    const doc = JSON.stringify({
      nodes: [
        { id: 'a', labels: [], properties: {} },
        { id: 'b', labels: [], properties: {} },
      ],
      // Two parallel edges: same from/to/label.
      edges: [
        { from: 'a', to: 'b', undirected: false, labels: ['KNOWS'], properties: { w: 1 } },
        { from: 'a', to: 'b', undirected: false, labels: ['KNOWS'], properties: { w: 2 } },
      ],
    });
    const out = decode(doc, new Graph());
    expect(out.edgeCount).toBe(2);
  });

  test('our own ids are preserved on import', () => {
    const doc = JSON.stringify({
      nodes: [
        { id: 'a', labels: [], properties: {} },
        { id: 'b', labels: [], properties: {} },
      ],
      edges: [{ id: 'e42', from: 'a', to: 'b', undirected: false, labels: ['X'], properties: {} }],
    });
    const out = decode(doc, new Graph());
    expect(out.getEdgeById('e42')).toBeDefined();
  });
});

describe('serialization/pg-json: round-trip property test', () => {
  test('graphContentEqual over 300 seeds', () => {
    let passed = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const original = randomLpgGraph(seed);
      const restored = decode(encode(randomLpgGraph(seed)), new Graph());
      if (graphContentEqual(restored, original)) {
        passed += 1;
      } else {
        throw new Error(`round-trip mismatch at seed ${seed}`);
      }
    }
    expect(passed).toBe(300);
  });

  test('codec object round-trips via its own methods', () => {
    const original = randomLpgGraph(7);
    const restored = pgJsonCodec.decode(pgJsonCodec.encode(randomLpgGraph(7)), new Graph());
    expect(graphContentEqual(restored, original)).toBe(true);
  });
});

describe('serialization/pg-json: throughput smoke', () => {
  test('encode + decode a ~10k-element graph', () => {
    const g = new Graph();
    g.disableEvents();
    const nodeCount = 4000;
    const verts = [];
    for (let i = 0; i < nodeCount; i += 1) {
      verts.push(
        g.addVertex({ id: `n${i}`, labels: ['Node'], properties: { i, name: `v${i}`, ok: true } }),
      );
    }
    const edgeCount = 6000;
    for (let i = 0; i < edgeCount; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: verts[i % nodeCount],
        to: verts[(i * 7 + 1) % nodeCount],
        labels: ['LINKS'],
        properties: { w: i % 13 },
      });
    }

    const start = performance.now();
    const out = decode(encode(g), new Graph());
    const elapsed = performance.now() - start;

    expect(out.vertexCount).toBe(nodeCount);
    expect(out.edgeCount).toBe(edgeCount);
    // Generous ceiling: this is a smoke test, not a benchmark.
    expect(elapsed).toBeLessThan(2000);
  });
});
