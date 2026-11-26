import { describe, expect, it, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  Scope,
  both,
  count,
  fold,
  id,
  in_,
  optional,
  out,
  run,
  toArray,
  traversal,
  values,
} from '../index.js';
import { optionalHopValues } from './optional-hop-values.js';

/**
 * The `optional(<one hop>)` values rung (item 1884).
 *
 * THE ORACLE IS HAND-COMPUTED. A route test that asserts the fused walk agrees with itself proves
 * nothing, and CLAUDE.md records wrong answers that passed suites whose fixture could not tell right
 * from wrong.
 *
 * AND THE FIXTURE EXISTS TO PIN ONE SUBTLE RULE. `optionalHopStep` sets its `any` flag per EDGE,
 * BEFORE the projection — so a vertex that HAS edges whose far ends all lack the projected key emits
 * **nothing**, not itself. `h` below is exactly that vertex: it has an `E` edge to `g`, and `g` has
 * no `n`. An implementation that decided emptiness from "did any VALUE survive" would emit `h`'s own
 * `n` and pass every other test in this file.
 *
 * **EVERY SEQUENCE IS `toStrictEqual`, NOT `toEqual`, AND THAT IS NOT STYLE.** A mutant that
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
   * THE RULE THIS FILE EXISTS FOR. `h` HAS an edge, so `optional` is satisfied and the empty
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
   * `in('E')` IS HERE BECAUSE ITS ABSENCE LET A MUTANT LIVE. `soleTypeBucket` returns a
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
 * THE FIXTURE'S `d` IS THE DISCRIMINATOR. `d` has an `F` out-edge and no `E` one, so in a
 * two-hop `E` chain the vertex BEFORE it (none here) and `d` itself produce nothing. The vertex that
 * matters is `a`: it HAS `E` edges (to `b` and `c`), and `b` has none — so the path through `b` dies
 * while the path through `c` survives via the self-loop. An implementation setting `any` on the
 * FIRST hop would still be right for `a`; `h` is the one that proves the rule, because its only
 * edge goes to `g`, which has no `E` out-edge at all — so `h` produces NOTHING at two hops and must
 * emit ITSELF, where a first-hop `any` would emit nothing for it.
 */
/**
 * THE SINGLE-HOP CSR ARM IS ONLY REACHED ON A REPEAT CALL (item 1891), and this block exists
 * because FIVE mutants aimed at it survived without it. `seenBefore` declines the first ask on any
 * topology version — the amortization policy item 1889 built — so every assertion in this file that
 * calls `toArray` ONCE measures the bucket walk and says nothing about the CSR arm.
 *
 * Each case therefore runs TWICE and asserts the two agree, which is the real claim, and once more
 * through `run` for the LAZY iterator: `toArray` prefers `drain` (item 1412), so the two fills need
 * separate coverage — item 1889 lost a mutant to exactly that.
 */
describe('optionalHopValues — the single-hop CSR arm, on the repeat call', () => {
  it('agrees with the bucket walk, including the empty branch', () => {
    const g = fixture();
    const make = () => traversal(V(), optional(traversal(out('E'))), values('n'));
    const first = toArray(make(), g);

    expect(toArray(make(), g)).toStrictEqual(first);
    expect(toArray(make(), g)).toStrictEqual([2, 3, 2, 3, 4, 5]);
    // The LAZY iterator, which `drain` would otherwise hide.
    expect([...run(make(), g)]).toStrictEqual([2, 3, 2, 3, 4, 5]);
  });

  it('agrees on `id()`, where the empty branch emits the vertex itself', () => {
    const g = fixture();
    const make = () => traversal(V(), optional(traversal(out('E'))), id());
    const first = toArray(make(), g);

    expect(toArray(make(), g)).toStrictEqual(first);
    expect(toArray(make(), g)).toStrictEqual(['b', 'c', 'b', 'c', 'd', 'e', 'g', 'g']);
    expect([...run(make(), g)]).toStrictEqual(['b', 'c', 'b', 'c', 'd', 'e', 'g', 'g']);
  });

  it('agrees on `in`, where the bucket direction is observable', () => {
    const g = fixture();
    const make = () => traversal(V(), optional(traversal(in_('E'))), values('n'));
    const first = toArray(make(), g);

    expect(toArray(make(), g)).toStrictEqual(first);
    expect(toArray(make(), g)).toStrictEqual([1, 1, 1, 3, 4, 5, 8, 8]);
  });

  /**
   * `both` AND A MULTI-TYPE HOP MUST KEEP THE BUCKET WALK — the CSR appends one named bucket at a
   * time, so a two-type edge would be appended twice. `e5` carries only `E` here, so the
   * discriminating case is the `both` one: its answer differs from the directed walk's.
   */
  it('keeps `both` and multi-type on the bucket walk, on every call', () => {
    const g = fixture();
    const both2 = () => traversal(V(), optional(traversal(both('E'))), values('n'));
    const multi = () => traversal(V(), optional(traversal(out('E', 'F'))), values('n'));

    expect(toArray(both2(), g)).toStrictEqual(toArray(both2(), g));
    expect(toArray(both2(), g)).toStrictEqual([2, 3, 1, 3, 1, 3, 4, 5, 8]);
    expect(toArray(multi(), g)).toStrictEqual(toArray(multi(), g));
  });
});

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
   * A SEPARATE, PURELY LINEAR FIXTURE, because the shared one cannot tell the depths apart. On
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

  /**
   * THE CHAIN WALK IS ALSO WRITTEN TWICE SINCE ITEM 1894 — a lazy iterator and an eager `drain` —
   * and `toArray` reads only the second. Without this, half of it has no test; item 1893 lost a
   * mutant to exactly that on the edge rung and item 1891 lost five on the single-hop one.
   */
  it("the chain walk's LAZY iterator agrees with its eager drain", () => {
    const g = fixture();
    const make = () => traversal(V(), optional(traversal(out('E'), out('E'))), values('n'));

    expect([...run(make(), g)]).toStrictEqual(toArray(make(), g));
    expect([...run(make(), g)]).toStrictEqual([3, 2, 3, 4, 5, 8]);

    // `in` as well, so the chain's DIRECTION is observable through the iterator.
    const back = () => traversal(V(), optional(traversal(in_('E'), in_('E'))), values('n'));

    expect([...run(back(), g)]).toStrictEqual(toArray(back(), g));
    expect([...run(back(), g)]).toStrictEqual([1, 2, 1, 3, 4, 5, 8]);
  });

  /**
   * A CHAIN WHOSE FAR END LACKS THE KEY, on its own fixture — the shared one has none, and a
   * mutant removing the chain drain's drop therefore SURVIVED. The row still COUNTS as a row (so the
   * start does not emit itself), which is the pairing the `any`-at-the-end rule and the drop rule
   * make together.
   */
  it('drops a chain row whose far end lacks the key, without emitting the start', () => {
    const g = new Graph();

    g.addVertex({ id: 'k0', labels: ['T'], properties: { n: 10 } });
    g.addVertex({ id: 'k1', labels: ['T'], properties: { n: 20 } });
    // `k2` has NO `n`, and is the only two-hop far end from `k0`.
    g.addVertex({ id: 'k2', labels: ['T'], properties: { other: 1 } });
    g.addEdge({
      id: 'ke0',
      from: g.getVertexById('k0') as never,
      to: g.getVertexById('k1') as never,
      labels: ['E'],
    });
    g.addEdge({
      id: 'ke1',
      from: g.getVertexById('k1') as never,
      to: g.getVertexById('k2') as never,
      labels: ['E'],
    });

    const make = () => traversal(V(), optional(traversal(out('E'), out('E'))), values('n'));

    // k0: k0->k1->k2, whose `n` is absent => the row is DROPPED and k0 does NOT emit itself.
    // k1: k1->k2, then k2 has no out => the chain dies => k1 emits itself (20).
    // k2: no out => itself, no `n` => dropped.
    expect(toArray(make(), g)).toStrictEqual([20]);
    expect([...run(make(), g)]).toStrictEqual([20]);
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
   * THESE THREE ORACLES WERE WRONG IN THE FIRST DRAFT AND WERE RE-DERIVED BY HAND, not copied
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

  /**
   * AN EDGE CARRYING TWO OF THE NAMED TYPES, which is the one case the CSR arm must REFUSE. The
   * CSR appends one named bucket at a time (`buildChainCsr`, sound only "because the multi-type
   * guard has already cleared"), so such an edge would be appended TWICE where `iterLabeled`
   * dedupes it. No other fixture in this file or in `optional-oracle-1884.mjs` has one, so without
   * this test a mutant admitting multi-type hops into the CSR passes everything.
   */
  it('counts an edge carrying TWO of the named types ONCE', () => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 3; i += 1) {
      vs.push(g.addVertex({ id: `m${String(i)}`, labels: ['T'], properties: { n: i } }));
    }

    // m0 -> m1 carries BOTH types and m1 -> m2 carries ONLY `F`, which is what makes the test
    // discriminating in both directions: an arm that double-appends the two-type edge yields `2`
    // TWICE for m0, and an arm that reads only the FIRST named type never reaches m2 at all.
    g.addEdge({ id: 'me0', from: vs[0], to: vs[1], labels: ['E', 'F'] });
    g.addEdge({ id: 'me1', from: vs[1], to: vs[2], labels: ['F'] });

    // One two-hop path (m0 -> m1 -> m2), so `m0` yields 2 exactly once. m1's chain dies at m2
    // (no out-edge) so m1 emits itself; m2 has none so it emits itself.
    expect(
      toArray(traversal(V(), optional(traversal(out('E', 'F'), out('E', 'F'))), values('n')), g),
    ).toStrictEqual([2, 1, 2]);
  });

  /**
   * TWO SHAPES THAT KEEP THE GENERATOR ARM, added because the CSR arm took over every single-type
   * chain and left three mutants aimed at the generator arm surviving vacuously. `both` in ANY
   * position sends the whole chain to the generator walk, so these exercise its unrolled pair and
   * its recursion with a hop whose direction still matters.
   */
  it('serves a `both`-led pair, where the SECOND hop is still directed', () => {
    const g = fixture();

    // both(E) then out(E): a: both = [b, c]; b's out = none; c's out = [c] => 3
    //   b: both = [a]; a's out = [b, c] => 2, 3        c: both = [c, a, c] => c's out = c (3),
    //   a's out = b(2), c(3), c's out = c(3)           d/e: none => themselves (4, 5)
    //   h: both = [g]; g's out = none => dies => itself (8)
    //   g: both = [h]; h's out = [g] => g has no `n` => dropped
    expect(
      toArray(traversal(V(), optional(traversal(both('E'), out('E'))), values('n')), g),
    ).toStrictEqual([3, 2, 3, 3, 2, 3, 3, 4, 5, 8]);
  });

  it('serves a THREE-hop chain containing a `both`, which takes the recursion', () => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 5; i += 1) {
      vs.push(g.addVertex({ id: `q${String(i)}`, labels: ['T'], properties: { n: i * 10 } }));
    }

    for (let i = 0; i < 4; i += 1) {
      g.addEdge({ id: `qe${String(i)}`, from: vs[i], to: vs[i + 1], labels: ['E'] });
    }

    // out(E).out(E).both(E) on a line: q0 -> q1 -> q2, then both(E) of q2 = [q3, q1] => 30, 10.
    //   q1 -> q2 -> q3, both of q3 = [q4, q2] => 40, 20.      q2 -> q3 -> q4, both of q4 = [q3]
    //   => 30.    q3, q4: the chain dies => themselves (30, 40).
    expect(
      toArray(traversal(V(), optional(traversal(out('E'), out('E'), both('E'))), values('n')), g),
    ).toStrictEqual([30, 10, 40, 20, 30, 30, 40]);
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
   * THE MULTI-STEP SUB-PLAN MOVED FROM THIS LIST TO THE CLAIMED LIST AT ITEM 1887, deliberately.
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

describe('a residual count() rides the walk (item 2027)', () => {
  /*
   * **`count()` USED TO DECLINE THE ENTIRE PLAN**, so `V().optional(out(E)).count()` ran the
   * generic traverser pipeline — the route census read `opt: optional count` generic with all four of
   * its siblings fused — while its `values(n)` sibling, which does strictly MORE work (80,000 rows
   * against one number), was fused:
   *
   *     V().optional(out(E)).count()     7.20 ms  ->  0.48   15.0x
   *     V().optional(out(E)).values(n)   1.23         1.24   flat (control)
   *
   * The same decision item 1956 made for the EDGE-FILTER rung: the terminal is NOT consumed, so it
   * stays in `rest` and runs over this walk's stream instead of over the generic chain.
   *
   * **AND THAT IS WHY THE GATE NEED NOT CHECK `count`'s SCOPE, where item 2020's fused count
   * MUST.** An UNCONSUMED terminal is still executed by its own step, so `Scope.local` is honoured
   * by `countStep` itself; item 2020 REPLACES the count with a drain, so there the scope has to be
   * refused at the gate. Both scope cases are asserted below, against the seeded (pipeline) route.
   */
  const build = (): Graph => {
    const g = new Graph();

    for (const id of ['a', 'b', 'c']) {
      g.addVertex({ id, labels: ['P'], properties: {} });
    }

    g.addEdge({
      id: 'e1',
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'e2',
      from: g.getVertexById('a')!,
      to: g.getVertexById('c')!,
      labels: ['E'],
      properties: {},
    });

    return g;
  };

  test('THE ROUTE: the rung CLAIMS the count shape, and reports it as a residual', () => {
    /*
     * **ANSWER-EQUIVALENT, SO NOTHING ELSE HERE CAN SEE THE RUNG DECLINING.** The mutation round
     * proved it: making `count` decline again survived this file AND the whole @lenke/gremlin suite,
     * because the pipeline returns the same number. [[perf-gate-needs-its-own-test]].
     *
     * AND THE RESIDUAL'S CONTENT IS ASSERTED, NOT ITS PRESENCE — item 2021's lesson: a wrong
     * `rest` still returns a non-`undefined` object, then declines downstream and falls through to
     * the pipeline with the same answer.
     */
    const claimed = optionalHopValues(
      traversal(V(), optional(traversal(out('E'))), count()),
      build(),
    );

    expect(claimed?.rest.map((st) => st.kind)).toEqual(['count']);

    // The `values` sibling CONSUMES its projection, so its residual is empty — the other side of
    // the same `consumed` flag.
    const consumed = optionalHopValues(
      traversal(V(), optional(traversal(out('E'))), values('n')),
      build(),
    );

    expect(consumed?.rest).toEqual([]);
  });

  test('the GLOBAL count counts far ends PLUS each unmatched vertex itself', () => {
    // `a` has two out-edges -> b, c. `b` and `c` have none -> each yields ITSELF. 2 + 1 + 1 = 4.
    expect(toArray(traversal(V(), optional(traversal(out('E'))), count()), build())).toEqual([4]);
  });

  test('a vertex with NO edge contributes exactly one — the optional’s whole point', () => {
    const g = new Graph();

    g.addVertex({ id: 'lonely', labels: ['P'], properties: {} });

    expect(toArray(traversal(V(), optional(traversal(out('E'))), count()), g)).toEqual([1]);
  });

  test('`count(Scope.local)` matches the SEEDED pipeline, which this rung declines', () => {
    /*
     * THE ORACLE IS `V('a','b','c')` — naming every vertex is the same question, and the rung
     * refuses a narrowed source, so the twin runs the pipeline. Local counts each traverser's own
     * value: every value here is a vertex, so each is 1.
     */
    const g = build();
    const fast = toArray(traversal(V(), optional(traversal(out('E'))), count(Scope.local)), g);
    const general = toArray(
      traversal(V('a', 'b', 'c'), optional(traversal(out('E'))), count(Scope.local)),
      g,
    );

    expect(fast).toEqual([1, 1, 1, 1]);
    expect(fast).toEqual(general);
  });

  test('`fold()` then a local count still sees one list of four', () => {
    expect(
      toArray(traversal(V(), optional(traversal(out('E'))), fold(), count(Scope.local)), build()),
    ).toEqual([4]);
  });
});
