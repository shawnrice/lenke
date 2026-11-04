import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Two more vacuous-far-label drops: `filteredHopWalk`'s START-ONLY closure and the OPTIONAL-MATCH
 * hop (item 1410).
 *
 * `filteredHopWalk` holds TWO closures. The general one got item 1066's vacuity drop; the start-only
 * one — taken when the predicate reads only the start, so the gate can run before the adjacency is
 * touched (item 164) — did not. `hopfiltyield` profiles with ZERO label frames and
 * `hopstartonlyyield` spent **36.8%** there, two rows on one function where neither covered the
 * other. `detectOptionalHopProjection` is a separate detector entirely and had never had the drop.
 *
 * ⚠️ THE OPTIONAL HOP IS THE DELICATE ONE. Its far test decides `matched`, and `matched` decides
 * whether a start with no qualifying edge gets a NULL row. So a mis-decided drop there does not just
 * add or remove rows — it changes which starts are padded with NULL, and **the row COUNT can stay
 * the same while the rows are wrong**. The fixtures below are built so that is exactly what a
 * wrongly-dropped label would do, and every assertion names the nulls rather than counting them.
 *
 * A vacuous label cannot change `matched` by definition — it rejects nothing, so every edge that set
 * the flag still sets it — which is why the drop is sound. These tests are what makes that an
 * observation rather than an assertion.
 *
 * ⚠️ A FIXTURE TRAP, HIT WHILE WRITING THIS FILE. `MATCH (a:P)` filters the START set by the same
 * label, so moving a vertex off `P` to make the far label meaningful also removes it as a start, and
 * the two fixtures then differ in two ways at once. My first version put the `Q` on a vertex that was
 * also the second edge's source, and five assertions failed for that reason rather than any defect.
 * Here the label difference lands ONLY on `e`, which is nothing's source — so `a`..`d` are starts in
 * both graphs and the two differ in exactly the property under test.
 */

const build = (eIsP: boolean): Graph => {
  const g = new Graph();

  for (const [id, n] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { n } });
  }

  // The ONLY difference between the two fixtures. `e` is a sink, so it is never a start.
  g.addVertex({ id: 'e', labels: [eIsP ? 'P' : 'Q'], properties: { n: 5 } });
  g.addEdge({ id: 'ab', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['E'] });
  g.addEdge({ id: 'ce', from: g.getVertexById('c')!, to: g.getVertexById('e')!, labels: ['E'] });

  return g;
};

/** Every vertex `P`, so `:P` rejects nothing and the drop must fire. */
const vacuous = (): Graph => build(true);
/** `e` is `Q`, so `:P` really filters and the drop must NOT fire. */
const filtering = (): Graph => build(false);

/** Nulls first, then ascending — so a NULL row cannot vanish into a numeric comparison. */
const cmp = (x: unknown, y: unknown): number => {
  if (x === null) {
    return y === null ? 0 : -1;
  }

  if (y === null) {
    return 1;
  }

  return Number(x) - Number(y);
};

/** Sorted with `null` kept and placed first, so a NULL row cannot vanish into a numeric sort. */
const col = (g: Graph, src: string, key: string): unknown[] =>
  query(g, src)
    .map((r) => r[key] ?? null)
    .slice()
    .sort(cmp);

describe("filteredHopWalk's START-ONLY closure and a vacuous far label (item 1410)", () => {
  // A predicate on the START (`a.n`), which is what routes here rather than to the general closure.
  const Q = 'MATCH (a:P)-[:E]->(b:P) WHERE a.n > 0 RETURN b.n AS n';

  test('on a vacuous graph the labelled and unlabelled spellings agree', () => {
    const g = vacuous();

    expect(col(g, Q, 'n')).toEqual(
      col(g, 'MATCH (a:P)-[:E]->(b) WHERE a.n > 0 RETURN b.n AS n', 'n'),
    );
    expect(col(g, Q, 'n')).toEqual([2, 5]);
  });

  test('on a FILTERING graph the same query text drops the Q endpoint', () => {
    // `a`->`b` survives; `c`->`e` does not, because `e` is a `Q`. An unconditional drop would
    // return [2, 5] here — the vacuous answer.
    expect(col(filtering(), Q, 'n')).toEqual([2]);
  });

  test('and the complementary label picks up exactly the other row', () => {
    expect(col(filtering(), 'MATCH (a:P)-[:E]->(b:Q) WHERE a.n > 0 RETURN b.n AS n', 'n')).toEqual([
      5,
    ]);
  });

  test('the start gate still applies with the label dropped', () => {
    // `a.n > 1` excludes vertex `a`, leaving only `c`->`e`. The gate and the label are independent,
    // and dropping one must not weaken the other.
    expect(col(vacuous(), 'MATCH (a:P)-[:E]->(b:P) WHERE a.n > 1 RETURN b.n AS n', 'n')).toEqual([
      5,
    ]);
  });

  test('a start gate that admits nothing returns nothing, on either graph', () => {
    for (const g of [vacuous(), filtering()]) {
      expect(col(g, 'MATCH (a:P)-[:E]->(b:P) WHERE a.n > 99 RETURN b.n AS n', 'n')).toEqual([]);
    }
  });
});

describe('the OPTIONAL-MATCH hop and a vacuous far label (item 1410)', () => {
  const Q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:P) RETURN b.n AS n';

  test('on a vacuous graph every start appears, matched or padded with NULL', () => {
    // Starts are a, b, c, d, e (all `P`). `a`->`b` gives 2 and `c`->`e` gives 5; b, d and e have no
    // outgoing `E` and are padded. Five starts, five rows.
    expect(col(vacuous(), Q, 'n')).toEqual([null, null, null, 2, 5]);
  });

  test('the labelled and unlabelled spellings agree when the label is vacuous', () => {
    const g = vacuous();

    expect(col(g, Q, 'n')).toEqual(
      col(g, 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.n AS n', 'n'),
    );
  });

  test('⚠️ a FILTERING label moves a start from MATCHED to NULL-padded, at a CONSTANT row count', () => {
    // THE TEST A ROW COUNT CANNOT DO. On the filtering graph the starts are a, b, c, d — `e` is a
    // `Q` and so not a start — giving FOUR rows. `a`->`b` still matches (2). `c`->`e` is rejected
    // by the far label, so `matched` stays false and `c` is padded.
    //
    //   correct:              [null, null, null, 2]      a=2, b=NULL, c=NULL, d=NULL
    //   with the label wrongly dropped: [null, null, 2, 5]   a=2, b=NULL, c=5,    d=NULL
    //
    // FOUR rows either way. Only the contents distinguish them, which is why this file asserts
    // values and not lengths.
    expect(col(filtering(), Q, 'n')).toEqual([null, null, null, 2]);
  });

  test('a label absent from the graph pads EVERY start', () => {
    // The strongest form of the same guard: nothing can match, so all five starts are NULL. A
    // dropped label would return the matched rows instead.
    expect(
      col(vacuous(), 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:Z) RETURN b.n AS n', 'n'),
    ).toEqual([null, null, null, null, null]);
  });

  test('the row count is one per start whatever the far label does', () => {
    // A relation rather than a guessed number: every vertex here has out-degree at most 1, so the
    // optional hop emits exactly one row per start regardless of which far ends qualify. Asserted
    // against the start count the engine itself reports, not against a literal.
    for (const g of [vacuous(), filtering()]) {
      const starts = query<{ c: number }>(g, 'MATCH (a:P) RETURN count(*) AS c')[0].c;

      for (const lbl of [':P', ':Q', ':Z', '']) {
        const rows = query(g, `MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b${lbl}) RETURN b.n AS n`);

        expect(rows).toHaveLength(starts);
      }
    }
  });
});

describe('vacuity is decided PER GRAPH for both walks (item 1410)', () => {
  // This is what would catch a per-COMPILE hoist: one query text, two graphs, two correct but
  // DIFFERENT answers. A cached decision would make the second call agree with the first whichever
  // order they run in, so the vacuous case is asserted again after the filtering one.
  test('one start-only query text, two graphs, two correct answers', () => {
    const Q = 'MATCH (a:P)-[:E]->(b:P) WHERE a.n > 0 RETURN b.n AS n';

    expect(col(vacuous(), Q, 'n')).toEqual([2, 5]);
    expect(col(filtering(), Q, 'n')).toEqual([2]);
    expect(col(vacuous(), Q, 'n')).toEqual([2, 5]);
  });

  test('one optional query text, two graphs, two correct paddings', () => {
    const Q = 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:P) RETURN b.n AS n';

    expect(col(vacuous(), Q, 'n')).toEqual([null, null, null, 2, 5]);
    expect(col(filtering(), Q, 'n')).toEqual([null, null, null, 2]);
    expect(col(vacuous(), Q, 'n')).toEqual([null, null, null, 2, 5]);
  });
});
