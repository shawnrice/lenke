// Item 569. `((x)-[e:T]->(y)){n,m}` and `-[:T]->{n,m}(y)` are one question, and the GROUP spelling
// cost nearly twice the abbreviated one because it compiles to a repetition UNIT carrying a
// per-rep list for every inner variable. 60,000 vertices / 180,000 edges, one case per process:
//
//   MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)         421.35 / 469.33 ms   native 1.07
//   MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*)   786.15 -> 381.20     native 1.06
//
// 2.06x, landing on the abbreviated spelling's own cost. The native optimizer has done this since
// `drop_unread_group_binds`; the two engines agreeing the spellings cost the same (1.06 against
// 1.07) is what says the rewrite is sound rather than merely faster.
//
// NARROW ON PURPOSE, and the subquery condition is item 444's trap: `freePredicateVars` adds a
// subquery's own pattern names to its bound set, so an inner `-[r:T]->` that CORRELATES on an
// already-bound `r` is indistinguishable from one binding it freshly. With no subquery anywhere,
// "mentioned" is exactly what a free-variable walk reports.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// A CYCLE (1→2→3→1) so the path modes are distinguishable — item 238 records that an acyclic
// fixture made all four indistinguishable and let a WALK-mode mutant survive a whole fuzzer.
const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"3","labels":["P","Q"],"properties":{"n":3}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"1","to":"2","properties":{"w":5}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"2","to":"3","properties":{"w":7}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"3","to":"1","properties":{"w":9}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('an unread group binding is a plain quantified hop (item 569)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  test('the rewritten shape answers what the abbreviated spelling answers', () => {
    // Nine walks of length 1 or 2 from three starts around the cycle.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*) AS c', '[{"c":6}]');
    agree('MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":6}]');
    agree('MATCH (a:P)((x)-[:T]->(y)){1,2} RETURN count(*) AS c', '[{"c":6}]');
    // The OUTER endpoint is still bound and still readable — only the UNIT's variables go.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2}(z) RETURN count(z) AS c', '[{"c":6}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){2,2} RETURN count(*) AS c', '[{"c":3}]');
  });

  test('a READ inner variable keeps the unit — the lists are the answer', () => {
    // `e` is a per-rep LIST here, so the group form is not the abbreviated one.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(e) AS c', '[{"c":6}]');
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN size(e) AS c ORDER BY c',
      '[{"c":1},{"c":1},{"c":1}]',
    );
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN size(y) AS c ORDER BY c',
      '[{"c":1},{"c":1},{"c":1}]',
    );
    // The only read is in an ORDER BY key, which is why that position is collected too.
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN a.n AS k ORDER BY size(e) DESC, k LIMIT 2',
      '[{"k":1},{"k":2}]',
    );
  });

  test('anything that changes WHAT IS MATCHED keeps the unit', () => {
    // A per-rep WHERE.
    agree('MATCH (a:P)((x)-[e:T]->(y) WHERE y.n > 1){1,2} RETURN count(*) AS c', '[{"c":3}]');
    // An inline edge predicate.
    agree('MATCH (a:P)((x)-[e:T WHERE e.w > 5]->(y)){1,2} RETURN count(*) AS c', '[{"c":3}]');
    // A LABEL or inline property on an inner node is a PARSE error in both engines, so the
    // rewrite's `plain` guard on the inner nodes is depth rather than reachable protection.
    // Pinned here so that if the parser ever admits them, this test fails and the guard is
    // re-examined BEFORE the rewrite silently starts dropping a filtering label.

    for (const q of [
      'MATCH (a:P)((x)-[e:T]->(y:Q)){1,1} RETURN count(*) AS c',
      'MATCH (a:P)((x)-[e:T]->(y {n: 3})){1,1} RETURN count(*) AS c',
    ]) {
      expect(() => tsQuery(tsGraph, q)).toThrow(/quantified-subpath node/);
      expect(() => nativeGraph.query(q)).toThrow();
    }
  });

  test('the PATH MODES survive, which the cycle is here to test', () => {
    // Over a 3-cycle a 3-rep walk returns to its start, so `walk` counts it and the
    // restrictors do not. The rewrite must not change which mode applies.
    for (const mode of ['WALK', 'TRAIL', 'SIMPLE', 'ACYCLIC']) {
      const grouped = `MATCH ${mode} (a:P)((x)-[e:T]->(y)){3,3} RETURN count(*) AS c`;
      const abbrev = `MATCH ${mode} (a:P)-[:T]->{3,3}(y) RETURN count(*) AS c`;

      expect(`${mode} ${JSON.stringify(tsQuery(tsGraph, grouped))}`).toBe(
        `${mode} ${JSON.stringify(nativeGraph.query(grouped))}`,
      );
      // The two spellings must also agree with EACH OTHER, which is the rewrite's claim.
      expect(JSON.stringify(tsQuery(tsGraph, grouped))).toBe(
        JSON.stringify(tsQuery(tsGraph, abbrev)),
      );
    }
  });

  // Item 571 FIXED what item 569 found and pinned here as a divergence. The cause was one
  // line in the MATCH clause's seed-hint loop, which rebuilt each segment as `{rel, node}`
  // and so dropped `CSegment.unit` — the compiled repetition unit. Without it `walkSegments`
  // never called `bindGroupVars`, so every group binding read as NULL, and only when the
  // clause carried a WHERE (the one branch that runs that loop). That is why it looked like a
  // scoping rule and was in fact a lost field.
  //
  // These assertions ran RED against the divergence before the fix, which is the whole reason
  // item 569 pinned both engines' answers rather than only TS's.
  test('a group binding is readable from a CLAUSE expression (item 571)', () => {
    // The shapes that returned zero rows / all-null before the fix.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE size(e) > 1 RETURN count(*) AS c', '[{"c":3}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE size(y) > 1 RETURN count(*) AS c', '[{"c":3}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE size(x) > 1 RETURN count(*) AS c', '[{"c":3}]');
    // `e IS NULL` is what identified the fault as a missing binding rather than a wrong one:
    // it answered 6 (every row) before and answers 0 now.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE e IS NULL RETURN count(*) AS c', '[{"c":0}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE e IS NOT NULL RETURN count(*) AS c', '[{"c":6}]');
    // A standalone FILTER reaches the same loop, because item 548's rewrite folds a trailing
    // FILTER into the MATCH's WHERE — which is why a clause the MATCH never carried was
    // affected too.
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} FILTER size(e) > 1 RETURN count(*) AS c', '[{"c":3}]');
    // Reading the list itself, not just its size.
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,1} WHERE size(e) = 1 RETURN size(y) AS c ORDER BY c',
      '[{"c":1},{"c":1},{"c":1}]',
    );
    // A WHERE that reads a group binding AND the outer anchor together.
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE size(e) > 1 AND a.n = 1 RETURN count(*) AS c',
      '[{"c":1}]',
    );
  });

  // The dropped `unit` reached FURTHER than the bindings, and this is the part item 569 did
  // not see. `walkSegments` reads `unit` to choose its walker: `trailEndsUnit` repeats the
  // compiled unit, and the `undefined` branch is `trailEnds`, the ABBREVIATED single-edge
  // walk. So a clause WHERE did not merely blank the group lists — it made TS walk a
  // DIFFERENT PATTERN, losing the unit's shape AND its per-repetition filter.
  //
  // Its own fixture, because the shared one above has in-degree 1 everywhere and so answers
  // ZERO for a reversed unit — a coinciding fixture, where right and wrong both round to
  // nothing. Node 4 -> 2 gives node 2 an in-degree of 2, which is what makes
  // `(x)-[:T]->(m)<-[:T]-(y)` have an answer at all.
  //
  // The sharpest statement of the bug: `WHERE a.n > 0` rejects nothing here, and adding it
  // changed the reversed-unit answer from 2 to 8. Each pair below is the same question with
  // and without that vacuous clause, so the members must agree with each other and with
  // native. Measured before the fix: 8/2, 8/5 and 8/5.
  test('a vacuous clause WHERE does not change a quantified walk (item 571)', () => {
    const FOUR = [
      '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
      '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
      '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
      '{"type":"node","id":"4","labels":["P"],"properties":{"n":4}}',
      '{"type":"edge","id":"e1","labels":["T"],"from":"1","to":"2","properties":{"w":5}}',
      '{"type":"edge","id":"e2","labels":["T"],"from":"2","to":"3","properties":{"w":7}}',
      '{"type":"edge","id":"e3","labels":["T"],"from":"3","to":"1","properties":{"w":9}}',
      '{"type":"edge","id":"e4","labels":["T"],"from":"4","to":"2","properties":{"w":2}}',
    ].join('\n');
    const nv = graphFromNdjson(nativeBackend(), FOUR);
    const ts = tsDeserialize(FOUR, 'ndjson', new Graph());
    const bothWays = (bare: string, withWhere: string, want: string): void => {
      for (const q of [bare, withWhere]) {
        const got = JSON.stringify(tsQuery(ts, q));

        expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nv.query(q))}`);
        expect(`${q} ${got}`).toBe(`${q} ${want}`);
      }
    };

    bothWays(
      'MATCH (a:P)((x)-[:T]->(m)<-[:T]-(y)){1,2} RETURN count(*) AS c',
      'MATCH (a:P)((x)-[:T]->(m)<-[:T]-(y)){1,2} WHERE a.n > 0 RETURN count(*) AS c',
      '[{"c":2}]',
    );
    bothWays(
      'MATCH (a:P)((x)-[:T]->(m)-[:T]->(y)){1,2} RETURN count(*) AS c',
      'MATCH (a:P)((x)-[:T]->(m)-[:T]->(y)){1,2} WHERE a.n > 0 RETURN count(*) AS c',
      '[{"c":5}]',
    );
    // The per-repetition filter also lives on the unit, so it vanished with it.
    bothWays(
      'MATCH (a:P)((x)-[e:T]->(y) WHERE y.n > 1){1,2} RETURN count(*) AS c',
      'MATCH (a:P)((x)-[e:T]->(y) WHERE y.n > 1){1,2} WHERE a.n > 0 RETURN count(*) AS c',
      '[{"c":5}]',
    );
  });

  test('a SUBQUERY anywhere refuses the rewrite (item 444s trap)', () => {
    // `freePredicateVars` cannot tell a correlated inner `-[e:T]->` from a fresh binding, so the
    // rewrite declines rather than trust it. The answer must be unchanged either way.
    agree(
      'MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN count(*) AS c, COUNT { MATCH (a)-[:T]->(w) } AS d',
      '[{"c":3,"d":1}]',
    );

    // Item 444's trap exactly, and the observable the guard exists for: the inner pattern
    // REBINDS `e`, so `freePredicateVars` reports it BOUND and `mentioned` does not hold it.
    // TS correlates it against the outer per-rep LIST and answers 0; dropping the outer binding
    // would make the inner `e` a fresh binding over all three T edges and answer 3.
    //
    // Pinned on the TS side alone because native REJECTS this spelling with E_SYNTAX — an
    // eighth cross-engine divergence, recorded in CLOSED.md. The guard is a TS-side guard, so
    // a TS-side pin is the right strength for it.
    const trap =
      'MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN count(*) AS c, COUNT { MATCH (p:P)-[e:T]->(q) } AS d';

    expect(JSON.stringify(tsQuery(tsGraph, trap))).toBe('[{"c":3,"d":0}]');
    expect(() => nativeGraph.query(trap)).toThrow();
  });
});
