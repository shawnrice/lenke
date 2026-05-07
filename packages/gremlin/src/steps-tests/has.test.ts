import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { inside, outside, startsWith, within } from '../predicates.js';
import { V, has, hasLabel, out, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('has tests', () => {
    test('we can filter using has with a predicate', () => {
      const result = arr(
        run(
          traversal(V(), hasLabel('PERSON'), out(), has('name', within('vadas', 'josh'))),
          tinkerGraph,
        ),
      ) as Array<{ id: string }>;
      expect(result.map((x) => x.id)).toEqual(['2', '4']);
    });

    test('we can chain filters using with predicates', () => {
      const result = arr(
        run(
          traversal(
            V(),
            hasLabel('PERSON'),
            out(),
            has('name', within('vadas', 'josh')),
            outE(),
            hasLabel('CREATED'),
          ),
          tinkerGraph,
        ),
      ) as Array<{ id: string }>;
      expect(result.map((x) => x.id)).toEqual(['10', '11']);
    });

    // Ages: marko=29, vadas=27, josh=32, peter=35.
    test('has(key, inside) — strict open interval', () => {
      // age in (28, 33) → marko (29), josh (32).
      const result = arr(
        run(
          traversal(V(), hasLabel('PERSON'), has('age', inside(28, 33)), values('name')),
          tinkerGraph,
        ),
      );
      expect((result as string[]).sort()).toEqual(['josh', 'marko']);
    });

    test('has(key, outside) — strict complement', () => {
      // age < 29 || > 32 → vadas (27), peter (35).
      const result = arr(
        run(
          traversal(V(), hasLabel('PERSON'), has('age', outside(29, 32)), values('name')),
          tinkerGraph,
        ),
      );
      expect((result as string[]).sort()).toEqual(['peter', 'vadas']);
    });

    test('we can do startsWith filtering', () => {
      // v1 used has('PERSON', 'name', P.startingWith('m')) — three-arg form
      // (label, key, pred). v2 has() is two-arg, so combine hasLabel + has.
      const result = arr(
        run(traversal(V(), hasLabel('PERSON'), has('name', startsWith('m'))), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(result.map((x) => x.id)).toEqual(['1']);
    });

    // v2 has() requires a predicate — single-arg "has key exists" form is not
    // implemented.
    test.skip('we can filter just by key (key-only has not in v2)', () => {});

    // v1's has(null, 'vadas') edge case — n/a in v2 since key is required.
    test.skip('calling with a first arg of null is empty (n/a in v2)', () => {});
  });
});
