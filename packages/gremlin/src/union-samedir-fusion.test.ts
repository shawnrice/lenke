import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { fuseUnionSameDir } from './executor/index.js';
import {
  V,
  both,
  count,
  dedupe,
  in_,
  inE,
  out,
  outE,
  toArray,
  traversal,
  union,
  values,
} from './index.js';

/**
 * `union(out(T), out(U))` fusing to `out(T, U)` — and the four ways it must NOT (item 1460).
 *
 * Item 1459 measured the pair at **172,061x** (0.001 ms against 251.210) on identical answers, once
 * that probe's fixture gained a second edge label. Item 1311 had already built the sibling rewrite
 * for the same TYPE in opposite directions; this is the same DIRECTION with different types.
 *
 * ⚠️ THE FIXTURE THAT MATTERS IS THE ONE WITH AN EDGE IN BOTH BUCKETS, and item 1459 flagged that it
 * did not exist anywhere. `union(out(T), out(U))` CONCATENATES, so an edge carrying both `T` and `U`
 * is emitted TWICE; `out(T, U)` dedupes across buckets and emits it ONCE. The rewrite is therefore
 * answer-changing on such a graph, and is gated on `graph.multiTypeEdgeCount === 0`.
 *
 * Without a multi-label-edge fixture every test here would pass with the gate deleted — which is
 * precisely the hole item 1453 found in the bench (no parallel edges, so a scan replaced by
 * `return 1` passed every row) and item 922 found in the Rust corpus (no fixture varied the index
 * count). So the multi-label case is the FIRST describe block, not an afterthought.
 *
 * THE ORACLE IS THE UNION SPELLING ITSELF, run on a graph where the gate declines. That is sound
 * here precisely because the rewrite is what is under test: when `multiTypeEdgeCount > 0` no rewrite
 * happens, so the union's own answer is the engine's unoptimised behaviour and the thing the fused
 * form must match on the graphs where it IS applied.
 */

/** `a->b` on T, `a->c` on U, and — when `shared` — ONE edge carrying BOTH T and U. */
const build = (shared: boolean): Graph => {
  const g = new Graph();
  const vs = ['a', 'b', 'c', 'd'].map((id) =>
    g.addVertex({ id, labels: ['P'], properties: { k: id } }),
  );

  g.addEdge({ id: 't1', from: vs[0], to: vs[1], labels: ['T'], properties: {} });
  g.addEdge({ id: 'u1', from: vs[0], to: vs[2], labels: ['U'], properties: {} });
  g.addEdge({ id: 't2', from: vs[1], to: vs[3], labels: ['T'], properties: {} });
  g.addEdge({
    id: 'both1',
    from: vs[2],
    to: vs[3],
    labels: shared ? ['T', 'U'] : ['T'],
    properties: {},
  });

  return g;
};

const n = (g: Graph, ...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

describe('⚠️ AN EDGE IN BOTH BUCKETS: the spellings DISAGREE and the gate must decline (item 1460)', () => {
  test('the union counts the shared edge twice and the fused form once', () => {
    // THE WHOLE SOUNDNESS CASE. 4 edges, one carrying T and U: out(T) sees 3, out(U) sees 2, so the
    // union emits 5 while out(T, U) emits the 4 DISTINCT edges. Both numbers are correct for their
    // own spelling — which is why the rewrite is gated and not just ordered.
    const g = build(true);

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(n(g, V(), union(out('T'), out('U')), count())).toBe(5);
    expect(n(g, V(), out('T', 'U'), count())).toBe(4);
  });

  test('so the union spelling keeps ITS answer on such a graph', () => {
    // If the gate were deleted the rewrite would fire here and answer 4. Asserting the 5 is what
    // catches that — and nothing else in this suite would.
    const g = build(true);

    expect(n(g, V(), union(out('T'), out('U')), count())).toBe(5);
    expect(n(g, V(), union(out('T'), out('U')), dedupe(), count())).toBe(3);
  });

  test('and the rewrite itself declines, asserted on the plan', () => {
    // The WIRING and the GATE, not just the answer: a rewrite that fired and happened to agree would
    // pass the counts above on some other fixture.
    const g = build(true);
    const plan = traversal(V(), union(out('T'), out('U')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
  });
});

describe('no edge in two buckets: the spellings agree and the rewrite fires (item 1460)', () => {
  test('⚠️ the counts match, and the plan is actually REWRITTEN', () => {
    const g = build(false);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(n(g, V(), union(out('T'), out('U')), count())).toBe(n(g, V(), out('T', 'U'), count()));
    expect(n(g, V(), out('T', 'U'), count())).toBe(4);

    // The plan assertion: answer-equality alone cannot tell a fired rewrite from a declined one,
    // which is the trap item 1447 paid three ticks for.
    const plan = traversal(V(), union(out('T'), out('U')), count());
    const fused = fuseUnionSameDir(plan, g);

    expect(fused).not.toBe(plan);
    expect(fused.steps[1]).toEqual({ kind: 'out', labels: ['T', 'U'] });
  });

  test('the INCOMING direction too, and the label ORDER is preserved', () => {
    const g = build(false);

    expect(n(g, V(), union(in_('T'), in_('U')), count())).toBe(n(g, V(), in_('T', 'U'), count()));

    const fused = fuseUnionSameDir(traversal(V(), union(in_('U'), in_('T')), count()), g);

    expect(fused.steps[1]).toEqual({ kind: 'in', labels: ['U', 'T'] });
  });

  test('the EDGE forms, which have their own kinds', () => {
    const g = build(false);

    expect(n(g, V(), union(outE('T'), outE('U')), count())).toBe(
      n(g, V(), outE('T', 'U'), count()),
    );
    expect(n(g, V(), union(inE('T'), inE('U')), count())).toBe(n(g, V(), inE('T', 'U'), count()));

    expect(
      fuseUnionSameDir(traversal(V(), union(outE('T'), outE('U')), count()), g).steps[1],
    ).toEqual({ kind: 'outE', labels: ['T', 'U'] });
  });

  test('a `dedupe` tail is admitted, as item 1311 established for its sibling', () => {
    const g = build(false);

    expect(n(g, V(), union(out('T'), out('U')), dedupe(), count())).toBe(
      n(g, V(), out('T', 'U'), dedupe(), count()),
    );
  });
});

describe('the shapes that must DECLINE even with no multi-type edge (item 1460)', () => {
  test('⚠️ a SHARED type name declines — and it exposed a COUNT-vs-YIELD divergence (item 1460)', () => {
    // I wrote this expecting `out(T, T)` to emit each edge ONCE (the earlier-buckets dedupe), and it
    // does not. What the engine actually does, and what TinkerPop 3.7.3 says:
    //
    //   out(T, T).count()      lenke 6    TinkerPop 6    <- agree
    //   out(T, T) yielding     lenke 3    TinkerPop 6    <- DIVERGE
    //
    // TinkerPop traverses each NAMED label separately, so a duplicated name means each edge is
    // traversed twice: its values are `[b, b, d, d, d, d]`. lenke's count path agrees; its yield path
    // applies the earlier-buckets dedupe by EDGE IDENTITY and collapses the two copies to `[b, d, d]`.
    // So the engine also disagrees with ITSELF on one query, which is true independently of
    // TinkerPop. Recorded as a flagged bug in item 1460, not fixed here.
    //
    // The rewrite declines this shape either way, which is what this test is for: the count spellings
    // agree at 6 so fusing a COUNT would be sound, but the yield spellings do not, and one guard that
    // refuses the shape outright is the conservative choice while the divergence stands.
    const g = build(false);

    expect(n(g, V(), union(out('T'), out('T')), count())).toBe(6);
    expect(n(g, V(), out('T', 'T'), count())).toBe(6);
    expect(toArray(traversal(V(), out('T', 'T'), values('k')), g)).toEqual(['b', 'd', 'd']);

    const plan = traversal(V(), union(out('T'), out('T')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
  });

  test('an UNTYPED side: out() is every type, so the union is every edge twice', () => {
    const g = build(false);
    const plan = traversal(V(), union(out(), out('U')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
    expect(n(g, V(), union(out(), out('U')), count())).toBe(5);
  });

  test('MIXED directions stay with item 1311, which has its own rule', () => {
    const g = build(false);
    const plan = traversal(V(), union(out('T'), in_('U')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
  });

  test('`both` is excluded — it has no two-type hand walk to fuse into', () => {
    const g = build(false);
    const plan = traversal(V(), union(both('T'), both('U')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
    // Still answered correctly by the unfused route.
    expect(n(g, V(), union(both('T'), both('U')), count())).toBe(8);
  });

  test('an ORDER-SENSITIVE tail declines, because the two are not sequence-equal', () => {
    // The fused form finishes a vertex's buckets together; the union interleaves branches. Item 1308
    // measured that difference directly for the sibling rewrite.
    const g = build(false);
    const plan = traversal(V(), union(out('T'), out('U')));

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
  });

  test('a union of three branches is not this shape', () => {
    const g = build(false);
    const plan = traversal(V(), union(out('T'), out('U'), out('V')), count());

    expect(fuseUnionSameDir(plan, g)).toBe(plan);
  });
});
