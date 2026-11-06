import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { V, both, count, dedupe, eq, gt, has, hasLabel, in_, out, traversal } from '../index.js';
import type { Plan } from '../index.js';
import { countShortcut } from './count-shortcut.js';
import { effectivePlan } from './index.js';

/**
 * `V()[…filters] out(T) …filters dedupe() .count()` — a DISTINCT far count with a filter, which fell
 * off `distinctHopCount`'s arity gate at **76.5x** (item 1613).
 *
 * ```text
 *    V().out(E).dedupe().count()                  173908 ns   CLOSED (`distinctHopCount`)
 *    V().out(E).has(team,eq).dedupe().count()   13309727      THE PIPELINE      76.5x
 *    ... after this rung                           616026      21.6x, and 3.42x of its neighbour
 * ```
 *
 * `countShortcut` gates `distinctHopCount` on `mid.length !== 2`, so ONE filter between the hop and
 * the dedupe dropped the whole query to the pipeline — which then also builds a `Set` of every
 * distinct far vertex.
 *
 * ⚠️ EVERY LITERAL IS DERIVED BY A SCRIPT over the table below, before this file was written, and
 * the LEAD cases were chosen from a derived (no lead / User lead / Admin lead) table because the
 * obvious ones do not discriminate — exactly the trap item 1612's mutation pass found.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  [User]        team=t1  >b >c ~d
 *   b  [User]        team=t1  >c >e
 *   c  [Admin]       team=t2  >c          a SELF-LOOP: c is its own distinct endpoint
 *   d  [User,Admin]  team=t1  >a >b       TWO labels, so hasLabel is not a partition
 *   e  [Admin]       (no team)            a MISSING property, and NO out-edges
 *   f  [User]        team=t2  >e >c
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['User'],
    team: 't1',
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  {
    id: 'b',
    labels: ['User'],
    team: 't1',
    out: [
      ['c', 'E'],
      ['e', 'E'],
    ],
  },
  { id: 'c', labels: ['Admin'], team: 't2', out: [['c', 'E']] },
  {
    id: 'd',
    labels: ['User', 'Admin'],
    team: 't1',
    out: [
      ['a', 'E'],
      ['b', 'E'],
    ],
  },
  { id: 'e', labels: ['Admin'], team: undefined, out: [] },
  {
    id: 'f',
    labels: ['User'],
    team: 't2',
    out: [
      ['e', 'E'],
      ['c', 'E'],
    ],
  },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.team !== undefined) {
      properties.team = r.team;
    }

    graph.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  return graph;
})();

/** Through `effectivePlan`, because that is what `run` hands the rungs — see the note below. */
const answered = (plan: Plan): number | undefined =>
  countShortcut(effectivePlan(plan, g, false), g);

describe('a distinct far count with a filter', () => {
  test('one far `has` — the shape at 76.5x', () => {
    // E-targets with team t1 are a and b.
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), dedupe(), count()))).toBe(2);
  });

  test('⚠️ the `dedupe` BEFORE the filter answers the same — one rung, two spellings', () => {
    /**
     * `dedupe` does not change which vertices pass a filter, and this is a COUNT, so emission order
     * is not observable either. Both spellings describe the same set and must therefore cost the
     * same — the property this engine is named after.
     */
    expect(answered(traversal(V(), out('E'), dedupe(), has('team', eq('t1')), count()))).toBe(2);
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), dedupe(), count()))).toBe(2);
  });

  test('a far `hasLabel`, where the SELF-LOOP counts itself once', () => {
    // Admin E-targets are c (from a, b, f AND its own loop) and e (from b, f) — distinct: 2.
    expect(answered(traversal(V(), out('E'), hasLabel('Admin'), dedupe(), count()))).toBe(2);
  });

  test('TWO far filters', () => {
    expect(
      answered(
        traversal(V(), out('E'), hasLabel('Admin'), has('team', eq('t2')), dedupe(), count()),
      ),
    ).toBe(1);
  });

  test('⚠️ a leading filter that DISCRIMINATES', () => {
    /**
     * Derived, because the obvious choice does not separate:
     *
     * ```text
     *    far filter     no lead   User lead   Admin lead
     *      hasLabel(Admin)   2        2            1      <- separates
     *      hasLabel(User)    2        2            2
     *      (none)            4        4            3
     *      team = t2         1        1            1
     * ```
     *
     * With an `Admin` lead only `c` remains reachable (`c -> c`), where a `User` lead reaches both
     * `c` and `e`. A lead filter that changes nothing would let a mutant dropping it pass.
     */
    expect(answered(traversal(V(), out('E'), hasLabel('Admin'), dedupe(), count()))).toBe(2);
    expect(
      answered(traversal(V(), hasLabel('User'), out('E'), hasLabel('Admin'), dedupe(), count())),
    ).toBe(2);
    expect(
      answered(traversal(V(), hasLabel('Admin'), out('E'), hasLabel('Admin'), dedupe(), count())),
    ).toBe(1);
  });

  test('an `in` hop, where the far end is the edge SOURCE', () => {
    // E-sources whose team is t1: a, b, d.
    expect(answered(traversal(V(), in_('E'), has('team', eq('t1')), dedupe(), count()))).toBe(3);
  });

  test('an ORDERING predicate, so the rung is not quietly equality-only', () => {
    // `team > 't1'` is t2: only c among the E-targets.
    expect(answered(traversal(V(), out('E'), has('team', gt('t1')), dedupe(), count()))).toBe(1);
  });

  test('a MISSING property is rejected by `has` and kept by `hasLabel`', () => {
    // `e` has no team, so no `has('team', …)` admits it — but it IS a distinct Admin endpoint.
    expect(answered(traversal(V(), out('E'), has('team', eq('t9')), dedupe(), count()))).toBe(0);
    expect(answered(traversal(V(), out('E'), hasLabel('Admin'), dedupe(), count()))).toBe(2);
  });
});

describe('the rung declines what it must', () => {
  test('NO far filter — that is `distinctHopCount`’s own shape, which still answers', () => {
    expect(answered(traversal(V(), out('E'), dedupe(), count()))).toBe(4);
  });

  test('a `both` hop', () => {
    expect(
      answered(traversal(V(), both('E'), has('team', eq('t1')), dedupe(), count())),
    ).toBeUndefined();
  });

  test('TWO hops', () => {
    expect(
      answered(traversal(V(), out('E'), out('E'), has('team', eq('t1')), dedupe(), count())),
    ).toBeUndefined();
  });

  test('a `dedupe` with a BY-modulator or a path label dedupes on something else', () => {
    expect(
      answered(traversal(V(), out('E'), has('team', eq('t1')), dedupe('x'), count())),
    ).toBeUndefined();
  });

  test('no `dedupe` at all is the plain filtered hop count, not this', () => {
    /**
     * `filteredHopCount` answers it, and it is a DIFFERENT number — **3** E-edges reach a t1 target
     * (`d->a`, `a->b`, `d->b`) against **2** distinct such targets (`a`, `b`). That difference is
     * the whole point of the rung.
     *
     * ⚠️ I wrote 3 as 4 by eye, which is the FOURTH eyeballed literal this session the engine was
     * right about. Derived: targets with `team = t1` are `a` and `b`; the E-edges into them are
     * `d->a`, `a->b` and `d->b`.
     */
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), count()))).toBe(3);
  });

  test('⚠️ the verdict must be asked of the EFFECTIVE plan', () => {
    /**
     * `effectivePlan` runs `dropVacuousLabels`, so a leading `hasLabel` every vertex carries is
     * DELETED before any rung sees the plan. Asking the raw plan reports a different verdict for the
     * same query — which is what `gremlin-cliff-finder.ts` did in its first version, inventing a
     * `pipeline` reading for a shape that is in fact CLOSED.
     */
    const single = new Graph();

    for (const id of ['x', 'y']) {
      single.addVertex({ id, labels: ['Only'], properties: { k: 1 } });
    }

    single.addEdge({
      id: 'z',
      from: single.getVertexById('x') as Vertex,
      to: single.getVertexById('y') as Vertex,
      labels: ['E'],
      properties: {},
    });

    /**
     * ⚠️ AND IT HAS TO BE A SHAPE WHERE THE VERDICT ACTUALLY DIFFERS. The first version of this test
     * used `hasLabel(Only).out(E).has(k,1).dedupe()`, which THIS rung answers on the raw plan too —
     * it treats the leading `hasLabel` as a lead filter. The shape that separates is the
     * UNFILTERED one, because `distinctHopCount` is gated on `mid.length !== 2` and the vacuous
     * label makes it 3.
     */
    const plan = traversal(V(), hasLabel('Only'), out('E'), dedupe(), count());

    expect(countShortcut(plan, single)).toBeUndefined();
    expect(countShortcut(effectivePlan(plan, single, false), single)).toBe(1);
  });
});
