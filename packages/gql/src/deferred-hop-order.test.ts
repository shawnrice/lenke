/**
 * Item 1063: the HOP rung's deferred order — a windowed sort whose projection could fault.
 *
 * `hopOrderPlan` refused these outright, because the walks project every row and `sortedRows`
 * slices after. `deferredHopOrder` hands the walk a REDUCED projection (the sort keys, plus one
 * item per endpoint the real items read) and re-projects the survivors, so no walk changed.
 *
 * WHAT GIVES THESE TESTS TEETH. The route choice is not answer-equivalent — that is the point —
 * and the two directions are separate failures with opposite fixes: projecting too eagerly raises
 * where the query does not, and refusing the arm is only slow. So both the ANSWER and the ROUTE
 * are asserted, and each walk variant gets its own case, because a partial build would make a
 * filtered hop and an unfiltered one answer the same question by different routes.
 *
 * Every expected value here was confirmed against the NATIVE engine first — 20 arms, all agreeing,
 * including each raise.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/** The fast-path detectors that fire for `src` — `routes-fired.test.ts`'s helper. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([k, v]) => k !== 'clauses' && v !== null && v !== undefined)
    .map(([k]) => k)
    .sort();
};

/**
 * Eight `P` vertices and seven `E` edges.
 *
 * `bad` is the ONLY vertex whose `s` cannot be CAST and it sits at the TOP of the `k` order, so a
 * window can include it or exclude it by choosing a direction — which is what separates "the arm
 * defers" from "the arm is never reached". The first fixture had two faulting vertices, one at
 * each end, and every window then included one: it agreed with native while proving nothing.
 */
const fixture = (): Graph => {
  const g = new Graph();
  const ks = [3, 1, 2, 1, 5, 4];
  const vs = ks.map((k, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k, s: `${i}`, t: i % 2 === 0 ? 'a' : 'b' },
    }),
  );
  const bad = g.addVertex({ id: 'bad', labels: ['P'], properties: { k: 9, s: 'nope', t: 'a' } });
  const low = g.addVertex({ id: 'worst', labels: ['P'], properties: { k: -2, s: '8', t: 'b' } });
  const E = (id: string, from: unknown, to: unknown, w: number): void => {
    g.addEdge({ id, labels: ['E'], from: from as never, to: to as never, properties: { w } });
  };

  E('e0', vs[0], vs[1], 5);
  E('e1', vs[0], vs[2], 1);
  E('e2', vs[1], vs[3], 3);
  E('e3', vs[2], bad, 7);
  E('e4', vs[3], low, 2);
  E('e5', vs[4], vs[5], 4);
  E('e6', vs[5], vs[0], 6);

  return g;
};

describe('every hop walk variant takes the rung now', () => {
  // One per variant. A variant missing here is one whose spelling would cost 3-4x more than its
  // siblings' for the same question.
  const CLAIMED = [
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 3',
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY b.k + 1 LIMIT 3',
    'MATCH (a:P)-[:E]->(b:P) WHERE b.k > 0 RETURN b.k + 1 AS c ORDER BY c LIMIT 3',
    'MATCH (a:P)-[:E]-(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 4',
    "MATCH (a:P {t: 'a'})-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 3",
    'MATCH (a:P)-[e:E]->(b:P) RETURN e.w + 1 AS c ORDER BY c LIMIT 3',
    'MATCH (a:P)-[:E]->(b:P) RETURN upper(b.s) AS c ORDER BY c LIMIT 3',
    'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k + 1 AS c ORDER BY x LIMIT 3',
    'MATCH (a:P)-[e:E]->(b:P) RETURN a.k AS x, e.w AS w, b.k + 1 AS c ORDER BY c, x LIMIT 4',
  ] as const;

  for (const q of CLAIMED) {
    it(`routes ${q}`, () => {
      expect(routes(q)).toEqual(['hopProjection']);
    });
  }

  const REFUSED = [
    // A window with no sort: the general path is lazy and a materializing rung scans everything.
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c LIMIT 3',
    // `LIMIT 0` — correctness, not speed. See the raise test below.
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 0',
    // A SKIP with no LIMIT is not a top-k: with no cap the general path projects every row.
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c SKIP 1',
    // A parameterized window cannot be resolved where the route is chosen.
    'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT $n',
  ] as const;

  for (const q of REFUSED) {
    it(`still declines ${q}`, () => {
      expect(routes(q)).toEqual([]);
    });
  }
});

/**
 * Three starts and nine far vertices that ALL TIE on the sort key, wired so that the far-driven
 * walk's arrival order differs from the start-driven one: `s0 -> f0,f3,f6`, `s1 -> f1,f4,f7`,
 * `s2 -> f2,f5,f8`. Start-driven gives 51,54,57,52,…; far-driven would give 51,52,53,….
 *
 * It exists because mutation found `startDriven: true` UNTESTED — the main fixture's ties did not
 * discriminate between the two walk orders, so a mutant setting it false survived.
 */
const ties = (): Graph => {
  const g = new Graph();
  const starts = [0, 1, 2].map((i) =>
    g.addVertex({ id: `s${i}`, labels: ['P'], properties: { k: i, key: 100 } }),
  );
  const fars = Array.from({ length: 9 }, (_, i) =>
    g.addVertex({ id: `f${i}`, labels: ['P'], properties: { k: 50 + i, key: 7 } }),
  );
  let e = 0;

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      g.addEdge({
        id: `e${e++}`,
        labels: ['E'],
        from: starts[i],
        to: fars[i + j * 3],
        properties: { w: j },
      });
    }
  }

  return g;
};

describe('the deferred arm keeps the START-DRIVEN order, so ties match native', () => {
  it('every row ties, so the answer IS the arrival order', () => {
    // The far-driven walk REORDERS rows deliberately and `Array.prototype.sort` is stable, so a
    // deferred plan that allowed it would return 51,52,53,… here. Tie order is observable between
    // the engines (item 605) and native gives the start-driven order.
    expect(
      query(ties(), 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY b.key LIMIT 9'),
    ).toEqual([51, 54, 57, 52, 55, 58, 53, 56, 59].map((c) => ({ c })));
  });

  it('and with the start projected alongside', () => {
    expect(
      query(ties(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k + 1 AS c ORDER BY b.key LIMIT 9'),
    ).toEqual([
      { x: 0, c: 51 },
      { x: 0, c: 54 },
      { x: 0, c: 57 },
      { x: 1, c: 52 },
      { x: 1, c: 55 },
      { x: 1, c: 58 },
      { x: 2, c: 53 },
      { x: 2, c: 56 },
      { x: 2, c: 59 },
    ]);
  });
});

describe('a key that reads an OUTPUT column goes to the general path', () => {
  // `d`'s expression reads `b`, which is also an output NAME, so `aliasDefinition` refuses to
  // substitute it and `orderNeedsOutput` is set: in the sort scope that `b` means the COLUMN. The
  // deferred arm's compiled key closures read the INPUT binding alone, so it must decline — and
  // both engines agree on the general path's answer.
  it('the shadowed alias as the key', () => {
    expect(
      query(ties(), 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS b, b.k + 1 AS d ORDER BY d LIMIT 3'),
    ).toEqual([
      { b: 50, d: 51 },
      { b: 51, d: 52 },
      { b: 52, d: 53 },
    ]);
  });

  it('the shadowing name itself as the key', () => {
    expect(
      query(ties(), 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS b, b.k + 1 AS d ORDER BY b LIMIT 3'),
    ).toEqual([
      { b: 50, d: 51 },
      { b: 51, d: 52 },
      { b: 52, d: 53 },
    ]);
  });
});

describe('a deferred hop projection is evaluated for emitted rows only', () => {
  it('does not fault on a discarded row', () => {
    // `bad` (k=9) sorts last ascending, so `LIMIT 2` never reaches its CAST.
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c, CAST(b.s AS INTEGER) AS d ORDER BY c LIMIT 2',
      ),
    ).toEqual([
      { c: -2, d: 8 },
      { c: 1, d: 1 },
    ]);
  });

  it('faults when the window INCLUDES the faulting row', () => {
    expect(() =>
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c, CAST(b.s AS INTEGER) AS d ORDER BY c DESC LIMIT 2',
      ),
    ).toThrow();
  });

  it('faults with no window at all', () => {
    expect(() =>
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c, CAST(b.s AS INTEGER) AS d ORDER BY c',
      ),
    ).toThrow();
  });

  it('faults on a SKIP with no LIMIT, though the window discards the faulting row', () => {
    expect(() =>
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c, CAST(b.s AS INTEGER) AS d ORDER BY c SKIP 1',
      ),
    ).toThrow();
  });

  it('a faulting SORT KEY still raises', () => {
    expect(() =>
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS c ORDER BY CAST(b.s AS INTEGER) LIMIT 2',
      ),
    ).toThrow();
  });

  it('LIMIT 0 returns no rows WITHOUT evaluating a faulting key', () => {
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN CAST(b.s AS INTEGER) AS c ORDER BY c LIMIT 0',
      ),
    ).toEqual([]);
  });
});

describe('the deferred hop arm answers what the plain spelling answers', () => {
  it('the directed hop, both key spellings', () => {
    const g = fixture();
    const alias = query(g, 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 3');

    expect(alias).toEqual([{ c: -1 }, { c: 2 }, { c: 2 }]);
    expect(
      query(g, 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY b.k + 1 LIMIT 3'),
    ).toEqual(alias);
  });

  it('a clause WHERE gates before the ranking', () => {
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) WHERE b.k > 0 RETURN b.k + 1 AS c ORDER BY c LIMIT 3',
      ),
    ).toEqual([{ c: 2 }, { c: 2 }, { c: 3 }]);
  });

  it('the UNDIRECTED hop', () => {
    expect(
      query(fixture(), 'MATCH (a:P)-[:E]-(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 4'),
    ).toEqual([{ c: -1 }, { c: 2 }, { c: 2 }, { c: 2 }]);
  });

  it('an inline start property seeds, then ranks', () => {
    expect(
      query(fixture(), "MATCH (a:P {t: 'a'})-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 3"),
    ).toEqual([{ c: 2 }, { c: 3 }, { c: 5 }]);
  });

  it('the REL-BOUND walk, projecting an edge property', () => {
    expect(
      query(fixture(), 'MATCH (a:P)-[e:E]->(b:P) RETURN e.w + 1 AS c ORDER BY c LIMIT 3'),
    ).toEqual([{ c: 2 }, { c: 3 }, { c: 4 }]);
  });

  it('BOTH endpoints read, with the key on the start', () => {
    // The key row carries two elements here, not one, and the tie order is the walk's arrival
    // order — which native agrees with exactly.
    expect(
      query(fixture(), 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS x, b.k + 1 AS c ORDER BY x LIMIT 3'),
    ).toEqual([
      { x: 1, c: 2 },
      { x: 1, c: -1 },
      { x: 2, c: 10 },
    ]);
  });

  it('all three of start, rel and far, on a two-key sort', () => {
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[e:E]->(b:P) RETURN a.k AS x, e.w AS w, b.k + 1 AS c ORDER BY c, x LIMIT 4',
      ),
    ).toEqual([
      { x: 1, w: 2, c: -1 },
      { x: 1, w: 3, c: 2 },
      { x: 3, w: 5, c: 2 },
      { x: 3, w: 1, c: 3 },
    ]);
  });

  it('DESC with a SKIP', () => {
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c DESC SKIP 1 LIMIT 3',
      ),
    ).toEqual([{ c: 5 }, { c: 4 }, { c: 3 }]);
  });

  it('a key absent from every row, with a second key breaking the ties', () => {
    expect(
      query(
        fixture(),
        'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY b.missing, b.k LIMIT 3',
      ),
    ).toEqual([{ c: -1 }, { c: 2 }, { c: 2 }]);
  });

  it('a window past the end returns every row, sorted', () => {
    expect(
      query(fixture(), 'MATCH (a:P)-[:E]->(b:P) RETURN b.k + 1 AS c ORDER BY c LIMIT 99'),
    ).toEqual([{ c: -1 }, { c: 2 }, { c: 2 }, { c: 3 }, { c: 4 }, { c: 5 }, { c: 10 }]);
  });
});
