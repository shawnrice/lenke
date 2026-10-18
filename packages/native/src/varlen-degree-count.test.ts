// Item 573. The TS engine answered `count(*)` over a bounded var-length hop by ENUMERATING the
// walks; native has used degree arithmetic since item 64. The gap was algorithmic, not the
// data-layout ceiling item 566 measured — 40,000 vertices / 120,000 edges, one case per process:
//
//   MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)    ts 295.70ms -> 19.73    nv 0.62
//   MATCH (a:P)((x)-[e:T]->(y)){1,2} ...             269.28    -> 20.36      0.67
//
// 479,998 paths against a V+E of 160,000. The ratio to native goes from ~400x to ~30x, which is
// the constant-factor band item 566 established rather than a missing route.
//
// The GROUP spelling reaches the same rung through item 569's `dropUnreadGroupBinds`, so the two
// spellings cannot diverge in cost — which is this repo's equivalent-spelling rule, and the
// reason both appear below.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// A cycle (so the path modes are distinguishable), a SELF-LOOP (the trail correction's only
// witness), a PARALLEL pair, a MULTI-LABEL edge, a second edge type, an ISOLATED vertex, and a
// label on a third of the nodes so it is NOT vacuous.
const NDJSON = [
  '{"type":"node","id":"1","labels":["P","Q"],"properties":{"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
  '{"type":"node","id":"4","labels":["P","Q"],"properties":{"n":4}}',
  '{"type":"node","id":"iso","labels":["P"],"properties":{"n":9}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"2","to":"3"}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"3","to":"1"}',
  '{"type":"edge","id":"e4","labels":["T"],"from":"1","to":"1"}',
  '{"type":"edge","id":"e5","labels":["T"],"from":"2","to":"3"}',
  // BOTH types: summing per-label bucket sizes counts this edge twice, which is the bug
  // `multi-label-edges.test.ts` caught and `edgesOfTypes` exists to prevent.
  '{"type":"edge","id":"e6","labels":["T","U"],"from":"3","to":"4"}',
  '{"type":"edge","id":"e7","labels":["U"],"from":"4","to":"2"}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a bounded var-length count is degree arithmetic (item 573)', () => {
  const nv = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(ts, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nv.query(q))}`);
    expect(`${q} ${got}`).toBe(`${q} ${want}`);
  };

  test('the bounds, and the two spellings of each', () => {
    // Every value here was taken from the native engine and then checked for coherence, not
    // hand-derived — the first `expect` in `agree` is the real assertion and these are pins.
    //
    //   {1,1} = 6, the T-edge count (e1..e6; `e6` carries T AND U and is ONE edge)
    //   {2,2} = 9, and {1,2} = 15 = 6 + 9
    //   {0,1} = 11 = 6 + 5 sources, {0,2} = 20 = 15 + 5 — `iso` contributes its own row
    //
    // My own arithmetic for three of these was wrong, in the direction of forgetting that the
    // multi-label edge is a T edge. Deriving a pin by hand and asserting it is how a fixture
    // that disagrees with the engine gets committed; deriving it and CHECKING it is not.
    agree('MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":15}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*) AS c', '[{"c":15}]');
    agree('MATCH (a:P)-[:T]->{1,1}(y) RETURN count(*) AS c', '[{"c":6}]');
    agree('MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN count(*) AS c', '[{"c":6}]');
    agree('MATCH (a:P)-[:T]->{2,2}(y) RETURN count(*) AS c', '[{"c":9}]');
    // `{0,n}` adds the zero-length path, one per SOURCE — five of them, `iso` included.
    agree('MATCH (a:P)-[:T]->{0,2}(y) RETURN count(*) AS c', '[{"c":20}]');
    agree('MATCH (a:P)-[:T]->{0,1}(y) RETURN count(*) AS c', '[{"c":11}]');
  });

  test('WALK against TRAIL is the self-loop, which is the trail correction', () => {
    // The only path a trail forbids here is `1 -e4-> 1 -e4-> 1`, over the same edge twice.
    agree('MATCH TRAIL (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":15}]');
    agree('MATCH WALK (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":16}]');
  });

  test('a MULTI-LABEL edge is counted ONCE per path, not once per label', () => {
    // `e6` carries T and U. Summing the two buckets' sizes counts it twice, so the answer would
    // be 8 where every edge taken once gives 7.
    agree('MATCH (a:P)-[:T|U]->{1,1}(y) RETURN count(*) AS c', '[{"c":7}]');
    agree('MATCH (a:P)-[:T|U]->{1,2}(y) RETURN count(*) AS c', '[{"c":19}]');
    // and with no type at all, where every bucket is wanted
    agree('MATCH (a:P)-[]->{1,1}(y) RETURN count(*) AS c', '[{"c":7}]');
  });

  test('an endpoint LABEL is the passing out-degree; a VACUOUS one changes nothing', () => {
    // `:Q` is on 1 and 4 only, so it excludes something: {1,1} = 3 is the T edges landing on a
    // Q node — e3 (3->1), e4 (1->1) and e6 (3->4).
    agree('MATCH (a:P)-[:T]->{1,2}(y:Q) RETURN count(*) AS c', '[{"c":8}]');
    agree('MATCH (a:P)-[:T]->{1,1}(y:Q) RETURN count(*) AS c', '[{"c":3}]');
    // `:P` is on every vertex, so it must not turn the degree product into a per-edge scan —
    // and must not change the answer either.
    agree('MATCH (a:P)-[:T]->{1,2}(y:P) RETURN count(*) AS c', '[{"c":15}]');
    // a label NO vertex carries
    agree('MATCH (a:P)-[:T]->{1,2}(y:Nope) RETURN count(*) AS c', '[{"c":0}]');
    // an unknown edge TYPE: `{0,n}` still emits the zero-length path per source
    agree('MATCH (a:P)-[:Nope]->{1,2}(y) RETURN count(*) AS c', '[{"c":0}]');
    agree('MATCH (a:P)-[:Nope]->{0,2}(y) RETURN count(*) AS c', '[{"c":5}]');
  });

  test('the shapes the rung must REFUSE still answer correctly', () => {
    // SIMPLE / ACYCLIC forbid the node-repeating paths the degree product counts.
    agree('MATCH SIMPLE (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":13}]');
    agree('MATCH ACYCLIC (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":12}]');
    // max > 2 has no two-term closed form here.
    agree('MATCH (a:P)-[:T]->{1,3}(y) RETURN count(*) AS c', '[{"c":28}]');
    // Reversed and undirected are not `Dir::Out`.
    agree('MATCH (a:P)<-[:T]-{1,2}(y) RETURN count(*) AS c', '[{"c":15}]');
    // A per-hop predicate, an inline endpoint property, and a bound edge variable.
    agree('MATCH (a:P)-[:T]->{1,2}(y {n: 3}) RETURN count(*) AS c', '[{"c":4}]');
    agree('MATCH (a:P)-[e:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":15}]');
    // A trailing clause WHERE, which filters the ENDPOINT only.
    agree('MATCH (a:P)-[:T]->{1,2}(y) WHERE y.n > 2 RETURN count(*) AS c', '[{"c":7}]');
    // A path SELECTOR counts a different set of paths, and `selector` defaults to the string
    // 'walk' rather than to undefined — so the guard is `!== 'walk'`, not `!== undefined`. A
    // guard written the obvious way declines every query instead; written too loosely it admits
    // these, and each one is a different number:
    //
    //   ANY SHORTEST 9, ALL SHORTEST 13, ANY 9, ALL 15 — against the default walk's 15.
    //
    // `ALL` happens to agree with the default. It is still refused: a spelling that agrees on
    // this fixture is not a proof that it agrees on every one, and the rung is not needed there.
    agree('MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":9}]');
    agree('MATCH ALL SHORTEST (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":13}]');
    agree('MATCH ANY (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":9}]');
    agree('MATCH ALL (a:P)-[:T]->{1,2}(y) RETURN count(*) AS c', '[{"c":15}]');
    // An unbounded quantifier.
    agree('MATCH ACYCLIC (a:P)-[:T]->+(y) RETURN count(*) AS c', '[{"c":14}]');
  });
});

// Item 583. The rung took the unfiltered case and an endpoint LABEL; an endpoint PREDICATE
// declined and ran the walk. Priced at 40,000 vertices / 120,000 edges, three alternated rounds:
//
//   (y WHERE y.n > 50)        267.40/270.54/313.32 -> 43.01/57.11/47.21   6.2x
//   (y) WHERE y.n > 50        325.18/332.59/338.33 -> 42.66/70.41/43.85   7.6x
//   (y {n: 50})               220.19/225.94/233.60 -> 42.26/57.90/43.09   5.2x
//   (y:Q)      (control, already on the rung)   flat, 36.33 against 39.60 isolated at 9 reps
//   unfiltered (control)                        flat
//
// BOTH SPELLINGS OR NEITHER. `(y WHERE p)` and `(y) WHERE p` are the same question, so carrying
// only the inline one would have CREATED a cliff — 270.82 against 334.13, with the inline side
// alone dropping to ~43. Items 303/304 are both the precedent and the warning: an inline
// `{k: 1}` reached `inlineOf` through the pattern node while the identical clause `WHERE` cost
// 4708.2ms against 33.9, "139x, item 125's bug class at the far end of the family".
// `chainGatesOf` + `gateWith` is the composition they built for it, and it is what this uses.
//
// No fault fallback is needed where native's `node_pass_mask` has one (items 570, 572): this
// applies the predicate per REACHED endpoint, so it evaluates exactly the set the walk would. The
// faulting-CAST case below is what holds that claim.
suite('the rung carries an endpoint PREDICATE, either spelling (item 583)', () => {
  const nv2 = graphFromNdjson(nativeBackend(), NDJSON);
  const ts2 = tsDeserialize(NDJSON, 'ndjson', new Graph());
  const same = (want: string, ...spellings: string[]): void => {
    for (const q of spellings) {
      const got = JSON.stringify(tsQuery(ts2, q));

      expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nv2.query(q))}`);
      expect(`${q} ${got}`).toBe(`${q} ${want}`);
    }
  };

  test('the two spellings of one predicate agree with each other and with native', () => {
    // 4 one-hop T edges land on n>1 (e1->2, e2->3, e5->3, e6->4) and 6 two-hop, so {1,2} is 10.
    same(
      '[{"c":10}]',
      'MATCH (a:P)-[:T]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y) WHERE y.n > 1 RETURN count(*) AS c',
    );
    // THREE spellings of an equality, the inline-property one included.
    same(
      '[{"c":4}]',
      'MATCH (a:P)-[:T]->{1,2}(y {n: 3}) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y) WHERE y.n = 3 RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y WHERE y.n = 3) RETURN count(*) AS c',
    );
    // A CONJUNCTION, in both spellings — `gateWith` merges clause conjuncts with an inline WHERE.
    same(
      '[{"c":7}]',
      'MATCH (a:P)-[:T]->{1,2}(y WHERE y.n > 1 AND y.n < 4) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y) WHERE y.n > 1 AND y.n < 4 RETURN count(*) AS c',
    );
    // A label AND a predicate together: `:Q` is on 1 (n=1, fails) and 4 (n=4), so only paths
    // ending at 4 count — e6 one-hop, and 2->3->4 twice.
    same('[{"c":3}]', 'MATCH (a:P)-[:T]->{1,2}(y:Q WHERE y.n > 1) RETURN count(*) AS c');
  });

  test('the bounds, where the ZERO-LENGTH endpoint is the SOURCE', () => {
    same('[{"c":4}]', 'MATCH (a:P)-[:T]->{1,1}(y WHERE y.n > 1) RETURN count(*) AS c');
    same('[{"c":6}]', 'MATCH (a:P)-[:T]->{2,2}(y WHERE y.n > 1) RETURN count(*) AS c');
    // 10 hop paths plus one row per SOURCE that passes — 2, 3, 4 and iso, not 1.
    same('[{"c":14}]', 'MATCH (a:P)-[:T]->{0,2}(y WHERE y.n > 1) RETURN count(*) AS c');
    same('[{"c":0}]', 'MATCH (a:P)-[:T]->{1,2}(y WHERE y.n IS NULL) RETURN count(*) AS c');
  });

  test('a predicate that FAULTS does so on the same set the walk would', () => {
    // `n` is a number on every vertex here, so a CAST of it cannot fault — which is exactly why
    // the assertion is that the two spellings AGREE WITH NATIVE rather than that they throw.
    // The claim being held is that the rung evaluates the predicate per REACHED endpoint: were it
    // asking about every vertex in the store (native's mask does, and declines on `Err`), a
    // vertex no walk reaches could fault here and not there.
    same(
      '[{"c":10}]',
      'MATCH (a:P)-[:T]->{1,2}(y WHERE CAST(y.n AS INTEGER) > 1) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y) WHERE CAST(y.n AS INTEGER) > 1 RETURN count(*) AS c',
    );
  });

  test('a CORRELATED endpoint gate declines rather than dropping the predicate', () => {
    // `inlineOf`/`gateWith` return `null` — not `undefined` — when the endpoint's constraint reads
    // something other than the endpoint, and the two mean opposite things: `undefined` is "no
    // predicate, count everything", `null` is "cannot carry this, run the walk". Treating the one
    // as the other is a silent overcount (10 for 1 here) that no other case in this file catches.
    // Only the SELF-LOOP has an endpoint whose `n` equals its source's.
    same(
      '[{"c":1}]',
      'MATCH (a:P)-[:T]->{1,2}(y {n: a.n}) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y WHERE y.n = a.n) RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->{1,2}(y) WHERE y.n = a.n RETURN count(*) AS c',
    );
  });

  test('a NON-PLAIN START keeps its own constraint', () => {
    // `degreeCountShape` refuses a start that carries anything, so these run the walk — but the
    // rung is one `||` away from seeing them, and dropping the start's `{n: 1}` would read 10.
    same('[{"c":4}]', 'MATCH (a:P {n: 1})-[:T]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c');
    same(
      '[{"c":4}]',
      'MATCH (a:P WHERE a.n = 1)-[:T]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c',
    );
    same('[{"c":5}]', 'MATCH (a:P {n: 1})-[:T]->{1,2}(y) RETURN count(*) AS c');
    same('[{"c":1}]', 'MATCH (a:P {n: 1})-[:T]->{1,2}(y:Q) RETURN count(*) AS c');
  });

  test('the shapes it must still REFUSE answer correctly', () => {
    // A gate on the START is a filter on the seed, which this rung does not carry.
    same('[{"c":10}]', 'MATCH (a:P)-[:T]->{1,2}(y) WHERE a.n > 1 RETURN count(*) AS c');
    // SIMPLE, max > 2, and a multi-type hop all decline for their own reasons.
    same('[{"c":9}]', 'MATCH SIMPLE (a:P)-[:T]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c');
    same('[{"c":19}]', 'MATCH (a:P)-[:T]->{1,3}(y WHERE y.n > 1) RETURN count(*) AS c');
    same('[{"c":14}]', 'MATCH (a:P)-[:T|U]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c');
    // WALK keeps the self-loop path a trail forbids.
    same('[{"c":10}]', 'MATCH WALK (a:P)-[:T]->{1,2}(y WHERE y.n > 1) RETURN count(*) AS c');
  });
});
