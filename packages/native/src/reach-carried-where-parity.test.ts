// A CLAUSE `WHERE` ON THE START OF A VAR-LENGTH PATTERN, carried into the reachability rung
// (item 1906).
//
// THE GAP IT CLOSES IS THIS REPO'S FIRST-NAMED DEFECT CLASS. `CLAUDE.md` lists the shapes every
// index-seeding bug the old engine had took, and "a clause `WHERE` vs an inline `{k: $x}`" is one of
// them. Here the inline spelling reached `reachShortcut` and the clause spelling reached NO rung:
//
//     MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) RETURN DISTINCT b.n     342.45 ms
//     MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.n   2996.17   <- 8.75x
//     ... the same query with NO seed at all                        405.22   <- so seeding COST 7.4x
//
// The last line is audit item 159's rule — "a filter that makes a query slower is a declined fast
// path, not the cost of filtering" — and it is the thing that makes this a bug rather than a
// missing optimization.
//
// NATIVE IS THE ORACLE, because every spelling here returns the same rows and the risk is
// entirely in WHICH vertices the rung seeds from. A wrong seed set is a wrong answer that no
// same-engine comparison would catch: the TS rung and the TS general path could agree while both
// differed from native, and the inline spelling shares the rung the clause one now takes.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/**
 * A fixture where the SEED SET decides the answer.
 *
 * THE REACHABLE SETS OF THE TWO `n` GROUPS MUST DIFFER, or a wrong seed set would answer
 * correctly by accident — the same trap item 1903 paid for with a tie-heavy fixture. Here `n = 1`
 * vertices lead into the `k = 10..` chain and `n = 2` vertices into the `k = 20..` chain, with no
 * edge between the two components.
 */
const NDJSON = [
  // Component A: seeds with n = 1 reaching 10, 11, 12.
  '{"type":"node","id":"a0","labels":["T"],"properties":{"n":1,"k":1,"g":"A"}}',
  '{"type":"node","id":"a1","labels":["T"],"properties":{"n":9,"k":10,"g":"A"}}',
  '{"type":"node","id":"a2","labels":["T"],"properties":{"n":9,"k":11,"g":"A"}}',
  '{"type":"node","id":"a3","labels":["T"],"properties":{"n":9,"k":12,"g":"A"}}',
  // Component B: seeds with n = 2 reaching 20, 21.
  '{"type":"node","id":"b0","labels":["T"],"properties":{"n":2,"k":2,"g":"B"}}',
  '{"type":"node","id":"b1","labels":["T"],"properties":{"n":9,"k":20,"g":"B"}}',
  '{"type":"node","id":"b2","labels":["T"],"properties":{"n":9,"k":21,"g":"B"}}',
  // An isolated vertex, and one with a NULL `n` so an equality on it matches nothing.
  '{"type":"node","id":"z0","labels":["T"],"properties":{"n":null,"k":99,"g":"Z"}}',
  '{"type":"edge","id":"ea1","from":"a0","to":"a1","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"ea2","from":"a1","to":"a2","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"ea3","from":"a2","to":"a3","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"eb1","from":"b0","to":"b1","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"eb2","from":"b1","to":"b2","labels":["E"],"properties":{}}',
  '{"type":"edge","id":"ez","from":"z0","to":"b2","labels":["E"],"properties":{}}',
].join('\n');

describe.if(nativeReady)('a carried start WHERE seeds the same set native does', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** `[text, params]` — every shape the gate admits, and the near misses beside them. */
  const CASES: readonly [string, Record<string, unknown>][] = [
    // THE PAIR. These two must agree with each other AND with native.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    ['MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    // The other component, so a seed set that ignored the predicate would show.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 2 }],
    // No seed at all — the union of both components.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.k AS x ORDER BY x', {}],
    // A PREDICATE MATCHING NOTHING must answer empty rather than everything.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 77 }],
    // A NULL-VALUED key: `a.n = $p` with `$p` null is UNKNOWN, so no seed qualifies.
    [
      'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x',
      {
        p: null,
      },
    ],
    // A non-equality start predicate — carried the same way, since the gate is about which
    // VARIABLE is read, not which operator.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.k > $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.g = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 'A' }],
    // A conjunction, still start-only.
    [
      'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p AND a.g = $q RETURN DISTINCT b.k AS x ORDER BY x',
      {
        p: 1,
        q: 'A',
      },
    ],
    // `IS NULL` on the start: `z0` is the only seed, reaching `b2` only.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n IS NULL RETURN DISTINCT b.k AS x ORDER BY x', {}],
    // Other bounds and the unbounded forms, so the carried gate is exercised on every arm.
    ['MATCH (a:T)-[:E]->{1,1}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    ['MATCH (a:T)-[:E]->{0,2}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    ['MATCH (a:T)-[:E]->+(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    ['MATCH (a:T)-[:E]->*(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 1 }],
    // THE NEAR MISSES, which the rung DECLINES — carried here so a later change that admits one
    // of them has to come past this file with an answer.
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE b.k > $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 10 }],
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.g = b.g RETURN DISTINCT b.k AS x ORDER BY x', {}],
    ['MATCH (:T)-[:E]->{1,3}(b:T) WHERE b.k > $p RETURN DISTINCT b.k AS x ORDER BY x', { p: 10 }],
    // A count over the same seeded shape (its own rung refuses the seed in BOTH spellings — a
    // missing rung rather than a spelling gap, priced at item 1906 and still open).
    ['MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN count(*) AS c', { p: 1 }],
    ['MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) RETURN count(*) AS c', { p: 1 }],
  ];

  for (const [text, params] of CASES) {
    test(`${text}  ${JSON.stringify(params)}`, () => {
      const a = JSON.stringify(tsQuery(ts, text, params));

      expect(a).toBe(JSON.stringify(nat.query(text, params)));
    });
  }

  /**
   * THE TWO SPELLINGS AGAINST EACH OTHER, which is the claim the whole item is about — and a
   * separate assertion from agreeing with native, because they could both be wrong in the same way
   * only if native were too.
   */
  test('the clause and inline spellings answer identically on every NON-NULL seed value', () => {
    /*
     * **NULL IS EXCLUDED BECAUSE THE TWO SPELLINGS ARE NOT THE SAME QUESTION THERE, and that
     * is a settled engine semantic rather than this item's business.** With `$p` null:
     *
     *     WHERE a.n = $p     ->  []            three-valued equality, UNKNOWN matches nothing
     *     (a:T {n: $p})      ->  the row       a property-value match, and null is a PRESENT
     *                                          value here ([[null-first-class-policy]])
     *
     * Verified to hold in BOTH engines and for the node, hop AND var-length shapes alike, so it
     * is consistent policy and not a divergence — the `{ p: null }` case above asserts the clause
     * spelling against native directly. It is written down because "equivalent spellings must cost
     * the same" only binds where they ARE equivalent, and this pair is the exception.
     */
    for (const p of [1, 2, 9, 77]) {
      const clause = tsQuery(
        ts,
        'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x',
        { p },
      );
      const inline = tsQuery(
        ts,
        'MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) RETURN DISTINCT b.k AS x ORDER BY x',
        { p },
      );

      expect(clause).toStrictEqual(inline);
    }
  });

  /** AND NOT EVERY ANSWER IS EMPTY — two engines agree trivially on nothing. */
  test('the seeded shapes return rows, and DIFFERENT rows per component', () => {
    const q = 'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN DISTINCT b.k AS x ORDER BY x';

    expect(tsQuery(ts, q, { p: 1 })).toStrictEqual([{ x: 10 }, { x: 11 }, { x: 12 }]);
    expect(tsQuery(ts, q, { p: 2 })).toStrictEqual([{ x: 20 }, { x: 21 }]);
    expect(tsQuery(ts, q, { p: 77 })).toStrictEqual([]);
  });
});
