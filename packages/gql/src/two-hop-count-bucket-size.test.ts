import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `side` is the two-hop count family's per-middle degree lookup. It ALWAYS ran a per-edge loop,
// resolving the far endpoint (`edge.to` — a string-keyed `Map.get`, ~190ns) to test a label, even
// when there was no label to test: `matchesLabel(x, undefined)` is true for every edge it had just
// resolved. Audit item 218 makes three changes:
//
//   - no far label  => the answer is a bucket SIZE (`bucketSize`), so no generator, no endpoint
//     resolve, no label call;
//   - a VACUOUS far label (one every vertex carries) collapses to no label, decided per execution;
//   - the start-filtered walk reads `e.toId` / `e.fromId` instead of resolving the middle VERTEX,
//     since the middle is wanted only for its label and the second leg counts from its id.
//
//     count 2-hop + start filter   248.3 -> 120.3ms   (2.06x)
//     2-hop, no filter             639.4 -> 104.4ms   (6.12x)
//
// The subtle risk is `bucketSize`: one edge can carry SEVERAL labels and so sit in several type
// buckets, which is why `edgesOfTypes` keeps a `seen` set. Summing bucket sizes would double-count
// it. `bucketSize` only reads a size where there is exactly one bucket in play, and otherwise
// counts through the deduping generator -- the tests below are what hold that line.
describe('a multi-label edge counts ONCE', () => {
  const g = new Graph();
  const v = (id: string) => g.addVertex({ id, labels: ['N'], properties: {} });
  const [a, b, c] = [v('a'), v('b'), v('c')];

  // ONE edge carrying BOTH labels. A type disjunction must see it once.
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['A', 'B'], properties: {} });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['A', 'B'], properties: {} });

  test('a type disjunction over a two-hop count does not double-count', () => {
    // One a->b edge and one b->c edge, so exactly ONE two-hop path -- regardless of the fact that
    // each edge sits in two buckets.
    expect(query(g, 'MATCH (x)-[:A|B]->(y)-[:A|B]->(z) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('and neither does the one-hop count it shares the helper with', () => {
    expect(query(g, 'MATCH (x)-[:A|B]->(y) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });

  test('an untyped hop over multi-label edges counts each edge once', () => {
    // `types === undefined` with MORE than one bucket present -- the other branch that must not
    // read a size.
    expect(query(g, 'MATCH (x)-[]->(y)-[]->(z) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('a single named type reads one bucket', () => {
    expect(query(g, 'MATCH (x)-[:A]->(y)-[:A]->(z) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('a type nothing carries counts nothing', () => {
    expect(query(g, 'MATCH (x)-[:Z]->(y)-[:Z]->(z) RETURN count(*) AS c')).toEqual([{ c: 0 }]);
  });
});

describe('a type disjunction whose buckets hold DIFFERENT edges', () => {
  // The case above cannot distinguish reading ONE bucket from counting the union: its single edge
  // sits in both buckets, so bucket `A` alone happens to equal the deduped total. Here each
  // bucket holds a different edge, so a first-bucket-only read UNDERCOUNTS -- the "two of the
  // thing" shape that `mutants-find-fixture-blindness` describes.
  const h = new Graph();
  const v = (id: string) => h.addVertex({ id, labels: ['N'], properties: {} });
  const [s1, s2, m, t1, t2] = [v('s1'), v('s2'), v('m'), v('t1'), v('t2')];

  // `m` has one A in-edge and one B in-edge, from DIFFERENT sources; likewise out.
  h.addEdge({ id: 'ia', from: s1, to: m, labels: ['A'], properties: {} });
  h.addEdge({ id: 'ib', from: s2, to: m, labels: ['B'], properties: {} });
  h.addEdge({ id: 'oa', from: m, to: t1, labels: ['A'], properties: {} });
  h.addEdge({ id: 'ob', from: m, to: t2, labels: ['B'], properties: {} });

  test('the degree product counts the UNION on both sides', () => {
    // Through `m`: 2 ways in x 2 ways out = 4. Reading only bucket `A` on either side gives 1 or 2.
    expect(query(h, 'MATCH (x)-[:A|B]->(y)-[:A|B]->(z) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  test('and so does the start-filtered walk', () => {
    expect(
      query(h, 'MATCH (x:N)-[:A|B]->(y)-[:A|B]->(z) WHERE x.id IS NOT NULL RETURN count(*) AS c'),
    ).toEqual(
      query(
        h,
        'MATCH (x:N)-[:A|B]->(y)-[:A|B]->(z) WHERE x.id IS NOT NULL LET _z = 1 RETURN count(*) AS c',
      ),
    );
  });

  test('the one-hop count agrees too', () => {
    expect(query(h, 'MATCH (x)-[:A|B]->(y) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });
});

describe('two-hop counts agree with the general path', () => {
  const g = new Graph();
  const v = (id: string, labels: string[], age: number) =>
    g.addVertex({ id, labels, properties: { age } });

  // Mixed labels at every position, so no label is vacuous and every one must be applied.
  const p1 = v('p1', ['P'], 70);
  const p2 = v('p2', ['P'], 20);
  const m1 = v('m1', ['M'], 0);
  const m2 = v('m2', ['X'], 0);
  const c1 = v('c1', ['C'], 0);
  const c2 = v('c2', ['Y'], 0);

  g.addEdge({ from: p1, to: m1, labels: ['T'], properties: {} });
  g.addEdge({ from: p1, to: m2, labels: ['T'], properties: {} });
  g.addEdge({ from: p2, to: m1, labels: ['T'], properties: {} });
  g.addEdge({ from: m1, to: c1, labels: ['T'], properties: {} });
  g.addEdge({ from: m1, to: c2, labels: ['T'], properties: {} });
  g.addEdge({ from: m2, to: c1, labels: ['T'], properties: {} });

  const SHAPES = [
    'MATCH (a)-[:T]->(b)-[:T]->(c) RETURN count(*) AS c',
    'MATCH (a:P)-[:T]->(b)-[:T]->(c) RETURN count(*) AS c',
    'MATCH (a)-[:T]->(b:M)-[:T]->(c) RETURN count(*) AS c',
    'MATCH (a)-[:T]->(b)-[:T]->(c:C) RETURN count(*) AS c',
    'MATCH (a:P)-[:T]->(b:M)-[:T]->(c:C) RETURN count(*) AS c',
    'MATCH (a:P)-[:T]->(b)-[:T]->(c) WHERE a.age > 50 RETURN count(*) AS c',
    'MATCH (a)-[:T]->(b:M)-[:T]->(c:C) WHERE a.age > 50 RETURN count(*) AS c',
    'MATCH (a:P WHERE a.age > 50)-[:T]->(b)-[:T]->(c) RETURN count(*) AS c',
    // Reversed legs, so `toId` vs `fromId` is the difference between right and wrong.
    'MATCH (a)<-[:T]-(b)-[:T]->(c) RETURN count(*) AS c',
    'MATCH (a)-[:T]->(b)<-[:T]-(c) RETURN count(*) AS c',
    'MATCH (a)<-[:T]-(b)<-[:T]-(c) RETURN count(*) AS c',
    'MATCH (a:C)<-[:T]-(b:M)<-[:T]-(c:P) RETURN count(*) AS c',
  ];

  for (const q of SHAPES) {
    test(q.replace('MATCH ', '').replace(' RETURN count(*) AS c', ''), () => {
      // The general path binds a row per match, so it is the independent oracle here.
      const general = query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

      expect(query(g, q)).toEqual(general);
    });
  }

  test('the shortcut actually counts something, so agreement is not vacuous', () => {
    // p1->m1->{c1,c2}, p1->m2->c1, p2->m1->{c1,c2} = 5 paths.
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) RETURN count(*) AS c')).toEqual([{ c: 5 }]);
    // Only p1 has age > 50: p1->m1->{c1,c2} and p1->m2->c1 = 3.
    expect(
      query(g, 'MATCH (a:P)-[:T]->(b)-[:T]->(c) WHERE a.age > 50 RETURN count(*) AS c'),
    ).toEqual([{ c: 3 }]);
  });
});

describe('a vacuous label changes nothing, a real one still filters', () => {
  const g = new Graph();
  const v = (id: string, labels: string[]) => g.addVertex({ id, labels, properties: {} });
  // EVERY vertex carries `Univ`; only some carry `Some`.
  const [a, b, c] = [v('a', ['Univ', 'Some']), v('b', ['Univ']), v('c', ['Univ', 'Some'])];

  g.addEdge({ from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ from: b, to: c, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: c, labels: ['T'], properties: {} });
  g.addEdge({ from: c, to: b, labels: ['T'], properties: {} });

  test('a vacuous label on each position matches the unlabelled spelling', () => {
    const bare = query(g, 'MATCH (x)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c');

    for (const q of [
      'MATCH (x:Univ)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c',
      'MATCH (x)-[:T]->(y:Univ)-[:T]->(z) RETURN count(*) AS c',
      'MATCH (x)-[:T]->(y)-[:T]->(z:Univ) RETURN count(*) AS c',
      'MATCH (x:Univ)-[:T]->(y:Univ)-[:T]->(z:Univ) RETURN count(*) AS c',
    ]) {
      expect(query(g, q)).toEqual(bare);
    }
  });

  test('a NON-vacuous label still filters, at each position', () => {
    // This is the guard on the vacuity collapse: `Some` is not carried by `b`.
    for (const q of [
      'MATCH (x:Some)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c',
      'MATCH (x)-[:T]->(y:Some)-[:T]->(z) RETURN count(*) AS c',
      'MATCH (x)-[:T]->(y)-[:T]->(z:Some) RETURN count(*) AS c',
    ]) {
      expect(query(g, q)).toEqual(query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
    }
  });

  test('and the non-vacuous answers genuinely differ from the bare one', () => {
    // Otherwise the agreement above would prove nothing.
    const bare = query(g, 'MATCH (x)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c');
    const filtered = query(g, 'MATCH (x)-[:T]->(y:Some)-[:T]->(z) RETURN count(*) AS c');

    expect(filtered).not.toEqual(bare);
  });

  test('vacuity is re-decided per execution, so adding a vertex can un-vacuum a label', () => {
    // `effectiveLabel` reads the graph, so a label that was vacuous when first run must start
    // filtering once a vertex without it exists. A compile-time decision would be stale here.
    const before = query(g, 'MATCH (x:Univ)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c');

    expect(before).toEqual(query(g, 'MATCH (x)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c'));

    const d = g.addVertex({ id: 'd', labels: ['Other'], properties: {} });

    g.addEdge({ from: d, to: b, labels: ['T'], properties: {} });

    // `Univ` is no longer vacuous, and the d->b->c path must be excluded by `(x:Univ)`.
    const bare = query(g, 'MATCH (x)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c');
    const labelled = query(g, 'MATCH (x:Univ)-[:T]->(y)-[:T]->(z) RETURN count(*) AS c');

    expect(labelled).not.toEqual(bare);
    expect(labelled).toEqual(
      query(g, 'MATCH (x:Univ)-[:T]->(y)-[:T]->(z) LET _z = 1 RETURN count(*) AS c'),
    );
  });
});
