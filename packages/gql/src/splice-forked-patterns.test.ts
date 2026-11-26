import { describe, expect, test } from 'bun:test';

/**
 * `MATCH (a)-[:E]->(b), (a)-[:E]->(c)` spliced into `(b)<-[:E]-(a)-[:E]->(c)` — item 1864.
 *
 * The FORK is the other way two comma patterns can share a variable: item 1844 joined where the
 * right pattern STARTS on the left's END, and this joins where both START on the same variable.
 * It reached no rung at all, because every projection rung requires `patterns.length === 1` —
 * 35.0 ms against the reversed chain's 4.9 and the forward chain's 3.8, **7.1x between two
 * spellings of one question**.
 *
 * **THE REWRITE IS ASSERTED AS A REWRITE, not through a route**, which is item 1844's own
 * lesson: `countShortcut` fires for both spellings, so "which detector fired" is identical either
 * way and such an assertion passes with the rewrite disabled. What has to be checked is the AST —
 * one pattern, two segments, the first one's direction FLIPPED.
 *
 * **AND THE DIAGONAL IS THE CORRECTNESS QUESTION.** In the comma form the two patterns are
 * independent, so the two legs may be the SAME EDGE: an `a` with one out-edge matches once, with
 * `b` and `c` both bound to that edge's target. A single path pattern carries `mode: 'trail'`, and
 * had the engine enforced it on fixed-length segments this rewrite would silently drop rows. It
 * does not — but that is measured here rather than assumed, because it is the one thing that would
 * turn this into a wrong answer with no other symptom.
 */
import { Graph } from '@lenke/core';

import { spliceChainedPatterns } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

type Seg = { rel: { direction: string }; node: { variable?: string } };
type Pat = { start: { variable?: string }; segments: readonly Seg[] };

/** The spliced patterns of the first MATCH clause, as plain shape data. */
const splicedShape = (src: string): { count: number; start?: string; dirs: string[] } => {
  const q = parse(src) as never as { parts: readonly { clauses: readonly unknown[] }[] };
  const out = spliceChainedPatterns(q.parts[0].clauses as never) as unknown as {
    kind: string;
    patterns: readonly Pat[];
  }[];
  const m = out.find((c) => c.kind === 'match');

  if (m === undefined) {
    throw new Error('no match clause');
  }

  return {
    count: m.patterns.length,
    start: m.patterns[0].start.variable,
    dirs: m.patterns[0].segments.map((s) => s.rel.direction),
  };
};

describe('a forked pair of patterns splices into a reversed chain', () => {
  test('two patterns become ONE, with the first leg flipped', () => {
    const got = splicedShape('MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x');

    // `(b)<-[:E]-(a)-[:E]->(c)`: starts on `b`, the leg into `a` is now IN, the leg to `c` is OUT.
    expect(got).toEqual({ count: 1, start: 'b', dirs: ['in', 'out'] });
  });

  test('the chained form still splices the way item 1844 made it', () => {
    const got = splicedShape('MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN c.n AS x');

    expect(got).toEqual({ count: 1, start: 'a', dirs: ['out', 'out'] });
  });

  test('an IN leg flips to OUT', () => {
    const got = splicedShape('MATCH (a:T)<-[:E]-(b:T), (a)-[:E]->(c:T) RETURN b.n AS x');

    expect(got).toEqual({ count: 1, start: 'b', dirs: ['out', 'out'] });
  });

  /** Two patterns sharing NOTHING are a genuine product and must stay two patterns. */
  test('a genuine product is left alone', () => {
    const got = splicedShape('MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN b.n AS x');

    expect(got.count).toBe(2);
  });

  /** An UNDIRECTED leg is refused — see the rewrite's note on `undirectedSide`. */
  test('an undirected leg is refused', () => {
    const got = splicedShape('MATCH (a:T)-[:E]-(b:T), (a)-[:E]->(c:T) RETURN b.n AS x');

    expect(got.count).toBe(2);
  });

  /** A multi-segment left leg is refused: reversing it is mechanical but was not measured. */
  test('a two-segment left leg is refused', () => {
    const got = splicedShape(
      'MATCH (a:T)-[:E]->(m:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x',
    );

    expect(got.count).toBe(2);
  });

  /** A label or inline property on the back-reference would have to be merged, so it declines. */
  test('a non-bare back-reference is refused', () => {
    const got = splicedShape('MATCH (a:T)-[:E]->(b:T), (a:T)-[:E]->(c:T) RETURN b.n AS x');

    expect(got.count).toBe(2);
  });
});

const build = (fanout: number): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 'a' } });

  for (let i = 0; i < fanout; i += 1) {
    g.addVertex({ id: `t${i}`, labels: ['T'], properties: { n: `t${i}` } });
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById('a') as never,
      to: g.getVertexById(`t${i}`) as never,
      labels: ['E'],
    });
  }

  return g;
};

const rowsOf = (g: Graph, text: string): string =>
  JSON.stringify(
    query(g, text)
      .map((r) => `${String(r.x)}/${String(r.y)}`)
      .sort(),
  );

describe('the spliced fork answers what the fork answered', () => {
  /**
   * THE DIAGONAL, at the smallest fixture that shows it. ONE out-edge means the only match uses
   * the same edge for both legs — so a rewrite that refused a repeated edge would answer 0 here,
   * and every larger fixture would merely under-count rather than obviously break.
   */
  test('one out-edge still matches once, both legs on the SAME edge', () => {
    const g = build(1);

    expect(query(g, 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS c')[0].c).toBe(1);
    expect(rowsOf(g, 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y')).toBe(
      JSON.stringify(['t0/t0']),
    );
  });

  test('the row multiset is the full square, diagonal included', () => {
    const g = build(3);
    const got = rowsOf(g, 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y');

    expect(JSON.parse(got)).toHaveLength(9);
    expect(got).toBe(rowsOf(g, 'MATCH (b:T)<-[:E]-(a:T)-[:E]->(c:T) RETURN b.n AS x, c.n AS y'));
  });

  /**
   * AND AGAINST THE ROUTE THAT CANNOT TAKE THE REWRITE. A clause `WHERE` is not spliced away —
   * `foldLabelTestsIntoPatterns` can empty one, but `WHERE true` survives — so this is the same
   * question down the general matcher, and it cannot share a mistake with the spliced arm.
   */
  test('agrees with the unspliced general matcher', () => {
    for (const fanout of [1, 2, 3, 5]) {
      const g = build(fanout);
      const spliced = rowsOf(
        g,
        'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
      );
      const general = rowsOf(
        g,
        'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) WHERE true RETURN b.n AS x, c.n AS y',
      );

      expect(`fanout ${fanout}: ${spliced}`).toBe(`fanout ${fanout}: ${general}`);
    }
  });

  /** The `a` binding must survive the reversal — it is projectable from the middle of the chain. */
  test('the shared variable is still bound and projectable', () => {
    const g = build(2);

    expect(rowsOf(g, 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN a.n AS x, b.n AS y')).toBe(
      JSON.stringify(['a/t0', 'a/t0', 'a/t1', 'a/t1']),
    );
  });
});
