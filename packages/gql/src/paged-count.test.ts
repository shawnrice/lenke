import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The count shortcuts used to DECLINE any SKIP/LIMIT and hand the query to the general
// pipeline, which made `LIMIT 1` — a no-op on a one-row result — cost up to 35,000x the same
// query without it (audit item 152). They now answer the window themselves.
//
// Two different arguments license that, and the tests are split along them:
//
//   - an un-grouped `count(*)` is exactly ONE row, so the window is arithmetic on a
//     one-element list;
//   - a grouped count's rows are in FIRST-SEEN group order, the pinned contract both engines
//     keep, so a window over them selects the same groups the general path would.
//
// Every window below is also checked against the UNPAGED query sliced in the test, because
// that is literally what declining used to deliver.
const users = (): Graph => {
  const g = new Graph();

  // `k` cycles 0,1,2 so first-seen group order is 0,1,2 — distinguishable from sorted order
  // only if a group arrives out of numeric sequence, which `start` below arranges.
  for (let i = 0; i < 9; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, k: i % 3 } });
  }

  return g;
};

describe('an un-grouped count answers its own window', () => {
  const q = 'MATCH (u:User) RETURN count(*) AS c';

  test('the unpaged answer is one row', () => {
    expect(query(users(), q)).toEqual([{ c: 9 }]);
  });

  test('LIMIT 1 keeps it', () => {
    expect(query(users(), `${q} LIMIT 1`)).toEqual([{ c: 9 }]);
  });

  test('LIMIT 2 keeps it — a limit above the row count is not a cap', () => {
    expect(query(users(), `${q} LIMIT 2`)).toEqual([{ c: 9 }]);
  });

  test('LIMIT 0 keeps nothing', () => {
    expect(query(users(), `${q} LIMIT 0`)).toEqual([]);
  });

  test('SKIP 0 keeps it', () => {
    expect(query(users(), `${q} SKIP 0`)).toEqual([{ c: 9 }]);
  });

  test('SKIP 1 skips the only row', () => {
    expect(query(users(), `${q} SKIP 1`)).toEqual([]);
  });

  test('SKIP 1 LIMIT 1 is still empty', () => {
    expect(query(users(), `${q} SKIP 1 LIMIT 1`)).toEqual([]);
  });

  test('SKIP 0 LIMIT 0 is empty — the limit wins', () => {
    expect(query(users(), `${q} SKIP 0 LIMIT 0`)).toEqual([]);
  });

  test('a $param window resolves per execution', () => {
    // The bounds are resolved inside the shortcut rather than at compile time, so the SAME
    // compiled query must give different answers for different params.
    const g = users();

    expect(query(g, `${q} LIMIT $n`, { n: 1 })).toEqual([{ c: 9 }]);
    expect(query(g, `${q} LIMIT $n`, { n: 0 })).toEqual([]);
    // Only LIMIT/OFFSET take a `$param` here — `SKIP $x` is rejected by the parser on
    // purpose (ISO's `nonNegativeIntegerSpecification` covers LIMIT and OFFSET; a dynamic
    // SKIP is a Cypherism), so there is no param spelling of it to test.
    expect(query(g, `${q} OFFSET $s`, { s: 0 })).toEqual([{ c: 9 }]);
    expect(query(g, `${q} OFFSET $s`, { s: 1 })).toEqual([]);
  });

  test('the same holds for a filtered count', () => {
    const fq = 'MATCH (u:User) WHERE u.k = 1 RETURN count(*) AS c';

    expect(query(users(), fq)).toEqual([{ c: 3 }]);
    expect(query(users(), `${fq} LIMIT 1`)).toEqual([{ c: 3 }]);
    expect(query(users(), `${fq} SKIP 1`)).toEqual([]);
    expect(query(users(), `${fq} LIMIT 0`)).toEqual([]);
  });

  test('the same holds for a hop count', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['User'], properties: { k: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['User'], properties: { k: 1 } });
    const c = g.addVertex({ id: 'c', labels: ['User'], properties: { k: 2 } });

    g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ from: b, to: c, labels: ['E'], properties: {} });

    const hq = 'MATCH (u:User)-[:E]->(v) RETURN count(*) AS c';

    expect(query(g, hq)).toEqual([{ c: 2 }]);
    expect(query(g, `${hq} LIMIT 1`)).toEqual([{ c: 2 }]);
    expect(query(g, `${hq} SKIP 1`)).toEqual([]);
    expect(query(g, `${hq} LIMIT 0`)).toEqual([]);
  });

  test('the same holds for a product count over two patterns', () => {
    const pq = 'MATCH (a:User) MATCH (b:User) RETURN count(*) AS c';

    expect(query(users(), pq)).toEqual([{ c: 81 }]);
    expect(query(users(), `${pq} LIMIT 1`)).toEqual([{ c: 81 }]);
    expect(query(users(), `${pq} SKIP 1`)).toEqual([]);
  });
});

describe('a grouped count windows its groups in first-seen order', () => {
  // Deliberately NOT in numeric order: u0 has k=2, so first-seen order is 2, 0, 1 while
  // sorted order would be 0, 1, 2. A window that silently sorted would pick different rows.
  const start = (): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'u0', labels: ['User'], properties: { k: 2 } });
    g.addVertex({ id: 'u1', labels: ['User'], properties: { k: 0 } });
    g.addVertex({ id: 'u2', labels: ['User'], properties: { k: 1 } });
    g.addVertex({ id: 'u3', labels: ['User'], properties: { k: 2 } });
    g.addVertex({ id: 'u4', labels: ['User'], properties: { k: 0 } });

    return g;
  };

  const q = 'MATCH (u:User) RETURN u.k AS g, count(*) AS c';
  const all = [
    { g: 2, c: 2 },
    { g: 0, c: 2 },
    { g: 1, c: 1 },
  ];

  test('unpaged is first-seen order, not sorted', () => {
    expect(query(start(), q)).toEqual(all);
  });

  test('LIMIT 2 takes the first two GROUPS SEEN', () => {
    expect(query(start(), `${q} LIMIT 2`)).toEqual(all.slice(0, 2));
  });

  test('SKIP 1 drops the first group seen', () => {
    expect(query(start(), `${q} SKIP 1`)).toEqual(all.slice(1));
  });

  test('SKIP 1 LIMIT 1 takes the middle group', () => {
    expect(query(start(), `${q} SKIP 1 LIMIT 1`)).toEqual(all.slice(1, 2));
  });

  test('LIMIT 0 keeps nothing', () => {
    expect(query(start(), `${q} LIMIT 0`)).toEqual([]);
  });

  test('a SKIP past the last group is empty', () => {
    expect(query(start(), `${q} SKIP 9`)).toEqual([]);
  });

  test('a LIMIT above the group count is not a cap', () => {
    expect(query(start(), `${q} LIMIT 99`)).toEqual(all);
  });

  test('the LET spelling windows identically', () => {
    const lq = 'MATCH (u:User) LET g = u.k RETURN g, count(*) AS c GROUP BY g';

    expect(query(start(), lq)).toEqual(all);
    expect(query(start(), `${lq} LIMIT 2`)).toEqual(all.slice(0, 2));
    expect(query(start(), `${lq} SKIP 1 LIMIT 1`)).toEqual(all.slice(1, 2));
  });

  test('a grouped HOP count windows identically', () => {
    // Built here rather than from `start()` so the edge endpoints are to hand: three distinct
    // `k` values on the SOURCE side, so the grouped hop count really has several groups.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['User'], properties: { k: 2 } });
    const b = g.addVertex({ id: 'b', labels: ['User'], properties: { k: 0 } });
    const c = g.addVertex({ id: 'c', labels: ['User'], properties: { k: 1 } });

    g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ from: c, to: a, labels: ['E'], properties: {} });

    const hq = 'MATCH (u:User)-[:E]->(v) RETURN u.k AS g, count(*) AS c';
    const whole = query(g, hq);

    expect(whole.length).toBeGreaterThan(1);
    expect(query(g, `${hq} LIMIT 1`)).toEqual(whole.slice(0, 1));
    expect(query(g, `${hq} SKIP 1`)).toEqual(whole.slice(1));
    expect(query(g, `${hq} LIMIT 0`)).toEqual([]);
  });
});

describe('LIMIT 0 must not evaluate anything', () => {
  // The rule from items 139/142: a fast path may not evaluate an expression on an element the
  // general path never reaches. `LIMIT 0` emits nothing and the general path returns before
  // projecting, so a shortcut that tallied first and sliced to empty afterwards would raise
  // where the general path does not.
  //
  // The fault MUST live in the clause `WHERE`, because that is the only faulting expression
  // the grouped tally actually evaluates. Mutation proved it: written with a faulting `LET`
  // (`LET g = 1 / (u.k - 7)`) every assertion here passed even with the guard removed, because
  // an arithmetic `LET` makes the grouped shortcut DECLINE and the query takes the general
  // path. The `WHERE` becomes the tally's per-vertex gate, so it is inside the fast path.
  const faulting = (): Graph => {
    const g = new Graph();

    // k = 7 on exactly one vertex, so `1 / (u.k - 7)` faults on that vertex and only it.
    for (let i = 0; i < 6; i++) {
      g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i } });
    }

    g.addVertex({ id: 'z', labels: ['User'], properties: { k: 7 } });

    return g;
  };

  const grouped = 'MATCH (u:User) WHERE 1 / (u.k - 7) > 0 RETURN u.k AS g, count(*) AS c';
  const bare = 'MATCH (u:User) WHERE 1 / (u.k - 7) > 0 RETURN count(*) AS c';
  const letForm =
    'MATCH (u:User) WHERE 1 / (u.k - 7) > 0 LET g = u.k RETURN g, count(*) AS c GROUP BY g';

  test('the fault is REACHABLE — each unpaged query raises', () => {
    // Without this the rest of the describe proves nothing: a predicate that never faults
    // makes every "does not raise" assertion below vacuous.
    expect(() => query(faulting(), grouped)).toThrow();
    expect(() => query(faulting(), bare)).toThrow();
    expect(() => query(faulting(), letForm)).toThrow();
  });

  test('a grouped count with LIMIT 0 returns no rows instead of raising', () => {
    expect(query(faulting(), `${grouped} LIMIT 0`)).toEqual([]);
  });

  test('the LET spelling with LIMIT 0 likewise', () => {
    expect(query(faulting(), `${letForm} LIMIT 0`)).toEqual([]);
  });

  test('a bare count with LIMIT 0 likewise', () => {
    expect(query(faulting(), `${bare} LIMIT 0`)).toEqual([]);
  });

  test('a $param LIMIT 0 also short-circuits', () => {
    expect(query(faulting(), `${grouped} LIMIT $n`, { n: 0 })).toEqual([]);
  });

  test('LIMIT 1 DOES evaluate, and still raises', () => {
    // The other direction (item 145): the guard must not start skipping work the general path
    // does. Any non-zero limit needs the groups, so the fault stands.
    expect(() => query(faulting(), `${grouped} LIMIT 1`)).toThrow();
    expect(() => query(faulting(), `${bare} LIMIT 1`)).toThrow();
  });

  test('a SKIP past every group still raises', () => {
    // Knowing there are fewer than 99 groups requires tallying them all.
    expect(() => query(faulting(), `${grouped} SKIP 99`)).toThrow();
  });
});
