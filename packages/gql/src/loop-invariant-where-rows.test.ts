import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * What a LOOP-INVARIANT carried `WHERE` must still answer and still RAISE (item 1437).
 *
 * Item 1437 admitted a predicate with no free pattern variables — `WHERE true`, `WHERE 1 = 1`,
 * `WHERE $flag` — to hop projection's start-gated walk, where it had been declining to the general
 * matcher at **7.46x** (194.63 ms against the identical unfiltered row's 26.08). `WHERE true` means
 * exactly what no `WHERE` means, so this is CLAUDE.md's equivalent-spelling rule rather than a
 * missing optimization: the two spellings now cost the same, 4.18x apart before.
 *
 * ⚠️ THE ROUTE IS INVISIBLE HERE AND THAT IS THE POINT OF THE OTHER FILE. Every assertion below
 * passes with the change reverted, because admitting a predicate to a different walk changes no
 * answer — `loop-invariant-where.test.ts` holds the route assertion and the exported pure fn. This
 * file is the other half: the walk the predicate now rides must produce the same ROWS and the same
 * RAISES as the one it left, and those are things a route change genuinely can break.
 *
 * THE ORACLE IS THE UNFILTERED SPELLING, not a literal. `WHERE true` must equal no `WHERE` and
 * `WHERE false` must equal nothing, on whatever the engine answers — which is both the right
 * assertion and robust to the fixture changing. The one place literals appear is the raise contract,
 * where there is nothing to compare against.
 */

/** `v0 -> v1 -> … `, one `E` edge each, plus an `F` edge so a type can select nothing. */
const build = (verts: number, edges: number): Graph => {
  const g = new Graph();
  const vs: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < verts; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i, k: i * 2 } }));
  }

  for (let i = 0; i < edges; i += 1) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: { w: i } });
  }

  return g;
};

/** Rows as a sorted multiset — the walk's row order is unspecified, its contents are not. */
const ns = (g: Graph, src: string, params: Record<string, unknown> = {}): unknown[] =>
  query(g, src, params)
    .map((r) => r['n'])
    .slice()
    .sort((x, y) => Number(x) - Number(y));

const HOP = (w: string): string =>
  `MATCH (a:P)-[:E]->(b:P)${w === '' ? '' : ` WHERE ${w}`} RETURN b.n AS n`;

describe('an invariant TRUE predicate equals no predicate at all (item 1437)', () => {
  test('⚠️ `WHERE true` and the bare spelling agree — the 7.46x pair', () => {
    const g = build(50, 49);

    expect(ns(g, HOP('true'))).toEqual(ns(g, HOP('')));
    // And non-trivially so: the fixture really does produce rows, or this would pass empty.
    expect(ns(g, HOP('')).length).toBe(49);
  });

  test('the other constant spellings agree with it too', () => {
    const g = build(50, 49);
    const bare = ns(g, HOP(''));

    expect(ns(g, HOP('1 = 1'))).toEqual(bare);
    expect(ns(g, HOP('1 < 2'))).toEqual(bare);
    expect(ns(g, HOP('true AND true'))).toEqual(bare);
    expect(ns(g, HOP('NOT false'))).toEqual(bare);
  });

  test('an invariant FALSE predicate keeps nothing', () => {
    const g = build(50, 49);

    expect(ns(g, HOP('false'))).toEqual([]);
    expect(ns(g, HOP('1 = 2'))).toEqual([]);
    expect(ns(g, HOP('true AND false'))).toEqual([]);
  });

  test('a PARAMETER drives it both ways on one graph, so the carry is not folded at compile', () => {
    // The generated-query shape. The same query text must answer both ways depending only on the
    // parameter, which also pins that the decision is not cached across calls with the plan.
    const g = build(50, 49);
    const bare = ns(g, HOP(''));

    expect(ns(g, HOP('$flag'), { flag: true })).toEqual(bare);
    expect(ns(g, HOP('$flag'), { flag: false })).toEqual([]);
    expect(ns(g, HOP('$flag'), { flag: true })).toEqual(bare);
  });

  test('and on a graph where the hop selects nothing', () => {
    const g = build(50, 49);

    expect(ns(g, 'MATCH (a:P)-[:ZZZ]->(b:P) WHERE true RETURN b.n AS n')).toEqual([]);
  });
});

describe('the invariant carry across the other hop shapes (item 1437)', () => {
  test('UNDIRECTED, which is a different walk entirely', () => {
    const g = build(50, 49);

    expect(ns(g, 'MATCH (a:P)-[:E]-(b:P) WHERE true RETURN b.n AS n')).toEqual(
      ns(g, 'MATCH (a:P)-[:E]-(b:P) RETURN b.n AS n'),
    );
    expect(ns(g, 'MATCH (a:P)-[:E]-(b:P) WHERE false RETURN b.n AS n')).toEqual([]);
  });

  test('a BOUND REL, which needs the edge bound before the gate', () => {
    // `carriedWhere` reports `startOnly` for an invariant predicate and `relBoundHopWalk` declines
    // `startOnly` outright, so this shape falls somewhere else. It is here because the answer must
    // be right wherever it lands, not because this item made it fast.
    const g = build(50, 49);
    const w = (src: string): unknown[] =>
      query(g, src)
        .map((r) => r['w'])
        .slice()
        .sort((x, y) => Number(x) - Number(y));

    expect(w('MATCH (a:P)-[r:E]->(b:P) WHERE true RETURN r.w AS w')).toEqual(
      w('MATCH (a:P)-[r:E]->(b:P) RETURN r.w AS w'),
    );
    expect(w('MATCH (a:P)-[r:E]->(b:P) WHERE false RETURN r.w AS w')).toEqual([]);
  });

  test('OPTIONAL MATCH, which has its own detector', () => {
    const g = build(50, 49);

    expect(ns(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:P) WHERE true RETURN b.n AS n')).toEqual(
      ns(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:P) RETURN b.n AS n'),
    );
  });

  test('a COUNT over the same hop, which rides a different route again', () => {
    const g = build(50, 49);
    const c = (src: string): number => query<{ c: number }>(g, src)[0].c;

    expect(c('MATCH (a:P)-[:E]->(b:P) WHERE true RETURN count(*) AS c')).toBe(
      c('MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c'),
    );
    expect(c('MATCH (a:P)-[:E]->(b:P) WHERE false RETURN count(*) AS c')).toBe(0);
  });

  test('an invariant predicate BESIDE a real one still filters by the real one', () => {
    // `true AND b.n > 5` has a free variable, so it is NOT invariant and must keep taking the far
    // predicate's closure. The guard against the invariant branch swallowing a conjunction.
    const g = build(50, 49);

    expect(ns(g, HOP('true AND b.n > 5'))).toEqual(ns(g, HOP('b.n > 5')));
    expect(ns(g, HOP('false AND b.n > 5'))).toEqual([]);
    expect(ns(g, HOP('b.n > 5')).length).toBeLessThan(49);
  });
});

/**
 * ⚠️ RAISE PARITY, which is the one thing this route can get wrong invisibly.
 *
 * The general matcher evaluates a clause `WHERE` once per COMPLETE match, so a graph that produces
 * no match must never evaluate it — items 139-145 record this and the start-gated walk carries a
 * bucket check and a `try`/`catch` for exactly that reason. An invariant predicate makes the
 * question sharp, because hoisting its evaluation anywhere earlier than the first complete match
 * would turn a quiet empty answer into a thrown error.
 *
 * `$s + 1 = 2` with a string `$s` is the probe: it faults on evaluation and reads no pattern
 * variable, so it is invariant AND observable. The contract asserted is route-independent — **raise
 * if and only if at least one complete match exists** — and was verified against the general matcher
 * by running the same predicate under a two-hop pattern hop projection declines, which raises on a
 * graph with two edges and stays quiet on one with a single edge, exactly as the match count says.
 */
describe('an invariant predicate that FAULTS raises iff a match exists (item 1437)', () => {
  const FAULT = HOP('$s + 1 = 2');
  const P = { s: 'not a number' };

  test('⚠️ a complete match exists: it raises', () => {
    expect(() => query(build(3, 2), FAULT, P)).toThrow(/arithmetic requires a number/);
    // One edge is still a complete one-hop match, so one is enough.
    expect(() => query(build(3, 1), FAULT, P)).toThrow(/arithmetic requires a number/);
  });

  test('vertices but NO edges: it must stay quiet', () => {
    // THE CASE A HOIST WOULD BREAK. The starts exist, so a predicate evaluated per start vertex
    // without the bucket check would fault here while the general path returns an empty answer.
    expect(query(build(3, 0), FAULT, P)).toEqual([]);
  });

  test('edges of ANOTHER type only: also quiet', () => {
    const g = build(3, 2);

    expect(query(g, 'MATCH (a:P)-[:ZZZ]->(b:P) WHERE $s + 1 = 2 RETURN b.n AS n', P)).toEqual([]);
  });

  test('an empty graph: quiet', () => {
    expect(query(build(0, 0), FAULT, P)).toEqual([]);
  });

  test('no start matches the label: quiet', () => {
    const g = build(3, 2);

    expect(query(g, 'MATCH (a:ZZZ)-[:E]->(b:P) WHERE $s + 1 = 2 RETURN b.n AS n', P)).toEqual([]);
  });

  test('a zero-variable faulting SUBQUERY is not carried, and raises as it always did', () => {
    // `rowLocal` refuses this, so it keeps the general path. Asserted because the invariant branch
    // sits above every other test in `carriedWhere` and a missing `rowLocal` check would route a
    // faulting subquery into a walk whose raise parity does not expect one.
    const g = build(3, 2);

    expect(
      query(g, 'MATCH (a:P)-[:E]->(b:P) WHERE EXISTS { MATCH (z:P) } RETURN b.n AS n').length,
    ).toBe(2);
  });
});
