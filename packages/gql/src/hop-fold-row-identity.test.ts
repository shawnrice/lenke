import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1953: EVERY template fold must hand back INDEPENDENT row objects.
 *
 * `hop-projection.ts` has seven places that compute a row once and copy it for the rest of a
 * bucket — item 167's hoist and item 1407's clone. Replacing `{ ...template }` with `template` at
 * any of them is invisible to every other test in the repo: nothing inside the engine mutates a
 * projected row, and two aliased rows carry identical values, so no differential or multiset
 * comparison can see it. The rows go to the CALLER, who may write to one.
 *
 * `hop-far-driven.test.ts` ALREADY PINS THIS for one walk, with a test named "each row is a
 * DISTINCT object, not one shared reference" — written for the fold item 1407 built and never
 * extended as five more folds were added. A mechanical sweep (`clone-sweep-1953.mjs`) aliased each
 * code site in turn and found **three of seven covered**: this file covers the other four.
 *
 * ```text
 *   3594  farDrivenPredicatedHopWalk             a raise-free far predicate, far-driven
 *   3887  farDrivenHopWalk, MULTI-TYPE arm       `-[:E|F]->`
 *   3967  farDrivenHopWalk, the counting CSR arm the second ask, once the CSR exists
 *   4424  filteredHopWalk, the start-only fold   a start-only WHERE and a start-only projection
 * ```
 *
 * EACH TEST NAMES THE SITE IT COVERS, because the shapes are not interchangeable — each one
 * reaches exactly one fold, and a shape that drifts onto another arm would leave its site untested
 * while still passing. The sweep is how that is checked, not by reading.
 */
const build = (): Graph => {
  const g = new Graph();
  // EVERY vertex carries `D`, so a far label is vacuous and the counting CSR arm is reachable.
  const spec: [string, string, number][] = [
    ['v1', 'h', 5],
    ['v2', 'b', 5],
    ['v3', 'c', 5],
    ['v4', 't', 5],
    ['v5', 'u', 5],
  ];

  for (const [id, k, n] of spec) {
    g.addVertex({ id, labels: ['D'], properties: { k, n } });
  }

  const v = (id: string) => {
    const got = g.getVertexById(id);

    if (got === null) {
      throw new Error('fixture lost a vertex');
    }

    return got;
  };

  // FAN-IN IS THE POINT: a fold only emits more than one row per far vertex when several edges
  // arrive at it, so every shape below needs a far vertex of in-degree >= 2.
  g.addEdge({ id: 'e1', from: v('v1'), to: v('v4'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('v2'), to: v('v4'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: v('v3'), to: v('v4'), labels: ['E'], properties: {} });
  // v1 has TWO `E` out-edges, which is what the START-side fold needs.
  g.addEdge({ id: 'e4', from: v('v1'), to: v('v5'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'f1', from: v('v2'), to: v('v5'), labels: ['F'], properties: {} });
  g.addEdge({ id: 'f2', from: v('v3'), to: v('v5'), labels: ['F'], properties: {} });

  return g;
};

/**
 * The shared assertion: among rows sharing a value there must be at least two, they must be
 * different objects, and writing through one must not reach the others.
 */
const expectIndependentRows = (rows: readonly unknown[], key: string, value: unknown): void => {
  const group = (rows as Record<string, unknown>[]).filter((r) => r[key] === value);

  // A fixture that stopped producing a fan-in group would make the test vacuous, so this is an
  // assertion about the FIXTURE, not about the engine.
  expect(group.length).toBeGreaterThan(1);
  expect(group[0]).not.toBe(group[1]);

  group[0][key] = '__mutated__';

  for (let i = 1; i < group.length; i += 1) {
    expect(group[i][key]).toBe(value);
  }
};

describe('every hop fold returns independent row objects (item 1953)', () => {
  test('site 3594 — the predicated far-driven fold', () => {
    // A raise-free far-only predicate with no start label: `predicatedHopRoute` takes the
    // template-and-copy walk, evaluating the predicate once per far vertex.
    const rows = query(build(), 'MATCH (a)-[:E]->(x:D) FILTER x.n > $p0 RETURN x.k AS k', {
      p0: 0,
    });

    expectIndependentRows(rows, 'k', 't');
  });

  test('site 3887 — the MULTI-TYPE far-driven fold', () => {
    // `-[:E|F]->` routes to the multi-type arm, which unions a far vertex's buckets and folds.
    const rows = query(build(), 'MATCH (a)-[:E|F]->(x:D) RETURN x.k AS k', {});

    expectIndependentRows(rows, 'k', 'u');
  });

  test('site 3967 — the counting CSR fold, on the second ask', () => {
    // THE SAME QUERY TWICE, DELIBERATELY. `csrHopRoute` declines its own first ask rather than
    // pay the CSR build for a one-shot query, so a single call never reaches this fold.
    const g = build();
    const q = 'MATCH (a)-[:E]->(x) RETURN x.k AS k';

    query(g, q, {});

    const rows = query(g, q, {});

    expectIndependentRows(rows, 'k', 't');
  });

  test('site 4424 — the start-only fold under a start-only WHERE', () => {
    // The projection and the predicate both read only the start, and the far end is unlabelled, so
    // every row a start vertex produces is identical and the bucket size is the row count.
    const rows = query(build(), 'MATCH (a:D)-[:E]->(b) WHERE a.n > $p0 RETURN a.k AS k', {
      p0: 0,
    });

    expectIndependentRows(rows, 'k', 'h');
  });
});
