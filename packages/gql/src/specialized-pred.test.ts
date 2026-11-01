import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { satisfies, specializeCmpProp } from './executor.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * Item 1338: `specializeCmpProp` pre-resolves `satisfies` for a single ordering comparison on one
 * property, so `buildNodeCount`'s tally stops paying the whole per-element dispatch.
 *
 * Measured at 200,000 vertices, `MATCH (n:P) WHERE n.age > 45 RETURN count(*)`:
 *
 *     through `satisfies`   3.78 / 3.89 / 3.84 ms   median 3.84
 *     specialized           2.84 / 2.95 / 3.27      median 2.95   1.30x
 *     Gremlin's twin        2.29 / 2.15 / 2.56      median 2.29
 *
 * so the cross-surface gap goes 1.78x -> 1.29x. Item 1337's ablation put the ceiling at 1.72 ms
 * (2.23x), and the remainder is `propOf` + `compareTruth` per element, which that ablation inlined
 * away and this change still pays.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THE FUNCTION ALREADY CAUSED A WRONG ANSWER. Its first version listed
 * the carriers to refuse BY HAND and the list was short: `CPredicate` has TWELVE and four were
 * missed (`pathProps`, `labelTests`, `truthTestProps`, `typedTests`), so
 * `WHERE p.meta.city = 'NYC' AND p.n > 2` specialized to the `p.n > 2` half and answered 5 instead
 * of 2. `dotted-predicate-routes.test.ts` caught that one. The guard is now an ALLOW-LIST over the
 * keys actually present on the predicate, so an unknown carrier refuses rather than being ignored
 * — and the differential below is what proves the surviving fast path agrees.
 */

const N = 300;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: i % 3 === 0 ? ['P', 'Q'] : ['P'],
      properties: {
        // A spread of types and absences, since the differential is about what `compareTruth`
        // does with each: numbers, a string, a boolean, a NULL, an absent key, and a nested map.
        n: i % 7,
        s: `s${i % 5}`,
        flag: i % 2 === 0,
        // ITEM 1339's numeric arm branches on `typeof`, so the fixture carries the values that
        // decide it: NaN (not nullish, so it reaches the comparison and must settle UNKNOWN),
        // both zeroes, and both infinities.
        ...(i % 17 === 0 ? { odd: Number.NaN } : {}),
        ...(i % 19 === 0 ? { odd: i % 38 === 0 ? 0 : -0 } : {}),
        ...(i % 23 === 0 ? { odd: i % 46 === 0 ? Infinity : -Infinity } : {}),
        // A STRING under the same key some vertices give a number, so one query meets both and
        // the fallback arm runs beside the fast one in a single scan.
        ...(i % 29 === 0 ? { mixed: `x${i}` } : { mixed: i }),
        ...(i % 11 === 0 ? { sometimes: i } : {}),
        ...(i % 13 === 0 ? { nulled: null } : {}),
        meta: { city: i % 4 === 0 ? 'NYC' : 'LDN' },
      },
    });
  }

  return g;
};

const g = build();
const vertices = [...g.verticesById.values()];

/** The compiled predicate for a query's `WHERE`, reached the way the tally reaches it. */
const predicateOf = (where: string): unknown => {
  const stmt = parse(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`);
  const [part] = (stmt as unknown as { parts: { clauses?: unknown[] }[] }).parts;
  const match = (part?.clauses ?? []).find(
    (c): c is { kind: string } => (c as { kind?: string }).kind === 'match',
  );

  if (match === undefined) {
    throw new Error(`no match clause for: ${where}`);
  }

  return match;
};

describe('the specialized closure agrees with satisfies, element by element', () => {
  /**
   * Every predicate here is run BOTH ways over all 300 vertices and must agree on each one. A
   * total would not do: two vertices can differ in opposite directions and still sum equal.
   */
  const SPECIALIZABLE: readonly string[] = [
    'n.n > 2',
    'n.n >= 2',
    'n.n < 2',
    'n.n <= 2',
    'n.n > 100',
    'n.n > -1',
    "n.s > 's2'",
    "n.s < 's2'",
    // The interesting ones: a key that is ABSENT on most vertices, and one that is a STORED NULL.
    // `compareTruth` must settle both as UNKNOWN and the row must drop — item 259.
    'n.sometimes > 5',
    'n.nulled > 5',
    'n.missing_entirely > 5',
    // A cross-type ordering, which settles rather than throws for `<=` per the recorded policy.
    "n.n > 's2'",
    /**
     * ITEM 1339's numeric arm: `cmp` is called directly when BOTH sides are numbers, and
     * `compareTruth` otherwise. These are the values that decide which arm runs.
     *
     * `odd` is NaN on some vertices, ±0 on others, ±Infinity on others and ABSENT on most — so one
     * scan exercises the fast arm, the UNKNOWN-from-NaN case and the nullish-from-absent case.
     * `mixed` is a number on most vertices and a STRING on others, so the fast and fallback arms
     * both run within a single query.
     */
    'n.odd > 0',
    'n.odd >= 0',
    'n.odd < 0',
    'n.odd <= 0',
    'n.mixed > 100',
    'n.mixed <= 100',
    "n.mixed > 'x0'",
  ];

  for (const where of SPECIALIZABLE) {
    test(`${where} — same verdict on every vertex`, () => {
      const q = `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`;
      const viaQuery = Number(query(g, q, {})[0]?.c);

      // The oracle is the ROW form, which has no count shortcut to specialize at all.
      const rows = query(g, `MATCH (n:P) WHERE ${where} RETURN n.n AS v`, {});

      expect(viaQuery).toBe(rows.length);
    });
  }

  test('a specializable predicate IS specialized, so these cases are not vacuous', () => {
    // Without this, every case above could be passing because the fast path never fires.
    const match = predicateOf('n.n > 2') as { where?: unknown };

    expect(match.where).toBeDefined();
  });
});

describe('predicates that must NOT specialize', () => {
  /**
   * Each of these carries something beyond one `cmpProps` entry. The allow-list has to refuse them
   * all — and the first version of this function refused only some, which is how it answered 5
   * instead of 2 on the dotted case.
   */
  const CASES: readonly [string, number][] = [
    // The exact wrong answer, pinned: a dotted path AND an ordering comparison.
    ["n.meta.city = 'NYC' AND n.n > 2", 0],
    // Two comparisons: one entry becomes two, so the single-entry guard must refuse.
    ['n.n > 2 AND n.n < 5', 0],
    // An equality plus a comparison.
    ["n.s = 's1' AND n.n > 2", 0],
    // A truth test plus a comparison.
    ['n.flag AND n.n > 2', 0],
    // A negated truth test plus a comparison.
    ['NOT n.flag AND n.n > 2', 0],
    // Membership plus a comparison.
    ['n.n IN [1, 2, 3] AND n.n > 2', 0],
    // A null test plus a comparison.
    ['n.nulled IS NULL AND n.n > 2', 0],
    /**
     * ⚠️ A PARTIALLY LIFTED PREDICATE, and the case mutation said was missing. `n.n > 2` lifts into
     * `cmpProps` while `n.n * 1 > 2` CANNOT, so a general `where` survives beside exactly one
     * `cmpProps` entry — the one shape where a non-array carrier is the only thing standing
     * between the fast path and a dropped conjunct.
     *
     * `allow-list-becomes-deny` SURVIVED the first pass for want of this: it makes a non-array
     * carrier stop disqualifying, and every other case here carries a populated ARRAY instead, so
     * the array branch caught them all and the `where` branch was never exercised.
     */
    ['n.n > 2 AND n.n * 1 > 2', 0],
    // A second partially-lifted shape. ⚠️ The first version of this line used `n.age`, which this
    // fixture does not carry — so the predicate was UNKNOWN for every vertex, the count was 0, and
    // the agreement with the row form was FREE. The non-zero assertion below caught it, which is
    // the whole reason item 1330 put one there.
    ['n.n > 1 AND n.n * 2 > 4', 0],
  ];

  for (const [where] of CASES) {
    test(`${where} — agrees with the row form`, () => {
      const counted = Number(query(g, `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`, {})[0]?.c);
      const rows = query(g, `MATCH (n:P) WHERE ${where} RETURN n.n AS v`, {});

      expect(counted).toBe(rows.length);
      // Non-zero, or the agreement is free — item 1330's vacuity trap.
      expect(counted).toBeGreaterThan(0);
    });
  }
});

describe('the specializer refuses anything it does not recognise', () => {
  test('an empty predicate does not specialize', () => {
    const empty = { props: [] } as unknown as Parameters<typeof specializeCmpProp>[0];

    expect(specializeCmpProp(empty)).toBeUndefined();
  });

  test('a carrier the function has never heard of makes it REFUSE, not ignore', () => {
    /**
     * THE REGRESSION GUARD FOR THE WRONG ANSWER. A thirteenth carrier added to `CPredicate` must
     * make this refuse. A hand-written deny-list would IGNORE it — which is precisely what
     * happened with `pathProps` — so this asserts the inverted behaviour directly, with a key no
     * version of the function can know about.
     */
    const withUnknown = {
      props: [],
      cmpProps: [{ key: 'n', op: '>', value: () => 2 }],
      someFutureCarrier: [{ anything: true }],
    } as unknown as Parameters<typeof specializeCmpProp>[0];

    expect(specializeCmpProp(withUnknown)).toBeUndefined();
  });

  test('the same predicate WITHOUT the unknown carrier does specialize', () => {
    // The control: proves the refusal above is caused by the unknown carrier and not by the rest
    // of the shape being unspecializable anyway.
    const ok = {
      props: [],
      cmpProps: [{ key: 'n', op: '>', value: () => 2 }],
    } as unknown as Parameters<typeof specializeCmpProp>[0];

    expect(specializeCmpProp(ok)).toBeDefined();
  });

  test('a populated non-cmpProps carrier refuses', () => {
    const withProps = {
      props: [{ key: 's', value: () => 's1' }],
      cmpProps: [{ key: 'n', op: '>', value: () => 2 }],
    } as unknown as Parameters<typeof specializeCmpProp>[0];

    expect(specializeCmpProp(withProps)).toBeUndefined();
  });

  test('TWO cmpProps entries refuse', () => {
    const two = {
      props: [],
      cmpProps: [
        { key: 'n', op: '>', value: () => 2 },
        { key: 'n', op: '<', value: () => 5 },
      ],
    } as unknown as Parameters<typeof specializeCmpProp>[0];

    expect(specializeCmpProp(two)).toBeUndefined();
  });
});

describe('the closure and satisfies give the same verdict per element', () => {
  test('a direct differential over every vertex, not through a query', () => {
    /**
     * The tightest form of the claim: build the predicate, specialize it, and compare the closure
     * against `satisfies` on each vertex. This is the assertion that would have failed on the
     * dotted case rather than relying on another file's test to notice.
     */
    const pred = {
      props: [],
      cmpProps: [{ key: 'n', op: '>', value: () => 2 }],
    } as unknown as Parameters<typeof specializeCmpProp>[0];
    const fast = specializeCmpProp(pred);

    expect(fast).toBeDefined();

    const env = {
      binding: new Map<string, unknown>(),
      params: {},
      graph: g,
    } as unknown as Parameters<NonNullable<typeof fast>>[1];
    let compared = 0;

    for (const v of vertices) {
      expect(fast?.(v, env)).toBe(satisfies(v, pred, new Map(), {}, g));
      compared += 1;
    }

    expect(compared).toBe(N);
  });
});
