// Item 549. ISO puts `<order by and page statement>` in the `primitiveQueryStatement` position
// (§14.10), so `ORDER BY` / `OFFSET` / `LIMIT` can stand as a pipeline step of its own in FRONT
// of the projection — and there it put one extra clause ahead of every detector, which is item
// 540's structural rule again (item 548 was its `FILTER` instance). Two spellings are identities:
//
//                                                      TS         native
//   MATCH (n:Person) RETURN count(*)                   0.00 ms    0.01 ms
//   MATCH (n:Person) OFFSET 0 RETURN count(*)         83.00       0.57
//   MATCH (n:Person) ORDER BY n.age RETURN count(*)  126.60      10.07
//   MATCH (n:Person) ORDER BY n.age RETURN max(n.age) 194.35     10.30
//
// After: 0.00, 0.00 and 15.61. BOTH engines have the cliff, so this is the TS half.
//
// The refusals carry the whole correctness argument, and each has its own case below: a `LIMIT`
// or a non-zero `OFFSET` changes WHICH rows reach the projection; `collect` reads their ORDER;
// a projection that is not one row makes the sort position observable; and `ORDER BY 1 / 0`
// RAISES in both engines, so a drop that skipped the sort would skip the fault with it.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3 } });

  return g;
};

const g = build();
const rows = (q: string): readonly unknown[] => query(g, q);

describe('a vacuous ORDER BY / OFFSET statement is dropped (item 549)', () => {
  test('the dropped spellings answer what the same query without them answers', () => {
    expect(rows('MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) OFFSET 0 RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n DESC RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n OFFSET 0 RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN max(n.n) AS m')).toEqual([{ m: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN min(n.n) AS m')).toEqual([{ m: 1 }]);
    // Two items, and an aggregate WRAPPED in arithmetic — still one order-free row.
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN count(*) AS c, max(n.n) + 1 AS m')).toEqual([
      { c: 3, m: 4 },
    ]);
    // A bare variable key, and a key the projection never mentions.
    expect(rows('MATCH (n:P) ORDER BY n RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.missing RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('a LIMIT or a non-zero OFFSET changes the answer and is NEVER dropped', () => {
    expect(rows('MATCH (n:P) ORDER BY n.n LIMIT 2 RETURN count(*) AS c')).toEqual([{ c: 2 }]);
    expect(rows('MATCH (n:P) LIMIT 2 RETURN count(*) AS c')).toEqual([{ c: 2 }]);
    expect(rows('MATCH (n:P) OFFSET 1 RETURN count(*) AS c')).toEqual([{ c: 2 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n OFFSET 1 LIMIT 1 RETURN max(n.n) AS m')).toEqual([
      { m: 2 },
    ]);
    // The ORDER BY is load-bearing under a LIMIT: the other direction takes the other rows.
    expect(rows('MATCH (n:P) ORDER BY n.n DESC LIMIT 1 RETURN max(n.n) AS m')).toEqual([{ m: 3 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n LIMIT 1 RETURN max(n.n) AS m')).toEqual([{ m: 1 }]);
  });

  test('an ORDER-DEPENDENT aggregate keeps its sort', () => {
    // `collect` reads the row order, so these two must stay different.
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN collect(n.n) AS m')).toEqual([{ m: [1, 2, 3] }]);
    expect(rows('MATCH (n:P) ORDER BY n.n DESC RETURN collect(n.n) AS m')).toEqual([
      { m: [3, 2, 1] },
    ]);
    // `sum` and `avg` are order-free in arithmetic but NOT in floating point, and byte-identity
    // with native pins the summation order — so they are refused too, and must still answer.
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN sum(n.n) AS s')).toEqual([{ s: 6 }]);
    expect(rows('MATCH (n:P) ORDER BY n.n DESC RETURN avg(n.n) AS s')).toEqual([{ s: 2 }]);
  });

  test('a projection that is NOT one row keeps its sort', () => {
    // No aggregate at all: the ORDER BY statement is the only thing ordering the output.
    expect(rows('MATCH (n:P) ORDER BY n.n DESC RETURN n.n AS k')).toEqual([
      { k: 3 },
      { k: 2 },
      { k: 1 },
    ]);
    // An implicit GROUP BY key beside an aggregate — many rows, and the sort picks their order.
    expect(rows('MATCH (n:P) ORDER BY n.n DESC RETURN n.n AS k, count(*) AS c')).toEqual([
      { k: 3, c: 1 },
      { k: 2, c: 1 },
      { k: 1, c: 1 },
    ]);
    // `RETURN *` carries the bound row, so its order is the statement's.
    expect((rows('MATCH (n:P) ORDER BY n.n RETURN *') as unknown[]).length).toBe(3);
  });

  test('a FAULTING sort key still raises', () => {
    // Dropping this sort would swallow the fault. Both engines raise and must keep raising.
    expect(() => rows('MATCH (n:P) ORDER BY 1 / 0 RETURN count(*) AS c')).toThrow();
    expect(() => rows('MATCH (n:P) ORDER BY n.n + 1 / 0 RETURN count(*) AS c')).toThrow();
    // The controls: a fault-free key on the same query is dropped and answered.
    expect(rows('MATCH (n:P) ORDER BY n.n RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });
});
