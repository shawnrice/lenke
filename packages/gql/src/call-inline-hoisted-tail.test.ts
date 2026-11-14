import { describe, expect, test } from 'bun:test';

/**
 * The HOISTED tail of `runCallInline` — item 1818.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. Item 1818 added a second row-to-binding tail, taken only when an
 * unscoped (and therefore non-correlated) inline `CALL` body has been hoisted, which reuses the
 * body rows' `Object.entries` instead of recomputing them per outer row. That is a pure
 * ROUTE CHOICE: both tails are built to emit the same bindings, so by construction every existing
 * test agrees whichever one runs, and `bun run fuzz` compares TS against Rust on the ANSWER — so a
 * mutant that breaks the new tail in a way the old tail would have got right is invisible to all of
 * it. `perf-gate-needs-its-own-test` is the rule; these are the assertions that give the route
 * teeth.
 *
 * Each test below is written against a shape where the TWO TAILS COULD DISAGREE, rather than
 * against the shape the optimization was measured on (a single-column `count(*)` body, where almost
 * any mutant still produces the right answer).
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = () => {
  const graph = new Graph();

  for (let i = 0; i < 4; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, s: `s${i}` } });
  }

  const v0 = graph.getVertexById('v0');
  const v1 = graph.getVertexById('v1');

  if (v0 === null || v1 === null) {
    throw new Error('fixture is broken: v0/v1 missing right after insertion');
  }

  graph.addEdge({ id: 'e0', from: v0, to: v1, labels: ['E'] });

  return graph;
};

describe('the hoisted inline-CALL tail emits what the general tail emits', () => {
  /**
   * ⚠️ A MULTI-COLUMN body, because the measured shape has ONE column and a one-column row cannot
   * catch a tail that drops, reorders or duplicates entries.
   */
  test('carries every body column onto every outer row', () => {
    const rows = query(
      g(),
      'MATCH (n:P) CALL { MATCH (a:P) WHERE a.k = 2 RETURN a.k AS bk, a.s AS bs } ' +
        'RETURN n.k AS nk, bk, bs ORDER BY nk',
    );

    expect(rows).toEqual([
      { nk: 0, bk: 2, bs: 's2' },
      { nk: 1, bk: 2, bs: 's2' },
      { nk: 2, bk: 2, bs: 's2' },
      { nk: 3, bk: 2, bs: 's2' },
    ]);
  });

  /**
   * ⚠️ A body returning SEVERAL rows, so the tail's own loop is exercised. A tail that emitted only
   * the first hoisted row, or that reused one binding object across rows, passes the test above and
   * fails this one.
   */
  test('crosses a multi-row body against every outer row', () => {
    const rows = query(
      g(),
      'MATCH (n:P) WHERE n.k < 2 CALL { MATCH (a:P) WHERE a.k < 3 RETURN a.k AS bk } ' +
        'RETURN n.k AS nk, bk ORDER BY nk, bk',
    );

    expect(rows).toEqual([
      { nk: 0, bk: 0 },
      { nk: 0, bk: 1 },
      { nk: 0, bk: 2 },
      { nk: 1, bk: 0 },
      { nk: 1, bk: 1 },
      { nk: 1, bk: 2 },
    ]);
  });

  /**
   * ⚠️ THE SHADOWING CASE, which is the sharpest thing either tail has to get right: the body's
   * column has the SAME NAME as a BOUND OUTER VARIABLE. Both tails copy the outer binding first
   * and then set the body's entries over it, so the BODY wins — a tail that seeded from the body
   * and overlaid the outer binding would invert this and still pass every other test here.
   *
   * ⚠️ AND THE COLLISION HAS TO BE WITH THE VARIABLE, NOT WITH A PROJECTED COLUMN — this test's
   * first cut used `RETURN a.k AS nk` against an outer `n`, where there is no collision at all
   * (the outer binding holds the variable `n`, and `nk` only exists after the final projection), so
   * the inverted-overlay mutant SURVIVED it. Caught by mutating, not by reading. The name below is
   * `n` deliberately: the outer binding has `n` bound to a VERTEX and the body rebinds it to the
   * number 3, so the two orders give visibly different answers rather than merely different types.
   */
  test('a body column overwrites an outer VARIABLE of the same name', () => {
    const rows = query(
      g(),
      'MATCH (n:P) WHERE n.k < 2 CALL { MATCH (a:P) WHERE a.k = 3 RETURN a.k AS n } ' +
        'RETURN n ORDER BY n',
    );

    expect(rows).toEqual([{ n: 3 }, { n: 3 }]);
  });

  /**
   * ⚠️ A body that matches NOTHING under an OPTIONAL call must still null-pad, and that arm sits
   * ABOVE the new tail. A guard written as `hoistedPairs !== undefined` alone, without the
   * empty-body arm keeping its place, would return no rows here.
   */
  test('an OPTIONAL call with an empty hoisted body still null-pads', () => {
    const rows = query(
      g(),
      'MATCH (n:P) WHERE n.k < 2 OPTIONAL CALL { MATCH (a:P) WHERE a.k = 99 RETURN a.k AS bk } ' +
        'RETURN n.k AS nk, bk ORDER BY nk',
    );

    expect(rows).toEqual([
      { nk: 0, bk: null },
      { nk: 1, bk: null },
    ]);
  });

  /**
   * ⚠️ THE CORRELATED FORM MUST NOT TAKE THE NEW TAIL, and the assertion is a VALUE and not a
   * timing: with ISO's variable scope clause the body sees the outer `n`, so `c` is that vertex's
   * own degree. If the hoist (and with it the new tail) ever reached a scoped call, every row would
   * read the same whole-graph number instead — which is exactly the 1-vs-6 observation
   * `runCallInline`'s own comment records.
   */
  test('a scoped call stays correlated and is unaffected', () => {
    const rows = query(
      g(),
      'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x:P) RETURN count(*) AS c } ' +
        'RETURN n.k AS nk, c ORDER BY nk',
    );

    expect(rows).toEqual([
      { nk: 0, c: 1 },
      { nk: 1, c: 0 },
      { nk: 2, c: 0 },
      { nk: 3, c: 0 },
    ]);
  });

  /**
   * ⚠️ THE UNSCOPED FORM'S ANSWER IS THE WHOLE-GRAPH ONE, pinned here as the twin of the test
   * above. This is the observable that proves the body does not see the outer row — the property
   * item 1818 relied on when it concluded the body is loop-invariant, so it is asserted rather
   * than assumed.
   */
  test('an unscoped call sees no outer variable, so every row reads the same body answer', () => {
    const rows = query(
      g(),
      'MATCH (n:P) CALL { MATCH (n)-[:E]->(x:P) RETURN count(*) AS c } ' +
        'RETURN n.k AS nk, c ORDER BY nk',
    );

    expect(rows).toEqual([
      { nk: 0, c: 1 },
      { nk: 1, c: 1 },
      { nk: 2, c: 1 },
      { nk: 3, c: 1 },
    ]);
  });

  /**
   * ⚠️ A SET-OP body, because `bodyMore` folds extra parts into `nested` AFTER the first
   * `runLinearClauses` and the hoist caches the FOLDED result. A tail keyed on the first part's
   * rows would drop the union's second half.
   */
  test('a UNION body is hoisted and crossed in full', () => {
    const rows = query(
      g(),
      'MATCH (n:P) WHERE n.k = 0 ' +
        'CALL { MATCH (a:P) WHERE a.k = 1 RETURN a.k AS bk ' +
        'UNION MATCH (a:P) WHERE a.k = 2 RETURN a.k AS bk } ' +
        'RETURN bk ORDER BY bk',
    );

    expect(rows).toEqual([{ bk: 1 }, { bk: 2 }]);
  });

  /**
   * ⚠️ A body whose rows carry a NULL value, since `Object.entries` captured once must still carry
   * a key whose value is null rather than the key disappearing — the hoisted tail reads a captured
   * pair list, so a mutant that filtered nullish pairs when building it would lose the column
   * entirely and no other test here would notice.
   */
  test('a null body value is carried as a present column', () => {
    const rows = query(
      g(),
      'MATCH (n:P) WHERE n.k = 0 CALL { MATCH (a:P) WHERE a.k = 1 RETURN a.missing AS bk } ' +
        'RETURN n.k AS nk, bk',
    );

    expect(rows).toEqual([{ nk: 0, bk: null }]);
  });
});
