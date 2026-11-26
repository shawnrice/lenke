/*
 * Item 2410 — A SILENT WRONG ANSWER: the chain level fold answered an aggregate over a NON-FAR
 * variable, and `foldLevel` binds the far variable and nothing else.
 *
 * ```text
 *   MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN count(a.n)
 *       before   0        over 16 paths whose `a.n` is never null
 *       after    16
 * ```
 *
 * **NOT A DECLINE — AN ANSWER, AND A FAST ONE.** `a` is unbound inside the per-vertex pass, so
 * `a.n` evaluated to `undefined`, became `null`, and was excluded as a null: `count` answered 0 and
 * `min`/`max`/`sum`/`avg` answered `null`. Every one of those is a plausible-looking value, which is
 * why no fixture caught it for 400 items.
 *
 * **THE CONDITION, NOT THE QUERY — which is what this file is built around.** The defect needs
 * BOTH halves at once: a chain the level fold ADMITS (plain directed single-type hops, no
 * relationship variable, no `WHERE`, no inline properties, no union types, no label expression) AND
 * an aggregate whose argument reads something other than the far node. Change either half and the
 * query is correct, because it falls to the path-walk rung that binds every variable. So a test that
 * merely aggregates over a chain passes against the broken gate — and most of this suite did.
 *
 * THE FIXTURE IS LAYERED, NOT A RING, AND THAT IS LOAD-BEARING. On a ring every vertex is both a
 * start and a far end, so `min(a.n)` and `min(d.n)` COINCIDE and a near-arg test is satisfied by the
 * far-arg answer. Four disjoint layers make every variable's value set disjoint from every other's,
 * so each assertion below can only be met by binding the variable it names.
 *
 * EVERY `near` TEST HERE HAS A `far` CONTROL THAT STAYS ON THE FOLD. Mutating the fix away must
 * leave those passing — otherwise the pair says "something changed" rather than "this changed".
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Four layers of two vertices each, every vertex of a layer pointing at BOTH vertices of the next.
 *
 * FANOUT 2 is deliberate: it gives the level recurrence a multiplicity greater than 1 at every
 * reached vertex, so the arm under test is the weighted one item 2409 shipped and not a degenerate
 * `u_v = 1` pass that cannot tell a weighted fold from a plain one.
 *
 * The 3-hop chain `(a)-[:E]->(b)-[:E]->(c)-[:E]->(d)` therefore matches exactly `2·2·2·2 = 16`
 * paths — L0 → L1 → L2 → L3 — and each individual vertex lies on 8 of them. Those two facts make
 * every expectation below hand-checkable rather than re-derived from a walk.
 */
const layered = (startNull = false): Graph => {
  const g = new Graph();
  // A null START value is built IN, not assigned after: `addVertex` freezes the property bag, so
  // `v.properties.n = null` throws rather than mutating (and a test that did it inside a try would
  // silently assert nothing).
  const layers: (number | null)[][] = [
    [startNull ? null : 10, 20], // a — the START, and the value set nothing else shares
    [1, 2], // b — the first middle
    [3, 4], // c — the second middle
    [100, 200], // d — the FAR end
  ];

  for (const [li, vals] of layers.entries()) {
    for (const [vi, n] of vals.entries()) {
      g.addVertex({ id: `L${li}-${vi}`, labels: ['P'], properties: { n } });
    }
  }

  for (let li = 0; li + 1 < layers.length; li += 1) {
    for (let from = 0; from < layers[li].length; from += 1) {
      for (let to = 0; to < layers[li + 1].length; to += 1) {
        g.addEdge({
          id: `e${li}-${from}-${to}`,
          from: g.getVertexById(`L${li}-${from}`)!,
          to: g.getVertexById(`L${li + 1}-${to}`)!,
          labels: ['E'],
          properties: {},
        });
      }
    }
  }

  return g;
};

const CHAIN3 = '(a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P)';

const one = (g: Graph, text: string): unknown => {
  const rows = query(g, text, {}) as Record<string, unknown>[];

  expect(rows).toHaveLength(1);

  return rows[0].x;
};

describe('item 2410 — an aggregate over a non-far variable on the chain level fold', () => {
  /*
   * THE PATH COUNT IS ESTABLISHED FIRST AND FROM THE ROW FORM, because every expectation below is
   * a statement about it. `count(a.n)` answering 0 is only a defect once the walk is known to have
   * 16 paths carrying a non-null `a.n`; asserting the 16 separately is what makes the rest readable.
   */
  test('the fixture has 16 paths and every variable is non-null on all of them', () => {
    expect(query(layered(), `MATCH ${CHAIN3} RETURN a.n AS x`, {})).toHaveLength(16);

    for (const v of ['a', 'b', 'c', 'd']) {
      const rows = query(layered(), `MATCH ${CHAIN3} RETURN ${v}.n AS x`, {}) as {
        x: unknown;
      }[];

      expect(rows).toHaveLength(16);
      expect(rows.filter((r) => r.x === null || r.x === undefined)).toHaveLength(0);
    }
  });

  /*
   * THE DEFECT ITSELF, one aggregate per row of the table item 1830 wrote. The `before` column is
   * what each answered with the check missing.
   *
   *     count(a.n)   0      -> 16
   *     min(a.n)     null   -> 10
   *     max(a.n)     null   -> 20
   *     sum(a.n)     null   -> 240   (8 paths x 10  +  8 paths x 20)
   *     avg(a.n)     null   -> 15
   */
  test.each([
    ['count', 16],
    ['min', 10],
    ['max', 20],
    ['sum', 240],
    ['avg', 15],
  ])('%s over the START variable answers the paths, not null', (fn, want) => {
    expect(one(layered(), `MATCH ${CHAIN3} RETURN ${fn}(a.n) AS x`)).toBe(want);
  });

  /*
   * **THE CONTROL, AND IT MUST SURVIVE THE MUTANT.** The far end is what the fold is FOR, and
   * item 2409's weighted arm answers it. Every number here is the same arithmetic over a different
   * variable, so if a mutant that removes the fix breaks these too, the pair proves nothing about
   * which variable was bound.
   */
  test.each([
    ['count', 16],
    ['min', 100],
    ['max', 200],
    ['sum', 2400],
    ['avg', 150],
  ])('CONTROL: %s over the FAR variable is unchanged and stays on the fold', (fn, want) => {
    expect(one(layered(), `MATCH ${CHAIN3} RETURN ${fn}(d.n) AS x`)).toBe(want);
  });

  /*
   * A MIDDLE variable is the same defect and is tested separately, because a fix that compared
   * against "the START variable" rather than "the far variable" would pass every test above and
   * still answer these wrongly. `b` and `c` each lie on 8 of the 16 paths.
   */
  test.each([
    ['b', 'sum', 24], // 8 x 1  +  8 x 2
    ['b', 'min', 1],
    ['b', 'count', 16],
    ['c', 'sum', 56], // 8 x 3  +  8 x 4
    ['c', 'min', 3],
    ['c', 'count', 16],
  ])('%s is a MIDDLE variable, so %s(%s.n) is not the far end either', (v, fn, want) => {
    expect(one(layered(), `MATCH ${CHAIN3} RETURN ${fn}(${v}.n) AS x`)).toBe(want);
  });

  /*
   * TWO HOPS AS WELL AS THREE. The level fold admits both widths, and a fix applied at one is
   * item 1822's situation — the unfixed neighbour becomes the anomaly. Expectations come from the
   * row form here rather than by hand, because a 2-hop chain over four layers matches L0→L1→L2 AND
   * L1→L2→L3 and the hand count is the part that would go wrong.
   */
  test.each([['a'], ['b'], ['c']])('two hops: sum and count over %s agree with its rows', (v) => {
    const g = layered();
    const chain2 = '(a:P)-[:E]->(b:P)-[:E]->(c:P)';
    const rows = query(g, `MATCH ${chain2} RETURN ${v}.n AS x`, {}) as { x: number }[];
    const exact = rows.reduce((t, r) => t + r.x, 0);

    expect(rows.length).toBeGreaterThan(1);
    expect(one(g, `MATCH ${chain2} RETURN count(${v}.n) AS x`)).toBe(rows.length);
    expect(one(g, `MATCH ${chain2} RETURN sum(${v}.n) AS x`)).toBe(exact);
  });

  /*
   * NULL EXCLUSION IS THE TRAP THAT MADE THE DEFECT INVISIBLE, so it is pinned on the near-arg
   * path too. The wrong answer WAS a null exclusion — every `a.n` read `undefined`, so `count`
   * excluded all 16 and answered 0. A fixture where the start genuinely carries a null must
   * therefore exclude exactly that one vertex's paths and no others.
   */
  test('a genuine null on the START variable excludes only its own paths', () => {
    const g = layered(true);

    // L0-1 (n = 20) still lies on 8 of the 16 paths; L0-0's 8 are excluded by the null rule.
    expect(one(g, `MATCH ${CHAIN3} RETURN count(a.n) AS x`)).toBe(8);
    expect(one(g, `MATCH ${CHAIN3} RETURN sum(a.n) AS x`)).toBe(160);
    expect(one(g, `MATCH ${CHAIN3} RETURN min(a.n) AS x`)).toBe(20);
    // CONTROL: the far end is untouched by a null at the start, and all 16 paths survive.
    expect(one(g, `MATCH ${CHAIN3} RETURN count(d.n) AS x`)).toBe(16);
    expect(one(g, `MATCH ${CHAIN3} RETURN sum(d.n) AS x`)).toBe(2400);
  });

  /*
   * AN EXPRESSION MIXING THE TWO is the shape a `reads.size === 1` test must also refuse, and it
   * is not covered by any single-variable case above: `sum(a.n + d.n)` reads BOTH, so the far
   * variable IS among its free variables and a check that merely asked "does it read the far node"
   * would admit it and silently drop `a.n`.
   */
  test('an argument reading the far node AND another variable is not admitted', () => {
    const g = layered();
    const rows = query(g, `MATCH ${CHAIN3} RETURN a.n + d.n AS x`, {}) as { x: number }[];

    expect(rows).toHaveLength(16);
    expect(one(g, `MATCH ${CHAIN3} RETURN sum(a.n + d.n) AS x`)).toBe(
      rows.reduce((t, r) => t + r.x, 0),
    );
    // CONTROL: the far node alone in an expression still folds, so the refusal is about the OTHER
    // variable rather than about the expression being compound.
    expect(one(g, `MATCH ${CHAIN3} RETURN sum(d.n + 1) AS x`)).toBe(2400 + 16);
  });
});
