import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * A depth-4 quantified trail with an endpoint LABEL: fast when the label is vacuous, correct when
 * it is not (item 1399).
 *
 * Item 1398 priced the old behaviour at **11-13x**: `{1,4}(b:P)` refused the closed form on SYNTAX
 * — any endpoint label at all — and fell to the general matcher, 433.7 ms against 43.2 for the
 * identical answer on a graph where every vertex carries `P`. The closed form's terms are derived
 * for a TRIVIAL endpoint mask (items 687-689), and a label every vertex carries IS trivial; only the
 * graph can say which it is, so the rung is now admitted at compile time and declines at run time.
 *
 * ⚠️ THE FAILURE MODE IS A WRONG ANSWER, NOT A SLOW ONE, and it has happened here before: item 692
 * relaxed the dispatch bound without relaxing the arithmetic and the depth-4 trail answered the WALK
 * count — 450,000 against the trail's 449,998 — caught by a brute-force oracle, not by any timing.
 * So these tests pin the ANSWER in both regimes, and the filtering regime is the one that matters:
 * if the runtime decline is dropped, a filtering label reaches terms that assume it filters nothing
 * and the count comes back as if it did not.
 */

/** Every vertex `P`, so the label rejects nothing: the mask the closed form was derived for. */
const vacuousGraph = (n: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3) % n}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** Half `P`, half `Q`: the label really filters, so the closed form must NOT be used. */
const filteringGraph = (n: number): Graph => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: i % 2 === 0 ? ['P'] : ['Q'], properties: { n: i } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3) % n}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const c = (g: Graph, src: string): unknown => query(g, src)[0]?.['c'];

describe('depth-4 quantified trail with a VACUOUS endpoint label (item 1399)', () => {
  test('the labelled and unlabelled spellings agree, which is what makes the label vacuous', () => {
    const g = vacuousGraph(2_000);

    expect(c(g, 'MATCH ()-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(
      c(g, 'MATCH ()-[:E]->{1,4}() RETURN count(*) AS c'),
    );
  });

  test('and the value is 4 per vertex, every path length contributing once', () => {
    // Out-degree 1 and a long cycle, so each vertex starts exactly one path of each length 1..4 and
    // no path repeats an edge — 4n, identical for the trail and the walk.
    expect(c(vacuousGraph(2_000), 'MATCH ()-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(8_000);
  });

  test('a START label is unaffected — it was always admitted', () => {
    const g = vacuousGraph(2_000);

    expect(c(g, 'MATCH (a:P)-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(8_000);
    expect(c(g, 'MATCH (a:P)-[:E]->{1,4}() RETURN count(*) AS c')).toBe(8_000);
  });
});

describe('depth-4 quantified trail with a FILTERING endpoint label (item 1399)', () => {
  // THE WRONG-ANSWER GUARD. Half the vertices are `Q`, so `(b:P)` keeps half the landings. A route
  // that used the closed form here would answer as though the label kept all of them.
  test('a filtering label answers the FILTERED count, not the unfiltered one', () => {
    const g = filteringGraph(2_000);
    const filtered = c(g, 'MATCH ()-[:E]->{1,4}(b:P) RETURN count(*) AS c');
    const unfiltered = c(g, 'MATCH ()-[:E]->{1,4}() RETURN count(*) AS c');

    expect(unfiltered).toBe(8_000);
    expect(filtered).toBe(4_000);
    expect(filtered).not.toBe(unfiltered);
  });

  test('the two labels partition the landings, so P and Q sum to the unfiltered count', () => {
    const g = filteringGraph(2_000);

    expect(c(g, 'MATCH ()-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(4_000);
    expect(c(g, 'MATCH ()-[:E]->{1,4}(b:Q) RETURN count(*) AS c')).toBe(4_000);
  });

  test('depth 3 was already admitted with a filtering label and still answers', () => {
    const g = filteringGraph(2_000);

    expect(c(g, 'MATCH ()-[:E]->{1,3}(b:P) RETURN count(*) AS c')).toBe(3_000);
    expect(c(g, 'MATCH ()-[:E]->{1,3}() RETURN count(*) AS c')).toBe(6_000);
  });

  test('an endpoint PREDICATE is still refused at compile time and still applies', () => {
    // A predicate can never be shown vacuous cheaply, so `depth4Admissible` keeps refusing it — this
    // pins that the refusal is intact rather than accidentally relaxed along with the label.
    //
    // The assertion is a RELATION, not a number I derived: an always-true predicate must give the
    // unfiltered count and a selective one must give strictly less. Stating a specific count here
    // would mean working out which landing each of 2,000 sources reaches at four depths, and a
    // number I cannot derive is a number the test cannot defend.
    const g = vacuousGraph(2_000);

    expect(c(g, 'MATCH ()-[:E]->{1,4}(b) WHERE b.n < 1000000 RETURN count(*) AS c')).toBe(8_000);
    expect(
      c(g, 'MATCH ()-[:E]->{1,4}(b) WHERE b.n < 1000 RETURN count(*) AS c') as number,
    ).toBeLessThan(8_000);
  });
});

describe('a TRIANGLE, where the trail and the walk genuinely differ (item 1399)', () => {
  // The shape item 692's bug was caught on: with a 3-cycle, a depth-4 WALK may reuse an edge and a
  // TRAIL may not, so the two counts diverge and an arithmetic route that confuses them is visible.
  const triangle = (): Graph => {
    const g = new Graph();

    for (const id of ['a', 'b', 'c']) {
      g.addVertex({ id, labels: ['P'], properties: {} });
    }

    g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
    g.addEdge({ id: 'bc', from: g.getVertexById('b')!, to: g.getVertexById('c')!, labels: ['E'] });
    g.addEdge({ id: 'ca', from: g.getVertexById('c')!, to: g.getVertexById('a')!, labels: ['E'] });

    return g;
  };

  test('the TRAIL stops at 3 hops, so depth 4 adds nothing', () => {
    // Each vertex has exactly one path of length 1, 2 and 3; a 4th hop must reuse an edge.
    expect(c(triangle(), 'MATCH ()-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(9);
    expect(c(triangle(), 'MATCH ()-[:E]->{1,3}(b:P) RETURN count(*) AS c')).toBe(9);
  });

  // ⚠️ `WALK` IS A PREFIX, not a suffix: `MATCH WALK (…)`. I wrote it after the pattern first and
  // the parser rejected the query outright — which the test caught as a syntax error rather than a
  // wrong count, but a mode keyword silently ignored would have been the dangerous version.
  test('the WALK does not stop, which is the count the trail must NOT return', () => {
    expect(c(triangle(), 'MATCH WALK ()-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(12);
  });
});
