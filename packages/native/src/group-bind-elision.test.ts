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

  // A SEVENTH cross-engine divergence, found by this item's own test and PRE-EXISTING — it
  // reproduces on HEAD with the rewrite reverted. A group binding read from a CLAUSE
  // expression is NULL in TS and the per-rep list in native:
  //
  //   WHERE size(e) > 1   ts [{c:0}]   nv [{c:3}]      and the same for x, y
  //   WHERE e IS NULL     ts [{c:6}]   nv [{c:0}]      which is what says it is NULL
  //   FILTER size(e) > 1  ts [{c:0}]   nv [{c:3}]      a separate clause, so not the seed gate
  //   RETURN size(e)      ts and nv AGREE                the PROJECTION resolves it correctly
  //
  // `bindGroupVarsFlat` does put the lists in the binding Map, so the fault is in how a
  // clause-level expression resolves the name, not in the matching. Silent wrong rows, so it
  // belongs to the dangerous VALUE class. Recorded, not fixed here: a correctness fix is its
  // own item, and folding it into a perf change would make neither reviewable.
  //
  // It is ALSO what gives this rewrite's `m.where` collection its teeth. Eliding the binding
  // while the WHERE still names `e` does not return a different count — it makes `e` UNBOUND,
  // which is a scope error, and that is the observable the mutant trips.
  test('a group binding read from a CLAUSE is a known divergence (item 569)', () => {
    const q = 'MATCH (a:P)((x)-[e:T]->(y)){1,2} WHERE size(e) > 1 RETURN count(*) AS c';

    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe('[{"c":0}]');
    expect(JSON.stringify(nativeGraph.query(q))).toBe('[{"c":3}]');
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
