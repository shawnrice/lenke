import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 429: the n-hop count sweep reads a chain BACKWARDS when that seeds from the cheaper end.
// It did so for a GATE on the last position (item 308) but never for a LABEL, so
// `MATCH (x)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:P)` seeded every vertex where the forward
// spelling of the same question seeded the `:P` bucket. 4.26x at four hops, 3.09x at five.
//
// Flipping is ANSWER-PRESERVING by construction — a fixed-length chain read backwards is the
// same multiset of walks — so no test can catch a wrong DECISION; the 4.26x is the evidence that
// it fires. What a test CAN catch is a wrongly BUILT reversal, and that is what this file is
// for: the leg order, the direction of each leg, and which position each label and gate lands on.
// The fixture is built so that getting any of those wrong changes the count.
const build = (): Graph => {
  const g = new Graph();
  const v: Array<ReturnType<Graph['addVertex']>> = [];

  // Labels are DIFFERENT per tier, so a label applied to the wrong position counts the wrong
  // walks rather than coincidentally agreeing. `:Univ` is on every vertex, which is the vacuous
  // case the flip must decline.
  // The tiers are DIFFERENT SIZES on purpose, and `:A` is the smallest. A first version gave `:A`
  // and `:D` four vertices each, so `candidateCount` TIED and the strict comparison declined to
  // flip — which meant the cases with labels at every position never exercised the reversal at
  // all, and the mutant that stops reversing the leg ORDER survived. The fixture has to make the
  // flip FIRE, and that is a property of the label COUNTS, not of the query text.
  const tier = (i: number): string[] => {
    if (i < 3) {
      return ['A', 'Univ']; // 3 — the smallest, so a chain ending in `:A` flips
    }

    if (i < 9) {
      return ['B', 'Univ']; // 6
    }

    return i < 14 ? ['C', 'Univ'] : ['D', 'Univ']; // 5, then 4
  };

  for (let i = 0; i < 18; i++) {
    v.push(g.addVertex({ id: `v${i}`, labels: tier(i), properties: { k: i % 3 } }));
  }

  // A deliberately IRREGULAR edge set: the counts below are only stable if the walk is enumerated
  // correctly, and an irregular graph makes a mis-built reversal diverge rather than coincide.
  for (const [a, b] of [
    [0, 4],
    [0, 5],
    [1, 4],
    [2, 6],
    [3, 7],
    [4, 9],
    [4, 10],
    [5, 9],
    [6, 11],
    [7, 12],
    [9, 14],
    [9, 15],
    [10, 14],
    [11, 16],
    [12, 17],
    [14, 0],
    [15, 1],
  ] as Array<[number, number]>) {
    g.addEdge({ from: v[a], to: v[b], labels: ['E'], properties: {} });
  }

  // A second edge type, so a chain mixing types catches a leg that kept the wrong `types`.
  g.addEdge({ from: v[4], to: v[11], labels: ['F'], properties: {} });
  g.addEdge({ from: v[5], to: v[12], labels: ['F'], properties: {} });

  return g;
};

const count = (g: Graph, q: string): unknown => query(g, q);

describe('chain label flip', () => {
  const g = build();

  // THE INVARIANT: the same question written forwards and backwards must give the same count.
  // Only the backwards spelling can take the new flip, so any disagreement is this change.
  test.each([
    [
      '3 hops',
      'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    [
      '4 hops',
      'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) RETURN count(*) AS c',
      'MATCH (e)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    [
      '5 hops',
      'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      'MATCH (f)<-[:E]-(e)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // LABELS AT EVERY POSITION, so a reversal that lands a label on the wrong node is caught.
    [
      'labels throughout',
      'MATCH (a:A)-[:E]->(b:B)-[:E]->(c:C)-[:E]->(d:D) RETURN count(*) AS c',
      'MATCH (d:D)<-[:E]-(c:C)<-[:E]-(b:B)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // A label on the LAST position only in the forward reading — so the forward spelling is the
    // one that wants flipping, and the reversed one does not. Both directions of the rule.
    [
      'label at the far end',
      'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d:D) RETURN count(*) AS c',
      'MATCH (d:D)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a) RETURN count(*) AS c',
    ],
    // MIXED DIRECTIONS: the reversal negates each leg's direction, and an un-negated leg walks
    // the wrong way. The graph has a cycle (14->0, 15->1) so a wrong direction still finds walks
    // instead of returning zero, which is what makes this catch rather than crash.
    [
      'mixed directions',
      'MATCH (a:A)-[:E]->(b)<-[:E]-(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (d)<-[:E]-(c)-[:E]->(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // NON-PALINDROMIC directions, which the case above is not: its `out` flags read
    // false/true/false, so negating them in the WRONG ORDER gives the same sequence and the
    // mutant that stops reversing the leg order survived. These read true/true/false, so the
    // order is observable.
    [
      'directions, order observable',
      'MATCH (a:A)-[:E]->(b)-[:E]->(c)<-[:E]-(d) RETURN count(*) AS c',
      'MATCH (d)-[:E]->(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    [
      'directions and labels, order observable',
      'MATCH (a:A)-[:E]->(b:B)-[:E]->(c:C)<-[:E]-(d:B) RETURN count(*) AS c',
      'MATCH (d:B)-[:E]->(c:C)<-[:E]-(b:B)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // TWO EDGE TYPES, so a leg that kept the wrong `types` counts the wrong walks.
    [
      'two edge types',
      'MATCH (a:A)-[:E]->(b)-[:F]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (d)<-[:E]-(c)<-[:F]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // FOUR hops with labels at every position, which is where the leg-ORDER mutant finally
    // shows. Every case above is a 3-hop chain, and a 3-segment chain does not reach the n-hop
    // sweep at all (`try_3hop_product_count` owns it) — so none of them exercised the reversal's
    // ordering, and the mutant that stops reversing the leg order survived twice: first because
    // the label tiers tied so the flip never fired, then because the label and direction
    // sequences it did see were palindromic. The sweep starts at FOUR.
    [
      '4 hops, labels throughout',
      'MATCH (a:A)-[:E]->(b:B)-[:E]->(c:C)-[:E]->(d:D)-[:E]->(e:Univ) RETURN count(*) AS c',
      'MATCH (e:Univ)<-[:E]-(d:D)<-[:E]-(c:C)<-[:E]-(b:B)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    [
      '4 hops, directions not palindromic',
      'MATCH (a:A)-[:E]->(b)<-[:E]-(c)<-[:E]-(d)<-[:E]-(e) RETURN count(*) AS c',
      'MATCH (e)-[:E]->(d)-[:E]->(c)-[:E]->(b)<-[:E]-(a:A) RETURN count(*) AS c',
    ],
    // A GATE at the far end, which is item 308's flip — untouched, and must still agree.
    [
      'gate at the far end',
      'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d {k: 2}) RETURN count(*) AS c',
      'MATCH (d {k: 2})<-[:E]-(c)<-[:E]-(b)<-[:E]-(a) RETURN count(*) AS c',
    ],
    // GATES AT BOTH ENDS: item 308 declines to flip, and the label rule is not consulted.
    [
      'gates at both ends',
      'MATCH (a {k: 0})-[:E]->(b)-[:E]->(c)-[:E]->(d {k: 2}) RETURN count(*) AS c',
      'MATCH (d {k: 2})<-[:E]-(c)<-[:E]-(b)<-[:E]-(a {k: 0}) RETURN count(*) AS c',
    ],
    // A VACUOUS end label, where `candidateCount` ties and the STRICT comparison declines.
    [
      'vacuous end label',
      'MATCH (a:Univ)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:Univ) RETURN count(*) AS c',
    ],
  ])('%s agrees forwards and backwards', (_name, fwd, rev) => {
    expect(count(g, rev)).toEqual(count(g, fwd));
  });

  // Item 430: a 3-segment chain whose END carries a label went to the degree PRODUCT, which has
  // no place to test a label at its end positions and so enumerated — 1112 ms against the
  // forward spelling's 347. It now routes to the sweep when either end narrows the seed (11.8x
  // reversed, 3.67x forward, both landing on ~95 ms), and keeps the product when neither does,
  // which is the shape item 301 measured the product as winning.
  //
  // The ORACLE here is `count(*) + 0`: an aggregate nested in arithmetic, which every count
  // shortcut refuses, so the general matcher answers it. Measured 620.5 ms against the
  // shortcut's 138.6 on the 200,000-vertex fixture, which is how we know it is a different
  // route and not the same one wearing a hat.
  test.each([
    // The label narrows the START — the product could already seed it, but the sweep is better
    // at this depth once anything narrows.
    'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    // The label narrows the END, which is the shape that was 1112 ms.
    'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    // BOTH ends labelled, and the narrower one is the end.
    'MATCH (d:D)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d:D) RETURN count(*) AS c',
    // VACUOUS on both ends: nothing narrows, so the product is kept — and must still be right.
    'MATCH (a:Univ)-[:E]->(b)-[:E]->(c)-[:E]->(d:Univ) RETURN count(*) AS c',
    'MATCH (d:Univ)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:Univ) RETURN count(*) AS c',
    // No label anywhere: the product, untouched.
    'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    // An INLINE gate at an interior position AND an end label: the sweep carries inline gates at
    // every position (item 303), so this may route there and must agree either way.
    'MATCH (d)<-[:E]-(c {k: 1})<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c',
    'MATCH (d)<-[:E]-(c)<-[:E]-(b {k: 1})<-[:E]-(a:A) RETURN count(*) AS c',
    // A clause `WHERE` over an INTERIOR node, which `interiorPred` carries on the product — the
    // routing must decline and leave it there.
    'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) WHERE c.k = 1 RETURN count(*) AS c',
    // An end GATE, which item 306 already routes to the sweep.
    'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a {k: 2}) RETURN count(*) AS c',
    // Mixed directions with an end label, so the sweep's own flip is involved too.
    'MATCH (d)<-[:E]-(c)-[:E]->(b)<-[:E]-(a:A) RETURN count(*) AS c',
  ])('%s matches the general matcher', (q) => {
    const viaGeneral = q.replace('count(*)', 'count(*) + 0');

    expect(query(g, q)).toEqual(query(g, viaGeneral));
  });

  // And the counts themselves, pinned: two spellings that are wrong the same way would satisfy
  // every agreement above. Derived by hand from the edge list in `build`.
  test('the counts are the right ones', () => {
    // `:A` is vertices 0,1,2. 3-hop walks from them over `:E`: 0->4->9->{14,15} (2),
    // 0->4->10->14 (1), 0->5->9->{14,15} (2), 1->4->9->{14,15} (2), 1->4->10->14 (1),
    // 2->6->11->16 (1) = 9. One hop: 0->4, 0->5, 1->4, 2->6 = 4.
    expect(query(g, 'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c')).toEqual([
      { c: 9 },
    ]);
    expect(query(g, 'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:A) RETURN count(*) AS c')).toEqual([
      { c: 9 },
    ]);
    expect(query(g, 'MATCH (a:A)-[:E]->(b) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });
});
