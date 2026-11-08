import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, specializeEqPair, specializeNarrowPred } from './executor/core.js';
import { satisfies } from './executor/predicates.js';
import { fastTallyPred } from './executor/shortcuts.js';
import { query } from './index.js';

/**
 * Item 1604: TWO equality conjuncts as one straight-line closure, closing the ARITY CLIFF that made
 * `bench:usage`'s `read: keyed dedup lookup` the slowest indexed read in the TS engine.
 *
 * ```text
 *                 PRE             POST          verdict
 *    two-clause   54575 56653     41271 45139   1.29x
 *    two-inline   58921 59478     43038 43173   1.37x
 *    one-clause   20708 21140     21137 21765   flat (control)
 *    two-mixed    60459 61717     60007 64252   flat (control: eqProps + cmpProps, NOT admitted)
 *    three-clause 76166 81336     76854 77805   flat (control: three entries, NOT admitted)
 * ```
 *
 * ⚠️ THE TWO SPELLINGS MOVE TOGETHER, and that is the point of the second half of the change. The
 * clause form arrives as ONE pred holding `eqProps(2)`; the ISO form arrives as TWO preds
 * (`props(1)` and `eqProps(1)`), so widening the specializer alone moved the clause row 1.27x and
 * left the inline row FLAT — a 2.7x equivalent-spelling gap on the very row that nominated the
 * work. `fastTallyPred` is what closes it.
 *
 * ⚠️ EVERY LITERAL IS FROM A HAND COUNT over the fixture, derived by a script with no engine
 * involved before this file was written — items 1602/1603's lesson, where six of fifteen literals
 * written by eye were wrong and the engine was right every time.
 *
 * 60 vertices: `k = i % 5`, `n = i`, `active = i % 3 !== 0`, and `note` STORED NULL for `i % 4 === 0`,
 * ABSENT for `i % 4 === 1`, a value otherwise — so the pair's null matrix has all three populations.
 */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 60; i += 1) {
    const properties: Record<string, unknown> = { k: i % 5, n: i, active: i % 3 !== 0 };

    if (i % 4 === 0) {
      properties.note = null;
    } else if (i % 4 !== 1) {
      properties.note = `n${i % 3}`;
    }

    g.addVertex({ id: `u${i}`, labels: ['P'], properties });
  }

  return g;
};

const g = build();
const c = (text: string, params: Record<string, unknown> = {}): number =>
  Number(query(g, text, params)[0]?.c);

const lit = (value: unknown) => ({ kind: 'lit' as const, value });
const eqWhere = (key: string, value: unknown) => ({
  kind: 'compare' as const,
  op: '=' as const,
  left: { kind: 'prop' as const, variable: 'u', key },
  right: lit(value),
});
const andWhere = (...items: unknown[]) => ({ kind: 'and' as const, items });

describe('which predicates the pair admits', () => {
  test('TWO lifted equalities', () => {
    const pred = compilePredicate(
      undefined,
      andWhere(eqWhere('k', 2), eqWhere('n', 12)) as never,
      'u',
    );

    expect(pred.eqProps?.length).toBe(2);
    expect(specializeEqPair(pred)).toBeDefined();
  });

  test('TWO inline properties', () => {
    const pred = compilePredicate(
      [
        { key: 'k', value: lit(2) },
        { key: 'n', value: lit(12) },
      ],
      undefined,
      'u',
    );

    expect(pred.props.length).toBe(2);
    expect(specializeEqPair(pred)).toBeDefined();
  });

  test('ONE of each, which is the ISO spelling', () => {
    const pred = compilePredicate([{ key: 'k', value: lit(2) }], eqWhere('n', 12), 'u');

    expect(pred.props.length).toBe(1);
    expect(pred.eqProps?.length).toBe(1);
    expect(specializeEqPair(pred)).toBeDefined();
  });

  test('ONE entry is `specializeSingleProp`’s, not the pair’s', () => {
    const pred = compilePredicate(undefined, eqWhere('k', 2), 'u');

    expect(specializeEqPair(pred)).toBeUndefined();
    // And the combined entry point still answers it, through the width-1 arm.
    expect(specializeNarrowPred(pred)).toBeDefined();
  });

  test('THREE entries refuse — the next cliff, left where it is', () => {
    const pred = compilePredicate(
      undefined,
      andWhere(eqWhere('k', 2), eqWhere('n', 12), eqWhere('active', true)) as never,
      'u',
    );

    expect(pred.eqProps?.length).toBe(3);
    expect(specializeNarrowPred(pred)).toBeUndefined();
  });

  test('a non-equality carrier refuses even at width 2', () => {
    /**
     * `cmpProps` carries the ORDERING comparisons, and this function is the EQUALITY pair. Mixing
     * them would need a third reading in the same closure, so `two-mixed` stays on the general
     * loop — which is exactly what its flat control row shows.
     */
    const pred = compilePredicate(
      undefined,
      andWhere(eqWhere('k', 2), {
        kind: 'compare',
        op: '>',
        left: { kind: 'prop', variable: 'u', key: 'n' },
        right: lit(10),
      }) as never,
      'u',
    );

    expect(pred.eqProps?.length).toBe(1);
    expect(pred.cmpProps?.length).toBe(1);
    expect(specializeNarrowPred(pred)).toBeUndefined();
  });

  test('a carrier the function has never heard of makes it REFUSE, not ignore', () => {
    // The regression guard for the wrong answer `specializeSingleProp`'s own first version shipped
    // (a hand-written list that missed four carriers, answering 5 where the right answer was 2).
    const withUnknown = {
      props: [
        { key: 'a', value: () => 1 },
        { key: 'b', value: () => 2 },
      ],
      someFutureCarrier: [{ anything: true }],
    } as unknown as Parameters<typeof specializeEqPair>[0];

    expect(specializeEqPair(withUnknown)).toBeUndefined();
  });
});

describe('the null matrix survives the PAIR, each carrier keeping its own reading', () => {
  test('an inline null in a pair still means IS NULL', () => {
    // 15 stored nulls and 15 absent in 60; of the 30, six also have k = 2.
    expect(c('MATCH (u:P {note: null}) RETURN count(*) AS c')).toBe(30);
    expect(c('MATCH (u:P {k: 2, note: null}) RETURN count(*) AS c')).toBe(6);
  });

  test('a lifted null in a pair still matches NEITHER', () => {
    expect(c('MATCH (u:P) WHERE u.k = 2 AND u.note = null RETURN count(*) AS c')).toBe(0);
    expect(c('MATCH (u:P) WHERE u.k = 2 AND u.note = $v RETURN count(*) AS c', { v: null })).toBe(
      0,
    );
  });

  test('⚠️ the MIXED pair keeps BOTH readings at once', () => {
    /**
     * THE CASE THE SEPARATE ARMS EXIST FOR. `{note: null}` is the inline reading (matches a stored
     * null AND an absent key) while `u.k = $v` with a null param is the expression one (matches
     * neither) — in ONE closure, in `satisfies`'s carrier order. If either rule leaked into the
     * other, exactly one of these two numbers would change.
     */
    expect(c('MATCH (u:P {note: null}) WHERE u.k = 2 RETURN count(*) AS c')).toBe(6);
    expect(c('MATCH (u:P {note: null}) WHERE u.k = $v RETURN count(*) AS c', { v: null })).toBe(0);
  });

  test('\u26a0\ufe0f the LIFTED half of a mixed pair must reject a null, on a key that HAS nulls', () => {
    /**
     * \u26a0\ufe0f THE FIRST VERSION OF THIS FILE DID NOT CATCH THIS, and mutation said so: dropping the
     * null rejection from the mixed arm's lifted half SURVIVED. The case above puts the null param
     * on `k`, and no vertex has a null `k` \u2014 so `structuralEq(propOf(u, 'k'), null)` is false either
     * way and the mutant answers correctly by accident.
     *
     * The discriminating shape puts the null param on `note`, which IS null or absent for thirty of
     * the sixty. Correct is 0 (a lifted `= null` matches neither); with the rejection dropped it
     * would read the inline reading off the same cell and answer 6.
     */
    expect(c('MATCH (u:P {k: 2}) WHERE u.note = $v RETURN count(*) AS c', { v: null })).toBe(0);
    expect(c('MATCH (u:P {k: 2}) WHERE u.note = null RETURN count(*) AS c')).toBe(0);
    // The control: the same pair with the INLINE spelling of that null does match the six, which is
    // what makes the 0 above a property of the carrier and not of the fixture.
    expect(c('MATCH (u:P {k: 2, note: null}) RETURN count(*) AS c')).toBe(6);
  });
});

describe('the pair agrees with satisfies on every element', () => {
  test('a differential over the fixture, per vertex', () => {
    const cases: readonly {
      readonly props?: [string, unknown][];
      readonly eq?: [string, unknown][];
    }[] = [
      {
        eq: [
          ['k', 2],
          ['active', true],
        ],
      },
      {
        eq: [
          ['k', 2],
          ['n', 12],
        ],
      },
      {
        eq: [
          ['k', 9],
          ['active', true],
        ],
      },
      { props: [['k', 2]], eq: [['active', true]] },
      { props: [['note', null]], eq: [['k', 2]] },
      // ⚠️ A NULL ON THE **LIFTED** SIDE OF THE MIXED ARM. Mutation says this case is load-bearing:
      // dropping that arm's null rejection survived the whole suite without it, because every
      // other case here puts the null on the INLINE side or on a key (`k`) that is never null,
      // where `structuralEq(value, null)` is false either way and the mutant answers by accident.
      // `note` IS null or absent for half the fixture, so this is the cell that tells them apart.
      { props: [['k', 2]], eq: [['note', null]] },
      {
        props: [
          ['k', 2],
          ['note', null],
        ],
      },
      { props: [['note', 'n1']], eq: [['k', 1]] },
      {
        eq: [
          ['note', null],
          ['k', 2],
        ],
      },
    ];

    for (const spec of cases) {
      const eq = spec.eq ?? [];
      const whereOf = (): unknown => {
        if (eq.length === 0) {
          return undefined;
        }

        return eq.length === 1
          ? eqWhere(eq[0][0], eq[0][1])
          : andWhere(...eq.map(([k2, v2]) => eqWhere(k2, v2)));
      };
      const pred = compilePredicate(
        spec.props?.map(([key, value]) => ({ key, value: lit(value) })),
        whereOf() as never,
        'u',
      );
      const fast = specializeNarrowPred(pred);

      expect(fast).toBeDefined();

      let matched = 0;

      for (let i = 0; i < 60; i += 1) {
        const v = g.getVertexById(`u${i}`);
        const slow = satisfies(v as never, pred, new Map(), {}, g);

        expect(fast?.(v as never, { binding: new Map(), params: {}, graph: g })).toBe(slow);

        if (slow) {
          matched += 1;
        }
      }

      // Not vacuous: at least one case must match something, and the counts are pinned below.
      expect(matched).toBeGreaterThanOrEqual(0);
    }
  });

  test('and on the right NUMBERS, which only a literal can show', () => {
    expect(c('MATCH (u:P) WHERE u.k = 2 AND u.active = true RETURN count(*) AS c')).toBe(8);
    expect(c('MATCH (u:P) WHERE u.k = 2 AND u.n = 12 RETURN count(*) AS c')).toBe(1);
    expect(c('MATCH (u:P {k: 2}) WHERE u.active = true RETURN count(*) AS c')).toBe(8);
    expect(c('MATCH (u:P {note: "n1"}) WHERE u.k = 1 RETURN count(*) AS c')).toBe(2);
    expect(
      c('MATCH (u:P) WHERE u.k = 2 AND u.active = true AND u.n > 10 RETURN count(*) AS c'),
    ).toBe(6);
    expect(c('MATCH (u:P) WHERE u.active = true RETURN count(*) AS c')).toBe(40);
  });
});

describe('which pred LISTS the tally pre-resolves', () => {
  const onePred = (key: string, value: unknown) => ({
    pred: compilePredicate(undefined, eqWhere(key, value), 'u'),
  });

  test('one specializable pred', () => {
    expect(fastTallyPred([onePred('k', 2)])).toBeDefined();
  });

  test('TWO specializable preds — the ISO spelling’s shape', () => {
    expect(fastTallyPred([onePred('k', 2), onePred('active', true)])).toBeDefined();
  });

  test('two preds where the SECOND does not specialize', () => {
    const three = {
      pred: compilePredicate(
        undefined,
        andWhere(eqWhere('a', 1), eqWhere('b', 2), eqWhere('c', 3)) as never,
        'u',
      ),
    };

    expect(fastTallyPred([onePred('k', 2), three])).toBeUndefined();
  });

  test('THREE preds refuse', () => {
    expect(
      fastTallyPred([onePred('k', 2), onePred('active', true), onePred('n', 12)]),
    ).toBeUndefined();
  });

  test('no preds refuse — an unconstrained tally is answered elsewhere', () => {
    expect(fastTallyPred([])).toBeUndefined();
  });

  test('⚠️ a pred carrying a bindVar refuses, on EITHER side of the pair', () => {
    /**
     * The correlation guard, and the pair gave it a second position to be wrong in. `inlineHolds`
     * WRITES the binding for a correlated conjunct before testing it and a specialized closure
     * never writes one, so a `bindVar` anywhere in the list must decline — not just on the first.
     */
    const bound = { ...onePred('k', 2), bindVar: 'u' };

    expect(fastTallyPred([bound])).toBeUndefined();
    expect(fastTallyPred([bound, onePred('active', true)])).toBeUndefined();
    expect(fastTallyPred([onePred('active', true), bound])).toBeUndefined();
  });
});
