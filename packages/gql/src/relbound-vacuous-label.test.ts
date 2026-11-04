import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * A REL-BOUND hop's far label: dropped when vacuous, applied when it filters (item 1409).
 *
 * Item 1408 gave `undirectedHopWalk` the vacuity drop and its entry claimed that was the one walk in
 * `hop-projection.ts` lacking it. **That claim was wrong** — twelve further `matchesLabel` sites had
 * no drop, and two of them are PER-EDGE walks the bench can reach: `relBoundHopWalk` (profiled at
 * **44.4%** on label testing) and `relBoundFilteredHopWalk` (**32.0%**), both on a fixture where
 * every vertex carries the label so it rejects nothing.
 *
 * ⚠️ THE FAILURE MODE IS A WRONG ROW SET, NOT A SLOW ONE. `vacuousLabel` is consulted per CALL
 * because vacuity is a property of the graph, so the same query is correct on one graph and wrong on
 * another if the drop is mis-decided. Every test here runs the SAME query text against a vacuous and
 * a filtering fixture, so a mis-drop cannot hide behind a fixture that agrees either way.
 *
 * The two walks are SEPARATE closures — the unfiltered one binds the rel and projects, the filtered
 * one additionally gates on it — so each is pinned independently. A change to one does not reach the
 * other, which is the whole reason this item needed two bench rows and not one.
 */

/** `b` and `c` are both `P`: the far label rejects nothing on this graph. */
const vacuous = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });
  g.addEdge({
    id: 'ab',
    from: g.getVertexById('a')!,
    to: g.getVertexById('b')!,
    labels: ['E'],
    properties: { w: 10 },
  });
  g.addEdge({
    id: 'ac',
    from: g.getVertexById('a')!,
    to: g.getVertexById('c')!,
    labels: ['E'],
    properties: { w: 500 },
  });

  return g;
};

/** Same shape, but `c` is `Q`: the far label really filters. */
const filtering = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });
  g.addEdge({
    id: 'ab',
    from: g.getVertexById('a')!,
    to: g.getVertexById('b')!,
    labels: ['E'],
    properties: { w: 10 },
  });
  g.addEdge({
    id: 'ac',
    from: g.getVertexById('a')!,
    to: g.getVertexById('c')!,
    labels: ['E'],
    properties: { w: 500 },
  });

  return g;
};

const col = (g: Graph, src: string, key: string): unknown[] =>
  query(g, src)
    .map((r) => r[key])
    .slice()
    .sort((x, y) => Number(x) - Number(y));

describe('the UNFILTERED rel-bound walk and a vacuous far label (item 1409)', () => {
  // `MATCH (a:P)-[r:E]->(b:P) RETURN r.w` — a projected rel variable and no filter, which is what
  // routes to `relBoundHopWalk`.
  const Q = 'MATCH (a:P)-[r:E]->(b:P) RETURN r.w AS w';

  test('on a vacuous graph the labelled and unlabelled spellings agree', () => {
    const g = vacuous();

    expect(col(g, Q, 'w')).toEqual(col(g, 'MATCH (a:P)-[r:E]->(b) RETURN r.w AS w', 'w'));
    expect(col(g, Q, 'w')).toEqual([10, 500]);
  });

  test('on a FILTERING graph the same query text must keep only the P endpoint', () => {
    // THE WRONG-ROWS GUARD. If the drop were applied unconditionally, `ac` (far end `c`, a `Q`)
    // would come back too and this would read [10, 500].
    expect(col(filtering(), Q, 'w')).toEqual([10]);
  });

  test('and the complementary label picks up exactly the other edge', () => {
    expect(col(filtering(), 'MATCH (a:P)-[r:E]->(b:Q) RETURN r.w AS w', 'w')).toEqual([500]);
  });

  test('an absent far label keeps nothing, on either graph', () => {
    expect(col(vacuous(), 'MATCH (a:P)-[r:E]->(b:Z) RETURN r.w AS w', 'w')).toEqual([]);
    expect(col(filtering(), 'MATCH (a:P)-[r:E]->(b:Z) RETURN r.w AS w', 'w')).toEqual([]);
  });
});

describe('the FILTERED rel-bound walk and a vacuous far label (item 1409)', () => {
  // A rel gate as well as the projected rel variable, which routes to `relBoundFilteredHopWalk` —
  // a different closure from the one above, with its own drop.
  const Q = 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w < 100 RETURN b.n AS n';

  test('on a vacuous graph the gate alone decides, label or no label', () => {
    const g = vacuous();

    expect(col(g, Q, 'n')).toEqual(
      col(g, 'MATCH (a:P)-[r:E]->(b) WHERE r.w < 100 RETURN b.n AS n', 'n'),
    );
    expect(col(g, Q, 'n')).toEqual([2]);
  });

  test('the gate and the far label COMPOSE rather than one masking the other', () => {
    // `w < 100` keeps `ab` (far `b`); `w >= 100` keeps `ac` (far `c`). On the filtering graph `b:P`
    // admits only the first and `b:Q` only the second, so each pair of conditions selects a
    // different single row — which a mis-drop on either side cannot reproduce.
    const g = filtering();

    expect(col(g, Q, 'n')).toEqual([2]);
    expect(col(g, 'MATCH (a:P)-[r:E]->(b:Q) WHERE r.w < 100 RETURN b.n AS n', 'n')).toEqual([]);
    expect(col(g, 'MATCH (a:P)-[r:E]->(b:Q) WHERE r.w >= 100 RETURN b.n AS n', 'n')).toEqual([3]);
    expect(col(g, 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w >= 100 RETURN b.n AS n', 'n')).toEqual([]);
  });

  test('a gate that admits everything leaves the label as the only filter', () => {
    // The relation, not a guessed count: an always-true gate must return what the unfiltered walk
    // returns for the same label, on both fixtures.
    for (const g of [vacuous(), filtering()]) {
      const gated = col(g, 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w > 0 RETURN b.n AS n', 'n');
      const plain = col(g, 'MATCH (a:P)-[r:E]->(b:P) RETURN b.n AS n', 'n');

      expect(gated).toEqual(plain);
    }
  });

  test('a gate that admits nothing returns nothing whether or not the label is vacuous', () => {
    expect(col(vacuous(), 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w < 0 RETURN b.n AS n', 'n')).toEqual(
      [],
    );
    expect(col(filtering(), 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w < 0 RETURN b.n AS n', 'n')).toEqual(
      [],
    );
  });
});

describe('vacuity is decided PER GRAPH, not per query text (item 1409)', () => {
  test('the identical query returns different rows on the two fixtures', () => {
    // This is the test that would have caught a per-COMPILE hoist: one query text, two graphs, two
    // correct-but-different answers. A cached decision would make the second call agree with the
    // first whichever order they run in, so both orders are asserted.
    const Q = 'MATCH (a:P)-[r:E]->(b:P) RETURN r.w AS w';

    expect(col(vacuous(), Q, 'w')).toEqual([10, 500]);
    expect(col(filtering(), Q, 'w')).toEqual([10]);
    expect(col(vacuous(), Q, 'w')).toEqual([10, 500]);
  });

  test('and the same holds for the filtered walk', () => {
    const Q = 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w >= 100 RETURN b.n AS n';

    expect(col(filtering(), Q, 'n')).toEqual([]);
    expect(col(vacuous(), Q, 'n')).toEqual([3]);
    expect(col(filtering(), Q, 'n')).toEqual([]);
  });
});
