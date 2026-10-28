import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 1039: the REL-BOUND hop projection dropped its `ORDER BY` and any following `LIMIT`.
// `detectHopProjection` wraps every other return in `sorted(...)`; that one route returned
// unwrapped, so the sort was computed and thrown away.
//
// EVERY EXPECTATION HERE WAS COMPARED AGAINST THE NATIVE ENGINE BEFORE BEING WRITTEN DOWN, through
// the FFI backend on the same fixture. That is the only ground truth available: the defect WAS a
// cross-engine divergence (TS returned insertion order and three rows for `LIMIT 2`; native
// returned descending order and two), so a TS-only expectation would have been guesswork about the
// thing that was broken.
//
// WHY THE DIFFERENTIAL FUZZERS MISSED IT. They compare row MULTISETS for unordered results — the
// correct invariant, since row order without `ORDER BY` is unspecified — and a DROPPED `ORDER BY`
// is invisible to a multiset comparison. The `LIMIT` half is not, but a `LIMIT` only rides along
// here when the same route is taken, and the generated hop shapes do not read the REL variable, so
// `itemsReadRel` is false and this route is never reached. Both halves of the blind spot are
// coverage, not a broken invariant.

const fixture = (indexed: boolean): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 5 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });

  // Tags DELIBERATELY out of insertion order, so insertion order and sorted order differ. A
  // fixture whose arrival order already matches the sort cannot see a dropped sort at all.
  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: { w: 1, tag: 'b' } });
  g.addEdge({ id: 'e2', from: a, to: b, labels: ['T'], properties: { w: 2, tag: 'a' } });
  g.addEdge({ id: 'e3', from: b, to: a, labels: ['T'], properties: { w: 3, tag: 'c' } });

  if (indexed) {
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });
  }

  return g;
};

const vals = (g: Graph, q: string): unknown[] =>
  ([...query(g, q)] as Record<string, unknown>[]).map((r) => r.a);

describe('ORDER BY on a REL property is honoured (item 1039)', () => {
  for (const indexed of [false, true]) {
    const label = indexed ? 'with an edge index declared' : 'with no edge index';
    const g = fixture(indexed);

    describe(label, () => {
      test('DESC sorts descending', () => {
        expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.tag AS a ORDER BY e.tag DESC')).toEqual([
          'c',
          'b',
          'a',
        ]);
      });

      test('ASC sorts ascending — and differs from DESC, which is the whole point', () => {
        expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.tag AS a ORDER BY e.tag ASC')).toEqual([
          'a',
          'b',
          'c',
        ]);
      });

      test('the output ALIAS is a usable sort key', () => {
        expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.tag AS a ORDER BY a DESC')).toEqual([
          'c',
          'b',
          'a',
        ]);
      });

      test('a following LIMIT applies — it returned every row before', () => {
        expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.tag AS a ORDER BY e.tag DESC LIMIT 2')).toEqual(
          ['c', 'b'],
        );
      });

      test('OFFSET too', () => {
        expect(
          vals(g, 'MATCH ()-[e:T]->() RETURN e.tag AS a ORDER BY e.tag DESC OFFSET 1 LIMIT 1'),
        ).toEqual(['b']);
      });

      test('a sort on a NUMERIC rel property', () => {
        expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.w AS a ORDER BY e.w DESC')).toEqual([3, 2, 1]);
      });

      test('a rel-reading projection sorted on a FAR property still works', () => {
        // This shape was already correct before the fix — it is the control that says the fix
        // addressed the sort KEY's position and did not change what already worked.
        expect(vals(g, 'MATCH ()-[e:T]->(y) RETURN e.tag AS a ORDER BY y.n DESC')).toEqual([
          'c',
          'b',
          'a',
        ]);
      });
    });
  }
});

describe('TIE ORDER under a sort stays the engines-agree order (item 1039)', () => {
  // The `sortedQuery` guard's reason. `Array.prototype.sort` is stable, so a sort pins the sorted
  // order and leaves TIES on ARRIVAL order — and tie order is observable between the engines (item
  // 605). Item 1038's seeded walk arrives in INDEX order, so taking it under a sort would reorder
  // ties away from native. These expectations were verified against native on this fixture.
  const g = (() => {
    const graph = new Graph();
    const vs = [graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } })];

    for (let i = 1; i < 20; i++) {
      vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
    }

    // `w` takes TWO values over 400 edges, so each sort key has ~200 ties — and `w` is INDEXED, so
    // the seeded walk would be admitted were the guard not there.
    for (let i = 0; i < 400; i++) {
      graph.addEdge({
        id: `e${i}`,
        from: vs[i % vs.length],
        to: vs[(i * 7 + 1) % vs.length],
        labels: ['T'],
        properties: { w: i % 2, t: `x${i}` },
      });
    }

    graph.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

    return graph;
  })();

  test('DESC on the tied key keeps arrival order within each group', () => {
    const got = vals(g, 'MATCH ()-[e:T]->() RETURN e.t AS a ORDER BY e.w DESC');

    expect(got).toHaveLength(400);
    expect(got.slice(0, 3)).toEqual(['x1', 'x21', 'x41']);
  });

  test('ASC starts from the other group, same arrival order inside it', () => {
    const got = vals(g, 'MATCH ()-[e:T]->() RETURN e.t AS a ORDER BY e.w ASC');

    expect(got.slice(0, 3)).toEqual(['x0', 'x20', 'x40']);
  });

  test('a SELECTIVE indexed predicate under a sort — both spellings keep that order', () => {
    const clause = vals(g, 'MATCH ()-[e:T]->() WHERE e.w = 1 RETURN e.t AS a ORDER BY e.w DESC');
    const inline = vals(g, 'MATCH ()-[e:T {w: 1}]->() RETURN e.t AS a ORDER BY e.w DESC');

    expect(clause).toHaveLength(200);
    expect(clause.slice(0, 3)).toEqual(['x1', 'x21', 'x41']);
    expect(inline).toEqual(clause);
  });

  test('a LIMIT over tied rows takes the arrival-order prefix', () => {
    expect(vals(g, 'MATCH ()-[e:T]->() RETURN e.t AS a ORDER BY e.w DESC LIMIT 5')).toEqual([
      'x1',
      'x21',
      'x41',
      'x61',
      'x81',
    ]);
  });
});

describe('the sortedQuery guard is load-bearing (item 1039)', () => {
  // THE FIXTURE THAT CAN SEE IT, after two that could not. To distinguish the seeded walk's INDEX
  // order from the scanning walk's VERTEX-DRIVEN order, three things must hold at once, and the
  // first two attempts each missed one:
  //
  //   1. The seed must be ADMITTED — a selective indexed key. (`w` with two values is half the
  //      bucket, which `edgeSeek`'s margin correctly refuses.)
  //   2. The sort key must be a PROJECTED OUTPUT COLUMN, or `outputColumnSorts` declines and the
  //      whole query goes to the general path, where neither walk runs.
  //   3. The matching edges must be INTERLEAVED against vertex creation order, or the two orders
  //      coincide and nothing is observable. (All eight `k = 7` edges sharing one source vertex is
  //      how the second attempt hid it.)
  //
  // Here: `m1` from v9, `m2` from v2, `m3` from v9, inserted in that order, all with `w = 0` so
  // the whole result is one tie group. Index order is m1, m2, m3; vertex-driven order is
  // m2, m1, m3. NATIVE RETURNS m2, m1, m3 — every expectation below was read off the FFI engine on
  // this fixture — so the vertex-driven order is the one to keep, and the guard is what keeps it.
  //
  // Without the guard all three sorted queries diverge from native, and the `LIMIT 2` one returns
  // DIFFERENT ROWS (m1, m2 instead of m2, m1) rather than merely a different order.
  const g = (() => {
    const graph = new Graph();
    const vs: ReturnType<Graph['addVertex']>[] = [];

    for (let i = 0; i < 20; i++) {
      vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
    }

    const add = (id: string, from: number, to: number, k: number, w: number, t: string): void => {
      graph.addEdge({ id, from: vs[from], to: vs[to], labels: ['T'], properties: { k, w, t } });
    };

    // Filler on keys 100..999, so `k = 7` is only the three marked edges — 3 of 8,003, far inside
    // the seek margin.
    for (let i = 0; i < 8_000; i++) {
      add(`f${i}`, i % 20, (i * 7 + 1) % 20, 100 + (i % 900), i % 2, `f${i}`);
    }

    add('m1', 9, 3, 7, 0, 'm1');
    add('m2', 2, 3, 7, 0, 'm2');
    add('m3', 9, 4, 7, 0, 'm3');
    graph.createIndex({ on: 'edge', kind: 'hash', keys: ['k'] });

    return graph;
  })();

  test('DESC over a full tie group keeps the vertex-driven order native uses', () => {
    expect(
      vals(g, 'MATCH ()-[e:T]->() WHERE e.k = 7 RETURN e.t AS a, e.w AS w ORDER BY w DESC'),
    ).toEqual(['m2', 'm1', 'm3']);
  });

  test('and so does the INLINE spelling, ascending', () => {
    expect(vals(g, 'MATCH ()-[e:T {k: 7}]->() RETURN e.t AS a, e.w AS w ORDER BY w ASC')).toEqual([
      'm2',
      'm1',
      'm3',
    ]);
  });

  test('a LIMIT over the tie group takes the SAME ROWS native takes', () => {
    // The sharpest arm: without the guard this is m1, m2 — different rows, not a different order.
    expect(
      vals(g, 'MATCH ()-[e:T]->() WHERE e.k = 7 RETURN e.t AS a, e.w AS w ORDER BY w DESC LIMIT 2'),
    ).toEqual(['m2', 'm1']);
  });
});
