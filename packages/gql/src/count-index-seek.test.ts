import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The filtered node count now SEEKS a property index instead of always scanning the label
// bucket (audit item 149). `bun run bench:usage` had been reporting the defect all along as a
// row whose indexed and unindexed columns were identical:
//
//   read: keyed dedup lookup     ts(-) 731    ts(+) 727    engine(+) 111.7k
//
// A seek brings two risks the bucket scan did not have, and both are tested here:
//
//   1. The index returns vertices by VALUE, across ALL labels — so the label has to be
//      applied to each candidate, which the bucket path got from its seed.
//   2. A seed hint is a NECESSARY condition lifted from an AND-chain, so the seek is a
//      SUPERSET of the matches and every candidate must be re-validated.
//
// Every test asserts the indexed answer equals the unindexed one, because that is the whole
// contract: an index may change the cost and must never change the count.
const build = (indexed: boolean): Graph => {
  const g = new Graph();

  // 60 users: score = i % 10, active on every third. So `score = 7` is 6 users, of whom 2 are
  // active — the seek returns 6 and the predicate must cut it to 2.
  for (let i = 0; i < 60; i++) {
    g.addVertex({
      id: `u${i}`,
      labels: ['User'],
      properties: { name: `user${i}`, score: i % 10, active: i % 3 === 0 },
    });
  }

  // A DIFFERENT label carrying the SAME indexed values. The seek finds these too, so a
  // missing label check counts them: 6 more `score = 7` rows that are not Users.
  for (let i = 0; i < 60; i++) {
    g.addVertex({
      id: `a${i}`,
      labels: ['Admin'],
      properties: { name: `admin${i}`, score: i % 10, active: true },
    });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
  }

  return g;
};

/** The same query against an indexed and an unindexed graph — they must agree. */
const bothGraphs = (q: string, params?: Record<string, unknown>) =>
  [query(build(false), q, params), query(build(true), q, params)] as const;

describe('filtered node count over an index', () => {
  test('the LABEL is applied to every seeked candidate', () => {
    // This is the one that fails if the seek's label check is dropped: `Admin` carries the
    // same scores, so an unlabelled count of the seek would be 12, not 6.
    const [plain, indexed] = bothGraphs('MATCH (u:User) WHERE u.score = 7 RETURN count(*) AS c');

    expect(plain).toEqual([{ c: 6 }]);
    expect(indexed).toEqual(plain);
  });

  test('the seek is a SUPERSET and every candidate is re-validated', () => {
    // `score = 7` seeks 6 Users; `active` cuts it to 2. A seek that trusted its own result
    // would answer 6.
    const [plain, indexed] = bothGraphs(
      'MATCH (u:User) WHERE u.score = 7 AND u.active = true RETURN count(*) AS c',
    );

    expect(plain).toEqual([{ c: 2 }]);
    expect(indexed).toEqual(plain);
  });

  test('the conjunct ORDER does not matter', () => {
    const [plain, indexed] = bothGraphs(
      'MATCH (u:User) WHERE u.active = true AND u.score = 7 RETURN count(*) AS c',
    );

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 2 }]);
  });

  test('an INLINE constraint seeks too, and agrees with the clause spelling', () => {
    const [plain, indexed] = bothGraphs('MATCH (u:User {score: 7}) RETURN count(*) AS c');

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 6 }]);
    // And the two spellings of one question still agree with each other.
    expect(indexed).toEqual(
      query(build(true), 'MATCH (u:User) WHERE u.score = 7 RETURN count(*) AS c'),
    );
  });

  test('inline AND clause together', () => {
    const [plain, indexed] = bothGraphs(
      'MATCH (u:User {score: 7}) WHERE u.active = true RETURN count(*) AS c',
    );

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 2 }]);
  });

  test('a parameterised predicate seeks', () => {
    const [plain, indexed] = bothGraphs('MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c', {
      s: 7,
    });

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 6 }]);
  });

  test('an IN list seeks every value', () => {
    const [plain, indexed] = bothGraphs(
      'MATCH (u:User) WHERE u.score IN [7, 8] RETURN count(*) AS c',
    );

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 12 }]);
  });

  test('a RANGE predicate agrees whichever path it takes', () => {
    const [plain, indexed] = bothGraphs('MATCH (u:User) WHERE u.score >= 8 RETURN count(*) AS c');

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 12 }]);
  });

  test('a predicate on an UNINDEXED key still answers correctly', () => {
    // No candidate is offered, so the bucket scan runs — the path the tally was built for.
    const [plain, indexed] = bothGraphs(
      'MATCH (u:User) WHERE u.active = true RETURN count(*) AS c',
    );

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 20 }]);
  });

  test('an UNLABELLED count over an indexed key counts every label', () => {
    // No label to apply, so the seek's whole result counts — Users AND Admins.
    const [plain, indexed] = bothGraphs('MATCH (u) WHERE u.score = 7 RETURN count(*) AS c');

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 12 }]);
  });

  test('a value matching NOTHING answers zero', () => {
    const [plain, indexed] = bothGraphs('MATCH (u:User) WHERE u.score = 99 RETURN count(*) AS c');

    expect(indexed).toEqual(plain);
    expect(indexed).toEqual([{ c: 0 }]);
  });

  test('an index created AFTER the first run of a query is still used', () => {
    // The seek is chosen per EXECUTION, not at compile time, because an index can be created
    // between two runs of the same query — and the count must not change when it is.
    const g = build(false);
    const q = 'MATCH (u:User) WHERE u.score = 7 RETURN count(*) AS c';
    const before = query(g, q);

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

    expect(query(g, q)).toEqual(before);
  });

  test('a count over a key some vertices lack agrees', () => {
    const g = build(true);

    g.addVertex({ id: 'x', labels: ['User'], properties: { name: 'noscore' } });

    const plain = build(false);

    plain.addVertex({ id: 'x', labels: ['User'], properties: { name: 'noscore' } });

    // The absent key is neither in the index nor a match, on either path.
    expect(query(g, 'MATCH (u:User) WHERE u.score = 7 RETURN count(*) AS c')).toEqual(
      query(plain, 'MATCH (u:User) WHERE u.score = 7 RETURN count(*) AS c'),
    );
  });
});
