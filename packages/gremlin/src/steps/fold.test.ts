import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, fold, hasLabel, out, unfold, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP fold tests', () => {
    test('fold works', () => {
      const r1 = run(traversal(V('1'), out('KNOWS'), values('name')), tinkerGraph);
      expect(arr(r1)).toEqual(['vadas', 'josh']);

      const r2 = run(traversal(V('1'), out('KNOWS'), values('name'), fold()), tinkerGraph);
      // v2 fold() is a 1-element stream containing T[]
      expect(arr(r2)).toEqual([['vadas', 'josh']]);
    });

    // doc: g.V().out('knows').values('age').fold(0, (a, v) => a + v)
    test('fold(seed, reducer) — bifunctor closure form', () => {
      const r = arr(
        run(
          traversal(
            V('1'),
            out('KNOWS'),
            values('age'),
            fold(0, (acc, v) => (acc as number) + (v as number)),
          ),
          tinkerGraph,
        ),
      );
      // marko knows vadas (27) + josh (32) → sum = 59
      expect(r).toEqual([59]);
    });

    // doc: g.V().fold().unfold().values('name')
    test('fold().unfold() round-trips', () => {
      const r = arr(run(traversal(V(), fold(), unfold(), values('name')), tinkerGraph));
      expect(r).toEqual(['marko', 'vadas', 'josh', 'peter', 'lop', 'ripple']);
    });

    // doc: g.V().hasLabel('person').fold() — [v[1],v[2],v[4],v[6]]
    test('fold collects person vertices into a single list', () => {
      const r = arr(run(traversal(V(), hasLabel('PERSON'), fold()), tinkerGraph));
      expect(r).toHaveLength(1);
      expect((r[0] as Array<{ id: string }>).map((v) => v.id)).toEqual(['1', '2', '4', '6']);
    });

    // doc: g.V(1).out('knows').values('name').fold(0) {a,b -> a + b.length()} — 9
    // marko knows vadas (5) + josh (4) = 9
    test('fold(seed, reducer) summing string lengths', () => {
      const r = arr(
        run(
          traversal(
            V('1'),
            out('KNOWS'),
            values('name'),
            fold(0, (acc, v) => (acc as number) + (v as string).length),
          ),
          tinkerGraph,
        ),
      );
      expect(r).toEqual([9]);
    });

    // doc: g.V().values('age').fold(0) {a,b -> a + b} — 123
    test('fold(seed, reducer) summing all ages', () => {
      const r = arr(
        run(
          traversal(
            V(),
            values('age'),
            fold(0, (acc, v) => (acc as number) + (v as number)),
          ),
          tinkerGraph,
        ),
      );
      expect(r).toEqual([123]);
    });
  });
});
