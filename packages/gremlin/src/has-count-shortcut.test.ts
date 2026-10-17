import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countShortcut } from './executor/count-shortcut.js';
import {
  V,
  both,
  count,
  gt,
  has,
  hasLabel,
  in_,
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

// Item 539. `V().out(T).count()` is the edge bucket's size — O(1) — and a filter AFTER the hop has
// `filteredHopCount`. A filter BEFORE one had no arm, so it ran the pipeline: at 100,000 vertices
// / 500,000 edges, `V().hasLabel('Person').out('KNOWS').count()` cost 95.34 ms against 0.00 for
// the same question without the label (every vertex carries it). An O(1) read against a 95 ms
// walk is this repo's named bug class.
//
// `startFilteredHopCount` answers it as the degree sum over the surviving starts. These assert
// the decision AND the answer against the pipeline's own, because a tally is answer-preserving by
// design and a mutant that never claims the shape passes every row assertion in the package.
describe('a START-filtered hop count (item 539)', () => {
  const hopGraph = (): Graph => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { age: 10 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { age: 20 } });
    const c = h.addVertex({ id: 'c', labels: ['Q'], properties: { age: 30 } });

    // a: two KNOWS out, one LIKES out. b: one KNOWS out. c: none out, two in.
    h.addEdge({ id: 'e1', from: a, to: b, labels: ['KNOWS'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: c, labels: ['KNOWS'], properties: {} });
    h.addEdge({ id: 'e3', from: a, to: c, labels: ['LIKES'], properties: {} });
    h.addEdge({ id: 'e4', from: b, to: c, labels: ['KNOWS'], properties: {} });

    return h;
  };

  const hg = hopGraph();
  const claim = (plan: Parameters<typeof toArray>[0]): unknown => {
    const n = countShortcut(plan, hg);

    expect(typeof n).toBe('number');
    expect(n).toBe(Number(toArray(plan, hg)[0]));

    return n;
  };

  test('the degree sum over the starts a LABEL keeps', () => {
    // `:P` is a and b, with 2 + 1 KNOWS out-edges.
    expect(claim(traversal(V(), hasLabel('P'), out('KNOWS'), count()))).toBe(3);
    // `:Q` is c, which has none.
    expect(claim(traversal(V(), hasLabel('Q'), out('KNOWS'), count()))).toBe(0);
    // UNTYPED `out()` is every out-edge of the kept starts: a has 3, b has 1.
    expect(claim(traversal(V(), hasLabel('P'), out(), count()))).toBe(4);
  });

  test('the degree sum over the starts a PROPERTY predicate keeps', () => {
    // age > 15 keeps b and c: b has one KNOWS out, c none.
    expect(claim(traversal(V(), has('age', gt(15)), out('KNOWS'), count()))).toBe(1);
    expect(claim(traversal(V(), has('age', gt(5)), out('KNOWS'), count()))).toBe(3);
    expect(claim(traversal(V(), has('age', gt(99)), out('KNOWS'), count()))).toBe(0);
  });

  test('the IN direction reads the other side', () => {
    // c has two KNOWS in-edges; it is `:Q`, so a `:P` start contributes b's one.
    expect(claim(traversal(V(), hasLabel('Q'), in_('KNOWS'), count()))).toBe(2);
    expect(claim(traversal(V(), hasLabel('P'), in_('KNOWS'), count()))).toBe(1);
    // A mutant that ignores the direction answers 0 and 3 here.
  });

  test('a chain of filters before the hop', () => {
    expect(claim(traversal(V(), hasLabel('P'), has('age', gt(15)), out('KNOWS'), count()))).toBe(1);
    // The label SECOND, so the bucket cannot be the source and every vertex is tested.
    expect(claim(traversal(V(), has('age', gt(15)), hasLabel('P'), out('KNOWS'), count()))).toBe(1);
  });

  test('`both` is refused — a self-loop is incident twice', () => {
    expect(
      countShortcut(traversal(V(), hasLabel('P'), both('KNOWS'), count()), hg),
    ).toBeUndefined();
  });

  test('a MULTI-label start keeps every vertex carrying EITHER label', () => {
    // The bucket of the FIRST label is not the step's survivors, so seeding from it would miss
    // the vertices carrying only the second — c, which is `:Q`. 3 + 0 KNOWS out-edges.
    expect(claim(traversal(V(), hasLabel('P', 'Q'), out('KNOWS'), count()))).toBe(3);
    // …and the other way round, so the mutant cannot pass by luck of which label comes first.
    expect(claim(traversal(V(), hasLabel('Q', 'P'), out('KNOWS'), count()))).toBe(3);
    // A single-label control, where seeding IS exact.
    expect(claim(traversal(V(), hasLabel('Q'), out('KNOWS'), count()))).toBe(0);
  });

  test('declines when the start predicate could seed an index', () => {
    // `propertyCount`'s rule, inherited: `countShortcut` runs before `seedFromIndex`, so a tally
    // that scanned anyway would answer in O(V) where a seek answers in O(matches) — item 149.
    const indexed = hopGraph();
    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

    expect(
      countShortcut(traversal(V(), has('age', within(10)), out('KNOWS'), count()), indexed),
    ).toBeUndefined();
    // Behind a label too, since the chain is scanned for a seedable `has` wherever it sits.
    expect(
      countShortcut(
        traversal(V(), hasLabel('P'), has('age', within(10)), out('KNOWS'), count()),
        indexed,
      ),
    ).toBeUndefined();
    // …and the answer is still right through the path that does seed.
    expect(toArray(traversal(V(), has('age', within(10)), out('KNOWS'), count()), indexed)).toEqual(
      [2],
    );
  });
});
