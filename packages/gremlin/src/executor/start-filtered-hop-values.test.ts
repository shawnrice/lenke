/**
 * `V().hasLabel(L).out(T).values(k)` — a hop with a FILTERED START, which `hopValuesShortcut`
 * declined outright and which `startFilteredHopValues` now answers (items 1534/1535).
 *
 * ⚠️ EVERY EXPECTATION HERE IS DERIVED FROM THE FIXTURE BY HAND, not recorded from the engine.
 * The shape previously declined to the traverser pipeline, so the existing suite has no row that
 * covers it — there was nothing in place to notice a wrong answer, exactly as item 1529 found on
 * the GQL side. A recorded expectation would have tested that the new walk agrees with itself.
 *
 * The fixture is built to be discriminating rather than representative:
 *
 * ```text
 *   a  [P, Q]  k=1   -E-> b, -E-> c, -F-> d        two E edges and one of another type
 *   b  [P]     k=2   -E-> a                        fails `hasLabel(Q)`, so its edge must NOT appear
 *   c  [P, Q]  k=3   -E-> c                        a SELF-LOOP, which must yield exactly once
 *   d  [P, Q]        (no k)                        passes the label, has NO adjacency at all
 *   e  [P, Q]  k=5                                 no adjacency either, and k is present
 *   f  [Q]     k=6   -E-> g                        Q WITHOUT P, for the two-label spelling
 *   g  [P, Q]  (no k)                              a far end LACKING the projected key
 * ```
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  count,
  gt,
  has,
  hasLabel,
  id,
  in_,
  order,
  out,
  toArray,
  traversal,
  values,
} from '../index.js';
import { startFilteredHopValues } from './start-filtered-hop-values.js';

let g: Graph;

beforeAll(() => {
  g = new Graph();
  const v = (vid: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id: vid, labels, properties: props });

  const a = v('a', ['P', 'Q'], { k: 1 });
  const b = v('b', ['P'], { k: 2 });
  const c = v('c', ['P', 'Q'], { k: 3 });
  const d = v('d', ['P', 'Q'], {});
  v('e', ['P', 'Q'], { k: 5 });
  const f = v('f', ['Q'], { k: 6 });
  const gg = v('g', ['P', 'Q'], {});

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: a, to: d, labels: ['F'], properties: {} });
  g.addEdge({ id: 'e4', from: b, to: a, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e5', from: c, to: c, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e6', from: f, to: gg, labels: ['E'], properties: {} });
});

const run = (t: Parameters<typeof toArray>[0]) => toArray(t, g);

describe('item 1535 — a filtered start on a yielded hop', () => {
  /**
   * ⚠️ THE TWO THINGS THAT NEARLY SHIPPED WRONG, both from seeding the walk out of
   * `graph.verticesByLabel.get(L)` the way `startFilteredHopCount` does. A count cannot observe
   * either one; a yielded stream observes both. See the comment at `tests` in the module.
   */
  test('rows come out in GLOBAL vertex order, not label-bucket order', () => {
    const h = new Graph();
    // Q on the ODD vertices, so the Q bucket is a non-prefix subsequence of insertion order. If the
    // walk seeded from the bucket this would still pass — the bucket is in insertion order too —
    // so the discriminating part is the SECOND graph below, where it is not.
    const mk = (hh: Graph, ids: readonly string[], qs: readonly string[]) => {
      const vs = ids.map((vid) =>
        hh.addVertex({ id: vid, labels: qs.includes(vid) ? ['Q'] : ['P'], properties: { k: vid } }),
      );

      for (const v of vs) {
        hh.addEdge({ id: `x${v.id}`, from: v, to: v, labels: ['E'], properties: {} });
      }

      return vs;
    };

    mk(h, ['n0', 'n1', 'n2', 'n3'], ['n1', 'n3']);
    expect(toArray(traversal(V(), hasLabel('Q'), out('E'), values('k')), h)).toEqual(['n1', 'n3']);

    // Now a graph whose Q bucket order CANNOT match global order: `n2` is given `Q` through
    // `addLabelToVertex` AFTER `n3` already has it, so the bucket is [n3, n2] while global order is
    // [n2, n3]. The pipeline emits global order, so this is the case that separates the two.
    const j = new Graph();

    const jvs = mk(j, ['n0', 'n1', 'n2', 'n3'], ['n3']);

    // `(label, vertex)`, in that order.
    j.addLabelToVertex('Q', jvs[2]);

    expect([...j.getVerticesByLabel('Q')].map((v) => v.id)).toEqual(['n3', 'n2']);
    expect(toArray(traversal(V(), hasLabel('Q'), out('E'), values('k')), j)).toEqual(['n2', 'n3']);
  });

  test('the raw labels SETTER is honoured, though it leaves verticesByLabel stale', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['Q'], properties: { k: 2 } });

    h.addEdge({ id: 'x1', from: a, to: a, labels: ['E'], properties: {} });
    h.addEdge({ id: 'x2', from: b, to: b, labels: ['E'], properties: {} });

    // `core`'s `label-box.test.ts` pins this: the setter does NOT reindex, so the bucket is now
    // wrong in BOTH directions at once — it still lists `b` and does not list `a`.
    a.labels = ['Q'];
    b.labels = ['P'];

    expect([...h.getVerticesByLabel('Q')].map((v) => v.id)).toEqual(['b']);

    // `labels.has` is the truth, and it is what the general pipeline tests. A bucket-seeded walk
    // would answer [2] here — the exact value this asserts against.
    expect(toArray(traversal(V(), hasLabel('Q'), out('E'), values('k')), h)).toEqual([1]);
  });

  /**
   * THE ROUTE ITSELF, asserted directly rather than inferred from a number.
   *
   * A route choice is answer-equivalent, so no differential test can see it (the standing rule from
   * `perf-gate-needs-its-own-test`). These check the admission boundary: what the walk claims and
   * what it leaves to the walks that already existed.
   */
  test('the start-filtered shape is CLAIMED, and the unfiltered one is left to hopValuesShortcut', () => {
    const claimed = startFilteredHopValues(traversal(V(), hasLabel('Q'), out('E'), values('k')), g);

    expect(claimed).toBeDefined();
    expect(claimed?.rest).toEqual([]);

    // No filter between the source and the hop: `hopValuesShortcut` owns it, so this declines.
    expect(startFilteredHopValues(traversal(V(), out('E'), values('k')), g)).toBeUndefined();
  });

  test('a residual step is handed back rather than swallowed', () => {
    const claimed = startFilteredHopValues(
      traversal(V(), hasLabel('Q'), out('E'), values('k'), order()),
      g,
    );

    expect(claimed?.rest.map((s) => s.kind)).toEqual(['order']);
  });

  test('the walks this module does NOT take still decline', () => {
    // `both`, an untyped hop and a multi-type hop are `hopValuesShortcut`'s other walks; declining
    // leaves them exactly where they were.
    for (const t of [
      traversal(V(), hasLabel('Q'), out(), values('k')),
      traversal(V(), hasLabel('Q'), out('E', 'F'), values('k')),
      traversal(V(), hasLabel('Q'), out('E'), values('k', 'n')),
      // A step between the source and the hop that is not a vertex filter at all.
      traversal(V(), hasLabel('Q'), order(), out('E'), values('k')),
    ]) {
      expect(startFilteredHopValues(t, g)).toBeUndefined();
    }
  });

  /**
   * THE ANSWERS. `hasLabel('Q')` keeps a, c, d, e, f, g and drops b — so b's `-E-> a` must be
   * absent, which is the whole point of the filter and the one thing a vacuous label cannot test.
   */
  test('values(k) over a seeded label bucket', () => {
    // a -E-> b (k=2), a -E-> c (k=3), c -E-> c (k=3, ONCE), f -E-> g (no k, DROPPED).
    // a's -F-> d is a different type. b -E-> a is excluded by the filter.
    expect(run(traversal(V(), hasLabel('Q'), out('E'), values('k'))).sort()).toEqual([2, 3, 3]);
  });

  test('the far end LACKING the key is dropped, and only by the value projection', () => {
    // f -E-> g survives the walk; g has no `k`, so `values` drops it but `id()` does not.
    // a -E-> b and a -E-> c, c -E-> c, f -E-> g. (My first hand-derivation wrote 'a' for a's own
    // far end and the engine was right; checked back against the edge list above, not recounted.)
    expect(run(traversal(V(), hasLabel('Q'), out('E'), id())).sort()).toEqual(['b', 'c', 'c', 'g']);
    expect(run(traversal(V(), hasLabel('Q'), out('E'))).length).toBe(4);
  });

  test('the SELF-LOOP yields exactly once', () => {
    expect(run(traversal(V(), hasLabel('Q'), has('k', 3), out('E'), id()))).toEqual(['c']);
  });

  test('a start that passes the filter with NO adjacency contributes nothing', () => {
    // d and e both carry Q and have no outgoing E at all; neither may yield, and neither may throw.
    expect(run(traversal(V(), hasLabel('Q'), has('k', 5), out('E'), id()))).toEqual([]);
  });

  test('an UNSEEDED first filter walks every vertex and agrees', () => {
    // `has` first, so `canSeed` is false: every vertex is tested. k>1 keeps b, c, f (and drops a).
    // b -E-> a (k=1), c -E-> c (k=3), f -E-> g (no k, dropped).
    expect(run(traversal(V(), has('k', gt(1)), out('E'), values('k'))).sort()).toEqual([1, 3]);
  });

  test('TWO filters both apply, in written order', () => {
    // Q and k>2 keeps c (k=3) and f (k=6). c -E-> c yields 3; f -E-> g has no k.
    expect(run(traversal(V(), hasLabel('Q'), has('k', gt(2)), out('E'), values('k')))).toEqual([3]);
    // The reverse spelling must agree — same filters, same answer (the equivalent-spelling rule).
    expect(run(traversal(V(), has('k', gt(2)), hasLabel('Q'), out('E'), values('k')))).toEqual([3]);
  });

  test('a TWO-LABEL hasLabel cannot seed from one bucket and still answers', () => {
    // `hasLabel('P','Q')` is every vertex here, so this is every vertex's out-E:
    // a->b (2), a->c (3), b->a (1), c->c (3), f->g (dropped).
    expect(run(traversal(V(), hasLabel('P', 'Q'), out('E'), values('k'))).sort()).toEqual([
      1, 2, 3, 3,
    ]);
  });

  test('a filter matching NOTHING yields no rows', () => {
    expect(run(traversal(V(), hasLabel('Nope'), out('E'), values('k')))).toEqual([]);
    expect(run(traversal(V(), has('k', gt(999)), out('E'), values('k')))).toEqual([]);
  });

  test('the `in` direction reads the OTHER side and the other endpoint', () => {
    // Incoming E of the Q-carrying starts: a <-E- b (k=2), c <-E- a (k=1), c <-E- c (k=3),
    // g <-E- f (k=6). d, e and f have no incoming E. Derived from the edge list, not recorded.
    expect(run(traversal(V(), hasLabel('Q'), in_('E'), values('k'))).sort()).toEqual([1, 2, 3, 6]);
    // c's incoming E are e2 (from a) and e5 (from ITSELF), so the self-loop is one row of two —
    // NOT the `out` answer. I copied `['c']` from the out case first and the engine was right.
    expect(run(traversal(V(), hasLabel('Q'), has('k', 3), in_('E'), id())).sort()).toEqual([
      'a',
      'c',
    ]);
  });

  test('a residual step consumes the walk correctly', () => {
    expect(run(traversal(V(), hasLabel('Q'), out('E'), values('k'), order()))).toEqual([2, 3, 3]);
    expect(run(traversal(V(), hasLabel('Q'), out('E'), count()))).toEqual([4]);
  });
});
