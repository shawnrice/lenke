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

import { order, out, path, toArray, traversal, V, values } from '../index.js';
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

  test('a plan below three steps is not claimed at all', () => {
    const g = twoHop();

    expect(hopValuesShortcut(traversal(V(), values('age')), g)).toBeUndefined();
    expect(hopValuesShortcut(traversal(V(), out('K')), g)).toBeUndefined();
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
});
