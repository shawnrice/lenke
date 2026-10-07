import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `MATCH (f)<-[:T]-(a:P) RETURN DISTINCT f.k` and `MATCH (a:P)-[:T]->(f) RETURN DISTINCT f.k` are
// one question. They were 4.6x apart (audit item 215):
//
//     forward, deduped on the far end    66ns an edge   ← takes the far-driven walk
//     reverse, deduped on the START     304ns
//
// The reverse spelling keys the dedup on the pattern's START, which `farDrivenFits` refuses by
// design, so it takes the start-driven walk — and that walk resolved the FAR endpoint for every
// edge in the graph (a string-keyed `Map.get`, ~190ns, item 194) for one purpose: testing the other
// end's label. Two fixes, 304 → 123 → 92ns an edge:
//
//   - STOP at the first qualifying edge. `take(v)` is idempotent under the dedup, so every later
//     edge of the same vertex re-offers the same element.
//   - a VACUOUS far label needs no resolve at all, decided per call against the graph.
//
// The case that makes the break's placement load-bearing is a vertex whose FIRST edge's far end
// FAILS the label and a LATER one passes: breaking before that is a dropped row, not a slow one.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown> = {}) =>
    g.addVertex({ id, labels: [label], properties: props });
  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>, ty = 'T') =>
    g.addEdge({ from: f, to: t, labels: [ty], properties: {} });

  // Three distinct `k` values among the deduped end, so the answer has structure.
  const f1 = v('f1', 'F', { k: 1 });
  const f2 = v('f2', 'F', { k: 2 });
  const f3 = v('f3', 'F', { k: 3 });
  // Deliberately EDGELESS, so `k: 4` must never appear — the no-in-edge case.
  v('f4', 'F', { k: 4 });
  // A duplicate `k`, so the dedup has something to collapse.
  const f5 = v('f5', 'F', { k: 1 });

  const p1 = v('p1', 'P');
  const p2 = v('p2', 'P');
  const other = v('o1', 'OTHER');

  // f1 is reached from a :P — the ordinary case, and TWICE, so the break has repeats to skip.
  e(p1, f1);
  e(p2, f1);
  // f2's FIRST in-edge is from a non-:P and its SECOND is from a :P. This is the case the break's
  // placement decides: it must survive.
  e(other, f2);
  e(p1, f2);
  // f3 is reached ONLY from a non-:P, so a `(a:P)` filter must exclude it.
  e(other, f3);
  // f4 has no in-edge at all.
  // f5 duplicates f1's `k`, reached from a :P.
  e(p2, f5);

  return g;
};

const g = build();

const REVERSE = 'MATCH (f:F)<-[:T]-(a:P) RETURN DISTINCT f.k AS x ORDER BY x';
const FORWARD = 'MATCH (a:P)-[:T]->(f:F) RETURN DISTINCT f.k AS x ORDER BY x';

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

describe('the two spellings are one question', () => {
  test('reverse, deduped on the pattern START', () => {
    // f1 (k=1, from p1 and p2), f2 (k=2, from p1), f5 (k=1, from p2). f3 is only from :OTHER and
    // f4 has no in-edge, so neither appears. Distinct k: 1, 2.
    expect(query(g, REVERSE)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  test('forward, deduped on the far end — the same answer', () => {
    expect(query(g, FORWARD)).toEqual(query(g, REVERSE));
  });

  test('both agree with the general path', () => {
    expect(query(g, REVERSE)).toEqual(viaGeneral(REVERSE));
    expect(query(g, FORWARD)).toEqual(viaGeneral(FORWARD));
  });
});

describe('the break must come AFTER a qualifying edge, not before', () => {
  test('a vertex whose FIRST in-edge fails the label and a LATER one passes is kept', () => {
    // f2's in-edges are (o1 → f2) then (p1 → f2). Breaking out of the bucket before reaching the
    // second would drop k=2 entirely. Edge insertion order is what makes this a real ordering
    // question rather than a lucky one.
    expect(query(g, REVERSE)).toContainEqual({ x: 2 });
  });

  test('a vertex reached only through a NON-matching label is excluded', () => {
    // The mirror: f3 (k=3) is reached only from :OTHER. A walk that took `v` without checking the
    // far label at all would include it.
    expect(query(g, REVERSE)).not.toContainEqual({ x: 3 });
  });

  test('a vertex with NO in-edge is excluded', () => {
    expect(query(g, REVERSE)).not.toContainEqual({ x: 4 });
  });

  test('duplicate values across different vertices collapse to one row', () => {
    // f1 and f5 both carry k=1 and both qualify; the answer has ONE row for it.
    expect(query(g, REVERSE).filter((r) => r.x === 1).length).toBe(1);
  });
});

describe('a VACUOUS far label still filters nothing, a real one still filters', () => {
  test('when every vertex carries the far label, the answer is unchanged by it', () => {
    // Every vertex here is :P, so `(a:P)` constrains nothing and the resolve is skipped at run
    // time. The answer must be what the unlabelled spelling gives.
    const h = new Graph();
    const mk = (id: string, k: number) => h.addVertex({ id, labels: ['P'], properties: { k } });
    const [a, b, c] = [mk('a', 1), mk('b', 2), mk('c', 3)];

    h.addEdge({ from: a, to: b, labels: ['T'], properties: {} });
    h.addEdge({ from: b, to: c, labels: ['T'], properties: {} });

    const labelled = query(h, 'MATCH (f:P)<-[:T]-(a:P) RETURN DISTINCT f.k AS x ORDER BY x');
    const bare = query(h, 'MATCH (f:P)<-[:T]-(a) RETURN DISTINCT f.k AS x ORDER BY x');

    expect(labelled).toEqual([{ x: 2 }, { x: 3 }]);
    expect(labelled).toEqual(bare);
  });

  test('a NON-vacuous far label is still applied', () => {
    // This is the guard on the vacuous-label skip: `:P` is NOT carried by `o1`, so the resolve and
    // the label test must still happen, which the f3 exclusion above already asserts. Restated here
    // against the general path so the claim is about agreement, not about my arithmetic.
    expect(query(g, REVERSE)).toEqual(viaGeneral(REVERSE));
  });
});

describe('the count variant takes the same walk', () => {
  test('count(DISTINCT) over the reverse spelling', () => {
    expect(query(g, 'MATCH (f:F)<-[:T]-(a:P) RETURN count(DISTINCT f.k) AS c')).toEqual([{ c: 2 }]);
  });

  test('and agrees with the forward spelling', () => {
    expect(query(g, 'MATCH (f:F)<-[:T]-(a:P) RETURN count(DISTINCT f.k) AS c')).toEqual(
      query(g, 'MATCH (a:P)-[:T]->(f:F) RETURN count(DISTINCT f.k) AS c'),
    );
  });
});

describe('a self-loop is still reached', () => {
  test('a vertex with only a self-loop qualifies', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: { k: 9 } });

    h.addEdge({ from: s, to: s, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (f)<-[:T]-(a:P) RETURN DISTINCT f.k AS x')).toEqual([{ x: 9 }]);
  });
});
