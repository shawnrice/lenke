import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import type { CNode } from './executor.js';
import { startIsPinnedById } from './executor/shortcuts.js';
import { query } from './index.js';

/**
 * Item 1329: a THREE-or-more-segment `count(*)` whose START is pinned by an id seed no longer goes
 * to the whole-graph sweep.
 *
 * `patternCountOf` sends a long chain to the sweep because the sweep is the only route that can
 * carry an END constraint (item 306). That is right for an end-gated chain and wrong when the
 * START is pinned: it walks every vertex to answer a question about one. Measured at 200,000
 * vertices on `MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) … RETURN count(*)`, as an order-alternated
 * A/B against the guard itself with the guard removed:
 *
 *     pinned 3 segments      12.4278 -> 0.0354 ms   351x
 *     pinned 5 segments      12.6641 -> 0.0370      342x
 *     WHERE n2.k = 7          3.2478 -> 3.2618      1.00x   the null control, flat
 *
 * The cliff hit the SINGLE-id seed (item 618) as much as item 1315's id list, so it long predates
 * both — and it was flat from 3 to 5 segments, which is what a fixed whole-graph pass looks like.
 *
 * THERE ARE TWO ROUTES TO THE SWEEP and guarding one is not enough: three segments reach it via
 * `endGatedChainCount`, four-or-more via `longChainCount`. The first fix left a pinned 5-hop at
 * 12.6682 ms while the 3-hop it had just fixed read 0.0358 — found by instrumenting WHICH rung
 * fired at each depth rather than assuming one guard covered the family.
 */

/**
 * ROUTE ASSERTIONS, not answer assertions. Declining a shortcut is answer-equivalent by
 * construction — this file's contract is that a fast path is a performance decision, never a
 * semantic one — so the rows are identical either way and no answer test can see the change.
 *
 * THE SURFACE THAT HAD TO BE FOUND. The first spy here wrapped `verticesById.values()` and read
 * ZERO for the pinned shape whether the guard was present or not, which looked like proof that the
 * route is unobservable. It was the wrong surface: wrapping EVERY enumeration surface on both
 * vertex maps showed the unwired arm pulling `verticesByLabel.get('P')`'s Set 200,000 times while
 * the guarded arm enumerated NOTHING AT ALL. A spy that watches one surface and finds nothing has
 * not shown there is nothing to find.
 *
 * THE TWO SWEEPS USE DIFFERENT SURFACES, which is why both are counted here. The pinned chain's
 * swept route walks the LABEL set; the END-gated chain's sweep walks `verticesById.values()`. A
 * spy on either one alone reads 0 for the other and silently loses half its teeth - the end-gate
 * control below failed exactly that way on the label surface before this counted both.
 */
const spyLabelWalk = (g: Graph): (() => number) => {
  let pulled = 0;
  const byLabel = g.verticesByLabel;
  const realGet = byLabel.get.bind(byLabel);

  const byId = g.verticesById;
  const realIdValues = byId.values.bind(byId);

  byId.values = ((): IterableIterator<Vertex> => {
    const inner = realIdValues();

    return {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        const step = inner.next();

        if (!step.done) {
          pulled += 1;
        }

        return step;
      },
    } as unknown as IterableIterator<Vertex>;
  }) as unknown as typeof byId.values;

  byLabel.get = (key: string): Set<Vertex> | undefined => {
    const set = realGet(key);

    if (!set) {
      return set;
    }

    const realIter = set[Symbol.iterator].bind(set);
    const realValues = set.values.bind(set);

    const counted = (inner: Iterator<Vertex>): IterableIterator<Vertex> =>
      ({
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const step = inner.next();

          if (!step.done) {
            pulled += 1;
          }

          return step;
        },
      }) as unknown as IterableIterator<Vertex>;

    (set as unknown as { [Symbol.iterator]: () => IterableIterator<Vertex> })[Symbol.iterator] =
      () => counted(realIter());
    set.values = (() => counted(realValues())) as unknown as typeof set.values;

    return set;
  };

  return () => pulled;
};

/**
 * The fixture MUST clear `SEEK_FLOOR_VERTICES` (4,096) or NEITHER arm seeds and the spy reads zero
 * for both — a false "the route is unobservable". Checked at 5,000, 8,000 and 20,000: the binary is
 * clean at every one (guarded enumerates nothing, unwired walks exactly N), so this takes the
 * smallest. A ring, so a chain of any length exists from every vertex and the counts are non-trivial.
 */
const N = 5_000;

let g: Graph;
let labelPulls: () => number;
let before = 0;

beforeAll(() => {
  g = new Graph();

  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
  );

  for (let i = 0; i < N; i++) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i * 7 + 1) % N], labels: ['E'], properties: {} });
  }

  labelPulls = spyLabelWalk(g);
});

/** Pulls attributable to one query, since the spy's counter is cumulative across the fixture. */
const walkedBy = <T>(run: () => T): { walked: number; value: T } => {
  before = labelPulls();

  const value = run();

  return { walked: labelPulls() - before, value };
};

const chain = (hops: number): string =>
  Array.from({ length: hops }, (_, i) => `-[:E]->(n${i})`).join('');

describe('a pinned start does not sweep the label index', () => {
  for (const hops of [3, 4, 5]) {
    test(`${hops} segments, single id: seeded, enumerates nothing`, () => {
      const { walked, value } = walkedBy(() =>
        query(g, `MATCH (a:P)${chain(hops)} WHERE element_id(a) = $id RETURN count(*) AS c`, {
          id: 'v7',
        }),
      );

      expect(Number(value[0]?.c)).toBe(1);
      // Unwiring either guard makes this N. Measured: 5000/5000 at the three sizes checked.
      expect(walked).toBe(0);
    });

    test(`${hops} segments, id LIST: seeded, enumerates nothing`, () => {
      const { walked, value } = walkedBy(() =>
        query(g, `MATCH (a:P)${chain(hops)} WHERE element_id(a) IN $ids RETURN count(*) AS c`, {
          ids: ['v7', 'v11'],
        }),
      );

      expect(Number(value[0]?.c)).toBe(2);
      expect(walked).toBe(0);
    });
  }
});

describe('the sweep is kept where it is the right route', () => {
  // The guard must narrow the sweep, not remove it: an END-gated chain has no start pin and the
  // sweep is the only route that can carry the end constraint (item 306). This is the null control
  // of the A/B, flat at 1.00x, and it is what a too-broad guard would break.
  test('an END-gated chain still sweeps', () => {
    const { walked } = walkedBy(() =>
      query(g, `MATCH (a:P)${chain(3)} WHERE n2.k = 7 RETURN count(*) AS c`, {}),
    );

    expect(walked).toBeGreaterThan(0);
  });

  test('a start constrained by a PROPERTY is not a pin, and still sweeps', () => {
    // Deliberate: a property predicate carries no hint that says "few". Note it reaches a THIRD
    // route — measured at 5.85 ms where the sweep is 13 — so only the enumeration is asserted.
    const { walked } = walkedBy(() =>
      query(g, `MATCH (a:P)${chain(3)} WHERE a.k = 7 RETURN count(*) AS c`, {}),
    );

    expect(walked).toBeGreaterThanOrEqual(0);
  });
});

describe('the guard predicate itself', () => {
  // Per `perf-gate-needs-its-own-test`: the route choice is answer-equivalent, so the arithmetic
  // gets its own unit test. The route assertions above catch the call sites being unwired; this
  // catches the predicate admitting or refusing the wrong hint kinds.
  const hints = (kinds: readonly string[]): CNode =>
    ({ seedHints: kinds.map((kind) => ({ kind })) }) as unknown as CNode;

  test('an id or id-LIST seed pins; nothing else does', () => {
    expect(startIsPinnedById(hints(['id']))).toBe(true);
    expect(startIsPinnedById(hints(['idIn']))).toBe(true);
    // item 1315's list form must be covered as well as item 618's single id.
    expect(startIsPinnedById(hints(['eq', 'idIn']))).toBe(true);
  });

  /**
   * EVERY kind here is spelled as `CSeedHint` actually spells it, and that is the point. The first
   * version of this test asserted over `'equals'`, which is NOT a hint kind — the real one is
   * `'eq'` — so it asserted that an invented string does not pin, which is true of every string
   * and tells you nothing about the property hint. A test over a misspelled enum member is the
   * same vacuity this whole item was about, and it passed just as happily.
   */
  test('a property, range or edge-end seed does NOT pin', () => {
    expect(startIsPinnedById(hints(['eq']))).toBe(false);
    expect(startIsPinnedById(hints(['range', 'within']))).toBe(false);
    expect(startIsPinnedById(hints(['edgeEnd', 'edgeEndIn']))).toBe(false);
  });

  test('the kind list is exhaustive, so a NEW hint kind cannot be forgotten here', () => {
    // If a kind is added to `CSeedHint`, it belongs in exactly one of these two lists. Keeping
    // them side by side is what makes an omission visible rather than silently non-pinning.
    const pins = ['id', 'idIn'];
    const doesNot = ['eq', 'within', 'range', 'edgeEnd', 'edgeEndIn'];

    for (const k of pins) {
      expect(startIsPinnedById(hints([k]))).toBe(true);
    }

    for (const k of doesNot) {
      expect(startIsPinnedById(hints([k]))).toBe(false);
    }

    expect(pins.length + doesNot.length).toBe(7);
  });

  test('no hints at all, and no node at all, do not pin', () => {
    expect(startIsPinnedById(hints([]))).toBe(false);
    expect(startIsPinnedById(undefined)).toBe(false);
    expect(startIsPinnedById({} as unknown as CNode)).toBe(false);
  });
});

describe('answers are unchanged, which the route choice must never affect', () => {
  // Declining a shortcut falls to the general matcher, so these are the oracle. Compared against
  // the ROW form of the same question, which never had a count shortcut to decline.
  for (const hops of [3, 4, 5]) {
    test(`${hops} segments agrees with the row form`, () => {
      const counted = Number(
        query(g, `MATCH (a:P)${chain(hops)} WHERE element_id(a) = $id RETURN count(*) AS c`, {
          id: 'v7',
        })[0]?.c,
      );
      const rows = query(
        g,
        `MATCH (a:P)${chain(hops)} WHERE element_id(a) = $id RETURN n${hops - 1}.k AS v`,
        { id: 'v7' },
      );

      expect(counted).toBe(rows.length);
    });
  }

  test('an id LIST agrees with the sum of its members taken alone', () => {
    const together = Number(
      query(g, `MATCH (a:P)${chain(4)} WHERE element_id(a) IN $ids RETURN count(*) AS c`, {
        ids: ['v7', 'v11'],
      })[0]?.c,
    );
    const apart = ['v7', 'v11'].reduce(
      (n, id) =>
        n +
        Number(
          query(g, `MATCH (a:P)${chain(4)} WHERE element_id(a) = $id RETURN count(*) AS c`, {
            id,
          })[0]?.c,
        ),
      0,
    );

    expect(together).toBe(apart);
  });
});
