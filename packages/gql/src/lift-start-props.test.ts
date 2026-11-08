import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause, MatchClause } from './ast.js';
import { normalizeLiterals } from './auto-param.js';
import { liftStartProps } from './executor/rewrites.js';
import { query } from './index.js';
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

describe('item 1558: a SINGLE bare node lifts too, and the refusal that blocked it was mispriced', () => {
  // The refusal here used to read "the scan rungs already serve it and the lift gains nothing —
  // measured equal at 3.36 against 3.55 ms". That equality came from timing all three spellings of
  // the group in ONE process, where the clause arm runs second through sites the inline arm has
  // just made polymorphic. One shape per process: inline is 1.37-1.56x slower WITHOUT the lift
  // (0.26/3.79/11.81 against 0.19/2.43/7.93) and both twins are flat.
  test('it lifts', () => {
    const m = matchOf('MATCH (b:P {k: 7}) RETURN b.k AS x');

    expect(m.where).toBeDefined();
    expect(inlineCounts(m)).toEqual([0]);
  });

  // ⚠️ THE ROUTE ASSERTION ABOVE IS NOT ENOUGH, and this is the half that matters: item 778 records
  // that lifting on a bare node is exactly where "one rung's admission gate is another rung's
  // disqualifier" bit — a lifted clause `WHERE` disqualified the unbounded BFS rung and turned two
  // `reachability.test.ts` passes into errors. So pin ANSWERS, for the bare node and for the
  // quantified shape next to it that must still refuse.
  test('the answers are unchanged, including the quantified neighbour that still refuses', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: { k: 2 } });
    const c = g.addVertex({ id: 'c', labels: ['N'], properties: { k: 1 } });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
    g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });

    // The lifted shape: a bare node with an inline property, both spellings and the empty case.
    expect(query(g, 'MATCH (n:N {k: 1}) RETURN count(*) AS c')[0]?.c).toBe(2);
    expect(query(g, 'MATCH (n:N) WHERE n.k = 1 RETURN count(*) AS c')[0]?.c).toBe(2);
    expect(query(g, 'MATCH (n:N {k: 9}) RETURN count(*) AS c')[0]?.c).toBe(0);

    // The quantified rung the lift must NOT reach — item 778's actual regression.
    expect(query(g, 'MATCH (n:N {k: 1})-[:E]->+(m) RETURN count(DISTINCT m) AS c')[0]?.c).toBe(2);
  });
});

describe('the refusals, each of which a mutant tried to remove', () => {
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

  /**
   * ⚠️ THE COMPOSED SHAPE, which is what actually broke (item 1556).
   *
   * Every route test above feeds `liftStartProps` a freshly PARSED query — and that is not the
   * path a real query takes. Auto-parameterization (item 1502) runs BEFORE the parse, so
   * `MATCH (a:P {k: 5})` reaches this rewrite as `{k: $__ap0}`, a `param` and not a `lit`. The old
   * gate refused params outright, so item 778's rewrite was silently off for every inline-literal
   * query: 51.44 ms against the clause twin's 9.47, caught by `bun run spelling` and not by any
   * test, because every test here parsed the UNLIFTED text.
   *
   * `rewrite-composition-is-not-free` is the standing rule this breaks: assert the COMPOSED shape,
   * not each rewrite against hand-written input.
   */
  test('⚠️ COMPOSED: an inline literal survives auto-parameterization and still lifts', () => {
    const q = 'MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x';
    const lifted = normalizeLiterals(q);

    // The premise: auto-param really does rewrite this position into a synthetic param.
    expect(lifted?.text).toContain('$__ap');

    // And the rewrite still fires on what the parser then sees.
    const m = matchOf(lifted?.text ?? q);

    expect(m.where).toBeDefined();
    expect(inlineCounts(m)).toEqual([0, 0]);
  });

  test('a SYNTHETIC param lifts where a USER param does not', () => {
    const synthetic = matchOf('MATCH (a:S), (b:P {k: $__ap0}) RETURN b.k AS x');

    expect(synthetic.where).toBeDefined();
    expect(inlineCounts(synthetic)).toEqual([0, 0]);

    // The user's own name is still refused — item 260's null case, which the synthetic namespace
    // cannot reach because `normalizeLiterals` never lifts `null`.
    const user = matchOf('MATCH (a:S), (b:P {k: $k}) RETURN b.k AS x');

    expect(user.where).toBeUndefined();
  });

  /**
   * ⚠️ THE ANSWER, not the route — the guard the refusals above were missing (item 1556).
   *
   * Every other test here asserts whether `where` is defined, which a route mutant can satisfy
   * while changing rows. These numbers are what item 260 is actually about: an inline `{k: …}`
   * means IS NULL, so a null value matches BOTH the stored-null vertex and the absent-key one,
   * while the clause form it would be lifted to matches NEITHER.
   */
  test('⚠️ ANSWERS: lifting a user param would turn 2 rows into 0', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: null } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 5 } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    for (const [i, v] of [a, b, c].entries()) {
      g.addEdge({ id: `e${i}`, from: v, to: a, labels: ['E'], properties: {} });
    }

    const n = (q: string, params?: Record<string, unknown>): number => query(g, q, params).length;

    // IS NULL semantics: the stored null AND the absent key.
    expect(n('MATCH (x:P {k: null})-[:E]->(y) RETURN y.k AS v')).toBe(2);
    expect(n('MATCH (x:P {k: $p})-[:E]->(y) RETURN y.k AS v', { p: null })).toBe(2);
    // The clause form means equality, and nothing equals null.
    expect(n('MATCH (x:P)-[:E]->(y) WHERE x.k = null RETURN y.k AS v')).toBe(0);
    expect(n('MATCH (x:P)-[:E]->(y) WHERE x.k = $p RETURN y.k AS v', { p: null })).toBe(0);
    // And the NON-null spellings agree with each other, which is what the lift relies on.
    expect(n('MATCH (x:P {k: 5})-[:E]->(y) RETURN y.k AS v')).toBe(1);
    expect(n('MATCH (x:P {k: $p})-[:E]->(y) RETURN y.k AS v', { p: 5 })).toBe(1);
    expect(n('MATCH (x:P)-[:E]->(y) WHERE x.k = 5 RETURN y.k AS v')).toBe(1);
  });

  test('normalizeLiterals never mints a NULL synthetic, which is what makes the above sound', () => {
    // If this ever starts lifting, the synthetic admission above becomes item 260's wrong answer.
    expect(normalizeLiterals('MATCH (b:P {k: null}) RETURN b.k AS x')).toBeUndefined();
    expect(normalizeLiterals('MATCH (b:P {k: true}) RETURN b.k AS x')).toBeUndefined();
    // Numbers and strings DO lift — including 0, which is falsy and must not be mistaken for null.
    expect(normalizeLiterals('MATCH (b:P {k: 0}) RETURN b.k AS x')?.params).toEqual({ __ap0: 0 });
    expect(normalizeLiterals("MATCH (b:P {s: 'x'}) RETURN b.s AS x")?.params).toEqual({
      __ap0: 'x',
    });
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
