import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Step } from '../ast.js';
import { E, V, count, has, hasLabel, toArray, traversal, values } from '../index.js';
import { gt, gte, lt } from '../predicates.js';
import { countShortcut } from './count-shortcut.js';
import { seedFromIndex, seekWorthTaking } from './index-seed.js';

/**
 * Item 1322: Gremlin gets the seek-vs-scan gate it was the only engine missing.
 *
 * Native has had `SEEK_MAX_FRACTION` throughout and GQL's `seekIsWorthIt` arrived at item 409 as
 * "the missing twin". `seedRest` had NO selectivity gate: it took any seek that was merely the
 * most selective CANDIDATE, however unselective in absolute terms. That is a PATHOLOGY rather
 * than a missed optimization — adding an index made a query slower.
 *
 * Measured at 200,000 vertices on `V().hasLabel('P').has('age', gt(45)).count()` (~49% kept):
 *
 *     no index                   2.179 ms    the count shortcut runs
 *     indexed, before            13.104      the seek is materialized
 *     indexed, after             2.266       5.78x, and 1.03x against the no-index path
 *
 * THE CHANGE HAS TWO HALVES AND EITHER ALONE IS WORSE THAN NEITHER. `count-shortcut.ts` declines
 * its own fast path wherever a leading filter is SEEDABLE, assuming the seed is better. With only
 * the gate, the shortcut bows out, the seek declines, and the query lands on the general path —
 * 5.43 ms, worse than the 2.18 ms shortcut it gave up. So both files are tested here.
 *
 * EVERY ADMISSION TEST IS A CONTROL FOR THE DECLINE TESTS. A gate that simply stopped seeding
 * would "fix" the pathology and be a far worse bug, so the selective cases assert the seek is
 * still TAKEN, not merely that the rows are right.
 */

/**
 * The materialised `Step` for a filter, which is what the gate takes.
 *
 * `has(...)` returns a step BUILDER (a function), not a `Step` — passing it straight to
 * `seekWorthTaking` makes `seedForStep` decline on `step.kind` being undefined, which reads as
 * "the gate refused" and is not. Building a one-filter traversal and taking its step is the
 * honest way to get one.
 */
const stepOf = (filter: Parameters<typeof traversal>[1]): Step =>
  traversal(V(), filter, count()).steps[1];

/** Above `SEEK_FLOOR_ELEMENTS` (4,096), so the ratio is consulted rather than waved through. */
const BIG = 6_000;

const bigGraph = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < BIG; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90, k: i } });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });
  }

  return g;
};

describe('the gate itself', () => {
  test('an UNSELECTIVE seek is refused and a SELECTIVE one is taken', () => {
    const g = bigGraph(true);
    // `age` is `i % 90`, so `> 45` keeps ~49% and `= 42` keeps ~1.1%.
    const unselective = stepOf(has('age', gt(45)));
    const selective = stepOf(has('age', 42));

    expect(seekWorthTaking(unselective, g.vertexPropertyIndex, g.verticesById.size)).toBe(false);
    expect(seekWorthTaking(selective, g.vertexPropertyIndex, g.verticesById.size)).toBe(true);
  });

  test('the boundary is the fraction, not the direction of the comparison', () => {
    // `< 11` keeps ~12.2%, just under the 1/8 line; `< 12` keeps ~13.3%, just over.
    const g = bigGraph(true);

    expect(
      seekWorthTaking(stepOf(has('age', lt(11))), g.vertexPropertyIndex, g.verticesById.size),
    ).toBe(true);
    expect(
      seekWorthTaking(stepOf(has('age', lt(12))), g.vertexPropertyIndex, g.verticesById.size),
    ).toBe(false);
  });

  test('BELOW the floor every seek is taken, which is what keeps small fixtures unchanged', () => {
    // The same unselective predicate on a tiny graph. GQL records that omitting this floor
    // flipped NINE of its tests; this is the assertion that the floor exists rather than the
    // observation that nothing broke.
    const small = new Graph();

    for (let i = 0; i < 50; i++) {
      small.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } });
    }

    small.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

    expect(
      seekWorthTaking(
        stepOf(has('age', gt(45))),
        small.vertexPropertyIndex,
        small.verticesById.size,
      ),
    ).toBe(true);
  });

  test('an UNINDEXED key is never a seek, gate or no gate', () => {
    const g = bigGraph(true);

    expect(
      seekWorthTaking(stepOf(has('k', gt(45))), g.vertexPropertyIndex, g.verticesById.size),
    ).toBe(false);
  });
});

describe('the seed path declines, and says so by seeding nothing', () => {
  test('an unselective indexed filter does not seed', () => {
    const g = bigGraph(true);
    const plan = traversal(V(), has('age', gt(45)), count());

    expect(seedFromIndex(plan, g, false)).toBeNull();
  });

  test('a selective indexed filter DOES seed, and removes the filter it replaced', () => {
    const g = bigGraph(true);
    const seeded = seedFromIndex(traversal(V(), has('age', 42), count()), g, false);

    expect(seeded).not.toBeNull();
    expect(seeded?.steps.map((s) => s.kind)).toEqual(['count']);
  });

  test('a label bucket still seeds beside a refused seek — exact seeds are never gated', () => {
    // `hasLabel('Q')` is a small exact bucket; the unselective `age` seek must be refused while
    // the bucket is still used, which is the case the two-list split in `seedRest` exists for.
    const g = bigGraph(true);

    g.addVertex({ id: 'q1', labels: ['Q'], properties: { age: 99 } });
    g.addVertex({ id: 'q2', labels: ['Q'], properties: { age: 99 } });

    const seeded = seedFromIndex(
      traversal(V(), hasLabel('Q'), has('age', gt(45)), count()),
      g,
      false,
    );

    expect(seeded).not.toBeNull();
    // Seeded from the 2-element bucket, with the refused seek left in the plan as a residual.
    expect(seeded?.steps.map((s) => s.kind)).toEqual(['has', 'count']);
  });
});

describe('the two guards mutation found uncovered', () => {
  // Both of these SURVIVED the first mutation pass, and neither is a deliberate survivor: they
  // are narrow cases the other tests cannot reach, so they get their own.

  test('a seek WIDER than its fallback loses to the fallback, even BELOW the floor', () => {
    // Written to pin a `count > scan` guard, and it does NOT: mutation showed deleting that guard
    // changes nothing, because `seedRest` picks the cheaper of seek and exact AFTERWARDS and the
    // 2-element bucket wins either way. The guard was removed as dead code; this test is kept
    // because the OUTCOME it asserts is the contract, however it is produced.
    const g = new Graph();

    for (let i = 0; i < 60; i++) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } });
    }

    g.addVertex({ id: 'q1', labels: ['Q'], properties: { age: 50 } });
    g.addVertex({ id: 'q2', labels: ['Q'], properties: { age: 51 } });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

    // `age >= 10` keeps 50 of 62; the `Q` bucket is 2. The seek is WIDER than the fallback.
    const seeded = seedFromIndex(
      traversal(V(), hasLabel('Q'), has('age', gte(10)), count()),
      g,
      false,
    );

    expect(seeded).not.toBeNull();
    // Seeded from the 2-element bucket, with the wider seek left as a residual — NOT the reverse.
    expect(seeded?.steps.map((s) => s.kind)).toEqual(['has', 'count']);
    expect(Number(toArray(traversal(V(), hasLabel('Q'), has('age', gte(10)), count()), g)[0])).toBe(
      2,
    );
  });

  test('the fallback is the cheapest EXACT seed, not the whole source', () => {
    // The denominator matters only for a seek BETWEEN bucket/8 and source/8. Here the `P` bucket
    // is 5,000 of 6,000 vertices and the seek keeps ~700: 700 > 5000/8 = 625 so it is refused
    // against the bucket it would actually replace, while judging it against 6000/8 = 750 would
    // wrongly admit it. The seek is only 7.1x better than the bucket, under the 8x bar.
    const g = new Graph();

    for (let i = 0; i < 5_000; i++) {
      g.addVertex({ id: `p${i}`, labels: ['P'], properties: { n: i % 50 } });
    }

    for (let i = 0; i < 1_000; i++) {
      g.addVertex({ id: `o${i}`, labels: ['O'], properties: { n: 99 } });
    }

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

    // `n < 7` keeps 7/50 of the 5,000 `P` vertices = 700, and no `O` vertex.
    const seeded = seedFromIndex(traversal(V(), hasLabel('P'), has('n', lt(7)), count()), g, false);

    expect(seeded).not.toBeNull();
    // The BUCKET was chosen, so the seek stayed in the plan as a residual.
    expect(seeded?.steps.map((s) => s.kind)).toEqual(['has', 'count']);
    expect(Number(toArray(traversal(V(), hasLabel('P'), has('n', lt(7)), count()), g)[0])).toBe(
      700,
    );
  });
});

describe('the COUNT SHORTCUT half, which is answer-equivalent and so needs a route assertion', () => {
  // `count-shortcut.ts` declined wherever a leading filter was merely SEEDABLE. Reverting that to
  // `seedForStep(...) !== null` returns identical rows and is only slower, so no answer test can
  // see it — and with the gate in place it is the WORSE half to lose: the shortcut bows out, the
  // seek declines, and the query lands on the general path at 5.43 ms against the shortcut's 2.18.
  test('an UNSELECTIVE indexed filter is handled by the shortcut, not surrendered', () => {
    const g = bigGraph(true);
    const plan = traversal(V(), has('age', gt(45)), count());

    expect(countShortcut(plan, g)).not.toBeUndefined();
  });

  test('a SELECTIVE indexed filter is still surrendered to the seek', () => {
    // The other direction, and the reason the gate is asked rather than removed: where the seek
    // IS worth taking, the shortcut must still stand aside for it.
    const g = bigGraph(true);

    expect(countShortcut(traversal(V(), has('age', 42), count()), g)).toBeUndefined();
  });

  test('with NO index the shortcut handles it either way', () => {
    const g = bigGraph(false);

    expect(countShortcut(traversal(V(), has('age', gt(45)), count()), g)).not.toBeUndefined();
    expect(countShortcut(traversal(V(), has('age', 42), count()), g)).not.toBeUndefined();
  });
});

describe('answers are unchanged, which is the whole invariant', () => {
  // The seed is a SUPERSET and the declined filters stay in the plan as residuals, so the gate
  // changes which plan runs and never which rows come back. Asserted against the UNINDEXED graph,
  // which cannot seed at all and is therefore the oracle.
  const SHAPES: [string, (g: Graph) => unknown][] = [
    ['unselective count', (g) => toArray(traversal(V(), has('age', gt(45)), count()), g)],
    ['selective count', (g) => toArray(traversal(V(), has('age', 42), count()), g)],
    ['unselective values', (g) => toArray(traversal(V(), has('age', gt(45)), values('k')), g)],
    ['selective values', (g) => toArray(traversal(V(), has('age', 42), values('k')), g)],
    [
      'labelled unselective',
      (g) => toArray(traversal(V(), hasLabel('P'), has('age', gt(45)), count()), g),
    ],
    ['boundary just under', (g) => toArray(traversal(V(), has('age', lt(11)), count()), g)],
    ['boundary just over', (g) => toArray(traversal(V(), has('age', lt(12)), count()), g)],
  ];

  for (const [name, run] of SHAPES) {
    test(`${name} agrees with the unindexed oracle`, () => {
      expect(run(bigGraph(true))).toEqual(run(bigGraph(false)));
    });
  }
});

describe('the EDGE source is gated too', () => {
  const edgeGraph = (indexed: boolean): Graph => {
    const g = new Graph();
    const vs = Array.from({ length: BIG }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: {} }),
    );

    for (let i = 0; i + 1 < BIG; i++) {
      g.addEdge({
        id: `e${i}`,
        from: vs[i],
        to: vs[i + 1],
        labels: ['E'],
        properties: { w: i % 90 },
      });
    }

    if (indexed) {
      g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });
    }

    return g;
  };

  test('an unselective EDGE seek does not seed, and a selective one does', () => {
    const g = edgeGraph(true);

    expect(seedFromIndex(traversal(E(), has('w', gt(45)), count()), g, false)).toBeNull();
    expect(seedFromIndex(traversal(E(), has('w', 42), count()), g, false)).not.toBeNull();
  });

  test('edge answers are unchanged', () => {
    expect(toArray(traversal(E(), has('w', gt(45)), count()), edgeGraph(true))).toEqual(
      toArray(traversal(E(), has('w', gt(45)), count()), edgeGraph(false)),
    );
  });
});
