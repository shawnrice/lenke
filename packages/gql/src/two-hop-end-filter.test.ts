import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `MATCH (a)-[r1]->(b)-[r2]->(c)` and `MATCH (c)<-[r2]-(b)<-[r1]-(a)` match the same (edge, edge)
// pairs, so a COUNT over one is the count over the other — which makes the END-filtered question
// the START-filtered question written backwards, and that one has had a walk since item 206.
//
// Measured before building anything, which is why item 220 needed no new walk: the same question
// and the same answer, 200,000 vertices at degree 5:
//
//     (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60    2363.5 -> 117.7ms    20.1x
//     … WHERE c.age = 61                          2011.8 ->  12.7     158x
//     (c {age: 61}) inline                        1362.6 ->  12.3     111x
//     the hand-reversed spelling, for reference    118.1 -> 138.0
//
// THE RISK IS THE DIRECTION FLIP. A reversal that mis-flips a leg still returns a number, and on a
// fixture where every vertex has equal in- and out-degree it returns the RIGHT number — so the
// fixture below is deliberately asymmetric: the middle has in-degree 1 and out-degree 2, and the
// two legs are exercised in all four direction combinations.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], age: number) =>
    g.addVertex({ id, labels, properties: { age } });
  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>, ty = 'T') =>
    g.addEdge({ from: f, to: t, labels: [ty], properties: {} });

  const a1 = v('a1', ['A'], 10);
  const a2 = v('a2', ['A'], 20);
  const b1 = v('b1', ['M'], 30);
  const b2 = v('b2', ['M'], 40);
  const c1 = v('c1', ['C'], 70);
  const c2 = v('c2', ['C'], 71);
  const c3 = v('c3', ['X'], 70);

  // b1: in-degree 2 (a1, a2), out-degree 3 (c1, c2, c3) — deliberately unequal, so swapping the
  // two factors gives a different product.
  e(a1, b1);
  e(a2, b1);
  e(b1, c1);
  e(b1, c2);
  e(b1, c3);
  // b2: in-degree 1, out-degree 1.
  e(a1, b2);
  e(b2, c1);
  // A different edge TYPE, so the type filter stays load-bearing through the reversal.
  e(a1, v('other', ['A'], 0), 'U');

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the count shortcuts decline. */
const general = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

describe('an END-filtered two-hop count', () => {
  test('agrees with the general path', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('and the answer is what the paths actually are', () => {
    // Ends with age > 60: c1 (70), c2 (71), c3 (70). Paths into them:
    //   via b1 (in-degree 2): b1->c1, b1->c2, b1->c3 = 3 x 2 = 6
    //   via b2 (in-degree 1): b2->c1 = 1 x 1 = 1
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n')).toEqual(
      [{ n: 7 }],
    );
  });

  test('a selective end predicate', () => {
    // Only c2 (71): reached from b1, whose in-degree is 2.
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual([{ n: 2 }]);
  });

  test('every end spelling is one question', () => {
    const spellings = [
      'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c WHERE c.age = 71) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c {age: 71}) RETURN count(*) AS n',
    ];

    for (const q of spellings) {
      expect(query(g, q)).toEqual(query(g, spellings[0]));
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('and the hand-reversed spelling gives the same count', () => {
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n')).toEqual(
      query(g, 'MATCH (c)<-[:T]-(b)<-[:T]-(a) WHERE c.age > 60 RETURN count(*) AS n'),
    );
  });

  test('an end predicate matching nothing counts nothing', () => {
    expect(
      query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 1000 RETURN count(*) AS n'),
    ).toEqual([{ n: 0 }]);
  });

  test('an end predicate matching everything equals the unfiltered count', () => {
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > -1 RETURN count(*) AS n')).toEqual(
      query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) RETURN count(*) AS n'),
    );
  });
});

describe('the direction flip, in all four combinations', () => {
  // The middle's in-degree (2) and out-degree (3) differ, so a mis-flipped leg produces a
  // DIFFERENT number rather than the same one — which is the only way a test can see the bug.
  const SHAPES = [
    'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)<-[:T]-(c) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a)<-[:T]-(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a)<-[:T]-(b)<-[:T]-(c) WHERE c.age > 60 RETURN count(*) AS n',
  ];

  for (const q of SHAPES) {
    test(q.slice(6, q.indexOf(' WHERE')), () => {
      expect(query(g, q)).toEqual(general(q));
    });
  }

  test('the four shapes do NOT all give the same answer, so agreement means something', () => {
    const answers = SHAPES.map((q) => query(g, q)[0].n);

    expect(new Set(answers).size).toBeGreaterThan(1);
  });

  test('ANONYMOUS start and middle still reverse correctly', () => {
    // The distinguishing input for "which node does the reversed pattern start from". With all
    // three nodes NAMED, a reversal that started from the middle collides two variables and the
    // builder's own duplicate-variable guard declines it — so the mutant is harmless and
    // invisible. Anonymous nodes have no variables to collide, so the wrong start reaches the
    // walk and returns a wrong count.
    for (const q of [
      'MATCH ()-[:T]->()-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
      'MATCH ()-[:T]->()-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
      'MATCH (a)-[:T]->()-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
      'MATCH ()-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('an anonymous end with an inline constraint reverses correctly', () => {
    const q = 'MATCH ()-[:T]->()-[:T]->({age: 71}) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual([{ n: 2 }]);
  });

  test('a LABELLED anonymous middle pins which node the reversal starts from', () => {
    // The distinguishing input for mutant "reversed pattern starts from the MIDDLE". With named
    // nodes a variable collision declines it; with plain anonymous nodes the walk is genuinely
    // equivalent, because only the START NODE'S LABEL differs. So the middle must be anonymous
    // (no collision) AND labelled differently from the end (so the label matters): starting from
    // `:M` gates b1/b2 by the END's predicate, which neither passes, giving 0 instead of 7.
    for (const q of [
      'MATCH (a)-[:T]->(:M)-[:T]->(c:C) WHERE c.age > 60 RETURN count(*) AS n',
      'MATCH ()-[:T]->(:M)-[:T]->(c:C) WHERE c.age = 71 RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }

    // And the answer is non-zero, so "0 instead of 7" is actually distinguishable.
    expect(
      query(g, 'MATCH (a)-[:T]->(:M)-[:T]->(c:C) WHERE c.age > 60 RETURN count(*) AS n')[0].n,
    ).toBeGreaterThan(0);
  });

  test('the anonymous spellings agree with the named ones', () => {
    expect(query(g, 'MATCH ()-[:T]->()-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n')).toEqual(
      query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n'),
    );
  });

  test('an asymmetric middle makes a swapped product visible', () => {
    // b1 is in-degree 2, out-degree 3. If the reversal read the two factors the wrong way round
    // the unfiltered-equivalent count would still be 2*3, but the FILTERED one would not: only
    // some of b1's out-edges reach a qualifying end.
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n';

    expect(query(g, q)).toEqual([{ n: 2 }]);
    // Reading the factors the other way round would give 3 (b1's out-degree), not 2.
    expect(query(g, q)).not.toEqual([{ n: 3 }]);
  });
});

describe('labels and types survive the reversal', () => {
  const SHAPES = [
    'MATCH (a:A)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b:M)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)-[:T]->(c:C) WHERE c.age > 60 RETURN count(*) AS n',
    'MATCH (a:A)-[:T]->(b:M)-[:T]->(c:C) WHERE c.age > 60 RETURN count(*) AS n',
    // `:C` excludes c3, so the label must still bite after the reversal.
    'MATCH (a)-[:T]->(b)-[:T]->(c:C) WHERE c.age = 70 RETURN count(*) AS n',
    // A type that only one edge carries.
    'MATCH (a)-[:U]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
  ];

  for (const q of SHAPES) {
    test(q.slice(6, Math.min(q.indexOf(' WHERE'), 60)), () => {
      expect(query(g, q)).toEqual(general(q));
    });
  }

  test('the end label genuinely narrows the answer', () => {
    const withLabel = query(
      g,
      'MATCH (a)-[:T]->(b)-[:T]->(c:C) WHERE c.age > 60 RETURN count(*) AS n',
    );
    const without = query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n');

    // c3 is `:X` with age 70, so it is in `without` and not in `withLabel`.
    expect(withLabel).not.toEqual(without);
  });
});

describe('what the reversed route must NOT claim', () => {
  test('an END predicate alongside a START one still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE a.age > 5 AND c.age > 60 RETURN count(*) AS n';

    // No route gates both ends, so this declines to the general path. The point is the ANSWER.
    expect(query(g, q)).toEqual(general(q));
  });

  test('an INLINE start constraint plus a CLAUSE end predicate declines', () => {
    // The combination the `AND` spelling above cannot reach: a clause `WHERE` reading only `c`
    // sets the end predicate, and an INLINE constraint on `a` sets the start one. The reversed
    // route refuses it (the start is constrained), and without the explicit decline it falls
    // through to the start-driven builder — which would apply the start constraint and SILENTLY
    // DROP the end predicate, counting too much. A mutant proved this path live: removing that
    // `return null` passed every other test in this file.
    for (const q of [
      'MATCH (a {age: 10})-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
      'MATCH (a {age: 10})-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
      'MATCH (a WHERE a.age > 5)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b {age: 30})-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('and that decline is not vacuous — the constraint really narrows the count', () => {
    // If the end predicate were dropped, the answer would be the start-only count, which differs.
    const both = query(
      g,
      'MATCH (a {age: 10})-[:T]->(b)-[:T]->(c) WHERE c.age = 71 RETURN count(*) AS n',
    );
    const startOnly = query(g, 'MATCH (a {age: 10})-[:T]->(b)-[:T]->(c) RETURN count(*) AS n');

    expect(both).not.toEqual(startOnly);
  });

  test('an END predicate alongside a MIDDLE one still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 25 AND c.age > 60 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('an inline END constraint alongside an inline MIDDLE one still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b {age: 30})-[:T]->(c {age: 71}) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('an inline END constraint alongside an inline START one still answers correctly', () => {
    const q = 'MATCH (a {age: 10})-[:T]->(b)-[:T]->(c {age: 71}) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('a CORRELATED inline end still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c {age: a.age}) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('the MID route still wins when only the middle is constrained', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 25 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });
});
