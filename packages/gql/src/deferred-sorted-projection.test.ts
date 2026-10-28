/**
 * Item 1062: `detectNodeProjection`'s DEFERRED arm — a windowed sort whose projection could fault.
 *
 * The rung used to refuse these outright (`outputColumnSorts`'s fault rule) because it projected
 * every row and sliced, which would raise on a row the query never emits. The deferred arm ranks
 * on the sort keys and projects only the `cap` survivors, which is what the general path and
 * native both do.
 *
 * WHAT MAKES THESE TESTS HAVE TEETH. The route choice is NOT answer-equivalent here — that is the
 * whole point, and it is what the fault assertions below pin. The two directions are separate
 * failures with opposite fixes:
 *
 *   - projecting too EAGERLY raises where the query does not (`faulting non-key item` below), and
 *   - refusing the arm is only slow, which is why the ROUTE is asserted as well as the answer.
 *
 * Every expected value here was confirmed against the NATIVE engine before being written down,
 * including the tie orders and the `SKIP` case; byte-identity is the invariant and a test that
 * only agrees with itself cannot see a divergence.
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
 * Eight `P` vertices. `k` is the sort key and is DISTINCT except for one tie pair, so tie order is
 * exercised rather than assumed; `s` casts to a number for every vertex but two, and those two sit
 * at the EXTREMES of `k` so a window can include or exclude them by choosing its direction.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 4; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: 10 + i, s: `${i}`, t: i % 2 === 0 ? 'a' : 'b' },
    });
  }

  g.addVertex({ id: 'tie1', labels: ['P'], properties: { k: 10, s: '91', t: 'a' } });
  g.addVertex({ id: 'tie2', labels: ['P'], properties: { k: 10, s: '92', t: 'b' } });
  // The two that cannot be CAST, at each end of `k`.
  g.addVertex({ id: 'low', labels: ['P'], properties: { k: -1, s: 'nope', t: 'a' } });
  g.addVertex({ id: 'high', labels: ['P'], properties: { k: 99, s: 'nope', t: 'b' } });

  return g;
};

describe('the deferred arm claims the shapes the fault rule used to refuse', () => {
  const CLAIMED = [
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 3',
    'MATCH (n:P) RETURN upper(n.s) AS c ORDER BY c LIMIT 3',
    'MATCH (n:P) RETURN n.k AS c, n.k + 1 AS d ORDER BY c LIMIT 3',
    'MATCH (n:P) RETURN n.k AS c, CAST(n.s AS INTEGER) AS d ORDER BY c DESC SKIP 1 LIMIT 2',
    // The EXPRESSION spelling of the alias above. Ranking on compiled keys rather than on output
    // columns is what makes these two cost the same; `bun run spelling` measured the first cut of
    // this arm 3.8x apart on exactly this pair.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.k + 1 LIMIT 3',
    // A key that is not projected AT ALL. The general path takes it the same way — the key reads
    // the input binding, so its top-k is over input bindings — and this arm compiles the key, so
    // there is no output column for it to need.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.t LIMIT 3',
  ] as const;

  for (const q of CLAIMED) {
    it(`routes ${q}`, () => {
      expect(routes(q)).toEqual(['nodeProjection']);
    });
  }

  // The guards that still decline, each for the reason `outputColumnSorts` states. Asserting the
  // ROUTE and not only the answer is deliberate: every one of these is answer-equivalent to the
  // arm admitting it (`LIMIT 0` excepted), so the answer alone cannot see a loosened guard.
  const REFUSED = [
    // A window with no sort: the general path is lazy and a materializing rung scans everything.
    'MATCH (n:P) RETURN n.k + 1 AS c LIMIT 3',
    // `LIMIT 0` — and here the refusal is CORRECTNESS, not speed. See the raise test below.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 0',
    // A PARAMETERIZED window cannot be resolved at compile time, where the route is chosen.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT $n',
    // A SKIP WITH NO LIMIT. There is no `cap` to rank against, so the general path sorts and
    // projects EVERY row before dropping the skipped ones — and so does native. Deferring would
    // answer rows where the query raises; `page-fold-fault.test.ts`'s own control caught the first
    // cut of this arm admitting it.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c SKIP 1',
    'MATCH (n:P) RETURN n.k AS c, n.k + 1 AS d ORDER BY c OFFSET 1',
    // An alias that SHADOWS the scan's own variable. In the sort scope the output columns are
    // overlaid on the binding, so the `n` inside `n.k + 1` would resolve to the COLUMN — a number
    // — and mean something else. `aliasDefinition` declines for the same reason, and native
    // agrees with the general path's answer.
    'MATCH (n:P) RETURN n.k AS n, n.k + 1 AS d ORDER BY d LIMIT 2',
    // An AGGREGATE key is defined over a group, not a row.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY count(*) LIMIT 2',
    // A SUBQUERY key, in both spellings — written out and named through an alias.
    // `freePredicateVars` returns the EMPTY set for a subquery (it does not descend), so the
    // free-variable test below it passes vacuously and cannot be the thing that refuses this;
    // `itemLocal` admits a subquery too. Mutation found that guard untested before this case
    // existed, which is the only reason it is here rather than assumed.
    'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY COUNT { MATCH (n)-[:E]->(m) } LIMIT 2',
    'MATCH (n:P) RETURN COUNT { MATCH (n)-[:E]->(m) } AS c ORDER BY c LIMIT 2',
  ] as const;

  for (const q of REFUSED) {
    it(`still declines ${q}`, () => {
      expect(routes(q)).toEqual([]);
    });
  }
});

describe('a subquery sort key goes to the general path, and answers what native answers', () => {
  /** Three `P` vertices with out-degrees 2, 1 and 0, so a correlated COUNT orders them. */
  const linked = (): Graph => {
    const g = new Graph();

    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 3 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ id: 'e1', labels: ['E'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'e2', labels: ['E'], from: a, to: c, properties: {} });
    g.addEdge({ id: 'e3', labels: ['E'], from: b, to: c, properties: {} });

    return g;
  };

  it('ascending by the correlated count', () => {
    expect(
      query(
        linked(),
        'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY COUNT { MATCH (n)-[:E]->(m) } LIMIT 2',
      ),
    ).toEqual([{ c: 2 }, { c: 3 }]);
  });

  it('descending by the correlated count', () => {
    expect(
      query(
        linked(),
        'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY COUNT { MATCH (n)-[:E]->(m) } DESC LIMIT 2',
      ),
    ).toEqual([{ c: 4 }, { c: 3 }]);
  });
});

describe('a deferred projection is evaluated for emitted rows only', () => {
  it('does not fault on a discarded row', () => {
    // `high` (k=99) sorts last and its `s` cannot be cast. Ascending with a window that excludes
    // it, the query returns rows; the same projection WITHOUT a window raises. Both engines.
    expect(
      query(
        fixture(),
        'MATCH (n:P) RETURN n.k AS c, CAST(n.s AS INTEGER) AS d ORDER BY c DESC SKIP 1 LIMIT 2',
      ),
    ).toEqual([
      { c: 13, d: 3 },
      { c: 12, d: 2 },
    ]);
  });

  it('faults when the same projection has no window', () => {
    expect(() =>
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, CAST(n.s AS INTEGER) AS d ORDER BY c'),
    ).toThrow();
  });

  it('faults when the window INCLUDES the faulting row', () => {
    // Ascending, `low` (k=-1) is first, so the two emitted rows include it and the CAST raises.
    expect(() =>
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, CAST(n.s AS INTEGER) AS d ORDER BY c LIMIT 2'),
    ).toThrow();
  });

  it('a faulting SORT KEY still raises, window or not', () => {
    // The general path evaluates every sort key per row — `aliasDefinition` substitutes the alias
    // precisely so it can — so this raise is the behaviour and not a divergence.
    expect(() =>
      query(fixture(), 'MATCH (n:P) RETURN CAST(n.s AS INTEGER) AS c ORDER BY c LIMIT 2'),
    ).toThrow();
  });

  it('a SKIP with no LIMIT raises even though the window discards the faulting row', () => {
    // Ascending, `low` (k=-1) is first and `SKIP 1` drops it — and the query still raises, on both
    // engines, because with no `limit` there is no top-k and every row is projected.
    expect(() =>
      query(fixture(), 'MATCH (n:P) RETURN n.k AS c, CAST(n.s AS INTEGER) AS d ORDER BY c SKIP 1'),
    ).toThrow();
  });

  it('LIMIT 0 returns no rows WITHOUT evaluating a faulting key', () => {
    // This is why `limit === 0` must stay refused under deferral: ranking keys to emit nothing
    // would raise where `applyProjection` returns `[]` before projecting or ranking anything.
    expect(
      query(fixture(), 'MATCH (n:P) RETURN CAST(n.s AS INTEGER) AS c ORDER BY c LIMIT 0'),
    ).toEqual([]);
  });
});

describe('the deferred arm answers what the plain spelling answers', () => {
  it('a computed item under a window', () => {
    expect(query(fixture(), 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 3')).toEqual([
      { c: 0 },
      { c: 11 },
      { c: 11 },
    ]);
  });

  it('a plain key with a computed sibling keeps the plain spelling order', () => {
    const g = fixture();
    const computed = query(g, 'MATCH (n:P) RETURN n.k AS c, n.k + 1 AS d ORDER BY c LIMIT 4');
    const plain = query(g, 'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 4');

    expect(computed.map((r) => (r as { c: number }).c)).toEqual(
      plain.map((r) => (r as { c: number }).c),
    );
    expect(computed).toEqual([
      { c: -1, d: 0 },
      { c: 10, d: 11 },
      { c: 10, d: 11 },
      { c: 10, d: 11 },
    ]);
  });

  it('a MULTI-key sort, where ties on the first key are broken by the second', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.t AS g, n.k AS c, n.k + 1 AS d ORDER BY g, c LIMIT 3'),
    ).toEqual([
      { g: 'a', c: -1, d: 0 },
      { g: 'a', c: 10, d: 11 },
      { g: 'a', c: 10, d: 11 },
    ]);
  });

  it('a clause WHERE gates before the ranking', () => {
    expect(
      query(fixture(), 'MATCH (n:P) WHERE n.k > 0 RETURN n.k + 1 AS c ORDER BY c LIMIT 2'),
    ).toEqual([{ c: 11 }, { c: 11 }]);
  });

  it('an INLINE start property gates before the ranking', () => {
    expect(query(fixture(), "MATCH (n:P {t: 'b'}) RETURN n.k + 1 AS c ORDER BY c LIMIT 2")).toEqual(
      [{ c: 11 }, { c: 12 }],
    );
  });

  it('a window past the end returns everything, sorted', () => {
    expect(query(fixture(), 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 99')).toEqual([
      { c: 0 },
      { c: 11 },
      { c: 11 },
      { c: 11 },
      { c: 12 },
      { c: 13 },
      { c: 14 },
      { c: 100 },
    ]);
  });

  it('DESC and a SKIP past the end', () => {
    expect(
      query(fixture(), 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c DESC SKIP 99 LIMIT 2'),
    ).toEqual([]);
  });
});
