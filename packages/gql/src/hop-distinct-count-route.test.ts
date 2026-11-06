import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * Item 1583: `count(DISTINCT <one expr over one end>)` over a 1-hop is accepted by BOTH
 * `detectHopAggregate` (which folds it over every row) and `detectDistinctCount` (which dedupes
 * WHILE walking). `hopAggregate` came first in `runLinear`'s chain, so it took every such shape and
 * the narrower rung never ran — up to **6.00x**, measured at 50,000 vertices / 150,000 edges:
 *
 * ```text
 *   count(DISTINCT b.k)   22.418 -> 3.735 ms   6.00x
 *   count(DISTINCT a.n)   17.870 -> 4.416      4.05x
 *   count(DISTINCT b.n)   29.230 -> 8.820      3.31x
 *   count(DISTINCT a)     20.923 -> 11.545     1.81x
 *   count(DISTINCT b)     29.928 -> 16.611     1.80x
 * ```
 *
 * ⚠️ A ROUTE CHOICE IS ANSWER-EQUIVALENT, so the correctness suites cannot see a mutant in the
 * gate: reverting it, or inverting its condition, leaves every answer correct and only the speed
 * changes. Item 1582 learned this the hard way — three mutants survived a 125-test run. So the
 * route is asserted directly, by reading which detector `compileLinear` left non-null.
 */
const rungsOf = (q: string): readonly string[] => {
  const stmt = parse(q);
  const [part] = (stmt as unknown as { parts: unknown[] }).parts;
  const compiled = compileLinear(part as Parameters<typeof compileLinear>[0]) as unknown as Record<
    string,
    unknown
  >;

  return Object.entries(compiled)
    .filter(([k, v]) => k !== 'clauses' && k !== 'writes' && v !== null && v !== undefined)
    .map(([k]) => k);
};

describe('hop count(DISTINCT …) reaches the dedup-while-walking rung', () => {
  const HOP_DISTINCT = [
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.n) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a.n) AS c',
    'MATCH (a:P)<-[:E]-(b) RETURN count(DISTINCT b.k) AS c',
  ];

  for (const q of HOP_DISTINCT) {
    test(`distinctCount wins, and hopAggregate is OFF: ${q}`, () => {
      const rungs = rungsOf(q);

      expect(rungs).toContain('distinctCount');
      // The whole point of the gate: `hopAggregate` would otherwise answer first, since it sits
      // above `distinctCount` in `runLinear`'s chain.
      expect(rungs).not.toContain('hopAggregate');
    });
  }
});

describe('the gate leaves every other hop aggregate exactly where it was', () => {
  const HOP_AGG = [
    'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m',
    'MATCH (a:P)-[:E]->(b) RETURN min(b.k) AS m',
    'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS s',
    'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS c',
  ];

  for (const q of HOP_AGG) {
    test(`hopAggregate still claims it: ${q}`, () => {
      const rungs = rungsOf(q);

      expect(rungs).toContain('hopAggregate');
      // And the narrower rung is not even willing, which is why the gate is a no-op here.
      expect(rungs).not.toContain('distinctCount');
    });
  }

  test('a cross-end WHERE declines distinctCount, so hopAggregate keeps the shape', () => {
    // `distinctShape` requires `whereReadsOnly(where, keyedVar)`; this WHERE reads the OTHER end.
    // These are exactly the shapes where `hopAggregate`'s execution-time decline can hand the
    // query to an index seek, which is why the gate must not fire here.
    const rungs = rungsOf('MATCH (a:P)-[:E]->(b) WHERE a.n > 2 RETURN count(DISTINCT b.k) AS c');

    expect(rungs).toContain('hopAggregate');
    expect(rungs).not.toContain('distinctCount');
  });

  test('the node-only twin is untouched: it never had a hopAggregate to lose', () => {
    const rungs = rungsOf('MATCH (n:P) RETURN count(DISTINCT n.k) AS c');

    expect(rungs).toContain('distinctCount');
    expect(rungs).not.toContain('hopAggregate');
  });
});

describe('the reroute did not change an answer', () => {
  const g = (): Graph => {
    const graph = new Graph();
    const vs = [1, null, undefined, 2, 1].map((k, i) =>
      graph.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: k === undefined ? { n: i } : { k, n: i },
      }),
    );

    for (const [i, [from, to]] of (
      [
        [0, 1],
        [0, 2],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 4],
      ] as const
    ).entries()) {
      graph.addEdge({ id: `e${i}`, from: vs[from], to: vs[to], labels: ['E'] });
    }

    return graph;
  };

  test('a null never counts, and an absent property counts as nothing', () => {
    const graph = g();

    // Far ends reached: v1 (k null), v2 (k absent), v3 (k 2), v4 (k 1). Distinct non-null: 2, 1.
    expect(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c')).toEqual([
      { c: 2 },
    ]);
    expect(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.nope) AS c')).toEqual([
      { c: 0 },
    ]);
  });

  test('dedup on the node itself counts distinct ELEMENTS, not edges', () => {
    const graph = g();

    // Six edges, four distinct far ends (v1, v2, v3, v4).
    expect(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toEqual([{ c: 6 }]);
    expect(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c')).toEqual([{ c: 4 }]);
    // And on the start end: v0, v1, v2, v3, v4 all have an outgoing edge.
    expect(query(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c')).toEqual([{ c: 5 }]);
  });

  test('the ROWS spelling keeps its own null rule, where a null IS a row', () => {
    const graph = g();
    const rows = query(graph, 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k') as Array<
      Record<string, unknown>
    >;

    expect(rows.some((r) => Object.values(r)[0] === null)).toBe(true);
  });
});
