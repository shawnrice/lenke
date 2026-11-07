import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { maskOfSteps } from './ast.js';
import { seedSingleHasId } from './executor/index.js';
import { E, V, count, hasId, hasLabel, id, out, toArray, traversal, values } from './index.js';

/**
 * `V().hasId(x)` is rewritten to the seeded source `V(x)` — ONE id only (item 1643). **1.58x** on
 * `hasId(x).values(k)` and **1.91x** on `hasId(x).count()`, with the already-seeded spellings flat as
 * controls.
 *
 * ⚠️⚠️ EXACTLY ONE ID, AND THE BOUNDARY IS THE WHOLE CORRECTNESS QUESTION. Above one id the two
 * spellings genuinely disagree, measured before the rewrite was written:
 *
 * ```text
 *   V().hasId(v3, v1).id()  ->  ["v1", "v3"]     GRAPH order, filtered
 *   V(v3, v1).id()          ->  ["v3", "v1"]     the order the IDS were given
 *   V().hasId(v1, v1).id()  ->  ["v1"]           a filter matches a vertex once
 *   V(v1, v1).id()          ->  ["v1", "v1"]     a seed emits once per id
 * ```
 *
 * Gremlin stream order is a TinkerPop contract the differential fuzzer compares ORDERED, and the
 * multiplicity difference is a wrong answer outright. So the tests below pin the DECLINE for both
 * cases with literals, not just the admit.
 *
 * The fixture: five vertices `v0..v4` with `k = i`, and one `E` edge `v0 -> v1` carrying `w: 1`.
 */
const g = ((): Graph => {
  const graph = new Graph();

  for (let i = 0; i < 5; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  graph.addEdge({
    id: 'e0',
    from: graph.getVertexById('v0') as Vertex,
    to: graph.getVertexById('v1') as Vertex,
    labels: ['E'],
    properties: { w: 1 },
  });

  return graph;
})();

describe('the seeded rewrite answers what the filter answers', () => {
  test('ONE id — the shape at 1.58x', () => {
    expect(toArray(traversal(V(), hasId('v2'), values('k')), g)).toEqual([2]);
    expect(toArray(traversal(V('v2'), values('k')), g)).toEqual([2]);
  });

  test('ONE id with a count — the shape at 1.91x', () => {
    expect(toArray(traversal(V(), hasId('v2'), count()), g)).toEqual([1]);
    expect(toArray(traversal(V('v2'), count()), g)).toEqual([1]);
  });

  test('an ABSENT id gives nothing on both spellings', () => {
    expect(toArray(traversal(V(), hasId('zz'), values('k')), g)).toEqual([]);
    expect(toArray(traversal(V('zz'), values('k')), g)).toEqual([]);
    // And a count of nothing is still a row, on both.
    expect(toArray(traversal(V(), hasId('zz'), count()), g)).toEqual([0]);
  });

  test('EDGES seed the same way', () => {
    expect(toArray(traversal(E(), hasId('e0'), values('w')), g)).toEqual([1]);
    expect(toArray(traversal(E('e0'), values('w')), g)).toEqual([1]);
  });

  test('a seeded source still carries its downstream steps', () => {
    // `v0 -> v1`, so hopping from the seeded start reaches v1 (k=1).
    expect(toArray(traversal(V(), hasId('v0'), out('E'), values('k')), g)).toEqual([1]);
  });
});

describe('⚠️ the rewrite DECLINES above one id, because the spellings disagree', () => {
  test('TWO ids keep GRAPH order under `hasId`, and id order under a seed', () => {
    /**
     * This is the literal that forbids widening the gate. `hasId` filters `graph.vertices`, so it
     * emits in insertion order whatever order the ids were written in; a seed emits per id in the
     * order given. Both are correct for their own spelling and they are not interchangeable.
     */
    expect(toArray(traversal(V(), hasId('v3', 'v1'), id()), g)).toEqual(['v1', 'v3']);
    expect(toArray(traversal(V('v3', 'v1'), id()), g)).toEqual(['v3', 'v1']);
  });

  test('DUPLICATE ids match once under `hasId` and twice under a seed', () => {
    // A multiplicity difference is a wrong answer, not an ordering one.
    expect(toArray(traversal(V(), hasId('v1', 'v1'), id()), g)).toEqual(['v1']);
    expect(toArray(traversal(V('v1', 'v1'), id()), g)).toEqual(['v1', 'v1']);
  });

  test('an ALREADY-SEEDED source plus `hasId` is an intersection, not a seed', () => {
    // `V(v1).hasId(v2)` selects v1 then rejects it — empty. Seeding v2 instead would answer [2].
    expect(toArray(traversal(V('v1'), hasId('v2'), values('k')), g)).toEqual([]);
    expect(toArray(traversal(V('v1'), hasId('v1'), values('k')), g)).toEqual([1]);
  });

  test('⚠️ a NON-STRING id declines — seeding it would turn EMPTY into a THROW', () => {
    /**
     * ⚠️ A PRE-EXISTING TEST CAUGHT THIS, not this file. `id-seed.test.ts` (item 1306) pins "a
     * non-string id must not raise", and the first version of this rewrite broke it: `V().hasId(5)`
     * answers EMPTY because a number cannot match a string id, while `V(5)` RAISES "a vertex/edge id
     * must be a string". Converting the first spelling into the second turned an empty answer into a
     * throw — a wrong answer, not a slow one.
     */
    expect(toArray(traversal(V(), hasId(5), values('k')), g)).toEqual([]);
    expect(() => toArray(traversal(V(5), values('k')), g)).toThrow(/id must be a string/);
  });

  test('`hasId` NOT immediately after the source is left alone', () => {
    // Filters commute so this is equally seedable, but the gate is deliberately narrow.
    expect(toArray(traversal(V(), hasLabel('P'), hasId('v2'), values('k')), g)).toEqual([2]);
  });
});

/**
 * ⚠️ THE PASS AS A PURE FUNCTION. A rewrite that declines everything is ANSWER-EQUIVALENT, so a
 * mutant disabling it passes every test above by construction — the class items 1619/1630/1631/1636
 * all recorded. These are the assertions that can fail on one.
 */
describe('seedSingleHasId', () => {
  const planOf = (steps: Parameters<typeof maskOfSteps>[0]) => ({
    steps,
    readsPath: false,
    kinds: maskOfSteps(steps),
    mayFault: false,
  });

  test('rewrites `V()` + one-id `hasId` into a seeded `V`', () => {
    const out1 = seedSingleHasId(planOf([{ kind: 'V' }, { kind: 'hasId', ids: ['v2'] }]));

    expect(out1.steps).toEqual([{ kind: 'V', ids: ['v2'] }]);
  });

  test('keeps the steps that follow', () => {
    const out1 = seedSingleHasId(
      planOf([{ kind: 'V' }, { kind: 'hasId', ids: ['v2'] }, { kind: 'count' }]),
    );

    expect(out1.steps).toEqual([{ kind: 'V', ids: ['v2'] }, { kind: 'count' }]);
  });

  test('rewrites an `E` source too', () => {
    const out1 = seedSingleHasId(planOf([{ kind: 'E' }, { kind: 'hasId', ids: ['e0'] }]));

    expect(out1.steps).toEqual([{ kind: 'E', ids: ['e0'] }]);
  });

  test('⚠️ RECOMPUTES the gate mask, or a later pass reads a stale one', () => {
    const before = planOf([
      { kind: 'V' },
      { kind: 'hasId', ids: ['v2'] },
      { kind: 'values', keys: ['k'] },
    ]);
    const after = seedSingleHasId(before);

    // The `hasId` bit must be GONE and the `values` bit must remain.
    expect(after.kinds).toBe(maskOfSteps(after.steps));
    expect(after.kinds).not.toBe(before.kinds);
  });

  test('declines TWO ids, duplicates, an already-seeded source, and a non-adjacent `hasId`', () => {
    const two = planOf([{ kind: 'V' }, { kind: 'hasId', ids: ['v3', 'v1'] }]);
    const dup = planOf([{ kind: 'V' }, { kind: 'hasId', ids: ['v1', 'v1'] }]);
    const seeded = planOf([
      { kind: 'V', ids: ['v1'] },
      { kind: 'hasId', ids: ['v2'] },
    ]);
    const late = planOf([
      { kind: 'V' },
      { kind: 'hasLabel', labels: ['P'] },
      { kind: 'hasId', ids: ['v2'] },
    ]);
    const numeric = planOf([{ kind: 'V' }, { kind: 'hasId', ids: [5] }]);

    expect(seedSingleHasId(two)).toBe(two);
    expect(seedSingleHasId(dup)).toBe(dup);
    expect(seedSingleHasId(seeded)).toBe(seeded);
    expect(seedSingleHasId(late)).toBe(late);
    expect(seedSingleHasId(numeric)).toBe(numeric);
  });

  test('declines a plan with no `hasId` at all, and a one-step plan', () => {
    const none = planOf([{ kind: 'V' }, { kind: 'count' }]);
    const one = planOf([{ kind: 'hasId', ids: ['v2'] }]);

    expect(seedSingleHasId(none)).toBe(none);
    expect(seedSingleHasId(one)).toBe(one);
  });

  test('declines a non-source first step', () => {
    const notSrc = planOf([{ kind: 'count' }, { kind: 'hasId', ids: ['v2'] }]);

    expect(seedSingleHasId(notSrc)).toBe(notSrc);
  });
});
