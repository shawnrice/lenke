import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { nodeValuesShortcut } from './executor/node-values.js';
import { V, count, hasLabel, out, path, values } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1482: `V().values(k)` and `V().hasLabel(L).values(k)` are answered by a scan that builds no
 * traverser — the no-hop sibling of `hopValuesShortcut`, which requires a hop at `steps[1]` and so
 * never covered these. Item 1481 measured the gap to ISO-GQL's `MATCH (n:P) RETURN n.k` at 1.63x and
 * profiled it as traverser construction (~29%).
 *
 * ⚠️ A SHORTCUT IS AN ANSWER PATH, NOT A REWRITE, so a mistake here is a wrong ANSWER rather than a
 * slower one — and the tests are mostly about which plans it must REFUSE. Every refusal below is a
 * plan the shortcut would answer incorrectly or incompletely if its gate were loosened.
 */

const mixed = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, other: 'x' } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  // no `k` at all: `values('k')` must DROP this vertex, not emit undefined
  g.addVertex({ id: 'c', labels: ['P'], properties: { other: 'y' } });
  // a different label, for the hasLabel arm
  g.addVertex({ id: 'd', labels: ['Q'], properties: { k: 99 } });

  return g;
};

const rows = (g: Graph, plan: Parameters<typeof run>[0]): unknown[] => [...run(plan, g)];

describe('the shortcut answers the shapes it claims', () => {
  test('V().values(k) emits one value per vertex that HAS k, in vertex order', () => {
    expect(rows(mixed(), traversal(V(), values('k')))).toEqual([1, 2, 99]);
  });

  test('a vertex lacking the key is DROPPED, not emitted as undefined', () => {
    const out_ = rows(mixed(), traversal(V(), values('k')));

    expect(out_).toHaveLength(3);
    expect(out_.includes(undefined)).toBe(false);
  });

  test('V().hasLabel(L).values(k) filters by label first', () => {
    expect(rows(mixed(), traversal(V(), hasLabel('P'), values('k')))).toEqual([1, 2]);
  });

  test('hasLabel matches ANY of its labels, not all', () => {
    expect(rows(mixed(), traversal(V(), hasLabel('P', 'Q'), values('k')))).toEqual([1, 2, 99]);
  });

  test('a label nothing carries yields nothing', () => {
    expect(rows(mixed(), traversal(V(), hasLabel('Nope'), values('k')))).toEqual([]);
  });

  test('an empty graph yields nothing', () => {
    expect(rows(new Graph(), traversal(V(), values('k')))).toEqual([]);
  });
});

describe('…and REFUSES every plan it would answer wrongly', () => {
  const refuses = (plan: Parameters<typeof nodeValuesShortcut>[0]): void => {
    expect(nodeValuesShortcut(plan, mixed())).toBeUndefined();
  };

  test('a residual step after values() — the values are no longer the whole answer', () => {
    refuses(traversal(V(), values('k'), count()));
  });

  test('values() with NO key — a different shape (every property value)', () => {
    refuses(traversal(V(), values()));
  });

  test('values(a, b) — fans out per key, a different shape again', () => {
    refuses(traversal(V(), values('k', 'other')));
  });

  test('V(id, …) — enumerates a given set, not the whole graph', () => {
    refuses(traversal(V('a'), values('k')));
  });

  test('a hop before values() — that is hopValuesShortcut’s shape, not this one', () => {
    refuses(traversal(V(), out('E'), values('k')));
  });

  test('a filter that is not hasLabel between V() and values()', () => {
    refuses(traversal(V(), hasLabel('P'), hasLabel('Q'), values('k')));
  });

  test('E() as the source', () => {
    refuses(traversal(V(), values('k'), values('k')));
  });
});

describe('the two spellings agree, and so do the shortcut and the pipeline', () => {
  /**
   * ⚠️ `drain` AND THE ITERATOR MUST AGREE. They are one loop body in the implementation precisely
   * so they cannot diverge, and Gremlin results are compared ORDERED by the differential fuzzer, so
   * a reordering between them would be a cross-engine failure rather than an unspecified-order
   * liberty.
   */
  test('drain() equals spreading the iterator', () => {
    const shortcut = nodeValuesShortcut(traversal(V(), values('k')), mixed());

    expect(shortcut).toBeDefined();
    expect(shortcut?.drain?.()).toEqual([...(shortcut as Iterable<unknown>)]);
  });

  /**
   * ⚠️ THE WIRING, not just the shortcut. A mutant that leaves `nodeValuesShortcut` correct but stops
   * `run` CALLING it answers identically by the traverser pipeline, so every behavioural test above
   * passes — it survived all 1,291 of them. `run` returns the shortcut object itself, and that object
   * carries a `drain`, so its presence is the observable that says which route answered.
   */
  test('run() APPLIES the shortcut — the result is the shortcut object, not a pipeline stream', () => {
    const answered = run(traversal(V(), values('k')), mixed()) as { drain?: unknown };

    expect(typeof answered.drain).toBe('function');
  });

  test('a plan the shortcut REFUSES is not answered by it', () => {
    const answered = run(traversal(V(), values('k'), count()), mixed()) as { drain?: unknown };

    expect(typeof answered.drain).not.toBe('function');
  });

  test('the shortcut agrees with the traverser pipeline, which path() forces', () => {
    const g = mixed();
    // `path()` sets tracksPath, which gates the shortcut off — so this arm is the pipeline. The
    // values are the same; only the wrapper differs.
    const viaPipeline = rows(g, traversal(V(), values('k'), path())).map(
      (p) => (p as unknown[])[(p as unknown[]).length - 1],
    );

    expect(viaPipeline).toEqual(rows(g, traversal(V(), values('k'))));
  });
});
