import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Two changes in audit item 217, both making the START-keyed dedup walk ask what the FAR-driven
// walk already asked:
//
//   1. `candidateVertices` is a GENERATOR (`yield* graph.verticesById.values()`), so a whole-graph
//      scan paid a generator frame and a `.next()` per vertex to hand back an iterator's own
//      elements. The far-driven walk used the direct `candidateVertexSource`; this one did not.
//   2. When the dedup is keyed on the start and `needsFar` is false, the bucket's EMPTINESS is the
//      whole question: `far` stays `v`, so neither the label test nor `take` reads the edge. The
//      iterator AND the per-vertex far-label test both go.
//
// `MATCH (f)<-[:KNOWS]-(a:Person) RETURN DISTINCT f.age` went 102.8 -> 57.9ms, from 1.64x of the
// forward spelling to 0.95x of it.
//
// The risk the tests below cover: dropping the far-label test is sound ONLY because a false
// `needsFar` under `onStart` means the far label is absent or VACUOUS. A label only some vertices
// carry must still filter, which means the gate must NOT fire for it.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], k: unknown) =>
    g.addVertex({ id, labels, properties: { k } });

  // `reached` vertices have an in-edge; `lonely` has none and must never appear.
  const r1 = v('r1', ['T'], 1);
  const r2 = v('r2', ['T'], 2);
  const r3 = v('r3', ['T'], 1);

  v('lonely', ['T'], 99);

  // Sources carry MIXED labels, so a far label is non-vacuous and must still be applied.
  const pa = v('pa', ['P'], 0);
  const pb = v('pb', ['P'], 0);
  const qa = v('qa', ['Q'], 0);

  g.addEdge({ from: pa, to: r1, labels: ['KNOWS'], properties: {} });
  g.addEdge({ from: pb, to: r1, labels: ['KNOWS'], properties: {} });
  g.addEdge({ from: pa, to: r2, labels: ['KNOWS'], properties: {} });
  // r3 is reached ONLY from a :Q, so a `:P` far label must exclude it.
  g.addEdge({ from: qa, to: r3, labels: ['KNOWS'], properties: {} });
  // An edge of a DIFFERENT type, so the type filter is load-bearing too.
  g.addEdge({ from: pa, to: v('other', ['T'], 42), labels: ['LIKES'], properties: {} });

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

describe('a start-keyed dedup over a reversed hop', () => {
  test('only vertices with an in-edge of the type appear', () => {
    // r1 (k=1), r2 (k=2), r3 (k=1) are reached; `lonely` and `other` are not reached by :KNOWS.
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a) RETURN DISTINCT f.k AS x ORDER BY x')).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
  });

  test('a vertex with no in-edge at all is excluded', () => {
    expect(
      query(g, 'MATCH (f:T)<-[:KNOWS]-(a) RETURN DISTINCT f.k AS x ORDER BY x'),
    ).not.toContainEqual({ x: 99 });
  });

  test('an in-edge of the WRONG type does not count as reached', () => {
    // `other` has only a :LIKES in-edge, so k=42 must not appear.
    expect(
      query(g, 'MATCH (f:T)<-[:KNOWS]-(a) RETURN DISTINCT f.k AS x ORDER BY x'),
    ).not.toContainEqual({ x: 42 });
  });

  test('and agrees with the general path', () => {
    const q = 'MATCH (f:T)<-[:KNOWS]-(a) RETURN DISTINCT f.k AS x ORDER BY x';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });
});

describe('a NON-vacuous far label must still be applied', () => {
  test('a :P source label excludes a vertex reached only from a :Q', () => {
    // This is the guard on dropping the far-label test. `:P` is carried by pa/pb but not qa, so
    // `needsFar` is true, the gate must NOT fire, and r3 (k=1, reached only from qa) is excluded
    // -- leaving r1 (k=1) and r2 (k=2), which still gives 1 and 2. So the DISTINCT values do not
    // distinguish it; the count below does.
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a:P) RETURN DISTINCT f.k AS x ORDER BY x')).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
  });

  test('a :Q source label admits ONLY the vertex reached from it', () => {
    // The distinguishing direction: reached-from-:Q is r3 alone (k=1). If the far-label test were
    // skipped here, r2 (k=2) would appear too.
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a:Q) RETURN DISTINCT f.k AS x ORDER BY x')).toEqual([
      { x: 1 },
    ]);
  });

  test('a label NOBODY carries admits nothing', () => {
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a:Nope) RETURN DISTINCT f.k AS x')).toEqual([]);
  });

  test('both agree with the general path', () => {
    for (const lab of ['P', 'Q', 'Nope']) {
      const q = `MATCH (f:T)<-[:KNOWS]-(a:${lab}) RETURN DISTINCT f.k AS x ORDER BY x`;

      expect(query(g, q)).toEqual(viaGeneral(q));
    }
  });

  test('count mode applies the far label too', () => {
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a:Q) RETURN count(DISTINCT f.k) AS c')).toEqual([
      { c: 1 },
    ]);
    expect(query(g, 'MATCH (f:T)<-[:KNOWS]-(a:P) RETURN count(DISTINCT f.k) AS c')).toEqual([
      { c: 2 },
    ]);
  });
});

describe('a VACUOUS far label changes nothing', () => {
  test('when every source carries the label, the answer equals the unlabelled spelling', () => {
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['P'], properties: { k } });
    const [a, b, c] = [v('a', 1), v('b', 2), v('c', 3)];

    h.addEdge({ from: a, to: b, labels: ['T'], properties: {} });
    h.addEdge({ from: b, to: c, labels: ['T'], properties: {} });

    const labelled = query(h, 'MATCH (f:P)<-[:T]-(a:P) RETURN DISTINCT f.k AS x ORDER BY x');
    const bare = query(h, 'MATCH (f:P)<-[:T]-(a) RETURN DISTINCT f.k AS x ORDER BY x');

    expect(labelled).toEqual([{ x: 2 }, { x: 3 }]);
    expect(labelled).toEqual(bare);
  });
});

describe('a vertex whose last edge was removed stops being reached', () => {
  // The emptiness test (`bucket.size > 0`) is only reachable-false if a bucket can be PRESENT and
  // EMPTY. The index drops the entry when its set empties, so it cannot — which is exactly why
  // this is worth a test: it pins the INVARIANT the cheap gate leans on, rather than the branch.
  // If de-indexing ever stopped removing the entry, the walk would emit an unreached vertex and
  // this test is what would say so.
  test('removing the only in-edge excludes the vertex again', () => {
    const h = new Graph();
    const v = (id: string, k: number) => h.addVertex({ id, labels: ['W'], properties: { k } });
    const [src, dst, keep] = [v('src', 0), v('dst', 5), v('keep', 6)];

    const doomed = h.addEdge({ from: src, to: dst, labels: ['E'], properties: {} });

    h.addEdge({ from: src, to: keep, labels: ['E'], properties: {} });

    const q = 'MATCH (f:W)<-[:E]-(a) RETURN DISTINCT f.k AS x ORDER BY x';

    expect(query(h, q)).toEqual([{ x: 5 }, { x: 6 }]);

    h.removeEdge(doomed);

    // `dst` now has an in-adjacency entry that is either gone or empty. Either way it is NOT
    // reached, so k=5 must disappear while k=6 stays.
    expect(query(h, q)).toEqual([{ x: 6 }]);
    expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });
});

describe('first-seen order survives the iteration-source swap', () => {
  // The dedup keeps FIRST-SEEN order and that order is OBSERVABLE without an `ORDER BY`, so
  // swapping `candidateVertices` for `candidateVertexSource` has to yield the same elements in the
  // same sequence. Item 142 gave back 7.4x for getting this exact thing wrong.
  const h = new Graph();
  const v = (id: string, k: number) => h.addVertex({ id, labels: ['Z'], properties: { k } });
  // Insertion order deliberately NOT sorted by `k`, so a sequence change is visible.
  const [z1, z2, z3, z4] = [v('z1', 30), v('z2', 10), v('z3', 20), v('z4', 10)];

  for (const t of [z1, z2, z3, z4]) {
    h.addEdge({ from: t, to: t, labels: ['E'], properties: {} });
  }

  test('a node dedup yields insertion order, not sorted order', () => {
    expect(query(h, 'MATCH (n:Z) RETURN DISTINCT n.k AS x')).toEqual([
      { x: 30 },
      { x: 10 },
      { x: 20 },
    ]);
  });

  test('a start-keyed hop dedup yields the same order', () => {
    expect(query(h, 'MATCH (f:Z)<-[:E]-(a) RETURN DISTINCT f.k AS x')).toEqual([
      { x: 30 },
      { x: 10 },
      { x: 20 },
    ]);
  });

  test('and both match the general path element for element', () => {
    for (const q of [
      'MATCH (n:Z) RETURN DISTINCT n.k AS x',
      'MATCH (f:Z)<-[:E]-(a) RETURN DISTINCT f.k AS x',
    ]) {
      expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
    }
  });

  test('an UNLABELLED scan (the whole-graph source) keeps insertion order too', () => {
    // The two sources differ in exactly this branch: no label means `verticesById.values()`.
    expect(query(h, 'MATCH (n) RETURN DISTINCT n.k AS x')).toEqual([
      { x: 30 },
      { x: 10 },
      { x: 20 },
    ]);
  });
});
