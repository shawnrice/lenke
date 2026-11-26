/*
 * Item 2107 — `hopAggregate` folds over the walk seeded from the BETTER end.
 *
 * **THIS IS A REVERSAL, NOT A DECLINE, AND AN ORACLE DECIDED THAT BEFORE IT WAS BUILT.** Items
 * 2104/2105 fixed their rungs by handing the query to the orienting matcher. Forcing THIS rung to decline
 * measured 0.285 ms written and 0.281 reversed — the general path does not seed a one-hop aggregate
 * either — so handing back would have cost the reversed spelling 6.4x to gain nothing. The fast arm is
 * this rung's own walk from a seeking start.
 *
 * THE RISK A REVERSAL CARRIES AND A DECLINE DOES NOT: an aggregate's argument NAMES A VARIABLE
 * (`min(a.n)`), so if reversing renamed or re-bound anything the answer would change. `reversePath`'s
 * contract is that the bindings are identical and only the seed side differs — and that contract is what
 * every test here checks, on both sides of the gate.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause } from './ast.js';
import type { CClause, CPath } from './executor/core.js';
import { reversedHopClauses } from './executor/hop-projection.js';
import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

const build = (withIndex: boolean, nodes = 600): Graph => {
  const g = new Graph();

  for (let i = 0; i < nodes; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      // `n` is deliberately NOT uniform and NOT monotonic in id, so min/max/sum/avg each pick a
      // different vertex — a reversal that lost a binding would have to be lucky to agree on all four.
      properties: { n: (i * 37) % 101, tag: `t${i % 50}`, grp: i % 3 },
    });
  }

  for (let e = 0; e < nodes * 3; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % nodes}`)!,
      labels: ['E'],
      properties: { w: i % 5 },
    });
  }

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });
  }

  return g;
};

/** Every aggregate the screen covered, plus the two it found clean. */
const AGGREGATES = [
  'min(a.n)',
  'max(a.n)',
  'sum(a.n)',
  'avg(a.n)',
  'count(DISTINCT a.n)',
  'count(*)',
  'count(a.n)',
  'size(collect(a.n))',
  // An aggregate over the FAR node too — the reversal makes `b` the start, so if a binding were lost
  // this is where it would show.
  'min(b.n)',
  'max(b.n)',
];

describe('hopAggregate seed side (item 2107)', () => {
  for (const agg of AGGREGATES) {
    test(`${agg} — the answer is identical indexed and not`, () => {
      /*
       * THE INDEX IS THE GATE'S ONLY INPUT, so the same graph with and without it takes the two
       * different routes. An answer that depends on which route ran is the bug this item could have
       * introduced, and nothing else in the suite would catch it.
       */
      const q = `MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN ${agg} AS c`;
      const bare = query(build(false), q, { t: 't7' });
      const indexed = query(build(true), q, { t: 't7' });

      expect(indexed).toStrictEqual(bare);
      // A shape answering null/0 would agree trivially.
      expect(Object.values(bare[0] as Record<string, unknown>)[0]).not.toBeNull();
    });
  }

  test('the hand-REVERSED spelling agrees with the written one, every aggregate', () => {
    /*
     * THE EQUIVALENT-SPELLING CHECK, which is the point of the item: both spellings of one question
     * now take a seeded walk, so they must still agree on the answer. Measured after this change,
     * written against reversed: `min` 0.033 against 0.041 ms, `count(DISTINCT)` 0.050 against 0.055 —
     * the written form is now the FASTER of the two, where it was 5.73x slower.
     */
    const g = build(true);

    for (const agg of AGGREGATES) {
      const fwd = query(g, `MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN ${agg} AS c`, {
        t: 't7',
      });
      const rev = query(g, `MATCH (b:P)<-[:E]-(a:P) WHERE b.tag = $t RETURN ${agg} AS c`, {
        t: 't7',
      });

      expect(rev).toStrictEqual(fwd);
    }
  });

  test('an UNDIRECTED hop agrees too — it runs TWO turned walks, not one', () => {
    /*
     * THE SHAPE MOST LIKELY TO BREAK. `hopAggregateWalks` returns TWO walks for an undirected hop
     * (item 478) plus a `looped` single walk for graphs with self-loops (item 481), and the reversal
     * builds a SECOND such set. If the pick mixed one set's walks with the other's, a self-loop would be
     * counted twice or not at all.
     *
     * SO IT IS RUN ON BOTH A LOOPLESS AND A SELF-LOOPED GRAPH, each compared indexed against
     * unindexed — the two routes — rather than against a hand-computed number.
     */
    const addLoop = (g: Graph): Graph => {
      g.addEdge({
        id: 'loop',
        from: g.getVertexById('v7')!,
        to: g.getVertexById('v7')!,
        labels: ['E'],
        properties: {},
      });

      return g;
    };

    for (const loops of [false, true]) {
      const indexed = loops ? addLoop(build(true)) : build(true);
      const plain = loops ? addLoop(build(false)) : build(false);

      for (const agg of ['count(*)', 'min(a.n)', 'sum(a.n)', 'count(DISTINCT a.n)']) {
        const q = `MATCH (a:P)-[:E]-(b:P) WHERE b.tag = $t RETURN ${agg} AS c`;

        expect(query(indexed, q, { t: 't7' })).toStrictEqual(query(plain, q, { t: 't7' }));
      }

      // The self-loop must actually be REACHED, or this asserts nothing about it.
      const touched = query(
        indexed,
        'MATCH (a:P)-[:E]-(b:P) WHERE b.tag = $t AND a.n = b.n RETURN count(*) AS c',
        { t: 't7' },
      );

      expect(Number((touched[0] as { c: number }).c)).toBeGreaterThan(loops ? 0 : -1);
    }
  });

  test('a predicate on the START keeps the written orientation — no needless flip', () => {
    /*
     * The gate asks whether the FAR end seeks NARROWER. With the predicate on the start there is
     * nothing to gain, and flipping would make the already-good walk scan instead. Asserted by answer;
     * the route itself is covered by the mutation round, since a flip here is answer-equivalent.
     */
    const q = 'MATCH (a:P)-[:E]->(b:P) WHERE a.tag = $t RETURN min(b.n) AS c';

    expect(query(build(true), q, { t: 't7' })).toStrictEqual(query(build(false), q, { t: 't7' }));
  });

  test('GROUPED and multi-aggregate projections are unaffected', () => {
    const g = build(true);
    const plain = build(false);

    for (const tail of [
      'RETURN min(a.n) AS lo, max(a.n) AS hi',
      'RETURN b.grp AS k, count(*) AS c',
      'RETURN count(*) AS c, sum(a.n) AS s, avg(a.n) AS m',
    ]) {
      const q = `MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t ${tail}`;

      expect(query(g, q, { t: 't7' })).toStrictEqual(query(plain, q, { t: 't7' }));
    }
  });
});

/*
 * **THE PAIR'S CONSISTENCY, WHICH NO ANSWER TEST CAN SEE.** Reversing only one half of the raw +
 * compiled pair returns the CORRECT answer and costs **1765x** (56.5 ms against 0.032) — measured, with
 * the compiled-only variant at 180x. Both are slower than the unfixed code. Two mutants did exactly
 * that and survived all 14 tests above.
 *
 * SO THE TWO HALVES ARE COMPARED STRUCTURALLY. A raw path and a compiled path describing the same
 * walk must agree on the segment directions and the node variables in order; if one was reversed and the
 * other was not, they cannot.
 */
describe('reversedHopClauses — the pair must describe ONE path (item 2107)', () => {
  const clausesOf = (src: string): { m: Clause; cMatch: CClause; cPath: CPath } => {
    const parsed = parse(src) as never as {
      parts: readonly { clauses: readonly Clause[] }[];
    };
    const [part] = parsed.parts;
    const m = part.clauses.find((c) => c.kind === 'match')!;
    const linear = compileLinear(part) as unknown as { clauses: readonly CClause[] };
    const cMatch = linear.clauses.find((c) => c.kind === 'match')!;

    return {
      m,
      cMatch,
      cPath: (cMatch as { patterns: readonly CPath[] }).patterns[0],
    };
  };

  /**
   * The first pattern of a clause, as the only shape this test reads.
   *
   * ONE `unknown` HOP, in one place. `Clause` and `CClause` are unions whose other arms carry
   * different pattern types, so a direct assertion is refused — and four separate casts at the call
   * sites read as if each were a different claim. This is the single claim: both unions' match arms
   * carry a `patterns` array whose elements have `start` and `segments`.
   */
  type Patterned = {
    start: { variable?: string };
    segments: readonly { rel: { direction: string }; node: { variable?: string } }[];
  };
  const firstPattern = (clause: Clause | CClause): Patterned =>
    (clause as unknown as { patterns: readonly Patterned[] }).patterns[0];

  /** Directions and node variables, in order — what both forms must agree on. */
  const shapeOf = (p: Patterned): string =>
    [
      p.start.variable ?? '_',
      ...p.segments.map((s) => `${s.rel.direction}:${s.node.variable ?? '_'}`),
    ].join(' | ');

  for (const [name, src] of Object.entries({
    out: 'MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN min(a.n) AS c',
    in: 'MATCH (a:P)<-[:E]-(b:P) WHERE b.tag = $t RETURN min(a.n) AS c',
    undirected: 'MATCH (a:P)-[:E]-(b:P) WHERE b.tag = $t RETURN min(a.n) AS c',
    anonymous: 'MATCH (a:P)-[:E]->(:P) RETURN min(a.n) AS c',
  })) {
    test(`${name} — the raw and compiled reversals agree`, () => {
      const { m, cMatch, cPath } = clausesOf(src);
      const pair = reversedHopClauses(m as never, cMatch as never, cPath);
      const rawShape = shapeOf(firstPattern(pair.raw));
      const compiledShape = shapeOf(firstPattern(pair.compiled));

      expect(rawShape).toBe(compiledShape);
    });

    test(`${name} — and BOTH differ from the written pattern, so a reversal happened`, () => {
      /*
       * Without this half, a builder that reversed NEITHER would pass the agreement test above.
       * An UNDIRECTED hop is the exception by construction: flipping `both` is `both`, and with the
       * endpoints swapped the shape can coincide — so it is asserted only to agree, not to differ.
       */
      const { m, cMatch, cPath } = clausesOf(src);
      const pair = reversedHopClauses(m as never, cMatch as never, cPath);
      const written = shapeOf(cPath);
      const got = shapeOf(firstPattern(pair.compiled));

      if (name === 'undirected') {
        expect(got).toBe(shapeOf(firstPattern(pair.raw)));
      } else {
        expect(got).not.toBe(written);
      }
    });
  }

  test("the DIRECTION is the reversed pattern's own, not a separately flipped copy", () => {
    /*
     * A mutant that passed the UNflipped `hopDir` measured IDENTICALLY (0.032), proving the argument
     * was a second source of truth for one fact. Reading it off the reversed pattern makes it
     * unfalsifiable by construction, and this asserts that it is read from there.
     */
    for (const [src, want] of [
      ['MATCH (a:P)-[:E]->(b:P) RETURN min(a.n) AS c', 'in'],
      ['MATCH (a:P)<-[:E]-(b:P) RETURN min(a.n) AS c', 'out'],
      ['MATCH (a:P)-[:E]-(b:P) RETURN min(a.n) AS c', 'both'],
    ] as const) {
      const { m, cMatch, cPath } = clausesOf(src);
      const pair = reversedHopClauses(m as never, cMatch as never, cPath);

      expect(pair.direction).toBe(want);
      expect(
        (
          pair.raw as {
            patterns: readonly { segments: readonly { rel: { direction: string } }[] }[];
          }
        ).patterns[0].segments[0].rel.direction,
      ).toBe(want);
    }
  });
});
