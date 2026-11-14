import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, id, in_, optional, out, toArray, traversal, values } from '../index.js';
import { optionalHopValues } from './optional-hop-values.js';

/**
 * The `optional(<one hop>)` values rung (item 1884).
 *
 * ⚠️ THE ORACLE IS HAND-COMPUTED. A route test that asserts the fused walk agrees with itself proves
 * nothing, and CLAUDE.md records wrong answers that passed suites whose fixture could not tell right
 * from wrong.
 *
 * ⚠️ AND THE FIXTURE EXISTS TO PIN ONE SUBTLE RULE. `optionalHopStep` sets its `any` flag per EDGE,
 * BEFORE the projection — so a vertex that HAS edges whose far ends all lack the projected key emits
 * **nothing**, not itself. `h` below is exactly that vertex: it has an `E` edge to `g`, and `g` has
 * no `n`. An implementation that decided emptiness from "did any VALUE survive" would emit `h`'s own
 * `n` and pass every other test in this file.
 *
 * ⚠️⚠️ **EVERY SEQUENCE IS `toStrictEqual`, NOT `toEqual`, AND THAT IS NOT STYLE.** A mutant that
 * removed the drop on the self-emit branch — so a vertex with no edges AND no `n` yields
 * `undefined` — SURVIVED the first version of this file. `toEqual` ignores `undefined` entries, so
 * `[2, 3, 2, 3, 4, 5, undefined]` compared EQUAL to `[2, 3, 2, 3, 4, 5]`. The engine emits `null`
 * for an absent value in several surfaces and `undefined` for a dropped row, so an assertion blind
 * to `undefined` is blind to exactly the distinction these walks exist to get right.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'c', n: 3 },
    { id: 'd', n: 4 },
    { id: 'e', n: 5 },
    { id: 'h', n: 8 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  // `g` has NO `n`, and is the sole target of `h`'s only edge.
  g.addVertex({ id: 'g', labels: ['T'], properties: { other: 7 } });

  const edges = [
    { id: 'e1', from: 'a', to: 'b', labels: ['E'] },
    { id: 'e2', from: 'a', to: 'c', labels: ['E'] },
    // `d` has only an `F` edge, so an `E` hop finds nothing and `optional` emits `d` itself.
    { id: 'e3', from: 'd', to: 'e', labels: ['F'] },
    { id: 'e4', from: 'h', to: 'g', labels: ['E'] },
    // A self-loop on `c`, which appears in both adjacency directions.
    { id: 'e5', from: 'c', to: 'c', labels: ['E'] },
  ];

  for (const spec of edges) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: spec.labels,
    });
  }

  return g;
};

describe('optionalHopValues — the answer', () => {
  it('emits the far values where there are edges and the vertex itself where there are none', () => {
    const g = fixture();

    // Vertex order a, b, c, d, e, h, g:
    //   a -> b(2), c(3)          b has no out `E` -> itself (2)
    //   c -> c(3) [self-loop]    d has only `F`   -> itself (4)
    //   e -> itself (5)          h -> g, which has no `n` -> DROPPED, and h does NOT emit itself
    //   g -> itself, but has no `n` -> dropped
    expect(toArray(traversal(V(), optional(traversal(out('E'))), values('n')), g)).toStrictEqual([
      2, 3, 2, 3, 4, 5,
    ]);
  });

  /**
   * ⚠️ THE RULE THIS FILE EXISTS FOR. `h` HAS an edge, so `optional` is satisfied and the empty
   * branch must not fire — even though the projection then drops the only row it produced.
   */
  it('does NOT emit a vertex whose edges exist but whose far values all drop', () => {
    const g = fixture();
    const got = toArray(traversal(V(), optional(traversal(out('E'))), values('n')), g);

    expect(got).not.toContain(8);
  });

  it('agrees with `id()`, where nothing drops', () => {
    const g = fixture();

    expect(toArray(traversal(V(), optional(traversal(out('E'))), id()), g)).toStrictEqual([
      'b',
      'c',
      'b',
      'c',
      'd',
      'e',
      'g',
      'g',
    ]);
  });

  it('serves a bare `optional` with no projection', () => {
    const g = fixture();
    const got = toArray(traversal(V(), optional(traversal(out('E')))), g);

    expect(got.map((v) => (v as { id: string }).id)).toStrictEqual([
      'b',
      'c',
      'b',
      'c',
      'd',
      'e',
      'g',
      'g',
    ]);
  });

  /**
   * ⚠️ `in('E')` IS HERE BECAUSE ITS ABSENCE LET A MUTANT LIVE. `soleTypeBucket` returns a
   * `forward` flag and the walk reads `forward ? e.to : e.from`; with only `out` and `both` tested,
   * hard-coding `forward = true` broke nothing — `out` is forward and `both` takes the other arm.
   * The direction is only observable through `in`.
   */
  it('serves `in`, where the bucket arm must read the OTHER end', () => {
    const g = fixture();

    // In-edges per vertex: a has none -> itself (1) | b <- a (1) | c <- a (1), c (3) [self-loop] |
    // d none -> itself (4) | e none -> itself (5) | h none -> itself (8) | g <- h (8)
    expect(toArray(traversal(V(), optional(traversal(in_('E'))), values('n')), g)).toStrictEqual([
      1, 1, 1, 3, 4, 5, 8, 8,
    ]);
  });

  it('serves `both`, which goes through the general adjacency arm', () => {
    const g = fixture();

    // `both('E')` for each vertex: a -> b, c | b -> a | c -> c (out), a, c (in) | d -> itself |
    // e -> itself | h -> g | g -> h
    expect(toArray(traversal(V(), optional(traversal(both('E'))), values('n')), g)).toStrictEqual([
      2, 3, 1, 3, 1, 3, 4, 5, 8,
    ]);
  });
});

describe('optionalHopValues — the route', () => {
  it('claims the shapes it was built for', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), optional(traversal(out('E'))), values('n')),
      traversal(V(), optional(traversal(out('E'))), id()),
      traversal(V(), optional(traversal(out('E')))),
      traversal(V(), optional(traversal(both('E'))), values('n')),
    ]) {
      expect(optionalHopValues(t, g)).not.toBeUndefined();
    }
  });

  it('declines a multi-step sub-plan, a seeded source and a multi-key projection', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), optional(traversal(out('E'), out('E'))), values('n')),
      traversal(V('a'), optional(traversal(out('E'))), values('n')),
      traversal(V(), optional(traversal(out('E'))), values('n', 'other')),
      traversal(V(), optional(traversal(out('E'))), values()),
    ]) {
      expect(optionalHopValues(t, g)).toBeUndefined();
    }
  });
});
