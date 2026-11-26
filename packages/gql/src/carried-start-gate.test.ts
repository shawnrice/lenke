import { describe, expect, test } from 'bun:test';

import { carriedStartGate } from './executor/reachability.js';
import { parse } from './parser.js';

/**
 * Which clause `WHERE` the reachability rung may carry (item 1906), as a pure function.
 *
 * EXTRACTED AND TESTED SEPARATELY for both of item 1903's reasons: the mistakes are
 * ANSWER-visible (a gate that admits a far-reading predicate would seed from the wrong set, which
 * is a wrong answer and not a slow one), and `detectReachableShortcut` sits on the complexity cap.
 */
const whereOf = (text: string) => {
  const stmt = parse(text);

  if (!('parts' in stmt)) {
    throw new Error('not a linear statement');
  }

  const [m] = stmt.parts[0].clauses;

  if (m.kind !== 'match') {
    throw new Error('not a match');
  }

  return m.where;
};

/** A stand-in compiled expression; the gate only checks that one EXISTS. */
const COMPILED = (() => true) as never;

describe('carriedStartGate', () => {
  const gate = (text: string, startVar: string | undefined = 'a') =>
    carriedStartGate(whereOf(text), COMPILED, startVar);

  test('no clause WHERE is `undefined` — not a decline', () => {
    expect(gate('MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x')).toBeUndefined();
  });

  test('a start-only predicate is CARRIED, with the variable it reads', () => {
    expect(
      gate('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = 1 RETURN DISTINCT b.n AS x'),
    ).toStrictEqual({ fn: COMPILED, variable: 'a' });
  });

  test('the operator does not matter — the gate is about which VARIABLE is read', () => {
    for (const w of ['a.n > 1', 'a.n IS NULL', 'a.n = 1 AND a.g = 2', 'NOT (a.n = 1)']) {
      expect(
        gate(`MATCH (a:T)-[:E]->{1,3}(b:T) WHERE ${w} RETURN DISTINCT b.n AS x`),
      ).not.toBeNull();
    }
  });

  /** THE FAR END IS A FILTER ON THE ANSWER, not on the seed set — a different computation. */
  test('a predicate reading the FAR variable declines', () => {
    expect(gate('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE b.n = 1 RETURN DISTINCT b.n AS x')).toBeNull();
  });

  test('a predicate reading BOTH declines', () => {
    expect(
      gate('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = b.n RETURN DISTINCT b.n AS x'),
    ).toBeNull();
  });

  /**
   * A LOOP-INVARIANT PREDICATE DECLINES RATHER THAN BEING CARRIED: it is a whole-query gate, not
   * a seed test, and the general path answers it without walking at all.
   */
  test('a predicate with no free variables declines', () => {
    expect(gate('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE 1 = 1 RETURN DISTINCT b.n AS x')).toBeNull();
  });

  /**
   * A SUBQUERY DECLINES, and it has to be refused EXPLICITLY: `freePredicateVars` does not
   * descend into one, so its names are invisible to the free-variable test and a subquery reading
   * the far end would pass it. A substituted subquery sort key was a live cross-engine divergence
   * at item 213.
   */
  test('a subquery declines even though its free-variable set looks empty', () => {
    expect(
      gate(
        'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE EXISTS { MATCH (a)-[:E]->(z:T) } RETURN DISTINCT b.n AS x',
      ),
    ).toBeNull();
  });

  /**
   * **THIS IS THE SPELLING THE `hasSubquery` GUARD ACTUALLY EXISTS FOR, and the mutation run
   * is what said so.** A BARE subquery declines without the guard too — `freePredicateVars` returns
   * the empty set for one, so `vars.size !== 1` already refuses it, and a mutant deleting the guard
   * SURVIVED the test above. In a CONJUNCTION the sibling supplies the start variable, so the free
   * set is `{a}` and the gate would admit a predicate whose subquery reads the FAR end — evaluated
   * per seed with `b` unbound.
   */
  test('a subquery reading the FAR end inside a start-only conjunction declines', () => {
    expect(
      gate(
        'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = 1 AND EXISTS { MATCH (b)-[:E]->(z:T) } RETURN DISTINCT b.n AS x',
      ),
    ).toBeNull();
  });

  /** An ANONYMOUS start cannot be read by a predicate, so there is nothing to carry. */
  test('no start variable declines', () => {
    expect(
      carriedStartGate(
        whereOf('MATCH (:T)-[:E]->{1,3}(b:T) WHERE b.n = 1 RETURN DISTINCT b.n AS x'),
        COMPILED,
        undefined,
      ),
    ).toBeNull();
  });

  /** A WHERE with no compiled counterpart cannot be evaluated, so it declines rather than passing. */
  test('a missing compiled expression declines', () => {
    expect(
      carriedStartGate(
        whereOf('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = 1 RETURN DISTINCT b.n AS x'),
        undefined,
        'a',
      ),
    ).toBeNull();
  });
});
