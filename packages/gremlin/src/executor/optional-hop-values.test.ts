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

/**
 * THE MULTI-STEP CHAIN (item 1887). The sub-plan is two or more vertex steps, and the rule that
 * changes is WHERE `any` is set: at one hop every adjacent edge produces a row, at two it does not.
 *
 * ⚠️ THE FIXTURE'S `d` IS THE DISCRIMINATOR. `d` has an `F` out-edge and no `E` one, so in a
 * two-hop `E` chain the vertex BEFORE it (none here) and `d` itself produce nothing. The vertex that
 * matters is `a`: it HAS `E` edges (to `b` and `c`), and `b` has none — so the path through `b` dies
 * while the path through `c` survives via the self-loop. An implementation setting `any` on the
 * FIRST hop would still be right for `a`; `h` is the one that proves the rule, because its only
 * edge goes to `g`, which has no `E` out-edge at all — so `h` produces NOTHING at two hops and must
 * emit ITSELF, where a first-hop `any` would emit nothing for it.
 */
describe('optionalHopValues — the multi-step chain', () => {
  it("emits each PATH's far value, and the vertex itself when the chain dies", () => {
    const g = fixture();

    // Two-hop `E` paths, per vertex in order a, b, c, d, e, h, g:
    //   a: a->b (b has no E out) dead; a->c -> c (self-loop) => 3
    //   b: no E out-edge          => itself (2)
    //   c: c->c -> c              => 3
    //   d: no E out-edge          => itself (4)
    //   e: no E out-edge          => itself (5)
    //   h: h->g, g has no E out   => NOTHING survives, so h emits ITSELF (8)
    //   g: no E out-edge          => itself, but `g` has no `n` => DROPPED
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), out('E'))), values('n')), g),
    ).toStrictEqual([3, 2, 3, 4, 5, 8]);
  });

  /**
   * ⚠️ A SEPARATE, PURELY LINEAR FIXTURE, because the shared one cannot tell the depths apart. On
   * `fixture()` only `c`'s self-loop extends a path, so the two-hop and three-hop answers are the
   * SAME list — and a mutant making the recursion stop one hop short (`hops.length - 2`) survived
   * the three-hop test for exactly that reason. Here depth 2 from `p0` is `p2` and depth 3 is `p3`,
   * so the depths are distinguishable by construction.
   */
  it('walks the chain to its FULL length, not one hop short', () => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 5; i += 1) {
      vs.push(g.addVertex({ id: `p${String(i)}`, labels: ['T'], properties: { n: i * 10 } }));
    }

    for (let i = 0; i < 4; i += 1) {
      g.addEdge({ id: `pe${String(i)}`, from: vs[i], to: vs[i + 1], labels: ['E'] });
    }

    // p0..p4 in order. Depth 2: p0->p2(20), p1->p3(30), p2->p4(40), p3 dies -> itself(30),
    // p4 dies -> itself(40).
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), out('E'))), values('n')), g),
    ).toStrictEqual([20, 30, 40, 30, 40]);
    // Depth 3: p0->p3(30), p1->p4(40), p2/p3/p4 die -> themselves (20, 30, 40).
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), out('E'), out('E'))), values('n')), g),
    ).toStrictEqual([30, 40, 20, 30, 40]);
    // Depth 4: p0->p4(40) only; the rest die.
    expect(
      toArray(
        traversal(V(), optional(traversal(out('E'), out('E'), out('E'), out('E'))), values('n')),
        g,
      ),
    ).toStrictEqual([40, 10, 20, 30, 40]);
  });

  it('serves THREE hops, where the recursion runs instead of the unrolled pair', () => {
    const g = fixture();

    // Three-hop `E` paths: only `c`'s self-loop can supply one (c->c->c->c), and `a->c->c->c`.
    //   a: a->c->c->c => 3        b: none => itself (2)      c: c->c->c->c => 3
    //   d/e/h: none => themselves (4, 5, 8)                  g: itself, no `n` => dropped
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), out('E'), out('E'))), values('n')), g),
    ).toStrictEqual([3, 2, 3, 4, 5, 8]);
  });

  /**
   * ⚠️ THESE THREE ORACLES WERE WRONG IN THE FIRST DRAFT AND WERE RE-DERIVED BY HAND, not copied
   * from the engine — which is the only way a test like this is worth anything. The walk's answers
   * were then confirmed to match the hand derivation exactly, vertex by vertex. Two details are
   * what I had wrong, and both are properties of `bothEdgesOf`/`inEdgesOf` rather than of this
   * walk: a SELF-LOOP appears in BOTH the out and in buckets, so `both(E)` on `c` yields `c` twice
   * and `a` once; and a vertex whose chain dies emits itself, where one whose chain SURVIVES but
   * whose values all drop (here `g`, which has no `n`) emits nothing at all.
   */
  it('serves `in` and `both` chains, which take the general adjacency arm', () => {
    const g = fixture();

    // in(E).in(E) per vertex: a none -> itself(1) | b: <-a, a has no in -> dies -> itself(2) |
    // c: <-a (a none, dies), <-c -> a(1), c(3) | d none -> 4 | e none (d->e is F) -> 5 |
    // h none -> 8 | g: <-h, h has no in -> dies -> itself, no `n` -> dropped
    expect(
      toArray(traversal(V(), optional(traversal(in_('E'), in_('E'))), values('n')), g),
    ).toStrictEqual([1, 2, 1, 3, 4, 5, 8]);
    // both(E).both(E): the self-loop counts TWICE for `c` (out bucket then in bucket).
    expect(
      toArray(traversal(V(), optional(traversal(both('E'), both('E'))), values('n')), g),
    ).toStrictEqual([1, 3, 1, 3, 2, 3, 3, 1, 3, 2, 3, 3, 1, 3, 4, 5, 8]);
  });

  it('serves a MIXED chain of directions', () => {
    const g = fixture();

    // out(E).in(E): a: ->b then b's in = a(1); ->c then c's in = a(1), c(3) | b: no E out -> 2 |
    // c: ->c then c's in = a(1), c(3) | d 4 | e 5 | h: ->g then g's in = h(8) | g: no E out ->
    // itself, no `n` -> dropped
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), in_('E'))), values('n')), g),
    ).toStrictEqual([1, 1, 3, 2, 1, 3, 4, 5, 8]);
  });

  it('serves `id()` and a bare chain', () => {
    const g = fixture();

    expect(toArray(traversal(V(), optional(traversal(out('E'), out('E'))), id()), g)).toStrictEqual(
      ['c', 'b', 'c', 'd', 'e', 'h', 'g'],
    );
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
      // The CHAIN arm (item 1887) — two steps and three, which item 1884 declined.
      traversal(V(), optional(traversal(out('E'), out('E'))), values('n')),
      traversal(V(), optional(traversal(out('E'), out('E'), out('E'))), id()),
      traversal(V(), optional(traversal(in_('E'), both('E')))),
    ]) {
      expect(optionalHopValues(t, g)).not.toBeUndefined();
    }
  });

  /**
   * ⚠️ THE MULTI-STEP SUB-PLAN MOVED FROM THIS LIST TO THE CLAIMED LIST AT ITEM 1887, deliberately.
   * Item 1884 declined it because `optionalSingleHop` is the gate; the chain arm now serves it at
   * 1.46x. The row is kept here as a comment rather than deleted so the flip is visible to whoever
   * reads this file next.
   */
  it('declines a seeded source and a multi-key projection', () => {
    const g = fixture();

    for (const t of [
      traversal(V('a'), optional(traversal(out('E'))), values('n')),
      traversal(V(), optional(traversal(out('E'))), values('n', 'other')),
      traversal(V(), optional(traversal(out('E'))), values()),
    ]) {
      expect(optionalHopValues(t, g)).toBeUndefined();
    }
  });
});
