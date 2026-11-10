/**
 * Item 1781: the FAR-DRIVEN route for a raise-free far predicate.
 *
 * ⚠️ A ROUTE CHANGE IS ANSWER-EQUIVALENT, so none of the 4,478 existing tests can fail when it is
 * wrong, and a green suite is not evidence that it fired (`perf-gate-needs-its-own-test`). Two
 * things therefore have to be pinned separately:
 *
 *   THE ANSWER — against an ABSOLUTE enumerated expectation, not against the other route. Item 1778
 *   is why: a route oracle says only that two paths agree, and the fix that removes the second path
 *   deletes the oracle. `EXPECTED` states the rows outright.
 *
 *   THE ROUTE — by ROW ORDER. The far-driven walk enumerates far vertices; the start-driven one
 *   enumerates start vertices and resolves a far vertex per edge, so on a fixture whose edges cross
 *   the two orders genuinely differ. `OFFSET 1` forces the start-driven arm (item 1777 gave
 *   `hopOrderPlan` a `pageSkip !== 0` arm of `startDriven`, and item 1779 made an instrument of it),
 *   so the two routes are reachable in ONE build and the order difference is what says which ran.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { predicateCannotRaise } from './executor/predicates.ts';
import { query } from './index.ts';

const N = 24;

/**
 * Every vertex carries `:L` so the start label is VACUOUS and the far-driven arm is eligible — the
 * same property item 1777's `buildVacuous()` had to add after a mutant survived against a fixture
 * whose stray label made the far-driven walk unreachable. A fixture that cannot reach the branch
 * passes for a reason that has nothing to do with the code.
 *
 * `k = i % 5` so an equality is SELECTIVE (a far vertex failing it must skip its whole bucket, which
 * is the hoist this item adds), and the edges are strided so the far-driven order is not the
 * start-driven one.
 */
const FAR = (i: number): number => (i * 7 + 3) % N;

const build = (): Graph => {
  const g = new Graph();
  const verts = [];

  for (let i = 0; i < N; i += 1) {
    verts.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['L'],
        // `m` is CONSTANT so an inline `{m: 3}` constraint is non-selective and leaves enough rows
        // for a row-ORDER read; `flag` is a boolean so `WHERE b.flag` lifts into `truthProps`,
        // which is the family `predicateCannotRaise` exists to decline. Both are here for the
        // gate's own tests below, and neither is read by any expectation above.
        properties: { k: i % 5, n: i, s: `s${i}`, m: 3, flag: i % 2 === 0 },
      }),
    );
  }

  for (let i = 0; i < N; i += 1) {
    g.addEdge({ id: `e${i}`, from: verts[i], to: verts[FAR(i)], labels: ['E'] });
  }

  return g;
};

/**
 * The rows of `MATCH (a:L)-[:E]->(b:L) WHERE <pred on b> RETURN b.<col>`, as a MULTISET.
 *
 * `FAR` is a bijection on 24 (7 is coprime with 24), so every vertex is the target of exactly one
 * edge and each passing far vertex contributes exactly one row. Stated as a multiset because this
 * item changes the ORDER deliberately — order is asserted separately, and only where it is the
 * thing under test.
 */
const expectedMultiset = (pass: (k: number, n: number) => boolean, col: 'k' | 'n'): number[] => {
  const out: number[] = [];

  for (let i = 0; i < N; i += 1) {
    const k = i % 5;

    if (pass(k, i)) {
      out.push(col === 'k' ? k : i);
    }
  }

  return out.sort((a, b) => a - b);
};

const multiset = (rows: readonly Record<string, unknown>[], col: string): number[] =>
  rows.map((r) => r[col] as number).sort((a, b) => a - b);

describe('predicateCannotRaise', () => {
  it('admits a predicate with only non-raising families', () => {
    expect(predicateCannotRaise({ props: [] })).toBe(true);
    expect(predicateCannotRaise({ props: [], eqProps: [], cmpProps: [] })).toBe(true);
    expect(predicateCannotRaise({ props: [], nullProps: [], labelTests: [] })).toBe(true);
  });

  it('rejects the three families `satisfies` coerces through `asTruth` or evaluates generically', () => {
    // These are the three the function exists to exclude, and each is rejected on its own so a
    // mutant that drops one condition fails rather than being covered by a sibling.
    expect(predicateCannotRaise({ props: [], truthProps: ['flag'] })).toBe(false);
    expect(predicateCannotRaise({ props: [], notTruthProps: ['flag'] })).toBe(false);
    expect(predicateCannotRaise({ props: [], where: () => true })).toBe(false);
  });
});

describe('a raise-free far predicate takes the far-driven walk', () => {
  const g = build();

  const cases: {
    name: string;
    q: string;
    col: 'k' | 'n';
    pass: (k: number, n: number) => boolean;
  }[] = [
    {
      name: 'an ordering comparison (the bench row at the top of item 1780)',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.n AS n',
      col: 'n',
      pass: (_k, n) => n > 5,
    },
    {
      name: 'a SELECTIVE equality — a failing far vertex skips its whole bucket',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.k = 2 RETURN b.n AS n',
      col: 'n',
      pass: (k) => k === 2,
    },
    {
      name: 'an inequality',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.k <> 2 RETURN b.n AS n',
      col: 'n',
      pass: (k) => k !== 2,
    },
    {
      name: 'IS NOT NULL',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.k IS NOT NULL RETURN b.n AS n',
      col: 'n',
      pass: () => true,
    },
    {
      name: 'a conjunction of two raise-free conjuncts',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.k < 3 AND b.n > 4 RETURN b.n AS n',
      col: 'n',
      pass: (k, n) => k < 3 && n > 4,
    },
    {
      name: 'a projection of the far key rather than the filtered property',
      q: 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.k AS k',
      col: 'k',
      pass: (_k, n) => n > 5,
    },
  ];

  for (const c of cases) {
    it(`answers correctly: ${c.name}`, () => {
      expect(multiset(query(g, c.q), c.col)).toEqual(expectedMultiset(c.pass, c.col));
    });

    it(`agrees with the START-DRIVEN route it replaces: ${c.name}`, () => {
      // `OFFSET 1` forces the start-driven arm, so this compares the two ROUTES in one build.
      //
      // ⚠️ THE PAGE REMOVES THE START-DRIVEN ARM'S FIRST ROW, NOT THE FAR-DRIVEN ARM'S, and a first
      // version of this test assumed otherwise and failed on 6 of 6 cases. The two routes enumerate
      // in different orders — which is the whole point of the order assertions below — so WHICH row
      // the page drops differs between them and `far.slice(1)` is not the paged arm's expectation.
      // The claim available from one build is therefore containment: the paged arm is the
      // far-driven arm with exactly ONE row of its own choosing removed.
      const far = query(g, c.q);
      const start = query(g, `${c.q} OFFSET 1`);

      expect(start.length).toBe(far.length - 1);

      const remaining = [...multiset(far, c.col)];

      for (const v of multiset(start, c.col)) {
        const at = remaining.indexOf(v);

        expect(at).toBeGreaterThanOrEqual(0);
        remaining.splice(at, 1);
      }

      // Exactly one row of the far-driven arm is unaccounted for, and it is the one the page took.
      expect(remaining.length).toBe(1);
    });
  }

  it('the two routes genuinely differ in ORDER, so the order assertions are not vacuous', () => {
    // If this fails, both arms are taking the SAME walk and every comparison above is a route
    // against itself — the tautological-probe mode items 1776-1778 hit twice.
    const far = query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.n AS n').map((r) => r.n);
    const start = query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.n AS n OFFSET 1').map(
      (r) => r.n,
    );

    expect(far.slice(1)).not.toEqual(start);
  });

  it('the far-driven arm emits far vertices in ASCENDING insertion order', () => {
    // The positive statement of which walk ran: the far-driven walk enumerates the far candidates,
    // so `b.n` comes out ascending. The start-driven walk enumerates start vertices and resolves
    // `FAR(i)` per edge, which is strided and therefore not ascending.
    const far = query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.n AS n').map(
      (r) => r.n as number,
    );

    expect(far).toEqual([...far].sort((x, y) => x - y));
  });
});

describe('a predicate that CAN raise keeps the start-driven route and its faults', () => {
  const g = build();

  it('a bare property in boolean context still raises', () => {
    // `truthProps`, which `asTruth` coerces. Both keys reject it, and the row set it would have
    // produced is irrelevant because it must throw.
    expect(() => query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.s RETURN b.n AS n')).toThrow();
  });

  it('an arithmetic operand still raises', () => {
    expect(() => query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.s / 2 > 1 RETURN b.n AS n')).toThrow();
  });

  it('a CAST still raises', () => {
    expect(() =>
      query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE CAST(b.s AS INTEGER) > 1 RETURN b.n AS n'),
    ).toThrow();
  });

  it('a raising predicate is NOT reordered into ascending far order', () => {
    // The route check for the DECLINING side. `b.n > 5 AND b.s` cannot raise on its first conjunct
    // and must raise overall, so if it answered rows at all the gate would be admitting a raising
    // predicate.
    expect(() =>
      query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 AND b.s RETURN b.n AS n'),
    ).toThrow();
  });
});

/**
 * ⚠️ THE GATE'S OWN TESTS, AND THEY ARE ROUTE ASSERTIONS BECAUSE NOTHING ELSE CAN SEE IT.
 *
 * The first mutation pass on this item caught every mutant in the WALK (27, 30, 5 and 1 failures)
 * and lost all three in the GATE: dropping `predicateCannotRaise`, `truthCannotRaise` or
 * `closedFar === undefined` left 4,500 pass / 0 fail. The reason is that the answer does not change
 * — a declined shape is merely slower — so only the ROUTE distinguishes them, which is the whole of
 * `perf-gate-needs-its-own-test`.
 *
 * The route is read off the ROW ORDER: the far-driven walk enumerates far candidates, so `b.n`
 * comes out ascending; the start-driven walk resolves `FAR(i)` per edge, which is strided. Each
 * case below is a shape ONE conjunct of the gate declines, so each conjunct has a test that fails
 * without it.
 *
 * ⚠️ AND FAULT ORDER TURNED OUT NOT TO BE THE OBSERVABLE, which is worth stating because it is the
 * reason item 936 gave for not building this at all. Both routes evaluate the predicate over the
 * same SET of far vertices, so no fault appears or disappears; only WHICH one escapes could differ.
 * Measured: the raising families that actually reach this gate are `truthProps`/`notTruthProps`,
 * whose message is fixed per error class (`a boolean is required — …`) and therefore identical
 * whichever vertex raises first. The value-dependent messages (`cannot cast string "BETA" to
 * number`) belong to predicates that never produce a `farPred` at all — a `CAST` does not lift, so
 * it stays in `gate` and the route declines on `farPred !== undefined` before any key is consulted.
 * So the keys are doing a ROUTING job here, not a fault-ordering one, and the soundness argument
 * they support is the one that would be needed if a value-dependent raising family ever did lift.
 */
describe('the gate declines what it must, and each conjunct has its own witness', () => {
  const g = build();

  const isAscending = (q: string): boolean => {
    const rows = query(g, q).map((r) => r.n as number);

    expect(rows.length).toBeGreaterThan(2);

    return rows.every((v, i) => i === 0 || rows[i - 1] <= v);
  };

  it('the admitted control IS far-driven, so a `false` below means something', () => {
    expect(isAscending('MATCH (a:L)-[:E]->(b:L) WHERE b.n > -1 RETURN b.n AS n')).toBe(true);
  });

  it('`predicateCannotRaise`: a bare property (truthProps) is declined', () => {
    // `b.flag` lifts into `truthProps`, which `satisfies` coerces through `asTruth`. The predicate
    // is defined and everything else about the shape qualifies, so this conjunct is the only thing
    // declining it.
    expect(isAscending('MATCH (a:L)-[:E]->(b:L) WHERE b.flag RETURN b.n AS n')).toBe(false);
  });

  it('`truthCannotRaise`: a non-raising family with a RAISING OPERAND is declined', () => {
    // `b.n > b.m / 1` is a comparison — a non-raising family — whose operand is arithmetic. It does
    // not actually raise on this fixture (`m` is 3 everywhere), so the decline is visible as a
    // route rather than as a throw, which is what makes this conjunct testable at all.
    expect(isAscending('MATCH (a:L)-[:E]->(b:L) WHERE b.n > b.m / 1 RETURN b.n AS n')).toBe(false);
  });

  it('`closedFar === undefined`: an inline far constraint is declined', () => {
    // Non-selective on purpose (`m` is 3 on every vertex) so the row count is large enough for the
    // order to be readable — a selective inline constraint left one row and said nothing.
    expect(isAscending('MATCH (a:L)-[:E]->(b:L {m: 3}) WHERE b.n > -1 RETURN b.n AS n')).toBe(
      false,
    );
  });

  it('a start-reading conjunct is declined', () => {
    expect(isAscending('MATCH (a:L)-[:E]->(b:L) WHERE b.n > -1 AND a.n > -1 RETURN b.n AS n')).toBe(
      false,
    );
  });
});

describe('shapes the gate declines for reasons other than raising', () => {
  const g = build();

  it('a start-reading predicate keeps the start-driven route and answers correctly', () => {
    const rows = query(g, 'MATCH (a:L)-[:E]->(b:L) WHERE a.n > 5 RETURN b.n AS n');
    const want: number[] = [];

    for (let i = 0; i < N; i += 1) {
      if (i > 5) {
        want.push(FAR(i));
      }
    }

    expect(multiset(rows, 'n')).toEqual(want.sort((a, b) => a - b));
  });

  it('a NON-VACUOUS start label keeps the start-driven route, and the stray vertex HAS AN EDGE so the branch is reachable', () => {
    // ⚠️ THE STRAY VERTEX MUST HAVE AN OUT-EDGE, and a first version of this test gave it none.
    // With an isolated `:M` vertex the far-driven walk would answer CORRECTLY even with the vacuity
    // check removed — every edge still runs between two `:L` vertices — so the mutant that drops
    // that check would survive against a fixture which cannot reach the branch. That is item 1777's
    // lesson exactly, and item 1064's before it: the fixture is load-bearing.
    //
    // With the edge present the two routes genuinely disagree: the start-driven walk rejects the
    // `:M` start vertex and emits no row for this edge, while a far-driven walk that skipped the
    // vacuity test would enumerate `v7` and emit a row per in-edge — including this one — because
    // it never looks at a start vertex at all.
    const g2 = new Graph();
    const verts = [];

    for (let i = 0; i < N; i += 1) {
      verts.push(
        g2.addVertex({ id: `v${i}`, labels: ['L'], properties: { k: i % 5, n: i, s: `s${i}` } }),
      );
    }

    for (let i = 0; i < N; i += 1) {
      g2.addEdge({ id: `e${i}`, from: verts[i], to: verts[FAR(i)], labels: ['E'] });
    }

    const stray = g2.addVertex({ id: 'stray', labels: ['M'], properties: { k: 0, n: 99, s: 'x' } });

    g2.addEdge({ id: 'estray', from: stray, to: verts[7], labels: ['E'] });

    const rows = query(g2, 'MATCH (a:L)-[:E]->(b:L) WHERE b.n > 5 RETURN b.n AS n');

    // Unchanged from the vacuous fixture: the extra edge contributes nothing, because its START is
    // not `:L`. A route that emitted it would show up here as an extra `7`.
    expect(multiset(rows, 'n')).toEqual(expectedMultiset((_k, n) => n > 5, 'n'));
  });
});
