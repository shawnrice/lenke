// Item 277. `CPredicate` carries a constraint in three places — `props`, `where`, and the
// equalities lifted into `eqProps` — and six of the seven gates that asked "is this predicate
// empty?" listed only the first two. An inline `WHERE a.k = 1` lifts ENTIRELY into `eqProps`,
// so those gates saw nothing and skipped applying it: a silent SUPERSET.
//
// Every test here compares the THREE SPELLINGS of one question. That is the shape the bug had
// — `(a WHERE a.k = 1)` returned 3 rows where `(a {k: 1})` returned 1 — so a spelling
// comparison is what detects it, and asserting one spelling alone would not have.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** Three P nodes in a cycle, so EVERY node has an out-edge and an in-edge: "has an edge" is
 *  true for all of them, and the predicate is the only thing that can distinguish. */
const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ labels: ['P'], properties: { n: 'a', k: 1 } });
  const b = graph.addVertex({ labels: ['P'], properties: { n: 'b', k: 2 } });
  const c = graph.addVertex({ labels: ['P'], properties: { n: 'c', k: 3 } });

  graph.addEdge({ from: a, to: b, labels: ['E'], properties: { w: 1 } });
  graph.addEdge({ from: b, to: c, labels: ['E'], properties: { w: 2 } });
  graph.addEdge({ from: c, to: a, labels: ['E'], properties: { w: 3 } });

  return graph;
};

const names = (q: string): string[] => (query(g(), q) as { n: string }[]).map((r) => r.n).sort();

describe('an inline WHERE on the already-bound start of an EXISTS subquery', () => {
  // THE BUG. `a.k = 1` lifts into `eqProps`, and the one-hop EXISTS fast path's decline gate
  // read only `props`/`where` — so it took the fast path and answered "does `a` have an out
  // edge", which is true for all three.
  test('the EQUALITY spelling is applied', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k = 1)-[:E]->(x) } RETURN a.n AS n'),
    ).toEqual(['a']);
  });

  test('the ORDERING spelling agrees (it stayed in `where`, so it always worked)', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k > 2)-[:E]->(x) } RETURN a.n AS n'),
    ).toEqual(['c']);
  });

  test('the INLINE-PROPERTY spelling agrees (it landed in `props`)', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a {k: 1})-[:E]->(x) } RETURN a.n AS n'),
    ).toEqual(['a']);
  });

  test('a two-conjunct inline WHERE, both lifting', () => {
    expect(
      names(
        "MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k = 1 AND a.n = 'a')-[:E]->(x) } \
         RETURN a.n AS n",
      ),
    ).toEqual(['a']);
  });

  test('a predicate matching nothing yields nothing, not everything', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k = 99)-[:E]->(x) } RETURN a.n AS n'),
    ).toEqual([]);
  });
});

describe('an inline WHERE on the ENDPOINT of an EXISTS subquery', () => {
  // The same omission in the endpoint's `free` computation, which decides that an
  // unconstrained endpoint makes every neighbour an answer.
  test('the EQUALITY spelling is applied', () => {
    // a→b, b→c, c→a. Only the hop landing on k=1 (c→a) qualifies, so only `c` matches.
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a)-[:E]->(x WHERE x.k = 1) } RETURN a.n AS n'),
    ).toEqual(['c']);
  });

  test('the INLINE-PROPERTY spelling agrees', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a)-[:E]->(x {k: 1}) } RETURN a.n AS n'),
    ).toEqual(['c']);
  });

  test('the ORDERING spelling agrees', () => {
    // k > 2 is only c, reached from b.
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a)-[:E]->(x WHERE x.k > 2) } RETURN a.n AS n'),
    ).toEqual(['b']);
  });
});

describe('the quantified EXISTS gate', () => {
  // The FIRST of the two gates with this shape guards the `->*` / `->+` fast path.
  test('an equality on the bound start is applied under a quantifier', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a WHERE a.k = 1)-[:E]->+(x) } RETURN a.n AS n'),
    ).toEqual(['a']);
  });

  test('the inline-property spelling agrees under a quantifier', () => {
    expect(
      names('MATCH (a:P) WHERE EXISTS { MATCH (a {k: 1})-[:E]->+(x) } RETURN a.n AS n'),
    ).toEqual(['a']);
  });
});

describe('an inline WHERE on a RELATIONSHIP', () => {
  // `relHasInlinePred` was the ONE check that already listed `eqProps`, because this exact
  // mistake shipped once for rels (`rel-inline-pred.test.ts`). It now routes through the same
  // helper, so these pin that it kept working.
  test('an equality on the edge is applied', () => {
    expect(names('MATCH (a:P)-[e:E WHERE e.w = 2]->(x) RETURN a.n AS n')).toEqual(['b']);
  });

  test('the inline-property spelling agrees', () => {
    expect(names('MATCH (a:P)-[e:E {w: 2}]->(x) RETURN a.n AS n')).toEqual(['b']);
  });
});
