import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, as_, out, select } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('as tests', () => {
    test('as() alone is a no-op on the value stream', () => {
      const result = arr(run(traversal(V('1'), as_('a')), tinkerGraph));
      expect(result).toHaveLength(1);
      expect((result[0] as { properties: { name: string } }).properties.name).toBe('marko');
    });

    test('multiple as statements do not affect the return', () => {
      const result = arr(
        run(traversal(V(), as_('a'), out(), as_('b'), out(), as_('c')), tinkerGraph),
      );
      expect(
        (result as Array<{ properties: { name: string } }>).map((x) => x.properties.name),
      ).toEqual(['ripple', 'lop']);
    });

    // doc: g.V().as('a').out().as('b').select('a','b')
    test('as feeds select(a,b)', () => {
      const result = arr(
        run(traversal(V('1'), as_('a'), out('KNOWS'), as_('b'), select('a', 'b')), tinkerGraph),
      );
      const ids = (result as Array<{ a: { id: string }; b: { id: string } }>).map((r) => ({
        a: r.a.id,
        b: r.b.id,
      }));
      expect(ids).toEqual([
        { a: '1', b: '2' },
        { a: '1', b: '4' },
      ]);
    });
  });
});
