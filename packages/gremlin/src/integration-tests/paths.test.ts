import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import {
  V,
  bothE,
  cyclicPath,
  has,
  in_,
  inV,
  out,
  outE,
  path,
  simplePath,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Paths', () => {
  const g = createTestTinkerGraph();

  // doc: g.V(marko).out('knows').values('name').path()
  test('path of marko -> knows -> name', () => {
    const r = arr(run(traversal(V('1'), out('KNOWS'), values('name'), path()), g));
    expect(r).toHaveLength(2);
    const names = (r as Array<Array<unknown>>).map((p) => p[p.length - 1] as string);
    expect(names.slice().sort()).toEqual(['josh', 'vadas']);
  });

  // doc: g.V().out().out().path() yields v[1] -> v[4] -> v[5]/v[3]
  test('two-hop out-path from any vertex', () => {
    const r = arr(run(traversal(V(), out(), out(), path()), g));
    const ids = (r as Array<Array<{ id: string }>>).map((p) => p.map((v) => v.id));
    expect(ids).toEqual([
      ['1', '4', '5'],
      ['1', '4', '3'],
    ]);
  });

  // doc: g.V().out().out().path().by('name')
  test('path().by("name") on two-hop traversal', () => {
    const r = arr(run(traversal(V(), out(), out(), path().by('name')), g));
    expect(r).toEqual([
      ['marko', 'josh', 'ripple'],
      ['marko', 'josh', 'lop'],
    ]);
  });

  // doc: g.V().outE().inV().outE().inV().path()
  test('outE.inV.outE.inV path threads edges', () => {
    const r = arr(run(traversal(V(), outE(), inV(), outE(), inV(), path()), g));
    const ids = (r as Array<Array<{ id: string }>>).map((p) => p.map((v) => v.id));
    expect(ids).toEqual([
      ['1', '8', '4', '10', '5'],
      ['1', '8', '4', '11', '3'],
    ]);
  });

  // simplePath drops paths that revisit a vertex.
  test('simplePath excludes cycles in both().both()', () => {
    const r = arr(
      run(traversal(V('1'), out('KNOWS'), in_('KNOWS'), simplePath(), values('name')), g),
    );
    // marko -> josh -> ?in_KNOWS = marko (cycle, excluded);
    // marko -> vadas -> ?in_KNOWS = marko (cycle, excluded).
    expect(r).toEqual([]);
  });

  // cyclicPath keeps only paths that return to themselves.
  test('cyclicPath retains cycles in out.in over CREATED', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          out('CREATED'),
          in_('CREATED'),
          cyclicPath(),
          values('name'),
        ),
        g,
      ),
    );
    // marko -> lop -> {marko, josh, peter}; only marko is a cycle.
    expect(r).toEqual(['marko']);
  });

  // Edges traversed in a 2-hop path appear in the path() output.
  test('path with edges has length 5 for 2-hop V-E-V-E-V', () => {
    const r = arr(run(traversal(V('1'), outE(), inV(), outE(), inV(), path()), g));
    expect(r.every((p) => (p as unknown[]).length === 5)).toBe(true);
  });

  // bothE then otherV path includes the edge.
  test('bothE.inV path from marko has 3 entries', () => {
    const r = arr(run(traversal(V('1'), bothE(), inV(), path()), g));
    // length 3 each: [vertex, edge, vertex]
    expect(r.every((p) => (p as unknown[]).length === 3)).toBe(true);
  });
});
