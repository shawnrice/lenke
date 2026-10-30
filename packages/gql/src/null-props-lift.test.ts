import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';

// `WHERE n.k IS NULL`, `IS NOT NULL` and `NOT (n.k IS NULL)` now LIFT into `nullProps` — read off
// the element instead of through the binding `Map` (item 1270). `isNull` is an `Expr` kind of its
// own, so `directEqProps` declined its whole chain on it, while the INLINE spelling of the same
// question — `(n {k: null})`, which this engine reads AS `IS NULL` — was already element-direct.
// Measured at 200,000 vertices, the first two answering an identical 2000:
//
//     {nk: null} inline      3.317 ms -> 3.219    16.1 ns/vertex   (control, already lifted)
//     nk IS NULL             5.683    -> 2.956    14.8             1.92x
//     nk IS NOT NULL         5.549    -> 3.351    16.8             1.66x
//     NOT (nk IS NULL)       6.438    -> 3.332    16.7             1.93x
//
// The native engine had the same omission in its own matcher and it cost ~4x twice over — items
// 1261 and 1262, the second being the `NOT (… IS NULL)` spelling that was missed the first time.
// Both are folded here at once.
//
// ⚠️ WHAT THIS FILE IS FOR IS THE SEMANTICS, not the speed. A null test is TOTAL (`null IS NULL` is
// TRUE, never UNKNOWN) which makes the lift simple — but "is this cell null" still has to classify
// an ABSENT property, a STORED null and a dotted path exactly as the generic path does, and the
// lifted list is the ONLY carrier of the conjunct once `compilePredicate` empties `where`.
const build = (): Graph => {
  const g = new Graph();

  // THE THREE CELL STATES THAT MUST AGREE ACROSS ROUTES. `nulled` stores an explicit null,
  // `absent` carries no `k` at all, and `has2` a real value. The probe that priced this item used
  // only the first two, so the absent case is asserted here rather than assumed.
  const has2 = g.addVertex({ id: 'has2', labels: ['P'], properties: { k: 2, s: 'xx' } });
  const nulled = g.addVertex({ id: 'nulled', labels: ['P'], properties: { k: null, s: 'xx' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { s: 'xx' } });
  g.addVertex({ id: 'deep', labels: ['P'], properties: { meta: { c: null }, s: 'yy' } });

  const src = g.addVertex({ id: 'src', labels: ['S'], properties: {} });
  g.addEdge({ id: 'e2', from: src, to: has2, labels: ['T'], properties: {} });
  g.addEdge({ id: 'en', from: src, to: nulled, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const countOf = (q: string, params?: Record<string, unknown>): number =>
  Number(query(g, q, params)[0].c);

describe('IS NULL / IS NOT NULL lift into nullProps (item 1270)', () => {
  test('an ABSENT property and a STORED null are both IS NULL, on every spelling', () => {
    // `nulled` and `absent` both count; `has2` and `deep` do not. If the lift classified only the
    // stored null — a plausible mistake, since `absent` has no cell at all — this would answer 1.
    expect(countOf('MATCH (n:P) WHERE n.k IS NULL RETURN count(*) AS c')).toBe(3);
    expect(countOf('MATCH (n:P {k: null}) RETURN count(*) AS c')).toBe(3);
    expect(countOf('MATCH (n:P) WHERE NOT (n.k IS NOT NULL) RETURN count(*) AS c')).toBe(3);
  });

  test('IS NOT NULL is its exact complement, on every spelling', () => {
    expect(countOf('MATCH (n:P) WHERE n.k IS NOT NULL RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (n:P) WHERE NOT (n.k IS NULL) RETURN count(*) AS c')).toBe(1);
  });

  test('a DOTTED path is not lifted, and still answers', () => {
    // `n.meta.c IS NULL` has a `field` expression, not a `prop`, so the arm declines and the whole
    // chain falls to the generic evaluator. `deep` stores a null at `meta.c`; the other three have
    // no `meta` at all, so every one of them is IS NULL there.
    expect(countOf('MATCH (n:P) WHERE n.meta.c IS NULL RETURN count(*) AS c')).toBe(4);
    expect(countOf('MATCH (n:P) WHERE n.meta.c IS NOT NULL RETURN count(*) AS c')).toBe(0);
  });

  test('an AND chain mixing a null test with the other lifted families is complete', () => {
    // Three families at once. A list dropped from the chain returns a SUPERSET.
    expect(countOf("MATCH (n:P) WHERE n.k IS NULL AND n.s = 'xx' RETURN count(*) AS c")).toBe(2);
    expect(countOf("MATCH (n:P) WHERE n.k IS NOT NULL AND n.s = 'xx' RETURN count(*) AS c")).toBe(
      1,
    );
    expect(countOf("MATCH (n:P) WHERE n.k IS NULL AND n.s IN ['yy'] RETURN count(*) AS c")).toBe(1);
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
    expect(countOf('MATCH (n:P) WHERE n.s AND n.s IS NULL RETURN count(*) AS c')).toBe(0);
    expect(countOf('MATCH (n:P) WHERE n.s IS NULL AND n.s RETURN count(*) AS c')).toBe(0);
    expect(() =>
      query(g, 'MATCH (n:P) WHERE n.s AND n.k IS NOT NULL RETURN count(*) AS c'),
    ).toThrow();
  });

  test('⚠️ the far-hop MERGE carries nullProps (a dropped list would return a SUPERSET)', () => {
    // `mergeFarPreds` concatenates an inline far constraint with the lifted clause predicate. With
    // `nullProps` left out of that merge the clause would VANISH and this would answer 2 instead
    // of 1 — a wrong answer, not a slow one.
    expect(
      countOf("MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IS NULL RETURN count(*) AS c"),
    ).toBe(1);
    expect(
      countOf("MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IS NOT NULL RETURN count(*) AS c"),
    ).toBe(1);
    expect(
      query(g, "MATCH (a:S)-[:T]->(b:P {s: 'xx'}) WHERE b.k IS NOT NULL RETURN b.k AS k").map(
        (r) => r.k,
      ),
    ).toEqual([2]);
  });

  test('⚠️ ROUTE: all three spellings LIFT, and the NOT spelling FLIPS the flag', () => {
    // Admitting a spelling to a lifted family is ANSWER-EQUIVALENT, so every test above passes
    // with the lift reverted and only the cost changes. Item 1269's mutation run proved that two
    // such mutants survive a whole answer suite, so the PURE decision is asserted directly.
    const prop: Expr = { kind: 'prop', variable: 'n', key: 'k' };
    const cases: [string, Expr, boolean][] = [
      ['IS NULL', { kind: 'isNull', expr: prop, negated: false }, false],
      ['IS NOT NULL', { kind: 'isNull', expr: prop, negated: true }, true],
      // `NOT (k IS NULL)` must arrive as `negated: true` — the flip, not a second list.
      [
        'NOT (IS NULL)',
        { kind: 'not', expr: { kind: 'isNull', expr: prop, negated: false } },
        true,
      ],
      // And the double negation folds back.
      [
        'NOT (IS NOT NULL)',
        { kind: 'not', expr: { kind: 'isNull', expr: prop, negated: true } },
        false,
      ],
    ];

    for (const [what, where, negated] of cases) {
      const pred = compilePredicate(undefined, where, 'n');

      expect(pred.nullProps?.length ?? 0).toBe(1);
      expect(pred.nullProps?.[0].negated).toBe(negated);
      // A successful lift EMPTIES `where`; if it survived, the conjunct would be applied twice.
      expect(pred.where).toBeUndefined();
      expect(hasPredicate(pred)).toBe(true);
      expect(what).toBeTruthy();
    }

    // A dotted path must NOT lift, and must stay in `where`.
    const dotted = compilePredicate(
      undefined,
      {
        kind: 'isNull',
        expr: { kind: 'field', base: { kind: 'prop', variable: 'n', key: 'meta' }, key: 'c' },
        negated: false,
      },
      'n',
    );

    expect(dotted.nullProps).toBeUndefined();
    expect(dotted.where).toBeDefined();
  });

  test('a null test is the ONLY constraint on a product factor (hasPredicate must see it)', () => {
    // The product shape: an unconstrained factor is answered from a bucket SIZE, so a carrier that
    // `hasPredicate` cannot see would multiply the whole label instead of the matching vertices.
    expect(countOf('MATCH (a:P), (b:S) WHERE a.k IS NOT NULL RETURN count(*) AS c')).toBe(1);
    expect(countOf('MATCH (a:P), (b:S) WHERE a.k IS NULL RETURN count(*) AS c')).toBe(3);
  });
});
