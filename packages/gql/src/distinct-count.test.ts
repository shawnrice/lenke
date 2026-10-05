import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `RETURN count(DISTINCT e)` is the SIZE of the dedup the walk already builds, and it went
// through the general pipeline instead: 65.8ms against the rows walk's 5.1ms on a node scan, and
// 841.9ms against 87.6ms over a hop. The cost is the pipeline and not the aggregate — `count(*)`
// forced down the same path is 84.3ms with no map, filter or dedup in it at all — so the walk is
// the whole answer (audit item 196).
//
// Two things differ from the rows path, and they are what these tests are mostly about:
//
//   - NULLs do not count. `count(DISTINCT n.k)` is 2 where `RETURN DISTINCT n.k` is three rows
//     including the null, and `count(DISTINCT n.missing)` is 0 rather than 1.
//   - the FAR-driven walk needs no sort here, because a count has no observable order — so the
//     vacuous-start condition is the only one left, and getting it wrong over-counts.

const build = (values: unknown[]): Graph => {
  const g = new Graph();

  values.forEach((k, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: k === undefined ? {} : { k } });
  });

  return g;
};

const c = (g: Graph, q: string): unknown => query(g, q)[0].c;

/** Forced to the general path by a dead `LET`, which every one of these detectors declines. */
const viaGeneral = (g: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const Q = 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c';

describe('count(DISTINCT …) over a walk', () => {
  test('counts the distinct values, agreeing with the general path', () => {
    const g = build(['a', 'b', 'a', 'c', 'b']);

    expect(c(g, Q)).toBe(3);
    expect(query(g, Q)).toEqual(viaGeneral(g, Q));
  });

  describe('NULLs do not count', () => {
    test('a stored null and an absent key are both skipped', () => {
      const g = build([1, null, undefined, 2, 1]);

      expect(c(g, Q)).toBe(2);
      expect(query(g, Q)).toEqual(viaGeneral(g, Q));
      // The rows walk DOES keep the null, which is the difference being relied on.
      expect((query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS x') as unknown[]).length).toBe(3);
    });

    test('every value null gives zero, not one', () => {
      const g = build([null, undefined, null]);

      expect(c(g, Q)).toBe(0);
      expect(query(g, Q)).toEqual(viaGeneral(g, Q));
    });

    test('a null first, then repeats — the count is of the non-null values', () => {
      const g = build([null, 7, 7, 8]);

      expect(c(g, Q)).toBe(2);
      // NOTE, corrected after a mutant survived here: whether a null also ENTERS the dedup set
      // is unobservable, because every null returns before the count is touched and no non-null
      // value can key as null — so nothing can collide with it. The early return is for clarity
      // and to keep nulls out of the set's growth, not for the answer. This test is a regression
      // pin on the ANSWER, not evidence about that.
    });

    test('an empty graph gives zero', () => {
      expect(c(new Graph(), Q)).toBe(0);
    });
  });

  test('an ELEMENT argument counts vertices, which are never null', () => {
    const g = build(['a', 'b', 'a']);

    expect(c(g, 'MATCH (n:P) RETURN count(DISTINCT n) AS c')).toBe(3);
  });

  test('the LET spelling agrees', () => {
    const g = build(['a', 'b', 'a']);
    const q = 'MATCH (n:P) LET a = n.k RETURN count(DISTINCT a) AS c';

    expect(c(g, q)).toBe(2);
    expect(query(g, q)).toEqual(
      query(g, 'MATCH (n:P) LET _z = 1 LET a = n.k RETURN count(DISTINCT a) AS c'),
    );
  });

  test('the engine’s value equivalences still hold', () => {
    expect(c(build([0, -0, 0]), Q)).toBe(1);
    expect(c(build([1, '1', true]), Q)).toBe(3);
    expect(
      c(
        build([
          [1, 2],
          [1, 2],
          [2, 1],
        ]),
        Q,
      ),
    ).toBe(2);
    expect(c(build([{ a: 1 }, { a: 1 }, { a: 2 }]), Q)).toBe(2);
  });

  describe('over a hop', () => {
    const hop = (): Graph => {
      const g = new Graph();
      const v = (id: string, labels: string[], n: unknown) =>
        g.addVertex({ id, labels, properties: n === undefined ? {} : { n } });

      const a = v('a', ['P'], 1);
      const b = v('b', ['P'], 2);
      const y = v('y', ['P', 'Q'], 30);
      const z = v('z', ['P'], 30); // same value as y, a DIFFERENT vertex
      const w = v('w', ['P'], undefined); // reached, but its value is null

      v('lonely', ['P'], 99); // never reached

      g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
      g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
      g.addEdge({ from: a, to: w, labels: ['T'], properties: {} });

      return g;
    };

    test('the FAR end: one distinct non-null value across two vertices', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]->(f) RETURN count(DISTINCT f.n) AS c';

      // y and z both read 30, w reads null, `lonely` is unreached → ONE.
      expect(c(g, q)).toBe(1);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('the FAR end as an ELEMENT counts the reached vertices', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]->(f) RETURN count(DISTINCT f) AS c';

      expect(c(g, q)).toBe(3);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('the START end', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]->(f) RETURN count(DISTINCT s.n) AS c';

      expect(c(g, q)).toBe(2);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('a clause WHERE over the keyed end is carried', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]->(f) WHERE f.n > 10 RETURN count(DISTINCT f.n) AS c';

      expect(c(g, q)).toBe(1);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('a far-end LABEL narrows it', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]->(f:Q) RETURN count(DISTINCT f.n) AS c';

      expect(c(g, q)).toBe(1);
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });

    test('a NON-vacuous start label must not over-count', () => {
      // The far-driven walk takes no sort here, so the vacuous-start condition is the only thing
      // standing between "is reached" and "has any in-edge". `viaB` is reached only from a B
      // vertex, so asking from A must not see it.
      const h = new Graph();
      const fromA = h.addVertex({ id: 'fromA', labels: ['A'], properties: {} });
      const fromB = h.addVertex({ id: 'fromB', labels: ['B'], properties: {} });
      const viaA = h.addVertex({ id: 'viaA', labels: ['Z'], properties: { n: 10 } });
      const viaB = h.addVertex({ id: 'viaB', labels: ['Z'], properties: { n: 20 } });

      h.addEdge({ from: fromA, to: viaA, labels: ['T'], properties: {} });
      h.addEdge({ from: fromB, to: viaB, labels: ['T'], properties: {} });

      const q = 'MATCH (a:A)-[:T]->(f) RETURN count(DISTINCT f.n) AS c';

      expect(c(h, q)).toBe(1);
      expect(query(h, q)).toEqual(viaGeneral(h, q));
    });

    test('an UNDIRECTED hop still answers correctly', () => {
      const g = hop();
      const q = 'MATCH (s:P)-[:T]-(f) RETURN count(DISTINCT f.n) AS c';

      expect(query(g, q)).toEqual(viaGeneral(g, q));
    });
  });

  describe('shapes this must NOT take', () => {
    test('count(*) is a different question and keeps its own shortcut', () => {
      const g = build(['a', 'a', 'b']);

      expect(c(g, 'MATCH (n:P) RETURN count(*) AS c')).toBe(3);
    });

    test('count(prop) without DISTINCT counts non-null VALUES, not distinct ones', () => {
      const g = build(['a', 'a', 'b', null]);

      expect(c(g, 'MATCH (n:P) RETURN count(n.k) AS c')).toBe(3);
    });

    test('a GROUP BY with ONE item is a grouped count — several rows, not one', () => {
      // The distinguishing case, and the one my first fixture missed: with TWO projected items
      // the item-count check declines before the GROUP BY check is ever consulted, so a mutant
      // dropping the latter survived. One item and a GROUP BY is the shape where it matters.
      const g = new Graph();

      g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'x', j: 1 } });
      g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'x', j: 2 } });
      g.addVertex({ id: 'c', labels: ['P'], properties: { k: 'y', j: 1 } });

      expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT n.j) AS c GROUP BY n.k')).toEqual([
        { c: 2 },
        { c: 1 },
      ]);
      expect(
        query(g, 'MATCH (n:P) LET a = n.k RETURN count(DISTINCT n.j) AS c GROUP BY a'),
      ).toEqual([{ c: 2 }, { c: 1 }]);
      // Ungrouped, the same data is ONE row — which is what a dropped GROUP BY check collapses to.
      expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT n.j) AS c')).toEqual([{ c: 2 }]);
    });

    test('a GROUP BY alongside a second item is a grouped count too', () => {
      const g = build(['a', 'a', 'b']);
      const rows = query(
        g,
        'MATCH (n:P) LET a = n.k RETURN a, count(DISTINCT n.k) AS c GROUP BY a',
      ) as Array<{ a: unknown; c: number }>;

      expect(rows).toEqual([
        { a: 'a', c: 1 },
        { a: 'b', c: 1 },
      ]);
    });

    test('ORDER BY declines and still answers', () => {
      const g = build(['a', 'b', 'a']);

      expect(query(g, `${Q} ORDER BY c`)).toEqual([{ c: 2 }]);
    });

    test('LIMIT 0 emits nothing', () => {
      const g = build(['a', 'b']);

      expect(query(g, `${Q} LIMIT 0`)).toEqual([]);
    });

    test('a LIMIT of one keeps the single row', () => {
      const g = build(['a', 'b']);

      expect(query(g, `${Q} LIMIT 1`)).toEqual([{ c: 2 }]);
    });

    test('a second projected item declines', () => {
      const g = build(['a', 'b', 'a']);

      expect(query(g, 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c, count(*) AS t')).toEqual([
        { c: 2, t: 3 },
      ]);
    });

    test('an argument reading BOTH ends declines', () => {
      const g = new Graph();
      const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
      const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });

      g.addEdge({ from: a, to: b, labels: ['T'], properties: {} });

      expect(c(g, 'MATCH (s:P)-[:T]->(f) RETURN count(DISTINCT s.n + f.n) AS c')).toBe(1);
    });
  });
});
