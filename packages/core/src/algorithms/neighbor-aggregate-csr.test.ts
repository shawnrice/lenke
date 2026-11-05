import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { neighborAggregate } from './neighbor-aggregate.js';

/**
 * Item 1469 replaced `neighborAggregate`'s `Map<string, {eidx, nbr}[]>` adjacency with two flat
 * CSRs and its per-vertex `sort` with a two-pointer merge. The existing eight tests cover ops,
 * directions, weights and `gcn` on tiny graphs but none of the three things that rewrite could
 * silently break:
 *
 *  1. **the `eidx` ↔ weight association.** `edgeWeights` is indexed by the index over EVERY edge,
 *     not only the type-matching ones, so if the CSR stored a filtered-local index instead, every
 *     weight would pair with the wrong edge. A fixture needs a type filter AND distinct weights for
 *     this to be observable at all.
 *  2. **the self-loop rule** — a `both`-direction self-loop counts ONCE, which the merge now
 *     enforces by dropping the in-copy rather than by filtering before a sort.
 *  3. **the accumulation order**, which under `sum`/`mean` is also the float summation order.
 *
 * The last test is an independent oracle: contributors re-derived by scanning `graph.edges` in
 * order, transcribing the documented rules rather than calling anything the implementation uses.
 */

const addV = (g: Graph, id: string, feat: number[] | null): void => {
  g.addVertex({
    id,
    labels: ['N'],
    properties: feat === null ? {} : { f: feat },
  });
};

const addE = (g: Graph, from: string, to: string, labels: string[], w?: number): void => {
  g.addEdge({
    from: g.getVertexById(from)!,
    to: g.getVertexById(to)!,
    labels,
    properties: w === undefined ? {} : { w },
  });
};

const vec = (rows: { node: string; vector: number[] }[]): Record<string, number[]> =>
  Object.fromEntries(rows.map((r) => [r.node, r.vector]));

describe('the eidx ↔ weight association survives a type filter', () => {
  test('weights come from the GLOBAL edge index, not a filtered-local one', async () => {
    // Edge order: 0 = a->b type X (w 100), 1 = a->c type E (w 2), 2 = a->d type E (w 3).
    // With edgeLabel 'E' only edges 1 and 2 contribute. A filtered-local index would read weights
    // 100 and 2 instead of 2 and 3 — the exact failure this fixture exists to catch.
    const g = new Graph();

    addV(g, 'a', [0]);
    addV(g, 'b', [1]);
    addV(g, 'c', [1]);
    addV(g, 'd', [1]);
    addE(g, 'a', 'b', ['X'], 100);
    addE(g, 'a', 'c', ['E'], 2);
    addE(g, 'a', 'd', ['E'], 3);

    const rows = vec(
      await neighborAggregate(
        { feature: 'f', op: 'sum', direction: 'out', edgeLabel: 'E', weightProperty: 'w' },
        g,
      ),
    );

    // 2*[1] + 3*[1] = [5]. Reading weight 100 anywhere would be unmissable.
    expect(rows.a).toEqual([5]);
  });

  test('an interleaved filter keeps each surviving edge with its own weight', async () => {
    const g = new Graph();

    addV(g, 'a', [0, 0]);
    addV(g, 'b', [1, 0]);
    addV(g, 'c', [0, 1]);

    addE(g, 'a', 'b', ['E'], 5);
    addE(g, 'a', 'b', ['X'], 999);
    addE(g, 'a', 'c', ['E'], 7);

    const rows = vec(
      await neighborAggregate(
        { feature: 'f', op: 'sum', direction: 'out', edgeLabel: 'E', weightProperty: 'w' },
        g,
      ),
    );

    expect(rows.a).toEqual([5, 7]);
  });
});

describe('the self-loop rule', () => {
  test('a both-direction self-loop counts ONCE', async () => {
    const g = new Graph();

    addV(g, 'a', [2]);
    addE(g, 'a', 'a', ['E']);

    // Counted once → sum is [2], not [4].
    expect(
      vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'both' }, g)).a,
    ).toEqual([2]);
  });

  test('…and once in each single direction too', async () => {
    const g = new Graph();

    addV(g, 'a', [2]);
    addE(g, 'a', 'a', ['E']);

    for (const direction of ['out', 'in'] as const) {
      expect(vec(await neighborAggregate({ feature: 'f', op: 'sum', direction }, g)).a).toEqual([
        2,
      ]);
    }
  });

  test('a self-loop contributes to the gcn degree exactly once', async () => {
    const g = new Graph();

    addV(g, 'a', [4]);
    addV(g, 'b', [0]);
    addE(g, 'a', 'a', ['E']);
    addE(g, 'a', 'b', ['E']);

    // deg(a) = 2 contributors (the self-loop ONCE, plus b), deg(b) = 1 (a, via the in-edge).
    // a's aggregate = 1/sqrt(2*2)*[4] + 1/sqrt(2*1)*[0] = 0.5*4 = [2].
    //
    // The load-bearing number is deg(a) = 2. Were the self-loop counted twice it would be 3, and
    // a's aggregate 1/sqrt(3*3)*4 + 1/sqrt(3*3)*4 = 2.667 — so this value pins the rule.
    const rows = vec(
      await neighborAggregate({ feature: 'f', op: 'sum', direction: 'both', norm: 'gcn' }, g),
    );

    expect(rows.a[0]).toBeCloseTo(2, 12);
  });

  test('a self-loop PLUS a parallel self-loop counts twice', async () => {
    const g = new Graph();

    addV(g, 'a', [2]);
    addE(g, 'a', 'a', ['E']);
    addE(g, 'a', 'a', ['E']);

    expect(
      vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'both' }, g)).a,
    ).toEqual([4]);
  });
});

describe('the accumulation ORDER, pinned by float cancellation', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. Replacing the eidx merge with a plain
   * concatenation (every out-contributor, then every in-contributor) leaves the contributor
   * MULTISET identical, so all 23 other tests passed — small integer features sum exactly, and an
   * exact sum does not care about order.
   *
   * But that order IS the contract: it is the canonical, engine-independent accumulation order, and
   * under `sum`/`mean` it is also the float summation order, so permuting it diverges from the
   * native engine in the result bytes. Pinning it needs values where float addition is not
   * associative.
   *
   * Edges in insertion order: e0 = v->a (out), e1 = b->v (in), e2 = v->c (out).
   *   merge by eidx  → a, b, c → ((1e16) + 1) + (-1e16) = 1e16 - 1e16 = 0
   *   concatenation  → a, c, b → ((1e16) + (-1e16)) + 1 = 0 + 1 = 1
   */
  test('contributors fold in edge-index order, interleaving the two directions', async () => {
    const g = new Graph();

    addV(g, 'v', [0]);
    addV(g, 'a', [1e16]);
    addV(g, 'b', [1]);
    addV(g, 'c', [-1e16]);

    addE(g, 'v', 'a', ['E']);
    addE(g, 'b', 'v', ['E']);
    addE(g, 'v', 'c', ['E']);

    const rows = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'both' }, g));

    // 0 is the merge order. A concatenation of out-then-in would give exactly 1.
    expect(rows.v).toEqual([0]);
  });
});

describe('multiplicity and direction', () => {
  test('parallel edges each contribute', async () => {
    const g = new Graph();

    addV(g, 'a', [0]);
    addV(g, 'b', [3]);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'b', ['E']);

    expect(
      vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'out' }, g)).a,
    ).toEqual([6]);
  });

  test('out / in / both are distinguished on an asymmetric graph', async () => {
    const g = new Graph();

    addV(g, 'a', [0]);
    addV(g, 'b', [1]);
    addV(g, 'c', [10]);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'c', 'a', ['E']);

    const out = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'out' }, g));
    const inn = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'in' }, g));
    const both = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'both' }, g));

    expect(out.a).toEqual([1]);
    expect(inn.a).toEqual([10]);
    expect(both.a).toEqual([11]);
  });

  test('a vertex with a null feature contributes nothing but still gets a row', async () => {
    const g = new Graph();

    addV(g, 'a', [0]);
    addV(g, 'b', null);
    addV(g, 'c', [5]);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'a', 'c', ['E']);

    const rows = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction: 'out' }, g));

    expect(rows.a).toEqual([5]);
    expect(rows.b).toEqual([0]);
  });

  test('an isolated vertex and an empty graph', async () => {
    expect(await neighborAggregate({ feature: 'f' }, new Graph())).toEqual([]);

    const g = new Graph();

    addV(g, 'a', [7]);
    expect(vec(await neighborAggregate({ feature: 'f', op: 'sum' }, g)).a).toEqual([0]);
  });
});

describe('an independent oracle over a generated graph', () => {
  /**
   * Contributors re-derived by scanning `graph.edges` in order — a transcription of the documented
   * rules (out-targets and in-sources, ascending edge index, a `both` self-loop once), sharing
   * nothing with the CSR the implementation builds. This is what makes the merge testable: it
   * validates the ORDER as well as the multiset.
   */
  const oracle = (
    g: Graph,
    feats: Map<string, number[]>,
    wantOut: boolean,
    wantIn: boolean,
    weights: number[] | undefined,
  ): Record<string, number[]> => {
    const ids = [...g.vertices].map((v) => v.id);
    const result: Record<string, number[]> = {};

    for (const v of ids) {
      const contributors: { eidx: number; nbr: string }[] = [];
      let eidx = 0;

      for (const edge of g.edges) {
        const from = edge.fromId;
        const to = edge.toId;

        if (wantOut && from === v) {
          contributors.push({ eidx, nbr: to });
        }

        // the in-copy of a self-loop is dropped whenever the out-copy was taken
        if (wantIn && to === v && !(wantOut && from === v)) {
          contributors.push({ eidx, nbr: from });
        }

        eidx += 1;
      }

      contributors.sort((x, y) => x.eidx - y.eidx);

      const acc = [0, 0];

      for (const c of contributors) {
        const f = feats.get(c.nbr)!;
        const w = weights === undefined ? 1 : weights[c.eidx];

        acc[0] += w * f[0];
        acc[1] += w * f[1];
      }

      result[v] = acc;
    }

    return result;
  };

  const build = (seed: number, n: number, edges: number) => {
    const g = new Graph();
    const feats = new Map<string, number[]>();
    let s = seed;
    const next = (m: number): number => {
      // a plain 32-bit LCG in integer space — CLAUDE.md item 702: an f64 LCG whose multiply passes
      // 2^53 collapses its period to ~11k draws and looks perfectly fine while doing it
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;

      return s % m;
    };

    for (let i = 0; i < n; i += 1) {
      const f = [next(9), next(9)];

      feats.set(`v${i}`, f);
      addV(g, `v${i}`, f);
    }

    const weights: number[] = [];

    for (let e = 0; e < edges; e += 1) {
      // ⚠️ SELF-LOOPS AND PARALLEL EDGES ARE INJECTED, NOT LEFT TO CHANCE. Drawing `from` and `to`
      // independently produced ZERO self-loops across 120 edges — the LCG's low bits mod 40 never
      // collide on consecutive draws — so the self-loop rule the oracle exists to check was never
      // exercised at all. The fixture-statistics test below is what caught it.
      const from = next(n);
      const to = e % 7 === 0 ? from : next(n);
      const w = next(5) + 1;

      weights.push(w);
      // two types, so the filtered runs exercise a sparse global eidx
      addE(g, `v${from}`, `v${to}`, [e % 3 === 0 ? 'X' : 'E'], w);
    }

    // a guaranteed parallel pair, so the multiplicity path is exercised whatever the draws do
    weights.push(2, 3);
    addE(g, 'v0', 'v1', ['E'], 2);
    addE(g, 'v0', 'v1', ['E'], 3);

    return { g, feats, weights };
  };

  for (const direction of ['out', 'in', 'both'] as const) {
    test(`matches the oracle, direction=${direction}`, async () => {
      const { g, feats } = build(7, 40, 120);
      const wantOut = direction === 'out' || direction === 'both';
      const wantIn = direction === 'in' || direction === 'both';
      const got = vec(await neighborAggregate({ feature: 'f', op: 'sum', direction }, g));
      const want = oracle(g, feats, wantOut, wantIn, undefined);

      for (const id of Object.keys(want)) {
        expect(got[id]).toEqual(want[id]);
      }
    });
  }

  test('matches the oracle with weights (the global-eidx pairing, at scale)', async () => {
    const { g, feats, weights } = build(11, 40, 120);
    const got = vec(
      await neighborAggregate(
        { feature: 'f', op: 'sum', direction: 'both', weightProperty: 'w' },
        g,
      ),
    );
    const want = oracle(g, feats, true, true, weights);

    for (const id of Object.keys(want)) {
      expect(got[id]).toEqual(want[id]);
    }
  });

  test('self-loops and parallel edges are present in the generated fixture', () => {
    // An invariant that cannot validate itself is worthless (CLAUDE.md): if the generator produced
    // neither, the oracle tests above would never exercise the self-loop rule at all.
    const { g } = build(7, 40, 120);
    let selfLoops = 0;
    const seen = new Set<string>();
    let parallel = 0;

    for (const edge of g.edges) {
      if (edge.fromId === edge.toId) {
        selfLoops += 1;
      }

      const key = `${edge.fromId}->${edge.toId}`;

      if (seen.has(key)) {
        parallel += 1;
      }

      seen.add(key);
    }

    expect(selfLoops).toBeGreaterThan(0);
    expect(parallel).toBeGreaterThan(0);
  });
});
