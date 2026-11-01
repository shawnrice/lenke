import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1330: the way-count SWEEP seeds its START set from an index instead of handing itself the
 * whole label bucket and letting the start gate filter it.
 *
 * The depth ladder that found it, at 200,000 vertices with `k` indexed — an indexed start IS
 * seeded at nought, one and two hops and then falls off a cliff at three, which is item 1329's
 * cliff in the family that item fixed only for `id`/`idIn`:
 *
 *     depth   indexed a.k = 7    id pin
 *       0           0.0049          -
 *       1           0.0066       0.0090
 *       2           0.0053       0.0069
 *       3        >> 5.6254 <<    0.0382
 *       4        >> 5.7319 <<        -
 *
 * After seeding the sweep, three rounds order-alternated, medians:
 *
 *     a.k = 7, indexed        5.5985 -> 0.0122 ms   458.89x
 *     a.k = $k, indexed       5.7721 -> 0.0142
 *     5 segments, indexed     5.7640 -> 0.0236
 *     a.k = 7, NOT indexed    6.0878 -> 6.3176      0.96x, overlapping runs
 *     WHERE n2.k = 7 (end)    3.2587 -> 3.2031      1.02x
 *     no predicate at all    80.0775 -> 78.5904     1.02x
 *
 * WHY THE SWEEP SEEDS RATHER THAN DECLINING, which is the whole design and was MEASURED, not
 * assumed. Item 1329's twin declines the rung outright, which is sound there because an id hint is
 * selective on every graph. A property hint is not — whether `k` is indexed is a property of the
 * GRAPH, and plans are cached across graphs — so a compile-time decline has to assume. Admitting
 * `eq` to item 1329's pin and declining unconditionally measured:
 *
 *     a.k = 7 WITH an index   5.4341 -> 0.0380 ms   143x FASTER
 *     a.k = 7 with NO index   5.6257 -> 16.5443      0.34x, a 2.9x REGRESSION
 *
 * The indexed column alone would have shipped that regression. Seeding keeps both halves.
 */

/**
 * Counts vertices pulled from EITHER vertex source, because one sweep uses each and counting one
 * of them loses half the teeth.
 *
 * THIS COST TIME THREE TIMES NOW, so it is written down plainly. A chain sweep whose start node
 * carries a label walks `verticesByLabel.get(L)`'s Set. A sweep that FLIPS to start from the far
 * end of `(a:P)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)` starts at `(n2)`, which has NO label — so
 * `startLabel` is undefined and the source is `verticesById.values()` instead. The end-gated case
 * below reads 0 on the label surface for that reason and not because it stopped sweeping.
 *
 * Item 1329 lost the most to this: a spy on `verticesById.values()` alone read 0 for the pinned
 * family whether its guard was present or not, which looked like proof the route was unobservable.
 * `enumeration-surface-probe.ts` exists to settle which surface a route uses; reach for it rather
 * than guessing again.
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
 * Above `SEEK_FLOOR_VERTICES` (4,096), without which the gate admits every seek and the
 * selectivity case below cannot be expressed at all. Item 1316 and item 1329 each lost time to a
 * fixture under a threshold reporting a confident null.
 */
const N = 5_000;

const chain = (hops: number): string =>
  Array.from({ length: hops }, (_, i) => `-[:E]->(n${i})`).join('');

const build = (withIndexes: boolean): Graph => {
  const g = new Graph();

  if (withIndexes) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['grp'] });
  }

  // A RARE second label, so a chain ending in `(n2:Q)` makes the END bucket smaller than the
  // START's and the sweep FLIPS to read from that end. Without it the flip never happens here and
  // the flipped-seeding mutant below has nothing to fail.
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: i % 500 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i, grp: i % 2 },
    }),
  );

  for (let i = 0; i < N; i++) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i * 7 + 1) % N], labels: ['E'], properties: {} });
  }

  return g;
};

let indexed: Graph;
let plain: Graph;
let indexedWalk: () => number;
let plainWalk: () => number;

beforeAll(() => {
  indexed = build(true);
  plain = build(false);
  indexedWalk = spyLabelWalk(indexed);
  plainWalk = spyLabelWalk(plain);
});

const walkedBy = <T>(walk: () => number, run: () => T): { walked: number; value: T } => {
  const before = walk();
  const value = run();

  return { walked: walk() - before, value };
};

describe('an indexed, selective start seeds the sweep instead of walking the bucket', () => {
  for (const hops of [3, 4, 5]) {
    test(`${hops} segments: seeded, so the label bucket is not walked`, () => {
      const { walked, value } = walkedBy(indexedWalk, () =>
        query(indexed, `MATCH (a:P)${chain(hops)} WHERE a.k = 7 RETURN count(*) AS c`, {}),
      );

      expect(Number(value[0]?.c)).toBe(1);
      expect(walked).toBe(0);
    });
  }

  test('a PARAMETER is seeded as well as a literal', () => {
    // The two spellings must cost the same — that is this repo's oldest performance rule, and
    // every historical index-seeding bug was one spelling recognized and its twin scanned.
    const { walked, value } = walkedBy(indexedWalk, () =>
      query(indexed, `MATCH (a:P)${chain(3)} WHERE a.k = $k RETURN count(*) AS c`, { k: 7 }),
    );

    expect(Number(value[0]?.c)).toBe(1);
    expect(walked).toBe(0);
  });

  test('an INLINE property is seeded as well as a clause WHERE', () => {
    // Item 125's 4x clause-vs-inline gap was exactly this asymmetry, on a one-hop count.
    const { walked, value } = walkedBy(indexedWalk, () =>
      query(indexed, `MATCH (a:P {k: 7})${chain(3)} RETURN count(*) AS c`, {}),
    );

    expect(Number(value[0]?.c)).toBe(1);
    expect(walked).toBe(0);
  });
});

describe('the seek is PRICED, not taken whenever an index exists', () => {
  /**
   * THE CASE THAT GIVES THIS FILE TEETH ABOUT THE GATE. `grp` is indexed and matches HALF the
   * graph, so seeking it would materialize 2,500 vertices to replace a 5,000-vertex scan. Audit
   * item 409 measured that shape at 5.02x SLOWER at 60% selectivity, which is why
   * `seekIsWorthIt` caps a seek at `SEEK_MAX_FRACTION` (1/8) of the bucket it replaces.
   *
   * Without this case, a mutant that drops the pricing and seeks whenever an index exists would
   * pass every other test here — the answers are identical either way.
   */
  test('an indexed but UNSELECTIVE start does NOT seed, and walks the bucket', () => {
    const { walked, value } = walkedBy(indexedWalk, () =>
      query(indexed, `MATCH (a:P)${chain(3)} WHERE a.grp = 0 RETURN count(*) AS c`, {}),
    );

    expect(Number(value[0]?.c)).toBe(2_500);
    expect(walked).toBeGreaterThan(0);
  });

  test('with NO index at all the sweep walks the bucket exactly as before', () => {
    // The unindexed path is the common one and the regression risk: the decline this item rejected
    // cost it 2.9x. Here it must be untouched.
    const { walked, value } = walkedBy(plainWalk, () =>
      query(plain, `MATCH (a:P)${chain(3)} WHERE a.k = 7 RETURN count(*) AS c`, {}),
    );

    expect(Number(value[0]?.c)).toBe(1);
    expect(walked).toBeGreaterThan(0);
  });

  test('an END-gated chain still sweeps — it flips to the UNLABELLED far end', () => {
    const { walked } = walkedBy(indexedWalk, () =>
      query(indexed, `MATCH (a:P)${chain(3)} WHERE n2.k = 7 RETURN count(*) AS c`, {}),
    );

    expect(walked).toBeGreaterThan(0);
  });
});

describe('answers are unchanged, which the route choice must never affect', () => {
  // Seeding only narrows the source set, so every answer must match the graph that cannot seed.
  for (const hops of [3, 4, 5]) {
    test(`${hops} segments agrees with the UNINDEXED graph`, () => {
      const q = `MATCH (a:P)${chain(hops)} WHERE a.k = 7 RETURN count(*) AS c`;

      expect(Number(query(indexed, q, {})[0]?.c)).toBe(Number(query(plain, q, {})[0]?.c));
    });
  }

  test('an unselective start agrees too, seeded or not', () => {
    const q = `MATCH (a:P)${chain(3)} WHERE a.grp = 0 RETURN count(*) AS c`;

    expect(Number(query(indexed, q, {})[0]?.c)).toBe(Number(query(plain, q, {})[0]?.c));
  });

  /**
   * A FLIPPED sweep must not be seeded from the forward start node. `(n2:Q)` is rarer than
   * `(a:P)`, so `pick` chooses the reversed reading and the sweep enumerates from the Q end —
   * while `cstart` describes `a`. Handing that seed to a reading that starts elsewhere is a WRONG
   * ANSWER, not a slow one, which is why only the unindexed graph can be the oracle.
   *
   * This case exists because mutation said it was missing: `seeds-flipped-reading-too` SURVIVED
   * the first pass with every other test green. That is the shape of defect this repo's own notes
   * warn about — a route change that permutes which slot holds which node, invisible to a
   * `count(*)` over a single-label fixture.
   */
  test('a chain whose END is rarer flips the sweep, and the answer survives it', () => {
    // `k = 201` is NOT arbitrary. The ring is `i -> (i * 7 + 1) % 5000`, so three hops from v201
    // reach v4000, which carries `Q` (4000 % 500 === 0). Exactly ten starts have that property.
    //
    // ⚠️ THE FIRST VERSION OF THIS TEST USED `k = 7`, WHOSE THREE-HOP ENDPOINT IS v2458 — not a Q
    // vertex, so the true answer was 0, both graphs returned 0, and the test passed while
    // asserting nothing. Mutation is the only reason that is known: `seeds-flipped-reading-too`
    // survived a pass in which this case was green. A cross-graph comparison is FREE whenever the
    // answer is empty, so the non-zero assertion below is load-bearing, not decoration.
    const qFlip = `MATCH (a:P)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2:Q) WHERE a.k = 201 RETURN count(*) AS c`;
    const seeded = Number(query(indexed, qFlip, {})[0]?.c);

    expect(seeded).toBeGreaterThan(0);
    expect(seeded).toBe(Number(query(plain, qFlip, {})[0]?.c));

    // And the unflipped twin still agrees, so the case above is not passing by both being wrong.
    const q = `MATCH (a:P)${chain(3)} WHERE a.k = 201 RETURN count(*) AS c`;
    const unflipped = Number(query(indexed, q, {})[0]?.c);

    expect(unflipped).toBeGreaterThan(0);
    expect(unflipped).toBe(Number(query(plain, q, {})[0]?.c));
  });

  /**
   * THE NARROWEST candidate must win, not merely some candidate. Both keys are indexed and they
   * differ by three orders of magnitude in selectivity: `k = 7` is one vertex, `grp = 0` is 2,500
   * of 5,000. Choosing the wider one makes the seek 2,500 wide, which `seekIsWorthIt` then
   * refuses outright — so the query falls back to the bucket walk and the saving is lost.
   *
   * Also added because mutation said so: `picks-worst-candidate` SURVIVED the first pass, since
   * every other query here offers exactly ONE indexed candidate and min and max coincide.
   */
  test('with TWO indexed conjuncts the narrowest is seeded, not just any of them', () => {
    const { walked, value } = walkedBy(indexedWalk, () =>
      query(indexed, `MATCH (a:P)${chain(3)} WHERE a.k = 7 AND a.grp = 1 RETURN count(*) AS c`, {}),
    );

    expect(Number(value[0]?.c)).toBe(1);
    expect(walked).toBe(0);
  });

  test('the count agrees with the ROW form, which has no count shortcut to decline', () => {
    const rows = query(indexed, `MATCH (a:P)${chain(3)} WHERE a.k = 7 RETURN n2.k AS v`, {});
    const counted = Number(
      query(indexed, `MATCH (a:P)${chain(3)} WHERE a.k = 7 RETURN count(*) AS c`, {})[0]?.c,
    );

    expect(counted).toBe(rows.length);
  });
});
