// A START PREDICATE carried into the var-length COUNT rung (item 1907), against native.
//
// ⚠️⚠️ **THE ARITHMETIC IS THE RISK, NOT THE GATE.** This rung does not walk paths — it counts them
// with degree arithmetic, a level recurrence, and closed-form trail corrections at depths 3 and 4.
// Restricting the SOURCES is sound because every arm accumulates over the source list (the level
// arrays span all vertices, as they must, but the answer is read off as `sum over sources`), and
// `trailCorrectionAt` / `trailsAt4From` take a source index. ⚠️ That is an argument, so it is
// checked against native — which has carried a seed mask since item 575 and is therefore the
// reference implementation for exactly this question.
//
// ⚠️ THE FIXTURE IS ITEM 573'S, deliberately: a cycle (so the path MODES differ), a SELF-LOOP (the
// depth-3 trail correction's only witness), a PARALLEL pair (what breaks a naive correction — two
// parallel `a -> b` edges are two walks but the trail terms must not double-subtract), a
// MULTI-LABEL edge (summing per-label bucket sizes counts it twice), a second edge type, and an
// ISOLATED vertex. A seed filter interacts with all of them.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P","Q"],"properties":{"n":1,"g":"a"}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2,"g":"a"}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3,"g":"b"}}',
  '{"type":"node","id":"4","labels":["P","Q"],"properties":{"n":4,"g":"b"}}',
  '{"type":"node","id":"iso","labels":["P"],"properties":{"n":9,"g":"c"}}',
  // A vertex with NO `n`, so an equality on it matches nothing and `IS NULL` matches only it.
  '{"type":"node","id":"nul","labels":["P"],"properties":{"g":"c"}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"2","to":"3"}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"3","to":"1"}',
  // THE SELF-LOOP — the trail correction's witness.
  '{"type":"edge","id":"e4","labels":["T"],"from":"1","to":"1"}',
  // THE PARALLEL PAIR.
  '{"type":"edge","id":"e5","labels":["T"],"from":"2","to":"3"}',
  '{"type":"edge","id":"e6","labels":["T","U"],"from":"3","to":"4"}',
  '{"type":"edge","id":"e7","labels":["U"],"from":"4","to":"2"}',
  '{"type":"edge","id":"e8","labels":["T"],"from":"nul","to":"2"}',
].join('\n');

/** Every depth the rung has an arm for, times every path mode it admits. */
/*
 * ⚠️⚠️ `{0,1}` IS LOAD-BEARING AND THE MUTATION RUN IS WHY. `takesTheLevelRecurrence` is
 * `max >= 2 && (!isTrail || max <= 4)`, so only `max <= 1` reaches `varLengthDegreeCount`'s
 * per-source loop — and `{1,1}` does not reach this rung AT ALL (`countShortcut` takes it as a
 * vacuous quantifier). Without `{0,1}` every bound here went to the LEVEL arm, and both mutants of
 * the per-source seed gate SURVIVED a 540-assertion suite.
 */
const BOUNDS = ['{1,1}', '{0,1}', '{1,2}', '{0,2}', '{1,3}', '{2,3}', '{1,4}', '{1,5}'] as const;
const MODES = ['', 'WALK ', 'TRAIL '] as const;

describe.if(nativeReady)('a carried start predicate counts what native counts', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /**
   * ⚠️ THE THREE SPELLINGS OF ONE SEEDED COUNT. Item 583 refused the start gate to keep them on the
   * walk TOGETHER rather than make a cliff; item 1907 carries all three for the same reason, so a
   * disagreement between them is this repo's named defect class and not a detail.
   */
  const SPELLINGS = (bound: string, mode: string) =>
    [
      `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n = $p RETURN count(*) AS c`,
      `MATCH ${mode}(a:P {n: $p})-[:T]->${bound}(b:P) RETURN count(*) AS c`,
      `MATCH ${mode}(a:P WHERE a.n = $p)-[:T]->${bound}(b:P) RETURN count(*) AS c`,
    ] as const;

  for (const mode of MODES) {
    for (const bound of BOUNDS) {
      test(`${mode}${bound} — three spellings, all against native`, () => {
        for (const p of [1, 2, 3, 9, 77]) {
          const answers = SPELLINGS(bound, mode).map((q) => {
            const a = JSON.stringify(tsQuery(ts, q, { p }));

            // Each spelling against NATIVE first — the arithmetic claim.
            expect(a).toBe(JSON.stringify(nat.query(q, { p })));

            return a;
          });

          // ⚠️ AND AGAINST EACH OTHER, which is the no-cliff claim item 583 made.
          expect(answers[1]).toBe(answers[0]);
          expect(answers[2]).toBe(answers[0]);
        }
      });
    }
  }

  /** Non-equality and non-numeric start predicates, and the mirror direction (item 744's axis). */
  test('other start predicates, and the IN mirror', () => {
    const MORE = [
      ['MATCH (a:P)-[:T]->{1,3}(b:P) WHERE a.n > $p RETURN count(*) AS c', { p: 1 }],
      ['MATCH (a:P)-[:T]->{1,3}(b:P) WHERE a.g = $p RETURN count(*) AS c', { p: 'a' }],
      ['MATCH (a:P)-[:T]->{1,3}(b:P) WHERE a.n IS NULL RETURN count(*) AS c', {}],
      ['MATCH (a:P {g: $p})-[:T]->{1,3}(b:P) RETURN count(*) AS c', { p: 'b' }],
      ['MATCH (a:P)<-[:T]-{1,3}(b:P) WHERE a.n = $p RETURN count(*) AS c', { p: 2 }],
      ['MATCH (a:P {n: $p})<-[:T]-{1,3}(b:P) RETURN count(*) AS c', { p: 2 }],
      // BOTH ends constrained — the endpoint predicate item 583 carried, plus the new seed one.
      ['MATCH (a:P {n: $p})-[:T]->{1,3}(b:P {g: $q}) RETURN count(*) AS c', { p: 1, q: 'b' }],
      [
        'MATCH (a:P)-[:T]->{1,3}(b:P) WHERE a.n = $p AND b.g = $q RETURN count(*) AS c',
        {
          p: 1,
          q: 'b',
        },
      ],
      // A multi-type hop, and a start label that is NOT the endpoint's.
      ['MATCH (a:P)-[:T|U]->{1,2}(b:P) WHERE a.n = $p RETURN count(*) AS c', { p: 3 }],
      ['MATCH (a:Q)-[:T]->{1,3}(b:P) WHERE a.n = $p RETURN count(*) AS c', { p: 1 }],
    ] as const;

    for (const [q, params] of MORE) {
      expect(JSON.stringify(tsQuery(ts, q, params as never))).toBe(
        JSON.stringify(nat.query(q, params as never)),
      );
    }
  });

  /**
   * ⚠️ AND THE ANSWERS MUST NOT ALL BE ZERO — two engines agree trivially on nothing, and a seed
   * gate that rejected every vertex would pass every test above.
   */
  test('the seeded counts are non-zero and DIFFER by seed', () => {
    const q = 'MATCH (a:P)-[:T]->{1,3}(b:P) WHERE a.n = $p RETURN count(*) AS c';
    const at = (p: unknown) => (tsQuery(ts, q, { p })[0] as { c: number }).c;
    const unseeded = (
      tsQuery(ts, 'MATCH (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c')[0] as { c: number }
    ).c;

    expect(at(1)).toBeGreaterThan(0);
    expect(at(2)).toBeGreaterThan(0);
    expect(at(1)).not.toBe(at(2));
    expect(at(77)).toBe(0);
    // The seeded counts must SUM to less than the unseeded one, since `nul` also has out-edges.
    expect(at(1) + at(2) + at(3) + at(9)).toBeLessThan(unseeded);
  });
});
