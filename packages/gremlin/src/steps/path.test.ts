import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, inV, out, outE, path, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('path tests', () => {
    test('simple tinker toy path', () => {
      const result = arr(run(traversal(V(), out(), out(), path()), tinkerGraph));
      const ids = (result as Array<Array<{ id: string }>>).map((p) => p.map((n) => n.id));
      expect(ids).toEqual([
        ['1', '4', '5'],
        ['1', '4', '3'],
      ]);
    });

    test('complex paths work', () => {
      const result = arr(run(traversal(V(), outE(), inV(), outE(), inV(), path()), tinkerGraph));
      expect(result).toHaveLength(2);
      const ids = (result as Array<Array<{ id: string }>>).map((p) => p.map((n) => n.id));
      expect(ids).toEqual([
        ['1', '8', '4', '10', '5'],
        ['1', '8', '4', '11', '3'],
      ]);
    });

    // doc: g.V().out().out().path().by('name')
    test('path().by("name") projects each path element by property', () => {
      const result = arr(run(traversal(V(), out(), out(), path().by('name')), tinkerGraph));
      // Two such paths in the test graph: marko→josh→ripple and marko→josh→lop.
      expect(result).toEqual([
        ['marko', 'josh', 'ripple'],
        ['marko', 'josh', 'lop'],
      ]);
    });

    // doc: g.V(marko).out('knows').values('name').path() — [v[1],v[2],vadas]; [v[1],v[4],josh]
    test('path includes intermediate values from values()', () => {
      const result = arr(run(traversal(V('1'), out('KNOWS'), values('name'), path()), tinkerGraph));
      const paths = (result as Array<Array<unknown>>).map((p) =>
        p.map((n) => (n as { id?: string }).id ?? n),
      );
      expect(paths).toEqual([
        ['1', '2', 'vadas'],
        ['1', '4', 'josh'],
      ]);
    });

    // doc: g.V().out().out().path().by('name').by('age')
    // by()'s are applied round-robin to each path element.
    test('path with multiple by() modulators rotates per element', () => {
      const result = arr(
        run(traversal(V(), out(), out(), path().by('name').by('age')), tinkerGraph),
      );
      // marko->josh->ripple : [name(marko)='marko', age(josh)=32, name(ripple)='ripple']
      // marko->josh->lop    : [name(marko)='marko', age(josh)=32, name(lop)=undefined→'lop']
      // round robin: by(0)='name', by(1)='age', by(2)='name'.
      expect(result).toEqual([
        ['marko', 32, 'ripple'],
        ['marko', 32, 'lop'],
      ]);
    });
  });
});
