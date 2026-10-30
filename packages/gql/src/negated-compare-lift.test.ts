import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate } from './executor.js';
import { query } from './index.js';

// `NOT (n.k = v)` is `n.k <> v`, so it now lifts by FLIPPING the operator (item 1272). Before this,
// `NOT` of a compare was neither a bare `prop` nor a `compare`, so `directEqProps` declined the
// whole chain — while the `<>` spelling of the same question lifted into `cmpProps`. 200,000
// vertices, both answering an identical 198000:
//
//     a <> 50             3.859 ms -> 3.631    19.3 -> 18.2 ns/vertex   (control)
//     NOT (a = 50)        6.467    -> 3.916    32.3 -> 19.6            1.65x
//     NOT (a <> 50)                -> 3.206            16.0            lands on `= 50`'s 3.193
//     NOT (a >= 50)       6.467    -> 6.172                            EXCLUDED, and must not move
//
// ⚠️ THE EXCLUSION OF ORDERING OPERATORS IS THE SUBSTANCE OF THIS FILE, and it is a wrong answer
// rather than a missed optimisation. The NaN hole is demonstrated below rather than argued: a
// stored NaN becomes null in this engine, but a NaN PARAM does not, so the divergence is reachable.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'k2', labels: ['P'], properties: { k: 2, s: 'xx' } });
  g.addVertex({ id: 'k9', labels: ['P'], properties: { k: 9, s: 'yy' } });
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { k: null, s: 'zz' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { s: 'ww' } });

  return g;
};

const g = build();
const countOf = (q: string, params?: Record<string, unknown>): number =>
  Number(query(g, q, params)[0].c);

describe('NOT of an equality lifts by flipping the operator (item 1272)', () => {
  test('⚠️ an ORDERING operator must NOT be flipped: a NaN param makes them DIVERGE', () => {
    // THE REASON THE LIFT IS EQUALITY-ONLY. Every ordering comparison against NaN is FALSE here
    // (this repo keeps NaN JS-unordered), so the NEGATION is TRUE for every row while the flipped
    // operator is FALSE for every row. If `asNegatedCompare` ever gained `>=`, this query would
    // answer 0 instead of 2 — a silent wrong answer on a shape a user can write today.
    //
    // 2, not 4: only `k2` and `k9` hold a number. For `nulled` and `absent` the comparison is
    // UNKNOWN, its negation is UNKNOWN, and a filter keeps only TRUE — so they drop on BOTH
    // spellings and cannot be what distinguishes them.
    expect(
      countOf('MATCH (n:P) WHERE NOT (n.k >= $x) RETURN count(*) AS c', { x: Number.NaN }),
    ).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k < $x RETURN count(*) AS c', { x: Number.NaN })).toBe(0);

    // EQUALITY HAS NO SUCH HOLE: `= NaN` is FALSE, its negation TRUE, and `<>` answers TRUE too.
    expect(
      countOf('MATCH (n:P) WHERE NOT (n.k = $x) RETURN count(*) AS c', { x: Number.NaN }),
    ).toBe(2);
    expect(countOf('MATCH (n:P) WHERE n.k <> $x RETURN count(*) AS c', { x: Number.NaN })).toBe(2);
  });

  test('NOT (k = v) and k <> v agree on every cell state', () => {
    // `k2` matches; `k9` does not; `nulled` and `absent` are UNKNOWN under both spellings and a
    // filter keeps only TRUE, so both drop. A lift that treated the negation as "not TRUE" rather
    // than "the complement" would count them and answer 3.
    for (const where of ['NOT (n.k = 2)', 'n.k <> 2']) {
      expect(countOf(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)).toBe(1);
    }

    for (const where of ['NOT (n.k = 2)', 'n.k <> 2']) {
      expect(query(g, `MATCH (n:P) WHERE ${where} RETURN n.k AS k`).map((r) => r.k)).toEqual([9]);
    }
  });

  test('NOT (k <> v) and k = v agree', () => {
    for (const where of ['NOT (n.k <> 2)', 'n.k = 2']) {
      expect(countOf(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)).toBe(1);
    }
  });

  test('a CROSS-TYPE literal agrees across the two spellings', () => {
    // Whatever this engine's cross-type `=` answers, the negation and `<>` must answer the same
    // thing — the lift is a route change, not a semantics change.
    const a = countOf("MATCH (n:P) WHERE NOT (n.k = 'two') RETURN count(*) AS c");
    const b = countOf("MATCH (n:P) WHERE n.k <> 'two' RETURN count(*) AS c");

    expect(a).toBe(b);
  });

  test('the STRING key agrees too, and the operand order does not matter', () => {
    for (const where of ["NOT (n.s = 'xx')", "n.s <> 'xx'", "NOT ('xx' = n.s)"]) {
      expect(countOf(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)).toBe(3);
    }
  });

  test('⚠️ ROUTE: the two equalities LIFT and the ordering operator does NOT', () => {
    // Answer-equivalent, so only the compiler can see it.
    const cmp = (op: string): Expr => ({
      kind: 'compare',
      op: op as never,
      left: { kind: 'prop', variable: 'n', key: 'k' },
      right: { kind: 'lit', value: 2 },
    });

    // `NOT (k = 2)` becomes `k <> 2`, which is not an equality, so it lands in `cmpProps`.
    const notEq = compilePredicate(undefined, { kind: 'not', expr: cmp('=') }, 'n');

    expect(notEq.cmpProps?.length ?? 0).toBe(1);
    expect(notEq.cmpProps?.[0].op).toBe('<>');
    expect(notEq.where).toBeUndefined();

    // `NOT (k <> 2)` becomes `k = 2`, which lands in `eqProps`.
    const notNe = compilePredicate(undefined, { kind: 'not', expr: cmp('<>') }, 'n');

    expect(notNe.eqProps?.length ?? 0).toBe(1);
    expect(notNe.where).toBeUndefined();

    // EVERY ordering operator stays on the generic path. This is the assertion that fails if the
    // flip table is widened, and the test above says what that would cost.
    for (const op of ['>', '>=', '<', '<=']) {
      const notOrd = compilePredicate(undefined, { kind: 'not', expr: cmp(op) }, 'n');

      expect(notOrd.cmpProps).toBeUndefined();
      expect(notOrd.eqProps).toBeUndefined();
      expect(notOrd.where).toBeDefined();
    }
  });

  test('a negated equality beside other lifted conjuncts is complete', () => {
    expect(countOf("MATCH (n:P) WHERE NOT (n.k = 2) AND n.s = 'yy' RETURN count(*) AS c")).toBe(1);
    expect(countOf("MATCH (n:P) WHERE NOT (n.k = 2) AND n.s = 'xx' RETURN count(*) AS c")).toBe(0);
    // And through the nested spelling item 1271 admitted.
    expect(countOf("MATCH (n:P) WHERE (NOT (n.k = 2) AND n.s = 'yy') RETURN count(*) AS c")).toBe(
      1,
    );
  });
});
