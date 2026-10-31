/**
 * The GROUPED per-endpoint extremum fold (item 1310) — which walk runs, when it declines, and that
 * the answers are the per-edge walk's.
 *
 * ⚠️ HOW THE ROUTE IS OBSERVED, because this needs stating plainly. The fold is answer-equivalent,
 * so nothing about the VALUES can tell which walk ran, and items 1303/1306/1307 all record how a
 * blunt route assertion lets a "silently stopped firing" mutant through. What distinguishes them
 * here is GROUP EMISSION ORDER: the per-edge walk iterates the START side, the fold iterates the
 * FAR side, and the fixture below is built so those two orders DISAGREE.
 *
 * That is order used as an INSTRUMENT, not asserted as a contract. Grouped row order without
 * `ORDER BY` is unspecified in this engine — the differential fuzzer compares grouped results as a
 * row MULTISET for exactly that reason, and item 1296 settled it before this fold was built. If
 * either walk's traversal order is deliberately changed later, these route assertions are expected
 * to change with it; the VALUE assertions below are the ones that pin behaviour.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * A fixture whose START-side and FAR-side group orders DISAGREE.
 *
 * Insertion order is `a`, `b`, `c`. Edges are `a->c` and `b->a`, so:
 *   * the START-side walk visits `a` first and reaches `c`, so it opens group "gc" first  -> [gc, ga]
 *   * the FAR-side walk visits `a` first and `a` IS reached (from `b`), so it opens "ga" first -> [ga, gc]
 *
 * `b` is never a far endpoint (nothing points at it), which is also what makes the two orders
 * differ rather than merely rotate. Every vertex carries `P`, so the start label is VACUOUS and the
 * fold's run-time admission passes.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const [id, grp, n] of [
    ['a', 'ga', 5],
    ['b', 'gb', 7],
    ['c', 'gc', 3],
  ] as ReadonlyArray<readonly [string, string, number]>) {
    g.addVertex({ id, labels: ['P'], properties: { grp, n } });
  }

  const v = (id: string) => g.verticesById.get(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('c'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: v('b'), to: v('a'), labels: ['T'], properties: {} });

  return g;
};

const keys = (rows: readonly unknown[]): unknown[] => rows.map((r) => (r as { c: unknown }).c);

describe('the fold RUNS for the shape it is admitted for', () => {
  test('groups come out in FAR-side order, which the per-edge walk cannot produce', () => {
    const g = build();
    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo');

    // [ga, gc] is the fold's order. [gc, ga] would mean it declined and the per-edge walk ran.
    expect(keys(rows)).toEqual(['ga', 'gc']);
    expect(rows).toEqual([
      { c: 'ga', lo: 5 },
      { c: 'gc', lo: 3 },
    ]);
  });

  test('an UNTYPED relationship is ADMITTED, not declined', () => {
    const g = build();

    // `relTypeNames` returns `undefined` for `-[]->` (every type) and `null` for a label
    // expression it cannot reduce to a type list (decline). Collapsing those two would silently
    // refuse the untyped hop, which answers correctly and so is invisible to a value assertion —
    // hence the ORDER check here.
    expect(keys(query(g, 'MATCH (s:P)-[]->(x) RETURN x.grp AS c, min(x.n) AS lo'))).toEqual([
      'ga',
      'gc',
    ]);
  });

  test('two extrema in one projection both ride it', () => {
    const g = build();
    const rows = query(
      g,
      'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo, max(x.n) AS hi',
    );

    expect(keys(rows)).toEqual(['ga', 'gc']);
    expect(rows).toEqual([
      { c: 'ga', lo: 5, hi: 5 },
      { c: 'gc', lo: 3, hi: 3 },
    ]);
  });

  test("ORDER BY still sorts, and sorts the FOLD's rows", () => {
    const g = build();

    expect(
      query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo ORDER BY c DESC'),
    ).toEqual([
      { c: 'gc', lo: 3 },
      { c: 'ga', lo: 5 },
    ]);
  });
});

describe('the admission conditions, each asserted by its DECLINE', () => {
  test('a NON-VACUOUS start label declines — and that is a measured regression guard', () => {
    const g = build();

    // One vertex without `P` makes the start label real, so proving reachability would have to
    // resolve `e.from` per in-edge. Item 1245 measured the fold WITHOUT this test as 1.07x WORSE
    // than the per-edge walk, so declining here is the faster plan and not merely the safe one.
    g.addVertex({ id: 'z', labels: ['Other'], properties: { grp: 'gz', n: 1 } });

    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo');

    // START-side order proves the per-edge walk ran; the VALUES are unchanged either way.
    expect(keys(rows)).toEqual(['gc', 'ga']);
    expect(rows).toEqual([
      { c: 'gc', lo: 3 },
      { c: 'ga', lo: 5 },
    ]);
  });

  test('count(*) is NOT admitted — it needs the multiplicity', () => {
    const g = build();
    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, count(*) AS n');

    expect(keys(rows)).toEqual(['gc', 'ga']);
    expect(rows).toEqual([
      { c: 'gc', n: 1 },
      { c: 'ga', n: 1 },
    ]);
  });

  test('sum is NOT admitted — it needs the multiplicity too', () => {
    const g = build();
    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, sum(x.n) AS s');

    expect(keys(rows)).toEqual(['gc', 'ga']);
  });

  test('a MIXED projection declines: one non-extremum disqualifies the whole fold', () => {
    const g = build();
    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo, count(*) AS n');

    expect(keys(rows)).toEqual(['gc', 'ga']);
  });

  test('a key on the START end declines — each start can reach MANY groups', () => {
    const g = build();
    const rows = query(g, 'MATCH (s:P)-[:T]->(x) RETURN s.grp AS c, min(x.n) AS lo');

    // Keyed on the start, so the identity "each distinct endpoint belongs to one group" does not
    // hold and the fold must not apply. Start-side order, and the values are the start's groups.
    expect(rows).toEqual([
      { c: 'ga', lo: 3 },
      { c: 'gb', lo: 5 },
    ]);
  });
});

describe('the gaps the mutation pass found — each of these let a mutant live', () => {
  // Four guards survived their mutants on the first pass, and NONE of them was redundant: every one
  // was a hole in THIS file. Recorded with the shape that closes it, because the next reader will
  // otherwise assume the guard is defensive.

  test('count(x) with an ARGUMENT must not be folded — it needs the multiplicity', () => {
    const g = build();
    const v = (id: string) => g.verticesById.get(id)!;

    // PARALLEL edges into `c`, so per-edge and per-endpoint counts differ: 2 against 1.
    g.addEdge({ id: 'p1', from: v('b'), to: v('c'), labels: ['T'], properties: {} });

    // `foldFor` admits count/min/max, so `count(x.n)` builds a `fold` acc and the acc-kind check
    // alone cannot refuse it — only the EXTREMUM name test can. The earlier tests used `count(*)`,
    // which builds a `rows` acc and is refused for a different reason, so the name test was
    // untested.
    expect(query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, count(x.n) AS n')).toEqual([
      { c: 'gc', n: 2 },
      { c: 'ga', n: 1 },
    ]);
  });

  test('a START-keyed group whose aggregate also reads the START must decline', () => {
    const g = build();

    // The earlier start-keyed test aggregated over `x`, which the rung refuses OUTRIGHT because
    // every aggregate argument must read the keyed variable — so it never reached the admission
    // and `!onStart` was untested. Reading `s` on both sides is the shape that does reach it.
    expect(query(g, 'MATCH (s:P)-[:T]->(x) RETURN s.grp AS c, min(s.n) AS lo')).toEqual([
      { c: 'ga', lo: 5 },
      { c: 'gb', lo: 7 },
    ]);
  });

  test('a filter on the KEYED end still applies through the fold', () => {
    const g = build();
    const v = (id: string) => g.verticesById.get(id)!;

    g.addVertex({ id: 'd', labels: ['P'], properties: { grp: 'gd', n: 9 } });
    g.addEdge({
      id: 'e3',
      from: v('b'),
      to: g.verticesById.get('d')!,
      labels: ['T'],
      properties: {},
    });

    // No earlier test put an inline constraint or a clause `WHERE` on the far end, so the gate was
    // never exercised inside the fold — dropping it answered a SUPERSET and nothing noticed.
    expect(query(g, "MATCH (s:P)-[:T]->(x {grp: 'gd'}) RETURN x.grp AS c, min(x.n) AS lo")).toEqual(
      [{ c: 'gd', lo: 9 }],
    );
    expect(
      query(g, "MATCH (s:P)-[:T]->(x) WHERE x.grp = 'gd' RETURN x.grp AS c, min(x.n) AS lo"),
    ).toEqual([{ c: 'gd', lo: 9 }]);
  });

  test('min(DISTINCT x) must decline — it is an extremum by NAME but not a fold', () => {
    const g = build();

    // ⚠️ THIS DOES NOT TEST THE ACC-KIND GUARD, and a first version of this comment claimed it
    // did. `compileLinear` shows NO rung firing for this shape at all — `routes()` returns `[]` —
    // so `detectGroupedHopAggregate` refuses a DISTINCT aggregate upstream of the fold's
    // admission, and the general path answers it. The acc-kind guard's mutant survives for that
    // reason, which is recorded where the guard is.
    //
    // Kept anyway, because nothing else asserted that this shape answers correctly.
    expect(query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(DISTINCT x.n) AS lo')).toEqual([
      { c: 'gc', lo: 3 },
      { c: 'ga', lo: 5 },
    ]);
  });

  test('a NEGATED relationship label must decline — "every type" is the wrong reading', () => {
    const g = build();
    const v = (id: string) => g.verticesById.get(id)!;

    g.addEdge({ id: 'es', from: v('b'), to: v('c'), labels: ['S'], properties: {} });

    // `relTypeNames` cannot reduce `!T` to a type list and returns `null`, so the fold's
    // `types === null` decline looks like what refuses this. IT IS NOT: `routes()` returns `[]`
    // for a negated relationship label, so the RUNG declines upstream and the general path
    // answers. That guard's mutant survives for the same reason the acc-kind one does.
    //
    // Kept as the assertion that a negated label answers correctly — only the `S` edge — which
    // nothing else covered.
    expect(query(g, 'MATCH (s:P)-[:!T]->(x) RETURN x.grp AS c, min(x.n) AS lo')).toEqual([
      { c: 'gc', lo: 3 },
    ]);
  });

  test('a NULL value is skipped by the fold, for MAX as well as MIN', () => {
    const g = build();
    const v = (id: string) => g.verticesById.get(id)!;

    g.addVertex({ id: 'nul', labels: ['P'], properties: { grp: 'ga' } });
    g.addEdge({
      id: 'en',
      from: v('b'),
      to: g.verticesById.get('nul')!,
      labels: ['T'],
      properties: {},
    });

    // ⚠️ MAX IS THE ARM THAT CATCHES THIS, and `min` alone did not. `extremumFold.step` does not
    // skip nullish itself, so dropping the guard folds the null through `compareValues` — and
    // where null sits in that total order decides WHICH extremum changes. The earlier null cases
    // asserted `min` only, so the guard looked tested and was not.
    expect(
      query(g, 'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo, max(x.n) AS hi'),
    ).toEqual([
      { c: 'ga', lo: 5, hi: 5 },
      { c: 'gc', lo: 3, hi: 3 },
    ]);
  });
});

describe('the fold answers what the per-edge walk answers', () => {
  /** The same question with the fold disqualified by a non-vacuous start label. */
  const bothWalks = (g: Graph, q: string): [unknown[], unknown[]] => {
    const folded = query(g, q);
    const g2 = new Graph();

    for (const v of g.vertices) {
      g2.addVertex({ id: v.id, labels: [...v.labels], properties: { ...v.properties } });
    }

    for (const e of g.edges) {
      g2.addEdge({
        id: e.id,
        from: g2.verticesById.get(e.from.id)!,
        to: g2.verticesById.get(e.to.id)!,
        labels: [...e.labels],
        properties: { ...e.properties },
      });
    }

    // Disqualify the fold on the COPY, so the same graph is answered by the per-edge walk.
    g2.addVertex({ id: '__nonvacuous', labels: ['Other'], properties: {} });

    const walked = query(g2, q);
    const sort = (rows: unknown[]) => [...rows].map((r) => JSON.stringify(r)).sort();

    return [sort(folded), sort(walked)];
  };

  const CASES: ReadonlyArray<readonly [string, (g: Graph) => void, string]> = [
    [
      'PARALLEL edges into one endpoint',
      (g) => {
        const v = (id: string) => g.verticesById.get(id)!;

        g.addEdge({ id: 'p1', from: v('b'), to: v('c'), labels: ['T'], properties: {} });
        g.addEdge({ id: 'p2', from: v('b'), to: v('c'), labels: ['T'], properties: {} });
      },
      'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'a SELF-LOOP',
      (g) => {
        const v = (id: string) => g.verticesById.get(id)!;

        g.addEdge({ id: 'loop', from: v('a'), to: v('a'), labels: ['T'], properties: {} });
      },
      'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'an UNDIRECTED hop',
      () => undefined,
      'MATCH (s:P)-[:T]-(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    ['an INCOMING hop', () => undefined, 'MATCH (s:P)<-[:T]-(x) RETURN x.grp AS c, min(x.n) AS lo'],
    [
      'a NULL value in a group',
      (g) => {
        g.addVertex({ id: 'nul', labels: ['P'], properties: { grp: 'ga' } });

        const v = (id: string) => g.verticesById.get(id)!;

        g.addEdge({ id: 'en', from: v('b'), to: v('nul'), labels: ['T'], properties: {} });
      },
      'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'a group whose EVERY value is null',
      (g) => {
        g.addVertex({ id: 'n1', labels: ['P'], properties: { grp: 'gnull' } });

        const v = (id: string) => g.verticesById.get(id)!;

        g.addEdge({ id: 'en1', from: v('b'), to: v('n1'), labels: ['T'], properties: {} });
      },
      'MATCH (s:P)-[:T]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'an UNTYPED relationship',
      () => undefined,
      'MATCH (s:P)-[]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'a FAR LABEL on the keyed end',
      (g) => {
        const v = (id: string) => g.verticesById.get(id)!;

        g.addVertex({ id: 'q', labels: ['P', 'Q'], properties: { grp: 'gq', n: 2 } });
        g.addEdge({
          id: 'eq',
          from: v('b'),
          to: g.verticesById.get('q')!,
          labels: ['T'],
          properties: {},
        });
      },
      'MATCH (s:P)-[:T]->(x:Q) RETURN x.grp AS c, min(x.n) AS lo',
    ],
    [
      'a hop matching NOTHING',
      () => undefined,
      'MATCH (s:P)-[:NOPE]->(x) RETURN x.grp AS c, min(x.n) AS lo',
    ],
  ];

  for (const [name, mutate, q] of CASES) {
    test(`${name} agrees with the per-edge walk`, () => {
      const g = build();

      mutate(g);

      const [folded, walked] = bothWalks(g, q);

      expect(folded).toEqual(walked);
    });
  }
});
