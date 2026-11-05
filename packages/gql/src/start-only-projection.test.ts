/**
 * ITEM 1525 — the start-driven hop projection gets `farDrivenHopWalk`'s template-and-copy when the
 * projection reads ONLY the start: every row a start vertex produces is then identical, so the
 * bucket SIZE is the row count and one `projectRow` serves the whole group.
 * `MATCH (a:P)-[:E]->() RETURN a.k` went from **251 to 117 ns/row (2.15x)** at 1,000,000 edges.
 *
 * ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the 3,800 tests in this package cannot see it taken or
 * dropped — `perf-gate-needs-its-own-test`. What they also cannot see is the route taken WRONGLY,
 * and that is a wrong ANSWER rather than a slow one, because this route derives the row COUNT from
 * the bucket size instead of from the edges it walked. Three ways to get it wrong:
 *
 *  1. **Anything that can reject an edge** makes the bucket size the wrong count — a non-vacuous far
 *     label, a far predicate.
 *  2. **A projection reading the far end** must not be folded: `RETURN a.k, x.k` has a DIFFERENT
 *     far value per row, and copying one template would repeat the first across the group.
 *  3. **The copies must be distinct objects.** `rows.push(template)` followed by `{ ...template }`
 *     is deliberate — the template is the first row — but pushing the same object `n` times would
 *     alias every row in a group to one object.
 *
 * Each is a case below, and each has a mutant recorded in the item that fails it.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Mixed out-degrees and a far label that rejects SOME edges, which is what makes the count tests
 * discriminating: a uniform fixture cannot tell `bucket.size` from the number of surviving edges.
 *
 *   a (k=1) → q1, q2, p1     out-degree 3, two of them `Q`
 *   b (k=2) → q1             out-degree 1, one of them `Q`
 *   c (k=3) →                out-degree 0 — a start with an EMPTY bucket
 */
const graph = (): Graph => {
  const g = new Graph();

  for (const [id, k, labels] of [
    ['a', 1, ['P']],
    ['b', 2, ['P']],
    ['c', 3, ['P']],
    ['q1', 9, ['P', 'Q']],
    ['q2', 8, ['P', 'Q']],
    ['p1', 7, ['P']],
  ] as const) {
    g.addVertex({ id, labels: [...labels], properties: { k } });
  }

  let e = 0;

  for (const [f, t] of [
    ['a', 'q1'],
    ['a', 'q2'],
    ['a', 'p1'],
    ['b', 'q1'],
  ] as const) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(f)!,
      to: g.getVertexById(t)!,
      // ⚠️ A DISTINCT `w` PER EDGE, and it has to be a real PROPERTY. My first version asserted on
      // `r.id` and read four nulls — `id` is the edge's IDENTITY, not a property, so ISO property
      // access on an absent key gives NULL and the column was uniformly null whether or not the
      // fold had wrongly fired. The test could not have failed for the reason it was written for.
      properties: { w: e + 1 },
    });
    e += 1;
  }

  return g;
};

const col = (rows: readonly Record<string, unknown>[], name: string): unknown[] =>
  rows.map((r) => r[name]).sort((x, y) => Number(x) - Number(y));

describe('a start-only projection folds to one row per edge, with the right count', () => {
  it('emits out-degree rows per start vertex', () => {
    // a contributes 3 (k=1), b contributes 1 (k=2), c contributes none.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k'), 'k')).toEqual([1, 1, 1, 2]);
  });

  it('a start with an EMPTY bucket contributes nothing', () => {
    // `c` has no out-edges. A fold that emitted one row per start vertex regardless would add a 3.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k'), 'k')).not.toContain(3);
  });

  it('⚠️ a NON-VACUOUS far label changes the count, so the fold must not use the bucket size', () => {
    // a→q1, a→q2 survive (k=1 twice); a→p1 does not; b→q1 survives (k=2). THREE rows, not four.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(:Q) RETURN a.k AS k'), 'k')).toEqual([1, 1, 2]);
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x:Q) RETURN a.k AS k'), 'k')).toEqual([1, 1, 2]);
  });

  it('⚠️ a far PREDICATE changes the count too', () => {
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x) WHERE x.k > 8 RETURN a.k AS k'), 'k')).toEqual(
      [1, 2],
    );
  });

  it('a VACUOUS far label is the folded case and still answers', () => {
    // Every vertex carries `P`, so `(:P)` rejects nothing and the bucket size IS the count.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(:P) RETURN a.k AS k'), 'k')).toEqual([
      1, 1, 1, 2,
    ]);
  });
});

describe('⚠️ the fold must not apply when the projection reads the far end', () => {
  it('RETURN a.k, x.k keeps a DISTINCT far value per row', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->(x) RETURN a.k AS k, x.k AS j');
    const pairs = rows.map((r) => `${String(r.k)}/${String(r.j)}`).sort();

    // Folding would give 1/9, 1/9, 1/9, 2/9 — the first far value repeated across a's group.
    expect(pairs).toEqual(['1/7', '1/8', '1/9', '2/9']);
  });

  it('RETURN x.k alone is the far-driven case and is unaffected', () => {
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x) RETURN x.k AS j'), 'j')).toEqual([7, 8, 9, 9]);
  });

  it('a projected REL variable is not folded either', () => {
    const rows = query(graph(), 'MATCH (a:P)-[r:E]->() RETURN a.k AS k, r.w AS w');

    expect(rows).toHaveLength(4);
    // Four edges with distinct `w`, so four distinct values — a fold would repeat one per group.
    expect(new Set(rows.map((r) => r.w)).size).toBe(4);
    expect(col(rows, 'w')).toEqual([1, 2, 3, 4]);
  });
});

describe('⚠️ the copies are distinct objects', () => {
  it('rows in one group are not the same object', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k');
    const ones = rows.filter((r) => r.k === 1);

    expect(ones).toHaveLength(3);
    // `rows.push(template)` then `{ ...template }` — the template IS the first row, and the rest
    // are clones. Pushing the template `n` times would alias them, which a caller mutating one row
    // would see. Identity, not equality, is the assertion.
    expect(ones[0]).not.toBe(ones[1]);
    expect(ones[1]).not.toBe(ones[2]);
  });

  it('mutating one row does not touch its siblings', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k');
    const ones = rows.filter((r) => r.k === 1);

    (ones[0] as Record<string, unknown>).k = 99;
    expect(ones[1].k).toBe(1);
    expect(ones[2].k).toBe(1);
  });
});

describe('the neighbouring shapes still answer', () => {
  it('RETURN * is unaffected and names only the bound variables', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN *');

    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0])).toEqual(['a']);
  });

  it('a START predicate plus a start-only projection still answers', () => {
    // `gate` is defined, so this takes the start-only PREDICATE closure, not the fold.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() WHERE a.k > 1 RETURN a.k AS k'), 'k')).toEqual([
      2,
    ]);
  });

  it('an aggregate over a start-only projection is unaffected', () => {
    expect(query(graph(), 'MATCH (a:P)-[:E]->() RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  it('ORDER BY over the folded shape is still ordered', () => {
    expect(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k ORDER BY k DESC')).toEqual([
      { k: 2 },
      { k: 1 },
      { k: 1 },
      { k: 1 },
    ]);
  });
});
