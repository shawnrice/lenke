import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  dedupe,
  gt,
  has,
  hasLabel,
  id,
  in_,
  out,
  toArray,
  traversal,
  values,
} from '../index.js';
import type { Plan } from '../index.js';
import { startFilteredHopValues } from './start-filtered-hop-values.js';

/**
 * `V()[…filters] out(T) …filters values(k)` — a FAR-SIDE filter between the hop and the projection,
 * which reached NEITHER values shortcut and fell to the traverser pipeline at **4.1x** (item 1603).
 *
 * `hopValuesShortcut` destructures exactly `[source, hop, proj]`, so any step after the hop sends
 * the plan to the pipeline; `startFilteredHopValues` scanned only the steps BEFORE the hop. Its own
 * count sibling (`filteredHopCount`) has answered the far-filtered shape in closed form for ages,
 * which is why the hole was invisible — the count spelling was fast and the yield spelling was not.
 *
 * ⚠️ ORDER IS PART OF THE CONTRACT HERE, unlike on the GQL side. Gremlin stream order is a
 * TinkerPop contract that the differential fuzzer compares ORDERED, so every expectation below is a
 * full ARRAY and not a count or a set. The admitted route therefore has to stay START-DRIVEN — the
 * far-driven shape `filteredHopCount` uses (one test per far vertex, contributing its degree) is
 * 3-4x faster and emits in the wrong order, so it is not available to a yielding walk.
 *
 * ⚠️ EVERY LITERAL IS FROM A HAND WALK OVER THE TABLE, derived by a script with no engine involved
 * before the file was written. Item 1602 wrote its literals by eye and SIX of fifteen were wrong
 * while the engine was right every time, so this one did it the other way round.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  [User]        score=1  >b >c ~d
 *   b  [User]        score=2  >c >e
 *   c  [Admin]       score=3  >c          a SELF-LOOP
 *   d  [User,Admin]  score=4  >a >b       TWO labels, so hasLabel is not a partition
 *   e  [Admin]       (no score)           passes a label filter and has NOTHING to project
 *   f  [User]        score=6  >e >c
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['User'],
    score: 1,
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  {
    id: 'b',
    labels: ['User'],
    score: 2,
    out: [
      ['c', 'E'],
      ['e', 'E'],
    ],
  },
  { id: 'c', labels: ['Admin'], score: 3, out: [['c', 'E']] },
  {
    id: 'd',
    labels: ['User', 'Admin'],
    score: 4,
    out: [
      ['a', 'E'],
      ['b', 'E'],
    ],
  },
  { id: 'e', labels: ['Admin'], score: undefined, out: [] },
  {
    id: 'f',
    labels: ['User'],
    score: 6,
    out: [
      ['e', 'E'],
      ['c', 'E'],
    ],
  },
] as const;

const build = (indexed = false): Graph => {
  const g = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.score !== undefined) {
      properties.score = r.score;
    }

    g.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      g.addEdge({
        id: `e${n++}`,
        from: g.getVertexById(r.id) as Vertex,
        to: g.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });
  }

  return g;
};

const g = build();
const ran = (plan: Plan): unknown[] =>
  toArray(plan, g).map((x) => (x !== null && typeof x === 'object' && 'id' in x ? x.id : x));
const routed = (plan: Plan): boolean => startFilteredHopValues(plan, g) !== undefined;

describe('a far-side filter before the projection', () => {
  test('no leading filter at all, which used to be an outright decline', () => {
    /**
     * ⚠️ THE GUARD THAT MOVED. `at === 1` (no step between the source and the hop) was a decline,
     * on the stated grounds that "`hopValuesShortcut` already owns the plan" — true only when the
     * hop is immediately followed by the projection. With a far-side filter that shortcut declines
     * too, so the plan reached NEITHER. And this is the COMMON spelling, because `effectivePlan`'s
     * `dropVacuousLabels` deletes a leading `hasLabel` whenever every vertex carries it.
     */
    const plan = traversal(V(), out('E'), has('score', gt(2)), values('score'));

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([3, 3, 3, 3]);
  });

  test('the same far filter projecting ids instead', () => {
    const plan = traversal(V(), out('E'), has('score', gt(2)), id());

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual(['c', 'c', 'c', 'c']);
  });

  test('a far hasLabel', () => {
    const plan = traversal(V(), out('E'), hasLabel('Admin'), values('score'));

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([3, 3, 3, 3]);
  });

  test('⚠️ the far filter KEEPS a vertex with nothing to project, and values drops it', () => {
    /**
     * THE CASE THE `drops` SENTINEL RESTS ON. `e` is `Admin`, so it passes the far filter, and it
     * has NO `score` — so `values(score)` must emit nothing for it while `id()` must emit it. The
     * filter is folded into `pick` and signalled by returning `undefined`, so this is the pair that
     * proves the sentinel is not conflating "rejected by the filter" with "has no such property":
     * both correctly yield nothing under `values`, and the id form shows the filter kept six.
     */
    expect(ran(traversal(V(), out('E'), hasLabel('Admin'), values('score')))).toEqual([3, 3, 3, 3]);
    expect(ran(traversal(V(), out('E'), hasLabel('Admin'), id()))).toEqual([
      'c',
      'c',
      'e',
      'c',
      'e',
      'c',
    ]);
  });

  test('a leading filter AND a far filter together', () => {
    const plan = traversal(V(), hasLabel('User'), out('E'), has('score', gt(2)), values('score'));

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([3, 3, 3]);
  });

  test('TWO far filters', () => {
    const plan = traversal(
      V(),
      hasLabel('User'),
      out('E'),
      hasLabel('Admin'),
      has('score', gt(2)),
      values('score'),
    );

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([3, 3, 3]);
  });

  test('an `in` hop, where the far end is the edge SOURCE', () => {
    // The direction discriminator: reversing it would give the `out` answer instead.
    const plan = traversal(V(), in_('E'), has('score', gt(2)), values('score'));

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([4, 4, 3, 6, 6]);
  });

  test('a far filter that keeps nothing', () => {
    const plan = traversal(V(), out('E'), has('score', gt(99)), values('score'));

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([]);
  });

  test('a seekable far `has` is answered even with the index present', () => {
    /**
     * The same asymmetry item 1602 records: a seekable LEADING `has` defers to `seedFromIndex`,
     * because a seek seeds the SOURCE — but nothing seeds from the FAR side of a hop, so refusing
     * there would decline the shape on every indexed graph and gain nothing.
     */
    const indexed = build(true);
    const plan = traversal(V(), out('E'), has('score', gt(2)), values('score'));

    expect(startFilteredHopValues(plan, indexed)).not.toBeUndefined();
    expect(toArray(plan, indexed)).toEqual([3, 3, 3, 3]);

    // And the LEADING twin still defers on the same indexed graph.
    expect(
      startFilteredHopValues(
        traversal(V(), has('score', gt(2)), out('E'), hasLabel('Admin'), values('score')),
        indexed,
      ),
    ).toBeUndefined();
  });
});

describe('what the module still leaves alone', () => {
  test('neither side filtered stays `hopValuesShortcut`’s plan', () => {
    // The decline did not disappear with the `at === 1` guard — it moved to "no filter on EITHER
    // side", which is the condition that was actually meant. That shortcut has four walks this
    // module deliberately does not fork.
    expect(routed(traversal(V(), out('E'), values('score')))).toBe(false);
    expect(routed(traversal(V(), out('E'), id()))).toBe(false);
    expect(routed(traversal(V(), out('E')))).toBe(false);
  });

  test('and still answers them correctly, through whichever route owns them', () => {
    expect(ran(traversal(V(), out('E'), values('score')))).toEqual([2, 3, 3, 3, 1, 2, 3]);
    expect(ran(traversal(V(), hasLabel('User'), out('E'), values('score')))).toEqual([
      2, 3, 3, 1, 2, 3,
    ]);
  });

  test('a step after the projection is a RESIDUAL, not a filter', () => {
    /**
     * The far scan stops at the projection, so a trailing step lands in `rest` and the pipeline
     * runs it over the yielded SCALARS.
     *
     * ⚠️ `id()` was the first spelling tried here and the engine REFUSED it statically:
     * `assertFrontierTypes` raises "id() reads from a graph element, but the frontier is a
     * projected scalar". That is the right behaviour and the wrong test, so this uses `dedupe`,
     * which legally follows a scalar and shows the residual actually running.
     */
    const plan = traversal(V(), out('E'), has('score', gt(2)), values('score'), dedupe());

    expect(routed(plan)).toBe(true);
    expect(ran(plan)).toEqual([3]);
  });

  test('an unrecognised step between the hop and the projection declines', () => {
    expect(routed(traversal(V(), out('E'), out('E'), values('score')))).toBe(false);
  });
});
