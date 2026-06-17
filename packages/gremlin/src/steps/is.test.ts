import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gte, inside, lte } from '../predicates.js';
import { V, count, in_, is, mean, values, where } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP is tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it works with a simple number', () => {
      // v1's `is(32)` is shorthand for `is(eq(32))`. v2 always requires a predicate.
      const result = arr(run(traversal(V(), values('age'), is(eq(32))), tinkerGraph));
      expect(result).toEqual([32]);
    });

    test('it works with a comparator', () => {
      const result = arr(run(traversal(V(), values('age'), is(lte(30))), tinkerGraph));
      expect(result).toEqual([29, 27]);
    });

    // doc: g.V().values('age').is(inside(30, 40)) — 32; 35
    test('is(inside(30, 40)) — josh and peter', () => {
      const result = arr(run(traversal(V(), values('age'), is(inside(30, 40))), tinkerGraph));
      expect((result as number[]).sort()).toEqual([32, 35]);
    });

    test('it works with the inside predicate', () => {
      // age in (27, 35) → marko (29), josh (32). Strict open interval.
      const result = arr(run(traversal(V(), values('age'), is(inside(27, 35))), tinkerGraph));
      expect((result as number[]).sort()).toEqual([29, 32]);
    });

    // doc: g.V().where(__.in('created').count().is(1)).values('name')
    test('it works with WHERE', () => {
      const result = arr(
        run(
          traversal(
            V(),
            where((p) => is(eq(1))(count()(in_('CREATED')(p)))),
            values('name'),
          ),
          tinkerGraph,
        ),
      );
      expect(result).toEqual(['ripple']);
    });

    // doc: g.V().where(__.in('created').count().is(gte(2))).values('name')
    test('it works with WHERE 2', () => {
      const result = arr(
        run(
          traversal(
            V(),
            where((p) => is(gte(2))(count()(in_('CREATED')(p)))),
            values('name'),
          ),
          tinkerGraph,
        ),
      );
      expect(result).toEqual(['lop']);
    });

    // doc: where(__.in('created').values('age').mean().is(P.inside(30, 35)))
    test('it works with WHERE 3 (mean of in-creators inside open interval)', () => {
      // For each vertex v, look at v.in('CREATED').values('age').mean(); keep if
      // the mean is in (30, 35). Software vertices: lop's creators are
      // marko(29), josh(32), peter(35) → mean ≈ 32 (in (30,35)). ripple's
      // creator is josh(32) → 32. Persons have no incoming CREATED. Vadas:
      // none. So lop and ripple match.
      const result = arr(
        run(
          traversal(
            V(),
            where((p) => is(inside(30, 35))(mean()(values('age')(in_('CREATED')(p))))),
            values('name'),
          ),
          tinkerGraph,
        ),
      );
      expect((result as string[]).sort()).toEqual(['lop', 'ripple']);
    });
  });
});
