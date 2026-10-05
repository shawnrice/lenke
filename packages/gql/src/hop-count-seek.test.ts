import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { CNode, EvalEnv } from './executor.js';
import { compilePredicate } from './executor.js';
import { hopSeek } from './executor/shortcuts.js';
import { query } from './index.js';

// The filtered one-hop `count(*)` shortcut walked the whole START LABEL summing degrees, so an
// anchored hop count ignored a property index the general path seeds from. Item 149 found and
// fixed exactly this for the NODE tally and recorded the signature it leaves in `bench:usage` —
// a row whose indexed and unindexed columns are the same number — but the one-hop walk was never
// given the same treatment. Four spellings of one question, 20,000 users, `name` indexed
// (audit item 176):
//
//   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*)       420.6us -> 19.1us
//   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name          15.5us
//   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(x.name)   17.8us
//   (a:User) WHERE a.name = $n MATCH (a)-[:FOLLOWS]->(x) count(*)     21.5us
//
// The seek is sound for the reason it is sound in `buildNodeCount`: a hint lifted from an
// AND-chain is a NECESSARY condition, so the seeded set is a SUPERSET of the matches, and the
// label check, the inline constraint and the predicate all re-validate every candidate.
//
// Everything here asserts the ANSWER, and asserts it twice — once on an indexed graph and once
// on an unindexed one — because the seek is a plan choice that must not change a single row. A
// test that only ran indexed could not tell a correct seek from a correct walk.

/**
 * `u0` has TWO `FOLLOWS` out-edges and one `OTHER`, so a type filter and a degree sum are both
 * observable. `x0` is the load-bearing vertex: it shares `name: 'user0'` with `u0`, carries a
 * `FOLLOWS` edge, and is NOT a `User` — so an index seek on `name` returns it BY VALUE and the
 * label check has to reject it. Without that vertex a seek that dropped the label test would
 * return the same answer as the walk, and every test in this file would pass.
 */
const fixture = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, t: i % 2 } });
  }

  g.addVertex({ id: 'x0', labels: ['Other'], properties: { name: 'user0', t: 0 } });
  // An anchored start with NO edges at all — a seek finds it and the degree sum must be 0.
  g.addVertex({ id: 'iso', labels: ['User'], properties: { name: 'lonely', t: 0 } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'a', from: v('u0'), to: v('u1'), labels: ['FOLLOWS'], properties: {} });
  g.addEdge({ id: 'b', from: v('u0'), to: v('u2'), labels: ['FOLLOWS'], properties: {} });
  g.addEdge({ id: 'z', from: v('u0'), to: v('u3'), labels: ['OTHER'], properties: {} });

  for (let i = 1; i < 6; i++) {
    g.addEdge({
      id: `c${i}`,
      from: v(`u${i}`),
      to: v(`u${(i + 1) % 6}`),
      labels: ['FOLLOWS'],
      properties: {},
    });
  }

  g.addEdge({ id: 'xe', from: v('x0'), to: v('u1'), labels: ['FOLLOWS'], properties: {} });

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['t'] });
  }

  return g;
};

/** Assert the answer, and that the indexed and unindexed plans agree on it. */
const both = (q: string, params: Record<string, unknown>, expected: { c: number }[]): void => {
  const walked = query(fixture(false), q, params);
  const seeked = query(fixture(true), q, params);

  expect(walked).toEqual(expected);
  expect(seeked).toEqual(expected);
};

describe('an anchored one-hop count seeks the start (item 176)', () => {
  test('the clause-WHERE spelling: seek and walk agree', () => {
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 2 },
    ]);
  });

  test('the inline-anchor spelling: seek and walk agree', () => {
    both(`MATCH (u:User {name: $n})-[:FOLLOWS]->(x) RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 2 },
    ]);
  });

  // The teeth. A seek on `name` yields `x0` too; it is not a User, and it HAS a FOLLOWS edge.
  test('a seeked vertex of the WRONG LABEL is rejected', () => {
    // 2, not 3 — `x0`'s edge must not be counted even though it matches the seeked value.
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 2 },
    ]);
    // And asked of the other label, only `x0`'s edge counts.
    both(`MATCH (o:Other)-[:FOLLOWS]->(x) WHERE o.name = $n RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 1 },
    ]);
  });

  test('the edge TYPE filter still applies to a seeked start', () => {
    // `u0` has 2 FOLLOWS and 1 OTHER. The untyped spelling counts all three.
    both(`MATCH (u:User)-[]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 3 },
    ]);
    both(`MATCH (u:User)-[:OTHER]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'user0' }, [
      { c: 1 },
    ]);
  });

  test('a NON-selective indexed key still answers correctly', () => {
    // `t = 0` holds for u0, u2, u4 — degrees 2, 1, 1. The seek is wider than selective and
    // must still produce the walk's answer.
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.t = $t RETURN count(*) AS c`, { t: 0 }, [
      { c: 4 },
    ]);
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.t = $t RETURN count(*) AS c`, { t: 1 }, [
      { c: 3 },
    ]);
  });

  test('an AND-chain anchor: the seek is a superset and the predicate re-validates', () => {
    // Only one conjunct is seekable; the other must still reject.
    both(
      `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n AND u.t = 0 RETURN count(*) AS c`,
      { n: 'user0' },
      [{ c: 2 }],
    );
    both(
      `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n AND u.t = 1 RETURN count(*) AS c`,
      { n: 'user0' },
      [{ c: 0 }],
    );
  });

  test('a value nothing holds counts 0, not the whole label', () => {
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'nobody' }, [
      { c: 0 },
    ]);
  });

  test('an anchored vertex with NO edges counts 0', () => {
    both(`MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'lonely' }, [
      { c: 0 },
    ]);
  });

  test('the IN direction seeks the same way', () => {
    // Into `u1`: `u0 -> u1` and `x0 -> u1`. `x` is UNLABELLED here, so `x0` counts — the
    // label check applies to the anchored end, which is `u`.
    both(`MATCH (u:User)<-[:FOLLOWS]-(x) WHERE u.name = $n RETURN count(*) AS c`, { n: 'user1' }, [
      { c: 2 },
    ]);
    // Restricting the far end to User drops `x0`.
    both(
      `MATCH (u:User)<-[:FOLLOWS]-(x:User) WHERE u.name = $n RETURN count(*) AS c`,
      { n: 'user1' },
      [{ c: 1 }],
    );
  });

  test('the UNANCHORED count keeps its own O(1) path', () => {
    // 7 FOLLOWS edges have a User source (u0 x2, u1..u5 x1 each); x0's does not.
    both(`MATCH (u:User)-[:FOLLOWS]->(x) RETURN count(*) AS c`, {}, [{ c: 7 }]);
  });

  test('the other spellings of the same question agree', () => {
    both(
      `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(x.name) AS c`,
      { n: 'user0' },
      [{ c: 2 }],
    );
    both(
      `MATCH (a:User) WHERE a.name = $n MATCH (a)-[:FOLLOWS]->(x) RETURN count(*) AS c`,
      { n: 'user0' },
      [{ c: 2 }],
    );
  });

  test('a far-end constraint beside the anchor is still applied', () => {
    both(
      `MATCH (u:User)-[:FOLLOWS]->(x:User {name: 'user1'}) WHERE u.name = $n RETURN count(*) AS c`,
      { n: 'user0' },
      [{ c: 1 }],
    );
  });

  test('an index on a key the query does not use changes nothing', () => {
    const g = fixture(false);

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['t'] });

    expect(
      query(g, `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, {
        n: 'user0',
      }),
    ).toEqual([{ c: 2 }]);
  });
});

// Seeking is answer-preserving, so a mutant that simply never seeks changes no row and survives
// every test above — the wall items 167/168/172/173 hit. `hopSeek` is exported for exactly this
// reason, so the DECISION can be asserted instead of its (identical) output. Each pair below
// differs in exactly one input, which is what makes it evidence rather than assertion.
describe('hopSeek chooses the seed set, not the answer (item 176)', () => {
  const env = (graph: Graph): EvalEnv => ({ binding: new Map(), params: {}, graph });

  /** A compiled start node carrying an inline equality, as `(u:User {name: v})` compiles to. */
  const withProp = (key: string, value: unknown): CNode => ({
    variable: 'u',
    label: { kind: 'label' as const, name: 'User' },
    pred: { props: [{ key, value: () => value }], where: undefined },
  });

  /** The clause-`WHERE` spelling's shape: the anchor arrives as a lifted seed HINT. */
  const withHint = (key: string, value: unknown): CNode => ({
    variable: 'u',
    label: { kind: 'label' as const, name: 'User' },
    pred: compilePredicate(undefined, undefined),
    seedHints: [{ kind: 'eq' as const, key, value: () => value }],
  });

  const LABEL = { kind: 'label' as const, name: 'User' };

  test('an INDEXED inline anchor seeks, and to a set narrower than the label', () => {
    const g = fixture(true);
    const seeded = hopSeek(g, withProp('name', 'user0'), LABEL, env(g));

    // TWO, not one: the index is keyed by VALUE, so it also returns `x0`, which carries the
    // same name and is NOT a User. That is the whole reason the walk re-checks the label.
    expect(seeded).toBeDefined();
    expect(seeded?.size).toBe(2);
  });

  test('the SAME node against an UNINDEXED graph does not seek', () => {
    // The pair: identical node, identical label, only the index differs.
    const g = fixture(false);

    expect(hopSeek(g, withProp('name', 'user0'), LABEL, env(g))).toBeUndefined();
  });

  test('a lifted seed HINT seeks too, which is the clause-WHERE spelling', () => {
    // `seedHints` is the second of the two things `indexCandidates` reads, and the one a
    // `mightSeek` reading only `props` missed in item 173. The clause spelling is the bench
    // row, so a chooser that handled only `props` would leave the measured gap in place.
    const g = fixture(true);
    const seeded = hopSeek(g, withHint('name', 'user0'), LABEL, env(g));

    expect(seeded).toBeDefined();
    expect(seeded?.size).toBe(2);
  });

  test('no compiled start node means no seek', () => {
    const g = fixture(true);

    expect(hopSeek(g, undefined, LABEL, env(g))).toBeUndefined();
  });

  test('an unconstrained node offers no candidate, so it walks', () => {
    const g = fixture(true);
    const bare: CNode = {
      variable: 'u',
      label: LABEL,
      pred: compilePredicate(undefined, undefined),
    };

    expect(hopSeek(g, bare, LABEL, env(g))).toBeUndefined();
  });

  test('a seek WIDER than the label bucket is declined', () => {
    // `t = 0` holds for 4 vertices (u0, u2, u4, iso) plus `x0`, which is NOT a User — so the
    // index set is 5 against a User bucket of 7: still narrower, so it seeks. Narrow the
    // bucket instead by asking for the label `Other`, whose bucket is 1 while the `t = 0`
    // index set is 5.
    const g = fixture(true);
    const other = {
      variable: 'o',
      label: { kind: 'label' as const, name: 'Other' },
      pred: { props: [{ key: 't', value: () => 0 }], where: undefined },
    } satisfies CNode;

    expect(hopSeek(g, other, { kind: 'label' as const, name: 'Other' }, env(g))).toBeUndefined();
  });

  test('among several indexed keys it takes the NARROWEST', () => {
    // `name = 'user0'` matches 2 vertices (u0 and x0); `t = 0` matches 5. Both indexed, both
    // offered, and the chooser must take the former — a `>` in that comparison picks `t`.
    const g = fixture(true);
    const two: CNode = {
      variable: 'u',
      label: LABEL,
      pred: {
        props: [
          { key: 't', value: () => 0 },
          { key: 'name', value: () => 'user0' },
        ],
        where: undefined,
      },
    };

    expect(hopSeek(g, two, LABEL, env(g))?.size).toBe(2);
  });
});

// `hopSeek`'s own tests prove the CHOICE is right, but not that the walk asks it. A mutant that
// drops the call, or stops plumbing the compiled start node to it, leaves every assertion above
// passing — both are answer-preserving. What a seek cannot hide is touching the index, so these
// two count index hits during a real query. White-box on purpose: a plan choice that changes no
// row has no other witness.
describe('the hop walk really asks the index (item 176)', () => {
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

  test('an anchored hop count SEEKS', () => {
    expect(
      hits(fixture(true), `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c`, {
        n: 'user0',
      }),
    ).toBeGreaterThan(0);
  });

  test('the inline spelling seeks too', () => {
    expect(
      hits(fixture(true), `MATCH (u:User {name: $n})-[:FOLLOWS]->(x) RETURN count(*) AS c`, {
        n: 'user0',
      }),
    ).toBeGreaterThan(0);
  });

  test('CONTROL an UNANCHORED hop count does not seek', () => {
    // Without this the assertions above would pass for a build that seeks indiscriminately,
    // and "touched the index" would stop meaning "chose to".
    expect(hits(fixture(true), `MATCH (u:User)-[:FOLLOWS]->(x) RETURN count(*) AS c`, {})).toBe(0);
  });

  test('CONTROL an anchor on an UNINDEXED key does not seek', () => {
    const g = fixture(true);

    expect(
      hits(g, `MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.nosuch = $n RETURN count(*) AS c`, {
        n: 'zzz',
      }),
    ).toBe(0);
  });
});
