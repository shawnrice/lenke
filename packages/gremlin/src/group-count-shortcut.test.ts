import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { groupCountShortcut } from './executor/projection.js';
import { E, V, count, groupCount, hasLabel, out, toArray, traversal } from './index.js';

// Item 236. `g.V().groupCount().by(k)` ran the traverser pipeline; it now tallies the vertex set.
// 7.3 -> 3.4ms on `bench:gremlin`, ts/nat 2.7 -> 1.3.
//
// The gap was attributed by ELIMINATION before anything was written (items 235/236): the traverser
// allocated per element costs nothing measurable (15.3ns a vertex against the tally's 15.5), nor
// does `hasOwn` (+0.6), a raw-keyed Map, `groupKey`, or the wrapper map. Two generator layers cost
// 60.4 against 15.5 — more than the whole engine row — so the layering is the cause.
//
// A shortcut is ANSWER-PRESERVING, so two things need testing that a passing suite does not give:
// the DECISION (which shapes it claims) and the EQUIVALENCE to the step it preempts. The step is no
// longer reachable for a claimed plan, so equivalence is tested ACROSS paths — a three-step plan
// with a VACUOUS label is declined by the shortcut and answers the identical question.
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 12; i++) {
    g.addVertex({ id: `v${i}`, labels: ['All'], properties: { age: i % 3, name: `n${i}` } });
  }

  // One vertex with NO `age` (NO_VALUE — takes no bucket) and one with a NULL `age` (null IS a
  // value and gets its own bucket). Those are different outcomes, and a fixture with neither
  // cannot tell a shortcut that conflates them from one that does not.
  g.addVertex({ id: 'noage', labels: ['All'], properties: { name: 'x' } });
  g.addVertex({ id: 'nullage', labels: ['All'], properties: { age: null, name: 'y' } });

  return g;
};

const asObject = (m: unknown): Record<string, unknown> =>
  Object.fromEntries([...(m as Map<unknown, number>)].map(([k, v]) => [String(k), v]));

describe('the decision: which shapes the tally claims', () => {
  const g = build();

  test('V().groupCount().by(key) is claimed', () => {
    const claimed = groupCountShortcut(traversal(V(), groupCount({ by: 'age' })), g);

    expect(claimed).toBeInstanceOf(Map);
    expect(asObject(claimed)).toEqual({ '0': 4, '1': 4, '2': 4, null: 1 });
  });

  test('declines every `by` that is not a plain property key', () => {
    // An `identity` by groups by the ELEMENT, not a property — a different question.
    expect(groupCountShortcut(traversal(V(), groupCount()), g)).toBeUndefined();
  });

  test('declines a source that is not the whole vertex set', () => {
    expect(groupCountShortcut(traversal(E(), groupCount({ by: 'age' })), g)).toBeUndefined();
    expect(groupCountShortcut(traversal(V('v1'), groupCount({ by: 'age' })), g)).toBeUndefined();
  });

  test('declines anything between the source and the aggregate', () => {
    expect(
      groupCountShortcut(traversal(V(), hasLabel('All'), groupCount({ by: 'age' })), g),
    ).toBeUndefined();
    expect(
      groupCountShortcut(traversal(V(), out('E'), groupCount({ by: 'age' })), g),
    ).toBeUndefined();
  });

  test('declines a step AFTER the aggregate, which is the harder half', () => {
    // A LEADING extra step declines for a second reason — `steps[1]` is then not the groupCount —
    // so it cannot distinguish an exact `length !== 2` from a lax `length < 2`. A TRAILING step
    // can: the lax guard would answer the groupCount and silently DROP the step after it.
    // Mutation found this, and the mutant survived until this case existed.
    const plan = traversal(V(), groupCount({ by: 'age' }), count());

    expect(groupCountShortcut(plan, g)).toBeUndefined();

    // `count()` over the single Map traverser the aggregate yields is 1, not the Map.
    expect(toArray(plan, g)).toEqual([1]);
  });
});

describe('the tally answers what the step answers', () => {
  const g = build();

  test('a VACUOUS label makes the step reachable for the same question', () => {
    // Every vertex is `:All`, so `hasLabel('All')` filters nothing — but it is a third step, which
    // the shortcut declines, so this plan runs the pipeline. Same question, two paths.
    const [tallied] = toArray(traversal(V(), groupCount({ by: 'age' })), g);
    const [piped] = toArray(traversal(V(), hasLabel('All'), groupCount({ by: 'age' })), g);

    expect(asObject(tallied)).toEqual(asObject(piped));
  });

  test('an ABSENT key takes no bucket, and a NULL value takes one', () => {
    // The two cases a fixture usually lacks. `noage` must not appear at all; `nullage` must appear
    // under a `null` key. A shortcut that dropped the `hasOwn` guard would add an `undefined`
    // bucket; one that filtered nullish would lose the `null` bucket.
    const tallied = asObject(toArray(traversal(V(), groupCount({ by: 'age' })), g)[0]);
    const piped = asObject(
      toArray(traversal(V(), hasLabel('All'), groupCount({ by: 'age' })), g)[0],
    );

    expect(tallied).toEqual({ '0': 4, '1': 4, '2': 4, null: 1 });
    expect(piped).toEqual(tallied);
    expect(Object.keys(tallied)).not.toContain('undefined');
  });

  test('an OBJECT-valued property groups by VALUE, not by reference', () => {
    // `groupKey`'s own rule: a plain object has no useful identity, so it is keyed by a structural
    // string. Two vertices carrying structurally-equal objects must land in ONE bucket — a tally
    // that used the raw value as the key would give two, and only a fixture with two equal-but-
    // distinct objects can see it.
    const h = new Graph();

    h.addVertex({ id: 'a', labels: ['All'], properties: { tag: { x: 1 } } });
    h.addVertex({ id: 'b', labels: ['All'], properties: { tag: { x: 1 } } });
    h.addVertex({ id: 'c', labels: ['All'], properties: { tag: { x: 2 } } });

    const tallied = toArray(traversal(V(), groupCount({ by: 'tag' })), h)[0] as Map<
      unknown,
      number
    >;
    const piped = toArray(traversal(V(), hasLabel('All'), groupCount({ by: 'tag' })), h)[0] as Map<
      unknown,
      number
    >;

    expect(tallied.size).toBe(2);
    expect([...tallied.values()].sort()).toEqual([1, 2]);

    // And the ORIGINAL key survives into the output, not the structural string it was bucketed by.
    expect([...tallied.keys()].every((k) => typeof k === 'object')).toBe(true);
    expect([...piped.values()].sort()).toEqual([...tallied.values()].sort());
  });

  test('an empty graph yields an empty map, not nothing', () => {
    const empty = new Graph();

    expect(asObject(toArray(traversal(V(), groupCount({ by: 'age' })), empty)[0])).toEqual({});
  });

  test('a key NOTHING carries yields an empty map', () => {
    expect(asObject(toArray(traversal(V(), groupCount({ by: 'missing' })), g)[0])).toEqual({});
  });
});
