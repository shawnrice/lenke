import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 176 gave the START-side hop-count walk an index seek and left its FAR mirror scanning the
// far label bucket, so a far-anchored `count(*)` was the one spelling of its question that ignored
// the index. `farOnlyHopCount` now calls the SAME `hopSeek` the twin does — shared rather than
// mirrored, so the two sides cannot drift on what counts as seekable or on the width guard.
// Measured on 20,000 users, `name` indexed (audit item 178):
//
//   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN count(*)       413.0us -> 31.1us
//   (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN count(*)              348.1us -> 30.9us
//   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN count(u.name)   42.6us  (unchanged)
//
// As in item 176, every answer is asserted on BOTH an indexed and an unindexed graph — the seek
// is answer-preserving, so a test that only ran one of them could not tell a correct seek from a
// correct walk. `hopSeek`'s own choice (narrowest candidate, declining a seek wider than the
// bucket) is covered by the direct tests in `hop-count-seek.test.ts`, since it is one function.

/**
 * A ring of six users, and `x0` is the load-bearing vertex: it carries `name: 'user2'`, the value
 * the far anchor seeks, it is NOT a `User`, and it is the TARGET of a `FOLLOWS` edge. An index
 * seek on `name` returns it BY VALUE, so the far label check has to reject it — and because it is
 * an edge TARGET rather than a source, item 176's fixture could not have caught this.
 *
 * It also makes the label `User` non-vacuous, without which `pb` is dropped and the walk's label
 * check never runs at all.
 */
const ring = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, t: i % 2 } });
  }

  g.addVertex({ id: 'x0', labels: ['Other'], properties: { name: 'user2', t: 0 } });

  const v = (id: string) => g.getVertexById(id)!;

  // u0 -> u1 -> … -> u0, plus a +2 chord, so in-degrees differ (u2 has two, which is what
  // distinguishes "one row per edge" from "one row per far vertex").
  for (let i = 0; i < 6; i++) {
    g.addEdge({
      id: `f${i}`,
      from: v(`u${i}`),
      to: v(`u${(i + 1) % 6}`),
      labels: ['FOLLOWS'],
      properties: {},
    });
  }

  g.addEdge({ id: 'c0', from: v('u0'), to: v('u2'), labels: ['FOLLOWS'], properties: {} });
  // Into the WRONG-LABEL vertex, from two sources, so dropping the label check is loud.
  g.addEdge({ id: 'xe1', from: v('u3'), to: v('x0'), labels: ['FOLLOWS'], properties: {} });
  g.addEdge({ id: 'xe2', from: v('u4'), to: v('x0'), labels: ['FOLLOWS'], properties: {} });
  // A second edge type into u2, so the type filter is observable on a seeked far vertex.
  g.addEdge({ id: 'o1', from: v('u5'), to: v('u2'), labels: ['OTHER'], properties: {} });

  if (indexed) {
    for (const k of ['name', 't']) {
      g.createIndex({ on: 'vertex', kind: 'hash', keys: [k] });
    }
  }

  return g;
};

/** Assert the answer, and that the seeking and walking plans agree on it. */
const both = (q: string, params: Record<string, unknown>, expected: { c: number }[]): void => {
  expect(query(ring(false), q, params)).toEqual(expected);
  expect(query(ring(true), q, params)).toEqual(expected);
};

/** How many times a query asks the property index for a set — the witness for a seek. */
const hits = (g: Graph, q: string, params: Record<string, unknown>): number => {
  const idx = g.vertexPropertyIndex as unknown as {
    equals: (key: string, value: unknown) => unknown;
  };
  const real = idx.equals.bind(idx);
  let calls = 0;

  idx.equals = (key: string, value: unknown) => {
    calls += 1;

    return real(key, value);
  };

  query(g, q, params);

  return calls;
};

const FAR_CLAUSE = 'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN count(*) AS c';
const FAR_INLINE = 'MATCH (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN count(*) AS c';

describe('a far-anchored hop count seeks its far end (item 178)', () => {
  test('the clause-WHERE spelling: seek and walk agree', () => {
    // Into u2: `f1` (u1->u2) and the chord `c0` (u0->u2). The OTHER-typed `o1` does not count.
    both(FAR_CLAUSE, { n: 'user2' }, [{ c: 2 }]);
  });

  test('the inline-anchor spelling: seek and walk agree', () => {
    both(FAR_INLINE, { n: 'user2' }, [{ c: 2 }]);
  });

  // The teeth. A seek on `name` yields `x0`, which has TWO in-edges and is not a User.
  test('a seeked FAR vertex of the wrong label is rejected', () => {
    // 2, not 4 — `x0`'s two in-edges must not be counted.
    both(FAR_CLAUSE, { n: 'user2' }, [{ c: 2 }]);
    // Asked of the other label, only `x0`'s two count.
    both('MATCH (u)-[:FOLLOWS]->(x:Other) WHERE x.name = $n RETURN count(*) AS c', { n: 'user2' }, [
      { c: 2 },
    ]);
  });

  test('the edge TYPE filter still applies to a seeked far vertex', () => {
    both('MATCH (u)-[:OTHER]->(x:User) WHERE x.name = $n RETURN count(*) AS c', { n: 'user2' }, [
      { c: 1 },
    ]);
    // Untyped counts both types into u2.
    both('MATCH (u)-[]->(x:User) WHERE x.name = $n RETURN count(*) AS c', { n: 'user2' }, [
      { c: 3 },
    ]);
  });

  test('an AND-chain far anchor: the seek is a superset and the predicate re-validates', () => {
    // u2 has t = 0, so the second conjunct keeps it and then rejects it.
    both(
      'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n AND x.t = 0 RETURN count(*) AS c',
      { n: 'user2' },
      [{ c: 2 }],
    );
    both(
      'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n AND x.t = 1 RETURN count(*) AS c',
      { n: 'user2' },
      [{ c: 0 }],
    );
  });

  test('a value nothing holds counts 0, and a far vertex with no in-edges counts 0', () => {
    both(FAR_CLAUSE, { n: 'nobody' }, [{ c: 0 }]);
    // u0's only in-edge is `f5` (u5 -> u0), so ask the reverse direction of a leaf instead:
    // nothing points at nothing, and a seeked vertex with an empty bucket must contribute 0.
    both('MATCH (u)<-[:FOLLOWS]-(x:User) WHERE x.name = $n RETURN count(*) AS c', { n: 'user2' }, [
      { c: 1 },
    ]);
  });

  test('a NON-selective indexed far key still answers correctly', () => {
    // t = 0 holds for u0, u2, u4 — in-degrees 1, 2, 1 over FOLLOWS.
    both('MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.t = $t RETURN count(*) AS c', { t: 0 }, [
      { c: 4 },
    ]);
    both('MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.t = $t RETURN count(*) AS c', { t: 1 }, [
      { c: 3 },
    ]);
  });

  test('the UNANCHORED far count keeps its own path', () => {
    // NINE FOLLOWS edges — six in the ring, the chord, and two into `x0` — of which the two
    // into `x0` fail `:User`.
    both('MATCH (u)-[:FOLLOWS]->(x:User) RETURN count(*) AS c', {}, [{ c: 7 }]);
  });

  // The witness: the seek is answer-preserving, so a mutant that never seeks changes no row.
  test('a selective far anchor SEEKS, in both spellings', () => {
    expect(hits(ring(true), FAR_CLAUSE, { n: 'user2' })).toBeGreaterThan(0);
    expect(hits(ring(true), FAR_INLINE, { n: 'user2' })).toBeGreaterThan(0);
  });

  test('CONTROL an unanchored far count does not seek', () => {
    expect(hits(ring(true), 'MATCH (u)-[:FOLLOWS]->(x:User) RETURN count(*) AS c', {})).toBe(0);
  });

  test('CONTROL an anchor on an UNINDEXED far key does not seek', () => {
    expect(
      hits(ring(true), 'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.nosuch = $n RETURN count(*) AS c', {
        n: 'zzz',
      }),
    ).toBe(0);
  });

  test('CONTROL a START-anchored count still seeks its own end, not this one', () => {
    // Item 176's path, unchanged — included so a mutant that swapped `cstart` and `cfar` is
    // visible rather than merely moving the win from one side to the other.
    expect(
      hits(ring(true), 'MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c', {
        n: 'user2',
      }),
    ).toBeGreaterThan(0);
    both('MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c', { n: 'user2' }, [
      { c: 1 },
    ]);
  });
});
