import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

// `WHERE n.flag IS TRUE` had no arm in `directEqProps` — the `isTruth` leaf item 1272 listed as
// declined and unpriced. Item 1286 lifts it into `truthTestProps`, beside `nullProps`, whose
// defining property it shares: the test is TOTAL and cannot raise.
//
// Priced at 200,000 vertices, ONE SHAPE PER PROCESS, min of three alternated rounds, against a
// `compare` arranged to keep EXACTLY the same rows so all of them answer an identical 20000:
//
//     n.flag IS TRUE            9.284 ms -> 3.567    2.60x
//     NOT (n.flag IS FALSE)     8.107    -> 3.559    2.28x
//     n.k IS UNKNOWN            9.424    -> 3.830    2.46x
//     [CTL] n.marker = true     3.531    -> 3.806    flat, already lifted via eqProps
//     [CTL] n.k IS NULL         3.108    -> 3.417    flat, already lifted via nullProps
//     [CTL] bare count          0.001    -> 0.001    flat
//
// ⚠️ THE `IS NULL` CONTROL IS WHY THIS IS THE RIGHT LAYER. `isNull` and `isTruth` are BOTH refused
// by `rowLocal`'s allowlist, so the node-count gate declines both — and `isNull` is fast anyway,
// because `pushWhereIntoNode` routes a clause `WHERE` through `compilePredicate` where item 1270
// gave it an arm. Two kinds, one gate, opposite costs: the allowlist was a red herring and the
// missing arm was the whole of it.
const build = (): Graph => {
  const g = new Graph();

  // SIX cell states, because `IS TRUE` distinguishes more of them than `= true` does.
  g.addVertex({ id: 'yes', labels: ['P'], properties: { nm: 'yes', flag: true } });
  g.addVertex({ id: 'no', labels: ['P'], properties: { nm: 'no', flag: false } });
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { nm: 'nulled', flag: null } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { nm: 'absent' } });
  // ⚠️ NON-BOOLEAN CELLS. `case 'isTruth'` is explicit that these are simply "no" rather than a
  // fault — "Unlike a boolean CONTEXT (WHERE / AND / CASE …), it does NOT fault on a non-boolean".
  // The lifted arm has to agree, or a query that answered starts throwing.
  g.addVertex({ id: 'str', labels: ['P'], properties: { nm: 'str', flag: 'x' } });
  g.addVertex({ id: 'num', labels: ['P'], properties: { nm: 'num', flag: 1 } });

  return g;
};

const g = build();
const ids = (where: string): string[] =>
  query(g, `MATCH (n:P) WHERE ${where} RETURN n.nm AS nm`)
    .map((r) => String(r.nm))
    .sort();
const countOf = (where: string): number =>
  Number(query(g, `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)[0].c);

describe('IS TRUE / IS FALSE / IS UNKNOWN lift (item 1286)', () => {
  test('⚠️ ROUTE: every spelling lands in truthTestProps and nothing is left behind', () => {
    // Answer-equivalent by design, so only the compiler can see the lift. Without this, a mutant
    // that never claims the shape passes every row assertion in the package.
    const lifted = (
      src: string,
    ): readonly { key: string; truth: boolean | null; negated: boolean }[] =>
      compilePredicate(undefined, parsePredicate(src), 'n').truthTestProps ?? [];

    expect(lifted('n.flag IS TRUE')).toEqual([{ key: 'flag', truth: true, negated: false }]);
    expect(lifted('n.flag IS NOT TRUE')).toEqual([{ key: 'flag', truth: true, negated: true }]);
    expect(lifted('n.flag IS FALSE')).toEqual([{ key: 'flag', truth: false, negated: false }]);
    // ⚠️ `IS UNKNOWN` IS NOT HERE — it folds into `nullProps`, because it IS `IS NULL` (both go
    // through `isNullish`) and because the native engine hoists it past a faulting sibling while
    // refusing to hoist `IS TRUE`/`IS FALSE`. Putting it in `truthTestProps` would be a
    // cross-engine divergence; `and-short-circuit-conformance.test.ts` holds the table.
    expect(
      compilePredicate(undefined, parsePredicate('n.flag IS UNKNOWN'), 'n').truthTestProps,
    ).toBeUndefined();
    expect(compilePredicate(undefined, parsePredicate('n.flag IS UNKNOWN'), 'n').nullProps).toEqual(
      [{ key: 'flag', negated: false }],
    );
    expect(
      compilePredicate(undefined, parsePredicate('n.flag IS NOT UNKNOWN'), 'n').nullProps,
    ).toEqual([{ key: 'flag', negated: true }]);

    // The `NOT (…)` spelling is folded by FLIPPING `negated`, not by a second list.
    expect(lifted('NOT (n.flag IS TRUE)')).toEqual([{ key: 'flag', truth: true, negated: true }]);
    expect(lifted('NOT (n.flag IS NOT TRUE)')).toEqual([
      { key: 'flag', truth: true, negated: false },
    ]);

    // Fully lifted means NOTHING for the generic evaluator — the item 277 failure is a gate that
    // reads only `where` and so sees an unconstrained predicate.
    expect(
      compilePredicate(undefined, parsePredicate('n.flag IS TRUE'), 'n').where,
    ).toBeUndefined();

    // A chain of them, in order, beside an equality.
    const mixed = compilePredicate(
      undefined,
      parsePredicate('n.a = 1 AND n.flag IS TRUE AND n.b IS FALSE'),
      'n',
    );

    expect((mixed.truthTestProps ?? []).length).toBe(2);
    expect((mixed.eqProps ?? []).length).toBe(1);
    expect(mixed.where).toBeUndefined();
  });

  test('a test on ANOTHER variable, or on a non-property, is not lifted', () => {
    expect(
      compilePredicate(undefined, parsePredicate('m.flag IS TRUE'), 'n').truthTestProps,
    ).toBeUndefined();
    // The subject must be a plain property read: a function call is not liftable here.
    expect(
      compilePredicate(undefined, parsePredicate('upper(n.s) IS TRUE'), 'n').truthTestProps,
    ).toBeUndefined();
  });

  test('⚠️ a NON-BOOLEAN cell is "no", NOT a fault', () => {
    // The semantic crux. `str` and `num` hold non-booleans; `IS TRUE` must answer false for them
    // and must not throw. A lifted arm that reached for a boolean coercion would fault here, which
    // is the wrong answer `truthProps` (the bare-prop family) legitimately produces in a boolean
    // CONTEXT and this family must not.
    expect(() => ids('n.flag IS TRUE')).not.toThrow();
    expect(ids('n.flag IS TRUE')).toEqual(['yes']);
    expect(ids('n.flag IS FALSE')).toEqual(['no']);
    // IS NOT TRUE keeps everything that is not exactly `true`: false, null, absent, and the two
    // non-booleans.
    expect(ids('n.flag IS NOT TRUE')).toEqual(['absent', 'no', 'nulled', 'num', 'str']);
  });

  test('IS UNKNOWN covers a STORED NULL and an ABSENT cell alike', () => {
    // `isNullish` reads both as null, which is this engine's settled rule — the lifted arm uses
    // the same function rather than re-deriving it.
    expect(ids('n.flag IS UNKNOWN')).toEqual(['absent', 'nulled']);
    expect(ids('n.flag IS NOT UNKNOWN')).toEqual(['no', 'num', 'str', 'yes']);
  });

  test('⚠️ IS TRUE and = true are NOT the same question, and must stay different', () => {
    // On THIS fixture `IS TRUE` and `= true` agree, because both drop a null. Their NEGATIONS do
    // not, and that is the assertion that fails if someone ever "unifies" the two families:
    //
    //   IS NOT TRUE  -> null and absent are kept (they are not TRUE)
    //   <> true      -> null and absent are UNKNOWN, and a filter keeps only clean TRUE, so both
    //                   drop; the non-booleans survive
    expect(ids('n.flag = true')).toEqual(['yes']);
    expect(ids('n.flag IS TRUE')).toEqual(['yes']);

    expect(ids('n.flag IS NOT TRUE')).toEqual(['absent', 'no', 'nulled', 'num', 'str']);
    expect(ids('n.flag <> true')).toEqual(['no', 'num', 'str']);
  });

  test('the lifted answer equals the GENERIC answer, spelling by spelling', () => {
    // The oracle: the same predicate wrapped so it cannot lift (no own-var is passed), compiled
    // and run through the generic evaluator. Any disagreement is the lift changing an answer.
    for (const where of [
      'n.flag IS TRUE',
      'n.flag IS NOT TRUE',
      'n.flag IS FALSE',
      'n.flag IS NOT FALSE',
      'n.flag IS UNKNOWN',
      'n.flag IS NOT UNKNOWN',
      'NOT (n.flag IS TRUE)',
      'NOT (n.flag IS UNKNOWN)',
    ]) {
      const direct = compilePredicate(undefined, parsePredicate(where), 'n');
      const generic = compilePredicate(undefined, parsePredicate(where), undefined);

      // One lifts, the other cannot — otherwise this oracle compares a route with itself. The
      // destination depends on the spelling (`IS UNKNOWN` folds into `nullProps`), so the check is
      // that SOMETHING lifted, not which list it landed in.
      const liftedCount = (direct.truthTestProps ?? []).length + (direct.nullProps ?? []).length;

      expect(liftedCount).toBeGreaterThan(0);
      expect(generic.truthTestProps).toBeUndefined();
      expect(generic.nullProps).toBeUndefined();

      // And the row sets agree. `countOf` goes through the tally, `ids` through the row path, so
      // both of this engine's answers for the shape are checked.
      expect(countOf(where)).toBe(ids(where).length);
    }
  });

  test('a test survives a HOP, where the far-end predicate is merged', () => {
    // `mergeFarPreds` has to carry the new list: dropping it returns a SUPERSET of rows, which is
    // the failure mode item 903 recorded for `pathProps`.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { nm: 'a', flag: true } });
    const t = h.addVertex({ id: 't', labels: ['Q'], properties: { nm: 't', flag: true } });
    const f = h.addVertex({ id: 'f', labels: ['Q'], properties: { nm: 'f', flag: false } });

    h.addEdge({ id: 'e1', from: a, to: t, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: f, labels: ['E'], properties: {} });

    const rows = query(h, 'MATCH (x:P)-[:E]->(y:Q) WHERE y.flag IS TRUE RETURN y.nm AS nm').map(
      (r) => String(r.nm),
    );

    expect(rows).toEqual(['t']);

    // And the INLINE spelling of the same question, which lands on the other side of the merge.
    const inline = query(h, 'MATCH (x:P)-[:E]->(y:Q WHERE y.flag IS TRUE) RETURN y.nm AS nm').map(
      (r) => String(r.nm),
    );

    expect(inline).toEqual(['t']);
  });

  test('an INLINE test actually filters — the item 277 class', () => {
    // A predicate that lifts ENTIRELY leaves `where` undefined, so any gate asking "is this node
    // constrained?" by looking only at `where` sees nothing and skips the filter. `hasPredicate` is
    // the one definition; this is the query that catches a carrier missing from it.
    const rows = query(g, 'MATCH (n:P WHERE n.flag IS TRUE) RETURN n.nm AS nm').map((r) =>
      String(r.nm),
    );

    expect(rows).toEqual(['yes']);

    const sub = query(
      g,
      'MATCH (n:P) WHERE EXISTS { MATCH (n WHERE n.flag IS TRUE) } RETURN n.nm AS nm',
    ).map((r) => String(r.nm));

    expect(sub).toEqual(['yes']);
  });

  test('it lifts AHEAD OF A RESIDUAL, because the test cannot raise', () => {
    // Item 1284 holds back `truth`/`notTruth`/`cmp`/`path` when a residual exists, because their
    // readings can raise where the whole-chain route would not. `isTruth` is in the other group
    // with `eq`/`nulls`/`member`: it is total, so it may lift.
    const prop = (k: string): Expr => ({ kind: 'prop', variable: 'n', key: k });
    const decl: Expr = { kind: 'compare', op: '>=', left: prop('z'), right: prop('z') };
    const pred = compilePredicate(
      undefined,
      { kind: 'and', items: [parsePredicate('n.flag IS TRUE'), decl] },
      'n',
    );

    expect((pred.truthTestProps ?? []).length).toBe(1);
    expect(pred.where).toBeDefined();
  });
});
