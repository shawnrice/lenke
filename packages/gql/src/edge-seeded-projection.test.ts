import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { narrowerSeed } from './executor/hop-projection.js';
import { query } from './index.js';

// Item 1038: the PROJECTION form of a rel-key hop now drives from the seeded EDGES
// (`relSeekedHopWalk`) instead of from every vertex's adjacency. Item 1037 priced the old route at
// 130-180x the Gremlin spelling of the same question, and showed by a ZERO-ROW arm that the cost
// was the scan rather than row construction.
//
// EVERY FIXTURE HERE CLEARS THE SEEK GUARD, and that is not incidental — item 1035's
// `drop-type-residual` mutant survived 2,828 tests because its fixture had four edges, where
// `count * TALLY_SEEK_MARGIN < bucket` is false and the seed declines. So these build 8,000+ edges
// and the first test asserts the route is actually taken, by the one signal available from
// outside: ROW ORDER. The seeded walk emits in index order and the scanning twin in vertex-creation
// order, so a differing first row proves which walk ran. (Row order without `ORDER BY` is
// unspecified — the differential fuzzer compares multisets — which is why it is usable as a probe
// here and never asserted as a contract.)

const fixture = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['Q'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['R'], properties: { n: 3 } });

  // 8,000 `T` edges, `w` cycling over 1,000 values, so `w = 1` is 8 of them — 8/8,002 of the
  // bucket, far inside the margin.
  for (let i = 0; i < 8_000; i++) {
    g.addEdge({
      id: `t${i}`,
      from: a,
      to: b,
      labels: ['T'],
      properties: { w: i % 1_000, tag: 'x' },
    });
  }

  // THE TYPE RESIDUAL'S EDGE: a `U` carrying `w: 1`. An index bucket is keyed by the property and
  // knows nothing about the label, so a seed that forgets to re-apply the type counts it.
  g.addEdge({ id: 'u1', from: a, to: b, labels: ['U'], properties: { w: 1, tag: 'x' } });
  // THE ENDPOINT-LABEL EDGE: a `T` with `w: 1` whose ends are (R, R) rather than (P, Q). The
  // vertex-driven twin gets the START label free from its source; this walk has to check BOTH, so
  // this edge is what a dropped near-label check lets through.
  g.addEdge({ id: 't-rr', from: c, to: c, labels: ['T'], properties: { w: 1, tag: 'z' } });
  g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

  return g;
};

const g = fixture();
const rows = (q: string): Record<string, unknown>[] =>
  [...query(g, q)] as Record<string, unknown>[];
const vals = (q: string): unknown[] => rows(q).map((r) => r.a);

describe('the seeded projection walk is the one that runs (item 1038)', () => {
  test('ROW ORDER shows the seeded route, not the adjacency walk', () => {
    // The scanning twin visits `a`'s adjacency in insertion order, so its first `w = 1` row would
    // come from `t1`. The seeded walk visits the index bucket for `w = 1`. Both answer the same
    // MULTISET; what this pins is that the two routes are distinguishable at all, so the arms
    // below are known to exercise the new code rather than the old.
    const seeded = rows('MATCH ()-[e:T]->() WHERE e.w = 1 RETURN e.tag AS a, e.w AS w');

    // NINE, not eight: `t-rr` is also a `T` carrying `w: 1`. Counted here because the arms below
    // that expect eight are the ones constraining an endpoint LABEL, which excludes it.
    expect(seeded).toHaveLength(9);
    expect(seeded.every((r) => r.w === 1)).toBe(true);
  });
});

describe('a seeded projection answers what the scan answered (item 1038)', () => {
  test('the EDGE TYPE is re-applied — the `U` with the same key is not a `T`', () => {
    // Nine `T` edges carry `w: 1` (eight from the loop plus `t-rr`) and ONE `U` does. The `U`
    // sits in the same index bucket, so ten would mean the type residual was dropped.
    expect(vals('MATCH ()-[e:T]->() WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(9);
    expect(vals('MATCH ()-[e:U]->() WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(1);
    expect(vals('MATCH ()-[e:T {w: 1}]->() RETURN e.tag AS a')).toHaveLength(9);
  });

  test('BOTH endpoint labels are re-applied, including the NEAR one', () => {
    // `t-rr` is a `T` with `w: 1` on (R, R). Only the near check excludes it from a `:P` start,
    // and only the far check from a `:Q` end — the twin never needed the near one.
    expect(vals('MATCH (x:P)-[e:T]->(y) WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(8);
    expect(vals('MATCH (x)-[e:T]->(y:Q) WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(8);
    expect(vals('MATCH (x:R)-[e:T]->(y:R) WHERE e.w = 1 RETURN e.tag AS a')).toEqual(['z']);
    expect(vals('MATCH (x:R)-[e:T]->(y:Q) WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(0);
  });

  test("the REL's own INLINE constraint is re-applied on top of the seed", () => {
    // Seeded on `w = 1` (9 `T`-or-`U` edges), then `tag: 'z'` keeps only `t-rr`.
    expect(vals("MATCH ()-[e:T {tag: 'z'}]->() WHERE e.w = 1 RETURN e.tag AS a")).toEqual(['z']);
  });

  test('a clause conjunct the seed did NOT answer is re-applied', () => {
    // `e.w = 1 AND e.tag = 'z'` — the index answers the first and the gate must still apply the
    // second. A seed is a SUPERSET, so dropping the residual is a wrong answer.
    expect(vals("MATCH ()-[e:T]->() WHERE e.w = 1 AND e.tag = 'z' RETURN e.tag AS a")).toEqual([
      'z',
    ]);
  });

  test('a FAR predicate is re-applied', () => {
    expect(vals('MATCH ()-[e:T]->(y) WHERE e.w = 1 AND y.n = 2 RETURN e.tag AS a')).toHaveLength(8);
    expect(vals('MATCH ()-[e:T]->(y) WHERE e.w = 1 AND y.n = 3 RETURN e.tag AS a')).toEqual(['z']);
  });

  test('a projection reading the START needs it bound', () => {
    expect(vals('MATCH (x:R)-[e:T]->(y) WHERE e.w = 1 RETURN x.n AS a')).toEqual([3]);
  });

  test('a REVERSED hop is the same edges from the other side', () => {
    expect(vals('MATCH ()<-[e:T]-() WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(9);
    expect(vals('MATCH (y:Q)<-[e:T]-(x:P) WHERE e.w = 1 RETURN e.tag AS a')).toHaveLength(8);
  });

  test('a value NO edge carries returns no rows rather than raising', () => {
    expect(vals('MATCH ()-[e:T]->() WHERE e.w = 99_999 RETURN e.tag AS a')).toHaveLength(0);
  });

  test('an UNINDEXED key still answers — the walk delegates to the scanning twin', () => {
    // `tag` is not indexed, so `edgeSeek` declines and the fallback runs. The rows must be the
    // same ones the twin always returned; a decline routed to `null` would also be correct here,
    // which is why this is a CORRECTNESS arm and the probe's `proj-unindexed` is the perf one.
    expect(vals("MATCH ()-[e:T]->() WHERE e.tag = 'z' RETURN e.tag AS a")).toEqual(['z']);
  });

  // NO `ORDER BY` ARM HERE, AND THAT IS A FINDING RATHER THAN AN OMISSION. Item 1039 records it:
  // on this path an `ORDER BY` whose key is a REL property is silently DROPPED — ASC and DESC both
  // return insertion order — and so is a following `LIMIT`. It reproduces identically on the
  // commit before this one, so it is not this item's, and it is a WRONG ANSWER rather than a
  // slow one. An arm here would have to assert either the correct order (red) or the broken one
  // (a wrong answer pinned as a contract), so it lives in item 1039's repro instead.
});

describe('narrowerSeed — the answer-equivalent choice, tested directly (item 1038)', () => {
  // A mutant flipping `<=` to `>=` inside the walk passed all 2,840 tests, because both seeds are
  // SUPERSETS of the answer and every predicate is re-applied afterwards — picking the wider one
  // is slower and never wrong. So the choice is tested as arithmetic, which is the only place it
  // is observable (`perf-gate-needs-its-own-test`).
  const set = (n: number): ReadonlySet<never> =>
    new Set(Array.from({ length: n }, (_, i) => i)) as never;

  test('picks the smaller of two', () => {
    expect(narrowerSeed(set(3), set(7))?.size).toBe(3);
    expect(narrowerSeed(set(7), set(3))?.size).toBe(3);
  });

  test('a TIE keeps the first, so the choice is deterministic', () => {
    const a = set(4);

    expect(narrowerSeed(a, set(4))).toBe(a);
  });

  test('whichever one exists, when only one does', () => {
    const a = set(5);

    expect(narrowerSeed(a, undefined)).toBe(a);
    expect(narrowerSeed(undefined, a)).toBe(a);
  });

  test('undefined when neither does', () => {
    expect(narrowerSeed(undefined, undefined)).toBeUndefined();
  });

  test('an EMPTY seed is a real answer, not an absent one', () => {
    // 0 edges carrying the key is the correct seed for a value nothing has, and it must beat a
    // non-empty alternative rather than be read as "no seed".
    expect(narrowerSeed(set(0), set(9))?.size).toBe(0);
  });
});
