import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  both,
  cyclicPath,
  inE,
  map,
  otherV,
  out,
  path,
  simplePath,
  tree,
  union,
  V,
} from '../steps.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';
import { planReadsPath } from './runtime.js';

/**
 * Guards the path-elision optimization: `planReadsPath` must detect every step
 * that observes a traverser's path (directly or via a user closure), including
 * readers buried in sub-plans. A miss would silently hand those steps an empty
 * path. The default is "track", so the only failure mode worth testing is a
 * *false negative* — claiming a path-reading plan doesn't read the path.
 */
describe('path-tracking detection', () => {
  test('pure traversals do not read the path (elision fires)', () => {
    expect(planReadsPath(traversal(V(), out(), out()))).toBe(false);
    expect(planReadsPath(traversal(V(), both('KNOWS')))).toBe(false);
    expect(planReadsPath(traversal(V()))).toBe(false);
  });

  test('every direct path reader is detected at top level', () => {
    expect(planReadsPath(traversal(V(), out(), path()))).toBe(true);
    expect(planReadsPath(traversal(V(), out(), tree()))).toBe(true);
    expect(planReadsPath(traversal(V(), out(), simplePath()))).toBe(true);
    expect(planReadsPath(traversal(V(), out(), cyclicPath()))).toBe(true);
    expect(planReadsPath(traversal(V(), inE(), otherV()))).toBe(true);
  });

  test('opaque user closures force tracking (could read path via closureView)', () => {
    expect(
      planReadsPath(
        traversal(
          V(),
          map((v: unknown) => v),
        ),
      ),
    ).toBe(true);
  });

  test('a reader buried in a sub-plan is still detected', () => {
    expect(planReadsPath(traversal(V(), union(out(), path())))).toBe(true);
  });
});

describe('path-tracking correctness (elision must not change results)', () => {
  const chainGraph = (): Graph => {
    const g = new Graph();
    g.disableEvents();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['N'], properties: {} });
    g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ from: b, to: c, labels: ['E'], properties: {} });
    g.enableEvents();

    return g;
  };

  test('path() still yields the full accumulated path', () => {
    const g = chainGraph();
    const paths = [...run(traversal(V('a'), out(), out(), path()), g)] as unknown[][];
    expect(paths.length).toBe(1);
    expect((paths[0] as { id: string }[]).map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });

  test('simplePath still observes the path to filter revisits', () => {
    const g = chainGraph();
    // both() can walk back a→b→a; simplePath drops the revisiting traverser.
    const withSimple = [...run(traversal(V('a'), both('E'), both('E'), simplePath()), g)];
    const without = [...run(traversal(V('a'), both('E'), both('E')), g)];
    expect(withSimple.length).toBeLessThan(without.length);
  });
});
