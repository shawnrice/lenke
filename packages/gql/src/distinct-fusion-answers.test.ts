import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS the FUSED one-column `DISTINCT` produces — item 1843.
 *
 * Items 1821/1822 admitted `RETURN DISTINCT` to the hop-2 and chain rungs by materializing every
 * undeduped row and calling `distinctRows` afterwards; both left a note that deduping INSIDE the
 * walk was the remaining lever, "with this one's number as the floor". This file is that lever's
 * guard.
 *
 * ⚠️ THE THREE WAYS THIS FUSION CAN SILENTLY BREAK, one describe block each. None of them is
 * caught by "does DISTINCT still return distinct rows" on a fixture of plain numbers, which is why
 * the existing `chain-distinct-answers` file passed against every mutant of the keying.
 *
 *   1. KEY-SET LIFETIME. The key set must be built PER RUN. Hoisted into the compiled plan it is
 *      shared across executions, and the SECOND run of a cached query returns ZERO rows — every
 *      key already seen. Parse and plan caches make a repeated query text reuse one plan, so this
 *      is the normal case in an application and invisible to a test that runs each query once.
 *   2. THE TWO KEY SPACES. `addOneColumnKey` keeps primitives in a `Set` (SameValueZero) and
 *      non-primitives under `valueKey` in a SEPARATE set, because the row `['@v1']` (a string) and
 *      the row `[<vertex v1>]` are different rows that both key as `'@v1'`. Items 1561 and 1562
 *      each shipped a silent answer change here.
 *   3. THE FUSED AND UNFUSED ROUTES MUST AGREE. One column fuses; two columns keep the old
 *      materialize-then-`distinctRows` tail. Both are reached from the same detector, so a
 *      divergence between them is a divergence between two spellings of the same question.
 */
import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * ⚠️ THE FIXTURE CARRIES THE VALUES THAT ARE HARD, not a range of plain integers: a stored `null`,
 * a `-0` against a `0`, a `NaN`, and a STRING that collides with a vertex id's key shape (`@v1`).
 * A fixture of distinct small integers cannot tell correct keying from almost any mutant of it.
 */
const build = (): Graph => {
  const g = new Graph();
  const values: unknown[] = [1, 1, 0, -0, Number.NaN, Number.NaN, null, null, '@v1', 'x', 'x'];

  for (const [i, v] of values.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: v, n: i % 3 } });
  }

  // A chain long enough for BOTH rungs: two segments reach `hop2-projection`, three reach
  // `chain-projection`. Fanout 2 so duplicates genuinely arise rather than being an artifact of a
  // one-to-one topology.
  let e = 0;

  for (let h = 0; h < 2; h += 1) {
    for (let i = 0; i < values.length; i += 1) {
      const from = g.getVertexById(`v${i}`);
      const to = g.getVertexById(`v${(i * 5 + 3 + h) % values.length}`);

      if (from === null || to === null) {
        throw new Error('fixture is broken: a vertex is missing after insertion');
      }

      g.addEdge({ id: `e${e}`, from, to, labels: ['E'] });
      e += 1;
    }
  }

  return g;
};

const TWO_SEG = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT c.k AS x';
const THREE_SEG = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN DISTINCT d.k AS x';

/** Row order is unspecified, so every comparison here is as a MULTISET of rendered keys. */
const keysOf = (rows: readonly Record<string, unknown>[]): string[] =>
  rows
    .map((r) => {
      const v = r.x;

      if (typeof v === 'number' && Number.isNaN(v)) {
        return '#NaN';
      }

      return `${typeof v}:${String(v)}`;
    })
    .sort();

describe('the fused one-column DISTINCT', () => {
  /**
   * ⚠️ MUTANT 1's GUARD, and the one a single-run test cannot give. Running the SAME TEXT twice
   * reuses the cached plan, so a key set that lives in the plan rather than in the run is empty
   * only the first time.
   */
  test('a repeated query returns the same rows every time', () => {
    const g = build();

    for (const text of [TWO_SEG, THREE_SEG]) {
      const first = keysOf(query(g, text));
      const second = keysOf(query(g, text));
      const third = keysOf(query(g, text));

      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    }
  });

  /**
   * ⚠️ MUTANT 2's GUARD, and the FIRST version of it did not work — recorded because the failure is
   * the interesting part. Asserting that `RETURN DISTINCT c` yields unique ids, and separately that
   * `c.k` contains the string `'@v1'`, catches NOTHING: each of those columns holds elements OR
   * strings, never both, so collapsing the two key spaces changes neither answer. The mutant
   * survived and the test looked fine.
   *
   * The collision needs ONE column holding BOTH, which is exactly what `clauses.ts` describes —
   * "the row `['@v1']` and the row `[<vertex v1>]` are different rows that would both key as
   * `'@v1'`". A `CASE` yielding the VERTEX when `k` is null and the STRING otherwise builds it: the
   * fixture gives `v1` a stored null (so the vertex itself lands in the column, keying as `@v1`)
   * and another vertex the literal string `'@v1'`. Correct keying keeps two rows; one shared space
   * keeps one.
   */
  test('a vertex and a string that render the same key stay distinct', () => {
    const g = new Graph();

    g.addVertex({ id: 'v0', labels: ['T'], properties: { k: 'z' } });
    g.addVertex({ id: 'v1', labels: ['T'], properties: { k: null } });
    g.addVertex({ id: 'v2', labels: ['T'], properties: { k: '@v1' } });

    const edges = [
      ['v0', 'v1'],
      ['v1', 'v2'],
      ['v2', 'v0'],
      ['v0', 'v2'],
      ['v1', 'v0'],
      ['v2', 'v1'],
    ];

    edges.forEach(([a, b], i) => {
      const from = g.getVertexById(a);
      const to = g.getVertexById(b);

      if (from === null || to === null) {
        throw new Error('fixture is broken');
      }

      g.addEdge({ id: `e${i}`, from, to, labels: ['E'] });
    });

    const render = (rows: readonly Record<string, unknown>[]): string[] =>
      rows
        .map((r) => {
          const v = r.x;

          return typeof v === 'object' && v !== null
            ? `V:${String((v as { id: string }).id)}`
            : `${typeof v}:${String(v)}`;
        })
        .sort();

    for (const text of [
      'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT CASE WHEN c.k IS NULL THEN c ELSE c.k END AS x',
      'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN DISTINCT CASE WHEN d.k IS NULL THEN d ELSE d.k END AS x',
    ]) {
      // The VERTEX v1 and the STRING '@v1' are different rows; `valueKey` renders both as `@v1`,
      // which is why they must live in separate key spaces.
      expect(render(query(g, text))).toEqual(['V:v1', 'string:@v1', 'string:z']);
    }
  });

  /**
   * ⚠️ MUTANT 3's GUARD, and a cross-route oracle rather than a hand-written expectation. The
   * two-column spelling REFUSES the fusion and keeps the materialize-then-dedupe tail, so it is a
   * genuine second implementation of the same keying. Projecting the same column twice makes the
   * two answers comparable: one column per row against two identical ones.
   */
  test('agrees with the two-column route that declines the fusion', () => {
    const g = build();

    for (const [one, two] of [
      [TWO_SEG, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT c.k AS x, c.k AS y'],
      [
        THREE_SEG,
        'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN DISTINCT d.k AS x, d.k AS y',
      ],
    ]) {
      const fused = keysOf(query(g, one));
      const viaDistinctRows = keysOf(query(g, two));

      expect(fused).toEqual(viaDistinctRows);
    }
  });

  /**
   * ⚠️ AND IT MUST STILL BE A SUBSET OF THE UNDEDUPED ROWS, with every value represented. A fusion
   * that dropped a whole key would pass the agreement test above if BOTH routes dropped it; the
   * undeduped walk is the independent third opinion, and it reaches neither keyer.
   */
  test('holds exactly the distinct values of the undeduped walk', () => {
    const g = build();

    for (const [distinct, raw] of [
      [TWO_SEG, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.k AS x'],
      [THREE_SEG, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.k AS x'],
    ]) {
      const got = keysOf(query(g, distinct));
      const expected = [...new Set(keysOf(query(g, raw)))].sort();

      expect(got).toEqual(expected);
      // `-0` and `0` are ONE group and both render as `number:0`, so a fixture carrying both must
      // still yield a single key — the property `valueKey` exists to guarantee.
      expect(got.filter((k) => k === 'number:0').length).toBe(1);
    }
  });
});
