import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `farOnlyHopCount` (audit item 137): when a 1-hop count's predicate reads only the FAR
// endpoint, it is decided once per far VERTEX and each survivor contributes its whole
// matching IN-degree, instead of once per edge.
//
// The fixture is built so a per-vertex SUM cannot be confused with a COUNT of survivors —
// the trap that would make the obvious bug invisible. Survivors have in-degrees 3, 1, 2
// and 0, so:
//
//   expected answer        6   (3 + 1 + 2 + 0)
//   surviving vertices     4
//   edges of type T       10
//   vertices               8
//
// Four distinct numbers. A non-survivor is given the LARGEST in-degree (4) so counting it
// cannot pass either.
const N = 8;
// `n` drives the far predicate `n > 9`: survivors are v0, v1, v2, v5. v4 has NO `n` at all,
// so the three-valued filter must drop it rather than treat absent as 0.
const NUM: (number | undefined)[] = [10, 20, 30, 5, undefined, 40, 1, 2];
const SURVIVORS = [0, 1, 2, 5];
// Type-T edges. Into v0: 3 (one of them a SELF-LOOP). Into v1: 1. Into v2: 2 (PARALLEL,
// same pair twice). Into v5: 0. Into v3: 4, and v3 fails the predicate.
const T_EDGES: readonly (readonly [number, number])[] = [
  [6, 0],
  [7, 0],
  [0, 0], // self-loop: v0's own in-degree includes it
  [3, 1],
  [6, 2],
  [6, 2], // parallel: both count
  [1, 3],
  [2, 3],
  [5, 3],
  [7, 3],
];
// One `S` edge, so a type-filtered count differs from an untyped one.
const S_EDGES: readonly (readonly [number, number])[] = [[0, 1]];

const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      // Every vertex is `P`, so the START label is vacuous and the walk is reachable;
      // `Q` on a subset gives the FAR label something to exclude.
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: NUM[i] === undefined ? { tag: 't' } : { n: NUM[i], tag: 't' },
    }),
  );

  for (const [a, b] of T_EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['T'], properties: { w: a } });
  }

  for (const [a, b] of S_EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['S'], properties: { w: a } });
  }

  return g;
};

/** In-degree of `v` over type-T edges. */
const inDegT = (v: number): number => T_EDGES.filter(([, b]) => b === v).length;

const countOf = (g: Graph, q: string): number => (query(g, q)[0]?.c as number) ?? -1;

/**
 * The same question routed through the per-edge TALLY instead of the per-vertex walk, by
 * making the predicate also read the START variable — which fails both walks' guards (one
 * needs `farVar` unset, the other `startVar` unset) and falls through to the tally.
 *
 * `a.tag = a.tag` is the added conjunct and every vertex carries `tag`, so it is TRUE for
 * every row and changes no answer; an absent property would make it NULL and drop rows,
 * which is exactly why a present one is used.
 */
const viaTally = (g: Graph, q: string): number => {
  const i = q.indexOf(' RETURN ');
  const head = q.slice(0, i);
  const start = /MATCH \((\w+)/.exec(head)?.[1] ?? 'a';
  const joined = head.includes(' WHERE ')
    ? `${head} AND ${start}.tag = ${start}.tag`
    : `${head} WHERE ${start}.tag = ${start}.tag`;

  return countOf(g, `${joined}${q.slice(i)}`);
};

describe('far-endpoint 1-hop count', () => {
  test('a far-only clause predicate sums survivors in-degrees', () => {
    const g = build();
    const q = 'MATCH (a:P)-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c';
    const expected = SURVIVORS.reduce((n, v) => n + inDegT(v), 0);

    expect(expected).toBe(6);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
    // Not the count of survivors, not the edge total.
    expect(countOf(g, q)).not.toBe(SURVIVORS.length);
    expect(countOf(g, q)).not.toBe(T_EDGES.length);
  });

  test('an absent property is dropped by the three-valued filter', () => {
    const g = build();
    // v4 has no `n`. `x.n < 100` must not pick it up, so the answer is the survivors of
    // `n < 100` excluding v4 — every vertex with an `n`, by their in-degrees.
    const q = 'MATCH (a:P)-[:T]->(x) WHERE x.n < 100 RETURN count(*) AS c';
    const expected = [0, 1, 2, 3, 5, 6, 7].reduce((n, v) => n + inDegT(v), 0);

    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('an inline far constraint takes the same route and agrees', () => {
    const g = build();
    // The pair items 124-125 were about: the inline spelling and the clause spelling of
    // one question must cost the same, so both now take this walk.
    const inline = countOf(g, 'MATCH (a:P)-[:T]->(x {n: 30}) RETURN count(*) AS c');
    const clause = countOf(g, 'MATCH (a:P)-[:T]->(x) WHERE x.n = 30 RETURN count(*) AS c');

    expect(inline).toBe(inDegT(2));
    expect(inline).toBe(2);
    expect(clause).toBe(inline);
  });

  test('the FAR label is applied', () => {
    const g = build();
    // `Q` is on even vertices. Survivors of `n > 9` that are also `Q`: v0 and v2.
    const q = 'MATCH (a:P)-[:T]->(x:Q) WHERE x.n > 9 RETURN count(*) AS c';
    const expected = SURVIVORS.filter((v) => v % 2 === 0).reduce((n, v) => n + inDegT(v), 0);

    expect(expected).toBe(5);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('a reversed hop whose FAR end is the edge source walks the forward index', () => {
    const g = build();
    // Which variable is the pattern's START decides which walk runs, and it is easy to
    // get backwards: in `(x)<-[:T]-(a)` the start is `x`, so a predicate on `x` belongs to
    // the TWIN. To reach this walk with a reversed hop the FAR end must be the one the
    // predicate reads — `(a)<-[:T]-(x)`, where `x` is the edge's SOURCE, so the walk reads
    // the FORWARD index and sums OUT-degree.
    const q = 'MATCH (a:P)<-[:T]-(x) WHERE x.n > 9 RETURN count(*) AS c';
    const outDeg = (v: number): number => T_EDGES.filter(([a]) => a === v).length;
    const expected = SURVIVORS.reduce((n, v) => n + outDeg(v), 0);

    // v0 has 1 out-edge (its self-loop), v1 1, v2 1, v5 1 — four, distinct from the 6 the
    // in-degree sum gives, so the two directions cannot be confused.
    expect(expected).toBe(4);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('the two spellings of ONE hop agree', () => {
    const g = build();
    // `(a)-[:T]->(x)` and `(x)<-[:T]-(a)` are the same pattern written two ways, so they
    // must give the same answer whichever walk each one routes to — the first reads the
    // far end (this walk), the second reads the start (the twin). This is the invariant
    // that caught my own arithmetic above.
    const forward = countOf(g, 'MATCH (a:P)-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c');
    const reversed = countOf(g, 'MATCH (x)<-[:T]-(a:P) WHERE x.n > 9 RETURN count(*) AS c');

    expect(forward).toBe(6);
    expect(reversed).toBe(forward);
  });

  test('an untyped hop counts every type', () => {
    const g = build();
    const q = 'MATCH (a:P)-[]->(x) WHERE x.n > 9 RETURN count(*) AS c';
    const inDegAny = (v: number): number =>
      [...T_EDGES, ...S_EDGES].filter(([, b]) => b === v).length;
    const expected = SURVIVORS.reduce((n, v) => n + inDegAny(v), 0);

    // 6 from T plus the one S edge into v1.
    expect(expected).toBe(7);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('a START-reading predicate does not take this walk', () => {
    const g = build();
    // Reads only the start, so it belongs to the twin (`startOnlyHopCount`).
    const q = 'MATCH (a:P)-[:T]->(x) WHERE a.n > 9 RETURN count(*) AS c';
    const outDeg = (v: number): number => T_EDGES.filter(([a]) => a === v).length;
    const expected = SURVIVORS.reduce((n, v) => n + outDeg(v), 0);

    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('a predicate reading BOTH ends still tallies per edge', () => {
    const g = build();
    // Neither walk can answer this: the comparison is per EDGE.
    const q = 'MATCH (a:P)-[:T]->(x) WHERE x.n > a.n RETURN count(*) AS c';
    const expected = T_EDGES.filter(([a, b]) => {
      const na = NUM[a];
      const nb = NUM[b];

      return na !== undefined && nb !== undefined && nb > na;
    }).length;

    expect(countOf(g, q)).toBe(expected);
  });

  test('a multi-label EDGE declines rather than double-counting', () => {
    const g = build();
    // An edge carrying both T and S sits in two buckets, so summing per-type bucket sizes
    // would count it twice. `multiTypeEdgeCount > 0` must make the walk decline.
    const from = g.getVertexById('v6');
    const to = g.getVertexById('v0');

    if (from === null || to === null) {
      throw new Error('fixture lost a vertex');
    }

    g.addEdge({ from, to, labels: ['T', 'S'] });

    const q = 'MATCH (a:P)-[:T|S]->(x) WHERE x.n > 9 RETURN count(*) AS c';
    // The honest answer counts that edge ONCE.
    const expected = 6 + 1 /* S into v1 */ + 1; /* the new T|S edge into v0 */

    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('a surviving vertex with no in-edges contributes nothing', () => {
    const g = build();
    // v5 survives `n > 9` and has in-degree 0; the answer must not change if its edges
    // are the only thing that differs.
    expect(inDegT(5)).toBe(0);
    expect(countOf(g, 'MATCH (a:P)-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c')).toBe(6);
  });

  test('a non-survivor with the LARGEST in-degree is excluded', () => {
    const g = build();
    // v3 has in-degree 4, more than any survivor, and fails `n > 9`.
    expect(inDegT(3)).toBe(4);
    expect(NUM[3]).toBe(5);
    expect(countOf(g, 'MATCH (a:P)-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c')).toBe(6);
  });

  test('a non-vacuous START label declines, because in-degree ignores the source', () => {
    const g = build();
    // An in-degree counts edges from ANY source, so the walk cannot apply a start label.
    // `Q` is on the even vertices, so this must NOT be the unrestricted 6.
    const q = 'MATCH (a:Q)-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c';
    const expected = T_EDGES.filter(([a, b]) => a % 2 === 0 && SURVIVORS.includes(b)).length;

    expect(expected).toBe(4);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('BOTH endpoints inline: the start constraint is not dropped', () => {
    const g = build();
    // No clause `WHERE`, so this takes the inline-only branch — a different guard from the
    // one above, and mutation showed it was uncovered: removing its `inNear` check
    // survived every other test here.
    //
    // The far end is v0 (`n = 10`), whose three in-edges come from v6, v7 and ITSELF, so a
    // walk that ignored the start constraint would answer 3 where the truth is the one
    // edge from v6 (`n = 1`). A far vertex whose in-edges all shared one source would make
    // those two numbers equal and prove nothing.
    const q = 'MATCH (a:P {n: 1})-[:T]->(x {n: 10}) RETURN count(*) AS c';
    const expected = T_EDGES.filter(([a, b]) => NUM[a] === 1 && NUM[b] === 10).length;

    expect(expected).toBe(1);
    expect(inDegT(0)).toBe(3);
    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });

  test('an inline START constraint declines for the same reason', () => {
    const g = build();
    const q = 'MATCH (a:P {n: 10})-[:T]->(x) WHERE x.n > 9 RETURN count(*) AS c';
    const expected = T_EDGES.filter(([a, b]) => NUM[a] === 10 && SURVIVORS.includes(b)).length;

    expect(countOf(g, q)).toBe(expected);
    expect(viaTally(g, q)).toBe(expected);
  });
});
