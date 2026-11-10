// `hopValuesShortcut` matches a plan PREFIX and returns the steps left over, so a trailing step
// rides the shortcut instead of dropping the whole query onto the traverser pipeline (item 608).
//
// TWO OF THE THREE CLAIMS HERE ARE NOT VISIBLE IN AN ANSWER, which is why this file exists:
//
//   - THE ROUTE. Taking the shortcut and taking the pipeline produce identical values, so a
//     mutant restoring the old exact-3-step gate SURVIVES every answer-based test in the package.
//     The remedy is the one item 605 used for a capability check: assert the function's own
//     contract rather than the query's output.
//   - THE `tracksPath` GATE. It is a CORRECTNESS guard, not a perf one — the walk emits bare
//     values and builds no traverser, so it carries no path. A mutant removing it also survived,
//     because nothing exercised a path-reading plan over this shape.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { both, has, id, label, order, out, path, toArray, traversal, V, values } from '../index.js';
import { hopValuesShortcut } from './hop-values.js';

const twoHop = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 2 } });

  g.addEdge({ id: 'e', from: a, to: b, labels: ['K'], properties: {} });

  return g;
};

describe('the hop-values shortcut and its residual', () => {
  test('a 3-step plan is claimed whole — no residual, so no traverser is ever built', () => {
    const g = twoHop();
    const claimed = hopValuesShortcut(traversal(V(), out('K'), values('age')), g);

    expect(claimed).toBeDefined();
    expect(claimed?.rest).toEqual([]);
    expect([...(claimed?.values ?? [])]).toEqual([2]);
  });

  test('a 4-step plan is claimed with the leftover step as its RESIDUAL', () => {
    // THE ROUTE ASSERTION. Both routes answer the same, so this is the only thing that can tell a
    // shortcut-with-residual from the traverser pipeline — a mutant restoring `steps.length !== 3`
    // returns `undefined` here and passes every other test in the package.
    const g = twoHop();
    const plan = traversal(V(), out('K'), values('age'), path());
    const claimed = hopValuesShortcut(plan, g);

    expect(claimed).toBeDefined();
    expect(claimed?.rest).toHaveLength(1);
    expect(claimed?.rest[0]?.kind).toBe('path');
    // The prefix's values are unchanged by there being a residual.
    expect([...(claimed?.values ?? [])]).toEqual([2]);
  });

  test('a plan with no HOP is not claimed, whatever its length', () => {
    const g = twoHop();

    // `V().values(age)` has no hop to fuse — the shortcut is about the WALK, not the projection.
    expect(hopValuesShortcut(traversal(V(), values('age')), g)).toBeUndefined();
    // `V(id)` enumerates a given set rather than the whole graph.
    expect(hopValuesShortcut(traversal(V('a'), out('K')), g)).toBeUndefined();
  });

  // ITEM 881 CHANGED THIS CONTRACT. The gate used to be `steps.length < 3`, so a BARE hop — about
  // as common a traversal as the language has — went down the traverser pipeline while the
  // projected form rode the fused walk: 325.21 ms against 169.93 over 1,000,000 edges, so ADDING
  // a step made the query 1.9x faster (item 880). A two-step plan is now claimed and yields the
  // far VERTICES.
  test('a BARE hop is claimed and yields the far vertices', () => {
    const g = twoHop();
    const claimed = hopValuesShortcut(traversal(V(), out('K')), g);

    expect(claimed).toBeDefined();
    expect(claimed?.rest).toHaveLength(0);

    const far = [...(claimed?.values ?? [])] as { id: string }[];

    expect(far.map((v) => v.id)).toEqual(['b']);
  });

  test("`id()` is claimed too, and yields the far vertices' ids", () => {
    const g = twoHop();
    const claimed = hopValuesShortcut(traversal(V(), out('K'), id()), g);

    expect(claimed).toBeDefined();
    expect(claimed?.rest).toHaveLength(0);
    expect([...(claimed?.values ?? [])]).toEqual(['b']);
  });

  test('any OTHER third step still declines the whole shortcut', () => {
    // Deliberately unchanged: treating an unrecognised step as a residual over a bare hop would
    // re-route a large family of plans that nothing has measured. `has` is the shape that would
    // have been silently claimed.
    const g = twoHop();

    expect(hopValuesShortcut(traversal(V(), out('K'), has('age', 2)), g)).toBeUndefined();
    expect(hopValuesShortcut(traversal(V(), out('K'), label()), g)).toBeUndefined();
  });

  // THE GENERAL BRANCH, which a single-label `out()` never reaches. `hopValuesShortcut` has two
  // walks — a tuned one for ONE named type on `out`/`in`, and a general one through
  // `adjacentEdges`/`otherEndpoint` for `both` and for label SETS. The fixture above only ever
  // exercised the first, so a mutant deleting the absent-key DROP from the general walk SURVIVED.
  test('the general walk (`both`) also DROPS a far vertex lacking the key', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 2 } });
    // `c` deliberately has NO `age`
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['K'], properties: {} });
    g.addEdge({ id: 'e2', from: a, to: c, labels: ['K'], properties: {} });

    // `both` forces the general walk. From `a` the far ends are `b` (age 2) and `c` (no age);
    // from `b` and `c` the far end is `a` (age 1). `c`'s missing key is DROPPED, not emitted as
    // null or undefined — so four traversals yield three values.
    const got = [...(hopValuesShortcut(traversal(V(), both('K'), values('age')), g)?.values ?? [])];

    expect(got).toEqual([2, 1, 1]);
  });

  test('the general walk claims a BARE `both` hop and keeps every far vertex', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['K'], properties: {} });

    // No key to be absent, so nothing may be dropped: two directions over one edge.
    const far = [...(hopValuesShortcut(traversal(V(), both('K')), g)?.values ?? [])] as {
      id: string;
    }[];

    expect(far.map((v) => v.id)).toEqual(['b', 'a']);
  });

  test('a bare hop and its PIPELINE spelling agree, element for element', () => {
    // The route is answer-equivalent, so this is the equality that matters: `path()` forces the
    // pipeline (the `tracksPath` gate), and the far vertices must match the shortcut's.
    const g = twoHop();
    const shortcut = toArray(traversal(V(), out('K')), g) as { id: string }[];
    const viaPipeline = (toArray(traversal(V(), out('K'), path()), g) as unknown[][]).map(
      (p) => (p[p.length - 1] as { id: string }).id,
    );

    expect(shortcut.map((v) => v.id)).toEqual(viaPipeline);
  });

  test('a PATH-READING plan does not ride the shortcut, and keeps its whole path', () => {
    // The `tracksPath` gate, asserted through behaviour. `values()` yields a bare value and the
    // walk builds no traverser, so a plan reading a path cannot be served from it: the path would
    // lose everything before the value. `[a, b, 2]` is the vertex, the far vertex and the value —
    // a shortcut that claimed this would answer `[2]`.
    const g = twoHop();
    const got = toArray(traversal(V(), out('K'), values('age'), path()), g) as unknown[][];

    expect(got).toHaveLength(1);
    expect(got[0]).toHaveLength(3);
    expect((got[0][0] as { id: string }).id).toBe('a');
    expect((got[0][1] as { id: string }).id).toBe('b');
    expect(got[0][2]).toBe(2);
  });

  test('a trailing step still answers what the pipeline would', () => {
    // The residual's own correctness, over a graph big enough that the order is not trivially the
    // input order: `order()` must sort the walked values, and the values must be the walk's.
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 12; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: (i * 5) % 12 } }));
    }

    for (let i = 0; i < 12; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: vs[i],
        to: vs[(i * 7 + 1) % 12],
        labels: ['K'],
        properties: {},
      });
    }

    const unordered = toArray(traversal(V(), out('K'), values('age')), g) as number[];
    const ordered = toArray(traversal(V(), out('K'), values('age'), order()), g) as number[];

    // The residual sorts EXACTLY the multiset the prefix produced — not a different set.
    expect(ordered).toEqual([...unordered].sort((x, y) => x - y));
    // And it really sorted: the walk's own order is not already ascending, so a residual that did
    // nothing would fail this. (An earlier draft of this test ran the SAME traversal twice and
    // compared it to itself, which asserted nothing.)
    expect(unordered).not.toEqual(ordered);
    expect(ordered).toHaveLength(12);
  });

  /**
   * ⚠️ `order` AS A THIRD STEP OVER THE BARE HOP (item 1783), AND NO ANSWER-BASED TEST CAN SEE IT.
   *
   * The other residual shapes above at least change which VALUES come out. This one cannot even be
   * distinguished by row ORDER, because the step under test is a sort — it defines the order on
   * either route. So the gate's contract is the only observable, exactly as this file's header says
   * for the 3-step gate, and a mutant dropping `|| proj.kind === 'order'` reverts the whole item
   * while leaving every answer in the package identical.
   *
   * Item 1782 measured what the decline cost: `V().out(T).order().by(k)` was the heaviest row on
   * the Gremlin bench at 1537.5 ns/row with `projected=UNDEFINED`, and admitting it reads **1.51x**
   * (79.4 -> 51.7 ms, five alternated rounds, every round below the base median).
   */
  test('`order` as a third step is claimed as a RESIDUAL over the bare hop, not declined', () => {
    const g = twoHop();
    const claimed = hopValuesShortcut(traversal(V(), out('K'), order().by('age')), g);

    expect(claimed).toBeDefined();
    // `consumed = 2`, so the order step and anything after it is the residual.
    expect(claimed?.rest).toHaveLength(1);
    expect(claimed?.rest[0]?.kind).toBe('order');
    // BARE-HOP MODE: the walk emits far ELEMENTS, not values — which is what lets the residual's
    // `by('age')` read the property and what makes `fusableProjectedOrder` decline (its last
    // consumed step is the hop, not a `values`), leaving the VALUE-mode fusion untouched.
    const walked = [...(claimed?.values ?? [])] as { id: string }[];

    expect(walked.map((v) => v.id)).toEqual(['b']);
  });

  test('the sorted ELEMENTS are right, and the walk order is not already sorted', () => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 12; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: (i * 5) % 12 } }));
    }

    for (let i = 0; i < 12; i += 1) {
      g.addEdge({
        id: `e${i}`,
        from: vs[i],
        to: vs[(i * 7 + 1) % 12],
        labels: ['K'],
        properties: {},
      });
    }

    const bare = toArray(traversal(V(), out('K')), g) as { properties: { age: number } }[];
    const sorted = toArray(traversal(V(), out('K'), order().by('age')), g) as {
      properties: { age: number };
    }[];

    const ages = (rows: { properties: { age: number } }[]): number[] =>
      rows.map((v) => v.properties.age);

    // The same multiset, sorted by the `by` key.
    expect(ages(sorted)).toEqual([...ages(bare)].sort((x, y) => x - y));
    // And it really sorted — a residual that did nothing would fail this.
    expect(ages(bare)).not.toEqual(ages(sorted));
    expect(sorted).toHaveLength(12);
  });

  test('a bare `order()` over ELEMENTS still throws, so the gate did not make an illegal sort legal', () => {
    // `assertFrontierTypes` raises at PLAN-CHECK time, before any route is chosen, so this throws
    // whichever way the gate routes it. Pinned because the gate now admits an `order` step over an
    // ELEMENT walk, and the one thing that must not follow from that is an element sort succeeding.
    const g = twoHop();

    expect(() => toArray(traversal(V(), out('K'), order()), g)).toThrow();
  });
});
