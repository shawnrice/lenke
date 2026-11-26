// THE ROUTE CHOICE for a seeded var-length COUNT (item 1978), as arithmetic.
//
// **A ROUTE CHOICE IS ANSWER-EQUIVALENT, so the differential and parity tests cannot see it.**
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

import { seedVertices, seekedSeeds } from './executor/matching.js';
import { compileLinear } from './executor/rewrites.js';
import { perSourceAdmissible, perSourceBudget } from './executor/var-length-count.js';
import { query } from './index';
import { parse } from './parser.js';

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
 * AND THE ANSWERS, on a graph big enough for the gate to admit — because the gate being right
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
   * `{0,2}` AND `{0,3}` ARE LOAD-BEARING, and a SURVIVOR is why they are here. Dropping the
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
    // `{0,0}` IS NOT THIS ROUTE — `max >= 2` is the dispatch, so it is kept only as the control
    // that the shallow bound still answers 1. `{0,2}` is the one that reaches the per-source term.
    expect(count('MATCH (a:P)-[:T]->{0,0}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1)).toBe(1);

    const zero = count('MATCH WALK (a:P)-[:T]->{0,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1);
    const one = count('MATCH WALK (a:P)-[:T]->{1,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', 1);

    // The zero-length path is the source itself, counted exactly once, so the two bounds differ by
    // precisely one. A dropped min-0 term makes them equal.
    expect(zero).toBe(one + 1);
  });
});

/*
 * `seekedSeeds` IS A ROUTE CHOICE TOO, and the costliest kind: returning `undefined` where a
 * seek was available silently restores the O(|V|) scan (item 1979's 160x), and returning an array
 * where no index served it silently restores the 1.37-1.72x generator regression that made the
 * first attempt unshippable. Both answer identically, so only this file can see either.
 */
describe('seekedSeeds', () => {
  /** The compiled start node of a seeded var-length count, which is what the rung passes. */
  const startNodeOf = (text: string): Parameters<typeof seekedSeeds>[1] => {
    const stmt = parse(text);

    if (!('parts' in stmt)) {
      throw new Error('not a linear statement');
    }

    const lin = compileLinear(stmt.parts[0]);
    const cm = lin?.clauses.find((c) => c.kind === 'match');

    if (cm?.kind !== 'match') {
      throw new Error('no compiled match clause');
    }

    return cm.patterns[0].start;
  };

  const g = new Graph();
  const N = 400;

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `s${String(i)}`,
      labels: ['S'],
      /*
       * `name` unique + INDEXED, `bucket` two values + INDEXED (so candidate CHOICE is observable),
       * `tag` three values and deliberately NEVER INDEXED — the unindexed arm needs a key that
       * stays unindexed, and pointing it at `bucket` broke the moment `bucket` gained an index.
       */
      properties: { name: `n${String(i)}`, bucket: i % 2, tag: `t${String(i % 3)}` },
    });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
  /*
   * A SECOND INDEX, AND A SURVIVOR IS WHY. With only `name` indexed there is exactly ONE index
   * candidate, so `candidate.count < best.count` never decides anything and a mutant inverting it
   * to `>` — picking the WORST candidate, i.e. the broadest seek — passed the whole file. Choosing
   * among candidates needs two of them with DIFFERENT selectivity to be observable at all.
   */
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['bucket'] });

  const CLAUSE = 'MATCH (a:S)-[:T]->{1,3}(b:S) WHERE a.name = $p RETURN count(*) AS c';
  const INLINE = 'MATCH (a:S {name: $p})-[:T]->{1,3}(b:S) RETURN count(*) AS c';
  const NOINDEX = 'MATCH (a:S)-[:T]->{1,3}(b:S) WHERE a.tag = $p RETURN count(*) AS c';

  test('seeks an indexed equality, in BOTH spellings', () => {
    // Both, because `compileLinear` attaches a clause `WHERE` to the node as `pred`/`seedHints`.
    // If that ever stops being true the clause form silently returns to the scan, which is item
    // 583's cliff and this repo's first-named defect class.
    for (const q of [CLAUSE, INLINE]) {
      const got = seekedSeeds(g, startNodeOf(q), new Map(), { p: 'n7' });

      expect(got).not.toBeUndefined();
      expect(got).toHaveLength(1);
      expect(got?.[0]?.properties.name).toBe('n7');
    }
  });

  test('returns undefined when NO index serves the node', () => {
    // THE REGRESSION GUARD. An array here sends every unindexed seed through this module's
    // generator, which measured 1.37-1.72x worse than the label-extent spread the rung already had.
    expect(seekedSeeds(g, startNodeOf(NOINDEX), new Map(), { p: 't1' })).toBeUndefined();
  });

  test('AGREES WITH seedVertices about what is worth seeking', () => {
    /*
     * THIS ASSERTS AGREEMENT, NOT A THRESHOLD, and the first draft got that wrong. I expected a
     * broad `name >= ''` to be refused by `seekIsWorthIt` (break-even ~18%) and asserted
     * `undefined`; it seeks, returning 301 of 400. That is `seekIsWorthIt`'s call to make and it is
     * SHARED with `seedVertices` — so pinning my own guess at the threshold here would duplicate
     * the rule and could drift from it, which is how one shape rule became two before (see
     * `detectDistinctCount`'s note).
     *
     * What must hold is that the two seekers never disagree: wherever `seekedSeeds` returns a list,
     * `seedVertices` must return the SAME list, because the rung's answer now depends on one and
     * every other caller's on the other. The measured 5.3% that a broad indexed seed pays is this
     * case — priced, seeked, and then filtered — and it is the documented cost of the 160x.
     */
    const SEEDS = [
      ['MATCH (a:S)-[:T]->{1,3}(b:S) WHERE a.name >= $p RETURN count(*) AS c', { p: '' }],
      [CLAUSE, { p: 'n7' }],
      [INLINE, { p: 'n7' }],
      [NOINDEX, { p: 't1' }],
    ] as const;

    for (const [q, params] of SEEDS) {
      const node = startNodeOf(q);
      const seeked = seekedSeeds(g, node, new Map(), params);

      if (seeked === undefined) {
        continue;
      }

      expect(seeked).toEqual([...seedVertices(g, node, new Map(), params)]);
    }
  });

  test('picks the NARROWEST candidate when several indexes serve the node', () => {
    // `name` is unique (1 of 400) and `bucket` has two values (200 of 400). Both are indexed and
    // both serve this node, so the choice is observable: the narrow one yields 1 vertex, the broad
    // one 200. Picking the broad one still answers correctly after `seedPasses` filters it, which
    // is precisely why no answer test can see the difference.
    const both =
      'MATCH (a:S)-[:T]->{1,3}(b:S) WHERE a.name = $p AND a.bucket = $q RETURN count(*) AS c';
    const got = seekedSeeds(g, startNodeOf(both), new Map(), { p: 'n7', q: 1 });

    expect(got).not.toBeUndefined();
    expect(got).toHaveLength(1);
  });

  test('a seed matching nothing seeks to an EMPTY list, not undefined', () => {
    // Distinct outcomes: `[]` means "seeked, found none" and the count is 0 without touching a
    // vertex; `undefined` would send it to a full scan to discover the same thing.
    expect(seekedSeeds(g, startNodeOf(CLAUSE), new Map(), { p: 'absent' })).toEqual([]);
  });
});
