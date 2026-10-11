// `AND` short-circuits on FALSE in BOTH engines, and the one case where they still differ is
// the declared one. `packages/gql/src/and-short-circuit.test.ts` pins the contract; this file
// is what says the contract is SHARED, which is the part a single-engine test cannot establish.
//
// Worth having as its own file rather than leaving it to the differential fuzzer: the fuzzer
// generates a raising operand beside a settling one only occasionally, and the distinction that
// matters here — FALSE settles, UNKNOWN does not — needs a fixture built with both an absent
// key and a stored null, which the fuzzer's fixture has but its generator rarely pairs with a
// faulting sibling. Each case below is one the engines got different answers for at some point
// during the change.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  // `s` is a STRING, so coercing it to a truth value is a data exception — and it is
  // DYNAMICALLY typed, so neither engine's static boolean-context check can catch it.
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1,"s":"a"}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2,"s":"b"}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3,"s":"c"}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('AND short-circuit: the TS and native engines agree', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const codeOf = (e: unknown): string => (e as { code?: string } | undefined)?.code ?? 'NO_CODE';

  // Row order without `ORDER BY` is unspecified, so the comparison is a multiset — sorting the
  // rendered rows rather than asserting a sequence (see `order-is-unspecified`).
  const outcome = (engine: 'ts' | 'native', q: string): string => {
    try {
      const r = (engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q)) as unknown[];

      // Joined, not `JSON.stringify`d as an array — wrapping the already-rendered rows escapes
      // every quote again and makes a `toContain('"x":1')` assertion silently unsatisfiable.
      return `ok [${[...r]
        .map((x) => JSON.stringify(x))
        .sort()
        .join('|')}]`;
    } catch (e) {
      return `ERR ${codeOf(e)}`;
    }
  };

  const agree = (q: string): string => {
    const ts = outcome('ts', q);
    const nat = outcome('native', q);

    expect(`${q}\n  ${ts}`).toBe(`${q}\n  ${nat}`);

    return ts;
  };

  test('a FALSE conjunct settles the row and the throwing sibling is skipped', () => {
    expect(agree('MATCH (n:P) WHERE n.n = 99 AND n.s RETURN n.n AS x')).toStartWith('ok');
    expect(agree('MATCH (n:P) WHERE n.n = 99 AND n.s + 1 > 0 RETURN n.n AS x')).toStartWith('ok');
    expect(agree('RETURN (false AND (1.0 / 0.0)) AS r')).toContain('false');
    expect(agree('RETURN (true AND false AND (1.0 / 0.0)) AS r')).toContain('false');
    expect(agree("RETURN (false AND trim(3) = 'x') AS r")).toContain('false');
  });

  test('CONTROL an ESSENTIAL raising conjunct still raises in both', () => {
    // Without these the suite would pass for two engines that had both stopped evaluating
    // the tail of every chain.
    expect(agree('MATCH (n:P) WHERE n.n > 0 AND n.s RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
    expect(agree('MATCH (n:P) WHERE n.n = 1 AND n.s RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
  });

  test('WRITTEN ORDER: a raising conjunct placed first is reached in both', () => {
    // Neither engine reorders here, and that symmetry is the reason the TS side does not
    // partition its conjuncts by cost: native reorders only where its optimizer can seed a
    // conjunct out of the chain, and in a projection it does not reorder at all.
    expect(agree('RETURN ((1.0 / 0.0) AND false) AS r')).toBe('ERR E_INVALID_VALUE');
    expect(agree('RETURN (0 AND (1 IS NULL)) AS r')).toBe('ERR E_INVALID_VALUE');
    expect(agree('RETURN (null AND (1.0 / 0.0)) AS r')).toBe('ERR E_INVALID_VALUE');
  });

  test('OR and XOR are eager in both', () => {
    expect(agree('RETURN (true OR (1.0 / 0.0)) AS r')).toBe('ERR E_INVALID_VALUE');
    expect(agree('RETURN (false XOR (1.0 / 0.0)) AS r')).toBe('ERR E_INVALID_VALUE');
    expect(agree('MATCH (n:P) WHERE n.n > 0 OR n.s RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
    // The shape the engine's own `narrowing_is_transparent` doc comment cites, caught by the
    // differential fuzzer: the left operand is TRUE on every row, so narrowing the right to a
    // zero-row batch would skip the coercion and answer where TS raises.
    expect(agree("RETURN ((NOT (3 IS UNKNOWN)) OR 'nan') AS r")).toBe('ERR E_INVALID_VALUE');
  });

  test('three-valued answers are unchanged by the short-circuit', () => {
    expect(agree('RETURN (null AND false) AS r')).toContain('false');
    expect(agree('RETURN (null AND true) AS r')).toContain('null');
    expect(agree('RETURN (true OR null) AS r')).toContain('true');
    expect(agree('RETURN (false OR null) AS r')).toContain('null');
  });

  test('NOT around a short-circuited AND negates FALSE in both', () => {
    // This is the shape that FORCED the engines to be reconciled rather than the difference
    // declared: TS returned three rows while native raised, and an error against a NON-EMPTY
    // result is something `divergence-registry.ts` explicitly may not excuse.
    // All three rows, not merely "no error": `NOT false` is TRUE, so nothing is filtered out.
    expect(agree('MATCH (n:P) WHERE NOT (n.n = 99 AND n.s) RETURN n.n AS x')).toBe(
      'ok [{"x":1}|{"x":2}|{"x":3}]',
    );
  });

  test('an aggregate VALUE subquery is rejected statically by both', () => {
    // The gap the short-circuit exposed. Native rejected this at PLAN time while TS reached
    // the operand per row — the same code by two routes, which read as agreement until a FALSE
    // conjunct stopped the row being evaluated. A static reject is order-independent, so it is
    // the route that survives short-circuiting; TS's `definitelyNonBool` gained the arm.
    expect(
      agree(
        'MATCH (n:P) WHERE n.n = 99 AND VALUE { MATCH (n)-[:E]->(b) RETURN count(*) } RETURN n.n AS x',
      ),
    ).toBe('ERR E_INVALID_VALUE');
    // On an EMPTY match too, which is what makes it static: no `Q` exists, so no row could
    // have reached the operand.
    expect(
      agree('MATCH (n:Q) WHERE VALUE { MATCH (n)-[:E]->(b) RETURN count(*) } RETURN n.n AS x'),
    ).toBe('ERR E_INVALID_VALUE');
  });

  test('a non-aggregate VALUE subquery stays dynamic and is skipped by both', () => {
    expect(
      agree(
        'MATCH (n:P) WHERE n.n = 99 AND VALUE { MATCH (n)-[:E]->(b) RETURN b.n } RETURN n.n AS x',
      ),
    ).toStartWith('ok');
    // CONTROL: reached when the sibling admits rows, and a number in a truth position faults.
    expect(
      agree('MATCH (n:P) WHERE n.n > 0 AND VALUE { MATCH (n)-[:E]->(b) RETURN 7 } RETURN n.n AS x'),
    ).toBe('ERR E_INVALID_VALUE');
    // And a boolean-returning one must not be rejected: it gates, and vertex 1's only
    // out-edge lands on `n = 2`.
    expect(
      agree('MATCH (n:P) WHERE VALUE { MATCH (n)-[:E]->(b) RETURN b.n > 1 } RETURN n.n AS x'),
    ).toContain('"x":1');
  });

  test('WAS THE DECLARED RESIDUAL: an UNKNOWN settling conjunct now agrees', () => {
    // This test asserted a DIFFERENCE until 2026-10-09 — `ERR E_INVALID_VALUE` against
    // `ok []` — and its comment said that if it ever started agreeing it should move up into
    // the agreeing set rather than be deleted, because it was the last of the
    // `boolean-context-dynamic-operand-under-seek` entry's traffic and the entry goes when it
    // does. Both halves of that happened: the entry is gone from `divergence-registry.ts`.
    //
    // `n.zz = 'a'` is UNKNOWN on every row (the key is absent). Native always answered []
    // because a FILTER keeps only TRUE rows and its conjunct split drops the UNKNOWN row
    // before the sibling is reached; TS now reads a filter the same way (`filterPredicate`,
    // testing `!== true`) instead of applying Kleene `AND`'s weaker FALSE-only settling.
    expect(agree("MATCH (n:P) WHERE n.zz = 'a' AND n.s RETURN n.n AS x")).toBe('ok []');
  });

  test('WAS THE OTHER RESIDUAL: the REVERSED spelling now agrees', () => {
    // `WHERE <raising> AND <seekable>`, the error-against-a-NON-EMPTY-result shape the
    // registry was not permitted to declare and the differential fuzzer does not generate.
    // Native never raised — its seek hoists the seekable conjunct and never visits the
    // faulting row. TS now puts the conjunct that cannot raise first, for the same reason it
    // may: in a filter, conjunct order is unobservable.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n = 99 RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) FILTER n.s AND n.n = 99 RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) WITH n WHERE n.s AND n.n = 99 RETURN n.n AS x')).toBe('ok []');
    // A bare literal conjunct takes a different route in the engine (`try_filter_keep`
    // declines it, so it reaches the general path), which is why it is listed separately.
    expect(agree('MATCH (n:P) WHERE n.s AND false RETURN n.n AS x')).toBe('ok []');
    // CONTROL: the seekable conjunct MATCHES, so the raising one is essential either way.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n = 1 RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
  });

  test('THE ORDERING KEY IS SHARED: each of these was a divergence until it was', () => {
    // A filter reorders its conjuncts in BOTH engines, so the two must agree on WHICH conjuncts
    // cannot raise. They did not, three times, and each mismatch was found by the differential
    // fuzzer on random seeds — so each is pinned here deterministically. A narrower key in one
    // engine is not caution, it is disagreement.
    //
    // THE SAFE CONJUNCT IS WRITTEN SECOND IN EVERY LINE, and that is the whole point. Written
    // FIRST, these pass whatever the ordering key says — item 258's FALSE short-circuit already
    // settles the row in written order and the raising sibling is never reached. Mutation caught
    // exactly that: narrowing the key back to `=`/`<>` (T4) and dropping the negated-literal arm
    // (T5) both SURVIVED the first version of this test, which had them the other way round.
    // Only the reversed spelling makes the REORDER observable.
    //
    // 1. ORDERED comparisons. TS admitted only `=` and `<>` at first, on the sound-looking
    //    ground that a cross-type `<=` throws where `=` is a no-match. The engine admits any
    //    operator. 41 divergences in one 20,000-query run.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n < 0 RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) WHERE n.s AND n.n > 99 RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) WHERE n.s AND n.n >= 99 RETURN n.n AS x')).toBe('ok []');
    // 2. A NEGATED NUMERIC LITERAL. `-1` is `neg(lit)` in the TS AST and a folded
    //    `Lit(Num(-1.0))` in the engine, where a `Lit` is operand-safe and a `Neg` is not.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n = -1 RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) WHERE n.s AND n.n < -1 RETURN n.n AS x')).toBe('ok []');
    // 3. NESTED parenthesized groups. A same-operator run folds into one n-ary `and` in the TS
    //    AST but a parenthesized group does not, so `(A AND B) AND (C AND D)` is two conjuncts
    //    there and four in the engine — which could hoist a safe conjunct out of the second
    //    group where TS could not. Each group here holds one raising and one safe conjunct, so
    //    only a RECURSIVE flatten finds a safe conjunct to put first.
    expect(
      agree('MATCH (n:P) WHERE (n.s AND n.n > 99) AND (n.n < 0 AND n.s) RETURN n.n AS x'),
    ).toBe('ok []');
    // 4. `IS TRUE` / `IS FALSE` / `IS UNKNOWN` — item 322. The key left `isTruth` out with a
    //    comment claiming "a conservative omission costs only a missed reorder"; the engine's
    //    `can_raise` admits the node, so it cost a divergence instead, on roughly one random
    //    differential seed in three. The tell was that `IS NULL`, which the key DOES admit,
    //    already agreed on the identical shape.
    //    THE SETTLING ONE IS THE TEST: `n.n IS UNKNOWN` is FALSE for a present property, so it
    //    settles the row and the raising sibling is skipped. Its siblings below are TRUE, which
    //    settles nothing in a filter, so the sibling stays essential and BOTH raise — those are
    //    controls for this arm, not failures of it. Every expectation here was MEASURED; a first
    //    version reasoned them out and got two of six wrong.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS UNKNOWN RETURN n.n AS x')).toBe('ok []');
    expect(agree('MATCH (n:P) WHERE n.s AND n.zz IS UNKNOWN RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS NOT UNKNOWN RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    // ONLY the UNKNOWN form is admitted, because only it is admitted by the engine. Widening
    // this arm to all three truth values introduced two NEW divergences the other way round —
    // these answered `ok []` here while the engine raised. Being WIDER in one engine is the same
    // mistake as being narrower.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS TRUE RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS FALSE RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS NOT TRUE RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    // Why the arm recurses with `valueCannotRaise` and not `truthCannotRaise`: a non-boolean
    // operand of a boolean test is NOT a fault in either engine — it is simply not that truth
    // value — while the OPERAND itself still raises, which is what that recursion tests.
    expect(agree('MATCH (n:P) RETURN (n.s IS UNKNOWN) AS x')).toStartWith('ok');
    expect(agree("RETURN (split('a,b', -1) IS UNKNOWN) AS x")).toBe('ERR E_INVALID_VALUE');
    // THE OPERAND MATTERS, and this is the only shape that proves it. A mutant claiming
    // `IS UNKNOWN` is safe REGARDLESS of its operand survived every line above: with the test
    // written FIRST and a settling sibling second, calling it safe makes every conjunct safe, so
    // the reorder never fires at all and written order reaches the raising operand. Calling it
    // correctly leaves the pair MIXED, the sibling goes first, and the row is dropped.
    expect(
      agree("MATCH (n:P) WHERE (split('a,b', -1) IS UNKNOWN) AND n.n = 99 RETURN n.n AS x"),
    ).toBe('ok []');
    // CONTROLS for that line: a sibling that MATCHES leaves the raising operand essential, and a
    // sibling that is itself a non-settling `IS UNKNOWN` does too.
    expect(
      agree("MATCH (n:P) WHERE (split('a,b', -1) IS UNKNOWN) AND n.n = 1 RETURN n.n AS x"),
    ).toBe('ERR E_INVALID_VALUE');
    expect(
      agree("MATCH (n:P) WHERE (split('a,b', -1) IS UNKNOWN) AND n.zz IS UNKNOWN RETURN n.n AS x"),
    ).toBe('ERR E_INVALID_VALUE');
    // 5. STAYS OUT, measured rather than assumed: `IS TYPED` lowers to a cast, which the
    //    engine's `can_raise` calls raising, so neither engine hoists it; and `IS LABELED` is
    //    TRUE here, so it settles nothing and the raising sibling is essential either way.
    //    Admitting either would be the mirror-image mistake.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS TYPED INTEGER RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    expect(agree('MATCH (n:P) WHERE n.s AND n IS LABELED P RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    // CONTROL for all of them: a safe conjunct that MATCHES leaves the raising one essential,
    // whichever side it is written.
    expect(agree('MATCH (n:P) WHERE n.s AND n.n < 99 RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
    expect(agree('MATCH (n:P) WHERE n.n > -1 AND n.s RETURN n.n AS x')).toBe('ERR E_INVALID_VALUE');
    expect(agree('MATCH (n:P) WHERE n.s AND n.n IS NOT NULL RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
    // And the arm that was already there, on the shape that exposed the missing one: `IS NULL`
    // agreeing here while `IS UNKNOWN` diverged is what identified the gap.
    expect(agree('MATCH (n:P) WHERE n.s AND n.zz IS NULL RETURN n.n AS x')).toBe(
      'ERR E_INVALID_VALUE',
    );
  });

  test('a VALUE position keeps written order in both, which is what bounds the above', () => {
    // The filter rule must not leak into a value context: there the conjunction's VALUE is the
    // answer, UNKNOWN is one of its three values, and `and(null, false)` is `false` — so a
    // later conjunct can still change the result and is essential. Same two conjuncts as the
    // filter case above, opposite outcome, both engines.
    expect(agree("MATCH (n:P) RETURN (n.zz = 'a' AND n.s) AS x")).toBe('ERR E_INVALID_VALUE');
    expect(agree('MATCH (n:P) RETURN (n.s AND n.n = 99) AS x')).toBe('ERR E_INVALID_VALUE');
  });
});
