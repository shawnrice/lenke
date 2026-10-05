import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// With BOTH endpoints constrained, neither per-vertex walk can take the query: `startWalkFits`
// needs `inFar === undefined` and `farWalkFits` needs `inNear === undefined`, because a walk
// summing bucket SIZES cannot apply a constraint on an end it never visits. So it fell to
// `tallyHopCount`, which scanned every edge of the type and seeked nothing — the last unseeded
// route in the family items 149/176/177/178 worked through. Measured on 20,000 users, 40,000
// edges, `name` indexed (audit item 179):
//
//   (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) count(*)        1187.3us -> 32.5us
//   (u:User)-[:FOLLOWS]->(x:User) WHERE u.name=$n AND x.name=$m         2300.4us -> 38.8us
//   the same question as count(x.name), which the general path seeds        41.4us (unchanged)
//
// `tallyEdges` now draws the edges from the seeded end when one is narrow enough. Three things
// have to hold, and each has its own kind of assertion:
//
//   - the ANSWER is unchanged (every test compares the indexed graph against the unindexed one);
//   - the seeded source is DECLINED where a per-vertex bucket could double-count a multi-type
//     edge, and where the seek is not narrow enough to pay for the adjacency lookups;
//   - the NARROWER end is the one chosen — observable because seeding the start reads
//     `edgesFromByLabel` and seeding the far end reads `edgesToByLabel`.

/**
 * 200 users, so two indexed keys can BOTH clear the x8 margin while differing in width:
 * `name` matches 1-2, `g20` matches 10 (10x8=80 < 200, so it seeds), and `t` matches 100
 * (100x8=800 > 200, so it does not). A 10-vertex fixture could not separate "the narrower end
 * won" from "the wider end was refused by the margin".
 *
 * `x0` shares `name: 'user2'` and is NOT a `User`, with edges in both directions, so the label
 * check is exercised whichever end seeds.
 */
const ring = (indexed: boolean, multiType = false): Graph => {
  const g = new Graph();

  for (let i = 0; i < 200; i++) {
    g.addVertex({
      id: `u${i}`,
      labels: ['User'],
      properties: { name: `user${i}`, g20: i % 20, t: i % 2 },
    });
  }

  g.addVertex({ id: 'x0', labels: ['Other'], properties: { name: 'user2', g20: 2, t: 0 } });

  const v = (id: string) => g.getVertexById(id)!;

  for (let i = 0; i < 200; i++) {
    g.addEdge({
      id: `f${i}`,
      from: v(`u${i}`),
      to: v(`u${(i + 1) % 200}`),
      labels: multiType ? ['FOLLOWS', 'ALSO'] : ['FOLLOWS'],
      properties: {},
    });
  }

  g.addEdge({ id: 'loop', from: v('u3'), to: v('u3'), labels: ['FOLLOWS'], properties: {} });
  g.addEdge({ id: 'xout', from: v('x0'), to: v('u2'), labels: ['FOLLOWS'], properties: {} });
  g.addEdge({ id: 'xin', from: v('u5'), to: v('x0'), labels: ['FOLLOWS'], properties: {} });
  // From a `g20: 0` user into the single `Other`, so a start seek on `g20` has something to
  // count when the far label's bucket is tiny — see the asymmetric-buckets test.
  g.addEdge({ id: 'xin0', from: v('u0'), to: v('x0'), labels: ['FOLLOWS'], properties: {} });

  if (indexed) {
    for (const k of ['name', 'g20', 't']) {
      g.createIndex({ on: 'vertex', kind: 'hash', keys: [k] });
    }
  }

  return g;
};

/** Assert the answer, and that the seeding and scanning plans agree on it. */
const both = (
  q: string,
  params: Record<string, unknown>,
  expected: { c: number }[],
  multiType = false,
): void => {
  expect(query(ring(false, multiType), q, params)).toEqual(expected);
  expect(query(ring(true, multiType), q, params)).toEqual(expected);
};

/** Index lookups by side: which adjacency the tally drew its edges from, if either. */
const sides = (q: string, params: Record<string, unknown>, multiType = false): string => {
  const g = ring(true, multiType);
  const from = g.edgesFromByLabel as unknown as Map<string, unknown>;
  const to = g.edgesToByLabel as unknown as Map<string, unknown>;
  const realFrom = from.get.bind(from);
  const realTo = to.get.bind(to);
  let nf = 0;
  let nt = 0;

  from.get = (k: string) => {
    nf += 1;

    return realFrom(k);
  };
  to.get = (k: string) => {
    nt += 1;

    return realTo(k);
  };

  query(g, q, params);
  from.get = realFrom;
  to.get = realTo;

  if (nf > 0 && nt === 0) {
    return 'start';
  }

  if (nt > 0 && nf === 0) {
    return 'far';
  }

  return nf === 0 ? 'neither' : 'both';
};

describe('a both-ends-constrained count seeds its tally (item 179)', () => {
  test('the answer is unchanged, in every spelling', () => {
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c',
      { n: 'user0', m: 'user1' },
      [{ c: 1 }],
    );
    both(
      'MATCH (u:User)-[:FOLLOWS]->(x:User) WHERE u.name = $n AND x.name = $m RETURN count(*) AS c',
      { n: 'user0', m: 'user1' },
      [{ c: 1 }],
    );
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User) WHERE x.name = $m RETURN count(*) AS c',
      { n: 'user0', m: 'user1' },
      [{ c: 1 }],
    );
  });

  test('a seeked vertex of the wrong LABEL is rejected, at either end', () => {
    // `x0` is an `Other` carrying `name: 'user2'`, with an edge in each direction. u5 -> x0
    // exists, so demanding a `User` far end must count 0.
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c',
      { n: 'user5', m: 'user2' },
      [{ c: 0 }],
    );
    // And asked of the right label it counts 1.
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:Other {name: $m}) RETURN count(*) AS c',
      { n: 'user5', m: 'user2' },
      [{ c: 1 }],
    );
  });

  test('a SELF-LOOP is counted once, not twice', () => {
    // Both ends seek the same value, and `loop` is incident to u3 on both sides — a source that
    // unioned the two adjacencies would double it.
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $n}) RETURN count(*) AS c',
      { n: 'user3' },
      [{ c: 1 }],
    );
  });

  test('the IN direction seeds the mirror adjacency', () => {
    both(
      'MATCH (u:User {name: $n})<-[:FOLLOWS]-(x:User {name: $m}) RETURN count(*) AS c',
      { n: 'user1', m: 'user0' },
      [{ c: 1 }],
    );
  });

  test('no match counts 0', () => {
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c',
      { n: 'user0', m: 'user77' },
      [{ c: 1 - 1 }],
    );
  });

  // The multi-type contract. A per-vertex bucket holds one edge under EVERY label it carries, so
  // the seeded source is sound only for one concrete type or a graph with no multi-type edge.
  test('an UNTYPED rel over multi-label edges declines the seeded source', () => {
    // Every `f*` edge carries FOLLOWS and ALSO. An untyped hop means every bucket, so a seeded
    // per-vertex source would yield each of those edges twice.
    both(
      'MATCH (u:User {name: $n})-[]->(x:User {name: $m}) RETURN count(*) AS c',
      {
        n: 'user0',
        m: 'user1',
      },
      [{ c: 1 }],
      true,
    );
    expect(
      sides(
        'MATCH (u:User {name: $n})-[]->(x:User {name: $m}) RETURN count(*) AS c',
        { n: 'user0', m: 'user1' },
        true,
      ),
    ).toBe('neither');
  });

  test('ONE concrete type over multi-label edges still seeds', () => {
    // The same graph, but naming a single type: that bucket holds each edge once.
    both(
      'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c',
      { n: 'user0', m: 'user1' },
      [{ c: 1 }],
      true,
    );
    expect(
      sides(
        'MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c',
        { n: 'user0', m: 'user1' },
        true,
      ),
    ).not.toBe('neither');
  });

  // The choice. Seeding the start reads `edgesFromByLabel`; seeding the far end reads
  // `edgesToByLabel`. Both keys below clear the margin, so this is the NARROWER-wins rule and
  // not the margin refusing one of them.
  test('the NARROWER end is the one seeded', () => {
    // `name` matches 1-2, `g20` matches 10; both clear x8 against a 200-user bucket.
    expect(
      sides('MATCH (u:User {name: $n})-[:FOLLOWS]->(x:User {g20: $m}) RETURN count(*) AS c', {
        n: 'user0',
        m: 1,
      }),
    ).toBe('start');
    expect(
      sides('MATCH (u:User {g20: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c', {
        n: 0,
        m: 'user1',
      }),
    ).toBe('far');
  });

  test("each end's seek is measured against ITS OWN bucket", () => {
    // Both ends `:User` makes `candidateCount(pa)` and `candidateCount(pb)` the SAME number, so
    // a mutant comparing the start's seek to the FAR bucket is equivalent code and survives
    // every other test here. Found by mutation. With a `:User` start (200) and an `:Other` far
    // end (1), the two differ by 200x: a `g20` seek of 10 clears x8 against 200 and cannot
    // clear it against 1.
    expect(
      sides('MATCH (u:User {g20: $n})-[:FOLLOWS]->(x:Other {name: $m}) RETURN count(*) AS c', {
        n: 0,
        m: 'user2',
      }),
    ).toBe('start');
    both(
      'MATCH (u:User {g20: $n})-[:FOLLOWS]->(x:Other {name: $m}) RETURN count(*) AS c',
      { n: 0, m: 'user2' },
      [{ c: 1 }],
    );
  });

  test('a seek too WIDE to pay for its adjacency lookups is refused', () => {
    // `t` matches 100 of 200; 100x8 exceeds the bucket, so the full edge scan stands. Measured:
    // seeding there cost 1946-2076us against the 1383 the scan takes.
    expect(
      sides('MATCH (u:User {t: $n})-[:FOLLOWS]->(x:User {t: $m}) RETURN count(*) AS c', {
        n: 0,
        m: 1,
      }),
    ).toBe('neither');
    both(
      'MATCH (u:User {t: $n})-[:FOLLOWS]->(x:User {t: $m}) RETURN count(*) AS c',
      { n: 0, m: 1 },
      [{ c: 100 }],
    );
  });

  test('an UNINDEXED constraint is refused', () => {
    expect(
      sides('MATCH (u:User {nosuch: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*) AS c', {
        n: 1,
        m: 'user1',
      }),
    ).toBe('far');
    // Neither end indexed: the full scan.
    expect(
      sides('MATCH (u:User {nosuch: $n})-[:FOLLOWS]->(x:User {alsonot: $m}) RETURN count(*) AS c', {
        n: 1,
        m: 2,
      }),
    ).toBe('neither');
  });

  test('the UNCONSTRAINED count keeps its own O(1) path', () => {
    both('MATCH (u:User)-[:FOLLOWS]->(x:User) RETURN count(*) AS c', {}, [{ c: 201 }]);
    expect(sides('MATCH (u:User)-[:FOLLOWS]->(x:User) RETURN count(*) AS c', {})).toBe('neither');
  });

  test('CONTROL the one-end shapes still take their own walks', () => {
    // Items 176 and 178, unchanged — a mutant that routed them here would be visible.
    // u0 has TWO out-edges: `f0` to u1 and `xin0` to the `Other`, and the far end is unlabelled
    // so both count.
    both('MATCH (u:User {name: $n})-[:FOLLOWS]->(x) RETURN count(*) AS c', { n: 'user0' }, [
      { c: 2 },
    ]);
    both('MATCH (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN count(*) AS c', { n: 'user2' }, [
      { c: 2 },
    ]);
  });
});
