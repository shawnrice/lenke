// `V().branch(values(k)).option(m, <arm>)….none(<arm>)` fused (item 2015).
//
// ⚠️⚠️ **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — the whole Gremlin suite passes either way.** The route
// assertions here are the only thing that can see a gate mutant ([[perf-gate-needs-its-own-test]]),
// and the answer assertions the only thing that can see a walk mutant, because the general
// `branchStep` answers identically.
//
// 🔑 THE FIXTURE'S THREE REQUIREMENTS, each because one semantic turns on it and the pricing fixture
// (`coalesce-vs-optional-1990.mjs`, where every vertex carries `n`) satisfies none of them:
//
//     1. THE TEST KEY IS MISSING on some vertex   -> `values(k)` yields NOTHING, so `sawResult` is
//                                                    false and the traverser goes to `default`,
//                                                    NOT to `option(undefined)`.
//     2. SOME VERTEX MATCHES NO OPTION            -> with no `none()` arm the row is DROPPED, which
//                                                    is the OPPOSITE of `choose`'s absent-else
//                                                    pass-through (item 2014's rung).
//     3. THE PROJECTED KEY IS MISSING on some FAR
//        vertex                                   -> `values(k)` drops it rather than emitting
//                                                    `undefined`.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  both,
  branch,
  constant,
  count,
  identity,
  in_,
  out,
  run,
  Scope,
  toArray,
  traversal,
  V,
  values,
  valueMap,
  id,
} from '../index.js';
import { branchValueHop } from './branch-value-hop.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * ⚠️ `t` IS THE TEST KEY AND IT IS SPARSE; `p` IS THE PROJECTED KEY AND IT IS SPARSER.
   *
   *     a  t=0  p=10    takes option(0) -> out(E)
   *     b  t=1  p=11    takes option(1) -> in_(E)
   *     c  t=2  p=12    matches NO option -> none() if present, else DROPPED
   *     d  t=0  (no p)  option(0) again, and its far end is used for the projection drop
   *     e  (no t) p=14  the test yields NOTHING -> default
   *     f  t=0          option(0) with NO out-edge at all, so an empty hop arm
   *     j  t=9          matches no option AND has no `p` — the IDENTITY arm's own drop
   *
   * ⚠️⚠️ **`j` IS HERE BECAUSE A MUTANT SURVIVED WITHOUT IT.** Removing the identity arm's
   * `!drops || own !== undefined` guard changed no answer, because every vertex that reached
   * `none(identity())` happened to carry `p`. So the fixture could see the HOP arm's drop (`a` hops
   * to `d`, which lacks `p`) and not the IDENTITY arm's, which is a different line of code.
   */
  for (const [id, props] of [
    ['a', { t: 0, p: 10 }],
    ['b', { t: 1, p: 11 }],
    ['c', { t: 2, p: 12 }],
    ['d', { t: 0 }],
    ['e', { p: 14 }],
    ['f', { t: 0 }],
    ['j', { t: 9 }],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { ...props } });
  }

  const E = (k: string, fr: string, t: string, l = 'E'): void => {
    g.addEdge({
      id: k,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(t)!,
      labels: [l],
      properties: {},
    });
  };

  E('e1', 'a', 'b'); // a -> b (p=11)
  E('e2', 'a', 'd'); // a -> d, and `d` has NO `p` — the projection drop
  E('e3', 'c', 'b'); // -> b has an inbound E, so option(1)'s in_(E) finds one
  E('e4', 'd', 'e', 'F'); // an F edge only
  // `f` has no edge of any type.

  return g;
};

describe('branchValueHop: the route', () => {
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean => branchValueHop(t, g) !== undefined;

  test('TAKES a values test with hop and identity arms, with and without none()', () => {
    expect(
      routed(
        traversal(
          V(),
          branch(values('t')).option(0, out('E')).option(1, in_('E')).none(identity()),
          values('p'),
        ),
      ),
    ).toBe(true);
    // No `none()` — admitted as a DROP, not declined.
    expect(routed(traversal(V(), branch(values('t')).option(0, out('E')), values('p')))).toBe(true);
    // `both`, an untyped hop, a multi-type hop, and no projection at all.
    expect(routed(traversal(V(), branch(values('t')).option(0, both('E')).none(identity())))).toBe(
      true,
    );
    expect(routed(traversal(V(), branch(values('t')).option(0, out()).none(identity())))).toBe(
      true,
    );
    expect(
      routed(traversal(V(), branch(values('t')).option(0, out('E', 'F')).none(identity()))),
    ).toBe(true);
  });

  test('TAKES string and boolean option keys', () => {
    expect(routed(traversal(V(), branch(values('t')).option('x', out('E')).none(identity())))).toBe(
      true,
    );
    expect(
      routed(traversal(V(), branch(values('t')).option(true, out('E')).none(identity()))),
    ).toBe(true);
  });

  test('DECLINES an option key a raw Map cannot key the way `tupleKey` does', () => {
    /*
     * ⚠️⚠️ A MUTANT HERE IS A WRONG ANSWER, NOT A SLOW ONE. `branchStep` matches through
     * `tupleKey([match])`, which compares a list/map STRUCTURALLY and renders `NaN` as `"null"`;
     * this rung's `Map` compares by SameValueZero, which does neither. So both shapes must stay on
     * the general loop, where `tupleKey` still does the structural thing.
     */
    expect(routed(traversal(V(), branch(values('t')).option([1], out('E')).none(identity())))).toBe(
      false,
    );
    expect(
      routed(traversal(V(), branch(values('t')).option({ a: 1 }, out('E')).none(identity()))),
    ).toBe(false);
    expect(
      routed(traversal(V(), branch(values('t')).option(Number.NaN, out('E')).none(identity()))),
    ).toBe(false);
    expect(
      routed(traversal(V(), branch(values('t')).option(null, out('E')).none(identity()))),
    ).toBe(false);
  });

  test('DECLINES a test that is not a single-key values', () => {
    // A HOP test is `choose`'s question and a different cost — and `branch` over a hop test asks
    // which FAR VERTEX came first, which no property read can answer.
    expect(routed(traversal(V(), branch(out('E')).option(0, out('E')).none(identity())))).toBe(
      false,
    );
    // `values()` with no key emits every property value; `values(a, b)` fans out per key. Neither
    // has a single first result a property read reproduces.
    expect(routed(traversal(V(), branch(values()).option(0, out('E')).none(identity())))).toBe(
      false,
    );
    expect(
      routed(traversal(V(), branch(values('t', 'p')).option(0, out('E')).none(identity()))),
    ).toBe(false);
    // A multi-step test.
    expect(
      routed(traversal(V(), branch(traversal(values('t'), identity())).option(0, out('E')))),
    ).toBe(false);
  });

  test('DECLINES an arm shape it cannot serve, in an option OR in none()', () => {
    /*
     * ⚠️⚠️ A REFUSED `none()` MUST DECLINE THE WHOLE SHAPE, NOT BE READ AS AN ABSENT ONE. An absent
     * `none()` DROPS an unmatched traverser, so `?? undefined` on a refused arm would silently
     * delete every row the engine routes there. That is the mirror of item 2014's else-arm mutant,
     * which was also a wrong answer rather than a slow one.
     */
    expect(
      routed(traversal(V(), branch(values('t')).option(0, out('E')).none(constant('x')))),
    ).toBe(false);
    expect(
      routed(traversal(V(), branch(values('t')).option(0, constant('x')).none(identity()))),
    ).toBe(false);
    // A MULTI-STEP arm, in each position — `optionalSingleHop` requires exactly one step.
    expect(
      routed(
        traversal(
          V(),
          branch(values('t'))
            .option(0, traversal(out('E'), out('E')))
            .none(identity()),
        ),
      ),
    ).toBe(false);
    expect(
      routed(
        traversal(
          V(),
          branch(values('t'))
            .option(0, out('E'))
            .none(traversal(out('E'), out('E'))),
        ),
      ),
    ).toBe(false);
  });

  test('DECLINES a multi-key projection and a narrowed source', () => {
    expect(
      routed(
        traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), values('p', 't')),
      ),
    ).toBe(false);
    expect(
      routed(traversal(V('a'), branch(values('t')).option(0, out('E')).none(identity()))),
    ).toBe(false);
  });
});

describe('branchValueHop: the answers', () => {
  const g = build();
  const rows = (t: ReturnType<typeof traversal>): unknown[] => toArray(t, g);
  const ids = (t: ReturnType<typeof traversal>): unknown[] =>
    rows(t).map((x) => (x as { id: string }).id);

  test('a MISSING test key routes to none(), not to option(undefined)', () => {
    /*
     * ⚠️ THE CENTRAL ASSERTION FOR THE TEST SIDE. `e` has no `t`, so `values('t')` yields nothing,
     * `branchStep`'s `sawResult` stays false and no option can match — it takes `none()`. A route
     * reading `props['t']` as `undefined` and looking THAT up would agree here only because no
     * option is keyed `undefined`; the `option(undefined)` form is declined by the gate (`null` and
     * `NaN` aside, `undefined` is not `keyable`), so `in` is what keeps the two equivalent.
     */
    expect(ids(traversal(V(), branch(values('t')).option(0, out('E')).none(identity())))).toEqual([
      // a (t=0) -> out(E): b, d
      'b',
      'd',
      // b (t=1) matches no option -> none() -> itself
      'b',
      // c (t=2) -> none() -> itself
      'c',
      // d (t=0) -> out(E): nothing (d's only edge is F)
      // e (no t) -> none() -> ITSELF, the assertion
      'e',
      // f (t=0) -> out(E): no edges at all
      // j (t=9) -> none() -> itself
      'j',
    ]);
  });

  test('DECLINES `option(undefined)`, which the walk DEPENDS on rather than merely tolerating', () => {
    /*
     * ⚠️⚠️ THIS PINS A COUPLING, NOT A PREFERENCE. `branchWalk` has NO `testKey in props` check — a
     * vertex lacking the test key reads as `undefined` and falls to the fallback, which is right
     * ONLY because no option can be keyed `undefined`. Widen `keyable` to admit it and the walk
     * silently answers the fallback where the engine answers that option.
     */
    expect(
      branchValueHop(
        traversal(V(), branch(values('t')).option(undefined, out('E')).none(identity())),
        g,
      ),
    ).toBeUndefined();
  });

  test('NO none() DROPS an unmatched row — the opposite of `choose`’s absent else', () => {
    // Only `a` and `d` and `f` (t=0) are routed at all, and only `a` has an `E` out-edge.
    expect(ids(traversal(V(), branch(values('t')).option(0, out('E'))))).toEqual(['b', 'd']);
    // `b`, `c` and `e` are gone entirely: 3 rows, not 6. `chooseStep` would have passed them through.
    expect(rows(traversal(V(), branch(values('t')).option(0, out('E'))))).toHaveLength(2);
  });

  test('the INWARD arm reads the inward adjacency', () => {
    // `b` (t=1) -> in_(E): a and c both point at b.
    expect(ids(traversal(V(), branch(values('t')).option(1, in_('E'))))).toEqual(['a', 'c']);
  });

  test('`values(k)` on the projection DROPS a far vertex lacking k', () => {
    /*
     * ⚠️ `a` hops to `b` (p=11) and `d` (NO p). So the `out(E)` arm contributes ONE row, not two —
     * `projectValues`' own `k in props` rule, which `drops` carries. A route emitting `undefined`
     * would give an extra row here and nowhere else in this file.
     */
    /*
     * ⚠️⚠️ **`toStrictEqual`, NOT `toEqual`, AND A SURVIVING MUTANT IS WHY.** `expect([11, 12,
     * undefined]).toEqual([11, 12])` PASSES in bun — `toEqual` treats a trailing `undefined` as
     * equal to its absence. So `toEqual` is structurally blind to a route that emits `undefined`
     * where the engine drops the row, which is the ONE thing `values(k)` semantics turn on, and it
     * is blind precisely when the dropped row is LAST. (Item 2014's twin assertion escaped this only
     * because its `undefined` would have landed mid-array and shifted every later position.)
     */
    expect(
      rows(traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), values('p'))),
    ).toStrictEqual([
      11, // a -> b.p ; a -> d has no p and is DROPPED
      11, // b -> none() -> its own p
      12, // c -> none()
      // d -> out(E) finds nothing
      14, // e -> none()
      // f -> none()? no: f has t=0, so it takes option(0) and finds no edge
    ]);
  });

  test('the `id` projection and no projection at all', () => {
    expect(
      rows(traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), identity())),
    ).toHaveLength(6);
    const byId = rows(traversal(V(), branch(values('t')).option(0, out('E')).none(identity()))).map(
      (x) => (x as { id: string }).id,
    );

    expect(byId).toEqual(['b', 'd', 'b', 'c', 'e', 'j']);
  });

  test('FIRST WINS on a duplicate option key, as `indexOf` decides', () => {
    // Two `option(0, …)` arms: the engine resolves through `optionKeys.indexOf`, so the SECOND is
    // unreachable. `a` must hop OUT (b, d), not IN.
    expect(
      ids(traversal(V(), branch(values('t')).option(0, out('E')).option(0, in_('E')))),
    ).toEqual(['b', 'd']);
  });

  test('THE GENERATOR AND THE DRAIN AGREE, positionally, on every shape', () => {
    /*
     * ⚠️⚠️ **WITHOUT THIS, EVERY ASSERTION IN THIS FILE TESTS THE `drain` AND NOT THE GENERATOR.**
     * `toArray` prefers `drain` when the walk offers one and `rest` is empty (item 1412), so the
     * `[Symbol.iterator]` body — the one a lazy consumer and any trailing step actually reach — is
     * UNEXERCISED by `rows()` above. The two fills are the same loop written twice (item 169's
     * rule), which is exactly the shape that drifts; `run` is the lazy entry, so spreading it is
     * what reaches the generator.
     *
     * Gremlin results are compared ORDERED against the Rust engine, so a disagreement here would be
     * a cross-engine failure rather than a style question.
     */
    const shapes = [
      traversal(V(), branch(values('t')).option(0, out('E')).option(1, in_('E')).none(identity())),
      traversal(V(), branch(values('t')).option(0, out('E'))),
      traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), values('p')),
      traversal(V(), branch(values('t')).option(0, identity()).none(out('E')), values('p')),
      traversal(V(), branch(values('t')).option(0, both('E')).none(identity()), values('p')),
      traversal(V(), branch(values('t')).option(0, out()).none(identity()), values('p')),
      traversal(V(), branch(values('t')).option(1, in_('E')).none(identity())),
    ];

    for (const t of shapes) {
      expect([...run(t, g)]).toStrictEqual(toArray(t, g));
    }

    // And the drain IS being reached for the projected form — otherwise the check above compares
    // the generator with itself and proves nothing.
    const projected = traversal(
      V(),
      branch(values('t')).option(0, out('E')).none(identity()),
      values('p'),
    );

    expect(typeof (run(projected, g) as { drain?: unknown }).drain).toBe('function');
  });

  test('a trailing step after the wrapper still runs', () => {
    expect(
      rows(
        traversal(
          V(),
          branch(values('t')).option(0, out('E')).none(identity()),
          values('p'),
          identity(),
        ),
      ),
    ).toStrictEqual([11, 11, 12, 14]);
  });
});

describe('a residual count() rides the walk (item 2028)', () => {
  /*
   * ⚠️⚠️ **`count()` USED TO DECLINE THE ENTIRE PLAN**, so the route census read this family's count
   * shape GENERIC — and for `choose`/`branch` with **4002 `applyStep` calls**, the sub-plan
   * re-dispatched per traverser, which is the exact cost the rung exists to remove. A `pickFor` audit
   * found FOUR rungs carrying the gap item 1956 closed for the edge-filter rung and item 2027 for
   * the `optional` one.
   *
   * ⚠️ ANSWER-EQUIVALENT, so the route assertion is the only thing that can see the rung declining
   * ([[perf-gate-needs-its-own-test]]) — and the RESIDUAL'S CONTENT is asserted, not its presence
   * (item 2021: a wrong `rest` still returns an object, then declines downstream with the same
   * answer).
   *
   * ⚠️ THE GATE NEED NOT CHECK `count`'s SCOPE, where item 2020's FUSED count must: an unconsumed
   * terminal is still run by its own step, so `Scope.local` is honoured by `countStep` itself.
   */
  const g = build();

  test('THE ROUTE: the rung claims the count shape and reports it as the residual', () => {
    const claimed = branchValueHop(
      traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), count()),
      g,
    );

    expect(claimed?.rest.map((st) => st.kind)).toEqual(['count']);

    // The `values` sibling CONSUMES its projection, so its residual is empty — the other side of
    // the same `consumed` flag.
    expect(
      branchValueHop(
        traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), values('p')),
        g,
      )?.rest,
    ).toEqual([]);
  });

  test('the `id()` shape CONSUMES its projection — a perf contract with no answer to see', () => {
    /*
     * ⚠️⚠️ **A MUTANT MARKING `id` UNCONSUMED SURVIVED BOTH THIS FILE AND THE WHOLE SUITE.** Leaving
     * `id` in `rest` still answers correctly: the step simply runs over the walk's ELEMENTS and maps
     * them to ids, which is the same result by a slower route. So only the residual's emptiness can
     * see it — the same shape as item 2021's three wrong-residual mutants.
     */
    expect(
      branchValueHop(
        traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), id()),
        g,
      )?.rest,
    ).toEqual([]);
  });

  test('a projection kind the walk cannot serve DECLINES', () => {
    /*
     * ⚠️ A MUTANT ADMITTING ANY KIND (`return true ? …`) SURVIVED: an element pick plus a residual is
     * broadly answer-equivalent, because the leftover step just runs over elements. It is still a
     * route this item never measured, and the gate is meant to name exactly what it serves — so the
     * decline is asserted rather than left to the next reader to discover.
     */
    expect(
      branchValueHop(
        traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), valueMap()),
        g,
      ),
    ).toBeUndefined();
  });

  test('the count equals the row count of the same walk without it', () => {
    /*
     * 🔑 THE ORACLE IS THE SHAPE WITHOUT `count()`: its `rest` is empty, so it takes the walk
     * directly and does not share the code under test. A non-empty row list is asserted first,
     * because 0 === 0 agrees trivially.
     */
    const rows = toArray(
      traversal(V(), branch(values('t')).option(0, out('E')).none(identity())),
      g,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(
      toArray(
        traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), count()),
        g,
      )[0],
    ).toBe(rows.length);
  });

  test('`count(Scope.local)` matches the narrowed-source twin, which this rung declines', () => {
    const fast = toArray(
      traversal(V(), branch(values('t')).option(0, out('E')).none(identity()), count(Scope.local)),
      g,
    );

    expect(fast).toEqual(
      toArray(
        traversal(
          V('a', 'b', 'c', 'd', 'e', 'f', 'j'),
          branch(values('t')).option(0, out('E')).none(identity()),
          count(Scope.local),
        ),
        g,
      ),
    );
  });
});
