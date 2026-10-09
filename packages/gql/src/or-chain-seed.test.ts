// A same-key `=`-OR-chain seeds the index, like the `IN` spelling it is equivalent to.
// `collectHints` descended only `and` and handled `compare`/`in`, so `k IN [a,b]` seeded (item
// 184) and `k = a OR k = b` scanned — the exact pair `CLAUDE.md` lists among the seeding gaps
// that cost 100-300x. Measured: 8.06ms -> 0.03ms at 2 terms, 77.95ms -> 0.68ms at 33.
//
// Two kinds of test, because they fail for different reasons:
//
//   1. RECOGNITION, asserted directly on `uniformEqChain`, because a soundness test alone passes
//      vacuously the moment the chain stops being recognized (both paths then scan and agree).
//   2. SOUNDNESS, as the same graph INDEXED and UNINDEXED — the contract an index must keep. A
//      seed is a SUPERSET of the matches and the predicate still runs, so the failure mode this
//      catches is a seed that is a SUBSET and silently drops rows.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { uniformEqChain } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

/**
 * 60 Users with `k = i % 10`, plus 60 ADMINS carrying the same `k` values. The second label is
 * load-bearing: a hash index returns vertices by value across ALL labels, so a missing label
 * check would count the Admins too.
 */
const build = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 60; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 10, j: i % 4 } });
    g.addVertex({ id: `a${i}`, labels: ['Admin'], properties: { k: i % 10, j: i % 4 } });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['j'] });
  }

  return g;
};

const unindexed = build(false);
const indexed = build(true);

/** The same query both ways. An index may change the cost and must never change the answer. */
const agree = (q: string, params?: Record<string, unknown>): unknown => {
  const a = JSON.stringify(query(unindexed, q, params));
  const b = JSON.stringify(query(indexed, q, params));

  expect(`${q}\n  indexed:   ${b}`).toBe(`${q}\n  indexed:   ${a}`);

  return JSON.parse(a);
};

describe('the chain is recognized, and only when every branch agrees', () => {
  const chain = (src: string) => uniformEqChain(parsePredicate(src));

  test('a two-term same-key chain is recognized', () => {
    expect(chain('n.k = 1 OR n.k = 2')?.key).toBe('k');
    expect(chain('n.k = 1 OR n.k = 2')?.values).toHaveLength(2);
  });

  test('a longer chain keeps every value', () => {
    expect(chain('n.k = 1 OR n.k = 2 OR n.k = 3 OR n.k = 4')?.values).toHaveLength(4);
  });

  test('a PARENTHESIZED group is flattened, not declined', () => {
    // A same-operator run folds into one n-ary `or`, but a parenthesized group does not — so
    // this arrives as two items where the engine's binary tree has three leaves.
    expect(chain('(n.k = 1 OR n.k = 2) OR n.k = 3')?.values).toHaveLength(3);
  });

  test('BOTH operand orders are recognized — the named bug class is the two costing differently', () => {
    expect(chain('1 = n.k OR n.k = 2')?.values).toHaveLength(2);
  });

  test('a params-valued branch is recognized (the consumer guards the resolved value)', () => {
    expect(chain('n.k = $a OR n.k = $b')?.values).toHaveLength(2);
  });

  test('a DIFFERENT KEY declines the whole chain', () => {
    expect(chain('n.k = 1 OR n.j = 2')).toBeUndefined();
  });

  test('a DIFFERENT VARIABLE declines the whole chain', () => {
    expect(chain('n.k = 1 OR m.k = 2')).toBeUndefined();
  });

  test('a non-equality branch declines the whole chain', () => {
    expect(chain('n.k = 1 OR n.k > 2')).toBeUndefined();
  });

  test('a non-comparison branch declines the whole chain', () => {
    expect(chain('n.k = 1 OR n.k IS NULL')).toBeUndefined();
  });

  test('a single comparison is not a chain', () => {
    expect(chain('n.k = 1')).toBeUndefined();
  });
});

describe('an index may change the cost and never the answer', () => {
  test('a two-term chain answers the same indexed and unindexed', () => {
    // 6 Users per `k` value, so two values is 12 — and 24 if the label check were dropped,
    // because the Admins carry the same values.
    expect(agree('MATCH (u:User) WHERE u.k = 1 OR u.k = 2 RETURN count(*) AS c')).toEqual([
      { c: 12 },
    ]);
  });

  test('the LABEL is applied to every seeded candidate', () => {
    expect(agree('MATCH (a:Admin) WHERE a.k = 1 OR a.k = 2 RETURN count(*) AS c')).toEqual([
      { c: 12 },
    ]);
  });

  test('a MIXED-key OR still finds every match', () => {
    // The chain declines, so this scans — and must. A `k`-only seed would miss the `j` matches.
    const rows = agree('MATCH (u:User) WHERE u.k = 1 OR u.j = 2 RETURN count(*) AS c') as {
      c: number;
    }[];

    expect(rows[0].c).toBeGreaterThan(12);
  });

  test('a repeated value does not double a row', () => {
    // The consumer unions into a `Set<Vertex>`, so duplicates are harmless — asserted rather
    // than assumed, because the engine's twin needs an explicit dedup for the same shape.
    expect(agree('MATCH (u:User) WHERE u.k = 1 OR u.k = 1 RETURN count(*) AS c')).toEqual([
      { c: 6 },
    ]);
  });

  test('a NULL-valued branch answers the same both ways', () => {
    // `k = null` is UNKNOWN, so it matches nothing. The seed may still include null-valued
    // vertices (a superset is allowed) because the predicate re-checks every candidate.
    expect(agree('MATCH (u:User) WHERE u.k = null OR u.k = 2 RETURN count(*) AS c')).toEqual([
      { c: 6 },
    ]);
  });

  test('a PARAM-valued chain answers the same both ways', () => {
    expect(
      agree('MATCH (u:User) WHERE u.k = $a OR u.k = $b RETURN count(*) AS c', { a: 1, b: 2 }),
    ).toEqual([{ c: 12 }]);
  });

  test('a NON-SCALAR value skips the hint rather than mis-seeding', () => {
    // `list.every(isScalar)` fails, so the hint is skipped and the seed falls back to the label
    // bucket. The answer must be the unindexed one either way.
    expect(agree('MATCH (u:User) WHERE u.k = [1, 2] OR u.k = 2 RETURN count(*) AS c')).toEqual([
      { c: 6 },
    ]);
  });

  test('the chain still works as a conjunct beside another predicate', () => {
    // `collectHints` descends `and`, so both hints are collected and `seedVertices` picks the
    // cheaper one. The answer must not depend on which it picked.
    expect(
      agree('MATCH (u:User) WHERE (u.k = 1 OR u.k = 2) AND u.j = 1 RETURN count(*) AS c'),
    ).toEqual(agree('MATCH (u:User) WHERE u.j = 1 AND (u.k = 1 OR u.k = 2) RETURN count(*) AS c'));
  });
});
