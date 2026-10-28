/**
 * Item 1078: the per-type bucket-sum soundness rule, asserted as a DECISION.
 *
 * WHY THIS FILE EXISTS. `bucketSumsAreSound` decides, at seven sites, whether a count may be read
 * off per-type bucket SIZES or has to take a walk that dedupes. Both routes answer correctly —
 * that is the point of having the second one — so choosing wrongly is SLOW, never WRONG, and no
 * result-based test can tell the two apart. Item 1078's mutation run proved it: `const sound =
 * false`, which forces every undirected constrained count through the correction pass, SURVIVED a
 * suite of 20 differential tests at 0 failures.
 *
 * That is the shape `perf-gate-needs-its-own-test` describes, and this is the prescribed answer —
 * extract the decision as a pure function and assert the decision rather than the answer.
 *
 * THE RULE. An edge carries a SET of types and every index buckets it under each one, so summing
 * two buckets counts a `T,S` edge twice. Either of two facts rules that out: exactly one type was
 * requested (a type cannot collide with itself), or no edge in the graph carries two labels at all.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { bucketSumsAreSound } from './executor/shortcuts.ts';
import { query } from './index.ts';

describe('bucketSumsAreSound', () => {
  test('ONE requested type is sound whatever the graph holds', () => {
    expect(bucketSumsAreSound(['T'], 0)).toBe(true);
    expect(bucketSumsAreSound(['T'], 1)).toBe(true);
    expect(bucketSumsAreSound(['T'], 1_000_000)).toBe(true);
  });

  test('TWO requested types are sound only on a graph with no multi-label edge', () => {
    expect(bucketSumsAreSound(['T', 'S'], 0)).toBe(true);
    expect(bucketSumsAreSound(['T', 'S'], 1)).toBe(false);
  });

  test('EVERY type — `undefined` — is never licensed by the type list alone', () => {
    expect(bucketSumsAreSound(undefined, 0)).toBe(true);
    expect(bucketSumsAreSound(undefined, 1)).toBe(false);
  });

  test('an EMPTY type list is not one type', () => {
    // Nothing is requested, so nothing can be summed; `length === 1` must not be `length <= 1`.
    expect(bucketSumsAreSound([], 1)).toBe(false);
    expect(bucketSumsAreSound([], 0)).toBe(true);
  });
});

describe('the graph counter the rule reads', () => {
  // The rule is pure, so this is the other half: that `multiTypeEdgeCount` means what the rule
  // takes it to mean on a real graph. Without this, a correct rule could still be fed a wrong
  // number and nothing here would notice.
  test('counts the edges carrying more than one label, not the labels', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    expect(g.multiTypeEdgeCount).toBe(0);

    g.addEdge({ id: 'one', labels: ['T'], from: a, to: b, properties: {} });
    expect(g.multiTypeEdgeCount).toBe(0);
    expect(bucketSumsAreSound(['T', 'S'], g.multiTypeEdgeCount)).toBe(true);

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });
    expect(g.multiTypeEdgeCount).toBe(1);
    expect(bucketSumsAreSound(['T', 'S'], g.multiTypeEdgeCount)).toBe(false);

    g.addEdge({ id: 'three', labels: ['T', 'S', 'U'], from: b, to: a, properties: {} });
    expect(g.multiTypeEdgeCount).toBe(2);
  });

  test('the counter and the answer agree on the shape the rule guards', () => {
    // The end-to-end claim in one line: on a graph the rule calls UNSOUND, the two-type count is
    // still right — because the site that asked it took the other route.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });

    expect(bucketSumsAreSound(['T', 'S'], g.multiTypeEdgeCount)).toBe(false);
    expect(query<{ c: number }>(g, 'MATCH (a:P)-[:T|S]->(x) RETURN count(*) AS c')[0].c).toBe(1);
    expect(
      query<{ c: number }>(g, 'MATCH (a:P)-[:T|S]-(x) WHERE a.k >= 0 RETURN count(*) AS c')[0].c,
    ).toBe(2);
  });
});
