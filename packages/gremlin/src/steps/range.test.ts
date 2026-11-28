import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Scope, V, fold, range, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, range tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it gets the first three', () => {
      const r = run(traversal(V(), range(0, 3)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh']);
    });

    test('it can skip on the low end', () => {
      const r = run(traversal(V(), range(3, 5)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['peter', 'lop']);
    });

    test('it can have an open end', () => {
      const r = run(traversal(V(), range(3, -1)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['peter', 'lop', 'ripple']);
    });

    // doc: g.V().range(0, 3) — v[1]; v[2]; v[3]
    test('range(0, 3) yields the first three vertices', () => {
      const xs = arr(run(traversal(V(), range(0, 3)), tinkerGraph)) as Array<{
        id: string;
      }>;
      // v2 fixture order: 1, 2, 4, 6, 3, 5
      expect(xs.map((v) => v.id)).toEqual(['1', '2', '4']);
    });

    // doc: g.V().range(1, 3) — v[2]; v[3]
    test('range(1, 3) skips first and yields next two', () => {
      const xs = arr(run(traversal(V(), range(1, 3)), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(xs.map((v) => v.id)).toEqual(['2', '4']);
    });

    // doc: g.V().range(1, -1) — v[2]; v[3]; v[4]; v[5]; v[6]
    test('range(1, -1) skips first and emits the rest', () => {
      const xs = arr(run(traversal(V(), range(1, -1)), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(xs.map((v) => v.id)).toEqual(['2', '4', '6', '3', '5']);
    });
    /*
     * LOCAL SCOPE, which no test in this file reached (item 2481). Every value below was taken from
     * TinkerPop 3.7.3 in the console on this same modern graph, whose ages fold to
     * `[29, 27, 32, 35]`:
     *
     *     g.V().values('age').fold().range(Scope.local, 1, 3)  -> [[27, 32]]
     *     g.V().values('age').fold().skip(Scope.local, 2)      -> [[32, 35]]
     *     g.V().values('age').fold().range(Scope.local, 1)     -> No signature of method
     *     g.V().values('age').fold().skip(Scope.local)         -> No signature of method
     *
     * Item 2480 fixed a real wrong answer in `tail(Scope.local)` — the overload omitted the no-`n`
     * form TinkerPop DOES have, and `b!` made it `n: undefined`, so `arr.slice(NaN)` returned the
     * whole list. The obvious follow-up was to widen that fix to this family, and the console says
     * NOT to: TinkerPop has no single-argument `range(Scope)`/`skip(Scope)`/`limit(Scope)`, so
     * requiring the bound here is correct and `tail` was rightly the only one changed.
     *
     * These tests pin the AGREEMENTS so the family cannot drift, and the one deviation is named
     * where it bites.
     */

    test('range(Scope.local, lo, hi) slices WITHIN each list value', () => {
      const r = run(traversal(V(), values('age'), fold(), range(Scope.local, 1, 3)), tinkerGraph);

      expect(arr(r)).toEqual([[27, 32]]);
    });

    test('a local range is a slice of ONE row, not a window over the stream', () => {
      // The global form with the same bounds answers a different question on the same data, which
      // is the whole point of the scope argument.
      const local = arr(
        run(traversal(V(), values('age'), fold(), range(Scope.local, 1, 3)), tinkerGraph),
      );
      const global = arr(run(traversal(V(), values('age'), range(1, 3)), tinkerGraph));

      expect(local).toEqual([[27, 32]]);
      expect(global).toEqual([27, 32]);
    });

    test('a local range whose window covers the list returns it unchanged', () => {
      const r = run(traversal(V(), values('age'), fold(), range(Scope.local, 0, 4)), tinkerGraph);

      expect(arr(r)).toEqual([[29, 27, 32, 35]]);
    });

    test('a NON-SLICEABLE value passes through a local range untouched', () => {
      const r = arr(run(traversal(V(), values('age'), range(Scope.local, 0, 2)), tinkerGraph));

      expect(r).toEqual([29, 27, 32, 35]);
    });

    test('range(Scope.local, lo) with no high bound is a TYPE ERROR here, as in TinkerPop', () => {
      /*
       * TinkerPop answers `No signature of method ... range() ... (Scope, Integer)`, and the
       * overloads here likewise require both bounds — `range(Scope.local, 1)` does not compile.
       * Forced through a cast it yields `{kind:'range', start:1, scope:'local'}` with NO `end` and
       * silently drops the high bound, which is why no default was added: there is no correct
       * answer to default TO.
       */
      const untyped = range as unknown as (s: symbol, lo: number) => ReturnType<typeof range>;
      const forced = traversal(V(), values('age'), fold(), untyped(Scope.local, 1));

      // Asserted as JSON because the forced step is NOT A VALID `Step`: the AST type requires
      // `end: number`, so `toEqual({kind:'range', start:1, scope:'local'})` is itself `TS2769`.
      // The typechecker proving the node is malformed is a stronger statement than the assertion
      // was going to make.
      expect(JSON.stringify(forced.steps.at(-1))).toBe(
        '{"kind":"range","start":1,"scope":"local"}',
      );
      expect(arr(run(forced, tinkerGraph))).toEqual([[27, 32, 35]]);
    });
  });
});
