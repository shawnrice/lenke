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
