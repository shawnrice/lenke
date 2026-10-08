import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `pushWhereIntoNode` folds a single-node MATCH's clause `WHERE` into the node pattern, so the
// predicate rejects DURING the scan instead of post-filtering bindings. A conjunct carrying
// `EXISTS {…}` / `COUNT {…}` / `VALUE {…}` must be held back from that fold: it runs a correlated
// sub-pattern per evaluation, the evaluator does NOT short-circuit (pinned in
// `operator-chains.test.ts`, and native raises on `false AND (1.0 / 0.0)` too), so a cheap
// conjunct beside it could not gate it and the subquery ran once per vertex in the label —
// 265.48ms against 2.38ms for the same question spelled with an inline anchor (audit item 174).
//
// The oracle these tests lean on: a subquery body that FAULTS raises if and only if it was
// evaluated. That makes "was the subquery gated?" directly observable, which a pure timing claim
// is not — so every test below is a real result assertion, not a proxy.
//
// What has to hold:
//
//   - rows are unchanged when nothing faults (the split is answer-preserving);
//   - a faulting subquery is NOT evaluated for a vertex the cheap conjunct rejects;
//   - it IS still evaluated, and still raises, for a vertex that survives;
//   - a NON-subquery faulting conjunct is untouched — that is the separate, reserved
//     `and-chain-seeding-divergence` (audit item 115), and this change must not quietly
//     settle it;
//   - the walker finds a subquery NESTED inside a conjunct, not just one at its top;
//   - an OR is never split, and a node's own inline predicate still merges.

/**
 * `a` and `b` have an out-edge; `c` does not. `z` is 0 on `b` ONLY, so `1.0 / u.z` faults for
 * exactly one vertex — and `b` is the vertex the selective conjunct `u.k = 'a'` rejects. A
 * fixture where every vertex faults could not tell "gated" from "evaluated in a different
 * order"; this one can.
 */
const g3 = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a', z: 1, n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b', z: 0, n: 2 } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { k: 'c', z: 1, n: 3 } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('b'), to: v('c'), labels: ['E'], properties: {} });

  return g;
};

const rows = (q: string, params?: Record<string, unknown>): unknown[] => query(g3(), q, params);

const raised = (q: string, params?: Record<string, unknown>): boolean => {
  try {
    query(g3(), q, params);

    return false;
  } catch {
    return true;
  }
};

describe('a subquery conjunct is held back from the node fold (item 174)', () => {
  test('rows are unchanged: the split is answer-preserving', () => {
    // `a` and `b` have an out-edge, `c` does not; the cheap conjunct keeps `a` and `b`.
    expect(
      rows(`MATCH (u:P) WHERE u.n <= 2 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toHaveLength(2);
    expect(rows(`MATCH (u:P) WHERE u.k = 'c' AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`)).toEqual(
      [],
    );
    expect(rows(`MATCH (u:P) WHERE u.k = 'a' AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`)).toEqual(
      [{ k: 'a' }],
    );
  });

  test('the conjunct ORDER does not change the answer either way', () => {
    const a = rows(`MATCH (u:P) WHERE u.n <= 2 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`);
    const b = rows(`MATCH (u:P) WHERE EXISTS { (u)-[:E]->() } AND u.n <= 2 RETURN u.k AS k`);

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  // The teeth. `1.0 / u.z` faults on `b` alone, and `u.k = 'a'` rejects `b`.
  test('a faulting subquery is NOT evaluated for a vertex the cheap conjunct rejects', () => {
    expect(
      raised(`MATCH (u:P) WHERE u.k = 'a' AND EXISTS { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 }
              RETURN u.k AS k`),
    ).toBe(false);
  });

  test('CONTROL it IS evaluated, and still raises, for a vertex that survives', () => {
    // Same query, selecting the vertex that DOES fault. Without this pair the test above
    // would also pass if the subquery had simply stopped faulting.
    expect(
      raised(`MATCH (u:P) WHERE u.k = 'b' AND EXISTS { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 }
              RETURN u.k AS k`),
    ).toBe(true);
  });

  test('CONTROL with no cheap conjunct to gate it, every vertex is evaluated', () => {
    expect(
      raised(`MATCH (u:P) WHERE EXISTS { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 } RETURN u.k AS k`),
    ).toBe(true);
  });

  test('a NON-subquery faulting conjunct is ALSO gated now (the AND decision)', () => {
    // This was the recorded divergence: the conjunct was pushed into the node, so it ran for
    // every vertex and raised even when nothing matched, while native returned []. The
    // comment here used to say the divergence "is a decision about seeding, NOT something
    // this change may settle by accident" — the decision has since been taken (user,
    // 2026-10-08) and native's answer is the intended one. A conjunct a FALSE sibling has
    // already settled is an INESSENTIAL part of the search condition and is not evaluated.
    expect(raised(`MATCH (u:P) WHERE u.k = 'nobody' AND 1.0 / 0.0 > 0 RETURN u.k AS k`)).toBe(
      false,
    );
    // CONTROL, and the half that must not move: when the cheap conjunct ADMITS the vertex the
    // faulting one is essential, so it runs and still raises.
    expect(raised(`MATCH (u:P) WHERE u.k = 'a' AND 1.0 / 0.0 > 0 RETURN u.k AS k`)).toBe(true);
  });

  test('a bare-expression AND short-circuits on FALSE; OR still evaluates both', () => {
    // Byte-identity with native, verified against it directly: `AND` skips the inessential
    // operand and `OR` does not. The asymmetry is deliberate — the decision was taken for
    // `AND`, and native has no counterpart to the conjunct split on the OR side to seed from.
    expect(raised(`RETURN false AND (1.0 / 0.0) AS r`)).toBe(false);
    expect(raised(`RETURN true OR (1.0 / 0.0) AS r`)).toBe(true);
    // The value, not just the absence of a fault.
    expect(rows(`RETURN false AND (1.0 / 0.0) AS r`)).toEqual([{ r: false }]);
    // And the order that a short-circuit does NOT save: the throwing operand comes first and
    // neither operand is safe to hoist, so it is reached. Native agrees.
    expect(raised(`RETURN (1.0 / 0.0) AND false AS r`)).toBe(true);
  });

  test('the walker finds a subquery NESTED inside a conjunct, not just at its top', () => {
    // `NOT EXISTS {…}` and `COUNT {…} > 0` bury the subquery one and two levels down. A
    // per-variant check that only looked at the conjunct's own `kind` would push these.
    expect(
      raised(`MATCH (u:P) WHERE u.k = 'a' AND NOT EXISTS { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 }
              RETURN u.k AS k`),
    ).toBe(false);
    expect(
      raised(`MATCH (u:P) WHERE u.k = 'a' AND COUNT { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 } > 0
              RETURN u.k AS k`),
    ).toBe(false);
  });

  test('the walker follows ARRAY children, not just object fields', () => {
    // `OR` is n-ary: its operands live in an `items` ARRAY, so this subquery is reachable
    // ONLY through an array. A walker that recursed into object fields but not arrays
    // answered "no subquery" here and pushed it — and every other nested case in this file
    // (`NOT`, `COUNT {…} > 0`) reaches its subquery through a plain field, so none of them
    // noticed. Found by mutation.
    expect(
      raised(`MATCH (u:P) WHERE u.k = 'a' AND (EXISTS { (u)-[:E]->(w) WHERE 1.0 / u.z > 0 } OR false)
              RETURN u.k AS k`),
    ).toBe(false);
  });

  test('TWO subquery conjuncts both survive as the residual filter', () => {
    // `conjoin` is what rebuilds the held-back conjuncts, and with a single subquery
    // conjunct it never has to build an AND at all — so a `conjoin` that returned only its
    // first item was invisible until a second subquery conjunct existed. `COUNT {…} = 99`
    // is false for every vertex, so dropping it turns [] into two rows.
    expect(
      rows(`MATCH (u:P) WHERE u.n >= 1 AND EXISTS { (u)-[:E]->() }
            AND COUNT { (u)-[:E]->() } = 99 RETURN u.k AS k`),
    ).toEqual([]);
  });

  test("the node's own inline WHERE still merges with the pushed conjuncts", () => {
    // `(u:P {k: 'a'})` is stored as the node's PROPS; only the `(u:P WHERE …)` spelling
    // populates `path.start.where`, which is the thing the merge actually reads. The props
    // test below therefore never exercised it.
    expect(
      rows(`MATCH (u:P WHERE u.k = 'a') WHERE u.n = 1 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toEqual([{ k: 'a' }]);
    expect(
      rows(`MATCH (u:P WHERE u.k = 'a') WHERE u.n = 2 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toEqual([]);
  });

  test('a COUNT subquery conjunct still answers correctly', () => {
    expect(
      rows(`MATCH (u:P) WHERE u.n <= 2 AND COUNT { (u)-[:E]->() } = 1 RETURN u.k AS k`),
    ).toHaveLength(2);
  });

  test('an OR carrying a subquery is never split', () => {
    // A disjunction cannot be taken apart, so nothing is pushable and the clause filter
    // stands — the answer is what matters here.
    const r = rows(`MATCH (u:P) WHERE u.k = 'c' OR EXISTS { (u)-[:E]->() } RETURN u.k AS k`);

    expect(r).toHaveLength(3);
  });

  test("a node's own inline predicate still merges with the pushed conjuncts", () => {
    expect(
      rows(`MATCH (u:P {k: 'a'}) WHERE u.n = 1 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toEqual([{ k: 'a' }]);
    expect(
      rows(`MATCH (u:P {k: 'a'}) WHERE u.n = 2 AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toEqual([]);
  });

  test('a subquery-only WHERE is left exactly as it was', () => {
    expect(rows(`MATCH (u:P) WHERE EXISTS { (u)-[:E]->() } RETURN u.k AS k`)).toHaveLength(2);
  });

  test('three conjuncts: both cheap ones push, the subquery stays behind', () => {
    expect(
      rows(`MATCH (u:P) WHERE u.n >= 1 AND u.k = 'a' AND EXISTS { (u)-[:E]->() } RETURN u.k AS k`),
    ).toEqual([{ k: 'a' }]);
    // And the gating still holds with more than one pushable conjunct.
    expect(
      raised(`MATCH (u:P) WHERE u.n >= 1 AND u.k = 'a'
              AND EXISTS { (u)-[:E]->(v) WHERE 1.0 / u.z > 0 } RETURN u.k AS k`),
    ).toBe(false);
  });

  test('OPTIONAL MATCH is still excluded from the fold entirely', () => {
    const r = rows(
      `MATCH (u:P) WHERE u.k = 'a' OPTIONAL MATCH (w:P) WHERE w.k = 'zzz' RETURN u.k AS k, w.k AS w`,
    );

    expect(r).toEqual([{ k: 'a', w: null }]);
  });
});
