/*
 * Item 2085 — `LabelBox.sole` and the `soleLabel` accessor.
 *
 * ⚠️⚠️ **STALENESS IS THE ONLY REAL RISK, AND THERE ARE THREE WRITE SITES, NOT ONE.**
 * `commitElementLabels`'s own doc calls itself "the single funnel for every label write" — and that
 * is true of the MAP ENTRY, not of the box's FIELDS. Both element setters write `#lbox.set` directly
 * whenever the element already holds its box, which is the common case. A derived field maintained
 * only in the funnel would be correct until the first re-write of an element that had already read
 * its labels — which is exactly how `verticesByLabel` came to disagree with `v.labels`.
 *
 * So every test below that writes labels does so AFTER a read, to force the cached-box branch.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '../index.js';

const g1 = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'one', labels: ['P'], properties: {} });
  g.addVertex({ id: 'many', labels: ['P', 'Q'], properties: {} });
  g.addVertex({ id: 'none', labels: [], properties: {} });

  return g;
};

describe('soleLabel (item 2085)', () => {
  test('exactly one label yields it; zero and many yield undefined', () => {
    const g = g1();

    expect(g.getVertexById('one')!.soleLabel).toBe('P');
    // 🔑 `undefined` MEANS ZERO **OR MANY** — the two cases are deliberately indistinguishable,
    // because both must fall back to `labels.has(n)`. A reader treating it as "no label" is wrong.
    expect(g.getVertexById('many')!.soleLabel).toBeUndefined();
    expect(g.getVertexById('none')!.soleLabel).toBeUndefined();
  });

  test('⚠️⚠️ the SETTER keeps it current — read FIRST, so the cached-box branch runs', () => {
    const g = g1();
    const v = g.getVertexById('one')!;

    // This read populates `#lbox`, which is what sends the write below down the direct branch
    // rather than through `commitElementLabels`. Without it the test exercises the wrong site.
    expect(v.soleLabel).toBe('P');

    v.labels = ['Z'];
    expect(v.soleLabel).toBe('Z');
    expect([...v.labels]).toStrictEqual(['Z']);

    v.labels = ['Z', 'Y'];
    expect(v.soleLabel).toBeUndefined();

    v.labels = ['Y'];
    expect(v.soleLabel).toBe('Y');

    v.labels = [];
    expect(v.soleLabel).toBeUndefined();
  });

  test('the setter keeps it current on an element that has NOT read its labels', () => {
    // The other branch: no cached box, so the write goes through the graph's funnel.
    const g = g1();
    const v = g.getVertexById('one')!;

    v.labels = ['W'];
    expect(v.soleLabel).toBe('W');
  });

  test('⚠️ add/remove label keep it current, in both directions', () => {
    const g = g1();
    const v = g.getVertexById('one')!;

    expect(v.soleLabel).toBe('P');

    g.addLabelToVertex('R', v);
    // Two labels now — no sole.
    expect(v.soleLabel).toBeUndefined();
    expect([...v.labels].sort()).toStrictEqual(['P', 'R']);

    g.removeLabelFromVertex('P', v);
    // Back to one, and it is the REMAINING one, not the original.
    expect(v.soleLabel).toBe('R');
  });

  test("⚠️⚠️ TWO instances sharing one id see each other's write", () => {
    /*
     * 🔑 THE BOX EXISTS FOR THIS CASE. `Graph.elementProperties`/`elementLabels` are keyed by ID, and
     * two attached `Vertex` objects can share one id — which is why `commitElementLabels` mutates the
     * box rather than replacing the map entry. A `sole` cached on the ELEMENT instead of the box
     * would leave whichever instance read first answering staler than its own `labels`.
     */
    const g = g1();
    const a = g.getVertexById('one')!;
    const b = g.getVertexById('one')!;

    expect(a.soleLabel).toBe('P');
    expect(b.soleLabel).toBe('P');

    a.labels = ['X'];

    expect(b.soleLabel).toBe('X');
    expect(a.soleLabel).toBe('X');
  });

  test('an EDGE carries it too, and tracks its setter', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    const e = g.addEdge({
      id: 'e1',
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['E'],
      properties: {},
    });

    expect(e.soleLabel).toBe('E');
    expect(e.soleLabel).toBe('E'); // cached box path
    e.labels = ['F', 'G'];
    expect(e.soleLabel).toBeUndefined();
    e.labels = ['F'];
    expect(e.soleLabel).toBe('F');
  });

  test('⚠️ it AGREES with the set on every element, which is the invariant', () => {
    /*
     * The general statement the individual cases above are instances of: `soleLabel` is the set's one
     * member when the set has exactly one, and `undefined` otherwise — checked after a round of
     * writes rather than only on a fresh graph.
     */
    const g = g1();

    for (const v of g.vertices) {
      v.labels = [...v.labels, 'EXTRA'];
    }

    for (const v of g.vertices) {
      const labels = [...v.labels];
      const expected = labels.length === 1 ? labels[0] : undefined;

      expect(v.soleLabel).toBe(expected);
    }
  });
});
