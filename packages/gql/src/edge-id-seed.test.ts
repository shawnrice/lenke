import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 621: `WHERE element_id(r) = '<id>'` on a REL variable pins the hop to one node, so the
 * pattern seeds from that node instead of scanning every one.
 *
 * **EVERY QUERY HERE WAS CHECKED TO ACTUALLY BUILD THE SEED**, by instrumenting
 * `indexCandidates`' `build()` and reading which shapes print. That check is not optional and
 * it is not satisfied by a spy: `indexCandidates` is called by `estimateSeedFrom` as well as
 * by `seedVertices`, so a hint can be COSTED without ever being used, and the first version of
 * this file asserted exactly that — `getEdgeById` was called, `build()` never was, and a
 * mutant that pinned the WRONG END passed all eight tests. (Item 619b learned the same lesson
 * at the exec layer one item earlier; this is it at the seed layer.)
 *
 * Not every shape reaches `seedVertices`. `MATCH ()-[r:R]->(b) … RETURN b.k` is answered by a
 * far-side shortcut that seeds its own way and does NOT use the pin — measured, and recorded
 * in `docs/reviews/CLOSED.md` as the follow-up rather than papered over here.
 *
 * The ROWS are the real assertion, because they are what an inverted or missing pin changes.
 * The spy is used only for the DECLINES, where zero calls means the hint was never even
 * attached.
 */
const spyGetEdgeById = (g: Graph): (() => number) => {
  let calls = 0;
  const real = g.getEdgeById;

  (g as unknown as { getEdgeById: typeof real }).getEdgeById = (id: string) => {
    calls += 1;

    return real(id);
  };

  return () => calls;
};

/** A 6-node ring, `e0..e5`, 1:1 — so a hit is one row and an undirected hop is exactly two. */
const fixture = (): Graph => {
  const g = new Graph();
  const vs: Vertex[] = [];

  for (let i = 0; i < 6; i++) {
    vs.push(g.addVertex({ id: `n${i}`, labels: ['P'], properties: { k: i } }));
  }

  for (let i = 0; i < 6; i++) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i + 1) % 6],
      labels: ['R'],
      properties: { w: i },
    });
  }

  return g;
};

describe('GQL hop pinned by an edge id', () => {
  test('an out hop pins the SOURCE end', () => {
    // e2 runs n2 -> n3. The seed is n2; walking out from n3 instead would reach e3, which the
    // predicate rejects, so an inverted pin answers ZERO rows here. That is what makes this a
    // test of the END and not merely of the plumbing.
    //
    // The spy is here as well, and the two assertions catch DIFFERENT mutants: the rows catch
    // a pin on the wrong end, and `calls() > 0` catches a pin that never fires at all — which
    // the rows CANNOT see, because a missing optimization returns the same answer slowly.
    const g = fixture();
    const calls = spyGetEdgeById(g);

    expect(query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = 'e2' RETURN r.w AS v`)).toEqual([
      { v: 2 },
    ]);
    expect(query(g, `MATCH (a)-[r:R]->() WHERE element_id(r) = 'e2' RETURN a.k AS v`)).toEqual([
      { v: 2 },
    ]);
    expect(query(g, `MATCH (a:P)-[r:R]->() WHERE element_id(r) = 'e2' RETURN a.k AS v`)).toEqual([
      { v: 2 },
    ]);
    expect(calls()).toBeGreaterThan(0);
  });

  test('an IN hop pins the TARGET end', () => {
    // `()<-[r:R]-()` walks target -> source, so the node it starts from is e2's TARGET, n3.
    // Pinning the source would start at n2, whose incoming edge is e1 — rejected, zero rows.
    const g = fixture();
    const calls = spyGetEdgeById(g);

    expect(query(g, `MATCH ()<-[r:R]-() WHERE element_id(r) = 'e2' RETURN r.w AS v`)).toEqual([
      { v: 2 },
    ]);
    expect(calls()).toBeGreaterThan(0);
  });

  test('a $param pins too', () => {
    const g = fixture();
    const calls = spyGetEdgeById(g);

    expect(
      query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = $x RETURN r.w AS v`, { x: 'e4' }),
    ).toEqual([{ v: 4 }]);
    expect(calls()).toBeGreaterThan(0);
  });

  test('a conjunct that EXCLUDES the pinned edge still removes the row', () => {
    // The superset-not-subset property, asserted: the pin narrows the SEED and the predicate
    // still decides. A pin that short-circuited the filter would answer one row.
    const g = fixture();

    expect(
      query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = 'e2' AND r.w > 99 RETURN r.w AS v`),
    ).toEqual([]);
  });

  test('an UNDIRECTED hop declines — pinning one end would lose the other row', () => {
    // `-[r:R]-` walks from EITHER endpoint, so the edge appears twice. Seeding one end would
    // drop a row; the native twin declines `Dir::Both` for the same reason (item 620). The
    // TWO rows are what make the decline necessary rather than cautious, and zero spy calls
    // show the hint was never even attached.
    const g = fixture();
    const calls = spyGetEdgeById(g);

    expect(query(g, `MATCH ()-[r:R]-() WHERE element_id(r) = 'e2' RETURN r.w AS v`)).toEqual([
      { v: 2 },
      { v: 2 },
    ]);
    expect(calls()).toBe(0);
  });

  test('a QUANTIFIED rel declines — the variable binds a LIST of edges, not one', () => {
    const g = fixture();
    const calls = spyGetEdgeById(g);

    expect(query(g, `MATCH ()-[r:R]->{2}() WHERE element_id(r) = 'e2' RETURN 1 AS v`)).toEqual([]);
    expect(calls()).toBe(0);
  });

  test('a deleted edge is not resurrected', () => {
    const g = fixture();
    g.removeEdge(g.getEdgeById('e2')!);

    expect(query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = 'e2' RETURN r.w AS v`)).toEqual([]);
    // A different edge still resolves, so the empty answer above is a real absence and not a
    // fixture that stopped matching anything.
    expect(query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = 'e3' RETURN r.w AS v`)).toEqual([
      { v: 3 },
    ]);
  });

  test('an id that resolves to no edge answers nothing', () => {
    const g = fixture();

    expect(query(g, `MATCH ()-[r:R]->() WHERE element_id(r) = 'nope' RETURN r.w AS v`)).toEqual([]);
  });
});
