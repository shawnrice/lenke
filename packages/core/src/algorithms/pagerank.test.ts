import { describe, expect, test } from 'bun:test';

import { Graph } from '../core/Graph.js';
import { pagerank, personalizedPagerank } from './pagerank.js';

const line = (edges: [string, string][], nodes = ['1', '2', '3']): Graph => {
  const g = new Graph();

  for (const id of nodes) {
    g.addVertex({ id, labels: ['N'] });
  }

  for (const [from, to] of edges) {
    g.addEdge({ from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['E'] });
  }

  return g;
};

const map = (rows: { node: string; score: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.node, r.score]));

describe('pagerank', () => {
  test('symmetric 2-cycle → exactly [0.5, 0.5]', async () => {
    const g = line(
      [
        ['1', '2'],
        ['2', '1'],
      ],
      ['1', '2'],
    );
    expect(map(await pagerank({}, g))).toEqual({ 1: 0.5, 2: 0.5 });
  });

  test('mass is conserved (scores sum to 1) even with dangling sinks', async () => {
    // 1→2→3, 3 is a dangling sink.
    const g = line([
      ['1', '2'],
      ['2', '3'],
    ]);
    const total = (await pagerank({}, g)).reduce((s, r) => s + r.score, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  test('a sink outranks a source', async () => {
    const g = line([
      ['1', '2'],
      ['2', '3'],
    ]);
    const s = map(await pagerank({}, g));
    expect(s['3']).toBeGreaterThan(s['1']);
  });

  test('unknown edge type → uniform 1/N', async () => {
    const g = line([['1', '2']]);
    const s = map(await pagerank({ edgeLabel: 'NOPE' }, g));
    expect(s['1']).toBeCloseTo(1 / 3, 12);
    expect(s['2']).toBeCloseTo(1 / 3, 12);
    expect(s['3']).toBeCloseTo(1 / 3, 12);
  });

  test('writeProperty writes each score back to the vertex', async () => {
    const g = line(
      [
        ['1', '2'],
        ['2', '1'],
      ],
      ['1', '2'],
    );
    await pagerank({ writeProperty: 'pr' }, g);
    expect(g.getVertexById('1')?.getProperty<number>('pr')).toBe(0.5);
  });

  test('dual-form: curried application equals direct', async () => {
    const edges: [string, string][] = [
      ['1', '2'],
      ['2', '3'],
    ];
    expect(await pagerank({})(line(edges))).toEqual(await pagerank({}, line(edges)));
  });
});

describe('personalizedPagerank', () => {
  // a→b→c→a cycle, a→d (dangling sink), e→a (source into the cycle).
  const seedGraph = (): Graph =>
    line(
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['a', 'd'],
        ['e', 'a'],
      ],
      ['a', 'b', 'c', 'd', 'e'],
    );

  test('mass is conserved', async () => {
    const total = (await personalizedPagerank({ sourceNodes: ['a'] }, seedGraph())).reduce(
      (s, r) => s + r.score,
      0,
    );
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  test('restarting at a seed ranks it above an unreachable node', async () => {
    // Restart at `a`: node `e` (only points INTO the graph, never reached) stays low.
    const s = map(await personalizedPagerank({ sourceNodes: ['a'] }, seedGraph()));
    expect(s['a']).toBeGreaterThan(s['e']);
  });

  test('damping 0 → exactly the personalization vector', async () => {
    const s = map(
      await personalizedPagerank({ sourceNodes: ['a', 'c'], dampingFactor: 0 }, seedGraph()),
    );
    expect(s).toEqual({ a: 0.5, b: 0, c: 0.5, d: 0, e: 0 });
  });

  test('a repeated seed does not double-weight (distinct set)', async () => {
    const once = await personalizedPagerank({ sourceNodes: ['a'] }, seedGraph());
    const twice = await personalizedPagerank({ sourceNodes: ['a', 'a'] }, seedGraph());
    expect(twice).toEqual(once);
  });

  test('an unknown seed id is dropped', async () => {
    const clean = await personalizedPagerank({ sourceNodes: ['a'] }, seedGraph());
    const withJunk = await personalizedPagerank({ sourceNodes: ['a', 'zzz'] }, seedGraph());
    expect(withJunk).toEqual(clean);
  });

  test('no resolvable seed degenerates to global PageRank', async () => {
    const global = map(await pagerank({}, seedGraph()));

    for (const cfg of [{ sourceNodes: [] }, { sourceNodes: ['nope'] }]) {
      const s = map(await personalizedPagerank(cfg, seedGraph()));

      for (const id of Object.keys(global)) {
        expect(s[id]).toBeCloseTo(global[id], 12);
      }
    }
  });
});
