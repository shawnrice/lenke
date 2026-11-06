// Byte-identity for `anyWalk`, GQL's bare-`ANY` trail enumerator — item 1616.
//
// ⚠️ THE FUNCTION HAD NO TEST IN EITHER SUITE, and it was found mechanically rather than by reading:
// item 1616 duplicated every bare `yield` in the GQL executor one at a time and ran the suite. Ten
// of eleven sites died; `matching.ts`'s `anyWalk` emission survived, and survived the NATIVE suite
// too. Duplicating it makes every bare-`ANY` row come out twice, so nothing drained it at all.
//
// Why it was invisible: `pickSeedDriver` routes `ANY` to the O(V+E) BFS driver whenever
// `bfsReducible` holds — a single segment, `min <= 1`, no inline predicate — and EVERY existing
// bare-`ANY` test uses `*` (min 0) or `{1,1}`. So all of them exercised `shortestWalk`, and the
// enumerate-trails arm beneath it was reached by no spelling anyone had written. `{2,3}` is the
// cheapest spelling that gets there (min 2 ⇒ not reducible).
//
// This is the same CLASS as item 1615's lazy/eager finding — a branch chosen by a route predicate,
// where every test happens to take the other side — and the reason both items pin the ROUTE and not
// only the answer.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/**
 * Five vertices with TWO routes to `c` and `d`, so "one arbitrary path per endpoint" is a real
 * choice rather than forced — a path graph would make the enumerate-all and the ANY answers
 * coincide, which is the fixture defect item 614 recorded for exactly this selector.
 *
 * ```text
 *   a -> b -> c -> d -> e
 *   a -> c        (so `c` is reachable in 1 hop and 2)
 *   b -> d        (so `d` is reachable in 2 hops and 3)
 * ```
 */
const EDGES: readonly [string, string][] = [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
  ['a', 'c'],
  ['b', 'd'],
  ['d', 'e'],
];

const NDJSON = [
  ...['a', 'b', 'c', 'd', 'e'].map((id) =>
    JSON.stringify({ type: 'node', id, labels: ['N'], properties: { id } }),
  ),
  ...EDGES.map(([from, to], i) =>
    JSON.stringify({ type: 'edge', id: `r${i}`, labels: ['R'], from, to, properties: {} }),
  ),
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('bare `ANY` over a non-reducible quantifier: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const both = (q: string): [string, string] => [
    JSON.stringify(tsQuery(tsGraph, q)),
    JSON.stringify(nativeGraph.query(q)),
  ];

  const QUERIES: readonly string[] = [
    // `min = 2`, so `bfsReducible` is false and `anyWalk` is the driver.
    `MATCH ANY (a:N {id:'a'})-[:R]->{2,3}(x) RETURN x.id AS id ORDER BY id`,
    `MATCH ANY (a:N {id:'a'})-[:R]->{2,4}(x) RETURN x.id AS id ORDER BY id`,
    // Every start, so the per-endpoint `seen` set is per-seed and not global.
    `MATCH ANY (a:N)-[:R]->{2,3}(x) RETURN a.id AS s, x.id AS id ORDER BY s, id`,
    // A count, which is the spelling a shortcut could claim — so it must agree too.
    `MATCH ANY (a:N {id:'a'})-[:R]->{2,4}(x) RETURN count(*) AS c`,
    // An endpoint predicate, which narrows AFTER the one-witness-per-endpoint rule.
    `MATCH ANY (a:N {id:'a'})-[:R]->{2,3}(x) WHERE x.id <> 'e' RETURN x.id AS id ORDER BY id`,
    // A quantifier nothing satisfies, and one whose lower bound exceeds the graph's diameter.
    `MATCH ANY (a:N {id:'e'})-[:R]->{2,3}(x) RETURN x.id AS id ORDER BY id`,
    `MATCH ANY (a:N {id:'a'})-[:R]->{9,9}(x) RETURN count(*) AS c`,
    // The REDUCIBLE twin, as the control: `min <= 1` takes `shortestWalk` instead, and both
    // drivers must agree on the shape where they overlap.
    `MATCH ANY (a:N {id:'a'})-[:R]->{1,3}(x) RETURN x.id AS id ORDER BY id`,
    `MATCH ANY (a:N {id:'a'})-[:R]->*(x) RETURN x.id AS id ORDER BY id`,
  ];

  for (const q of QUERIES) {
    test(q, () => {
      const [ts, native] = both(q);

      expect(ts).toBe(native);
    });
  }

  test('ONE row per endpoint, not one per path — the selector’s whole claim', () => {
    /**
     * ⚠️ DERIVED, and this is the assertion the duplicated-`yield` mutant dies on. From `a` with
     * `{2,3}`: the 2-hop ends are `c` (a>b>c) and `d` (a>b>d, a>c>d); the 3-hop ends are `d`
     * (a>b>c>d) and `e` (a>b>d>e, a>c>d>e). Distinct endpoints: c, d, e — THREE rows, where
     * enumerating every trail gives six.
     */
    const [ts, native] = both(
      `MATCH ANY (a:N {id:'a'})-[:R]->{2,3}(x) RETURN x.id AS id ORDER BY id`,
    );

    expect(JSON.parse(ts)).toEqual([{ id: 'c' }, { id: 'd' }, { id: 'e' }]);
    expect(ts).toBe(native);

    // And the all-trails spelling of the same walk really does answer six, so the three above is
    // the SELECTOR working rather than the fixture having only three paths.
    expect(tsQuery(tsGraph, `MATCH (a:N {id:'a'})-[:R]->{2,3}(x) RETURN count(*) AS c`)).toEqual([
      { c: 6 },
    ]);
  });
});
