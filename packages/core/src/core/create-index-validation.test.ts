// Item 576. `Graph.createIndex` validated the index KIND and nothing else, and the branch that
// used `spec.on` read `on === 'vertex' ? vertex : edge` — so any other value took the EDGE arm
// and built an edge index on a vertex key. Not an ignored call: an index on the WRONG ELEMENT,
// which no seek consults. Measured at 20,000 users on `MATCH (u:User) WHERE u.name = $u`:
//
//   createIndex({ on: 'vertex', … })   1.20M ops/s
//   createIndex({ on: 'node',   … })      2.3k      the unindexed scan rate
//
// 500x with no error, and `'node'` is the natural word for a GQL engine. The native engine
// rejects every spec below, so this also closes a cross-engine divergence whose costly side was
// the silent one.
//
// `keys` is a bare `string[]` here (the native package's `IndexSpec` is a discriminated union,
// so its arity is a compile error instead), and `const [key] = spec.keys` quietly took the first
// and dropped the rest — a two-key spec built a one-key index, a keyless one built an index
// under the key `undefined`.
import { describe, expect, test } from 'bun:test';

import { Graph } from '../index.js';

const seeded = (): Graph => {
  const g = new Graph();

  const a = g.addVertex({ id: 'a', labels: ['U'], properties: { name: 'a', score: 1 } });

  // `addEdge` takes VERTEX OBJECTS, not ids — passing ids reads as missing endpoints.
  g.addEdge({ id: 'e', labels: ['R'], from: a, to: a, properties: { w: 2 } });

  return g;
};

describe('createIndex validates the spec it is given (item 576)', () => {
  test('an unknown target is rejected, not treated as an edge', () => {
    for (const on of ['node', 'NODE', 'vertices', 'bogus', '']) {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seeded().createIndex({ on, kind: 'hash', keys: ['name'] } as any),
      ).toThrow(/unknown index target/);
    }
    // A MISSING target is the same mistake and must read the same way.

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      seeded().createIndex({ kind: 'hash', keys: ['name'] } as any),
    ).toThrow(/unknown index target 'undefined'/);
  });

  test('a hash or range index takes exactly one key', () => {
    for (const kind of ['hash', 'range'] as const) {
      expect(() => seeded().createIndex({ on: 'vertex', kind, keys: [] })).toThrow(
        /takes exactly one key, got 0/,
      );
      expect(() => seeded().createIndex({ on: 'vertex', kind, keys: ['name', 'score'] })).toThrow(
        /takes exactly one key, got 2/,
      );
    }
  });

  test('the valid specs this engine supports still work', () => {
    const g = seeded();

    // A vertex index on a key an existing vertex carries — and the seek must find it, which is
    // what says the index landed on the VERTEX side rather than the edge side.
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
    g.createIndex({ on: 'vertex', kind: 'range', keys: ['score'] });
    // An EDGE hash index is a core capability the native engine does not have (core keeps one
    // structure per side and it serves both seeks), so it stays accepted.
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

    expect(g.vertexPropertyIndex.isIndexed('name')).toBe(true);
    expect(g.vertexPropertyIndex.isIndexed('score')).toBe(true);
    expect(g.edgePropertyIndex.isIndexed('w')).toBe(true);
    // and NOT on the other side, which is the bug's signature
    expect(g.edgePropertyIndex.isIndexed('name')).toBe(false);
  });

  test('the native-only kinds keep their own message', () => {
    expect(() => seeded().createIndex({ on: 'edge', kind: 'interval', keys: ['a', 'b'] })).toThrow(
      /only available in the native engine/,
    );
    expect(() => seeded().createIndex({ on: 'edge', kind: 'type', keys: [] })).toThrow(
      /only available in the native engine/,
    );
    // The target is checked FIRST, so a spec wrong in both ways reports the target.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      seeded().createIndex({ on: 'node', kind: 'interval', keys: ['a', 'b'] } as any),
    ).toThrow(/unknown index target/);
  });
});
