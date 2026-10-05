import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { CNode, CPath } from './executor.js';
import { compileExpr, compilePredicate } from './executor.js';
import { orient } from './executor/matching.js';
import { query } from './index.js';

// `orient` reverses a pattern when the far end looks like a smaller seed. It could not see that
// the START carried a clause `WHERE`, because an UNINDEXED predicate contributes nothing to
// `estimateSeed` — so a smaller far label won, the seed pre-filter was demoted to a post-filter,
// and adding a filter made the query SLOWER than no filter at all (audit item 172):
//
//   MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource)      6.8ms, 200,000 rows
//   ... the same WHERE u.name = $n                                     60.4ms,      10 rows
//   ... after: the same query                                           3.0ms,      10 rows   20x
//
// Orientation is a PERFORMANCE decision — reversing is answer-preserving by construction — so
// what these tests can guard is that the answers do not move, across enough shapes that a broken
// reversal shows up. The 20x itself is guarded by the measurement, not by a test; a mutant that
// never reverses at all is invisible here, the same class as item 167's.

/** The authz shape from `bench:usage`, scaled down: users -> teams -> resources. */
const authz = (): Graph => {
  const g = new Graph();
  const teams = 3;
  const users = 12;
  const resources = 6;

  for (let i = 0; i < users; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, age: i * 7 } });
  }

  for (let i = 0; i < teams; i++) {
    g.addVertex({ id: `g${i}`, labels: ['Team'], properties: { tier: i } });
  }

  for (let i = 0; i < resources; i++) {
    g.addVertex({ id: `r${i}`, labels: ['Resource'], properties: { kind: i % 2 } });
  }

  const v = (id: string) => g.getVertexById(id)!;

  for (let i = 0; i < users; i++) {
    g.addEdge({
      id: `m${i}`,
      from: v(`u${i}`),
      to: v(`g${i % teams}`),
      labels: ['MEMBER_OF'],
      properties: {},
    });
  }

  for (let i = 0; i < resources; i++) {
    g.addEdge({
      id: `w${i}`,
      from: v(`g${i % teams}`),
      to: v(`r${i}`),
      labels: ['VIEWER'],
      properties: {},
    });
  }

  return g;
};

const count = (g: Graph, q: string, p?: Record<string, unknown>): unknown => query(g, q, p)[0]?.c;

const rows = (g: Graph, q: string, p?: Record<string, unknown>): string[] =>
  query(g, q, p)
    .map((r) => JSON.stringify(r))
    .sort();

describe('a start-only WHERE over a labelled tail gives the same answer either way', () => {
  // user0 -> team0 -> {r0, r3}: two resources, so the answer is not 1 and not the row count of
  // any single bucket.
  test('the authz count is right', () => {
    const g = authz();

    expect(
      count(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) WHERE u.name = $n RETURN count(*) AS c',
        { n: 'user0' },
      ),
    ).toBe(2);
  });

  test('every spelling of it agrees', () => {
    // Clause WHERE, inline anchor and inline WHERE are one question; the engine is named after
    // this rule. Only the clause form gets a `prefilter`, so this is where the guard could have
    // made the spellings diverge.
    const g = authz();
    const P = { n: 'user1' };
    const shapes = [
      'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) WHERE u.name = $n RETURN r.kind AS k',
      'MATCH (u:User {name: $n})-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) RETURN r.kind AS k',
      'MATCH (u:User WHERE u.name = $n)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) RETURN r.kind AS k',
    ];
    const first = rows(g, shapes[0], P);

    expect(first.length).toBe(2);

    for (const q of shapes.slice(1)) {
      expect(rows(g, q, P)).toEqual(first);
    }
  });

  test('the labelled and UNLABELLED tail agree', () => {
    // The unlabelled tail never reversed, so it was already correct and fast — it is the oracle
    // for the labelled one. Here every `VIEWER` target is a Resource, so the two must match.
    const g = authz();
    const P = { n: 'user2' };

    expect(
      rows(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) WHERE u.name = $n RETURN r.kind AS k',
        P,
      ),
    ).toEqual(
      rows(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(x) WHERE u.name = $n RETURN x.kind AS k',
        P,
      ),
    );
  });

  test('a tail label that EXCLUDES still excludes', () => {
    // The guard must not have turned the tail label into a no-op: adding a label no target
    // carries has to empty the result.
    const g = authz();

    expect(
      count(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Nope) WHERE u.name = $n RETURN count(*) AS c',
        { n: 'user0' },
      ),
    ).toBe(0);
  });
});

describe('the shapes that must still reverse, or must never have', () => {
  test('a FAR-end WHERE is not a prefilter and is unaffected', () => {
    const g = authz();

    // Three teams own {r0,r3}, {r1,r4}, {r2,r5}; kind is i % 2, so kind=0 is r0, r2, r4.
    // Each resource is reachable from the 4 members of its team.
    expect(
      count(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) WHERE r.kind = 0 RETURN count(*) AS c',
      ),
    ).toBe(12);
  });

  test('no filter at all is unaffected', () => {
    const g = authz();

    // 12 users, each in one team; each team owns 2 resources. 12 x 2 = 24.
    expect(
      count(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) RETURN count(*) AS c',
      ),
    ).toBe(24);
  });

  test('a WHERE reading BOTH ends is not a prefilter', () => {
    const g = authz();
    const both = count(
      g,
      'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) WHERE u.name = $n AND r.kind = 0 RETURN count(*) AS c',
      { n: 'user0' },
    );

    // user0 -> team0 -> {r0 (kind 0), r3 (kind 1)}, so one row survives.
    expect(both).toBe(1);
  });

  test('a three-hop pattern with a start-only WHERE', () => {
    // More segments than the shape that was broken, so the guard cannot be segment-count
    // specific. Resource -> OWNS -> Doc, giving u -> gr -> r -> d.
    const g = authz();
    const v = (id: string) => g.getVertexById(id)!;

    g.addVertex({ id: 'd0', labels: ['Doc'], properties: { t: 'a' } });
    g.addVertex({ id: 'd1', labels: ['Doc'], properties: { t: 'b' } });
    g.addEdge({ id: 'o0', from: v('r0'), to: v('d0'), labels: ['OWNS'], properties: {} });
    g.addEdge({ id: 'o1', from: v('r3'), to: v('d1'), labels: ['OWNS'], properties: {} });

    expect(
      rows(
        g,
        'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource)-[:OWNS]->(d:Doc) WHERE u.name = $n RETURN d.t AS k',
        { n: 'user0' },
      ),
    ).toEqual(['{"k":"a"}', '{"k":"b"}']);
  });

  test('the reversal itself still works where it is wanted', () => {
    // A pattern with NO start predicate and a selective far end: `orient` is free to reverse, and
    // the answer must be the same as the unreversed spelling of the same question. If reversal
    // ever stopped flipping the edge direction, this is what would catch it.
    const g = authz();
    const forward = count(
      g,
      'MATCH (u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource) RETURN count(*) AS c',
    );
    const backward = count(
      g,
      'MATCH (r:Resource)<-[:VIEWER]-(gr:Team)<-[:MEMBER_OF]-(u:User) RETURN count(*) AS c',
    );

    expect(backward).toBe(forward);
    expect(forward).toBe(24);
  });
});

// `orient` is exported, so the DECISION can be asserted directly instead of only its (identical)
// answers. This matters: mutants that make the planner never reverse, or reverse exactly when it
// must not — which is the 20x bug itself — change no result and so survive every test above.
// Orientation is a performance decision, and this is the one place it is observable.
describe('orient does not reverse away from a seed pre-filter', () => {
  const node = (variable: string, label?: string): CNode => ({
    variable,
    ...(label === undefined ? {} : { label: { kind: 'label' as const, name: label } }),
    pred: compilePredicate(undefined, undefined),
  });

  /** A two-segment `(u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource)`. */
  const path = (prefiltered: boolean): CPath =>
    ({
      start: node('u', 'User'),
      segments: [
        {
          rel: {
            direction: 'out' as const,
            label: { kind: 'label' as const, name: 'MEMBER_OF' },
            pred: compilePredicate(undefined, undefined),
          },
          node: node('gr', 'Team'),
        },
        {
          rel: {
            direction: 'out' as const,
            label: { kind: 'label' as const, name: 'VIEWER' },
            pred: compilePredicate(undefined, undefined),
          },
          node: node('r', 'Resource'),
        },
      ],
      selector: 'walk',
      mode: 'trail',
      binds: new Set(['u', 'gr', 'r']),
      reads: new Set<string>(),
      ...(prefiltered
        ? { prefilter: { var: 'u', pred: compileExpr({ kind: 'lit', value: true }) } }
        : {}),
    }) as unknown as CPath;

  test('WITHOUT a prefilter it reverses toward the smaller far label', () => {
    // 12 Users against 6 Resources, so the far end is the cheaper seed and `orient` should flip.
    // This is the behaviour the guard must leave intact — without it, the guard would just be
    // "never reverse", which is a different change.
    const g = authz();
    const oriented = orient(g, path(false), new Map(), {});

    expect(oriented.start.variable).toBe('r');
  });

  test('WITH a prefilter it stays put', () => {
    const g = authz();
    const oriented = orient(g, path(true), new Map(), {});

    expect(oriented.start.variable).toBe('u');
  });

  test('the two differ only in the prefilter', () => {
    // Guards against the test passing for an unrelated reason: same graph, same pattern, the
    // presence of the prefilter is the only input that changed.
    const g = authz();

    expect(orient(g, path(false), new Map(), {}).start.variable).not.toBe(
      orient(g, path(true), new Map(), {}).start.variable,
    );
  });
});
