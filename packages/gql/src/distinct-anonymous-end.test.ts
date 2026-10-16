import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 485: the DISTINCT walk demanded a named start AND a named far end, so
// `MATCH (:Person)-[:KNOWS]->(b) RETURN DISTINCT b.age` fell to the general path at 964 ms
// where the `(a:Person)` spelling took the walk at 56 — 17x apart for one question, and the
// same bug class item 475 found in the grouped hop tally.
//
// Nothing can REFERENCE an unnamed end, so the name was only ever needed for the end the
// projection reads — and that end is named by the expression itself.
//
// The oracle is the NAMED spelling, which took the walk before this change and still does.
// DISTINCT's row order is first-seen and observable, so every comparison is on the ARRAY.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id, labels, properties: props });

  const a = v('a', ['P'], { k: 'a' });
  const b = v('b', ['P'], { k: 'b' });
  const x = v('x', ['F'], { k: 'x' });
  const y = v('y', ['F'], { k: 'y' });

  g.addEdge({ id: 'e1', from: a, to: x, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: b, to: x, labels: ['T'], properties: {} }); // a REPEAT of 'x'

  return g;
};

describe('an anonymous end in the DISTINCT walk (item 485)', () => {
  test('an anonymous START, keyed on the far end', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]->(b) RETURN DISTINCT b.k AS k')).toEqual(
      query(g, 'MATCH (a:P)-[:T]->(b) RETURN DISTINCT b.k AS k'),
    );
    // First-seen order, and 'x' appears twice in the walk but once here.
    expect(query(g, 'MATCH (:P)-[:T]->(b) RETURN DISTINCT b.k AS k')).toEqual([
      { k: 'x' },
      { k: 'y' },
    ]);
  });

  test('an anonymous FAR end, keyed on the start', () => {
    const g = build();

    expect(query(g, 'MATCH (a:P)-[:T]->() RETURN DISTINCT a.k AS k')).toEqual(
      query(g, 'MATCH (a:P)-[:T]->(b) RETURN DISTINCT a.k AS k'),
    );
    expect(query(g, 'MATCH (a:P)-[:T]->() RETURN DISTINCT a.k AS k')).toEqual([
      { k: 'a' },
      { k: 'b' },
    ]);
  });

  test('count(DISTINCT …) with an anonymous start', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]->(b) RETURN count(DISTINCT b.k) AS c')).toEqual(
      query(g, 'MATCH (a:P)-[:T]->(b) RETURN count(DISTINCT b.k) AS c'),
    );
    expect(query(g, 'MATCH (:P)-[:T]->(b) RETURN count(DISTINCT b.k) AS c')).toEqual([{ c: 2 }]);
  });

  test('BOTH ends anonymous has no key and declines', () => {
    const g = build();

    // Nothing names an end for the expression to read, so this is a different shape entirely.
    expect(query(g, 'MATCH (:P)-[:T]->() RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('a WHERE on the keyed end is still carried past an anonymous other end', () => {
    const g = build();

    expect(query(g, "MATCH (:P)-[:T]->(b) WHERE b.k <> 'y' RETURN DISTINCT b.k AS k")).toEqual(
      query(g, "MATCH (a:P)-[:T]->(b) WHERE b.k <> 'y' RETURN DISTINCT b.k AS k"),
    );
    expect(query(g, "MATCH (:P)-[:T]->(b) WHERE b.k <> 'y' RETURN DISTINCT b.k AS k")).toEqual([
      { k: 'x' },
    ]);
  });

  test('the START LABEL still excludes', () => {
    const g = build();

    // `F` vertices have no out-edges of type T, so an unlabelled start would find more.
    expect(query(g, 'MATCH (:F)-[:T]->(b) RETURN DISTINCT b.k AS k')).toEqual([]);
    expect(query(g, 'MATCH ()-[:T]->(b) RETURN DISTINCT b.k AS k')).toEqual([
      { k: 'x' },
      { k: 'y' },
    ]);
  });

  test('the guards the relaxed helper KEPT: a rel variable, a rel constraint, a constrained other end', () => {
    const g = build();

    // Each of these must stay on the general path, and each must be RIGHT. They are the three
    // conditions `plainUnnamedRel` and the non-keyed `plainNode` still enforce, and all three
    // mutants on them SURVIVED until this case: the file had no query that read an edge, put a
    // constraint on a rel, or constrained the end the projection does not read.
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN DISTINCT r.id AS r')).toEqual([{ r: null }]);
    expect(query(g, 'MATCH (:P)-[:T {w: 1}]->(b) RETURN DISTINCT b.k AS k')).toEqual([]);
    // Its OWN fixture: in `build()` every far end is reachable from BOTH starts, so ignoring a
    // start constraint changes nothing and that mutant survived. `z` is reachable only from
    // `b`, which is what makes the constraint observable.
    const h = new Graph();
    const ha = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
    const hb = h.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b' } });

    h.addEdge({
      id: 'ax',
      from: ha,
      to: h.addVertex({ id: 'x', labels: ['F'], properties: { k: 'x' } }),
      labels: ['T'],
      properties: {},
    });
    h.addEdge({
      id: 'bz',
      from: hb,
      to: h.addVertex({ id: 'z', labels: ['F'], properties: { k: 'z' } }),
      labels: ['T'],
      properties: {},
    });

    expect(query(h, "MATCH (a:P {k: 'a'})-[:T]->(b) RETURN DISTINCT b.k AS k")).toEqual([
      { k: 'x' },
    ]);
    // Unconstrained, for contrast — so the line above is not vacuously the same answer.
    expect(query(h, 'MATCH (a:P)-[:T]->(b) RETURN DISTINCT b.k AS k')).toEqual([
      { k: 'x' },
      { k: 'z' },
    ]);
    // The same constraint on the KEYED end is carried by the walk.
    expect(query(g, "MATCH (a:P)-[:T]->(b {k: 'x'}) RETURN DISTINCT b.k AS k")).toEqual([
      { k: 'x' },
    ]);
  });

  // Item 486: a rel VARIABLE nothing reads. The walk never binds the edge, so a name no one
  // uses cannot change an answer — and refusing it cost 19x for the `r:` alone (1050 ms against
  // 55). Item 485's mutation run is what identified the guard as conservative.
  describe('a rel variable nothing reads (item 486)', () => {
    test('an UNREAD rel variable answers exactly as no variable does', () => {
      const g = build();

      expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN DISTINCT b.k AS k')).toEqual(
        query(g, 'MATCH (:P)-[:T]->(b) RETURN DISTINCT b.k AS k'),
      );
      expect(query(g, 'MATCH (a:P)-[r:T]->(b) RETURN count(DISTINCT b.k) AS c')).toEqual([
        { c: 2 },
      ]);
    });

    test('a projection that READS the edge declines, and still answers', () => {
      const g = build();

      // The walk has no edge bound, so this shape must stay on the general path. It is also the
      // control the widening cannot reach: 1087-1107 ms where the unread spelling is 53-56.
      expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN DISTINCT r.id AS r')).toEqual([{ r: null }]);
    });

    test('a WHERE or a LET that reads the edge declines', () => {
      const g = build();

      expect(query(g, 'MATCH (:P)-[r:T]->(b) WHERE r.id IS NULL RETURN DISTINCT b.k AS k')).toEqual(
        [{ k: 'x' }, { k: 'y' }],
      );
      expect(query(g, 'MATCH (a:P)-[r:T]->(b) LET e = r.id RETURN DISTINCT e AS e')).toEqual([
        { e: null },
      ]);
    });

    test('a SUBQUERY naming the edge declines — item 444s hazard', () => {
      const g = build();

      // `mentionsName` is over-broad on purpose: a subquery correlating on `r` has to NAME it,
      // and a name anywhere in the projection is a decline. Without that, a correlated inner
      // pattern would be served as if it bound `r` freshly, which is item 444's wrong answer.
      expect(
        query(g, 'MATCH (a:P)-[r:T]->(q) RETURN DISTINCT COUNT { MATCH (a)-[r:T]->(z) } AS n'),
      ).toEqual([{ n: 1 }]);
    });
  });

  test('an UNDIRECTED DISTINCT, including a self-loop', () => {
    const g = new Graph();
    const p = g.addVertex({ id: 'p', labels: ['P'], properties: { k: 'p' } });
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: { k: 'q' } });

    g.addEdge({ id: 'loop', from: p, to: p, labels: ['T'], properties: {} });
    g.addEdge({ id: 'pq', from: p, to: q, labels: ['T'], properties: {} });

    // The walk reaches `both` now that the start may be anonymous; `expand` yields the loop
    // once, and DISTINCT would hide a duplicate anyway — so the ORDER is what this checks.
    expect(query(g, 'MATCH (:P)-[:T]-(b) RETURN DISTINCT b.k AS k')).toEqual(
      query(g, 'MATCH (a:P)-[:T]-(b) RETURN DISTINCT b.k AS k'),
    );
    expect(query(g, 'MATCH (:P)-[:T]-(b) RETURN DISTINCT b.k AS k')).toEqual([
      { k: 'p' },
      { k: 'q' },
    ]);
  });
});
