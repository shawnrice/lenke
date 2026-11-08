import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { vacuousLabel } from './executor/labels.js';
import { query } from './index.js';

/**
 * Item 1609: the vacuous-label elision applied UNIFORMLY to all seven seeded label tests in
 * `shortcuts.ts` — `buildNodeCount`, the three `detectNodeProjection` walks, both
 * `detectNodeAggregate` walks and `detectMultiNodeAggregate`.
 *
 * ⚠️ UNIFORMITY IS THE WHOLE POINT, not thoroughness. Item 1608 built this at ONE site and reverted
 * it, because `verticesByLabel` is not maintained by the raw `v.labels =` setter — so after such a
 * write the elided site and the non-elided one answer differently:
 *
 * ```text
 *    MATCH (n:P) WHERE n.k = $v RETURN count(*)   5     <- elided
 *    MATCH (n:P) WHERE n.k = $v RETURN n.k        4 rows   <- not
 * ```
 *
 * That is the defect class this engine is named after, as a CORRECTNESS bug. With all seven elided
 * the spellings agree again — which is what the first block below pins, and it is the test that
 * would have caught item 1608's version.
 *
 * ```text
 *                     PRE      POST     vacuous      MULTI control
 *    count          15483     2775      5.58x        15295 -> 13761  flat
 *    values         51421    34000      1.51x        44076 -> 39558..41034  flat
 *    values+order   62368    47102      1.32x        51882 -> 49567  flat
 *    values+limit   53755    39199      1.37x        47324 -> 45933  flat
 *    aggregate      49494    38478      1.29x        41970 -> 40986  flat
 *    multi-agg      61344    46978      1.31x        51034 -> 50630  flat
 * ```
 */
const build = (labels: (i: number) => string[], indexed = true): Graph => {
  const g = new Graph();

  for (let i = 0; i < 12; i += 1) {
    g.addVertex({ id: `u${i}`, labels: labels(i), properties: { k: i % 2, n: i } });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
  }

  return g;
};

/** One shape per elided site, so a site left behind shows up as a disagreement. */
const SHAPES: readonly [string, string][] = [
  ['count', 'MATCH (n:P) WHERE n.k = $v RETURN count(*) AS c'],
  ['values', 'MATCH (n:P) WHERE n.k = $v RETURN n.n AS n'],
  ['values+order', 'MATCH (n:P) WHERE n.k = $v RETURN n.n AS n ORDER BY n'],
  ['values+limit', 'MATCH (n:P) WHERE n.k = $v RETURN n.n AS n ORDER BY n LIMIT 99'],
  ['aggregate', 'MATCH (n:P) WHERE n.k = $v RETURN count(n.n) AS c'],
  ['multi-agg', 'MATCH (n:P) WHERE n.k = $v RETURN count(*) AS c, max(n.n) AS m'],
];

/**
 * Spellings that DECLINE their shortcut and fall to the general matcher (`matchNode`), which does
 * not elide — so after a raw-setter write these honour the label where the shortcut shapes do not.
 *
 * ⚠️ THIS SPLIT IS PRE-EXISTING AND NOT INTRODUCED HERE, and item 1608 said the opposite because it
 * tested the wrong pair. It compared a hop COUNT against hop ROWS — both of which take shortcuts —
 * and concluded the engine was consistent. It is not: measured on the HOP family today, with one
 * vertex's label removed by the raw setter,
 *
 * ```text
 *    MATCH (a:P)-[:E]->(b) RETURN count(*)            7    <- shortcut, elides
 *    MATCH (a:P)-[:E]->(b) RETURN b.n                 7    <- shortcut, elides
 *    MATCH (a:P)-[:E]->(b) RETURN collect(b.n)        7    <- shortcut, elides
 *    MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.n        7    <- shortcut, elides
 *    MATCH (a:P)-[:E]->(b) RETURN b.n ORDER BY a.n    6    <- GENERAL, honours it
 * ```
 *
 * So items 1551/1552 shipped this class in the hop family, and the node family now joins it rather
 * than inventing it. What this item DOES guarantee is that every shape taking a NODE shortcut
 * agrees with every other — which is what the block above pins.
 */
const DECLINING: readonly [string, string][] = [
  ['values+order-off-output', 'MATCH (n:P) WHERE n.k = $v RETURN n.n AS n ORDER BY n.k'],
  ['collecting-aggregate', 'MATCH (n:P) WHERE n.k = $v RETURN collect(n.n) AS s'],
];

/** The cardinality each shape reports, however it reports it. */
const card = (g: Graph, text: string): number => {
  const rows = query(g, text, { v: 0 });
  const first = (rows[0] ?? {}) as Record<string, unknown>;

  if ('c' in first) {
    return Number(first.c);
  }

  /**
   * ⚠️ `collect`, NOT `sum`, and the first version used `sum` and tested the wrong thing. A sum is
   * not a cardinality, so that version normalized it by RE-ASKING with `count(*)` — which takes a
   * different route (`buildNodeCount`) and so reported that route's answer for a shape meant to
   * exercise the collecting-aggregate arm. `collect` is also a VALUES aggregate, so it reaches the
   * same arm, and its result is a LIST whose length IS the cardinality — no re-ask, no second
   * route.
   */
  if (Array.isArray(first.s)) {
    return first.s.length;
  }

  return rows.length;
};

describe('every seeded label test elides, so the spellings cannot disagree', () => {
  test('all vertices labelled: every shape answers 6', () => {
    const g = build(() => ['P']);

    for (const [name, text] of SHAPES) {
      expect(card(g, text), name).toBe(6);
    }
  });

  test('⚠️ after a RAW setter write, all six still AGREE — item 1608 is why this exists', () => {
    /**
     * The raw `v.labels =` setter does not maintain `verticesByLabel` (memory's
     * `label-index-vs-setter`, an open owner decision), so a vacuity check cannot see the write.
     * That is pre-existing and shared with the ten hop sites, which were measured answering 9 for
     * BOTH a hop count and a hop ROWS query after the same write.
     *
     * What this test pins is the property item 1608's single-site version broke: whatever the
     * engine answers, every spelling of the question answers the SAME thing. A site left
     * un-elided would show up here as one number out of six differing.
     */
    const g = build(() => ['P']);

    g.getVertexById('u0')!.labels = ['Q'];

    const answers = SHAPES.map(([name, text]) => [name, card(g, text)] as const);

    expect(new Set(answers.map(([, c]) => c)).size, JSON.stringify(answers)).toBe(1);
  });

  test('a spelling that DECLINES its shortcut honours the label — pre-existing, same as hops', () => {
    /**
     * Not a wish, a record: `matchNode` does not elide, so a declining spelling sees the setter
     * write. The hop family has behaved this way since items 1551/1552 (see `DECLINING`'s note).
     * Pinned so the asymmetry is a documented state rather than a surprise, and so that making
     * `matchNode` elide — which item 631 prices at 0.86x for the shapes it cannot help — would show
     * up here as a failing test rather than as a silent answer change.
     */
    const g = build(() => ['P']);

    g.getVertexById('u0')!.labels = ['Q'];

    for (const [name, text] of DECLINING) {
      expect(card(g, text), name).toBe(5);
    }

    // And the shortcut shapes do not, which is the asymmetry itself.
    expect(card(g, SHAPES[0][1])).toBe(6);
  });

  test('and through the MAINTAINED api the answers follow the label', () => {
    // `removeLabel` updates `verticesByLabel`, so vacuity goes false and every site tests again.
    //
    // ⚠️ `u2`, NOT `u1`. `k = i % 2` and these shapes query `k = 0`, so stripping the label from an
    // ODD vertex leaves the queried bucket untouched and the test passes whatever the elision does.
    // The first version of this test used `u1` and expected 5 where 6 is correct.
    const g = build(() => ['P']);

    g.getVertexById('u2')!.removeLabel('P');

    for (const [name, text] of SHAPES) {
      expect(card(g, text), name).toBe(5);
    }
  });
});

describe('a NON-vacuous label is still tested at every site', () => {
  /**
   * The control that matters for correctness: when the label does NOT cover every vertex the
   * elision must not fire, and a seeded candidate of the wrong label must be excluded. The bucket
   * for `k = 0` holds both labels here, so a site that skipped the test would over-count.
   */
  const g = build((i) => (i % 3 === 0 ? ['Other'] : ['P']));

  test('vacuousLabel says so', () => {
    expect(vacuousLabel(g, { kind: 'label', name: 'P' })).toBe(false);
  });

  test('every shape excludes the Other-labelled vertices', () => {
    // 12 vertices, k = i % 2, so k = 0 is i in {0,2,4,6,8,10}; of those i % 3 === 0 for 0, 6 — two
    // are `Other`, leaving four `P`.
    for (const [name, text] of SHAPES) {
      expect(card(g, text), name).toBe(4);
    }
  });

  test('and the unindexed twin agrees, so the index changed the cost and not the count', () => {
    const plain = build((i) => (i % 3 === 0 ? ['Other'] : ['P']), false);

    for (const [name, text] of SHAPES) {
      expect(card(plain, text), name).toBe(card(g, text));
    }
  });
});

describe('an EMPTY label still answers nothing', () => {
  test('the companion of vacuity is untouched', () => {
    const g = build(() => ['P']);

    for (const [name, text] of SHAPES) {
      const q = text.replace('(n:P)', '(n:Nope)');
      const rows = query(g, q, { v: 0 });
      const first = (rows[0] ?? {}) as Record<string, unknown>;

      // A count of nothing is 0 and a projection of nothing is no rows; both mean "no match".
      expect('c' in first ? Number(first.c) : rows.length, name).toBe(0);
    }
  });
});
