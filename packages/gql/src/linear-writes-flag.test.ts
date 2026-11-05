/**
 * ITEM 1510 — `CLinear.writes` is now settled by `compileLinear` instead of recomputed on every
 * call. `runLinear` used to open with `linear.clauses.some((c) => WRITE_CLAUSES.has(c.kind))`,
 * which allocates a closure and does a `Set` lookup per clause to re-derive a property of the
 * compiled query: 14.7% of an 82 ns `RETURN 1 AS v`, and 1.19x on the two-clause count shapes.
 *
 * ⚠️ BEING WRONG HERE LOSES A TRANSACTION, NOT AN ANSWER — and that is why this file exists rather
 * than leaning on the 3,787 answer-comparing tests. `writes` is the single input to the one
 * decision `runLinear` makes:
 *
 *     if (!linear.writes) { return runLinearClauses(…); }
 *     return graph.transaction(() => runLinearClauses(…));
 *
 * So a `writes` that is wrongly FALSE runs the write with no transaction around it. Every row
 * assertion still passes — the happy path writes the same rows either way. What breaks is only
 * visible when a write FAILS PARTWAY: with the transaction, the whole statement rolls back; without
 * it, the rows written before the failure stay. A unique constraint makes that observable without
 * any timing or internals.
 *
 * Both halves are here deliberately:
 *
 *  1. the FLAG, asserted per clause kind — catches a kind missing from `WRITE_CLAUSES` precisely;
 *  2. the CONSEQUENCE, asserted as rollback — catches the flag being right and the wiring wrong,
 *     which (1) cannot see.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor.js';
import { parse, query } from './index.js';

/**
 * The compiled `writes` flag for a query text.
 *
 * The cast mirrors the four `routes()` helpers: `Statement` is a union, so `.parts` is not on it
 * statically, and `compileLinear` wants the `LinearQuery` inside.
 */
const writesOf = (text: string): boolean => {
  const q = parse(text) as never as { parts: readonly never[] };

  return compileLinear(q.parts[0]).writes;
};

describe('⚠️ CLinear.writes is true for every write clause kind', () => {
  // One case per member of `WRITE_CLAUSES`. A kind dropped from that set makes exactly one of
  // these fail, which is what names the mistake instead of just reporting a count.
  for (const [kind, text] of [
    ['insert', 'INSERT (:T {k: 1})'],
    ['merge', '_MERGE (:T {k: 1})'],
    ['set', 'MATCH (t:T) SET t.k = 2'],
    ['remove', 'MATCH (t:T) REMOVE t.k'],
    ['delete', 'MATCH (t:T) DELETE t'],
  ] as const) {
    it(`${kind} sets the flag`, () => {
      expect(writesOf(text), `${kind}: writes must be true`).toBe(true);
    });
  }

  it('a write ANYWHERE in the clause list sets it, not just in the first position', () => {
    expect(writesOf('MATCH (t:T) WHERE t.k > 0 SET t.j = 1 RETURN t.k AS k')).toBe(true);
    expect(writesOf('MATCH (t:T) INSERT (:U {k: 1})')).toBe(true);
  });
});

describe('CLinear.writes is false for reads', () => {
  for (const [label, text] of [
    ['a bare RETURN', 'RETURN 1 AS v'],
    ['a count', 'MATCH (t:T) RETURN count(*) AS c'],
    ['a filtered projection', 'MATCH (t:T) WHERE t.k > 1 RETURN t.k AS k'],
    ['a hop', 'MATCH (a:T)-[:E]->(b:T) RETURN b.k AS k'],
    ['a LET chain', 'LET a = 1 LET b = 2 RETURN a + b AS v'],
    ['ORDER BY and LIMIT', 'MATCH (t:T) RETURN t.k AS k ORDER BY k LIMIT 2'],
  ] as const) {
    it(`${label} does not set the flag`, () => {
      expect(writesOf(text), label).toBe(false);
    });
  }
});

describe('⚠️ the CONSEQUENCE: a write that fails partway still rolls back', () => {
  // THE HALF WITH TEETH. The flag being right is not the same as it being WIRED right, and no row
  // assertion anywhere can see the difference — a successful write writes the same rows with or
  // without a transaction around it. These cases fail only if `runLinear` stopped wrapping.
  const seeded = (): Graph => {
    const g = new Graph();

    g.createUniqueConstraint('T', 'k');
    query(g, 'INSERT (:T {k: 1})');

    return g;
  };

  it('a multi-node INSERT whose SECOND node violates uniqueness writes NEITHER', () => {
    const g = seeded();

    expect(() => query(g, 'INSERT (:T {k: 3}), (:T {k: 1})')).toThrow();
    // Without the transaction, k=3 is already in the graph when the k=1 insert raises.
    expect(
      query(g, 'MATCH (t:T) RETURN t.k AS k ORDER BY k'),
      'k=3 survived — the failing write was NOT rolled back, so runLinear skipped the transaction',
    ).toEqual([{ k: 1 }]);
  });

  it('a SET across rows that collides on the last row leaves every row unchanged', () => {
    const g = new Graph();

    g.createUniqueConstraint('T', 'k');
    query(g, 'INSERT (:T {k: 1}), (:T {k: 2}), (:T {k: 3})');

    // Collapsing every k to 9 collides as soon as the second row is set.
    expect(() => query(g, 'MATCH (t:T) SET t.k = 9')).toThrow();
    expect(
      query(g, 'MATCH (t:T) RETURN t.k AS k ORDER BY k'),
      'a partially applied SET survived — the statement was not transactional',
    ).toEqual([{ k: 1 }, { k: 2 }, { k: 3 }]);
  });

  it('a successful write still commits — the wrapper must not swallow the change', () => {
    const g = seeded();

    query(g, 'INSERT (:T {k: 7})');
    expect(query(g, 'MATCH (t:T) RETURN t.k AS k ORDER BY k')).toEqual([{ k: 1 }, { k: 7 }]);
  });

  it('a read that raises needs no rollback and still raises', () => {
    const g = seeded();

    expect(() => query(g, 'MATCH (t:T) RETURN nope(t.k) AS k')).toThrow();
    expect(query(g, 'MATCH (t:T) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });
});
