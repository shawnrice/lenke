/**
 * Item 1067: the bare degree sum — `MATCH (a:L)-[:T]->(b) RETURN count(*)` answered by summing
 * adjacency bucket SIZES, with none of the general walk's per-vertex call overhead.
 *
 * WHAT GIVES THESE TESTS TEETH, and how the fixture got there. The first version of this file
 * passed 19/19 while SEVEN of eight mutants survived, because its fixture could not tell the
 * guards apart: every edge had `w: 1` (so a rel constraint was answer-equivalent to ignoring it),
 * the only constant predicate tried was `WHERE true` (item 570's control — answer-equivalent by
 * design), and the multi-type edge made the alternation's correct answer equal the naive sum. The
 * shapes below are the discriminators mutation asked for:
 *
 *   - `WHERE 1 = 0` — a predicate with NO free variables, so it reaches the fast path's own
 *     `pred.fn !== alwaysTrue` guard rather than being refused upstream for reading the start, and
 *     unlike `WHERE true` it changes the answer.
 *   - `[:E|F]` on a fixture with NO multi-type edge, where the caller admits many types and only
 *     the fast path's `types.length === 1` refuses.
 *   - `-[:E {w: 2}]->` over edges whose `w` VARIES.
 *   - `(a:P&S)`, a label EXPRESSION no vertex satisfies: `candidateVertexSource` hands back every
 *     vertex for one of those, so admitting it would count the whole graph instead of none.
 *
 * Every number here was read off BOTH engines on these two fixtures (46 arms, all agreeing) — three
 * of my hand-derived counts in the first version were wrong and the engines were right.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * Six `P` vertices and three `S` vertices, with edges leaving BOTH kinds — the `S` ones are what
 * make `:P` non-vacuous AND make the label load-bearing, since they have out-edges a walk that
 * forgot the label would count.
 *
 * `multi` decides whether `f1` carries two types, which is the per-type summing hazard.
 */
const fixture = (multi: boolean): Graph => {
  const g = new Graph();
  const p = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `p${i}`, labels: ['P'], properties: { k: i } }),
  );
  const s = Array.from({ length: 3 }, (_, i) =>
    g.addVertex({ id: `s${i}`, labels: ['S'], properties: { k: 100 + i } }),
  );
  // `w` ALTERNATES, so a rel inline constraint is not answer-equivalent to ignoring it.
  const E = (id: string, from: unknown, to: unknown, labels: string[], w: number): void => {
    g.addEdge({ id, labels, from: from as never, to: to as never, properties: { w } });
  };

  E('e0', p[0], p[1], ['E'], 1);
  E('e1', p[0], p[2], ['E'], 2);
  E('e2', p[1], p[3], ['E'], 1);
  E('e3', p[2], s[0], ['E'], 2);
  E('e4', p[3], s[1], ['E'], 1);
  E('e5', s[0], p[4], ['E'], 2);
  E('e6', s[0], p[5], ['E'], 1);
  E('e7', s[1], p[0], ['E'], 2);
  E('e8', s[2], p[1], ['E'], 1);
  E('e9', s[2], s[0], ['E'], 2);
  E('f0', p[4], p[5], ['F'], 1);
  E('f1', p[5], p[0], multi ? ['E', 'F'] : ['F'], 2);

  return g;
};

describe('the bare degree sum counts what the general walk counts', () => {
  // Both fixtures, because the multi-type edge changes several of these counts and a route that
  // confused the two would be visible in exactly one of the columns.
  const CASES: ReadonlyArray<readonly [string, number, number]> = [
    // query, answer with the multi-type edge, answer without
    ['MATCH (a:P)-[:E]->(b) RETURN count(*) AS c', 6, 5],
    ['MATCH (a)-[:E]->(b:P) RETURN count(*) AS c', 8, 7],
    ['MATCH (a:P)<-[:E]-(b) RETURN count(*) AS c', 8, 7],
    ['MATCH (a)<-[:E]-(b:P) RETURN count(*) AS c', 6, 5],
    ['MATCH (a:S)-[:E]->(b) RETURN count(*) AS c', 5, 5],
    ['MATCH (a)-[:E]->(b:S) RETURN count(*) AS c', 3, 3],
    ['MATCH (a)-[:E]->(b) RETURN count(*) AS c', 11, 10],
    ['MATCH (a:Z)-[:E]->(b) RETURN count(*) AS c', 0, 0],
    ['MATCH (a:P)-[:F]->(b) RETURN count(*) AS c', 2, 2],
    ['MATCH (a)-[:F]->(b:P) RETURN count(*) AS c', 2, 2],
  ];

  for (const [q, withMulti, without] of CASES) {
    it(`${q} === ${withMulti} / ${without}`, () => {
      expect(query(fixture(true), q)).toEqual([{ c: withMulti }]);
      expect(query(fixture(false), q)).toEqual([{ c: without }]);
    });
  }

  it('agrees with the general path under a vacuous WHERE', () => {
    // `WHERE true` forces a real predicate, so the fast path declines and the two routes must
    // agree — item 570's control for exactly this question.
    for (const multi of [true, false]) {
      const g = fixture(multi);

      expect(query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toEqual(
        query(g, 'MATCH (a:P)-[:E]->(b) WHERE true RETURN count(*) AS c'),
      );
      expect(query(g, 'MATCH (a)-[:E]->(b:P) RETURN count(*) AS c')).toEqual(
        query(g, 'MATCH (a)-[:E]->(b:P) WHERE true RETURN count(*) AS c'),
      );
    }
  });
});

describe('the discriminators — each is a guard no other condition masks', () => {
  it('a CONSTANT predicate is applied, not skipped', () => {
    // `WHERE 1 = 0` reads no variable, so `pred.startVar` is unset and the shape reaches the fast
    // path's own predicate guard. Unlike `WHERE true` it changes the answer, so ignoring it is
    // visible: 0 against 6.
    expect(query(fixture(true), 'MATCH (a:P)-[:E]->(b) WHERE 1 = 0 RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
    expect(query(fixture(true), 'MATCH (a)-[:E]->(b:P) WHERE 1 = 0 RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
  });

  it('TWO types are summed without dropping one, even with no multi-type edge', () => {
    // With no edge in both buckets the CALLER admits many types, so only the fast path's
    // single-type guard refuses. Summing just `E` would answer 10; the right answer is 12.
    expect(query(fixture(false), 'MATCH (a)-[:E|F]->(b) RETURN count(*) AS c')).toEqual([
      { c: 12 },
    ]);
    expect(query(fixture(false), 'MATCH (a:P)-[:E|F]->(b) RETURN count(*) AS c')).toEqual([
      { c: 7 },
    ]);
  });

  it('and with one, where double-counting is the hazard instead', () => {
    // `f1` is in both buckets: 11 + 2 = 13 naively, against the 12 distinct edges.
    expect(query(fixture(true), 'MATCH (a)-[:E|F]->(b) RETURN count(*) AS c')).toEqual([{ c: 12 }]);
  });

  it('a rel INLINE constraint is applied, over edges whose `w` varies', () => {
    expect(query(fixture(true), 'MATCH (a:P)-[:E {w: 1}]->(b) RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
    expect(query(fixture(true), 'MATCH (a:P)-[:E {w: 2}]->(b) RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
    expect(query(fixture(false), 'MATCH (a:P)-[:E {w: 2}]->(b) RETURN count(*) AS c')).toEqual([
      { c: 2 },
    ]);
  });

  it('a label EXPRESSION is not treated as a plain label', () => {
    // `candidateVertexSource` returns EVERY vertex for a non-plain label expression, so a fast
    // path that admitted one would sum the whole graph's degree. `:P&S` is satisfied by nothing,
    // which makes the difference maximal: 0 against 11.
    expect(query(fixture(true), 'MATCH (a:P&S)-[:E]->(b) RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
    // The union is satisfied by everything, and must equal the unlabelled count.
    expect(query(fixture(true), 'MATCH (a:P|S)-[:E]->(b) RETURN count(*) AS c')).toEqual([
      { c: 11 },
    ]);
    expect(query(fixture(true), 'MATCH (a)-[:E]->(b:P|S) RETURN count(*) AS c')).toEqual([
      { c: 11 },
    ]);
  });

  it('an INLINE endpoint constraint is applied', () => {
    expect(query(fixture(true), 'MATCH (a:P {k: 0})-[:E]->(b) RETURN count(*) AS c')).toEqual([
      { c: 2 },
    ]);
  });

  it('a clause WHERE on the start is applied', () => {
    expect(
      query(fixture(true), 'MATCH (a:P)-[:E]->(b) WHERE a.k > 1 RETURN count(*) AS c'),
    ).toEqual([{ c: 3 }]);
  });

  it('BOTH ends labelled keeps the per-edge tally', () => {
    // Summing out-degrees counts edges to ANY target, so neither walk fits.
    expect(query(fixture(true), 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toEqual([
      { c: 4 },
    ]);
    expect(query(fixture(false), 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
  });
});

describe('an INDEX SEEK hands back a superset, so the fast path refuses', () => {
  const indexed = (): Graph => {
    const g = fixture(true);

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    return g;
  };

  it('a seeking count answers what the unindexed graph answers', () => {
    const q = 'MATCH (a:P)-[:E]->(b) WHERE a.k = 0 RETURN count(*) AS c';

    expect(query(indexed(), q)).toEqual([{ c: 2 }]);
    expect(query(indexed(), q)).toEqual(query(fixture(true), q));
  });

  it('a seek whose key matches a vertex of ANOTHER label does not leak it', () => {
    // `k: 100` is an `S` vertex, so the seeded candidate set for `(a:P … a.k = 100)` contains a
    // vertex that fails the label.
    expect(query(indexed(), 'MATCH (a:P)-[:E]->(b) WHERE a.k = 100 RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
    expect(query(indexed(), 'MATCH (a:S)-[:E]->(b) WHERE a.k = 100 RETURN count(*) AS c')).toEqual([
      { c: 2 },
    ]);
  });
});
