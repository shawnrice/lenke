import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Scope, V, fold, order, range, skip, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, skip tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it gets the first three', () => {
      const r = run(traversal(V(), range(0, 3)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh']);
    });

    test('it can skip on the low end', () => {
      const r = run(traversal(V(), values('age'), skip(2)), tinkerGraph);
      expect(arr(r)).toEqual([32, 35]);
    });

    test('it can have an open end', () => {
      const r = run(traversal(V(), values('name'), skip(3)), tinkerGraph);
      expect(arr(r)).toEqual(['peter', 'lop', 'ripple']);
    });

    // doc: g.V().values('age').order() — 27; 29; 32; 35
    test('order() on age gives the natural ordering (sanity for skip)', () => {
      const r = arr(run(traversal(V(), values('age'), order()), tinkerGraph));
      expect(r).toEqual([27, 29, 32, 35]);
    });

    // doc: g.V().values('age').order().skip(2) — 32; 35
    test('order().skip(2) drops the two lowest ages', () => {
      const r = arr(run(traversal(V(), values('age'), order(), skip(2)), tinkerGraph));
      expect(r).toEqual([32, 35]);
    });

    // doc: skip(n) is equivalent to range(n, -1)
    test('skip(n) is equivalent to range(n, -1)', () => {
      const a = arr(run(traversal(V(), values('age'), order(), skip(2)), tinkerGraph));
      const b = arr(run(traversal(V(), values('age'), order(), range(2, -1)), tinkerGraph));
      expect(a).toEqual(b);
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

    test('skip(Scope.local, n) drops the first n of each list value', () => {
      const r = run(traversal(V(), values('age'), fold(), skip(Scope.local, 2)), tinkerGraph);

      expect(arr(r)).toEqual([[32, 35]]);
    });

    test('a local skip is equivalent to the matching local range', () => {
      // The global identity `skip(n) === range(n, -1)` is tested above; this is its local twin.
      const a = arr(run(traversal(V(), values('age'), fold(), skip(Scope.local, 2)), tinkerGraph));
      const b = arr(
        run(traversal(V(), values('age'), fold(), range(Scope.local, 2, 4)), tinkerGraph),
      );

      expect(a).toEqual(b);
    });

    test('a local skip past the end empties the list rather than the stream', () => {
      // One row still comes out — the ROW survives, its VALUE is empty. A global skip would have
      // dropped the row entirely, and conflating the two is the mistake this pins.
      const r = arr(run(traversal(V(), values('age'), fold(), skip(Scope.local, 9)), tinkerGraph));

      expect(r).toEqual([[]]);
      expect(r).toHaveLength(1);
    });

    test('a NON-SLICEABLE value passes through a local skip untouched', () => {
      const r = arr(run(traversal(V(), values('age'), skip(Scope.local, 2)), tinkerGraph));

      expect(r).toEqual([29, 27, 32, 35]);
    });

    test('skip(Scope.local) with no n is a TYPE ERROR here, as in TinkerPop', () => {
      // `No signature of method ... skip() ... (Scope)` there; does not compile here. Forced
      // through a cast it drops `n` and returns the list untouched — no correct value to default to,
      // so unlike `tail(Scope.local)` (item 2480) this one is right to refuse.
      const untyped = skip as unknown as (s: symbol) => ReturnType<typeof skip>;
      const forced = traversal(V(), values('age'), fold(), untyped(Scope.local));

      // JSON, because the forced step is not a valid `Step` either — `n` is required, so the
      // object literal fails `TS2769`. Same point as in `range.test.ts`.
      expect(JSON.stringify(forced.steps.at(-1))).toBe('{"kind":"skip","scope":"local"}');
      expect(arr(run(forced, tinkerGraph))).toEqual([[29, 27, 32, 35]]);
    });
  });
});
