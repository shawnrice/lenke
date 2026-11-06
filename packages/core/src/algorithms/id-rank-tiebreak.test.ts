import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import { idRank } from './adjacency.js';
import { runAlgorithmSync } from './run-sync.js';

/**
 * `idRank` — the integer rank in EXTERNAL-ID order that `labelPropagation` and `peerPressure` use to
 * break a tie, instead of reading `Vertex.id` twice and comparing strings (item 1625).
 *
 * **1.16x/1.24x on `labelPropagation` and 1.17x/1.47x on `peerPressure`**, eleven sibling algorithms
 * flat. The tie-break was 20% of `labelPropagation` by ablation.
 *
 * ⚠️ THE TIE-BREAK IS A CONTRACT, not an implementation detail: ISO-less though it is, both engines
 * agree on "tie → lexicographically smallest external id", so the rank's order has to BE that order.
 * The risk is not that ranking is slow — it is that `rank[a] < rank[b]` and `ids[a] < ids[b]` could
 * disagree. Every test here is about that.
 *
 * ⚠️ AND THE FIXTURE IDS ARE CHOSEN SO LEXICOGRAPHIC AND NUMERIC ORDER DIFFER. `'v10' < 'v9'`
 * lexicographically and `10 > 9` numerically, so an implementation that ranked by insertion index,
 * by a numeric parse, or by anything other than the string compare answers differently. A fixture of
 * `v0..v9` could not tell them apart.
 */
const build = (ids: readonly string[], edges: readonly (readonly [string, string])[]): Graph => {
  const g = new Graph();

  for (const id of ids) {
    g.addVertex({ id, labels: ['P'], properties: {} });
  }

  edges.forEach(([from, to], i) => {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(from) as Vertex,
      to: g.getVertexById(to) as Vertex,
      labels: ['E'],
      properties: {},
    });
  });

  return g;
};

describe('idRank orders by external id', () => {
  test('⚠️ LEXICOGRAPHIC, not numeric and not insertion order', () => {
    // Inserted in numeric order; `'v10' < 'v2'` lexicographically, so the ranks are NOT 0,1,2,3.
    const g = build(['v1', 'v2', 'v10', 'v20'], []);
    const order = [...g.vertices];
    const rank = idRank(order);
    const byRank = [...order]
      .map((v, i) => ({ id: v.id, r: rank[i] }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.id);

    expect(byRank).toEqual(['v1', 'v10', 'v2', 'v20']);
    // And it agrees with a direct string sort, which is the property the loops rely on.
    expect(byRank).toEqual(order.map((v) => v.id).sort());
  });

  test('rank[a] < rank[b] IFF id[a] < id[b], over every pair', () => {
    const ids = ['b', 'a', 'z', 'A', 'Z', '0', 'aa', 'ab', 'B', '', '~', 'é'];
    const g = build(
      ids.filter((x) => x !== ''),
      [],
    );
    const order = [...g.vertices];
    const rank = idRank(order);

    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(rank[i] < rank[j]).toBe(order[i].id < order[j].id);
      }
    }
  });

  test('ranks are a PERMUTATION of 0..n-1 — no duplicate, no gap', () => {
    const g = build(['c', 'a', 'b', 'aa'], []);
    const rank = idRank([...g.vertices]);

    expect([...rank].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  test('an empty graph and a single vertex', () => {
    expect([...idRank([])]).toEqual([]);
    expect([...idRank([...build(['only'], []).vertices])]).toEqual([0]);
  });
});

describe('the tie-break the rank replaces, end to end', () => {
  /**
   * ⚠️ A FIXTURE WHERE THE TIE IS FORCED AND THE WINNER IS NOT THE FIRST-SEEN. `x` has exactly two
   * neighbours, so after round one they carry two distinct labels each counted ONCE — a tie — and
   * the contract says `x` adopts the lexicographically smaller external id. The neighbours are
   * inserted so that the SMALLER id is seen SECOND, which is what makes the test discriminate: an
   * implementation that kept the first-seen candidate (the ablation this item priced) answers the
   * other one.
   */
  const tied = (): Graph =>
    build(
      ['x', 'v9', 'v10'],
      [
        ['x', 'v9'],
        ['x', 'v10'],
      ],
    );

  test('labelPropagation adopts the lexicographically smaller id', () => {
    const rows = runAlgorithmSync('labelPropagation', { edgeLabel: 'E', iterations: 1 }, tied());
    const got = Object.fromEntries(
      (rows as unknown as Record<string, unknown>[]).map((r) => [r.node, r.label]),
    );

    // `'v10' < 'v9'`, so `x` takes `v10` — the one inserted LAST.
    expect(got.x).toBe('v10');
  });

  test('peerPressure adopts the lexicographically smaller id', () => {
    /**
     * `peerPressure` votes along IN-edges, so the tie has to be built on the in-side: `v9` and `v10`
     * both point AT `x`, each with out-degree 1, so each contributes an equal vote.
     */
    const g = build(
      ['x', 'v9', 'v10'],
      [
        ['v9', 'x'],
        ['v10', 'x'],
      ],
    );
    const rows = runAlgorithmSync('peerPressure', { edgeLabel: 'E', iterations: 1 }, g);
    const got = Object.fromEntries(
      (rows as unknown as Record<string, unknown>[]).map((r) => [r.node, r.cluster]),
    );

    expect(got.x).toBe('v10');
  });

  test('a THREE-way tie still picks the smallest of the three', () => {
    const g = build(
      ['x', 'v9', 'v10', 'v100'],
      [
        ['x', 'v9'],
        ['x', 'v10'],
        ['x', 'v100'],
      ],
    );
    const rows = runAlgorithmSync('labelPropagation', { edgeLabel: 'E', iterations: 1 }, g);
    const got = Object.fromEntries(
      (rows as unknown as Record<string, unknown>[]).map((r) => [r.node, r.label]),
    );

    // `'v10' < 'v100' < 'v9'`.
    expect(got.x).toBe('v10');
  });

  test('⚠️ the COUNT is the PRIMARY key — the tie-break only decides ties', () => {
    /**
     * ⚠️ THIS TEST EXISTS BECAUSE THE MUTATION PASS FOUND THE GAP. `c > bestCount` dropped from the
     * condition SURVIVED the whole `core` suite, and it is a PRE-EXISTING gap — item 1625 did not
     * touch the count, only the tie-break beside it. (My first attempt at this test guessed a
     * fixture and oscillated; label propagation on a small graph is not predictable by eye, so this
     * one is DERIVED from the round-by-round labels instead.)
     *
     * The construction, with `iterations: 1` giving every vertex its own label:
     *
     * ```text
     *    a—p, a—q      so after round 1 both p and q carry `a`  (their other neighbour is `x`,
     *                  and `'a' < 'x'`, so the tie at p and q resolves to `a`)
     *    A—r           so after round 1 `r` carries `A`          (`'A' < 'x'`)
     *    x—p, x—q, x—r so at round 2 `x` sees {a, a, A}
     * ```
     *
     * Count says `a` (two votes); the tie-break alone would say `A` (uppercase sorts first). They
     * DISAGREE, which is the whole point — a fixture where both rules give the same answer cannot
     * tell a count-ignoring implementation from a correct one.
     */
    const g = build(
      ['x', 'p', 'q', 'r', 'a', 'A'],
      [
        ['a', 'p'],
        ['a', 'q'],
        ['A', 'r'],
        // ⚠️ `x—r` FIRST, and the EDGE ORDER IS LOAD-BEARING. The dirty list is built in first-
        // sighting order, so the mutant that drops `c > bestCount` only differs when the MAJORITY
        // label is seen SECOND: with `x—p, x—q` first the best is already `a` and the condition is
        // never re-tested. My first version of this fixture had that order and the mutant SURVIVED
        // the new test — the fixture discriminated nothing until the minority neighbour came first.
        ['x', 'r'],
        ['x', 'p'],
        ['x', 'q'],
      ],
    );
    const labelOf = (iterations: number): Record<string, unknown> =>
      Object.fromEntries(
        (
          runAlgorithmSync(
            'labelPropagation',
            { edgeLabel: 'E', iterations },
            g,
          ) as unknown as Record<string, unknown>[]
        ).map((r) => [r.node, r.label]),
      );

    // Round 1 sets up the majority; asserted so a change to the setup is visible here too.
    expect(labelOf(1)).toEqual({ x: 'p', p: 'a', q: 'a', r: 'A', a: 'p', A: 'r' });
    // Round 2: `a` wins 2-1 over `A`, even though `'A' < 'a'`.
    expect(labelOf(2).x).toBe('a');
  });

  test('⚠️ peerPressure: ENERGY is the primary key, the same gap and the same shape', () => {
    /**
     * `peerPressure` votes along IN-edges with each source contributing `1 / outdegree`, so the
     * primary key is summed energy rather than a count — and `e > bestE` dropped SURVIVED too.
     *
     * Directed analogue of the fixture above, derived from the round-by-round clusters: `p` and `q`
     * both carry `a` after round 1, `r` carries `A`, and all three point at `x`, each with
     * outdegree 1 — so `a` has twice `A`'s energy at `x`.
     */
    const g = build(
      ['x', 'p', 'q', 'r', 'a', 'A'],
      [
        ['a', 'p'],
        ['a', 'q'],
        ['A', 'r'],
        // `r -> x` FIRST, for the reason the twin above records: the minority must be seen first.
        ['r', 'x'],
        ['p', 'x'],
        ['q', 'x'],
      ],
    );
    const clusterOf = (iterations: number): Record<string, unknown> =>
      Object.fromEntries(
        (
          runAlgorithmSync('peerPressure', { edgeLabel: 'E', iterations }, g) as unknown as Record<
            string,
            unknown
          >[]
        ).map((r) => [r.node, r.cluster]),
      );

    expect(clusterOf(1)).toEqual({ x: 'p', p: 'a', q: 'a', r: 'A', a: 'a', A: 'A' });
    expect(clusterOf(2).x).toBe('a');
  });
});
