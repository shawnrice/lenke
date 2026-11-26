// `V().choose(<vertex filter>, <one hop>, <one hop>).values(k)` fused (item 1999).
//
// **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — the 2,447-test suite passes either way.** The route
// assertions here are the only thing that can see a gate mutant
// ([[perf-gate-needs-its-own-test]]), and the answer assertions the only thing that can see a walk
// mutant, because the general `chooseStep` answers identically.
//
// FOUR THINGS THIS FILE EXISTS FOR, each of which a naive test misses:
//
//   1. **BOTH ARMS LIVE.** The fixture's test holds for 2 of 6 vertices. A fixture where the test
//      holds everywhere exercises only the `then` arm — and on the workload screen's own row the
//      test sends **96 of every 97 vertices to the ELSE arm**, so the minority arm is the one a
//      careless fixture would cover.
//   2. **THREE ASKS.** Both CSR arms sit behind `seenBefore` (item 1889's second-ask policy), so
//      ask 1 takes `chooseWalk` and asks 2+ take `csrBothArms`. A single-ask test exercises half
//      the module; item 1983 lost a verdict to exactly this.
//   3. **AN INDEXED TEST KEY.** `collectVertexFilters` defaults to REFUSING a filter an index could
//      seek, and this route passes `false` deliberately — a `choose` must visit the non-survivors,
//      so a seek is not merely unhelpful but wrong. Without an indexed-key test, the mutant that
//      restores the default passes.
//   4. **AN ABSENT ELSE ARM.** Per TinkerPop the traverser PASSES THROUGH; `chooseStep`'s own
//      comment records this against the AST comment, which reads the other way.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  both,
  choose,
  constant,
  count,
  has,
  hasKey,
  hasLabel,
  id,
  identity,
  in_,
  out,
  Scope,
  toArray,
  traversal,
  V,
  values,
} from '../index.js';
import { chooseHopValues } from './choose-hop-values.js';

/** `n === 0` for `a` and `c` only; `f` has NO `n` at all, so it fails the test AND drops as a far end. */
const VERTS: readonly [string, number | undefined, readonly string[]][] = [
  ['a', 0, ['P']],
  ['b', 7, ['P']],
  ['c', 0, ['P', 'Q']],
  ['d', 3, ['Q']],
  ['e', 9, ['P']],
  ['f', undefined, ['P']],
];

const build = (): Graph => {
  const g = new Graph();

  for (const [vid, n, labels] of VERTS) {
    g.addVertex({ id: vid, labels: [...labels], properties: n === undefined ? {} : { n } });
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

  E('e1', 'a', 'b');
  E('e2', 'a', 'b'); // PARALLEL
  E('e3', 'b', 'c');
  E('e4', 'c', 'c'); // SELF-LOOP
  E('e5', 'd', 'a');
  E('e6', 'e', 'a', 'F'); // only an F edge — a sink for E in BOTH directions
  E('e7', 'a', 'f'); // reaches the vertex with no `n`

  return g;
};

/** Rows, asked THREE times — ask 1 is `chooseWalk`, asks 2-3 `csrBothArms`. All must agree. */
const stableRows = (g: Graph, make: () => ReturnType<typeof traversal>): unknown[] => {
  const one = toArray(make(), g);
  const two = toArray(make(), g);
  const three = toArray(make(), g);

  expect(two).toEqual(one);
  expect(three).toEqual(one);

  return one;
};

describe('chooseHopValues: the route', () => {
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean => chooseHopValues(t, g) !== undefined;

  test('TAKES a `has` test with two single hops', () => {
    expect(routed(traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')))).toBe(true);
  });

  test('TAKES a `hasLabel` test and a MULTI-STEP filter test', () => {
    expect(routed(traversal(V(), choose(hasLabel('Q'), out('E'), in_('E')), values('n')))).toBe(
      true,
    );
    expect(
      routed(
        traversal(
          V(),
          choose(traversal(hasLabel('Q'), has('n', 0)), out('E'), in_('E')),
          values('n'),
        ),
      ),
    ).toBe(true);
  });

  test('TAKES the absent-else, `id` and no-projection forms', () => {
    expect(routed(traversal(V(), choose(has('n', 0), out('E')), values('n')))).toBe(true);
    expect(routed(traversal(V(), choose(has('n', 0), out('E'), in_('E')), id()))).toBe(true);
    expect(routed(traversal(V(), choose(has('n', 0), out('E'), in_('E'))))).toBe(true);
  });

  test('TAKES a test on an INDEXED key — a `choose` test must never be seeked', () => {
    // `collectVertexFilters` REFUSES a seekable filter by default, which is right for a filter
    // route (hand it to the seek) and wrong here: a seek narrows to the survivors, and `choose`
    // emits for the NON-survivors too — they are exactly who takes the else arm. So the route
    // passes `refuseSeekable: false`, and without this test the mutant restoring the default
    // passes, declining the route on precisely the graphs that have an index.
    const indexed = build();

    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

    expect(
      chooseHopValues(
        traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
        indexed,
      ),
    ).toBeDefined();
  });

  test('the CSR arms wait for the SECOND ask', () => {
    // A performance POLICY, so answer-identical and invisible to every answer test — but it needs
    // no timing: only `csrBothArms` carries an eager `drain`, so which walk was handed back is
    // readable straight off the returned object.
    const fresh = build();
    const ask = (): object => {
      const got = chooseHopValues(
        traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
        fresh,
      );

      expect(got).toBeDefined();

      return got!.values as object;
    };

    expect('drain' in ask()).toBe(false);
    expect('drain' in ask()).toBe(true);
  });

  test('TAKES a `hasKey` test — the guard that declined it was narrower than the admission', () => {
    // `collectVertexFilters` compiles a single-key `hasKey` into a `present` predicate, and the
    // `every(isVertexFilterStep)` guard that once stood in front of it did NOT admit `hasKey` — so
    // the guard declined this shape while reading like a safety check. The mutation round found it
    // by SURVIVING its own deletion. This test is what keeps the widened surface honest.
    expect(routed(traversal(V(), choose(hasKey('n'), out('E'), in_('E')), values('n')))).toBe(true);
  });

  test('TAKES an EMPTY test plan, which is TRUE for every vertex', () => {
    // `chooseStep` runs the test as "does this plan produce anything", and an empty plan yields the
    // traverser — so an empty test takes the `then` arm always, which is what zero gates answer.
    expect(routed(traversal(V(), choose(traversal(), out('E'), in_('E')), values('n')))).toBe(true);
  });

  test('the CSR walk waits for EVERY eligible arm, not just one', () => {
    // A PERFORMANCE POLICY, answer-identical, and the third survivor of the mutation round until
    // this test existed. With only one arm warm, `csrBothArms` would leave the other eligible arm on
    // the per-vertex bucket path — correct, but it commits the walk before the cheap route exists
    // for half the vertices. Readable without timing: only `csrBothArms` carries a `drain`.
    const fresh = build();
    const asked = (t: ReturnType<typeof traversal>): object =>
      (chooseHopValues(t, fresh) as { values: object }).values;

    // Warm ONLY the forward E CSR — `chainCsrFor`'s cache entry is shared with every single-hop
    // caller, so two bare `out('E')` asks arm the `then` arm and leave `in_('E')` cold.
    toArray(traversal(V(), out('E'), values('n')), fresh);
    toArray(traversal(V(), out('E'), values('n')), fresh);

    // One arm warm, one cold: the route must still hand back the bucket walk.
    expect(
      'drain' in asked(traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n'))),
    ).toBe(false);
  });

  test('DECLINES a HOP test — that asks whether an edge exists, not a vertex predicate', () => {
    expect(routed(traversal(V(), choose(out('E'), values('n'), constant('none'))))).toBe(false);
    // THE ARMS MUST BE VALID FOR THIS TO TEST THE TEST. The shape above also has a non-hop
    // `then` arm, so it declines on the ARM check and never reaches the filter admission at all —
    // which is why the mutant that ignored `collectVertexFilters` returning `undefined` SURVIVED
    // the first mutation round. This shape has two legal hop arms, so the only thing that can
    // decline it is the test.
    expect(routed(traversal(V(), choose(out('E'), out('E'), in_('E')), values('n')))).toBe(false);
  });

  test('DECLINES an identity arm and a two-step arm', () => {
    expect(routed(traversal(V(), choose(has('n', 0), identity(), out('E')), values('n')))).toBe(
      false,
    );
    expect(
      routed(traversal(V(), choose(has('n', 0), traversal(out('E'), out('E')), in_('E')))),
    ).toBe(false);
  });

  test('DECLINES a narrowed source and a multi-key projection', () => {
    expect(routed(traversal(V('a'), choose(has('n', 0), out('E'), in_('E')), values('n')))).toBe(
      false,
    );
    expect(routed(traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n', 'x')))).toBe(
      false,
    );
  });
});

describe('chooseHopValues: the answers', () => {
  test('BOTH arms run, and the answer is neither arm alone', () => {
    const g = build();
    const rows = stableRows(g, () =>
      traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
    );

    // `a` and `c` pass the test and take `out('E')`; `b`, `d`, `e`, `f` fail it and take `in_('E')`.
    // THE ANSWER MUST MATCH NEITHER BARE HOP — if it equals one of them the route collapsed to a
    // single arm, which every other assertion in this file would still pass.
    expect(rows).not.toEqual(toArray(traversal(V(), out('E'), values('n')), g));
    expect(rows).not.toEqual(toArray(traversal(V(), in_('E'), values('n')), g));
    expect(rows).toEqual([7, 7, 0, 0, 0, 0]);
  });

  test('an ABSENT else arm PASSES THE TRAVERSER THROUGH, it does not drop it', () => {
    const g = build();
    const rows = stableRows(g, () => traversal(V(), choose(has('n', 0), out('E')), values('n')));

    // `a`, `c` take the hop; `b`, `d`, `e` pass through as themselves; `f` passes through but has no
    // `n`, so the projection drops it. An arm that dropped non-survivors would give [7, 7, 0].
    expect(rows).toEqual([7, 7, 7, 0, 3, 9]);
  });

  test('a MIXED walk — one CSR arm, one bucket arm — agrees across all three asks', () => {
    const g = build();

    // `both` and a multi-type hop both decline the CSR, so these run one arm fused and one not.
    expect(
      stableRows(g, () => traversal(V(), choose(has('n', 0), both('E'), in_('E')), values('n'))),
    ).toEqual([7, 7, 3, 0, 0, 0, 7, 0, 0]);
    expect(
      stableRows(g, () =>
        traversal(V(), choose(has('n', 0), out('E', 'F'), out('E')), values('n')),
      ),
    ).toEqual([7, 7, 0, 0, 0]);
  });

  test('a test on a MISSING property fails, sending that vertex to the else arm', () => {
    const g = build();
    // `f` has no `n`. `has('n', 0)` must be false for it (not a throw, not a pass), so it takes
    // `in_('E')` and finds `a` — whose `n` is 0.
    const rows = stableRows(g, () =>
      traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
    );

    // The last row is `f`'s, via the else arm.
    expect(rows.at(-1)).toBe(0);
  });

  test('PARALLEL edges and a SELF-LOOP keep their multiplicity', () => {
    const g = build();
    // `a` passes the test, so its two parallel edges to `b` both emit; `c` passes and its self-loop
    // emits once.
    const rows = stableRows(g, () =>
      traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
    );

    expect(rows.filter((x) => x === 7)).toHaveLength(2); // a -> b twice
    expect(rows).toHaveLength(6);
  });

  test('the ORDER is vertex order, which the CSR arm must not change', () => {
    const g = build();
    // Projecting `id` makes the order readable. Gremlin compares a single-type step ORDERED against
    // native, so a route that walked the CSR slots in a different order than `graph.vertices` would
    // be a cross-engine failure rather than a style difference.
    expect(
      stableRows(g, () => traversal(V(), choose(has('n', 0), out('E'), in_('E')), id())),
    ).toEqual(['b', 'b', 'f', 'a', 'a', 'c', 'a']);
  });
});

describe('a residual count() rides the walk (item 2028)', () => {
  /*
   * **`count()` USED TO DECLINE THE ENTIRE PLAN**, so the route census read this family's count
   * shape GENERIC — and for `choose`/`branch` with **4002 `applyStep` calls**, the sub-plan
   * re-dispatched per traverser, which is the exact cost the rung exists to remove. A `pickFor` audit
   * found FOUR rungs carrying the gap item 1956 closed for the edge-filter rung and item 2027 for
   * the `optional` one.
   *
   * ANSWER-EQUIVALENT, so the route assertion is the only thing that can see the rung declining
   * ([[perf-gate-needs-its-own-test]]) — and the RESIDUAL'S CONTENT is asserted, not its presence
   * (item 2021: a wrong `rest` still returns an object, then declines downstream with the same
   * answer).
   *
   * THE GATE NEED NOT CHECK `count`'s SCOPE, where item 2020's FUSED count must: an unconsumed
   * terminal is still run by its own step, so `Scope.local` is honoured by `countStep` itself.
   */
  const g = build();

  test('THE ROUTE: the rung claims the count shape and reports it as the residual', () => {
    const claimed = chooseHopValues(
      traversal(V(), choose(has('n', 1), out('E'), in_('E')), count()),
      g,
    );

    expect(claimed?.rest.map((st) => st.kind)).toEqual(['count']);

    // The `values` sibling CONSUMES its projection, so its residual is empty — the other side of
    // the same `consumed` flag.
    expect(
      chooseHopValues(traversal(V(), choose(has('n', 1), out('E'), in_('E')), values('n')), g)
        ?.rest,
    ).toEqual([]);
  });

  test('the count equals the row count of the same walk without it', () => {
    /*
     * THE ORACLE IS THE SHAPE WITHOUT `count()`: its `rest` is empty, so it takes the walk
     * directly and does not share the code under test. A non-empty row list is asserted first,
     * because 0 === 0 agrees trivially.
     */
    const rows = toArray(traversal(V(), choose(has('n', 1), out('E'), in_('E'))), g);

    expect(rows.length).toBeGreaterThan(0);
    expect(toArray(traversal(V(), choose(has('n', 1), out('E'), in_('E')), count()), g)[0]).toBe(
      rows.length,
    );
  });

  test('`count(Scope.local)` matches the narrowed-source twin, which this rung declines', () => {
    const fast = toArray(
      traversal(V(), choose(has('n', 1), out('E'), in_('E')), count(Scope.local)),
      g,
    );

    expect(fast).toEqual(
      toArray(
        traversal(
          V('a', 'b', 'c', 'd', 'e', 'f'),
          choose(has('n', 1), out('E'), in_('E')),
          count(Scope.local),
        ),
        g,
      ),
    );
  });
});
