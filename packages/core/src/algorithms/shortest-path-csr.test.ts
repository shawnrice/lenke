import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { shortestPath } from './shortest-path.js';

/**
 * Item 1470 replaced `shortestPath`'s per-settled-vertex generator chain (`neighbours` delegating to
 * `incidentEdges`, yielding a tuple per edge, with a string-keyed `index.get` per step) with one flat
 * CSR built once. The existing twelve tests cover the routes and the negative-weight guard; these
 * cover what the CSR itself could get wrong.
 *
 * ⚠️ THE SHARPEST RISK IS A SIZE/FILL DISAGREEMENT. The CSR is sized by `countIncidentEdges` and
 * filled by `incidentEdges`, and both dedupe an edge carrying several labels. If the sizing had used
 * the non-deduping flat count instead, a two-label edge would reserve two slots and only one would be
 * written — leaving a slot holding **0**, which reads as a spurious edge to vertex index 0 and
 * invents a path. That is a wrong answer, not a crash, so it needs its own fixture.
 */

const addV = (g: Graph, ids: string[]): void => {
  for (const id of ids) {
    g.addVertex({ id, labels: ['N'] });
  }
};

const addE = (g: Graph, from: string, to: string, labels: string[], w?: number): void => {
  g.addEdge({
    from: g.getVertexById(from)!,
    to: g.getVertexById(to)!,
    labels,
    properties: w === undefined ? {} : { w },
  });
};

/**
 * ⚠️ AN UNREACHABLE VERTEX GETS NO ROW AT ALL — `computeGen` filters on `Number.isFinite`, so the
 * absence of a key is how unreachability is expressed, not a stored `Infinity`. Asserting
 * `Infinity` fails with `undefined`, which is what seven of these tests did on their first run.
 */
const dist = (rows: { node: string; distance: number }[]): Record<string, number | undefined> =>
  Object.fromEntries(rows.map((r) => [r.node, r.distance]));

describe('a multi-label edge reserves and fills exactly one slot', () => {
  test('an unreachable vertex stays unreachable (no slot holding a stale 0)', async () => {
    // v0 is the SOURCE, so a stale 0 slot would read as an edge back to the source — harmless.
    // Making 'zz' the source and putting the multi-label edge far from it means a stale slot
    // instead invents an edge to index 0, which would give 'a' a finite distance it must not have.
    const g = new Graph();

    addV(g, ['a', 'b', 'c', 'zz']);
    addE(g, 'b', 'c', ['E', 'F', 'G']);
    addE(g, 'zz', 'b', ['E']);

    const d = dist(await shortestPath({ source: 'zz', direction: 'out' }, g));

    expect(d.zz).toBe(0);
    expect(d.b).toBe(1);
    expect(d.c).toBe(2);
    // 'a' is isolated, so it must have NO ROW. A stale slot pointing at index 0 would have made
    // it reachable and given it one — which is exactly the invented path this fixture guards.
    expect(d.a).toBeUndefined();
  });

  test('a two-label edge is traversed ONCE, so a weighted distance is not doubled', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E', 'F'], 5);

    const d = dist(await shortestPath({ source: 'a', weightProperty: 'w' }, g));

    expect(d.b).toBe(5);
  });

  test('an edgeLabel restriction selects one bucket of a multi-label graph', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E', 'F']);
    addE(g, 'a', 'c', ['F']);

    const viaE = dist(await shortestPath({ source: 'a', edgeLabel: 'E' }, g));

    expect(viaE.b).toBe(1);
    expect(viaE.c).toBeUndefined();

    const viaF = dist(await shortestPath({ source: 'a', edgeLabel: 'F' }, g));

    expect(viaF.b).toBe(1);
    expect(viaF.c).toBe(1);
  });
});

describe('direction and self-loops', () => {
  test('out / in / both are distinguished', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'c', 'a', ['E']);

    const out = dist(await shortestPath({ source: 'a', direction: 'out' }, g));
    const inn = dist(await shortestPath({ source: 'a', direction: 'in' }, g));
    const both = dist(await shortestPath({ source: 'a', direction: 'both' }, g));

    expect([out.b, out.c]).toEqual([1, undefined]);
    expect([inn.b, inn.c]).toEqual([undefined, 1]);
    expect([both.b, both.c]).toEqual([1, 1]);
  });

  test('a self-loop changes no distance (it is yielded twice under both, harmlessly)', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'a', ['E']);
    addE(g, 'a', 'b', ['E']);

    const d = dist(await shortestPath({ source: 'a', direction: 'both' }, g));

    expect(d.a).toBe(0);
    expect(d.b).toBe(1);
  });

  test('both-direction traversal crosses an edge against its direction', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c', 'd']);
    addE(g, 'b', 'a', ['E']);
    addE(g, 'b', 'c', ['E']);
    addE(g, 'd', 'c', ['E']);

    const d = dist(await shortestPath({ source: 'a', direction: 'both' }, g));

    expect(d).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });
});

describe('the weighted route reads each edge’s own weight', () => {
  test('Dijkstra prefers a longer hop count with a smaller total weight', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'c', ['E'], 10);
    addE(g, 'a', 'b', ['E'], 1);
    addE(g, 'b', 'c', ['E'], 1);

    const d = dist(await shortestPath({ source: 'a', weightProperty: 'w' }, g));

    expect(d.c).toBe(2);
  });

  test('parallel edges of different weight take the cheaper', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E'], 9);
    addE(g, 'a', 'b', ['E'], 2);

    expect(dist(await shortestPath({ source: 'a', weightProperty: 'w' }, g)).b).toBe(2);
  });

  test('a non-numeric weight reads as 0, as it did before the CSR', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    g.addEdge({
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['E'],
      properties: { w: 'not a number' },
    });

    expect(dist(await shortestPath({ source: 'a', weightProperty: 'w' }, g)).b).toBe(0);
  });

  test('the negative-weight guard still fires — and BEFORE any CSR is built', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);
    addE(g, 'a', 'b', ['E'], -1);

    // An explicit try/catch rather than `.rejects.toThrow`: oxlint reads the matcher's return as
    // a non-Thenable, and this says the same thing without arguing with it.
    let message = '';

    try {
      await shortestPath({ source: 'a', weightProperty: 'w' }, g);
    } catch (err) {
      ({ message } = err as Error);
    }

    expect(message).toMatch(/non-negative/);
  });

  test('the unweighted route is hop distance, ignoring any w property', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'c', ['E'], 10);
    addE(g, 'a', 'b', ['E'], 1);
    addE(g, 'b', 'c', ['E'], 1);

    // No weightProperty → BFS → c is one hop away despite the heavy edge.
    expect(dist(await shortestPath({ source: 'a' }, g)).c).toBe(1);
  });
});

describe('the A* route shares the same adjacency', () => {
  test('A* returns the Dijkstra distance for the target', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E'], 1);
    addE(g, 'b', 'c', ['E'], 1);
    addE(g, 'a', 'c', ['E'], 10);

    const rows = await shortestPath(
      { source: 'a', target: 'c', algorithm: 'astar', weightProperty: 'w' },
      g,
    );

    expect(rows).toEqual([{ node: 'c', distance: 2 }]);
  });

  test('A* on an unweighted graph counts hops through the same CSR', async () => {
    const g = new Graph();

    addV(g, ['a', 'b', 'c']);
    addE(g, 'a', 'b', ['E']);
    addE(g, 'b', 'c', ['E']);

    const rows = await shortestPath({ source: 'a', target: 'c', algorithm: 'astar' }, g);

    expect(rows).toEqual([{ node: 'c', distance: 2 }]);
  });

  test('A* with an unreachable target returns no rows', async () => {
    const g = new Graph();

    addV(g, ['a', 'b']);

    expect(await shortestPath({ source: 'a', target: 'b', algorithm: 'astar' }, g)).toEqual([]);
  });
});

describe('an independent BFS oracle over a generated graph', () => {
  const build = (seed: number, n: number, edges: number) => {
    const g = new Graph();
    let s = seed;
    const next = (m: number): number => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;

      return s % m;
    };

    addV(
      g,
      Array.from({ length: n }, (_, i) => `v${i}`),
    );

    const pairs: [number, number][] = [];

    for (let e = 0; e < edges; e += 1) {
      const from = next(n);
      // every seventh edge is a self-loop, injected rather than left to the draws (item 1469: two
      // independent LCG draws mod n never collided, so the fixture had none at all)
      const to = e % 7 === 0 ? from : next(n);

      pairs.push([from, to]);
      addE(g, `v${from}`, `v${to}`, e % 3 === 0 ? ['X', 'E'] : ['E']);
    }

    return { g, pairs };
  };

  /** Plain BFS over an adjacency rebuilt from the edge list — shares nothing with the CSR. */
  const oracle = (
    n: number,
    pairs: [number, number][],
    src: number,
    dir: 'out' | 'in' | 'both',
  ): number[] => {
    const adj: number[][] = Array.from({ length: n }, () => []);

    for (const [from, to] of pairs) {
      if (dir === 'out' || dir === 'both') {
        adj[from].push(to);
      }

      if (dir === 'in' || dir === 'both') {
        adj[to].push(from);
      }
    }

    const d = Array.from({ length: n }, () => Infinity);

    d[src] = 0;

    const queue = [src];

    // a `while` over a GROWING queue -- `prefer-for-of` would rewrite a plain `for` here, and the
    // queue is appended to while it is walked
    let head = 0;

    while (head < queue.length) {
      const u = queue[head];

      head += 1;

      for (const v of adj[u]) {
        if (d[v] === Infinity) {
          d[v] = d[u] + 1;
          queue.push(v);
        }
      }
    }

    return d;
  };

  for (const direction of ['out', 'in', 'both'] as const) {
    test(`matches the oracle, direction=${direction}`, async () => {
      const { g, pairs } = build(13, 60, 150);
      const got = dist(await shortestPath({ source: 'v0', direction }, g));
      const want = oracle(60, pairs, 0, direction);

      for (let i = 0; i < 60; i += 1) {
        // unreachable == no row, so the oracle's Infinity maps to an absent key
        expect(got[`v${i}`]).toBe(Number.isFinite(want[i]) ? want[i] : undefined);
      }
    });
  }

  test('the fixture actually contains self-loops, multi-label edges and unreachable vertices', async () => {
    const { g, pairs } = build(13, 60, 150);

    expect(pairs.filter(([a, b]) => a === b).length).toBeGreaterThan(0);

    let multi = 0;

    for (const edge of g.edges) {
      if (edge.labels.size > 1) {
        multi += 1;
      }
    }

    expect(multi).toBeGreaterThan(0);

    // `in` from v0 reaches only part of the graph, which is what makes the unreachable branch
    // load-bearing — and unreachable means an ABSENT row, so the count of rows is the measure.
    const d = dist(await shortestPath({ source: 'v0', direction: 'in' }, g));

    expect(Object.keys(d).length).toBeLessThan(60);
  });
});
