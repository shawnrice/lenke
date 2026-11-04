import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * An UNDIRECTED hop's far label: dropped when vacuous, applied when it filters (item 1408).
 *
 * `undirectedHopWalk` tested `matchesLabel(far, farLabel)` per edge in BOTH passes, with no vacuity
 * drop — the one walk in `hop-projection.ts` that lacked the trick every sibling has. A windowed
 * profile of `MATCH (a:P)-[:E]-(b:P) RETURN b.n` put `evalLabelExpr` at 24.6%, `get labels` at 8.3%
 * and `matchesLabel` at 2.8%: **35.7% spent on a label that rejects nothing**, which is why that row
 * read 503 ns a row against the far-driven walk's 192.
 *
 * ⚠️ THE FAILURE MODE IS A WRONG ROW SET, NOT A SLOW ONE. `vacuousLabel` is consulted per CALL
 * because vacuity is a property of the graph, so the same query is correct on one graph and wrong on
 * another if the drop is mis-decided. These tests pin both sides on fixtures that differ ONLY in
 * whether the label is vacuous.
 *
 * The undirected walk is also the one that must not double-count a SELF-LOOP — its in-pass skips
 * `edge.from === edge.to` because the out-pass already emitted it — so that case is here too: a
 * change to the label handling runs right beside it.
 */

/** Every vertex `P`: the label rejects nothing, so it must be dropped and the rows unchanged. */
const vacuous = (): Graph => {
  const g = new Graph();

  for (const [id, n] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { n } });
  }

  g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
  g.addEdge({ id: 'bc', from: g.getVertexById('b')!, to: g.getVertexById('c')!, labels: ['E'] });

  return g;
};

/** `a` and `c` are `P`, `b` is `Q`: the label really filters, so it must NOT be dropped. */
const filtering = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['Q'], properties: { n: 2 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });

  g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
  g.addEdge({ id: 'bc', from: g.getVertexById('b')!, to: g.getVertexById('c')!, labels: ['E'] });

  return g;
};

const ns = (g: Graph, src: string): unknown[] =>
  query(g, src)
    .map((r) => r['n'])
    .slice()
    .sort();

describe('an undirected hop with a VACUOUS far label (item 1408)', () => {
  test('the labelled and unlabelled spellings agree, which is what vacuous means', () => {
    const g = vacuous();

    expect(ns(g, 'MATCH (a)-[:E]-(b:P) RETURN b.n AS n')).toEqual(
      ns(g, 'MATCH (a)-[:E]-(b) RETURN b.n AS n'),
    );
  });

  test('and both directions are emitted: 2 edges give 4 rows', () => {
    // `a-b` and `b-c`, each traversed from either end.
    expect(ns(vacuous(), 'MATCH (a)-[:E]-(b:P) RETURN b.n AS n')).toEqual([1, 2, 2, 3]);
  });

  test('a START label is unaffected', () => {
    expect(ns(vacuous(), 'MATCH (a:P)-[:E]-(b:P) RETURN b.n AS n')).toEqual([1, 2, 2, 3]);
  });
});

describe('an undirected hop with a FILTERING far label (item 1408)', () => {
  // THE WRONG-ROWS GUARD. If the drop were applied to a label that filters, `b:Q` would return the
  // `P` rows too and `b:P` would return the `Q` ones — so each is pinned against the other and
  // against the unlabelled total.
  test('`b:P` keeps only the P endpoints', () => {
    // Rows are (start, far): (a,b) (b,a) (b,c) (c,b). Far ends: b=Q, a=P, c=P, b=Q.
    expect(ns(filtering(), 'MATCH (a)-[:E]-(b:P) RETURN b.n AS n')).toEqual([1, 3]);
  });

  test('`b:Q` keeps only the Q endpoint, and the two partition the unlabelled rows', () => {
    const g = filtering();

    expect(ns(g, 'MATCH (a)-[:E]-(b:Q) RETURN b.n AS n')).toEqual([2, 2]);
    expect(ns(g, 'MATCH (a)-[:E]-(b) RETURN b.n AS n')).toHaveLength(4);
  });

  test('an ABSENT label keeps nothing', () => {
    expect(ns(filtering(), 'MATCH (a)-[:E]-(b:Z) RETURN b.n AS n')).toEqual([]);
  });
});

describe('an undirected hop over a SELF-LOOP emits it once (item 1408)', () => {
  // The in-pass skips `edge.from === edge.to` because the out-pass already emitted it. A change to
  // the label handling sits directly beside that skip, so it is pinned here.
  const loop = (vacuousLabels: boolean): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    g.addVertex({ id: 'b', labels: vacuousLabels ? ['P'] : ['Q'], properties: { n: 2 } });
    g.addEdge({ id: 'aa', from: g.getVertexById('a')!, to: g.getVertexById('a')!, labels: ['E'] });
    g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });

    return g;
  };

  test('with a vacuous label: the loop once, the edge twice', () => {
    expect(ns(loop(true), 'MATCH (a)-[:E]-(b:P) RETURN b.n AS n')).toEqual([1, 1, 2]);
  });

  test('with a filtering label the loop still appears once', () => {
    // `b` is `Q` here, so `b:P` keeps the self-loop (far end `a`) and the reverse of `a-b` (far
    // end `a`), and drops the forward `a-b` whose far end is `b`.
    expect(ns(loop(false), 'MATCH (a)-[:E]-(b:P) RETURN b.n AS n')).toEqual([1, 1]);
  });
});
