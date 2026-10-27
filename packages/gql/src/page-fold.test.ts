import { describe, expect, it } from 'bun:test';

/**
 * `foldPageIntoReturn` moves a trailing page STATEMENT onto the `RETURN` that follows it, so the
 * query is two clauses and the sort runs over projected columns (item 969). Measured at 200,000
 * nodes: `MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c` **38.01 → 10.02 ms, 3.79x**.
 *
 * THESE TESTS ARE THE REFUSAL LIST. The rewrite is answer-equivalent where it is legal, so every
 * mutant of it survives the differential tests (item 585) and nothing in the existing suite can
 * see it. What CAN go wrong is folding where it is not legal — and each case below changes an
 * ANSWER, not a cost. Each asserts the answer the engine must give, independently of which route
 * produced it.
 */
import { Graph } from '@lenke/core';

import { query } from './index.ts';

/** Six nodes: `k` descends 5..0 as `other` ascends 0..50, so a wrong ORDER is visible. */
const g = new Graph();

for (let i = 0; i < 6; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { k: 5 - i, other: i * 10, grp: i % 2 },
  });
}

const rows = (q: string): unknown[] => [...query(g, q)];

describe('a trailing page statement folds into the RETURN', () => {
  it('orders by a projected key, and the fold keeps the rows and their order', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 3 RETURN n.k AS c')).toEqual([
      { c: 0 },
      { c: 1 },
      { c: 2 },
    ]);
  });

  // The measured case keys on a variable the projection does NOT emit. It must still order by
  // `n.k` and not by the output column.
  it('orders by a key the projection does not emit', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 3 RETURN n.other AS o')).toEqual([
      { o: 50 },
      { o: 40 },
      { o: 30 },
    ]);
  });

  it('carries DESC and OFFSET across the fold', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k DESC LIMIT 2 RETURN n.other AS o')).toEqual([
      { o: 0 },
      { o: 10 },
    ]);
    expect(rows('MATCH (n:P) ORDER BY n.k OFFSET 2 LIMIT 2 RETURN n.k AS c')).toEqual([
      { c: 2 },
      { c: 3 },
    ]);
  });
});

describe('the fold REFUSES where it would change an answer', () => {
  // THE ONE THAT MOTIVATES THE WHOLE LIST. `ORDER BY … LIMIT 3 RETURN count(*)` takes three rows
  // and counts them; folded, it would count all six and page the single result row.
  it('an aggregating projection still counts only the paged rows', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 3 RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  it('a grouped projection groups only the paged rows', () => {
    // The two smallest `k` are k=0 (grp 1) and k=1 (grp 0) — DIFFERENT groups, so two rows of
    // one each. Folding would group all six and then page, giving a single row of 3.
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 2 RETURN count(*) AS c GROUP BY n.grp')).toEqual([
      { c: 1 },
      { c: 1 },
    ]);
  });

  // DISTINCT changes the row set the LIMIT applies to: paging first takes 3 rows then dedups to
  // 2 distinct `grp` values; folding would dedup to 2 first and then take 3.
  it('DISTINCT applies to the paged rows, not the other way round', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 3 RETURN DISTINCT n.grp AS g')).toEqual([
      { g: 1 },
      { g: 0 },
    ]);
  });

  // TWO pages compose rather than merge: take the 4 smallest `k`, then the last 2 of those.
  it('a projection that already pages composes with the statement page', () => {
    expect(
      rows('MATCH (n:P) ORDER BY n.k LIMIT 4 RETURN n.k AS c ORDER BY c DESC LIMIT 2'),
    ).toEqual([{ c: 3 }, { c: 2 }]);
  });

  // A PROPERTY key whose last segment matches an alias is NOT shadowing: `n.other` names a
  // property of `n`, and its only free variable is `n`.
  it('a property key whose name matches an alias keeps its original meaning', () => {
    expect(rows('MATCH (n:P) ORDER BY n.other LIMIT 3 RETURN n.k AS other')).toEqual([
      { other: 5 },
      { other: 4 },
      { other: 3 },
    ]);
  });

  // THE REAL SHADOWING SHAPE, and it turns out this engine is not vulnerable to it: a clause
  // `ORDER BY x` resolves `x` in the INPUT scope (the `LET` variable), not to the output column
  // of the same name. Both spellings below sort by `n.other` ascending and return `[5,4,3]`; if
  // the clause position resolved to the output alias, the second would sort by `n.k` and return
  // `[0,1,2]`. So `foldPageIntoReturn`'s alias guard is INERT — removing it passes all 2,786
  // tests. It is kept the way item 869's `toArray` and item 865's `nulls_first` guard are kept:
  // cheap, and load-bearing the moment that resolution rule changes. This test is what would
  // notice if it did.
  it('a LET variable key resolves in the INPUT scope, in both spellings', () => {
    const statement = rows('MATCH (n:P) LET x = n.other ORDER BY x LIMIT 3 RETURN n.k AS x');

    expect(statement).toEqual([{ x: 5 }, { x: 4 }, { x: 3 }]);
    expect(rows('MATCH (n:P) LET x = n.other RETURN n.k AS x ORDER BY x LIMIT 3')).toEqual(
      statement,
    );
  });

  it('RETURN * is left alone', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 2 RETURN *').length).toBe(2);
  });

  // A page clause that is not immediately before the RETURN: the FILTER between them observes
  // the PAGED table, so it sees 3 rows and keeps the 2 with k > 0.
  it('a clause between the page and the RETURN observes the paged table', () => {
    expect(rows('MATCH (n:P) ORDER BY n.k LIMIT 3 FILTER n.k > 0 RETURN n.k AS c')).toEqual([
      { c: 1 },
      { c: 2 },
    ]);
  });
});
