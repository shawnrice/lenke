import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A single-node MATCH's clause `WHERE` is moved into the node pattern at compile time, so it is
// applied during the scan instead of filtering a binding per vertex afterwards (audit item 127).
//
// THE ORACLE is independent enumeration from the known fixture, not another spelling: the point
// of the change is that the spellings now compile to the SAME thing, so one cannot check the
// other. Where a route still differs (OPTIONAL, a pattern with segments) both are compared.

const KS = [1, 2, 2, 0, 1, 1, 2, 0, 3, 1];
const SS = ['a', 'b', 'a', 'c', 'b', 'a', 'a', 'c', 'b', 'a'];

const build = (): Graph => {
  const g = new Graph();
  const vs = KS.map((k, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: i % 4 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k, s: SS[i] },
    }),
  );

  // A couple of edges so the "has segments, not pushed" cases have something to walk.
  g.addEdge({ from: vs[0], to: vs[1], labels: ['E'], properties: {} });
  g.addEdge({ from: vs[1], to: vs[2], labels: ['E'], properties: {} });
  // One vertex with no `k` at all: an absent key is NULL, which drops the row either way.
  g.addVertex({ id: 'bare', labels: ['P'], properties: { s: 'z' } });

  return g;
};

const c = (g: Graph, q: string): number => (query(g, q)[0] as { c: number }).c;

describe('a single-node clause WHERE is pushed into the pattern', () => {
  test('it answers the independently-enumerated count', () => {
    const g = build();

    expect(c(g, `MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c`)).toBe(
      KS.filter((k) => k === 2).length,
    );
    expect(c(g, `MATCH (n:P) WHERE n.k >= 1 RETURN count(*) AS c`)).toBe(
      KS.filter((k) => k >= 1).length,
    );
    // The `bare` vertex has no `k`: NULL drops it, so the total is KS.length, not KS.length + 1.
    expect(c(g, `MATCH (n:P) WHERE n.k >= 0 RETURN count(*) AS c`)).toBe(KS.length);
    expect(c(g, `MATCH (n:P) WHERE n.missing = 1 RETURN count(*) AS c`)).toBe(0);
    expect(c(g, `MATCH (n:Q) WHERE n.k = 1 RETURN count(*) AS c`)).toBe(
      KS.filter((k, i) => i % 4 === 0 && k === 1).length,
    );
  });

  test('the three spellings agree, and so do the rows they return', () => {
    const g = build();
    const want = query(g, `MATCH (n:P) WHERE n.k = 2 RETURN n.s AS s ORDER BY s`);

    expect(want).toEqual(query(g, `MATCH (n:P {k: 2}) RETURN n.s AS s ORDER BY s`));
    expect(want).toEqual(query(g, `MATCH (n:P WHERE n.k = 2) RETURN n.s AS s ORDER BY s`));
    expect(want.length).toBe(KS.filter((k) => k === 2).length);
  });

  // The node may already carry a predicate; the pushed one is AND-ed on, not substituted.
  test('it ANDs with a predicate the node already has', () => {
    const g = build();
    const n = (q: string): number => c(g, q);

    expect(n(`MATCH (n:P {k: 1}) WHERE n.s = 'a' RETURN count(*) AS c`)).toBe(
      KS.filter((k, i) => k === 1 && SS[i] === 'a').length,
    );
    expect(n(`MATCH (n:P WHERE n.k = 1) WHERE n.s = 'b' RETURN count(*) AS c`)).toBe(
      KS.filter((k, i) => k === 1 && SS[i] === 'b').length,
    );
    // Neither half may be dropped: each alone gives a bigger answer.
    expect(n(`MATCH (n:P {k: 1}) WHERE n.s = 'a' RETURN count(*) AS c`)).toBeLessThan(
      n(`MATCH (n:P {k: 1}) RETURN count(*) AS c`),
    );
    expect(n(`MATCH (n:P {k: 1}) WHERE n.s = 'a' RETURN count(*) AS c`)).toBeLessThan(
      n(`MATCH (n:P) WHERE n.s = 'a' RETURN count(*) AS c`),
    );
  });

  // A non-boolean in a truth context is a data exception, and it must stay one: the predicate is
  // evaluated once per scanned vertex either way, so the same queries raise.
  test('a non-boolean WHERE still raises', () => {
    const g = build();

    expect(() => query(g, `MATCH (n:P) WHERE n.k RETURN count(*) AS c`)).toThrow(
      /boolean is required/,
    );
    expect(() => query(g, `MATCH (n:P) WHERE $p RETURN count(*) AS c`, { p: 5 })).toThrow(
      /boolean is required/,
    );
    expect(query(g, `MATCH (n:P) WHERE $p RETURN count(*) AS c`, { p: true })).toEqual([
      { c: KS.length + 1 },
    ]);
  });

  // Shapes the push must NOT touch. Each is compared against the inline spelling, which for
  // these DOES still route differently, so the comparison means something.
  test('shapes the push declines still answer correctly', () => {
    const g = build();

    // Has segments — the probe shows the clause form is FASTER for a hop, so pushing would be
    // a pessimisation, and it is skipped.
    expect(c(g, `MATCH (a:P)-[:E]->(b) WHERE a.k = 1 RETURN count(*) AS c`)).toBe(
      c(g, `MATCH (a:P {k: 1})-[:E]->(b) RETURN count(*) AS c`),
    );
    // OPTIONAL: the clause WHERE must see the null-filled row, so it cannot move into the scan.
    expect(c(g, `OPTIONAL MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c`)).toBe(
      KS.filter((k) => k === 2).length,
    );
    expect(c(g, `OPTIONAL MATCH (n:P) WHERE n.k = 99 RETURN count(*) AS c`)).toBe(1);
    // An anonymous node has no variable to attach to.
    expect(c(g, `MATCH (:P) RETURN count(*) AS c`)).toBe(KS.length + 1);
    // A WHERE reading an OUTER variable is not a single-node predicate.
    expect(c(g, `MATCH (z:P {k: 3}) MATCH (n:P) WHERE n.k = z.k RETURN count(*) AS c`)).toBe(
      KS.filter((k) => k === 3).length,
    );
    // Several patterns in one clause.
    expect(c(g, `MATCH (n:P), (m:P) WHERE n.k = 3 RETURN count(*) AS c`)).toBe(
      KS.filter((k) => k === 3).length * (KS.length + 1),
    );
  });

  // A bound path variable makes the pattern more than a bare node.
  test('a path variable is not pushed into', () => {
    const g = build();

    expect(query(g, `MATCH p = (n:P) WHERE n.k = 2 RETURN count(*) AS c`)).toEqual([
      { c: KS.filter((k) => k === 2).length },
    ]);
  });
});
