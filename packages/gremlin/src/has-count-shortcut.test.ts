import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countShortcut } from './executor/count-shortcut.js';
import {
  V,
  count,
  gt,
  has,
  hasLabel,
  not,
  out,
  startsWith,
  toArray,
  traversal,
  within,
} from './index.js';

// Item 234. `g.V().has(k, pred).count()` ran the traverser pipeline — a traverser allocated per
// vertex to be filtered and discarded — where a tally answers the same question:
//
//   the traverser pipeline                7.65ms   38.2ns a vertex
//   a hand-written tally, same answer     2.30ms   11.5ns
//   the scan alone, no property read      0.91ms    4.6ns
//
// 7.9 -> 2.5ms on `bench:gremlin`, which is the row's own floor.
//
// A count shortcut is ANSWER-PRESERVING by design, so the tests that matter assert the DECISION:
// `countShortcut` returns a number for the shapes it claims and `undefined` for the rest. A mutant
// that never claims the shape passes every row assertion in the package.
const build = (opts: { index?: boolean } = {}): Graph => {
  const g = new Graph();

  for (let i = 0; i < 12; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: [i < 4 ? 'Few' : 'Many'],
      properties: { age: i * 10, name: `n${i}` },
    });
  }

  // Two vertices the predicate cannot be true of: one with NO `age`, one with a null.
  g.addVertex({ id: 'noage', labels: ['Many'], properties: { name: 'x' } });
  g.addVertex({ id: 'nullage', labels: ['Many'], properties: { age: null, name: 'y' } });

  if (opts.index) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });
  }

  return g;
};

describe('the decision: which shapes the tally claims', () => {
  const g = build();

  test('V().has(k, pred).count() is claimed', () => {
    expect(countShortcut(traversal(V(), has('age', gt(44)), count()), g)).toBe(7);
    expect(countShortcut(traversal(V(), has('age', within(0, 10)), count()), g)).toBe(2);
  });

  test('DECLINES when the key is INDEXED and the predicate is seekable', () => {
    // The load-bearing condition. `countShortcut` is consulted BEFORE `seedFromIndex`, so a tally
    // that scanned anyway would answer in O(V) where the seed answers in O(matches) — a fast path
    // losing an index, which is item 149's failure.
    const indexed = build({ index: true });

    expect(countShortcut(traversal(V(), has('age', within(10)), count()), indexed)).toBeUndefined();

    // ...and the answer is still right through the path that does seed.
    expect(toArray(traversal(V(), has('age', within(10)), count()), indexed)).toEqual([1]);
  });

  test('CLAIMS an indexed key when the predicate is NOT seekable', () => {
    // An index on `age` does not help `not(...)`, so declining would leave the pipeline to do a
    // full scan it does not need. The decision has to turn on the PREDICATE, not just the key.
    const indexed = build({ index: true });
    const claimed = countShortcut(traversal(V(), has('age', not(gt(44))), count()), indexed);

    expect(typeof claimed).toBe('number');
    expect(claimed).toBe(
      Number(toArray(traversal(V(), has('age', not(gt(44))), count()), indexed)[0]),
    );
  });

  test('declines a shape that is not a bare V().has().count()', () => {
    // `count(local)` is a different question, and an edge source has no vertex set to tally.
    expect(countShortcut(traversal(V(), out('KNOWS'), has('age', gt(44)), count()), g)).toBe(0);
  });

  // Item 537. A CHAIN of vertex filters used to fall here — `mid.length === 2` reached the hop
  // counts, which decline two filters, so the whole query ran the pipeline at ~40-50 ns a vertex
  // PER STEP. A `hasLabel` that excludes nothing was enough to get there: at 200,000 vertices all
  // carrying `Person`, `V().hasLabel('Person').has(age, gt(44)).count()` cost 19.27 ms against
  // 2.37 for the same query without the label.
  //
  // These assert the DECISION and the ANSWER, because a tally that claims the shape and answers 0
  // passes every row assertion the package has. `0` is the right answer for the first one, which
  // is exactly why it needs a non-zero sibling.
  test('claims a chain of vertex filters, in either order', () => {
    const claim = (plan: Parameters<typeof toArray>[0]): unknown => {
      const n = countShortcut(plan, g);

      expect(typeof n).toBe('number');
      // The pipeline's own answer, so the tally cannot drift from it.
      expect(n).toBe(Number(toArray(plan, g)[0]));

      return n;
    };

    // `Few` is v0-v3 (ages 0, 10, 20, 30) and `Many` is v4-v11 (40 … 110).
    expect(claim(traversal(V(), has('age', gt(44)), hasLabel('Few'), count()))).toBe(0);
    expect(claim(traversal(V(), hasLabel('Few'), has('age', gt(44)), count()))).toBe(0);
    expect(claim(traversal(V(), hasLabel('Many'), has('age', gt(44)), count()))).toBe(7);
    expect(claim(traversal(V(), has('age', gt(44)), hasLabel('Many'), count()))).toBe(7);
    expect(claim(traversal(V(), hasLabel('Few'), has('age', gt(5)), count()))).toBe(3);
    // Three filters, and two of them labels — the chain is not limited to two steps.
    expect(
      claim(traversal(V(), hasLabel('Many'), hasLabel('Many'), has('age', gt(44)), count())),
    ).toBe(7);
    // A MULTI-LABEL test cannot seed a bucket (a vertex may carry several), so it stays a
    // predicate rather than declining the chain.
    expect(claim(traversal(V(), hasLabel('Few', 'Many'), has('age', gt(44)), count()))).toBe(7);
    // Two property filters, no label at all.
    expect(claim(traversal(V(), has('age', gt(44)), has('age', gt(95)), count()))).toBe(2);
  });

  test('a chain still declines when an index could seed it', () => {
    // `propertyCount`'s load-bearing rule, which the chain inherits: `countShortcut` runs before
    // `seedFromIndex`, so a tally that scanned anyway would answer in O(V) where a seek answers
    // in O(matches) — item 149's failure, a fast path losing an index.
    const indexed = build({ index: true });

    // `age` is the indexed key and `within(10)` is the seekable predicate — the same pair the
    // single-step test uses, now behind a label that the chain would otherwise claim.
    expect(
      countShortcut(traversal(V(), hasLabel('Few'), has('age', within(10)), count()), indexed),
    ).toBeUndefined();
    expect(
      countShortcut(traversal(V(), has('age', within(10)), hasLabel('Few'), count()), indexed),
    ).toBeUndefined();
    // …and the answer is still right through the path that does seed.
    expect(
      toArray(traversal(V(), hasLabel('Few'), has('age', within(10)), count()), indexed),
    ).toEqual([1]);
  });
});

describe('the tally answers what the pipeline answers', () => {
  const g = build();

  const both = (plan: Parameters<typeof toArray>[0]): [unknown, unknown] => [
    toArray(plan, g)[0],
    countShortcut(plan, g),
  ];

  test('an ordering predicate, and the two vertices it cannot be true of', () => {
    // `noage` has no `age` and `nullage` has null; neither counts, and the pipeline agrees.
    const [piped, tallied] = both(traversal(V(), has('age', gt(44)), count()));

    expect(piped).toBe(7);
    expect(tallied).toBe(7);
  });

  test('a predicate matching NOTHING is zero, not the vertex count', () => {
    expect(both(traversal(V(), has('age', gt(10_000)), count()))).toEqual([0, 0]);
    expect(both(traversal(V(), has('missing', gt(0)), count()))).toEqual([0, 0]);
  });

  test('a predicate matching EVERYTHING is not the vertex count either', () => {
    // 14 vertices, but two have no usable `age` — so a tally that returned `vertexCount` for a
    // permissive predicate would be wrong, and a one-sided fixture could not see it.
    const [piped, tallied] = both(traversal(V(), has('age', gt(-1)), count()));

    expect(piped).toBe(12);
    expect(tallied).toBe(12);
  });

  test('a string predicate', () => {
    expect(both(traversal(V(), has('name', startsWith('n1')), count()))).toEqual([3, 3]);
  });

  test('a negated predicate', () => {
    const plan = traversal(V(), has('age', not(gt(44))), count());
    const [piped, tallied] = both(plan);

    // `not(gt(44))` is TRUE of a missing and a null `age`, which is the asymmetry that makes this
    // worth asserting rather than assuming: 14 - 7 = 7, not 12 - 7 = 5.
    expect(piped).toBe(7);
    expect(tallied).toBe(7);
  });

  test('a cross-type comparison matches nothing and does not throw', () => {
    expect(both(traversal(V(), has('name', gt(0)), count()))).toEqual([0, 0]);
  });
});
