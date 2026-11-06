import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate } from './executor.js';
import { query } from './index.js';

// `directEqProps` used to `return null` on any conjunct it could not read, forfeiting the lift of
// every conjunct BESIDE it. Item 1284 stops the loop there instead: the PREFIX lifts and the tail
// becomes the residual `where`. The function's own closing note had named this as "the next step
// rather than this one".
//
// Measured at 200,000 vertices, ONE SHAPE PER PROCESS, min of three alternated rounds. The
// unliftable conjunct is `n.a >= n.a` — true for every present row, so answers are identical, and
// it cannot raise:
//
//     target   a=50 AND <unliftable>     9.353 ms -> 4.053    2.31x
//     [CTL]    <unliftable> AND a=50    11.946   -> 12.159    flat, nothing lifts either way
//     [CTL]    <unliftable> alone       14.995   -> 14.819    flat
//     [CTL]    a=50 alone (all-lift)     3.145   ->  3.148    flat
//
// ⚠️ A MULTI-ROW IN-PROCESS SWEEP OF THE SAME ARMS REPORTED THE BOUNDARY CONTROL 1.35x SLOWER in
// all three rounds, and that was an artifact of rows interfering through the dispatch site — the
// isolated run above shows it flat. A control moving against the change is the tell.
//
// ⚠️ ONLY A PREFIX LIFTS, AND THAT IS THE WHOLE SOUNDNESS ARGUMENT. The lifted families run before
// the residual, so lifting a prefix cannot make any conjunct overtake another: executed order is
// written order, and no shape's raise behaviour moves. Lifting a conjunct from AFTER the first
// decliner would reorder, which is why that is a separate item rather than a wider `stop`.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'v1', labels: ['P'], properties: { nm: 'v1', a: 50, b: 0, s: 'x' } });
  g.addVertex({ id: 'v2', labels: ['P'], properties: { nm: 'v2', a: 50, b: 1, s: 'x' } });
  g.addVertex({ id: 'v3', labels: ['P'], properties: { nm: 'v3', a: 7, b: 0, s: 'x' } });
  // A STORED NULL and an ABSENT cell, so the UNKNOWN cases are exercised on both routes.
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { nm: 'nulled', a: null, b: 0, s: 'x' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { nm: 'absent', b: 0, s: 'x' } });

  return g;
};

const g = build();
// `n.a >= n.a` cannot be lifted: `asPropCompare` requires a CLOSED value side and a `prop` is not
// closed. It is TRUE for a present numeric cell and UNKNOWN otherwise, so it never changes which
// rows a filter keeps among present cells.
const DECL = 'n.a >= n.a';
const ids = (q: string): string[] =>
  query(g, q)
    .map((r) => String(r.nm))
    .sort();

describe('a mixed AND chain lifts its prefix (item 1284)', () => {
  test('⚠️ ROUTE: the prefix lifts, the tail becomes the residual, and the reverse order lifts NOTHING', () => {
    // Answer-equivalent by design, so only the compiler can see this. Without the route
    // assertions every mutant below passes every row assertion in the package.
    const prop = (k: string): Expr => ({ kind: 'prop', variable: 'n', key: k });
    const eq = (k: string, v: number): Expr => ({
      kind: 'compare',
      op: '=',
      left: prop(k),
      right: { kind: 'lit', value: v },
    });
    const decl: Expr = { kind: 'compare', op: '>=', left: prop('a'), right: prop('a') };

    const one = compilePredicate(undefined, { kind: 'and', items: [eq('a', 50), decl] }, 'n');

    expect(one.eqProps?.length ?? 0).toBe(1);
    expect(one.where).toBeDefined();

    // TWO liftable conjuncts ahead of the decliner both lift.
    const two = compilePredicate(
      undefined,
      { kind: 'and', items: [eq('a', 50), eq('b', 0), decl] },
      'n',
    );

    expect(two.eqProps?.length ?? 0).toBe(2);
    expect(two.where).toBeDefined();

    // ⚠️ THE BOUNDARY MOVED AT ITEM 1544. This used to assert that a decliner FIRST lifts nothing
    // at all, and its own comment said it was "the assertion that fails if the prefix rule is ever
    // widened to pick liftable conjuncts out of the middle of a chain". It was widened, on purpose:
    // the owner settled at item 1543 that evaluation order is chosen for SPEED per engine, and the
    // two spellings measured 13.952 ms against 5.741 while answering identically.
    //
    // The half that still has teeth is the residual. Item 1284's mutation run showed that making
    // the decline sites `continue` WITHOUT collecting the conjunct makes it VANISH — neither
    // lifted nor residual — so the predicate answers a superset with every test passing.
    const rev = compilePredicate(undefined, { kind: 'and', items: [decl, eq('a', 50)] }, 'n');

    expect(rev.eqProps?.length ?? 0).toBe(1);
    expect(rev.cmpProps).toBeUndefined();
    expect(rev.where).toBeDefined();

    // A fully-admitted chain still has NO residual — the lift is unchanged where it already worked.
    const all = compilePredicate(undefined, { kind: 'and', items: [eq('a', 50), eq('b', 0)] }, 'n');

    expect(all.eqProps?.length ?? 0).toBe(2);
    expect(all.where).toBeUndefined();
  });

  /**
   * ⚠️ WHY THE SPLIT IS WHERE IT IS (item 1545), at the ANSWER level rather than the route level.
   *
   * The guard's own comment said `cmp`/`path` were held back because "an ordering comparison throws
   * on a cross-type pair". **In this engine it does not.** Seven operand pairs were tried — string
   * vs number, string vs DATE, list vs number, list vs list, record vs number, boolean vs number,
   * string vs record — and every one answers no-match (UNKNOWN), never a fault. So relaxing `cmp`
   * cost no error behaviour at all, which is the opposite of what the comment predicted and is why
   * the relaxation is a pure 1.46-2.52x.
   *
   * `truth` is genuinely raise-capable and stays held back. The two cases below are the difference,
   * and the second is the one that would break if the guard were relaxed wholesale.
   */
  test('a cross-type ORDERING comparison answers no-match, it does not raise', () => {
    // `s` is a string on every vertex. Lifted (no residual) and beside a residual, both fine.
    expect(ids('MATCH (n:P) WHERE n.s < 5 RETURN n.nm')).toEqual([]);
    expect(ids(`MATCH (n:P) WHERE n.s < 5 AND ${DECL} RETURN n.nm`)).toEqual([]);
    expect(ids(`MATCH (n:P) WHERE ${DECL} AND n.s < 5 RETURN n.nm`)).toEqual([]);
    expect(ids("MATCH (n:P) WHERE n.s < DATE '2024-01-01' RETURN n.nm")).toEqual([]);
  });

  test('a bare-property TRUTH test DOES raise, and the held-back guard is what suppresses it', () => {
    // Alone it raises: coercing the string `x` to a boolean is a data exception.
    expect(() => ids('MATCH (n:P) WHERE n.s RETURN n.nm')).toThrow();

    // Beside an unliftable conjunct that settles every row FALSE it does NOT, because `truth` is
    // held back and the residual runs first. Relax `raisesWhereTheChainWouldNot` for `truth` and
    // this line throws — which is also the TS-vs-native divergence
    // `and-short-circuit-conformance.test.ts` pins as AGREEING.
    expect(ids("MATCH (n:P) WHERE upper(n.s) = 'ZZZ' AND n.s RETURN n.nm")).toEqual([]);
  });

  test('⚠️ a RAISE-CAPABLE family does not lift ahead of a residual', () => {
    // THE CORRECTION THIS ITEM NEEDED, and a wrong answer rather than a missed optimisation.
    // `truthProps` reads a value and coerces it to a boolean, which RAISES on a non-boolean; the
    // generic `and` arm does not, because FALSE dominates and settles the row first. Lifting a bare
    // `prop` ahead of a residual therefore exposes a raise the whole-chain route suppresses, and it
    // showed up as a TS-vs-native divergence:
    //
    //   MATCH (n:P) WHERE n.s AND false            native ok []  TS ok [] -> ERR E_INVALID_VALUE
    //   MATCH (n:P) WHERE n.s AND n.n IS UNKNOWN   native ok []  TS ok [] -> ERR E_INVALID_VALUE
    //
    // So with a residual present, `truth`/`notTruth` may not lift.
    //
    // ⚠️ `cmp`/`path` USED TO BE HELD BACK HERE AND NO LONGER ARE (item 1545). An ordering
    // comparison does throw on a cross-type pair, so lifting one ahead of a residual can raise
    // where the chain settled the row FALSE first — a query that works today can start throwing on
    // mixed-type data. The owner took that trade on being shown it cost 1.55x on
    // `n.a < 1 AND <unliftable>` and 2.66x on the reverse spelling. `truth`/`notTruth` stay held
    // back because the two divergences quoted above are pinned as AGREEING in
    // `packages/native/src/and-short-circuit-conformance.test.ts`.
    const prop = (k: string): Expr => ({ kind: 'prop', variable: 'n', key: k });
    const decl: Expr = { kind: 'compare', op: '>=', left: prop('a'), right: prop('a') };

    // A bare `prop` (truth) ahead of an unreadable tail: NOTHING lifts.
    const t = compilePredicate(undefined, { kind: 'and', items: [prop('flag'), decl] }, 'n');

    expect(t.truthProps).toBeUndefined();
    expect(t.eqProps).toBeUndefined();
    expect(t.where).toBeDefined();

    // An ORDERING comparison ahead of an unreadable tail NOW LIFTS (item 1545), and the tail is
    // still the residual — the half that keeps its teeth, as at item 1544.
    const c: Expr = {
      kind: 'compare',
      op: '>',
      left: prop('a'),
      right: { kind: 'lit', value: 5 },
    };
    const m = compilePredicate(undefined, { kind: 'and', items: [c, decl] }, 'n');

    expect(m.cmpProps?.length ?? 0).toBe(1);
    expect(m.where).toBeDefined();

    // And a DOTTED comparison likewise, since `path` was relaxed with `cmp`.
    const d: Expr = {
      kind: 'compare',
      op: '>',
      left: { kind: 'propPath', variable: 'n', path: ['meta', 'size'] } as unknown as Expr,
      right: { kind: 'lit', value: 5 },
    };
    const dp = compilePredicate(undefined, { kind: 'and', items: [d, decl] }, 'n');

    // Either it lifted into `pathProps` or the shape is not what `asPathCompare` reads; both are
    // fine for this test, but the residual must exist in either case.
    expect(dp.where).toBeDefined();

    // CONTROL: the SAME families still lift when the chain is FULLY admitted, which has no
    // residual and so no row for the residual to have settled. This is the assertion that fails if
    // the guard is written without its `residual !== undefined` condition.
    const all = compilePredicate(undefined, { kind: 'and', items: [prop('flag'), c] }, 'n');

    expect(all.truthProps).toEqual(['flag']);
    expect((all.cmpProps ?? []).length).toBe(1);
    expect(all.where).toBeUndefined();
  });

  test('⚠️ a declining conjunct is not overtaken: the RAISE shapes are identical on both arms', () => {
    // `CAST(n.s AS INTEGER)` throws on a non-numeric string and is unliftable (its left operand is
    // a function call, not a property), which makes it the instrument for the ordering claim — a
    // reorder is otherwise invisible, since every answer here is the same either way.
    //
    // ⚠️ THE FIRST SHAPE DOES NOT THROW, AND NOT BECAUSE OF THIS ITEM. `n.a = 999` matches nothing,
    // an empty seed pre-empts the scan, and the cast is never reached — measured identical on both
    // arms. So this engine does NOT preserve raise order in general, and the prefix rule is more
    // conservative than what already holds rather than less. What this test pins is that the
    // prefix lift changed none of it:
    //
    //   CAST(s) = 1 AND a = 999    pre []     post []     (empty seed pre-empts the scan)
    //   a = 999 AND CAST(s) = 1    pre []     post []
    //   a = 50  AND CAST(s) = 1    pre THROW  post THROW  (rows survive, so the cast is reached)
    //   CAST(s) = 1                pre THROW  post THROW
    expect(
      query(g, `MATCH (n:P) WHERE CAST(n.s AS INTEGER) = 1 AND n.a = 999 RETURN n.nm AS nm`),
    ).toEqual([]);
    expect(
      query(g, `MATCH (n:P) WHERE n.a = 999 AND CAST(n.s AS INTEGER) = 1 RETURN n.nm AS nm`),
    ).toEqual([]);

    // RAISER LAST behind a conjunct some rows PASS: the cast is reached for those rows, so it
    // still throws. The lift must not swallow a raise that is genuinely reachable — this is the
    // assertion that fails if a lifted prefix were allowed to consume the residual.
    expect(() =>
      query(g, `MATCH (n:P) WHERE n.a = 50 AND CAST(n.s AS INTEGER) = 1 RETURN n.nm AS nm`),
    ).toThrow(/cannot cast/i);

    // And alone, where nothing lifts at all.
    expect(() => query(g, `MATCH (n:P) WHERE CAST(n.s AS INTEGER) = 1 RETURN n.nm AS nm`)).toThrow(
      /cannot cast/i,
    );
  });

  test('the mixed chain answers what the chain means, on every cell state', () => {
    // `n.a >= n.a` is UNKNOWN for the null and absent cells, so they drop; `a = 50` keeps v1/v2.
    expect(ids(`MATCH (n:P) WHERE n.a = 50 AND ${DECL} RETURN n.nm AS nm`)).toEqual(['v1', 'v2']);
    // The same question with the conjuncts swapped is the same answer — equivalent spellings must
    // not differ, which is this engine's named bug class and the reason the route test above
    // checks the swapped form compiles differently but answers the same.
    expect(ids(`MATCH (n:P) WHERE ${DECL} AND n.a = 50 RETURN n.nm AS nm`)).toEqual(['v1', 'v2']);

    // Two lifted conjuncts ahead of the decliner.
    expect(ids(`MATCH (n:P) WHERE n.a = 50 AND n.b = 0 AND ${DECL} RETURN n.nm AS nm`)).toEqual([
      'v1',
    ]);

    // THE RESIDUAL MUST STILL BE APPLIED. If it were dropped, this would return v1 and v2 — a
    // SUPERSET, which is the failure mode a forgotten residual produces.
    expect(ids(`MATCH (n:P) WHERE n.a = 50 AND n.b = 0 RETURN n.nm AS nm`)).toEqual(['v1']);
  });

  test('a residual of TWO conjuncts is rebuilt as an and, and both are applied', () => {
    // `rest.length > 1` takes the `and` branch. Both decliners have to survive: dropping either
    // returns a superset.
    expect(ids(`MATCH (n:P) WHERE n.a = 50 AND ${DECL} AND n.b >= n.b RETURN n.nm AS nm`)).toEqual([
      'v1',
      'v2',
    ]);

    // And one that actually filters, so a dropped second residual conjunct is visible as a row.
    expect(ids(`MATCH (n:P) WHERE n.a = 50 AND ${DECL} AND n.b = 0 RETURN n.nm AS nm`)).toEqual([
      'v1',
    ]);
  });

  test('a PARENTHESISED mixed chain agrees with the flat spelling', () => {
    // `flattenAnd` is depth-first and left-to-right, so parenthesisation cannot change which
    // conjunct is the first decliner — the prefix is the same either way. Item 1271's lesson: a
    // missed optimisation that PARENTHESES alone turn on is this engine's named bug class.
    for (const where of [
      `n.a = 50 AND n.b = 0 AND ${DECL}`,
      `(n.a = 50 AND n.b = 0) AND ${DECL}`,
      `n.a = 50 AND (n.b = 0 AND ${DECL})`,
    ]) {
      expect(ids(`MATCH (n:P) WHERE ${where} RETURN n.nm AS nm`)).toEqual(['v1']);
    }
  });

  test('the residual can read ANOTHER variable and the chain is still correct', () => {
    // A residual is only reached through a predicate the caller proved element-local, but the
    // oracle is worth having: a two-variable `WHERE` must answer the same as its generic self.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { nm: 'a', a: 50, b: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { nm: 'b', a: 50, b: 2 } });

    h.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    const rows = query(
      h,
      'MATCH (x:P)-[:E]->(y:P) WHERE x.a = 50 AND x.b <= y.b RETURN x.nm AS nm',
    );

    expect(rows.map((r) => String(r.nm))).toEqual(['a']);
  });
});
