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
