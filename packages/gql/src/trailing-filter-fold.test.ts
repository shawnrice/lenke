// Item 548. `FILTER <pred>` and a clause `WHERE <pred>` on the MATCH before it ask the same
// question, but only the `WHERE` spelling reached the ladder — every detector matches a clause
// LIST and a `FILTER` is one clause too many (item 540's structural rule, on the GQL side).
// Measured at 200,000 vertices / 200,000 edges, one case per process:
//
//   MATCH (n:Person) FILTER n.age > 44 RETURN count(*)              41.72 -> 11.33 ms   3.7x
//   MATCH (:Person)-[:KNOWS]->(b) FILTER b.age > 44 RETURN count(*) 278.94 -> 32.29     8.6x
//   MATCH (n:Person) FILTER n.age > 44 RETURN max(n.age)             43.26 -> 12.23     3.5x
//
// against WHERE controls that did not move (10.73/11.12, 33.63/32.63, 12.20/12.42).
//
// The ONE refusal that is about semantics rather than reach is `OPTIONAL MATCH`: a clause `WHERE`
// there is evaluated INSIDE the optional, so a start with no match still yields its null-filled
// row, while a `FILTER` after it DROPS that row. The pair below reads 1 and 2 — folding would
// change the answer, and the test pins both.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });

  g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });
  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const rows = (q: string): readonly unknown[] => query(g, q);

/** The folded spelling and the `WHERE` spelling must answer identically. */
const same = (head: string, pred: string, tail: string, want: unknown[]): void => {
  expect(rows(`${head} FILTER ${pred} ${tail}`)).toEqual(want);
  expect(rows(`${head} WHERE ${pred} ${tail}`)).toEqual(want);
};

describe('a trailing FILTER folds into the preceding MATCH (item 548)', () => {
  test('the two spellings agree on a count, an aggregate and a projection', () => {
    same('MATCH (n:P)', 'n.n > 1', 'RETURN count(*) AS c', [{ c: 1 }]);
    same('MATCH (n:P)', 'n.n > 0', 'RETURN count(*) AS c', [{ c: 2 }]);
    same('MATCH (n:P)', 'n.n > 1', 'RETURN max(n.n) AS m', [{ m: 2 }]);
    same('MATCH (n:P)', 'n.n > 1', 'RETURN n.n AS k ORDER BY k', [{ k: 2 }]);
    same('MATCH (n:P)-[:T]->(m)', 'm.n = 2', 'RETURN count(*) AS c', [{ c: 1 }]);
    // A missing property is UNKNOWN, not FALSE, and must still drop the row on both routes.
    same('MATCH (n:P)', 'n.missing > 1', 'RETURN count(*) AS c', [{ c: 0 }]);
  });

  test('an OPTIONAL MATCH is NOT folded, because the two spellings differ there', () => {
    // `a` has a `:T` out-edge, `b` has none. The FILTER drops `b`'s null-filled row; the WHERE,
    // being evaluated inside the optional, keeps it. Folding would turn the first into the second.
    expect(
      rows('MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) FILTER x.n = 2 RETURN count(*) AS c'),
    ).toEqual([{ c: 1 }]);
    expect(
      rows('MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) WHERE x.n = 2 RETURN count(*) AS c'),
    ).toEqual([{ c: 2 }]);
    // The rows themselves, so a count that happens to match cannot hide a different row set.
    expect(rows('MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) FILTER x.n = 2 RETURN n.n AS k')).toEqual(
      [{ k: 1 }],
    );
  });

  test('the match keeps its own WHERE, and the fold conjoins onto it', () => {
    expect(rows('MATCH (n:P) WHERE n.n > 0 FILTER n.n > 1 RETURN count(*) AS c')).toEqual([
      { c: 1 },
    ]);
    expect(rows('MATCH (n:P) WHERE n.n > 1 FILTER n.n > 0 RETURN count(*) AS c')).toEqual([
      { c: 1 },
    ]);
  });

  test('the fold CLOSES a divergence on a faulting conjunct', () => {
    // A clause `WHERE` whose conjuncts are partitioned short-circuits on a FALSE one, so a
    // faulting conjunct beside it never raises — that is pre-existing and it is what NATIVE does:
    //
    //   WHERE 1 / 0 > 0 AND n.n > 9       ts [{c:0}]   native [{c:0}]
    //   WHERE 1 / 0 > 0 FILTER n.n > 9    ts THREW     native [{c:0}]   <- before item 548
    //
    // Folding makes the `FILTER` spelling the `AND` spelling, which is the whole claim, and the
    // TS answer becomes native's. Verified against the pristine build before saying so.
    expect(rows('MATCH (n:P) WHERE 1 / 0 > 0 AND n.n > 9 RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
    expect(rows('MATCH (n:P) WHERE 1 / 0 > 0 FILTER n.n > 9 RETURN count(*) AS c')).toEqual([
      { c: 0 },
    ]);
    // A faulting predicate with NOTHING to short-circuit against still raises on both spellings,
    // which is what says the fault was not simply discarded.
    expect(() => rows('MATCH (n:P) WHERE 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
    expect(() => rows('MATCH (n:P) FILTER 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
  });

  test('a faulting FILTER still raises on both spellings', () => {
    expect(() => rows('MATCH (n:P) FILTER 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
    expect(() => rows('MATCH (n:P) WHERE 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
    // The control: the same query without the predicate is answered, so the throw is the FILTER.
    expect(rows('MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });

  test('a FILTER that is not behind a MATCH is left alone', () => {
    // After a `LET` the previous clause is not a match, so nothing folds and the general path
    // answers — the same answer, which is the point.
    expect(rows('MATCH (n:P) LET z = n.n FILTER z > 1 RETURN count(*) AS c')).toEqual([{ c: 1 }]);
    // A GROUPED projection behind a folded FILTER still groups.
    expect(rows('MATCH (n) FILTER n.n > 1 RETURN n.n AS k, count(*) AS c ORDER BY k')).toEqual([
      { k: 2, c: 1 },
      { k: 3, c: 1 },
    ]);
  });
});
