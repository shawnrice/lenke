import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate } from './executor.js';
import { indexCandidates } from './executor/matching.js';
import { seedIsExact, soleEqualityKey } from './executor/shortcuts.js';
import { query } from './index.js';

/**
 * Item 1607: when a seek's equality is EVERYTHING the predicate asserts, the seeded set IS the
 * matching set, so the tally stops re-validating every candidate. **1.88x** on the 400-hit seeded
 * count (12363-13279 ns -> 6655-7017) and **1.49x** at 1000 candidates, landing on the ablation
 * that priced it (6324-6354).
 *
 * ⚠️ THIS IS A CORRECTNESS GATE, NOT A ROUTE CHOICE, which makes it the opposite of items
 * 1600/1601/1604: if `soleEqualityKey` is wrong the tally counts rows that do not match, so the
 * differential tests DO see it. The risk item 149 names is the one to pin hardest — the index
 * returns vertices by VALUE across all labels, so the label test must still run.
 *
 * ⚠️ THE FIXTURE SHARES `team` VALUES ACROSS LABELS ON PURPOSE. A value bucket for `t1` therefore
 * holds `User`s, `Admin`s and both-labelled vertices, and a seed that skipped the label test would
 * over-count. A fixture where every vertex has the same label — which is what most of this repo's
 * probes use — cannot see that at all.
 *
 * ```text
 *   60 vertices: team = t<i % 5>, n = i, flag only when i % 7 === 0
 *   labels: i % 3 === 0 -> [Admin], i % 3 === 1 -> [User], else [User, Admin]
 * ```
 *
 * Hand-counted for `team = 't1'` (i in 1, 6, 11, …, 56 — twelve vertices): eight are `User`,
 * eight are `Admin`, four are both.
 */
/** Labels by index, so each `team` value spans several labels — see the block comment. */
const labelsFor = (i: number): string[] => {
  if (i % 3 === 0) {
    return ['Admin'];
  }

  return i % 3 === 1 ? ['User'] : ['User', 'Admin'];
};

const build = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 60; i += 1) {
    const labels = labelsFor(i);
    const properties: Record<string, unknown> = { team: `t${i % 5}`, n: i };

    if (i % 7 === 0) {
      properties.flag = true;
    }

    g.addVertex({ id: `u${i}`, labels, properties });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  }

  return g;
};

const plain = build(false);
const indexed = build(true);

describe('an exact seed still answers what the scan answers', () => {
  const SHAPES: readonly [string, string, Record<string, unknown>][] = [
    ['labelled clause', 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['labelled inline', 'MATCH (u:User {team: $v}) RETURN count(*) AS c', { v: 't1' }],
    ['the OTHER label', 'MATCH (u:Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['no label at all', 'MATCH (u) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    [
      'a label DISJUNCTION',
      'MATCH (u:User|Admin) WHERE u.team = $v RETURN count(*) AS c',
      { v: 't1' },
    ],
    [
      'a label CONJUNCTION',
      'MATCH (u:User&Admin) WHERE u.team = $v RETURN count(*) AS c',
      { v: 't1' },
    ],
    ['a label NEGATION', 'MATCH (u:!Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    [
      'two conjuncts — NOT exact',
      'MATCH (u:User) WHERE u.team = $v AND u.flag = true RETURN count(*) AS c',
      { v: 't1' },
    ],
    ['a literal', "MATCH (u:User) WHERE u.team = 't1' RETURN count(*) AS c", {}],
    ['an inline literal', "MATCH (u:User {team: 't1'}) RETURN count(*) AS c", {}],
    ['a UNIQUE numeric key', 'MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 4 }],
    ['a value nothing has', 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 'nope' }],
    ['the ROWS spelling', 'MATCH (u:User) WHERE u.team = $v RETURN u.n AS n', { v: 't1' }],
    ['an ORDERING, never exact', 'MATCH (u:User) WHERE u.n > 30 RETURN count(*) AS c', {}],
    ['IN, never exact', 'MATCH (u:User) WHERE u.team IN [$v] RETURN count(*) AS c', { v: 't1' }],
    ['IS NULL, never exact', 'MATCH (u:User) WHERE u.flag IS NULL RETURN count(*) AS c', {}],
  ];

  for (const [name, text, params] of SHAPES) {
    test(name, () => {
      expect(JSON.stringify(query(indexed, text, params))).toBe(
        JSON.stringify(query(plain, text, params)),
      );
    });
  }

  test('⚠️ and on the hand-counted NUMBERS — the label test is what these pin', () => {
    /**
     * Agreement alone cannot show this: if the skip dropped the label test, BOTH columns would be
     * wrong only in the indexed one — but a reader cannot tell a shared bug from a shared truth, and
     * items 1581/1596 both shipped a comparison that passed while both sides were wrong.
     *
     * Twelve vertices carry `team = 't1'`; eight are `User`, eight are `Admin`, four are both. If
     * an exact seed skipped the label test, the labelled counts would read 12.
     */
    const c = (g: Graph, text: string, params: Record<string, unknown> = {}): number =>
      Number(query(g, text, params)[0]?.c);

    for (const g of [plain, indexed]) {
      expect(c(g, 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' })).toBe(8);
      expect(c(g, 'MATCH (u:Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' })).toBe(8);
      expect(c(g, 'MATCH (u:User&Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' })).toBe(
        4,
      );
      expect(c(g, 'MATCH (u) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' })).toBe(12);
      expect(c(g, 'MATCH (u:User {team: $v}) RETURN count(*) AS c', { v: 't1' })).toBe(8);
      expect(c(g, 'MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 4 })).toBe(1);
      expect(c(g, 'MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 3 })).toBe(0);
    }
  });
});

describe('which pred lists are EXACT', () => {
  const lit = (value: unknown) => ({ kind: 'lit' as const, value });
  const eqWhere = (key: string, value: unknown) => ({
    kind: 'compare' as const,
    op: '=' as const,
    left: { kind: 'prop' as const, variable: 'u', key },
    right: lit(value),
  });

  const predOf = (
    props?: { key: string; value: unknown }[],
    where?: unknown,
  ): ReturnType<typeof compilePredicate> =>
    compilePredicate(
      props?.map((p) => ({ key: p.key, value: lit(p.value) })),
      where as never,
      'u',
    );

  test('one lifted equality', () => {
    expect(soleEqualityKey([{ pred: predOf(undefined, eqWhere('k', 2)) }])).toBe('k');
  });

  test('one inline property', () => {
    expect(soleEqualityKey([{ pred: predOf([{ key: 'k', value: 2 }]) }])).toBe('k');
  });

  test('TWO entries are not exact — the second constraint survives the seek', () => {
    expect(
      soleEqualityKey([
        {
          pred: predOf([
            { key: 'k', value: 2 },
            { key: 'j', value: 3 },
          ]),
        },
      ]),
    ).toBeUndefined();
    expect(
      soleEqualityKey([
        { pred: predOf(undefined, { kind: 'and', items: [eqWhere('k', 2), eqWhere('j', 3)] }) },
      ]),
    ).toBeUndefined();
  });

  test('one of EACH carrier is not exact either', () => {
    expect(
      soleEqualityKey([{ pred: predOf([{ key: 'k', value: 2 }], eqWhere('j', 3)) }]),
    ).toBeUndefined();
  });

  test('TWO preds are not exact, however narrow each is', () => {
    expect(
      soleEqualityKey([
        { pred: predOf(undefined, eqWhere('k', 2)) },
        { pred: predOf(undefined, eqWhere('j', 3)) },
      ]),
    ).toBeUndefined();
  });

  test('a bindVar is not exact — a correlated value reads a binding nothing wrote', () => {
    const pred = predOf([{ key: 'k', value: 2 }]);

    expect(soleEqualityKey([{ pred, bindVar: 'u' }])).toBeUndefined();
    // The control, so the refusal is the bindVar and not the shape.
    expect(soleEqualityKey([{ pred }])).toBe('k');
  });

  test('an ORDERING comparison is not exact', () => {
    expect(
      soleEqualityKey([
        {
          pred: predOf(undefined, {
            kind: 'compare',
            op: '>',
            left: { kind: 'prop', variable: 'u', key: 'k' },
            right: lit(2),
          }),
        },
      ]),
    ).toBeUndefined();
  });

  test('an empty list, and no entries at all', () => {
    expect(soleEqualityKey([])).toBeUndefined();
    expect(soleEqualityKey([{ pred: predOf() }])).toBeUndefined();
  });

  test('⚠️ a carrier the function has never heard of REFUSES, not ignores', () => {
    /**
     * The regression guard for a wrong answer, and `specializeSingleProp`'s first version is why
     * it is shaped this way: a hand-written list missed four of twelve carriers and the predicate
     * specialized to half of itself, answering 5 where the right answer was 2. Here the cost of
     * being wrong is higher still — a thirteenth carrier ignored would be declared EXACT and its
     * constraint dropped entirely.
     */
    const withUnknown = {
      props: [{ key: 'k', value: () => 2 }],
      someFutureCarrier: [{ anything: true }],
    } as unknown as Parameters<typeof soleEqualityKey>[0][number]['pred'];

    expect(soleEqualityKey([{ pred: withUnknown }])).toBeUndefined();
  });

  test('a residual `where` refuses', () => {
    const withWhere = {
      props: [{ key: 'k', value: () => 2 }],
      where: () => true,
    } as unknown as Parameters<typeof soleEqualityKey>[0][number]['pred'];

    expect(soleEqualityKey([{ pred: withWhere }])).toBeUndefined();
  });
});

describe('whether a chosen seed is EXACT', () => {
  /**
   * ⚠️ THIS BLOCK EXISTS BECAUSE EVERY MUTANT OF THE VERDICT SURVIVED INLINE. `soleEqualityKey` is
   * already narrow enough that when it answers, the only candidate `indexCandidates` can produce is
   * the equality on that key — so dropping the key comparison, accepting any candidate kind, and
   * reporting `eqKey` on a `within` or a `range` candidate were all answer-neutral. Item 475's rule
   * is that the fix for "redundant" is to pin it where it can be seen.
   */
  test('a matching equality key is exact', () => {
    expect(seedIsExact({ eqKey: 'team' }, 'team')).toBe(true);
  });

  test('a DIFFERENT key is not — a seek on `n` must not satisfy a predicate about `team`', () => {
    expect(seedIsExact({ eqKey: 'n' }, 'team')).toBe(false);
  });

  test('a non-equality candidate is never exact, however narrow the predicate', () => {
    expect(seedIsExact({}, 'team')).toBe(false);
    expect(seedIsExact(undefined, 'team')).toBe(false);
  });

  test('no sole key means not exact, whatever was sought', () => {
    expect(seedIsExact({ eqKey: 'team' }, undefined)).toBe(false);
    expect(seedIsExact({}, undefined)).toBe(false);
  });
});

describe('which candidate kinds report an equality key', () => {
  /**
   * The other half: `eqKey` is a FACT about the candidate ("this set is every vertex whose key
   * equals the sought value"), so only the equality candidates may carry it. A `within` is a UNION
   * of buckets and a `range` an interval — both supersets of any one equality.
   */
  const candidates = (node: unknown): (string | undefined)[] =>
    [
      ...indexCandidates(indexed, node as Parameters<typeof indexCandidates>[1], {
        binding: new Map(),
        params: {},
        graph: indexed,
      }),
    ].map((c) => c.eqKey);

  const nodeWith = (
    seedHints: unknown[],
    props: { key: string; value: unknown }[] = [],
  ): unknown => ({
    variable: 'u',
    pred: compilePredicate(
      props.map((p) => ({ key: p.key, value: { kind: 'lit' as const, value: p.value } })),
      undefined,
      'u',
    ),
    seedHints,
  });

  test('an inline equality reports its key', () => {
    expect(candidates(nodeWith([], [{ key: 'team', value: 't1' }]))).toEqual(['team']);
  });

  test('an `eq` HINT reports its key', () => {
    expect(candidates(nodeWith([{ kind: 'eq', key: 'team', value: () => 't1' }]))).toEqual([
      'team',
    ]);
  });

  test('a `within` hint reports NONE — it is a union of buckets', () => {
    expect(
      candidates(nodeWith([{ kind: 'within', key: 'team', values: () => ['t1', 't2'] }])),
    ).toEqual([undefined]);
  });

  test('a `range` hint reports NONE — it is an interval', () => {
    expect(candidates(nodeWith([{ kind: 'range', key: 'n', bound: { gt: () => 3 } }]))).toEqual([
      undefined,
    ]);
  });
});
