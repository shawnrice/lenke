import { describe, expect, test } from 'bun:test';

import type { Clause, MatchClause } from './ast.js';
import { liftStartProps } from './executor.js';
import { parse } from './parser.js';

/**
 * Item 1333: `liftStartProps` lifts inline start properties into the clause `WHERE` for
 * MULTI-PATTERN matches, where it used to refuse `patterns.length !== 1` outright.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE MUTATION SAID THE OTHER ONE WAS VACUOUS. `product-inline-lift.test.ts`
 * asserts that the braces spelling seeds rather than walking the label bucket — and restoring the
 * old refusal left every one of its assertions green, because inline props ALREADY seed through
 * `indexCandidates`'s `node.pred.props` path whether or not they are lifted. So the lift is NOT
 * what enables the seek, a seeding assertion cannot see the lift at all, and my first explanation
 * of the 1.86x was wrong on the mechanism even though the measurement stands.
 *
 * The rewrite is answer-equivalent by construction, so this follows the repo's own prescription
 * (`perf-gate-needs-its-own-test`): test the TRANSFORMATION directly.
 */

const clausesOf = (q: string): readonly Clause[] => {
  const stmt = parse(q);

  // A parsed statement is `{ parts, ops }`; each part carries the clause list. Every query here is
  // a single linear part, so the first one is the whole query.
  const [part] = (stmt as unknown as { parts: { clauses?: readonly Clause[] }[] }).parts;
  const clauses = part?.clauses;

  if (clauses === undefined) {
    throw new Error(`no clause list parsed from: ${q}`);
  }

  return clauses;
};

const matchOf = (q: string): MatchClause => {
  const lifted = liftStartProps(clausesOf(q));
  const match = lifted.find((c): c is MatchClause => c.kind === 'match');

  if (match === undefined) {
    throw new Error(`no match clause in: ${q}`);
  }

  return match;
};

/** The inline props still sitting on each pattern's start, by pattern index. */
const inlineCounts = (m: MatchClause): number[] =>
  m.patterns.map((p) => (p.start.properties ?? []).length);

describe('a multi-pattern MATCH lifts its inline start props', () => {
  test('props on the SECOND pattern lift, which is the whole item', () => {
    const m = matchOf('MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x');

    expect(m.where).toBeDefined();
    expect(inlineCounts(m)).toEqual([0, 0]);
  });

  test('props on BOTH patterns lift, and both conjuncts survive', () => {
    const m = matchOf('MATCH (a:S {k: 1}), (b:P {k: 7}) RETURN b.k AS x');

    expect(m.where).toBeDefined();
    expect(inlineCounts(m)).toEqual([0, 0]);
    // Two props from two patterns means an AND of two conjuncts, not one of them dropped.
    expect(m.where?.kind).toBe('and');
    expect((m.where as { items: readonly unknown[] }).items.length).toBe(2);
  });

  test('a single pattern WITH segments still lifts, as it did before', () => {
    const m = matchOf('MATCH (a:P {k: 7})-[:E]->(b) RETURN b.k AS x');

    expect(m.where).toBeDefined();
    expect(inlineCounts(m)).toEqual([0]);
  });
});

describe('the refusals, each of which a mutant tried to remove', () => {
  test('a SINGLE bare node stays inline — the scan rungs already serve it', () => {
    // Refused on measured grounds, unlike the multi-pattern refusal this item removed: braces and
    // the clause WHERE read 3.36 against 3.55 ms for a bare node, so lifting gains nothing.
    const m = matchOf('MATCH (b:P {k: 7}) RETURN b.k AS x');

    expect(m.where).toBeUndefined();
    expect(inlineCounts(m)).toEqual([1]);
  });

  test('a clause binding a PATH variable does not lift', () => {
    // The regression the suite caught: the collision in `MATCH p = …, (p:P …)` raises only because
    // the product shortcut DECLINES, and a lifted `where` routed it elsewhere so it answered 0.
    const m = matchOf('MATCH p = (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c');

    expect(m.where).toBeUndefined();
    expect(inlineCounts(m)).toEqual([1, 1]);
  });

  test('a clause that already carries a WHERE does not lift', () => {
    // Combining the two needs an AND whose operand order carries items 258/259's short-circuit
    // contract — still refused, and this pins that the refusal survived the multi-pattern change.
    const m = matchOf('MATCH (a:S), (b:P {k: 7}) WHERE b.grp = 1 RETURN b.k AS x');

    expect(inlineCounts(m)).toEqual([0, 1]);
  });

  test('a NULL literal stays inline, because it means IS NULL', () => {
    // Item 260, and the one refusal here that changes an ANSWER rather than a plan.
    const m = matchOf('MATCH (a:S), (b:P {k: null}) RETURN b.k AS x');

    expect(m.where).toBeUndefined();
    expect(inlineCounts(m)).toEqual([0, 1]);
  });

  test('a PARAM value stays inline, since it cannot be shown non-null at compile time', () => {
    const m = matchOf('MATCH (a:S), (b:P {k: $k}) RETURN b.k AS x');

    expect(m.where).toBeUndefined();
    expect(inlineCounts(m)).toEqual([0, 1]);
  });

  test('a QUANTIFIED segment stays inline', () => {
    // Item 778: a clause WHERE DISQUALIFIES the unbounded var-length BFS rung, so lifting here
    // made `reachability.test.ts` fault on the trail budget. One rung's admission gate is
    // another's disqualifier.
    const m = matchOf('MATCH (a:S), (b:P {k: 7})-[:E]->{1,3}(c) RETURN count(*) AS c');

    expect(inlineCounts(m)[1]).toBe(1);
  });

  test('a start with no VARIABLE stays inline — there is no name to write the predicate against', () => {
    const m = matchOf('MATCH (a:S), (:P {k: 7}) RETURN a.k AS x');

    expect(m.where).toBeUndefined();
    expect(inlineCounts(m)).toEqual([0, 1]);
  });

  test('a clause with NOTHING liftable is returned unchanged, not rebuilt', () => {
    /**
     * CLAUSE identity, not ARRAY identity. `liftStartProps` is `clauses.map(...)`, so it always
     * returns a NEW array — that was true before this item too, and my first version of this test
     * asserted `after).toBe(before` and failed for that reason. What the `conjuncts.length === 0`
     * guard actually preserves is each untouched clause's own identity, which is the property the
     * neighbouring rewrites in `compileLinear` can observe.
     */
    const before = clausesOf('MATCH (a:S), (b:P) RETURN b.k AS x');
    const after = liftStartProps(before);

    for (const [i, clause] of before.entries()) {
      expect(after[i]).toBe(clause);
    }
  });
});
