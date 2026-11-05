/**
 * `V(id)` and `E(id)` must not touch `graph.vertices` / `graph.edges` at all (item 1539).
 *
 * ⚠️ THIS NEEDS ITS OWN TEST AND CANNOT BORROW ONE. `applySource` used to pass `graph.vertices` as
 * an ARGUMENT to `sourceFromIds`, which reads it only when no ids were given — so the getter ran on
 * every id lookup and its result was discarded. That is answer-equivalent by construction: every
 * correctness test in the suite passed before and after, which is `perf-gate-needs-its-own-test`
 * exactly. The only way to pin it is to make the access OBSERVABLE.
 *
 * It was worth 2.4-2.8x. `graph.vertices` is
 * `{ [Symbol.iterator]: () => this.verticesById.values() }` — an object plus a closure, allocated
 * and thrown away per call — and at 200,000 vertices it was **48.4% of the whole profile** of a
 * one-row `V(id)` query, the single largest frame.
 *
 * The spy is an own property shadowing the prototype getter, which is what `applySource` resolves.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { E, V, gt, has, toArray, traversal, values } from '../index.js';

/** Replaces the accessor with a counting one, and hands back the counter. */
const spyOn = (g: Graph, prop: 'vertices' | 'edges') => {
  const seen = { reads: 0 };
  // Taking the getter off the prototype to re-invoke is the point of the spy, and it IS called
  // with an explicit receiver (`real.call(g)`) below.
  // oxlint-disable-next-line typescript/unbound-method
  const real = Object.getOwnPropertyDescriptor(Graph.prototype, prop)?.get;

  if (real === undefined) {
    throw new Error(`${prop} is not a prototype getter — the spy would not observe it`);
  }

  Object.defineProperty(g, prop, {
    configurable: true,
    get() {
      seen.reads += 1;

      return real.call(g);
    },
  });

  return seen;
};

const fixture = () => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { w: 7 } });

  return g;
};

describe('item 1539 — an id-seeded source must not read the whole-graph iterable', () => {
  test('the spy itself works — V() with NO ids does read graph.vertices', () => {
    // Without this, a spy that silently observes nothing would make every assertion below vacuous.
    //
    // ⚠️ AND THE SHAPE MATTERS: `V().count()` and `V().values(k)` read it ZERO times, because
    // `countShortcut` and `nodeValuesShortcut` answer them without building a source at all. Both
    // were tried here first and both made this control pass vacuously in the wrong direction. A
    // `has` filter declines every shortcut (item 1538), so this one really does reach `applySource`.
    const g = fixture();
    const seen = spyOn(g, 'vertices');

    expect(toArray(traversal(V(), has('k', gt(0)), values('k')), g)).toEqual([1, 2]);
    expect(seen.reads).toBeGreaterThan(0);
  });

  test('V(id) never reads graph.vertices', () => {
    const g = fixture();
    const seen = spyOn(g, 'vertices');

    expect(toArray(traversal(V('a'), values('k')), g)).toEqual([1]);
    expect(seen.reads).toBe(0);
  });

  test('V(id, id) never reads it either, and a MISSING id still does not', () => {
    const g = fixture();
    const seen = spyOn(g, 'vertices');

    expect(toArray(traversal(V('a', 'b'), values('k')), g)).toEqual([1, 2]);
    // An id with no element yields nothing — and must not fall back to a scan.
    expect(toArray(traversal(V('nope'), values('k')), g)).toEqual([]);
    expect(seen.reads).toBe(0);
  });

  test('E(id) never reads graph.edges, and E() does', () => {
    const g = fixture();
    const seen = spyOn(g, 'edges');

    expect(toArray(traversal(E('e1'), values('w')), g)).toEqual([7]);
    expect(seen.reads).toBe(0);

    expect(toArray(traversal(E(), has('w', gt(0)), values('w')), g)).toEqual([7]);
    expect(seen.reads).toBeGreaterThan(0);
  });

  test('the id path still yields a DUPLICATE for a repeated id', () => {
    // `index-seed.ts` documents this as the reason `V() + hasId(ids)` is NOT rewritten to `V(ids)`:
    // `sourceFromIds` does not dedupe. Pinned here so the laziness change cannot alter it.
    const g = fixture();

    expect(toArray(traversal(V('a', 'a'), values('k')), g)).toEqual([1, 1]);
  });
});
