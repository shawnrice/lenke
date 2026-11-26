// `applyProjection`'s ORDER BY overlay, gated on `orderNeedsOutput` (item 2017).
//
// **THIS IS NOT A ROUTE CHOICE — A WRONG GATE HERE IS A WRONG ANSWER.** `applyProjection`
// evaluates every sort key against a binding, and before item 2017 that binding was always the
// projected output overlaid on the input:
//
//     const sortBinding = orderBy.length > 0 ? new Map([...b, ...projected]) : b;
//
// Built per row, it was the profile's top frame at 18.2% self with 12.9% GC behind it. It is now
// built only when `proj.orderNeedsOutput` says a key actually reads an output column. If that flag
// is ever wrong — or if the gate reads it the wrong way round — a sort key silently resolves to
// `undefined` and the rows come back in the wrong order, which no row COUNT and no multiset
// comparison can see.
//
// THE TWO DIRECTIONS THE FIXTURE MUST SEPARATE:
//
//     orderNeedsOutput = FALSE   the key was rewritten through `aliasDefinition` and reads the
//                                INPUT binding (`RETURN b.n AS x … ORDER BY x` compiles to `b.n`)
//     orderNeedsOutput = TRUE    the key reads a column with no input twin — an AGGREGATE alias,
//                                or `RETURN *`, where every in-scope variable is an output column
//
// AND THE ORDER IS ASSERTED, NOT THE MULTISET. Every expectation below is a full ordered array:
// an overlay bug reorders rows without changing which rows come back.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * THE `n` VALUES ARE DELIBERATELY NOT IN ID ORDER, so a sort that silently did nothing (every
   * key resolving to `undefined` compares equal, leaving arrival order) is distinguishable from a
   * sort that worked. With ids ascending and `n` ascending the two are the same array.
   */
  for (const [id, n, s] of [
    ['v1', 50, 'e'],
    ['v2', 10, 'c'],
    ['v3', 40, 'a'],
    ['v4', 20, 'd'],
    ['v5', 30, 'b'],
  ] as const) {
    g.addVertex({ id, labels: ['T'], properties: { n, s } });
  }

  let seq = 0;
  const E = (fr: string, to: string, w: number): void => {
    seq += 1;

    g.addEdge({
      id: `e${seq}`,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(to)!,
      labels: ['E'],
      properties: { w },
    });
  };

  E('v1', 'v2', 3);
  E('v2', 'v3', 1);
  E('v3', 'v4', 2);
  E('v4', 'v5', 5);
  E('v5', 'v1', 4);

  return g;
};

const rows = (g: Graph, q: string): unknown[] => [...query(g, q)];
const col = (g: Graph, q: string, k: string): unknown[] =>
  rows(g, q).map((r) => (r as Record<string, unknown>)[k]);

describe('the overlay is NOT built: keys rewritten to the input binding', () => {
  const g = build();

  test('a plain alias sort key — the shape item 2017 nominated', () => {
    // `RETURN b.n AS x … ORDER BY x` compiles to a key reading `b.n`, so the overlay is skipped.
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x', 'x')).toEqual([10, 20, 30, 40, 50]);
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x DESC', 'x')).toEqual([
      50, 40, 30, 20, 10,
    ]);
  });

  test('TWO keys, which is the cross-product shape the profile came from', () => {
    const got = rows(g, 'MATCH (a:T)-[e:E]->(b:T) RETURN a.n AS x, e.w AS y ORDER BY x, y');

    expect(got.map((r) => (r as { x: number }).x)).toEqual([10, 20, 30, 40, 50]);
  });

  test('a key on a variable that is NOT projected at all', () => {
    // `ORDER BY a.s` names no output column, so the overlay was never needed here either — and
    // this is the case the gate must not confuse with "the key is missing".
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY a.s', 'x')).toEqual([40, 30, 10, 20, 50]);
  });

  test('an EXPRESSION over an alias — item 1929 made this resolve INSIDE the expression', () => {
    /*
     * VERIFIED, NOT ASSUMED: `orderNeedsOutput` is FALSE for these. Item 1929's alias resolution
     * reaches inside an expression, so `ORDER BY x + 1` compiles to `a.n + 1` and reads the input
     * binding. (I first filed this under "the overlay IS built" by guessing; the flag says
     * otherwise. The spelling that DOES need the overlay is the SHADOWING one below.)
     */
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x + 1', 'x')).toEqual([10, 20, 30, 40, 50]);
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY -x', 'x')).toEqual([50, 40, 30, 20, 10]);
  });

  test('with SKIP / LIMIT, which take the top-k path that already trusted this flag', () => {
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x LIMIT 2', 'x')).toEqual([10, 20]);
    expect(col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x OFFSET 3', 'x')).toEqual([40, 50]);
  });

  test('with DISTINCT, which is excluded from the top-k path but not from this gate', () => {
    expect(col(g, 'MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x ORDER BY x', 'x')).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });
});

describe('the overlay IS built: keys with no input twin', () => {
  const g = build();

  test('an AGGREGATE alias — the aggregating branch', () => {
    /*
     * `count(*)` HAS NO INPUT VARIABLE TO READ, so `aliasDefinition` cannot rewrite `ORDER BY c`
     * into anything the input binding holds. `orderNeedsOutput` is TRUE and the overlay is what
     * makes the key resolve at all. A gate inverted here returns groups in arrival order.
     */
    const got = rows(
      g,
      'MATCH (a:T)-[:E]->(b:T) LET k = b.n RETURN k, count(*) AS c GROUP BY k ORDER BY c, k',
    );

    expect(got).toHaveLength(5);
    expect(got.map((r) => (r as { c: number }).c)).toEqual([1, 1, 1, 1, 1]);
    expect(got.map((r) => (r as { k: number }).k)).toEqual([10, 20, 30, 40, 50]);
  });

  test('an aggregate alias with groups of DIFFERENT sizes, so the order is observable', () => {
    /*
     * THE TEST ABOVE CANNOT FAIL ON ORDER — every group has count 1, so any permutation of the
     * `c` column is `[1,1,1,1,1]`. This one groups on a key with unequal group sizes, so sorting by
     * the aggregate alias produces a sequence only a working overlay can produce.
     */
    const got = rows(
      g,
      'MATCH (a:T) LET k = a.n % 20 RETURN k, count(*) AS c GROUP BY k ORDER BY c DESC, k',
    );

    expect(got.map((r) => (r as { c: number }).c)).toEqual([3, 2]);
    expect(got.map((r) => (r as { k: number }).k)).toEqual([10, 0]);
  });

  test('A SHADOWING ALIAS INSIDE AN EXPRESSION — the only case that pins the overlay DIRECTION', () => {
    /*
     * **THIS IS THE DISCRIMINATING CASE AND A MUTATION ROUND IS HOW IT WAS FOUND.** The overlay
     * spreads `projected` AFTER `b`, so an output alias SHADOWS an input variable of the same name
     * — `CProjection.orderNeedsOutput`'s doc states the rule ("output slots come first in the ORDER
     * BY scope"). Reversing that spread must be a wrong answer, and almost nothing can see it:
     *
     *   - `RETURN a.n AS a ORDER BY a`  — the BARE key is rewritten to `a.n` by `aliasDefinition`,
     *     so it reads the input vertex either way. Direction UNOBSERVABLE. (It was my only
     *     shadowing case, and the reversed-overlay mutant SURVIVED this whole file because of it.)
     *   - `RETURN * ORDER BY a.n`       — with star, `projected` carries the same entries as `b`,
     *     so the two halves AGREE. Direction unobservable again.
     *
     * Wrapping the shadowed name in arithmetic is what separates them: `a + 2` is NOT rewritten, so
     * the key reads the name `a` out of the overlay. Correct, `projected` wins and `a` is the
     * NUMBER. Reversed, `b` wins and `a` is the VERTEX — which RAISES, so the assertion is an
     * ordering AND a non-raise.
     */
    expect(col(g, 'MATCH (a:T) RETURN a.n AS a ORDER BY a + 2', 'a')).toEqual([10, 20, 30, 40, 50]);
    // The bare and string forms, kept as the controls that CANNOT see the direction.
    expect(col(g, 'MATCH (a:T) RETURN a.n AS a ORDER BY a', 'a')).toEqual([10, 20, 30, 40, 50]);
    expect(col(g, 'MATCH (a:T) RETURN a.s AS a ORDER BY a', 'a')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('A SHADOWING AGGREGATE ALIAS inside an expression — the aggregating branch’s twin', () => {
    /*
     * **NOTHING IN THE ENGINE CAUGHT A REVERSED OVERLAY IN THE AGGREGATING BRANCH** — item
     * 2017's `agg-overlay-reversed` mutant survived both this file AND the whole @lenke/gql suite.
     * That is a hole independent of item 2017's change: the branch has had the same overlay since
     * it was written. Same mechanism as the non-aggregating twin above — the alias `a` shadows the
     * input variable `a`, and wrapping it in arithmetic keeps the key reading the overlay, where
     * reversing the spread hands it the group's REPRESENTATIVE VERTEX and it raises.
     */
    const got = rows(
      g,
      'MATCH (a:T) LET k = a.n % 20 RETURN k, count(*) AS a GROUP BY k ORDER BY a + 2',
    );

    expect(got.map((r) => (r as { a: number }).a)).toEqual([2, 3]);
    expect(got.map((r) => (r as { k: number }).k)).toEqual([0, 10]);
  });

  test('MIXED SOURCES in one sort: key 1 needs the output, key 2 needs the INPUT', () => {
    /*
     * **THE OVERLAY MUST CARRY BOTH HALVES, AND ONLY A MIXED-SOURCE SORT CAN SEE IT.** A mutant
     * dropping `b` from the overlay (`new Map([...projected])`) survived this whole file and was
     * caught only by a CALL test elsewhere in the suite, whose shape is exactly this: one key that
     * `aliasDefinition` rewrote into an INPUT read, in a projection whose `orderNeedsOutput` is TRUE
     * because a DIFFERENT key keeps an output name.
     *
     * Here `a + 2` keeps the shadowed output name `a` (arithmetic is not rewritten), which sets the
     * flag; `t` is rewritten to `a.s` and reads the input vertex. Drop `b` and `a.s` resolves to
     * null for every row — the second key stops discriminating and the tie order shows through.
     */
    /*
     * AND THE SECOND KEY MUST READ A VARIABLE THAT IS NOT ITSELF AN OUTPUT COLUMN. My first
     * attempt was `RETURN a.n % 20 AS a, a.s AS t ORDER BY a + 2, t`, where `t` resolves through
     * `projected.t` — so BOTH keys live in the projected half and dropping `b` was still invisible.
     * `b.s` below reads the input variable `b`, which the projection never emits, so it exists ONLY
     * in the `b` half of the overlay.
     */
    const got = rows(
      g,
      'MATCH (a:T)-[:E]->(b:T) RETURN a.n % 20 AS a, b.n AS y ORDER BY a + 2, b.s',
    );

    expect(got.map((r) => (r as { a: number }).a)).toEqual([0, 0, 10, 10, 10]);
    // Within each `a` group the rows are ordered by the far vertex's `s`, which only the input half
    // of the overlay can supply. Drop it and the second key is null for every row.
    expect(got.map((r) => (r as { y: number }).y)).toEqual([30, 20, 40, 10, 50]);
  });

  test('`RETURN *`, where every in-scope variable IS an output column', () => {
    const got = rows(g, 'MATCH (a:T) RETURN * ORDER BY a.n');

    expect(got).toHaveLength(5);
    expect(got.map((r) => (r as { a: { id: string } }).a.id)).toEqual([
      'v2',
      'v4',
      'v5',
      'v3',
      'v1',
    ]);
  });

  test('a sum alias, whose value exists only after aggregation', () => {
    const got = rows(
      g,
      'MATCH (a:T)-[e:E]->(b:T) LET k = a.n % 20 RETURN k, sum(e.w) AS s GROUP BY k ORDER BY s',
    );

    // k=0 is v3(w 2) + v4(w 5) = 7; k=10 is v1(3) + v2(1) + v5(4) = 8. Ascending by `s` puts the
    // SMALLER sum first, which is the opposite of the group arrival order (k=10 is seen first), so
    // this sequence is one only a resolving sort key can produce.
    expect(got.map((r) => (r as { s: number }).s)).toEqual([7, 8]);
    expect(got.map((r) => (r as { k: number }).k)).toEqual([0, 10]);
  });
});

describe('the two arms agree with a spelling that cannot take the gate', () => {
  const g = build();

  test('the aliased and unaliased spellings of one sort return the SAME order', () => {
    /*
     * EQUIVALENT SPELLINGS MUST COST THE SAME AND ANSWER THE SAME — the repo's named defect
     * class. `ORDER BY x` (alias, gate SKIPS the overlay) and `ORDER BY a.n` (direct, gate also
     * skips) must agree; so must `RETURN *` (gate BUILDS the overlay) ordered on the same value.
     */
    const viaAlias = col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY x', 'x');
    const viaDirect = col(g, 'MATCH (a:T) RETURN a.n AS x ORDER BY a.n', 'x');
    const viaStar = rows(g, 'MATCH (a:T) RETURN * ORDER BY a.n').map(
      (r) => (r as { a: { properties: Record<string, unknown> } }).a.properties.n,
    );

    expect(viaDirect).toEqual(viaAlias);
    expect(viaStar).toEqual(viaAlias);
  });
});

describe('the gate’s INPUT, which is the only mechanical guard on the win', () => {
  /*
   * **THE `always` MUTANT IS UNCATCHABLE BY ANY ANSWER TEST, AND THAT IS NOT A HOLE** — building
   * the overlay unconditionally IS the pre-item-2017 behaviour, so it is answer-equivalent by
   * construction and the A/B measurement is the only evidence against it. Item 2017's mutation round
   * confirms it: `plain-overlay-always` survives both this file and the whole @lenke/gql suite, where
   * the other nine mutants are caught. `count-shortcut.ts` records the same situation for its own
   * `seenBefore` gate.
   *
   * What CAN be guarded is the gate's INPUT ([[perf-gate-needs-its-own-test]] — extract the decision
   * and test it directly). If `orderNeedsOutput` ever starts reading TRUE for a plain aliased sort,
   * every such query silently goes back to paying the per-row `Map` and nothing else notices: the
   * answers stay right and only the screen moves. These assertions make that loud.
   */
  const flagFor = (q: string): boolean => {
    const seen = new Set<object>();
    let linear: { clauses: unknown[] } | undefined;
    const find = (o: unknown): void => {
      if (linear !== undefined || o === null || typeof o !== 'object' || seen.has(o)) {
        return;
      }

      seen.add(o);

      if (Array.isArray((o as { clauses?: unknown }).clauses)) {
        linear = o as { clauses: unknown[] };

        return;
      }

      for (const v of Object.values(o)) {
        find(v);
      }
    };

    find(parse(q));

    const projections = compileLinear(linear as never)
      .clauses.map((c) => (c as { projection?: { orderNeedsOutput: boolean } }).projection)
      .filter((x): x is { orderNeedsOutput: boolean } => x !== undefined);

    return projections[0].orderNeedsOutput;
  };

  test('FALSE for the shapes the gate exists to speed up', () => {
    // Each of these compiles its sort key down to an INPUT read, so the overlay is dead work.
    expect(flagFor('MATCH (a:T) RETURN a.n AS x ORDER BY x')).toBe(false);
    expect(flagFor('MATCH (a:T) RETURN a.n AS x ORDER BY x + 1')).toBe(false);
    expect(flagFor('MATCH (a:T) RETURN a.n AS x ORDER BY a.n')).toBe(false);
    expect(flagFor('MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x ORDER BY x')).toBe(false);
    // The shape item 2017 nominated: the GQL surface's largest, a two-key sort over a cross product.
    expect(
      flagFor('MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN b.n AS x, d.n AS y ORDER BY x, y'),
    ).toBe(false);
  });

  test('TRUE where the overlay is load-bearing', () => {
    expect(flagFor('MATCH (a:T) RETURN * ORDER BY a.n')).toBe(true);
    expect(flagFor('MATCH (a:T) RETURN a.n AS a ORDER BY a + 2')).toBe(true);
    expect(flagFor('MATCH (a:T) LET k = a.n RETURN k, count(*) AS c GROUP BY k ORDER BY c')).toBe(
      true,
    );
  });
});
