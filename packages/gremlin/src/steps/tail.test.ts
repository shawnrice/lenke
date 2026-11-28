import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Scope, V, fold, hasLabel, order, tail, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP tail tests', () => {
    test('tail works', () => {
      const r = run(traversal(V(), hasLabel('PERSON'), values('name'), tail()), tinkerGraph);
      expect(arr(r)).toEqual(['peter']);
    });

    test('tail works with order', () => {
      const r = run(
        traversal(V(), hasLabel('PERSON'), values('name'), order(), tail()),
        tinkerGraph,
      );
      expect(arr(r)).toEqual(['vadas']);
    });

    test('tail works with order and an index', () => {
      const r1 = arr(
        run(traversal(V(), hasLabel('PERSON'), values('name'), order(), tail()), tinkerGraph),
      );
      const r2 = arr(
        run(traversal(V(), hasLabel('PERSON'), values('name'), order(), tail(1)), tinkerGraph),
      );
      expect(r1).toEqual(r2);
    });

    test('tail works with multiple items', () => {
      const r = run(traversal(V(), values('name'), order(), tail(3)), tinkerGraph);
      expect(arr(r)).toEqual(['peter', 'ripple', 'vadas']);
    });
  });

  /*
   * LOCAL SCOPE, which no test here reached (item 2480). `tailLocal` slices each traverser's own
   * iterable value rather than the stream, and it is reachable ONLY as `tail(Scope.local, n)` —
   * scope FIRST, matching `count(Scope.local)`/`order(Scope.local)`. `tail(n, Scope.local)` SILENTLY
   * IGNORES the scope and compiles to a global `{kind:'tail', n}`, which is why that spelling is
   * pinned below as a trap rather than left to be rediscovered.
   *
   * Ground truth is TinkerPop 3.7.3 on this same modern graph, run in the console:
   *
   *     g.V().values('age').fold().tail(Scope.local)     -> [35]
   *     g.V().values('age').fold().tail(Scope.local, 1)  -> [35]
   *     g.V().values('age').fold().tail(Scope.local, 2)  -> [[32, 35]]
   *     g.V().values('age').fold().limit(Scope.local)    -> No signature of method
   *
   * A route choice would be answer-equivalent and invisible to the differential suites, but this is
   * not a route choice — `tail(Scope.local)` returned the WHOLE list before the fix, a wrong answer
   * no existing test could see.
   */
  describe('STEP tail, LOCAL scope', () => {
    // The modern graph's ages in scan order, which these assertions depend on.
    const AGES = [29, 27, 32, 35];

    test('the fixture is in the order these expectations assume', () => {
      expect(arr(run(traversal(V(), values('age'), fold()), tinkerGraph))).toEqual([AGES]);
    });

    test('tail(Scope.local, n) takes the last n of each list value', () => {
      const r = run(traversal(V(), values('age'), fold(), tail(Scope.local, 2)), tinkerGraph);

      expect(arr(r)).toEqual([[32, 35]]);
    });

    test('tail(Scope.local) DEFAULTS n to 1, as TinkerPop and the Rust parser both do', () => {
      // THE BUG ITEM 2480 FIXED. The overload omitted the no-`n` form and the implementation used
      // `b!`, so an untyped call produced `n: undefined` ->
      // `arr.slice(arr.length - undefined)` = `arr.slice(NaN)` = the whole list.
      const r = run(traversal(V(), values('age'), fold(), tail(Scope.local)), tinkerGraph);

      expect(arr(r)).toEqual([[35]]);
      expect(arr(r)).not.toEqual([AGES]);
    });

    test('tail(Scope.local) and tail(Scope.local, 1) agree', () => {
      const a = arr(run(traversal(V(), values('age'), fold(), tail(Scope.local)), tinkerGraph));
      const b = arr(run(traversal(V(), values('age'), fold(), tail(Scope.local, 1)), tinkerGraph));

      expect(a).toEqual(b);
    });

    test('an n at or above the length returns the whole list unchanged', () => {
      for (const n of [AGES.length, AGES.length + 5]) {
        const r = run(traversal(V(), values('age'), fold(), tail(Scope.local, n)), tinkerGraph);

        expect(arr(r)).toEqual([AGES]);
      }
    });

    test('a NON-SLICEABLE value passes through untouched', () => {
      // `tailLocal` returns `v` as-is when `isSliceable(v)` is false, so local scope over a stream
      // of scalars is an identity — one row per vertex, not a slice of anything.
      const r = arr(run(traversal(V(), values('age'), tail(Scope.local, 2)), tinkerGraph));

      expect(r).toEqual(AGES);
    });

    test('tail(n, Scope.local) is a TYPE ERROR, and ignores the scope if forced', () => {
      /*
       * Pinned because it is a trap, not a feature: the arguments reversed compile to a GLOBAL
       * tail, so a caller who writes them this way gets the last n ROWS of the stream and no
       * error. Same class as `tree('k')` at item 2479, where a silently-dropped positional
       * argument made two arms identical and nearly closed a real finding as a null.
       */
      // Typed callers CANNOT write this at all: with the `tail(scope, n?)` overload in place,
      // `tail(2, Scope.local)` is `TS2345: Argument of type 'number' is not assignable to
      // parameter of type 'symbol'` — the typecheck gate caught exactly that in this test's first
      // draft. So the trap is compile-prevented, and only an untyped (JS, or cast) caller reaches
      // it. The cast is what makes that reachable here.
      const untypedTail = tail as unknown as (n: number, scope: symbol) => ReturnType<typeof tail>;
      const reversed = traversal(V(), values('age'), fold(), untypedTail(2, Scope.local));

      expect(reversed.steps.at(-1)).toEqual({ kind: 'tail', n: 2 });
      // One folded row in, one row out — the global tail cannot slice INTO the list.
      expect(arr(run(reversed, tinkerGraph))).toEqual([AGES]);
    });
  });
});
