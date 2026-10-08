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

  test('THE DECLARED RESIDUAL: an UNKNOWN settling conjunct still differs', () => {
    // Pinned as a difference, not asserted away. `n.zz = 'a'` is UNKNOWN on every row (the key
    // is absent), and `and(null, false)` is `false`, so UNKNOWN cannot settle a Kleene `AND` —
    // the TS chain reaches `n.s` and raises. Native answers [] because a FILTER keeps only TRUE
    // rows, so its conjunct split drops the UNKNOWN row before the sibling is reached.
    //
    // Declared in `divergence-registry.ts` under
    // `boolean-context-dynamic-operand-under-seek`, route (1). If this ever starts AGREEING,
    // that is good news and this test should be moved up into the agreeing set rather than
    // deleted — it is the last of that entry's traffic, and the entry goes when it does.
    const q = "MATCH (n:P) WHERE n.zz = 'a' AND n.s RETURN n.n AS x";

    expect(outcome('ts', q)).toBe('ERR E_INVALID_VALUE');
    expect(outcome('native', q)).toBe('ok []');
  });
});
