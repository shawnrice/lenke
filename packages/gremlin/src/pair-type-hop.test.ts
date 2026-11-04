import { describe, expect, test } from 'bun:test';

import type { Graph, Vertex } from '@lenke/core';
import { Graph as G } from '@lenke/core';

import { V, dedupe, in_, out, toArray, traversal, values } from './index.js';

/**
 * The TWO-TYPE hop's own walk (item 1442): order, dedupe, and the shapes that must decline it.
 *
 * `out('E','F')` cost **1.86x** `out('E')` on a graph with no `F` edge at all — an identical edge
 * set and row count — and item 1441 located that in the per-vertex `buckets` array, pricing a
 * two-type specialization at **1.03x the single-type walk, 45.1% headroom**. This file is the
 * correctness half of building it.
 *
 * ⚠️ ORDER IS THE CONTRACT, AND IT IS WHY THIS FILE ASSERTS ARRAYS RATHER THAN MULTISETS. Gremlin
 * stream order is a TinkerPop contract the differential fuzzer compares ORDERED — unlike GQL, whose
 * row order is unspecified, which is exactly why item 1431's edge-index trick was available there
 * and not here. The new walk must emit bucket `t0` in full, then bucket `t1` minus `t0`, which is
 * what the general `i`/`j` loops do at `labels.length === 2`. A specialization that got this right
 * as a SET and wrong as a SEQUENCE would pass every multiset test and fail the fuzzer.
 *
 * ⚠️ AND THE ORACLE IS A HAND WALK, NOT ANOTHER QUERY. The two-type and many-type paths are two
 * branches of one function, so comparing one spelling against another can compare a route to
 * itself — item 930's point. `expected()` below reads the adjacency directly.
 *
 * ⚠️ `toArray` TAKES `drain`, SO A PLAIN `toArray` NEVER RUNS THE GENERATOR. The walk has two arms —
 * a `function*` and an eager `drain()` — and the eager one is taken whenever `rest` is empty. Every
 * case here is therefore run TWICE: bare (eager `drain`) and with a trailing `dedupe()`, which makes
 * `rest` non-empty and forces the lazy arm. Item 1412 built that split; nothing until now ran both
 * sides of it on this walk.
 */

/** Bucket `t0` in insertion order, then `t1` minus `t0` — the contract, computed by hand. */
const expected = (g: Graph, t0: string, t1: string, forward = true): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const byLabel = forward ? v.adjFrom : v.adjTo;

    if (byLabel === undefined) {
      continue;
    }

    const b0 = byLabel.get(t0);
    const b1 = byLabel.get(t1);

    for (const e of b0 ?? []) {
      acc.push((forward ? e.to : e.from).properties['k']);
    }

    for (const e of b1 ?? []) {
      if (b0?.has(e) === true) {
        continue;
      }

      acc.push((forward ? e.to : e.from).properties['k']);
    }
  }

  return acc;
};

/**
 * `a -> b` on E, `a -> c` on F, `b -> d` on BOTH, `c -> e` on F, `d -> a` on E.
 *
 * Deliberately irregular: one vertex with both buckets, one with only F, one edge in two buckets, and
 * the far ends' `k` values all distinct so a reordering is visible as a changed SEQUENCE.
 */
const build = (): Graph => {
  const g = new G();
  const vs: Record<string, Vertex> = {};

  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
    ['e', 5],
  ] as const) {
    vs[id] = g.addVertex({ id, labels: ['P'], properties: { k } });
  }

  g.addEdge({ id: 'ab', from: vs['a'], to: vs['b'], labels: ['E'], properties: {} });
  g.addEdge({ id: 'ac', from: vs['a'], to: vs['c'], labels: ['F'], properties: {} });
  g.addEdge({ id: 'bd', from: vs['b'], to: vs['d'], labels: ['E', 'F'], properties: {} });
  g.addEdge({ id: 'ce', from: vs['c'], to: vs['e'], labels: ['F'], properties: {} });
  g.addEdge({ id: 'da', from: vs['d'], to: vs['a'], labels: ['E'], properties: {} });

  return g;
};

/** Both arms of the walk: bare takes `drain`, the `dedupe()` tail forces the generator. */
const bothArms = (g: Graph, ...hop: readonly unknown[]): { eager: unknown[]; lazy: unknown[] } => ({
  eager: toArray(traversal(V(), ...(hop as never[]), values('k')), g),
  lazy: toArray(traversal(V(), ...(hop as never[]), values('k'), dedupe()), g),
});

describe('the two-type hop emits t0 then t1-minus-t0, in order (item 1442)', () => {
  test('⚠️ `out(E,F)` matches a hand walk EXACTLY, as a sequence', () => {
    const g = build();
    const { eager, lazy } = bothArms(g, out('E', 'F'));

    expect(eager).toEqual(expected(g, 'E', 'F'));
    // The lazy arm is deduped, so it is the same sequence with repeats removed — asserted against
    // the hand walk put through the same reduction, which keeps this an order assertion.
    expect(lazy).toEqual([...new Set(expected(g, 'E', 'F'))]);
    // Non-vacuous: the fixture really does produce rows through both arms.
    expect(eager.length).toBeGreaterThan(3);
  });

  test('⚠️ the REVERSED spelling is a different sequence, which is the contract', () => {
    // `out('F','E')` must emit the F bucket first. If the specialization ignored argument order both
    // spellings would agree and this is the only test that would notice.
    const g = build();
    const { eager } = bothArms(g, out('F', 'E'));

    expect(eager).toEqual(expected(g, 'F', 'E'));
    expect(eager).not.toEqual(expected(g, 'E', 'F'));
    // Same MULTISET either way, which is why a multiset test could not catch a reordering.
    expect([...eager].sort()).toEqual([...expected(g, 'E', 'F')].sort());
  });

  test('the edge in BOTH buckets is emitted exactly once', () => {
    // `b -> d` carries E and F. `d.k` is 4, and it must appear once in the whole stream.
    const g = build();
    const { eager } = bothArms(g, out('E', 'F'));

    expect(eager.filter((x) => x === 4)).toEqual([4]);
  });

  test('a DUPLICATED label is admitted and still emits once each', () => {
    // `out('E','E')` resolves both lookups to the same Set, so every edge in bucket 1 is found in
    // bucket 0 and dropped. The answer must equal the single-type spelling.
    const g = build();
    const { eager, lazy } = bothArms(g, out('E', 'E'));

    expect(eager).toEqual(toArray(traversal(V(), out('E'), values('k')), g));
    expect(lazy).toEqual([...new Set(eager)]);
  });

  test('the INCOMING direction takes the same walk', () => {
    const g = build();
    const { eager, lazy } = bothArms(g, in_('E', 'F'));

    expect(eager).toEqual(expected(g, 'E', 'F', false));
    expect(lazy).toEqual([...new Set(expected(g, 'E', 'F', false))]);
  });

  test('a type NOTHING carries contributes nothing, from either position', () => {
    const g = build();

    expect(bothArms(g, out('E', 'ZZZ')).eager).toEqual(
      toArray(traversal(V(), out('E'), values('k')), g),
    );
    // `ZZZ` first means bucket 0 is absent everywhere — the branch where `b0` is undefined and the
    // membership test must not be consulted.
    expect(bothArms(g, out('ZZZ', 'E')).eager).toEqual(
      toArray(traversal(V(), out('E'), values('k')), g),
    );
    expect(bothArms(g, out('ZZZ', 'YYY')).eager).toEqual([]);
  });

  test('a graph with no edges at all, both arms', () => {
    const g = new G();

    g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 1 } });

    expect(bothArms(g, out('E', 'F')).eager).toEqual([]);
    expect(bothArms(g, out('E', 'F')).lazy).toEqual([]);
  });
});

describe('THREE types keep the general walk and agree with it (item 1442)', () => {
  test('⚠️ `out(E,F,G)` is not the pair specialization and is still right', () => {
    // THE DECLINE. The specialization is deliberately two-type — a loop over N hoisted locals is the
    // per-vertex array again — so 3+ labels must keep `manyTypes`. `G` carries nothing here, so the
    // answer must equal the two-type spelling while taking a different route; only a measurement or
    // this equality can tell, and the equality is the one that cannot rot.
    const g = build();

    expect(bothArms(g, out('E', 'F', 'G')).eager).toEqual(expected(g, 'E', 'F'));
  });

  test('and with the third type CARRYING edges, against a hand walk over all three', () => {
    const g = build();
    const vs = [...g.vertices];

    g.addEdge({ id: 'ae', from: vs[0], to: vs[4], labels: ['G'], properties: {} });

    const threeWay: unknown[] = [];

    for (const v of g.vertices) {
      const byLabel = v.adjFrom;

      if (byLabel === undefined) {
        continue;
      }

      const buckets = [byLabel.get('E'), byLabel.get('F'), byLabel.get('G')];

      for (let i = 0; i < buckets.length; i += 1) {
        for (const e of buckets[i] ?? []) {
          let earlier = false;

          for (let j = 0; j < i; j += 1) {
            if (buckets[j]?.has(e) === true) {
              earlier = true;

              break;
            }
          }

          if (!earlier) {
            threeWay.push(e.to.properties['k']);
          }
        }
      }
    }

    expect(bothArms(g, out('E', 'F', 'G')).eager).toEqual(threeWay);
    expect(threeWay.length).toBe(6);
  });
});

describe('a bigger irregular graph, where one vertex has both buckets populated (item 1442)', () => {
  test('both arms match the hand walk over 300 vertices', () => {
    // The small fixture has one such vertex; this one has many, so the dedupe membership test runs
    // on a real distribution rather than on a single case.
    const g = new G();
    const vs: Vertex[] = [];

    for (let i = 0; i < 300; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
    }

    for (let i = 0; i < 300; i += 1) {
      // Every vertex gets an E edge; every third ALSO carries F on the same edge (so the dedupe
      // fires), and every fifth gets a SEPARATE F edge (so both buckets populate independently).
      g.addEdge({
        id: `e${i}`,
        from: vs[i],
        to: vs[(i * 7 + 3) % 300],
        labels: i % 3 === 0 ? ['E', 'F'] : ['E'],
        properties: {},
      });

      if (i % 5 === 0) {
        g.addEdge({
          id: `f${i}`,
          from: vs[i],
          to: vs[(i * 11 + 1) % 300],
          labels: ['F'],
          properties: {},
        });
      }
    }

    const { eager, lazy } = bothArms(g, out('E', 'F'));

    expect(eager).toEqual(expected(g, 'E', 'F'));
    expect(lazy).toEqual([...new Set(expected(g, 'E', 'F'))]);
    // 300 E edges + 60 standalone F edges, and the 100 double-labelled ones must NOT double.
    expect(eager.length).toBe(360);
  });
});
