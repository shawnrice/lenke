import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the BOUNDED reachability rung produces — item 1848.
 *
 * `detectReachableShortcut` required `q.max === null`, so an unbounded `->+` got a BFS over the
 * reached set while a bounded `{1,3}` was sent to path enumeration: **165.5 ms to return 8 rows**,
 * against 108.0 ms for emitting all 251,910 undeduped rows of the same walk. The bounded arm is a
 * depth-capped BFS and measured 36.56x.
 *
 * `min <= 1` IS A CORRECTNESS CONDITION, NOT CONSERVATISM, and it is the thing these tests
 * exist to pin. The arm keys on SHORTEST distance: a vertex at shortest distance `d` is reachable
 * by a walk of length `d`, so it belongs in the answer exactly when `1 <= d <= max`. That argument
 * collapses the moment `min > 1` — a vertex at `d = 1` may ALSO be reachable at length 2 or 3, and
 * a shortest-distance search cannot see it. `{2,3}` therefore stays refused, and a test asserts
 * the ANSWER for it rather than only the refusal.
 *
 * `ACYCLIC` STAYS REFUSED for the reason already in `reachability.ts`: on one node with a
 * self-loop, `MATCH ACYCLIC (x)-[:R]->+(y)` is 0 — a self-loop repeats a node — while a BFS over
 * the reached set answers 1. Bounding the quantifier does not change that, so the mode gate is
 * unchanged and a test holds it there.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const build = (edges: readonly [string, string, string][]): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    g.addVertex({ id, labels: ['T'], properties: { n: id } });
  }

  for (const [id, from, to] of edges) {
    const f = g.getVertexById(from);
    const t = g.getVertexById(to);

    if (f === null || t === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id, from: f, to: t, labels: ['E'] });
  }

  return g;
};

const reached = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) => String(r.x))
    .sort();

/** A straight chain a->b->c->d->e->f, so depth is exactly position. */
const CHAIN: [string, string, string][] = [
  ['1', 'a', 'b'],
  ['2', 'b', 'c'],
  ['3', 'c', 'd'],
  ['4', 'd', 'e'],
  ['5', 'e', 'f'],
];

describe('a bounded var-length reachability query', () => {
  /**
   * THE DEPTH BOUNDARY IS THE POINT. On a straight chain from a single seed, `{1,k}` must reach
   * exactly the first `k` successors — one short and one long of the bound both being wrong in a
   * way no cyclic fixture would reveal.
   */
  test('reaches exactly to the bound on a chain', () => {
    const g = build(CHAIN);

    /**
     * THE ROUTE IS ASSERTED HERE BECAUSE THE FIRST VERSION OF THIS FILE DID NOT TAKE THE RUNG
     * AT ALL. It seeded with a clause `WHERE s.n = 'a'`, which `detectReachableShortcut` refuses
     * outright (`m.where !== undefined`), so every case below ran the GENERAL MATCHER and four
     * depth-correctness mutants — the cap off by one in each direction, the bound ignored, and the
     * frontier never advanced — all SURVIVED. An inline property seeds the same vertices and does
     * reach the rung. A route assertion is the only thing that makes that visible.
     */
    expect(routes("MATCH (s:T {n: 'a'})-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x")).toContain(
      'reachShortcut',
    );

    for (const [k, expected] of [
      [1, ['b']],
      [2, ['b', 'c']],
      [3, ['b', 'c', 'd']],
      [4, ['b', 'c', 'd', 'e']],
      [5, ['b', 'c', 'd', 'e', 'f']],
      // Past the end of the chain: no more to reach, and it must not throw.
      [9, ['b', 'c', 'd', 'e', 'f']],
    ] as [number, string[]][]) {
      expect(
        reached(g, `MATCH (s:T {n: 'a'})-[:E]->{1,${k}}(b:T) RETURN DISTINCT b.n AS x`),
      ).toEqual(expected);
    }
  });

  /** A cycle must terminate and must not report a vertex twice. */
  test('terminates on a cycle and reports each vertex once', () => {
    const g = build([
      ['1', 'a', 'b'],
      ['2', 'b', 'c'],
      ['3', 'c', 'a'],
      ['4', 'g', 'g'],
    ]);

    expect(reached(g, "MATCH (s:T {n: 'a'})-[:E]->{1,9}(b:T) RETURN DISTINCT b.n AS x")).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  /**
   * A SELF-LOOP AT THE SEED. The seed is reachable from itself at depth 1, so `{1,k}` includes
   * it — which a search that marked seeds as already-seen would miss.
   */
  test('a self-loop puts the seed in its own reached set', () => {
    const g = build([
      ['1', 'a', 'a'],
      ['2', 'a', 'b'],
    ]);

    expect(reached(g, "MATCH (s:T {n: 'a'})-[:E]->{1,2}(b:T) RETURN DISTINCT b.n AS x")).toEqual([
      'a',
      'b',
    ]);
  });

  /** `{0,k}` admits the zero-length path, so the seed is in the answer with no self-loop at all. */
  test('a zero minimum includes the seed itself', () => {
    const g = build(CHAIN);

    expect(reached(g, "MATCH (s:T {n: 'a'})-[:E]->{0,2}(b:T) RETURN DISTINCT b.n AS x")).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('the modes the rung serves all agree with each other on a cyclic fixture', () => {
    const g = build([
      ['1', 'a', 'a'],
      ['2', 'a', 'b'],
      ['3', 'b', 'a'],
      ['4', 'b', 'c'],
      ['5', 'c', 'd'],
      ['6', 'd', 'b'],
    ]);
    const base = reached(g, 'MATCH (a:T)-[:E]->{1,4}(b:T) RETURN DISTINCT b.n AS x');

    for (const mode of ['TRAIL', 'WALK', 'SIMPLE']) {
      expect(reached(g, `MATCH ${mode} (a:T)-[:E]->{1,4}(b:T) RETURN DISTINCT b.n AS x`)).toEqual(
        base,
      );
    }
  });

  test('count(DISTINCT b) over a bounded quantifier matches the row form', () => {
    const g = build(CHAIN);
    const rows = reached(g, 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x');
    const [counted] = query(g, 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN count(DISTINCT b) AS x');

    expect(counted.x).toBe(rows.length);
  });
});

describe('the bounded rung refuses what it must', () => {
  /*
   * **`min > 1` NOW TAKES THE RUNG (item 2008) AND THE ANSWER HALF IS UNCHANGED — which is
   * exactly the guard this test's original note described.** It said: "a test that only asserted
   * 'does not take the rung' would pass if the rung were removed entirely", and that reasoning is
   * why the reversal is safe to make — the assertion that carries the correctness condition is the
   * one below, and it is untouched.
   *
   * The refusal was a property of the BFS, not of the question: a shortest-distance search cannot
   * see that a vertex found at `d = 1` is ALSO reachable at length 2. `trailReached` is a DFS with a
   * `len >= minLen` test, so it can. Item 2007 refuted the cheap alternative (a per-level BFS
   * answers WALK reachability, and the modes diverge in 10 of 27 cells at `min >= 2`), which is why
   * only TRAIL and the default are admitted.
   */
  test('a minimum above one NOW takes the rung, and still answers', () => {
    const g = build(CHAIN);

    expect(routes("MATCH (s:T {n: 'a'})-[:E]->{2,3}(b:T) RETURN DISTINCT b.n AS x")).toContain(
      'reachShortcut',
    );
    // UNCHANGED: `b` is reachable from `a` only at depth 1, so `{2,3}` must EXCLUDE it. A DFS
    // that ignored `minLen` would answer `['b','c','d']` and every route assertion would still pass.
    expect(reached(g, "MATCH (s:T {n: 'a'})-[:E]->{2,3}(b:T) RETURN DISTINCT b.n AS x")).toEqual([
      'c',
      'd',
    ]);
  });

  test('min > 1 stays REFUSED for WALK, SIMPLE and ACYCLIC — each for its own measured reason', () => {
    /*
     * Item 2007's probe: `WALK` reaches vertices a trail cannot by reusing an edge (one self-loop
     * at `{2,2}` is `[0]` for WALK and `[]` for the rest), `SIMPLE` is a third restriction again
     * (`two self-loops {2,2}` is `[0]` for WALK and TRAIL, `[]` for SIMPLE), and `ACYCLIC` is
     * excluded for a SECOND reason on top: `acyclicReached` has no `min` term at all, so admitting
     * it would include depth-1 vertices in a `{2,3}` answer.
     */
    for (const kw of ['MATCH WALK', 'MATCH SIMPLE', 'MATCH ACYCLIC']) {
      expect(
        routes(`${kw} (s:T {n: 'a'})-[:E]->{2,3}(b:T) RETURN DISTINCT b.n AS x`),
      ).not.toContain('reachShortcut');
    }

    // And they still answer: the general matcher serves them, as it did before item 2008.
    const g = build(CHAIN);

    expect(
      reached(g, "MATCH WALK (s:T {n: 'a'})-[:E]->{2,3}(b:T) RETURN DISTINCT b.n AS x"),
    ).toEqual(['c', 'd']);
  });

  /**
   * ACYCLIC DIVERGES FROM SET REACHABILITY and must keep the enumeration path — the one-node
   * self-loop case `reachability.ts` records: ACYCLIC answers 0 where a BFS answers 1.
   */
  /*
   * **THIS TEST USED TO ASSERT THAT BOUNDED `ACYCLIC` DOES NOT TAKE THE RUNG, AND ITEM 2004
   * DELIBERATELY REVERSED THAT — while the ANSWER half is unchanged and is the reason the reversal is
   * safe.** The rung grew a separate DFS arm for a BOUNDED acyclic quantifier (`runReach`'s
   * `spec.acyclic`); the BFS arm and its refusal are untouched, because ACYCLIC genuinely is not set
   * reachability. Item 2003 refuted the cheap alternative by measurement: a BFS plus a closed-case
   * correction is UNSOUND once the sources are restricted.
   *
   * THE ANSWER ASSERTIONS BELOW ARE THE POINT, and they are IDENTICAL to what this test asserted
   * before. A lone self-loop is the fixture the whole refusal was built on — `CLOSED.md` records it
   * as the measured reason — so if the new arm answered like a BFS it would say `a` here.
   */
  test('bounded ACYCLIC now TAKES the rung, and still answers 0 on a lone self-loop', () => {
    const g = build([['1', 'a', 'a']]);

    expect(routes('MATCH ACYCLIC (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x')).toContain(
      'reachShortcut',
    );
    // UNCHANGED FROM BEFORE ITEM 2004: the only acyclic path from `a` would repeat `a`.
    expect(reached(g, 'MATCH ACYCLIC (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x')).toEqual([]);
    // A BFS over the reached set would say `a`; TRAIL does, and that is the divergence.
    expect(reached(g, 'MATCH TRAIL (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x')).toEqual([
      'a',
    ]);
  });

  test('UNBOUNDED ACYCLIC is still refused — the DFS has no depth bound there', () => {
    /*
     * THE BOUND IS WHAT MAKES THE ARM SAFE WITHOUT A DECLINE. This rung cannot decline at
     * runtime (`clauses.ts` returns its result directly), and for a bounded quantifier the DFS is
     * safe because the general matcher — what runs the shape today — enumerates the SAME acyclic
     * path set with a binding per path on top. An unbounded `->+` has no such bound: the longest
     * acyclic path is |V|, so it stays on the general matcher.
     */
    for (const q of ['+', '*', '{1,}']) {
      expect(routes(`MATCH ACYCLIC (a:T)-[:E]->${q}(b:T) RETURN DISTINCT b.n AS x`)).not.toContain(
        'reachShortcut',
      );
    }

    // And the answer is still right on the fixture the refusal was built on.
    expect(
      reached(
        build([['1', 'a', 'a']]),
        'MATCH ACYCLIC (a:T)-[:E]->+(b:T) RETURN DISTINCT b.n AS x',
      ),
    ).toEqual([]);
  });

  test('a bounded quantifier DOES take the rung, where an unbounded one already did', () => {
    // `{1,1}` is NOT in this list, and that is the engine being right rather than an omission:
    // `dropVacuousQuantifier` collapses a one-to-one quantifier to a plain hop, which reaches
    // `distinctProjection` instead. Asserting `reachShortcut` there would pin a worse route.
    for (const q of ['{1,3}', '{0,3}', '{1,}']) {
      expect(routes(`MATCH (a:T)-[:E]->${q}(b:T) RETURN DISTINCT b.n AS x`)).toContain(
        'reachShortcut',
      );
    }

    expect(routes('MATCH (a:T)-[:E]->{1,1}(b:T) RETURN DISTINCT b.n AS x')).toEqual([
      'distinctProjection',
    ]);
  });
});
