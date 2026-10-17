// Item 563. `CALL (n) { MATCH … RETURN <agg> AS c }` yields exactly ONE row per outer row — an
// un-grouped aggregate is null or 0 over an empty match, never nothing — so the lateral join
// neither drops nor multiplies rows and the call is a per-row SCALAR. That is precisely a
// `VALUE {}` subquery, which has rungs (items 499, 557) where the CALL route has none.
//
// Item 562 priced the gap at 24.9x against the `sum(COUNT { … })` spelling and RETRACTED the
// rewrite for a wrong answer. This is the fix, and the cause is worth stating because it generalises:
//
//   `markIfCorrelated` populates a WeakSet during SCOPE CHECKING, which runs over the PARSED AST.
//   A subquery node a REWRITE manufactures is never in it, so `memoizeIfUncorrelated` computed
//   the per-row scalar ONCE and reused it for every row.
//
// The node is correlated by construction (the rewrite fires only when the call imports outer
// names), so the fix is one `correlatedSubqueries.add`. Any future rewrite that manufactures an
// `exists`/`countSubquery`/`valueSubquery` node has the same obligation.
//
// MEASURED ON A NON-UNIFORM FIXTURE, which is the other half of the lesson: item 562's first
// measurement used one edge per node, where Σ(degree) and (first degree × row count) are the SAME
// NUMBER, so the memoized answer looked right AND the memoization looked like an 11.1x win. At
// 200,000 vertices with degree `i % 4` (300,000 edges), alternated rounds:
//
//   CALL (n) { … RETURN count(*) AS c } RETURN sum(c)   779.58 / 769.30 -> 491.96 / 510.91  1.5x
//   CALL (n) { … RETURN max(x.age) AS m } RETURN max(m) 779.69 / 801.46 -> 268.32 / 387.63  2.1-2.9x
//   RETURN sum(COUNT { … })                 (control)    52.45 / 53.75 / 52.06
//
// The control is still ~9x faster, so this closes part of the gap and the rest is recorded as open.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// NON-UNIFORM degrees on purpose: a=2, b=1, c=0, z=0. On a fixture where every node has the same
// degree a memoized per-row scalar is invisible, which is exactly how item 562's bug passed its
// first measurement.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"n":5}}',
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"b","to":"c","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a CALL with an aggregate body is a projection subquery (item 563)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  const call = (body: string, tail: string): string =>
    `MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) ${body} } RETURN ${tail}`;

  test('the per-row scalar is PER ROW — the regression guard for the marking', () => {
    // Four outer rows with degrees 2, 1, 0, 0. A memoized scalar would repeat the first.
    agree(
      call('RETURN count(*) AS c', 'n.n AS k, c'),
      '[{"k":1,"c":2},{"k":2,"c":1},{"k":5,"c":0},{"k":null,"c":0}]',
    );
    // Σ of the degrees is 3. Memoized it would be 2 × 4 = 8.
    agree(call('RETURN count(*) AS c', 'sum(c) AS t'), '[{"t":3}]');
    // THE SHAPE ITEM 562 GOT WRONG: a two-item outer projection. It answered 6 against 2 on its
    // own fixture, and here it would answer 8 against 3.
    agree(call('RETURN count(*) AS c', 'sum(c) AS t, count(*) AS r'), '[{"t":3,"r":4}]');
  });

  test('the other aggregates, and an empty match', () => {
    agree(
      call('RETURN max(x.n) AS m', 'n.n AS k, m'),
      '[{"k":1,"m":5},{"k":2,"m":5},{"k":5,"m":null},{"k":null,"m":null}]',
    );
    agree(call('RETURN max(x.n) AS m', 'max(m) AS t, min(m) AS u'), '[{"t":5,"u":5}]');
    agree(
      call('RETURN sum(x.n) AS s', 'n.n AS k, s'),
      '[{"k":1,"s":7},{"k":2,"s":5},{"k":5,"s":0},{"k":null,"s":0}]',
    );
    // An empty match yields its row with 0 for a count and null for the rest — which is what makes
    // the row count identical to the outer's and the rewrite sound.
    agree(
      call('RETURN avg(x.n) AS a', 'n.n AS k, a'),
      '[{"k":1,"a":3.5},{"k":2,"a":5},{"k":5,"a":null},{"k":null,"a":null}]',
    );
  });

  test('a body WHERE rides along', () => {
    agree(
      call('WHERE x.n > 2 RETURN count(*) AS c', 'n.n AS k, c'),
      '[{"k":1,"c":1},{"k":2,"c":1},{"k":5,"c":0},{"k":null,"c":0}]',
    );
  });

  test('the shapes the rewrite REFUSES', () => {
    // A PASS-THROUGH body yields many rows per outer row — `inlineCorrelatedCall`'s shape, not
    // this one. Three edges, so three rows.
    agree(call('RETURN x.n AS a', 'count(*) AS t'), '[{"t":3}]');
    // TWO aggregate items: native REJECTS this inside a CALL body while TS answers it (item 562's
    // fifth subquery-body divergence), so the rewrite declines and TS keeps the general path.
    const two = call('RETURN count(*) AS c, max(x.n) AS m', 'n.n AS k, c, m');

    expect(() => nativeGraph.query(two)).toThrow();
    expect(JSON.stringify(tsQuery(tsGraph, two))).toBe(
      '[{"k":1,"c":2,"m":5},{"k":2,"c":1,"m":5},{"k":5,"c":0,"m":null},{"k":null,"c":0,"m":null}]',
    );
  });

  test('the two hand-written spellings still agree with the rewritten one', () => {
    // All three are the same question, and the point of the rewrite is that they cost the same
    // route. Equal answers are what says the rewrite did not change the meaning.
    agree(
      'MATCH (n:P) LET c = VALUE { MATCH (n)-[:T]->(x) RETURN count(*) } RETURN sum(c) AS t, count(*) AS r',
      '[{"t":3,"r":4}]',
    );
    agree(
      'MATCH (n:P) RETURN sum(COUNT { MATCH (n)-[:T]->(x) }) AS t, count(*) AS r',
      '[{"t":3,"r":4}]',
    );
  });
});

// Item 564 mirrors the PARSER's own normalization inside the rewrite: `parseValueSubquery` turns
// `VALUE { … RETURN count(*) }` into a `countSubquery` (item 499's degree lowering), and a
// manufactured `valueSubquery` missed it — 504.16 ms against the parsed spelling's 151.30 for the
// same question, 3.2x. Mirroring the conditions lands it on 156.85/159.49.
//
// `star` is the load-bearing condition and the PARSER'S OWN COMMENT says so: without it,
// `count(x.n)` becomes a degree, and those are different numbers as soon as a neighbour lacks the
// property. The fixture above has no such neighbour, so the mutant survived there — this one adds
// one, which is the whole reason the block exists.
const SPARSE = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  // No `n` at all, and REACHED — so `count(x.n)` is 1 where the degree is 2.
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"z","properties":{}}',
].join('\n');

suite('count(*) normalizes to a degree, count(<arg>) must NOT (item 564)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), SPARSE);
  const tsGraph = tsDeserialize(SPARSE, 'ndjson', new Graph());

  test('the two counts are DIFFERENT numbers, and both engines say so', () => {
    const star =
      'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN count(*) AS c } RETURN n.n AS k, c';

    expect(JSON.stringify(tsQuery(tsGraph, star))).toBe(
      '[{"k":1,"c":2},{"k":2,"c":0},{"k":null,"c":0}]',
    );
    expect(JSON.stringify(nativeGraph.query(star))).toBe(
      '[{"k":1,"c":2},{"k":2,"c":0},{"k":null,"c":0}]',
    );
    // `count(x.n)` counts the NON-NULL property, so `a` has 1 where its degree is 2. The 1 is
    // what says the rewrite did not normalize it into a degree — this block's whole job.
    const arg =
      'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN count(x.n) AS c } RETURN n.n AS k, c';

    expect(JSON.stringify(tsQuery(tsGraph, arg))).toBe(
      '[{"k":1,"c":1},{"k":2,"c":0},{"k":null,"c":0}]',
    );
    // A SIXTH DIVERGENCE, found here and PRE-EXISTING (identical on the pre-563 build): native
    // answers 2 — it counts the ROWS where TS counts the non-null values. The same `count(x.n)`
    // written WITHOUT the CALL agrees at 1 in both engines, so the divergence belongs to the
    // CALL-body position rather than to `count`. Pinned, not hidden.
    expect(JSON.stringify(nativeGraph.query(arg))).toBe(
      '[{"k":1,"c":2},{"k":2,"c":0},{"k":null,"c":0}]',
    );
    expect(JSON.stringify(tsQuery(tsGraph, 'MATCH (n:P)-[:T]->(x) RETURN count(x.n) AS c'))).toBe(
      '[{"c":1}]',
    );
    expect(JSON.stringify(nativeGraph.query('MATCH (n:P)-[:T]->(x) RETURN count(x.n) AS c'))).toBe(
      '[{"c":1}]',
    );
  });

  test('count(DISTINCT …) is not a degree either', () => {
    // Both neighbours of `a` are distinct, but only one carries `n`, so this is 1 — and a degree
    // would be 2.
    const q =
      'MATCH (n:P) CALL (n) { MATCH (n)-[:T]->(x) RETURN count(DISTINCT x.n) AS c } RETURN n.n AS k, c';

    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe(
      '[{"k":1,"c":1},{"k":2,"c":0},{"k":null,"c":0}]',
    );
    // Native rejects a DISTINCT aggregate in a CALL body outright — item 557's family.
    expect(() => nativeGraph.query(q)).toThrow();
  });
});
