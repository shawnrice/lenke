import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run, toArray } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, both, cyclicPath, has, out, path, repeat } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('cyclicPath tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(1).both().both().cyclicPath() — v[1]; v[1]; v[1]
  test('cyclicPath keeps only traversers whose path repeats', () => {
    const r = arr(run(traversal(V('1'), both(), both(), cyclicPath()), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(r.map((v) => v.id)).toEqual(['1', '1', '1']);
  });

  // doc: g.V(1).both().both().cyclicPath().path() — [v[1],v[?],v[1]] x 3
  test('cyclicPath().path() yields 3 cyclic length-3 paths', () => {
    const r = arr(
      run(traversal(V('1'), both(), both(), cyclicPath(), path()), tinkerGraph),
    ) as Array<Array<{ id: string }>>;
    expect(r.length).toBe(3);

    for (const p of r) {
      const ids = p.map((e) => e.id);
      expect(ids[0]).toBe('1');
      expect(ids[ids.length - 1]).toBe('1');
    }
  });
});

describe('cycle detection via repeat().until(cyclicPath())', () => {
  // a -> b -> c -> a (a directed cycle); d -> a reaches it but isn't on it.
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['N'], properties: { name: id } });
  }

  for (const [from, to] of [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
    ['d', 'a'],
  ]) {
    g.addEdge({
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: ['E'],
      properties: {},
    });
  }

  const cyclesFrom = (name: string): string[][] =>
    (
      toArray(
        traversal(V(), has('name', name), repeat(out('E')).until(cyclicPath()), path()),
        g,
      ) as Array<Array<{ properties: { name: string } }>>
    ).map((p) => p.map((v) => v.properties.name));

  test('walks until the path revisits a vertex, emitting the cycle', () => {
    expect(cyclesFrom('a')).toEqual([['a', 'b', 'c', 'a']]);
  });

  test('distinguishes ON a cycle (first === last) from merely REACHING one', () => {
    expect(cyclesFrom('d')).toEqual([['d', 'a', 'b', 'c', 'a']]); // reaches, not on
    const onACycle = (name: string): boolean => cyclesFrom(name).some((p) => p[0] === p.at(-1));
    expect(['a', 'b', 'c', 'd'].map(onACycle)).toEqual([true, true, true, false]);
  });
});
