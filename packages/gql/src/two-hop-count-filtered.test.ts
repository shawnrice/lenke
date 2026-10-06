import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A START-FILTERED two-hop count. `patternCountOf` declined any predicate on a two-segment
// pattern — "the two-hop degree product has no route that applies a predicate" — which was true
// of the degree product (it iterates the MIDDLE and multiplies two degrees, so a predicate
// selecting which starts count has nowhere to go) and not true of the engine: the one-hop shape
// has had a per-VERTEX route since item 129. On 20,000 users at three FOLLOWS each:
//
//     1-hop count, filtered start      25.7ns a scanned vertex
//     2-hop count, filtered start      97.7ns  ->  after: 25.4ns
//
// The fixture is built so that each decline and each guard has a case that DISTINGUISHES it, not
// merely one that reaches it (audit item 206).
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: [label], properties: props });

  // a1 passes the filter, a2 does not, a3 has no `age` at all (three-valued).
  const a1 = v('a1', 'A', { age: 50, name: 'x' });
  const a2 = v('a2', 'A', { age: 20, name: 'y' });
  const a3 = v('a3', 'A', { name: 'z' });
  // A same-named WRONG-LABEL vertex: an index seek on `name` hands it back, and only the label
  // re-check drops it.
  const w1 = v('w1', 'W', { age: 50, name: 'x' });

  const m1 = v('m1', 'M', {});
  const m2 = v('m2', 'M', {});
  // A middle of the WRONG label, to prove the mid label is checked before the second leg.
  const bad = v('bad', 'BAD', {});

  const c1 = v('c1', 'C', {});
  const c2 = v('c2', 'C', {});
  const c3 = v('c3', 'C', {});
  // An END of the wrong label, so the second leg's label filter is observable.
  const badc = v('badc', 'BADC', {});

  const e = (from: ReturnType<typeof v>, to: ReturnType<typeof v>, type: string) =>
    g.addEdge({ from, to, labels: [type], properties: {} });

  // a1 -> m1 -> {c1, c2, badc}   and   a1 -> bad -> c3   and   a1 -> m2 -> c3
  e(a1, m1, 'T1');
  e(m1, c1, 'T2');
  e(m1, c2, 'T2');
  e(m1, badc, 'T2');
  e(a1, bad, 'T1');
  e(bad, c3, 'T2');
  e(a1, m2, 'T1');
  e(m2, c3, 'T2');

  // a2 -> m1 -> ... : a2 is excluded by the filter, so none of m1's three ends should count
  // through it. Sharing m1 with a1 is deliberate — a mid-driven count cannot tell the two apart.
  e(a2, m1, 'T1');

  // a3 -> m2 -> c3
  e(a3, m2, 'T1');

  // An edge of a DIFFERENT type out of a1, to a middle that does have T2 edges. The first leg
  // must follow T1 only: a walk that ignored its edge type would follow this too and count m1's
  // ends twice. Without it, a1 has nothing but T1 edges and the type filter is unobservable —
  // the mutant that drops it survived a 22-test file on the first sweep.
  e(a1, m1, 'OTHER');

  // w1 -> m1 -> ... : reachable only if the wrong label leaks in.
  e(w1, m1, 'T1');

  return g;
};

const g = build();

const Q = 'MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c';

/** Forced to the general path by a dead `LET`, which every count shortcut declines. */
const viaGeneral = (q: string, params?: Record<string, unknown>) =>
  query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '), params);

const agree = (q: string, params?: Record<string, unknown>) => {
  const fast = query(g, q, params);

  expect(fast).toEqual(viaGeneral(q, params));

  return fast;
};

describe('the filtered two-hop count agrees with the general path', () => {
  test('a clause WHERE on the start', () => {
    // Only a1 passes. Through m1: c1 and c2 (badc is the wrong end label). Through m2: c3.
    // `bad` is the wrong MID label, so a1 -> bad -> c3 does not count. Total 3.
    expect(agree(Q)).toEqual([{ c: 3 }]);
  });

  test('the INLINE spelling of the same filter', () => {
    expect(agree('MATCH (a:A {name: "x"})-[:T1]->(m:M)-[:T2]->(c:C) RETURN count(*) AS c')).toEqual(
      [{ c: 3 }],
    );
  });

  test('a param, which is what an index would seed from', () => {
    expect(
      agree('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.name = $n RETURN count(*) AS c', {
        n: 'x',
      }),
    ).toEqual([{ c: 3 }]);
  });

  test('an inline constraint AND a clause WHERE together', () => {
    expect(
      agree(
        'MATCH (a:A {name: "x"})-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c',
      ),
    ).toEqual([{ c: 3 }]);
    // The same two filters where they DISAGREE: nothing can satisfy both.
    expect(
      agree(
        'MATCH (a:A {name: "y"})-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c',
      ),
    ).toEqual([{ c: 0 }]);
  });

  test('a start EXCLUDED by the filter contributes nothing through a shared middle', () => {
    // The inverse filter: only a2 (age 20) passes — a1 is 50 and a3 has no `age` at all. a2
    // reaches only m1, whose T2 edges are c1, c2 and badc, and `(c:C)` drops badc. So 2.
    //
    // This is the case that separates start-driven from mid-driven counting: a1, a2 and w1 all
    // point at m1, so a count that iterated the MIDDLE and multiplied degrees could not tell
    // which of them the filter kept, and would answer the same number for both directions of
    // this filter. The test above answers 3 and this one answers 2.
    expect(
      agree('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age < 40 RETURN count(*) AS c'),
    ).toEqual([{ c: 2 }]);
  });

  test('an absent key matches nothing — ISO three-valued', () => {
    // a3 has no `age`, so `a3.age > 40` is UNKNOWN and its one path must not count.
    expect(
      agree('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 999 RETURN count(*) AS c'),
    ).toEqual([{ c: 0 }]);
  });

  test('a filter nothing satisfies', () => {
    expect(
      agree('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.name = "nope" RETURN count(*) AS c'),
    ).toEqual([{ c: 0 }]);
  });

  test('no mid or end label — every middle and end counts', () => {
    // a1: m1 -> 3 ends, bad -> 1, m2 -> 1. Total 5.
    expect(
      agree('MATCH (a:A)-[:T1]->(m)-[:T2]->(c) WHERE a.age > 40 RETURN count(*) AS c'),
    ).toEqual([{ c: 5 }]);
  });

  test('a REVERSED second leg', () => {
    expect(
      agree('MATCH (a:A)-[:T1]->(m:M)<-[:T1]-(c:A) WHERE a.age > 40 RETURN count(*) AS c'),
    ).toEqual(
      viaGeneral('MATCH (a:A)-[:T1]->(m:M)<-[:T1]-(c:A) WHERE a.age > 40 RETURN count(*) AS c'),
    );
  });

  test('a REVERSED first leg', () => {
    expect(
      agree('MATCH (c:C)<-[:T2]-(m:M)<-[:T1]-(a:A) WHERE c.id IS NOT NULL RETURN count(*) AS c'),
    ).toEqual(
      viaGeneral(
        'MATCH (c:C)<-[:T2]-(m:M)<-[:T1]-(a:A) WHERE c.id IS NOT NULL RETURN count(*) AS c',
      ),
    );
  });

  test('the UNFILTERED count still answers (the degree product keeps it)', () => {
    // a1 and a2 and w1 all reach m1; a1 and a3 reach m2. With no filter this is the product's
    // case and it must be unchanged.
    expect(agree('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) RETURN count(*) AS c')).toEqual([{ c: 6 }]);
  });
});

describe('the label is re-checked when the start is SEEDED', () => {
  test('a same-named WRONG-LABEL start is excluded', () => {
    const h = build();

    h.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

    const q = 'MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.name = $n RETURN count(*) AS c';

    // w1 is label W with name 'x' and points at m1. An index on `name` seeds it; only the label
    // check drops it. Leaking it would add m1's two valid ends and answer 5.
    expect(query(h, q, { n: 'x' })).toEqual([{ c: 3 }]);
    expect(query(h, q, { n: 'x' })).toEqual(query(build(), q, { n: 'x' }));
  });

  test('an UNLABELLED start over an index keeps the wrong-label vertex', () => {
    // The mirror: with no label to constrain it, w1 SHOULD count. A re-check that rejected
    // everything would pass the test above and fail this one.
    const h = build();

    h.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

    const q = 'MATCH (a)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.name = $n RETURN count(*) AS c';

    expect(query(h, q, { n: 'x' })).toEqual(query(build(), q, { n: 'x' }));
    expect(query(h, q, { n: 'x' })).toEqual([{ c: 5 }]);
  });
});

describe('the shapes it must decline', () => {
  const declines = (q: string) => {
    expect(query(g, q)).toEqual(viaGeneral(q));
  };

  test('a predicate reading the MIDDLE', () => {
    // The walk gates a start and then expands; a mid-reading predicate would have to apply per
    // expanded edge. It must reach the general path instead.
    declines('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE m.id IS NOT NULL RETURN count(*) AS c');
  });

  test('a predicate reading the END', () => {
    declines('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE c.id IS NOT NULL RETURN count(*) AS c');
  });

  test('a predicate reading the start AND the end', () => {
    declines(
      'MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 AND c.id IS NOT NULL RETURN count(*) AS c',
    );
  });

  test('a rel VARIABLE', () => {
    declines('MATCH (a:A)-[r:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c');
  });

  test('an undirected leg', () => {
    declines('MATCH (a:A)-[:T1]-(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c');
  });

  test('an inline constraint on the MIDDLE or the END has no route', () => {
    declines('MATCH (a:A)-[:T1]->(m:M {k: 1})-[:T2]->(c:C) WHERE a.age > 40 RETURN count(*) AS c');
    declines('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C {k: 1}) WHERE a.age > 40 RETURN count(*) AS c');
  });

  test('a SHARED node variable is a self-join neither counting shape expresses', () => {
    declines('MATCH (a:A)-[:T1]->(m:M)-[:T2]->(a) WHERE a.age > 40 RETURN count(*) AS c');
  });

  test('a quantified segment keeps the general matcher', () => {
    const q = 'MATCH (a:A)-[:T1]->{1,2}(m) WHERE a.age > 40 RETURN count(*) AS c';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('count(DISTINCT) is not count(*)', () => {
    const q =
      'MATCH (a:A)-[:T1]->(m:M)-[:T2]->(c:C) WHERE a.age > 40 RETURN count(DISTINCT c) AS c';

    expect(query(g, q)).toEqual(viaGeneral(q));
  });
});
