import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * The TRAIL corrections at depth 2, 3 and 4, against an independent enumerator (item 1453).
 *
 * `pairMultiplicities` existed to answer "how many parallel edges run from u to v", for the depth-4
 * trail correction. Item 1453 replaced it — a `Map` of one boxed-double key per edge, rebuilt per
 * query, with a CSR neighbour-slice scan that allocates nothing — worth **22-28% at 4/4 across two
 * degrees** on `quant44` and `varlen24`, with GC at a million nodes dropping 401.9 ms to 258.6.
 *
 * ⚠️ AND THE BENCH COULD NOT TEST THE ONE CASE THE FUNCTION EXISTS FOR. Instrumenting the original
 * counted, at both 100,000 and 1,000,000 nodes, **`dupes = 0`**: the fixture is a permutation at
 * `FANOUT=1..4` and has NO parallel edges, so every multiplicity is exactly 1 and the whole structure
 * carried no information. A change that returned a constant 1 would have measured as a 28% win and
 * passed every row in the bench. Nothing in this package exercised `{4,4}` or `{2,4}` either —
 * `shortest.test.ts` was the only file that mentioned those quantifiers at all.
 *
 * So the fixtures below are built the other way round: PARALLEL EDGES and SELF-LOOPS first, where
 * multiplicity is 2 and 3, and the oracle is an enumerator that walks every trail by hand.
 *
 * THE ORACLE IS NOT ANOTHER QUERY. A quantified `{k,k}` and an explicit k-hop chain differ by exactly
 * the trail rule (item 1401 measured that difference: `{2,2}` answers 799,996 where the chain answers
 * 800,000 at degree 4), so comparing them tests nothing about the correction — they are SUPPOSED to
 * disagree. `trails` below enumerates paths of exactly `k` edges with no edge repeated, which is the
 * ISO trail definition, independent of every route in the engine.
 */

/** Every trail of exactly `k` edges, counted by brute force. Vertices may repeat; edges may not. */
const trails = (g: Graph, k: number, type: string): number => {
  let total = 0;

  const walk = (at: ReturnType<Graph['addVertex']>, used: Set<string>, left: number): void => {
    if (left === 0) {
      total += 1;

      return;
    }

    const bucket = at.adjFrom?.get(type);

    if (bucket === undefined) {
      return;
    }

    for (const e of bucket) {
      if (used.has(e.id)) {
        continue;
      }

      used.add(e.id);
      walk(e.to, used, left - 1);
      used.delete(e.id);
    }
  };

  for (const v of g.vertices) {
    walk(v, new Set<string>(), k);
  }

  return total;
};

const countOf = (g: Graph, src: string): number => query<{ c: number }>(g, src)[0].c;

const quant = (k: number): string => `MATCH (a:P)-[:E]->{${k},${k}}(b:P) RETURN count(*) AS c`;

describe('PARALLEL EDGES, where multiplicity is more than 1 (item 1453)', () => {
  /** `a => b` twice and `b => c` three times: multiplicities 2 and 3 on one path. */
  const parallel = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: {} });

    g.addEdge({ id: 'ab1', from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ id: 'ab2', from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bc1', from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bc2', from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bc3', from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'cd', from: c, to: d, labels: ['E'], properties: {} });

    return g;
  };

  test('⚠️ depth 2, 3 and 4 all match the enumerator', () => {
    const g = parallel();

    for (const k of [1, 2, 3, 4]) {
      expect(countOf(g, quant(k))).toBe(trails(g, k, 'E'));
    }
  });

  test('and the counts are non-trivial, so the agreement means something', () => {
    // Asserted so a future fixture change that flattened this graph would be caught: `a=>b` twice
    // times `b=>c` three times is 6 two-hop trails through b alone.
    const g = parallel();

    expect(trails(g, 2, 'E')).toBeGreaterThan(6);
    expect(countOf(g, quant(3))).toBeGreaterThan(0);
  });
});

describe('SELF-LOOPS and back-edges, where a trail revisits a vertex (item 1453)', () => {
  /** A 2-cycle plus a self-loop plus a parallel pair — every way a trail can reuse a vertex. */
  const cyclic = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    g.addEdge({ id: 'aa', from: a, to: a, labels: ['E'], properties: {} });
    g.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ id: 'ba', from: b, to: a, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bc1', from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bc2', from: b, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'ca', from: c, to: a, labels: ['E'], properties: {} });

    return g;
  };

  test('⚠️ a trail may REVISIT a vertex but not an edge — depths 1 to 4', () => {
    // THE CASE THAT SEPARATES a trail from a simple path. `a -> b -> a -> b` is not a trail (it
    // reuses `ab`), but `a -> a -> b -> c` is. Only an edge-level enumerator gets this right, which
    // is why `trails` tracks edge ids rather than vertices.
    const g = cyclic();

    for (const k of [1, 2, 3, 4]) {
      expect(countOf(g, quant(k))).toBe(trails(g, k, 'E'));
    }
  });

  test('a lone self-loop gives exactly one trail at depth 1 and none deeper', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });

    g.addEdge({ id: 'aa', from: a, to: a, labels: ['E'], properties: {} });

    expect(countOf(g, quant(1))).toBe(1);
    expect(countOf(g, quant(2))).toBe(0);
    expect(countOf(g, quant(4))).toBe(0);
  });

  test('TWO self-loops on one vertex: depth 2 uses each once, in both orders', () => {
    // Multiplicity 2 on the pair (a, a) — the self-loop case of a parallel pair, which a
    // neighbour-slice scan must count as 2 and not collapse.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });

    g.addEdge({ id: 'aa1', from: a, to: a, labels: ['E'], properties: {} });
    g.addEdge({ id: 'aa2', from: a, to: a, labels: ['E'], properties: {} });

    expect(countOf(g, quant(1))).toBe(2);
    expect(countOf(g, quant(2))).toBe(trails(g, 2, 'E'));
    expect(trails(g, 2, 'E')).toBe(2);
  });
});

describe('the RANGE forms, where the correction is per level (item 1453)', () => {
  const ring = (): Graph => {
    const g = new Graph();
    const vs = Array.from({ length: 6 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: {} }),
    );

    for (let i = 0; i < 6; i += 1) {
      g.addEdge({ id: `r${i}`, from: vs[i], to: vs[(i + 1) % 6], labels: ['E'], properties: {} });
    }

    // A chord and a parallel edge, so degrees differ and multiplicity 2 appears.
    g.addEdge({ id: 'ch', from: vs[0], to: vs[3], labels: ['E'], properties: {} });
    g.addEdge({ id: 'par', from: vs[1], to: vs[2], labels: ['E'], properties: {} });

    return g;
  };

  test('⚠️ `{1,4}` is the SUM of the exact depths, which pins the per-level correction', () => {
    // Item 602's distinction: a correction applied once for the whole range answers `{3,3}` right
    // and `{1,3}` wrong. So the range must equal the sum of its levels, each checked against the
    // enumerator independently.
    const g = ring();
    const perLevel = [1, 2, 3, 4].map((k) => trails(g, k, 'E'));

    for (const [i, k] of [1, 2, 3, 4].entries()) {
      expect(countOf(g, quant(k))).toBe(perLevel[i]);
    }

    expect(countOf(g, 'MATCH (a:P)-[:E]->{1,4}(b:P) RETURN count(*) AS c')).toBe(
      perLevel.reduce((x, y) => x + y, 0),
    );
  });

  test('`{2,4}` is the sum of levels 2 to 4 — the bench row this item measured', () => {
    const g = ring();
    const sum = [2, 3, 4].map((k) => trails(g, k, 'E')).reduce((x, y) => x + y, 0);

    expect(countOf(g, 'MATCH (a:P)-[:E]->{2,4}(b:P) RETURN count(*) AS c')).toBe(sum);
  });
});

describe('a NON-EDGE pair must answer zero, not a stale count (item 1453)', () => {
  test('⚠️ two components, so most pairs have no edge at all', () => {
    // The slice scan answers 0 for a pair it never finds, where the `Map` answered 0 via `?? 0`.
    // A scan that fell through to the wrong slice would over-count here, and a disconnected fixture
    // is where that shows: no trail may cross between the components.
    const g = new Graph();
    const l = Array.from({ length: 4 }, (_, i) =>
      g.addVertex({ id: `l${i}`, labels: ['P'], properties: {} }),
    );
    const r = Array.from({ length: 4 }, (_, i) =>
      g.addVertex({ id: `r${i}`, labels: ['P'], properties: {} }),
    );

    for (let i = 0; i < 3; i += 1) {
      g.addEdge({ id: `le${i}`, from: l[i], to: l[i + 1], labels: ['E'], properties: {} });
      g.addEdge({ id: `re${i}`, from: r[i], to: r[i + 1], labels: ['E'], properties: {} });
    }

    for (const k of [1, 2, 3, 4]) {
      expect(countOf(g, quant(k))).toBe(trails(g, k, 'E'));
    }

    // Each component is a 4-path: 3 one-hop, 2 two-hop, 1 three-hop, 0 four-hop trails.
    expect(countOf(g, quant(3))).toBe(2);
    expect(countOf(g, quant(4))).toBe(0);
  });
});
