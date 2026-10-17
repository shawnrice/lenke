// Item 558. An `OPTIONAL MATCH` contributes ONE null-filled row per start with no match. Every
// aggregate in this engine drops nullish values before folding, so those rows change nothing —
// EXCEPT for `count(*)`, which counts rows and therefore counts them. So for an un-grouped
// projection whose aggregates all take an argument, `OPTIONAL MATCH … RETURN <agg>(x.k)` asks the
// same question as `MATCH … RETURN <agg>(x.k)`, and the second has had a rung since item 418.
//
// The enum that found it, 200,000 vertices / 200,000 edges, one case per process:
//
//                                                            TS                  native
//   OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*)                7.79 ->  7.81 ms   0.66 ms
//   ...RETURN count(x)                                        410.12 -> 78.84      1.30
//   ...RETURN max(x.age)                                  457.60/475.90 -> 91.36   1.52
//   ...RETURN sum(x.age)                                      494.60 -> 131.65     —
//
// 5.2x, 5.0x and 3.8x; `count(*)` keeps its own rung (item 546) and does not move. The two measured
// against native were 315x and 313x off it.
//
// THE FIXTURE IS THE TEST. `b` and `z` have no out-edge, so the null-filled row exists and is
// observable — on a fixture where every start matches, the optional and non-optional forms are
// indistinguishable and this whole rewrite would look correct for the wrong reason.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"n":5}}',
  // No `n` AND no out-edge: it contributes a null-filled row whose aggregate argument is also null.
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"c","to":"z","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('an OPTIONAL hop under a null-blind aggregate (item 558)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (tail: string, want: string): void => {
    const q = `MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) ${tail}`;
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
    // THE EQUIVALENCE ITSELF: the same query written without OPTIONAL must answer identically.
    // That is what the rewrite claims, and it is checked here rather than assumed.
    expect(JSON.stringify(tsQuery(tsGraph, `MATCH (n:P)-[:T]->(x) ${tail}`))).toBe(want);
  };

  test('the rewritten aggregates', () => {
    // Three matched edges (a->b, a->c, c->z) plus two null-filled rows (b, z). `z` has no `n`, so
    // the folded values are just 2 and 5.
    agree('RETURN max(x.n) AS t', '[{"t":5}]');
    agree('RETURN min(x.n) AS t', '[{"t":2}]');
    agree('RETURN sum(x.n) AS t', '[{"t":7}]');
    agree('RETURN avg(x.n) AS t', '[{"t":3.5}]');
    // `count(x)` counts the ELEMENT — three matched edges, nulls dropped — where `count(x.n)`
    // counts the non-null property, which is two. Both drop the null-filled rows.
    agree('RETURN count(x) AS t', '[{"t":3}]');
    agree('RETURN count(x.n) AS t', '[{"t":2}]');
    agree('RETURN count(DISTINCT x.n) AS t', '[{"t":2}]');
    agree('RETURN collect_list(x.n) AS t', '[{"t":[2,5]}]');
    // An aggregate WRAPPED in arithmetic is still null-blind.
    agree('RETURN max(x.n) + 1 AS t', '[{"t":6}]');
  });

  test('count(*) is REFUSED — it is the one aggregate that sees a null-filled row', () => {
    const q = 'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*) AS t';

    // FIVE: three matched edges plus the two starts that matched nothing.
    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe('[{"t":5}]');
    expect(JSON.stringify(nativeGraph.query(q))).toBe('[{"t":5}]');
    // And the non-optional form answers THREE, which is why the rewrite must not apply.
    expect(JSON.stringify(tsQuery(tsGraph, 'MATCH (n:P)-[:T]->(x) RETURN count(*) AS t'))).toBe(
      '[{"t":3}]',
    );
    // A star count BESIDE an argument-taking one refuses the whole projection.
    const both = 'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*) AS c, max(x.n) AS t';

    expect(JSON.stringify(tsQuery(tsGraph, both))).toBe('[{"c":5,"t":5}]');
    expect(JSON.stringify(nativeGraph.query(both))).toBe('[{"c":5,"t":5}]');
  });

  test('a GROUPED projection is REFUSED — an unmatched start keeps its group', () => {
    const q = 'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN n.n AS k, max(x.n) AS t';
    const got = JSON.stringify(tsQuery(tsGraph, q));

    // Four groups, two of them null — `b` and `z` matched nothing but are still present.
    expect(got).toBe(JSON.stringify(nativeGraph.query(q)));
    expect(got).toBe('[{"k":1,"t":5},{"k":2,"t":null},{"k":5,"t":null},{"k":null,"t":null}]');
    // The non-optional form drops those starts entirely, which is the difference the refusal
    // protects: TWO groups, not four.
    expect(
      (tsQuery(tsGraph, 'MATCH (n:P)-[:T]->(x) RETURN n.n AS k, max(x.n) AS t') as unknown[])
        .length,
    ).toBe(2);
  });

  test('a projection with NO aggregate is REFUSED — it is just the rows', () => {
    const q = 'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN x.n AS k';
    const got = tsQuery(tsGraph, q) as unknown[];

    // Five rows: three matched plus two null-filled.
    expect(got.length).toBe(5);
    expect(JSON.stringify(got)).toBe(JSON.stringify(nativeGraph.query(q)));
    expect((tsQuery(tsGraph, 'MATCH (n:P)-[:T]->(x) RETURN x.n AS k') as unknown[]).length).toBe(3);
  });

  test('a WHERE inside the OPTIONAL keeps its TS answer', () => {
    // Native rejects a `WHERE` inside an `OPTIONAL MATCH` outright, so there is nothing to compare
    // against — but the rewrite must not change what TS answers. Verified against the pristine
    // build: 5 before and after.
    const q = 'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) WHERE x.n > 1 RETURN max(x.n) AS t';

    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe('[{"t":5}]');
    expect(() => nativeGraph.query(q)).toThrow();
  });
});
