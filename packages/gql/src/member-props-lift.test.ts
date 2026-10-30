import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';

// `WHERE n.k IN [..]` and its `n.k = a OR n.k = b` spelling now LIFT into `memberProps` — read off
// the element instead of through the binding `Map` (item 1269). Three spellings of one question had
// measured 1.84x apart at 200,000 vertices, all answering 2000:
//
//     MATCH (b:Person {age: 50}) RETURN count(*)                      3.195ms   16.0 ns/vertex
//     MATCH (b:Person) WHERE b.age = 50 RETURN count(*)               3.358     16.8
//     MATCH (b:Person) WHERE b.age IN [50] RETURN count(*)            5.884     29.4
//     MATCH (b:Person) WHERE b.age = 50 OR b.age = 50 RETURN count(*) 5.885     29.4
//
// After: 3.643 and 3.678, a 1.15x spread. Item 230 had already measured and attributed that pair
// (17.2 ns against 29.0) — the binding write and read per element.
//
// ⚠️ THIS FILE IS ABOUT THE SEMANTICS THE LIFT MUST NOT CHANGE, not the speed. The lift reaches a
// different code path from the generic evaluator, so every three-valued rule has to be re-asserted
// on it: a null IN THE LIST, a null or absent CELL, a param bound to a non-array, and the RAISE a
// sibling conjunct owes. Each test below fails if the lift gets one of them wrong, and the answer
// is identical to the generic path by construction only because `membershipTest` is the same
// function `case 'in'` uses.
const build = (): Graph => {
  const g = new Graph();

  // `has2`/`has9` carry k; `absent` has no k at all; `nulled` stores an explicit null. The three
  // behave differently under `IN`, `NOT IN` and a null list element, which is what makes them the
  // fixture (the same shape `inline-where-direct-eq.test.ts` uses, for the same reason).
  const has2 = g.addVertex({ id: 'has2', labels: ['P'], properties: { k: 2, s: 'xx' } });
  const has9 = g.addVertex({ id: 'has9', labels: ['P'], properties: { k: 9, s: 'xx' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { s: 'yy' } });
  const nulled = g.addVertex({ id: 'nulled', labels: ['P'], properties: { k: null, s: 'zz' } });

  const src = g.addVertex({ id: 'src', labels: ['S'], properties: {} });
  g.addEdge({ id: 'e2', from: src, to: has2, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e9', from: src, to: has9, labels: ['T'], properties: {} });
  g.addEdge({ id: 'en', from: src, to: nulled, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const countOf = (q: string, params?: Record<string, unknown>): number =>
  Number(query(g, q, params)[0].c);

describe('IN / OR lift into memberProps (item 1269)', () => {
  test('the three spellings of one membership question agree', () => {
    // `= 2 OR = 9` is folded by `membershipFromEqChain` — but in `compileExpr`, a stage AFTER
    // `directEqProps` runs, so the lift has to fold it itself. The first cut of item 1269 lifted
    // only `in` and left this spelling 1.64x behind, which is why it is asserted separately rather
    // than assumed to be the same node.
    expect(countOf('MATCH (n:P) WHERE n.k IN [2,9] RETURN count(*) AS c')).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k = 2 OR n.k = 9 RETURN count(*) AS c')).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k IN [2] RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (n:P) WHERE n.k IN [] RETURN count(*) AS c')).toBe(0);
  });

  test('a null CELL and an absent cell are both UNKNOWN, so both drop', () => {
    // Neither `absent` nor `nulled` may be counted by any spelling: `null IN [..]` is UNKNOWN and a
    // filter keeps only TRUE. A lift that masked on "has a value" rather than on the membership
    // test's own verdict would count them.
    expect(countOf('MATCH (n:P) WHERE n.k IN [2,9,null] RETURN count(*) AS c')).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k IN [999] RETURN count(*) AS c')).toBe(0);
  });

  test('⚠️ a NULL IN THE LIST makes a non-match UNKNOWN rather than FALSE', () => {
    // THE THREE-VALUED RULE THAT IS EASIEST TO GET WRONG, and `hashValues` carries a `hasNull` flag
    // precisely for it. `has2` matches outright (TRUE). `has9` does NOT match 2, and the remaining
    // element is null, so its verdict is UNKNOWN, not FALSE — it drops either way here, but the
    // distinction is observable under `NOT IN` below, and a lift that treated the list's null as
    // "no match" would make `NOT IN` return it.
    expect(countOf('MATCH (n:P) WHERE n.k IN [2,null] RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (n:P) WHERE n.k NOT IN [2,null] RETURN count(*) AS c')).toBe(0);
  });

  test('NOT IN is not lifted, and still answers for itself', () => {
    // `not3` of UNKNOWN is UNKNOWN, so only `has9` survives: `absent` and `nulled` are UNKNOWN.
    expect(countOf('MATCH (n:P) WHERE n.k NOT IN [2] RETURN count(*) AS c')).toBe(1);
  });

  test('a PARAM haystack lifts through the per-execution arm', () => {
    expect(countOf('MATCH (n:P) WHERE n.k IN $p RETURN count(*) AS c', { p: [2, 9] })).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k IN [$a, $b] RETURN count(*) AS c', { a: 2, b: 9 })).toBe(
      2,
    );
    // A param bound to a NON-ARRAY makes the whole predicate UNKNOWN — `membershipTest`'s
    // `hashed === null` branch, which keeps `inList` over the raw value.
    expect(countOf('MATCH (n:P) WHERE n.k IN $p RETURN count(*) AS c', { p: 2 })).toBe(0);
  });

  test('⚠️ a sibling that SETTLES the row suppresses a raise, as it does on the generic route', () => {
    // ⚠️ REWRITTEN AT ITEM 1286, AND THE BEHAVIOUR IT USED TO ASSERT WAS A CROSS-ENGINE DIVERGENCE.
    // The original argument was that running a non-raising family FIRST "would let a FALSE test
    // return early and swallow that raise — changing WHICH queries error", so this family ran LAST
    // among the lifted blocks. The premise is right and the conclusion was backwards: the GENERIC
    // route does not raise when a sibling SETTLES the row (FALSE dominates), so running last is
    // what produced a raise the engine never produces. Measured on both engines:
    //
    //     WHERE n.s AND n.s IS NULL        ts ok 0   native ok 0   <- was ts THROW
    //     WHERE n.s IS NULL AND n.s        ts ok 0   native ok 0   <- was ts THROW
    //     WHERE n.s AND n.k IN [999]       ts ok 0   native ok 0   <- was ts THROW
    //     WHERE n.k IN [999] AND n.s       ts ok 0   native ok 0   <- was ts THROW
    //     WHERE n.s AND n.k IS NOT NULL    ts ERR    native ERR    <- unchanged, and why
    //
    // The last line is the one that still throws, and it is the control: one vertex PASSES
    // `k IS NOT NULL`, so the raising sibling is reached for that row whatever the order is. The
    // cross-engine guard now lives in `packages/native/src/and-short-circuit-conformance.test.ts`,
    // which is strictly stronger than this file could be — it compares against the engine instead
    // of pinning one engine's choice.
    expect(countOf('MATCH (n:P) WHERE n.s AND n.k IN [999] RETURN count(*) AS c')).toBe(0);
    expect(countOf('MATCH (n:P) WHERE n.k IN [999] AND n.s RETURN count(*) AS c')).toBe(0);
  });

  test('an AND chain mixing a membership with the other lifted families is complete', () => {
    // All four conjuncts lift, into three different families. A family dropped from the chain
    // returns a SUPERSET, which is the failure `hasPredicate`'s own doc records.
    expect(countOf("MATCH (n:P) WHERE n.k IN [2,9] AND n.s = 'xx' RETURN count(*) AS c")).toBe(2);
    expect(countOf("MATCH (n:P) WHERE n.k IN [2,9] AND n.s = 'zz' RETURN count(*) AS c")).toBe(0);
    expect(countOf('MATCH (n:P) WHERE n.k IN [2,9] AND n.k > 5 RETURN count(*) AS c')).toBe(1);
  });

  test('⚠️ the far-hop MERGE carries memberProps (a dropped list would return a SUPERSET)', () => {
    // `mergeFarPreds` concatenates an inline far constraint with the lifted clause predicate. If
    // `memberProps` were left out of that merge the clause would VANISH and this would answer 2
    // (both `xx` nodes) instead of 1 — a wrong answer, not a slow one, and no count-only test
    // elsewhere would see it.
    expect(countOf("MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IN [2] RETURN count(*) AS c")).toBe(
      1,
    );
    expect(
      countOf("MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IN [2,9] RETURN count(*) AS c"),
    ).toBe(2);
    // The projection spelling of the same shape, which is the other consumer of that merge.
    expect(
      query(g, "MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IN [2] RETURN b.k AS k").map(
        (r) => r.k,
      ),
    ).toEqual([2]);
  });

  test('⚠️ ROUTE: both spellings actually LIFT, asserted on the pure compiler', () => {
    // Admitting a spelling to a lifted family is ANSWER-EQUIVALENT, so every test above passes
    // with the lift reverted and only the cost changes. The mutation run proved it: removing the
    // OR fold SURVIVED the whole suite. `compilePredicate` is the pure decision, so it is asserted
    // directly — the repo's own remedy for a route choice no answer can see.
    const kIs = (v: number): Expr => ({
      kind: 'compare',
      op: '=',
      left: { kind: 'prop', variable: 'n', key: 'k' },
      right: { kind: 'lit', value: v },
    });

    const inForm: Expr = {
      kind: 'in',
      expr: { kind: 'prop', variable: 'n', key: 'k' },
      list: {
        kind: 'list',
        items: [
          { kind: 'lit', value: 2 },
          { kind: 'lit', value: 9 },
        ],
      },
      negated: false,
    };
    const orForm: Expr = { kind: 'or', items: [kIs(2), kIs(9)] };

    for (const [what, where] of [
      ['IN', inForm],
      ['the OR chain', orForm],
    ] as const) {
      const pred = compilePredicate(undefined, where, 'n');

      expect(pred.memberProps?.length ?? 0).toBe(1);
      // A successful lift EMPTIES `where` — the lifted list is then the ONLY carrier, which is why
      // every consumer had to be audited. If `where` survived, the conjunct would be applied twice.
      expect(pred.where).toBeUndefined();
      expect(hasPredicate(pred)).toBe(true);
      expect(what).toBeTruthy();
    }

    // A haystack that varies per row must NOT lift, and must stay in `where`.
    const perRow: Expr = {
      kind: 'in',
      expr: { kind: 'prop', variable: 'n', key: 'k' },
      list: { kind: 'prop', variable: 'n', key: 'tags' },
      negated: false,
    };
    const unlifted = compilePredicate(undefined, perRow, 'n');

    expect(unlifted.memberProps).toBeUndefined();
    expect(unlifted.where).toBeDefined();
  });

  test('⚠️ a membership is the ONLY constraint on a product factor (hasPredicate must see it)', () => {
    // `hasPredicate`'s own doc: every gate that decides "can I skip applying this predicate" or
    // "is this node constrained" goes through it, so a FIFTH list forgotten there reintroduces the
    // bug it exists to prevent. A product count is the shape where that would show — an
    // unconstrained factor is answered from a bucket SIZE, so a dropped membership would multiply
    // the whole label instead of the one matching vertex.
    //
    // ⚠️ THIS IS NOT WHAT CATCHES THE `hasPredicate` MUTANT, and the mutation run is why that is
    // stated rather than assumed: `has-predicate-omits-member` is caught by the ROUTE test above,
    // through its explicit `hasPredicate(pred)` assertion. This case still earns its place — it
    // pins the product shape's ANSWER, which no assertion on the compiler can — but the guard it
    // was written for lives next door.
    expect(countOf('MATCH (a:P), (b:S) WHERE a.k IN [2] RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (a:P), (b:S) WHERE a.k IN [2,9] RETURN count(*) AS c')).toBe(2);
  });

  test('a haystack that varies per row is not lifted, and still answers', () => {
    // `membershipTest` declines a haystack that is neither literal nor closed, and `directEqProps`
    // then declines the whole chain — so this runs on the generic path. It must still be right.
    expect(countOf('MATCH (n:P) WHERE n.k IN [n.k] RETURN count(*) AS c')).toBe(2);
  });
});
