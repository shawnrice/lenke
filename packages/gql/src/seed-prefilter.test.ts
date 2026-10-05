import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A hop whose clause `WHERE` constrains only the start variable now skips the seeds that
// predicate rejects, instead of expanding every start vertex and filtering the rows
// (audit item 154). 5-6x on a selective predicate.
//
// The whole design turns on ONE fact: a clause `WHERE` and an inline predicate are NOT
// equivalent on a hop. The clause form is evaluated once per ROW, so not at all for a start
// vertex with no edges; the inline form is evaluated once per VERTEX. Both engines agree —
//
//   MATCH (u:U)-[:E]->(v) WHERE CAST(u.st AS INTEGER) >= 1      rows, no fault
//   MATCH (u:U WHERE CAST(u.st AS INTEGER) >= 1)-[:E]->(v)      RAISES
//
// — so the filter SWALLOWS a fault and keeps the seed, leaving the clause `WHERE` as the
// authority on both rows and faults. These tests pin that, in both directions.
const hopGraph = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 2, j: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 5, j: 1 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 2, j: 1 } });
  const d = g.addVertex({ id: 'd', labels: ['P'], properties: { k: 9, j: 1 } });

  g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ from: a, to: c, labels: ['E'], properties: {} });
  g.addEdge({ from: b, to: d, labels: ['E'], properties: {} });
  g.addEdge({ from: c, to: d, labels: ['E'], properties: {} });

  return g;
};

describe('a start-only clause WHERE selects the same rows', () => {
  const sorted = (rows: readonly Record<string, unknown>[]) =>
    [...rows].map((r) => JSON.stringify(r)).sort();

  test('a selective predicate', () => {
    // a and c have k = 2; a has two out-edges, c has one. Three rows.
    expect(
      sorted(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k = 2 RETURN q.k AS n')),
    ).toEqual(sorted([{ n: 5 }, { n: 2 }, { n: 9 }]));
  });

  test('a predicate matching NOTHING yields no rows', () => {
    expect(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k = 77 RETURN q.k AS n')).toEqual([]);
  });

  test('a predicate matching EVERYTHING yields every row', () => {
    // The give-up path's shape: the filter rejects nothing, and must not drop anything.
    expect(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.j = 1 RETURN q.k AS n')).toHaveLength(
      4,
    );
  });

  test('a range predicate', () => {
    expect(
      sorted(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k < 5 RETURN q.k AS n')),
    ).toEqual(sorted([{ n: 5 }, { n: 2 }, { n: 9 }]));
  });

  test('a conjunction, both conjuncts on the start', () => {
    expect(
      sorted(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k = 2 AND p.j = 1 RETURN q.k AS n')),
    ).toEqual(sorted([{ n: 5 }, { n: 2 }, { n: 9 }]));
  });

  test('a disjunction on the start', () => {
    expect(
      query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k = 5 OR p.k = 9 RETURN q.k AS n'),
    ).toEqual([{ n: 9 }]);
  });

  test('it agrees with the inline spelling on rows', () => {
    // Not on faults — see the next describe — but the ROWS of the two spellings must match,
    // which is the claim that makes skipping a seed sound.
    expect(
      sorted(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE p.k = 2 RETURN q.k AS n')),
    ).toEqual(sorted(query(hopGraph(), 'MATCH (p:P {k: 2})-[:E]->(q) RETURN q.k AS n')));
  });

  test('a var-length hop too', () => {
    const rows = query(hopGraph(), 'MATCH (p:P)-[:E]->{1,2}(q) WHERE p.k = 2 RETURN q.k AS n');
    const inline = query(hopGraph(), 'MATCH (p:P {k: 2})-[:E]->{1,2}(q) RETURN q.k AS n');

    expect(rows.length).toBeGreaterThan(0);
    expect(sorted(rows)).toEqual(sorted(inline));
  });
});

describe('a fault keeps the seed, so faults are unchanged', () => {
  // `z` has NO EDGES and a non-numeric `st`, so `CAST(z.st AS INTEGER)` faults on it. A clause
  // WHERE never evaluates it (no rows); the filter does, and must swallow it.
  const faulting = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { st: '1' } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { st: '2' } });

    g.addVertex({ id: 'z', labels: ['P'], properties: { st: 'zzz' } });
    g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });

    return g;
  };

  test('an EDGELESS faulting vertex does not raise', () => {
    // The behaviour being preserved. If the filter let the fault through, this would throw —
    // and it would throw where the native engine does not.
    expect(
      query(faulting(), 'MATCH (p:P)-[:E]->(q) WHERE CAST(p.st AS INTEGER) >= 1 RETURN q.st AS n'),
    ).toEqual([{ n: '2' }]);
  });

  test('the INLINE spelling of the same predicate DOES raise', () => {
    // Proof the two spellings differ, which is why the predicate cannot simply be moved into
    // the node the way `pushWhereIntoNode` does for a segment-free pattern. If this ever stops
    // raising, the swallowing is no longer needed and this file should be revisited.
    expect(() =>
      query(faulting(), 'MATCH (p:P WHERE CAST(p.st AS INTEGER) >= 1)-[:E]->(q) RETURN q.st AS n'),
    ).toThrow();
  });

  test('a faulting vertex WITH edges still raises', () => {
    // The other direction (item 145): swallowing must not suppress a fault the clause WHERE
    // would have raised. Here the faulting vertex has an out-edge, so there IS a row to
    // evaluate the clause WHERE on.
    const g = new Graph();
    const bad = g.addVertex({ id: 'bad', labels: ['P'], properties: { st: 'zzz' } });
    const t = g.addVertex({ id: 't', labels: ['P'], properties: { st: '2' } });

    g.addEdge({ from: bad, to: t, labels: ['E'], properties: {} });

    expect(() =>
      query(g, 'MATCH (p:P)-[:E]->(q) WHERE CAST(p.st AS INTEGER) >= 1 RETURN q.st AS n'),
    ).toThrow();
  });
});

describe('the filter is only lifted where it is sound', () => {
  test('OPTIONAL MATCH answers correctly (its exclusion is conservatism, not a fix)', () => {
    // `seedPrefilter` excludes OPTIONAL, and mutation shows that exclusion is NOT load-bearing:
    // removing it leaves this file AND the whole gql suite green. The reason is that
    // `optionalMatch` decides on the null row by whether any row survived the clause `WHERE`,
    // and a seed the filter rejects would have produced only rows that `WHERE` dropped — so
    // the decision is unchanged.
    //
    // It stays excluded anyway, and this comment says why rather than implying a correctness
    // argument it does not have: extending the optimization to OPTIONAL is a real win left on
    // the table (an OPTIONAL hop is 17.7x behind native), but it is a different contract — the
    // row-versus-null-row decision — and deserves its own measurement and tests instead of
    // arriving as a side effect of this one.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 2 } });

    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 9 } });
    g.addEdge({ from: a, to: a, labels: ['E'], properties: {} });

    const rows = query(g, 'OPTIONAL MATCH (p:P)-[:E]->(q) WHERE p.k = 2 RETURN q.k AS n');

    expect(rows).toEqual([{ n: 2 }]);
  });

  test('a predicate reading the FAR end is not lifted, and still filters', () => {
    expect(query(hopGraph(), 'MATCH (p:P)-[:E]->(q) WHERE q.k = 9 RETURN q.k AS n')).toHaveLength(
      2,
    );
  });

  test('a predicate reading BOTH ends is not lifted, and still filters', () => {
    const rows = query(
      hopGraph(),
      'MATCH (p:P)-[:E]->(q) WHERE p.k = 2 AND q.k = 9 RETURN q.k AS n',
    );

    expect(rows).toEqual([{ n: 9 }]);
  });

  test('a LABELLED far endpoint flips which end seeds, and the filter stands aside', () => {
    // `orient` seeds a fixed-length pattern from the more selective end, so a labelled far
    // endpoint can make the walk start from `q` — at which point the filter, lifted for `p`,
    // is being offered the WRONG variable's binding and must not apply. It carries its
    // variable name for exactly this.
    //
    // Found by mutation: dropping that guard leaves this file green but breaks two tests
    // elsewhere ("a start-only predicate with a labelled far endpoint still filters the far
    // end", "the far LABEL is applied"), so the case is pinned locally too.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 2 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 9 } });
    const t1 = g.addVertex({ id: 't1', labels: ['P', 'Q'], properties: { k: 1 } });
    const t2 = g.addVertex({ id: 't2', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ from: a, to: t1, labels: ['E'], properties: {} });
    g.addEdge({ from: a, to: t2, labels: ['E'], properties: {} });
    g.addEdge({ from: b, to: t1, labels: ['E'], properties: {} });

    // Only `a` has k = 2, and only `t1` carries `:Q`, so exactly one row survives both.
    expect(query(g, 'MATCH (p:P)-[:E]->(q:Q) WHERE p.k = 2 RETURN q.k AS n')).toEqual([{ n: 1 }]);
  });

  test('a predicate reading an OUTER variable is not lifted, and still filters', () => {
    const rows = query(
      hopGraph(),
      'MATCH (z:P {k: 9}) MATCH (p:P)-[:E]->(q) WHERE p.k = 2 AND z.k = 9 RETURN q.k AS n',
    );

    expect(rows).toHaveLength(3);
  });
});

describe('the give-up after a run of non-rejections changes no answer', () => {
  // The filter stops evaluating once it has rejected nothing in its first 512 seeds, because a
  // predicate that rejects nothing is pure overhead (measured 6-8% before the give-up existed).
  //
  // The arrangement that matters: the first 600 vertices all PASS, and the ones after them all
  // FAIL. So the filter gives up before it would ever have rejected anything — and the later
  // vertices sail past the gate. The clause WHERE still drops them, which is exactly the claim
  // being tested, and a fixture smaller than 512 vertices cannot test it at all.
  const staggered = (): Graph => {
    const g = new Graph();
    const sink = g.addVertex({ id: 'sink', labels: ['S'], properties: {} });

    for (let i = 0; i < 900; i++) {
      const v = g.addVertex({
        id: `u${i}`,
        labels: ['P'],
        // PASS for the first 600, FAIL after.
        properties: { ok: i < 600 ? 1 : 0 },
      });

      g.addEdge({ from: v, to: sink, labels: ['E'], properties: {} });
    }

    return g;
  };

  test('only the passing vertices contribute rows', () => {
    expect(query(staggered(), 'MATCH (p:P)-[:E]->(q) WHERE p.ok = 1 RETURN count(*) AS c')).toEqual(
      [{ c: 600 }],
    );
  });

  test('and the reverse stagger — failing first — also answers correctly', () => {
    // Here the filter rejects immediately, so it never gives up and stays active for the whole
    // scan. The same answer either way is the point.
    const g = new Graph();
    const sink = g.addVertex({ id: 'sink', labels: ['S'], properties: {} });

    for (let i = 0; i < 900; i++) {
      const v = g.addVertex({
        id: `u${i}`,
        labels: ['P'],
        properties: { ok: i < 600 ? 0 : 1 },
      });

      g.addEdge({ from: v, to: sink, labels: ['E'], properties: {} });
    }

    expect(query(g, 'MATCH (p:P)-[:E]->(q) WHERE p.ok = 1 RETURN count(*) AS c')).toEqual([
      { c: 300 },
    ]);
  });
});
