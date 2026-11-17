/*
 * Item 2104 — `hop2Projection` declines at execution time when the matcher would seed from the other
 * end of the pattern.
 *
 * ⚠️⚠️ **THE DECLINE IS ANSWER-EQUIVALENT, so every mutant of it survives a behavioural test** — the
 * standing rule. What CAN be asserted is: (a) the answers are identical whichever route runs, for every
 * spelling; (b) the decline actually FIRES, by the only observable that distinguishes the routes.
 *
 * 🔑 (b) IS THE HARD HALF, and the observable is ROW ORDER. The rung walks from the pattern's written
 * start; the matcher it hands back to seeds the far end and emits in that order instead. Row order is
 * unspecified by policy — so this test does NOT assert a particular order. It asserts that the
 * oriented route produces a DIFFERENT order from the un-oriented one, which is only true if the
 * decline fired, and compares the two as SETS for correctness.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { CPath } from './executor/core.js';
import { shouldDeclineToOrientedMatcher } from './executor/hop2-projection.js';
import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

const build = (users: number, withIndex: boolean): Graph => {
  const g = new Graph();

  for (let u = 0; u < users; u += 1) {
    g.addVertex({ id: `u${u}`, labels: ['User'], properties: { name: `u${u}` } });
  }

  for (let t = 0; t < 4; t += 1) {
    g.addVertex({ id: `t${t}`, labels: ['Team'], properties: { name: `t${t}` } });
  }

  for (let d = 0; d < 4; d += 1) {
    g.addVertex({ id: `d${d}`, labels: ['Doc'], properties: { name: `d${d}` } });
  }

  let e = 0;

  /*
   * ⚠️⚠️ **THE MEMBERSHIPS ARE ADDED IN DESCENDING USER ORDER, AND THAT IS LOAD-BEARING.** The rung
   * emits in User-SCAN order (ascending id); the matcher, seeding the one Doc, emits in the TEAM's
   * adjacency order. Added ascending, those two coincide on this fixture — and three mutants against
   * the decline SURVIVED because of it, exactly as this file's header warned they could. Added
   * descending, the orders differ and the decline becomes observable.
   */
  for (let u = users - 1; u >= 0; u -= 1) {
    g.addEdge({
      id: `m${e}`,
      from: g.getVertexById(`u${u}`)!,
      to: g.getVertexById(`t${u % 4}`)!,
      labels: ['MEMBER_OF'],
      properties: {},
    });
    e += 1;
  }

  for (let t = 0; t < 4; t += 1) {
    g.addEdge({
      id: `c${e}`,
      from: g.getVertexById(`t${t}`)!,
      to: g.getVertexById(`d${t}`)!,
      labels: ['CAN_VIEW'],
      properties: {},
    });
    e += 1;
  }

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
  }

  return g;
};

const FWD =
  'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN u.name AS n';
const REV =
  'MATCH (d:Doc)<-[:CAN_VIEW]-(:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $d RETURN u.name AS n';

const namesOf = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => String(r.n));

describe('hop2Projection orientation decline (item 2104)', () => {
  test('⚠️ the ANSWER is identical whichever route runs — indexed and not', () => {
    for (const withIndex of [false, true]) {
      const g = build(40, withIndex);
      const fwd = namesOf(query(g, FWD, { d: 'd1' })).sort();
      const rev = namesOf(query(g, REV, { d: 'd1' })).sort();
      // A vacuous LIMIT defeats the rung's length gate, so this is the general matcher's own answer.
      const generic = namesOf(query(g, `${FWD} LIMIT 1000`, { d: 'd1' })).sort();

      expect(fwd).toStrictEqual(rev);
      expect(fwd).toStrictEqual(generic);
      expect(fwd.length).toBe(10);
    }
  });

  /*
   * ⚠️⚠️ **THE DECLINE HAS NO BEHAVIOURAL OBSERVABLE, AND TWO TESTS HERE TRIED TO FIND ONE AND FAILED.**
   * Both routes return the same rows IN THE SAME ORDER — measured `u37,u33,u29,u25` from the rung and
   * from the matcher, indexed or not. So the gate is tested DIRECTLY, which is the standing rule for a
   * route choice; three mutants survived the order-based attempt.
   */
  describe('shouldDeclineToOrientedMatcher — the gate itself', () => {
    const cPathOf = (src: string): CPath => {
      const parsed = parse(src) as never as { parts: readonly { clauses: readonly never[] }[] };
      const linear = compileLinear(parsed.parts[0]) as unknown as { clauses: readonly never[] };
      const match = (
        linear.clauses as readonly { kind: string; patterns?: readonly CPath[] }[]
      ).find((c) => c.kind === 'match');

      return match!.patterns![0];
    };

    test('🔑 WITH an index on the far key the rung HANDS BACK — the 59x case', () => {
      const g = build(40, true);

      expect(shouldDeclineToOrientedMatcher(g, cPathOf(FWD), { d: 'd1' })).toBe(true);
    });

    test('⚠️ WITHOUT an index it KEEPS the written order — a label bucket may not outvote', () => {
      /*
       * 🔑 `orient`'s own rule: a LABEL-BUCKET estimate is not evidence against the written start, so
       * with no seek available the pattern stays put and this rung must still answer. A decline here
       * would be a pure loss — the matcher would do the same scan with more overhead.
       */
      const g = build(40, false);

      expect(shouldDeclineToOrientedMatcher(g, cPathOf(FWD), { d: 'd1' })).toBe(false);
    });

    test('⚠️ written from the DOC already, it KEEPS the query — no needless flip-flop', () => {
      const g = build(40, true);

      expect(shouldDeclineToOrientedMatcher(g, cPathOf(REV), { d: 'd1' })).toBe(false);
    });

    test('⚠️ a QUANTIFIED segment is refused — reversing a quantified walk is not handled', () => {
      /*
       * 🔑 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED. `farEndSeeksNarrower` refuses a pattern with a
       * quantifier, mirroring `orient`'s own first gate ("patterns with a variable-length segment keep
       * their written orientation — reversing a quantified walk is not handled here"). Deleting that
       * clause changed no answer in this file until the shape was actually asked for.
       *
       * ⚠️ A quantified pattern never reaches `hop2Projection` anyway, so this guards the PREDICATE
       * rather than the rung — which is precisely why it needs its own assertion rather than relying
       * on a query.
       */
      const g = build(40, true);
      const quantified = cPathOf(
        'MATCH (u:User)-[:MEMBER_OF]->{1,2}(d:Doc) WHERE d.name = $d RETURN u.name AS n',
      );

      expect(shouldDeclineToOrientedMatcher(g, quantified, { d: 'd1' })).toBe(false);
    });

    test('with NO predicate at either end it keeps the written order', () => {
      const g = build(40, true);
      const plain = cPathOf(
        'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) RETURN u.name AS n',
      );

      /*
       * 🔑 THE NARROWING THAT MATTERS. `orient` WOULD reverse this (4 Docs against 40 Users, on bucket
       * size alone) — and that is no reason to give up this rung's fused walk, which items 1821/1822
       * measured at 13.8x. Only a genuine SEEK counts, so the gate says KEEP.
       */
      expect(shouldDeclineToOrientedMatcher(g, plain, {})).toBe(false);
    });
  });

  test('a pattern with NO far predicate is unaffected in either direction', () => {
    const g = build(40, true);
    const rows = query(
      g,
      'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) RETURN u.name AS n',
    );

    expect(rows).toHaveLength(40);
  });

  test('⚠️ the COMPOSING rungs inherit the decline and still answer correctly', () => {
    /*
     * `hop2FoldedAggregate` and `hop2GroupedCount` fold over this walk's rows, so they had to learn
     * the decline too — a fold over a handed-back walk has nothing to fold. Both answers are checked
     * against the generic path, which a vacuous `LIMIT` forces.
     */
    const g = build(40, true);
    const folded = query(
      g,
      `MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN min(u.name) AS m`,
      { d: 'd1' },
    );
    const grouped = query(
      g,
      `MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN d.name AS k, count(*) AS c`,
      { d: 'd1' },
    );

    expect(folded).toStrictEqual([{ m: 'u1' }]);
    expect(grouped).toStrictEqual([{ k: 'd1', c: 10 }]);
  });
});
