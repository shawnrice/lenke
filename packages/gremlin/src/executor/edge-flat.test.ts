// The flat edge array and its cache (item 2016).
//
// **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — every mutant of the cache or the policy survives the
// behavioural tests** ([[perf-gate-needs-its-own-test]]). So the structure gets its own unit tests:
// the ORDER it is built in (which is the entire correctness argument for the walk that reads it),
// the identity of a cached return, the invalidation on a topology write, and the `kind` namespacing
// that keeps this policy from arming the vertex-CSR rungs' builds.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { edgeFlatFor } from './edge-flat.js';
import { seenBefore } from './second-ask.js';

const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    g.addVertex({ id, labels: ['P'], properties: {} });
  }

  let seq = 0;
  const E = (fr: string, t: string, label = 'E'): void => {
    seq += 1;

    g.addEdge({
      id: `e${seq}`,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(t)!,
      labels: [label],
      properties: {},
    });
  };

  /*
   * SHAPED SO THE ORDER IS OBSERVABLE: `a` has three E edges added OUT of target order, an `F`
   * edge is interleaved so the build must filter by TYPE rather than by position, `c` is a
   * self-loop, `d` has only an F edge so its E bucket is ABSENT, and `e` has none at all.
   */
  E('a', 'c');
  E('a', 'b');
  E('a', 'd', 'F');
  E('a', 'e');
  E('c', 'c');
  E('d', 'b', 'F');

  return g;
};

describe('edgeFlatFor: the structure', () => {
  test('is built in `graph.vertices` order, bucket by bucket, filtered by TYPE', () => {
    /*
     * **THIS IS THE WHOLE CORRECTNESS ARGUMENT FOR THE FLAT WALK.** Position `i` must be the
     * `i`-th edge the bucket walk would have visited, because Gremlin rows are compared ORDERED
     * against the Rust engine for a single-type step. `a`'s three E edges come first in INSERTION
     * order (e1, e2, e4 — not e1, e2, e3, because e3 is the `F` edge), then `c`'s self-loop.
     */
    const g = build();

    expect([...edgeFlatFor(g, true, 'E')].map((e) => e.id)).toEqual(['e1', 'e2', 'e4', 'e5']);
    // The F array is a DIFFERENT shape key, so it holds only the F edges, also in vertex order.
    expect([...edgeFlatFor(g, true, 'F')].map((e) => e.id)).toEqual(['e3', 'e6']);
  });

  test('the INWARD array reads `adjTo` and has its own order', () => {
    // A build that ignored `outward` would return the outward array here, and every other
    // assertion in this file would still pass. Inbound E edges in vertex order: b<-a(e2),
    // c<-a(e1), c<-c(e5), e<-a(e4).
    const g = build();

    expect([...edgeFlatFor(g, false, 'E')].map((e) => e.id)).toEqual(['e2', 'e1', 'e5', 'e4']);
  });

  test('a second call returns the SAME array, not an equal one', () => {
    // The cache is the point; identity is how a mutant that rebuilds every time is caught, since a
    // rebuilt array is `toEqual` to the cached one.
    const g = build();

    expect(edgeFlatFor(g, true, 'E')).toBe(edgeFlatFor(g, true, 'E'));
  });

  test('a topology write INVALIDATES it, and the new array reflects the write', () => {
    /*
     * KEYED ON `topologyVersion`, NOT MERELY STAMPED WITH IT. A cache that compared nothing — or
     * that kept the stale generation alongside the new one — would return the four-edge array here.
     */
    const g = build();
    const first = edgeFlatFor(g, true, 'E');

    expect(first).toHaveLength(4);

    g.addVertex({ id: 'z', labels: ['P'], properties: {} });
    g.addEdge({
      id: 'eNEW',
      from: g.getVertexById('z')!,
      to: g.getVertexById('a')!,
      labels: ['E'],
      properties: {},
    });

    const second = edgeFlatFor(g, true, 'E');

    expect(second).not.toBe(first);
    expect([...second].map((e) => e.id)).toEqual(['e1', 'e2', 'e4', 'e5', 'eNEW']);
  });

  test('two graphs do not share a generation', () => {
    const g1 = build();
    const g2 = build();

    g2.addVertex({ id: 'z', labels: ['P'], properties: {} });

    expect(edgeFlatFor(g1, true, 'E')).not.toBe(edgeFlatFor(g2, true, 'E'));
  });
});

describe('seenBefore: the `kind` namespace', () => {
  test('a `kind` record does NOT arm the default namespace, or the reverse', () => {
    /*
     * **THIS IS WHY THE PARAMETER EXISTS, AND A MUTANT DROPPING IT IS A PERFORMANCE BUG RATHER
     * THAN A WRONG ANSWER** — which is exactly the kind only a test like this can see. The nine
     * vertex-CSR callers share the default namespace deliberately, because they all build
     * `chainCsrFor` from that key. The edge-flat rung builds a different structure, so if it shared
     * the namespace its first ask would mark `>E` as seen and arm every CSR rung's build on ITS
     * first ask — the 1.64x first-query regression item 1889's policy exists to prevent.
     */
    const g = build();

    expect(seenBefore(g, true, 'E', 'e')).toBe(false);
    expect(seenBefore(g, true, 'E', 'e')).toBe(true);
    // The default namespace is still UNTOUCHED by the two asks above.
    expect(seenBefore(g, true, 'E')).toBe(false);
    expect(seenBefore(g, true, 'E')).toBe(true);
  });

  test('the namespace still keys on direction, type and topology version', () => {
    const g = build();

    expect(seenBefore(g, true, 'E', 'e')).toBe(false);
    expect(seenBefore(g, false, 'E', 'e')).toBe(false);
    expect(seenBefore(g, true, 'F', 'e')).toBe(false);
    expect(seenBefore(g, true, 'E', 'e')).toBe(true);

    g.addVertex({ id: 'z', labels: ['P'], properties: {} });

    expect(seenBefore(g, true, 'E', 'e')).toBe(false);
  });
});
