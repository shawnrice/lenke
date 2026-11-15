// THE ROUTE CHOICE for a seeded var-length COUNT (item 1978), as arithmetic.
//
// ⚠️⚠️ **A ROUTE CHOICE IS ANSWER-EQUIVALENT, so the differential and parity tests cannot see it.**
// Both routes return the same count — that is the whole point of having two — so a mutant that
// inverts the gate, drops the seed requirement or zeroes the budget leaves every answer-comparing
// test green. [[perf-gate-needs-its-own-test]] is the rule and this file is the instrument: the
// decision is a pure function of four numbers, and the numbers are checked here.
//
// What the answers are checked against lives elsewhere, deliberately:
//   `packages/native/src/varlen-per-source-parity.test.ts`  both routes against native
//   `packages/gql/src/trail-count-bruteforce.test.ts`       the trail count against enumeration
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { perSourceAdmissible, perSourceBudget } from './executor/var-length-count.js';
import { query } from './index';

describe('perSourceAdmissible', () => {
  test('REQUIRES A SEED, whatever the counts say', () => {
    // Without one, `src` is every vertex (or every vertex of the start label), so the attempt could
    // only blow its budget — and the 2x would land on item 573's unseeded rung, the shape this file
    // was built for. This is the clause a mutant is most likely to drop.
    expect(perSourceAdmissible(false, 1, 1_000_000)).toBe(false);
    expect(perSourceAdmissible(true, 1, 1_000_000)).toBe(true);
  });

  test('refuses an EMPTY source list', () => {
    // Nothing to walk from, and `0 * ratio <= vertices` would otherwise admit it and spend a route
    // decision on a query whose answer is already known.
    expect(perSourceAdmissible(true, 0, 1000)).toBe(false);
  });

  test('admits a selective seed and refuses a broad one, at the pinned ratio', () => {
    // The ratio is 8, and these pin it from BOTH sides so a change to it has to come here. The
    // native parity fixture is 120 vertices with one source, which this is what makes reachable.
    expect(perSourceAdmissible(true, 1, 8)).toBe(true);
    expect(perSourceAdmissible(true, 1, 7)).toBe(false);
    expect(perSourceAdmissible(true, 15, 120)).toBe(true);
    expect(perSourceAdmissible(true, 16, 120)).toBe(false);
  });

  test('the whole-graph seed is never admitted', () => {
    for (const n of [1, 8, 100, 20_000]) {
      expect(perSourceAdmissible(true, n, n)).toBe(false);
    }
  });
});

describe('perSourceBudget', () => {
  test('is the RECURRENCE’s own cost, which is what bounds the waste', () => {
    // The recurrence runs `levels` passes over |V| and every edge, so an abandoned attempt costs at
    // most what the route it falls back to was always going to cost: worst case 2x, typical case
    // item 1977's 83x. A mutant that shrinks this makes the route decline where it should win; one
    // that grows it makes a dense graph pay unbounded waste before falling back.
    expect(perSourceBudget(3, 20_000, 20_000)).toBe(120_000);
    expect(perSourceBudget(1, 10, 0)).toBe(10);
  });

  test('scales with every one of its three inputs', () => {
    const base = perSourceBudget(2, 100, 100);

    expect(perSourceBudget(4, 100, 100)).toBe(base * 2);
    expect(perSourceBudget(2, 200, 100)).toBeGreaterThan(base);
    expect(perSourceBudget(2, 100, 200)).toBeGreaterThan(base);
  });
});

/*
 * ⚠️ AND THE ANSWERS, on a graph big enough for the gate to admit — because the gate being right
 * about WHEN is worthless if the route is wrong about WHAT. These are the shapes the route's own
 * arms differ on, kept here next to the gate rather than only in the native file, so a failure
 * points at the route rather than at the harness.
 */
describe('the per-source route answers what the recurrence answers', () => {
  /** A 3-cycle per block with a self-loop and a parallel pair, 20 blocks — 100 vertices. */
  const g = new Graph();
  const BLOCKS = 20;

  for (let b = 0; b < BLOCKS; b += 1) {
    for (let k = 1; k <= 5; k += 1) {
      g.addVertex({
        id: `${String(b)}_${String(k)}`,
        labels: ['P'],
        properties: { n: b * 10 + k },
      });
    }
  }

  const v = (b: number, k: number): ReturnType<Graph['getVertexById']> =>
    g.getVertexById(`${String(b)}_${String(k)}`);

  for (let b = 0; b < BLOCKS; b += 1) {
    const e = (id: string, from: number, to: number): void => {
      g.addEdge({
        id: `${String(b)}_${id}`,
        from: v(b, from)!,
        to: v(b, to)!,
        labels: ['T'],
        properties: {},
      });
    };

    e('e1', 1, 2);
    e('e2', 2, 3);
    e('e3', 3, 1);
    // THE SELF-LOOP, and THE PARALLEL PAIR — the two shapes a position-marked enumeration has to
    // get right and a neighbour-marked one does not.
    e('e4', 1, 1);
    e('e5', 2, 3);
  }

  const count = (q: string, p: unknown): number => query(g, q, { p })[0].c as number;

  /*
   * THE ORACLE IS THE BROAD SEED. `a.n >= $p` with a low `p` admits every vertex, which
   * `perSourceAdmissible` refuses — so it runs the RECURRENCE over the same graph. Summing the
   * per-source answers over all sources must equal it. That compares the two routes against each
   * other without needing a hand-computed number, which is what made the earlier version of this
   * test circular.
   */
  /*
   * ⚠️⚠️ `{0,2}` AND `{0,3}` ARE LOAD-BEARING, and a SURVIVOR is why they are here. Dropping the
   * `min === 0 && passes(s)` term from the WALK route survived the first mutation round: the only
   * min-0 test was `{0,0}`, and `takesTheLevelRecurrence` is `max >= 2`, so `{0,0}` never reaches
   * this route at all. Item 1907 recorded the identical trap one bound down ("`{0,1}` IS THE ONLY
   * BOUND THAT REACHES THE PER-SOURCE LOOP"), and it recurs because the DISPATCH CONDITION, not
   * the obvious axis, is what says which cases are needed.
   */
  for (const bound of ['{0,2}', '{1,2}', '{0,3}', '{1,3}', '{2,3}', '{1,4}']) {
    for (const mode of ['', 'WALK ', 'TRAIL ']) {
      test(`${mode}${bound}: the per-source sum equals the recurrence`, () => {
        const broad = count(
          `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n >= $p RETURN count(*) AS c`,
          -1,
        );
        let summed = 0;

        for (let b = 0; b < BLOCKS; b += 1) {
          for (let k = 1; k <= 5; k += 1) {
            summed += count(
              `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n = $p RETURN count(*) AS c`,
              b * 10 + k,
            );
          }
        }

        expect(summed).toBe(broad);
      });
    }
  }

  test('a WALK counts edge reuse and a TRAIL does not, on the self-loop', () => {
    // The discriminator: from the self-loop's vertex at depth 2 a WALK may take `e4` twice and a
    // TRAIL may not. If the trail enumeration marked NEIGHBOURS instead of positions, or skipped
    // the mark entirely, these two would converge.
    const walk = count('MATCH WALK (a:P)-[:T]->{2,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1);
    const trail = count(
      'MATCH TRAIL (a:P)-[:T]->{2,2}(b:P) WHERE a.n = $p RETURN count(*) AS c',
      1,
    );

    expect(walk).toBeGreaterThan(trail);
  });

  test('the PARALLEL pair gives a trail two distinct two-hops', () => {
    // From `2`, both `e2` and `e5` reach `3`, and they are DIFFERENT edges — so a trail of length 2
    // through `3` exists twice over. Marking neighbours would collapse these to one.
    expect(count('MATCH TRAIL (a:P)-[:T]->{2,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 2)).toBe(
      2,
    );
  });

  test('min 0 counts the source itself exactly once per source', () => {
    // ⚠️ `{0,0}` IS NOT THIS ROUTE — `max >= 2` is the dispatch, so it is kept only as the control
    // that the shallow bound still answers 1. `{0,2}` is the one that reaches the per-source term.
    expect(count('MATCH (a:P)-[:T]->{0,0}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1)).toBe(1);

    const zero = count('MATCH WALK (a:P)-[:T]->{0,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1);
    const one = count('MATCH WALK (a:P)-[:T]->{1,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1);

    // The zero-length path is the source itself, counted exactly once, so the two bounds differ by
    // precisely one. A dropped min-0 term makes them equal.
    expect(zero).toBe(one + 1);
  });
});
