import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The two-segment count ladder admitted only a START-reading predicate, on the stated grounds that
// "a predicate reading the middle or the end would have to be applied per expanded edge, which is
// the row pipeline this exists to avoid". That is true of the START-DRIVEN walk and false of the
// degree product, which iterates MIDDLES — so a middle-reading predicate is the CHEAPEST in the
// family, gated once per middle, and it was being refused for the hard case's reason.
//
// Four spellings of one question, 200,000 vertices at degree 5 (audit item 219):
//
//     WHERE b.age > 60        2331.7 -> 52.5ms    44.4x
//     (b WHERE b.age > 60)    1183.1 -> 52.9      22.4x
//     WHERE b.age = 61        1922.8 -> 12.3     156x
//     (b {age: 61})            482.3 ->  7.8      61.8x
//
// The first two were 1.97x apart and the last two 3.99x apart BEFORE the change — the
// equivalent-spelling gap this engine is named for, sitting in the open. They now share one route.
//
// The END is still refused: `sum over b of indeg(b) * |out-edges of b whose target passes p|` is a
// correct formula, but its second factor is a per-EDGE evaluation, a different cost class from a
// once-per-middle gate. These tests pin that it still answers CORRECTLY via the general path.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], age: number) =>
    g.addVertex({ id, labels, properties: { age } });

  // Mixed labels and ages at every position so nothing is vacuous and every constraint bites.
  const a1 = v('a1', ['A'], 70);
  const a2 = v('a2', ['A'], 20);
  const m1 = v('m1', ['M'], 61);
  const m2 = v('m2', ['M'], 10);
  const m3 = v('m3', ['X'], 61);
  const c1 = v('c1', ['C'], 70);
  const c2 = v('c2', ['C'], 10);

  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>) =>
    g.addEdge({ from: f, to: t, labels: ['T'], properties: {} });

  // Two sources into m1, so its in-degree factor is > 1 and a dropped middle is visible.
  e(a1, m1);
  e(a2, m1);
  e(a1, m2);
  e(a1, m3);
  // Two targets out of m1, so the product is 2 x 2 and not 1 x 1.
  e(m1, c1);
  e(m1, c2);
  e(m2, c1);
  e(m3, c2);

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the count shortcuts decline. */
const general = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

describe('every spelling of a middle constraint is one question', () => {
  const SPELLINGS = [
    'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 60 RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b WHERE b.age > 60)-[:T]->(c) RETURN count(*) AS n',
  ];

  test('the clause and inline WHERE spellings agree', () => {
    expect(query(g, SPELLINGS[0])).toEqual(query(g, SPELLINGS[1]));
  });

  test('and both agree with the general path', () => {
    for (const q of SPELLINGS) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('the answer is the product over SURVIVING middles, not a filtered path walk', () => {
    // Middles with age > 60: m1 (in 2, out 2 = 4) and m3 (in 1, out 1 = 1). Total 5.
    expect(query(g, SPELLINGS[0])).toEqual([{ n: 5 }]);
  });

  const EQ = [
    'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age = 61 RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b {age: 61})-[:T]->(c) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b WHERE b.age = 61)-[:T]->(c) RETURN count(*) AS n',
  ];

  test('the three equality spellings agree with each other and the general path', () => {
    for (const q of EQ) {
      expect(query(g, q)).toEqual(query(g, EQ[0]));
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('an inline property on an ANONYMOUS middle works', () => {
    // `inlineOf` returns a pred with no `bindVar` here, so `inlineHolds` must not need one.
    const q = 'MATCH (a)-[:T]->({age: 61})-[:T]->(c) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual([{ n: 5 }]);
  });

  test('a middle constraint composes with a middle LABEL', () => {
    // Both gates apply: `:M` and age > 60 leaves m1 alone, so 2 x 2 = 4.
    const q = 'MATCH (a)-[:T]->(b:M)-[:T]->(c) WHERE b.age > 60 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual([{ n: 4 }]);
  });

  test('a middle constraint composes with end labels on both sides', () => {
    for (const q of [
      'MATCH (a:A)-[:T]->(b)-[:T]->(c) WHERE b.age > 60 RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c:C) WHERE b.age > 60 RETURN count(*) AS n',
      'MATCH (a:A)-[:T]->(b:M)-[:T]->(c:C) WHERE b.age > 60 RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('reversed legs still read the right end', () => {
    for (const q of [
      'MATCH (a)<-[:T]-(b)-[:T]->(c) WHERE b.age > 60 RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)<-[:T]-(c) WHERE b.age > 60 RETURN count(*) AS n',
      'MATCH (a)<-[:T]-(b)<-[:T]-(c) WHERE b.age > 60 RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('a middle constraint that matches NOTHING counts nothing', () => {
    expect(
      query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 1000 RETURN count(*) AS n'),
    ).toEqual([{ n: 0 }]);
  });

  test('a middle constraint that matches EVERYTHING equals the unfiltered product', () => {
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > -1 RETURN count(*) AS n')).toEqual(
      query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) RETURN count(*) AS n'),
    );
  });
});

describe('what the middle route must NOT claim', () => {
  test('a predicate on the END still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60 RETURN count(*) AS n';

    // Refused by the ladder and answered by the general path; the point is the ANSWER, since a
    // route that half-applied it would be a wrong count rather than a slow one.
    expect(query(g, q)).toEqual(general(q));
  });

  test('a predicate reading the START and the MIDDLE still answers correctly', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE a.age > 60 AND b.age > 60 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('a CORRELATED inline middle value still answers correctly', () => {
    // `inlineOf` refuses `(b {age: a.age})` — the tally would have to bind `a` per edge. The
    // shortcut must decline, not carry a predicate it cannot evaluate.
    const q = 'MATCH (a)-[:T]->(b {age: a.age})-[:T]->(c) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('an inline constraint on the END still answers correctly', () => {
    // The END is reached only as a degree, so a constraint there has no once-per-element place.
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c {age: 70}) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('a START predicate keeps its own route and its own answer', () => {
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE a.age > 60 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    // a1 has three out-edges (m1, m2, m3) whose out-degrees are 2, 1, 1 = 4.
    expect(query(g, q)).toEqual([{ n: 4 }]);
  });

  test('a constant predicate is still tallied', () => {
    // It read no variables, so it kept the start route before this item and must still.
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE 1 = 1 RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
    expect(query(g, q)).toEqual(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c) RETURN count(*) AS n'));
  });
});

describe('the middle gate runs before the degrees are read', () => {
  test('a middle with NO out-edges contributes nothing even when it passes the gate', () => {
    const h = new Graph();
    const v = (id: string, age: number) => h.addVertex({ id, labels: ['N'], properties: { age } });
    const [s, dead, live, t] = [v('s', 0), v('dead', 99), v('live', 99), v('t', 0)];

    h.addEdge({ from: s, to: dead, labels: ['T'], properties: {} });
    h.addEdge({ from: s, to: live, labels: ['T'], properties: {} });
    h.addEdge({ from: live, to: t, labels: ['T'], properties: {} });

    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 50 RETURN count(*) AS n';

    // `dead` passes the gate but has out-degree 0, so only `live` contributes: 1 x 1 = 1.
    expect(query(h, q)).toEqual([{ n: 1 }]);
    expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });

  test('a middle with no IN-edges contributes nothing', () => {
    const h = new Graph();
    const v = (id: string, age: number) => h.addVertex({ id, labels: ['N'], properties: { age } });
    const [orphan, t] = [v('orphan', 99), v('t', 0)];

    h.addEdge({ from: orphan, to: t, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (a)-[:T]->(b)-[:T]->(c) WHERE b.age > 50 RETURN count(*) AS n')).toEqual(
      [{ n: 0 }],
    );
  });
});
