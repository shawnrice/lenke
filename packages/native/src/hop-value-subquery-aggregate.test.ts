// Item 557. `VALUE { MATCH (n)-[:T]->(x) RETURN <agg>(x.k) }` is a correlated subquery whose body
// is one scalar aggregate. The `count(*)` spelling has had a rung since item 499 lowered it onto
// the degree path; every other aggregate materialized the whole match set per OUTER ROW — a
// `Binding` Map per neighbour plus the array holding them. The enum shows exactly that split, at
// 200,000 vertices / 200,000 edges, one case per process:
//
//   VALUE { … RETURN count(*) }      27.07 ms  (on the degree rung)
//   VALUE { … RETURN avg(x.age) }   154.73 -> 78.82     2.0x
//   VALUE { … RETURN sum(x.age) }   155.16 -> 78.53     2.0x
//   VALUE { … RETURN max(x.age) }   161.03 -> 81.19     2.0x
//   VALUE { … RETURN min(x.age) }   170.50 -> 86.30     2.0x
//
// Native answers all of them in 4.7-5.8 ms, so the gap was TS-only.
//
// FOUR NAMES ARE REFUSED ON PURPOSE, and probing this enum is what found out why: native REJECTS
// `collect`, `collect_list`, the two stddevs AND `count(<arg>)` inside a subquery body ("RETURN
// CollectList(…) is not supported in …") while TS answers all of them. Those are open divergences
// recorded in CLOSED.md; making the divergent answer arrive faster is not an improvement, so the
// rung declines them and they keep the general path.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// `a` has three `:T` out-edges including one to a property-less `z`; `c` has a SELF-LOOP, which is
// the shape `degreeCountSubquery` has guarded since item 211 and this rung refuses the same way.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["P","Q"],"properties":{"n":5}}',
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"a","to":"z","properties":{}}',
  '{"type":"edge","id":"e4","labels":["S"],"from":"b","to":"c","properties":{}}',
  '{"type":"edge","id":"e5","labels":["T"],"from":"c","to":"c","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a one-hop VALUE subquery aggregate (item 557)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  const body = (tail: string): string =>
    `MATCH (n:P) RETURN VALUE { MATCH (n)-[:T]->(x) ${tail} } AS m`;

  test('the four admitted aggregates, including the EMPTY and all-null groups', () => {
    // `a` reaches b/c/z — so `max` is 5, and `z`'s absent `n` is dropped rather than counted.
    // `b` and `z` reach nothing: `max`/`min`/`avg` are null there and `sum` is 0, which is the
    // ISO/SQL contract and the same `aggregateOverValues` the general path calls.
    agree(body('RETURN max(x.n)'), '[{"m":5},{"m":null},{"m":5},{"m":null}]');
    agree(body('RETURN min(x.n)'), '[{"m":2},{"m":null},{"m":5},{"m":null}]');
    agree(body('RETURN sum(x.n)'), '[{"m":7},{"m":0},{"m":5},{"m":0}]');
    agree(body('RETURN avg(x.n)'), '[{"m":3.5},{"m":null},{"m":5},{"m":null}]');
    // An ALL-NULL group: every neighbour lacks the property, so nothing is folded.
    agree(body('RETURN max(x.missing)'), '[{"m":null},{"m":null},{"m":null},{"m":null}]');
    // A computed argument, which the rung compiles rather than refusing.
    agree(body('RETURN max(x.n + 1)'), '[{"m":6},{"m":null},{"m":6},{"m":null}]');
  });

  test('the per-neighbour WHERE, every direction, and a multi-type hop', () => {
    agree(body('WHERE x.n > 1 RETURN max(x.n)'), '[{"m":5},{"m":null},{"m":5},{"m":null}]');
    // UNKNOWN is not TRUE: an absent property keeps no neighbour, so every group is empty.
    agree(
      body('WHERE x.missing > 1 RETURN max(x.n)'),
      '[{"m":null},{"m":null},{"m":null},{"m":null}]',
    );
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)<-[:T]-(x) RETURN max(x.n) } AS m',
      '[{"m":null},{"m":1},{"m":5},{"m":1}]',
    );
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:T]-(x) RETURN max(x.n) } AS m',
      '[{"m":5},{"m":1},{"m":5},{"m":1}]',
    );
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:T|S]->(x) RETURN max(x.n) } AS m',
      '[{"m":5},{"m":5},{"m":5},{"m":null}]',
    );
    // A LANDING LABEL, applied per neighbour.
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:T]->(x:Q) RETURN max(x.n) } AS m',
      '[{"m":5},{"m":null},{"m":5},{"m":null}]',
    );
  });

  test('the refusals that are about the SHAPE', () => {
    // A REPEATED variable is the self-loop question, not a degree — `c` has the only self-loop.
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:T]->(n) RETURN max(n.n) } AS m',
      '[{"m":null},{"m":null},{"m":5},{"m":null}]',
    );
    // The landing variable already BOUND by the outer row asks whether that PAIR is joined, which
    // the rung declines at run time (the same check item 525 added to the EXISTS twin).
    //
    // `y` pinned to `b` (n = 2), NOT to the `:Q` node, and the mutation run is why: with `y` bound
    // to `c` the pair answer (5) and the folded-over-all-neighbours answer (also 5, since `c`
    // holds the maximum) COINCIDE, so the mutant admitting a bound landing survived. Pinning `y`
    // to the smaller neighbour separates them — the pair answer is 2 and the buggy one 5.
    agree(
      'MATCH (n:P), (y:P) WHERE y.n = 2 RETURN VALUE { MATCH (n)-[:T]->(y) RETURN max(y.n) } AS m',
      '[{"m":2},{"m":null},{"m":null},{"m":null}]',
    );
    agree(
      'MATCH (n:P), (y:Q) RETURN VALUE { MATCH (n)-[:T]->(y) RETURN max(y.n) } AS m',
      '[{"m":5},{"m":null},{"m":5},{"m":null}]',
    );
    // An argument reading the ANCHOR rather than the landing. The rung's scratch binding holds
    // only the landing name, so admitting this would read `n` as absent and fold nulls; the
    // correct answer repeats the anchor's own value once per neighbour.
    agree(
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:T]->(x) RETURN max(n.n) } AS m',
      '[{"m":1},{"m":null},{"m":5},{"m":null}]',
    );
    // `count(*)` keeps its own rung and must keep its own answer — it counts ROWS, so `z`'s
    // missing `n` still counts, which is what makes 3 the right answer where `max` saw two values.
    agree(body('RETURN count(*)'), '[{"m":3},{"m":0},{"m":1},{"m":0}]');
  });

  test('a faulting per-neighbour predicate still raises', () => {
    expect(() => tsQuery(tsGraph, body('WHERE 1 / 0 > 0 RETURN max(x.n)'))).toThrow();
    expect(() => nativeGraph.query(body('WHERE 1 / 0 > 0 RETURN max(x.n)'))).toThrow();
    // The control: the same query without the faulting predicate is answered by both.
    agree(body('RETURN max(x.n)'), '[{"m":5},{"m":null},{"m":5},{"m":null}]');
  });

  test('the FOUR names native refuses in a subquery body — an open divergence', () => {
    // Found by probing this enum. TS answers; native rejects. The rung declines all four, so TS's
    // answer is the general path's and this test pins the divergence rather than hiding it.
    for (const tail of [
      'RETURN collect(x.n)',
      'RETURN collect_list(x.n)',
      'RETURN stddev_pop(x.n)',
      'RETURN count(x.n)',
    ]) {
      expect(() => nativeGraph.query(body(tail))).toThrow();
      expect(Array.isArray(tsQuery(tsGraph, body(tail)))).toBe(true);
    }

    // The TS answers themselves, so a change to either side is visible here.
    expect(JSON.stringify(tsQuery(tsGraph, body('RETURN collect(x.n)')))).toBe(
      '[{"m":[2,5]},{"m":[]},{"m":[5]},{"m":[]}]',
    );
    expect(JSON.stringify(tsQuery(tsGraph, body('RETURN count(x.n)')))).toBe(
      '[{"m":2},{"m":0},{"m":1},{"m":0}]',
    );
  });
});
