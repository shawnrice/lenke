// `EXISTS { (x)-[:T]->(y) }` where `y` is ALREADY BOUND asks whether that PAIR is joined, not
// whether `x` has any `:T` edge. The TS engine's one-hop EXISTS rung answered the second
// question: item 492's free-endpoint arm reads a bucket SIZE and never visits an edge, which is
// right only when nothing has bound the endpoint.
//
// Two shapes diverged from native, and both returned a correct answer there:
//
//   MATCH (x), (y) WHERE y.n = 3 AND EXISTS { (x)-[:T]->(y) }   ts: x = a AND d,  native: a
//   MATCH (x) WHERE EXISTS { (x)-[:T]->(x) }                    ts: every x,      native: d
//
// The second is the self-loop question — `degreeCountSubquery` has had exactly this check since
// item 211, and the EXISTS twin never got it. Found while adding a label-only arm next to it
// (item 525); no test covered either shape, and the differential fuzzer does not generate an
// EXISTS whose endpoint the outer row has bound.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// `d` has a self-loop and NO other edge; `a` has two edges and NO self-loop. Each is the other's
// counterexample, so an arm that confuses "has an edge" with "has THIS edge" cannot pass both.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P","Q"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["Q"],"properties":{"n":3}}',
  '{"type":"node","id":"d","labels":["R"],"properties":{"n":4}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"d","to":"d","properties":{}}',
  '{"type":"edge","id":"e4","labels":["S"],"from":"b","to":"d","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a BOUND EXISTS endpoint: the TS and native engines agree', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  // Row order without ORDER BY is unspecified, so compare as a multiset.
  const bag = (rows: unknown[]): string =>
    JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());

  const agree = (q: string, want: string): void => {
    const rows = tsQuery(tsGraph, q) as unknown[];

    expect(`${q}\n  ${bag(rows)}`).toBe(`${q}\n  ${bag(nativeGraph.query(q) as unknown[])}`);
    // `want` pins the ANSWER too — two engines can agree on a wrong one.
    expect(bag(rows)).toBe(want);
  };

  test('a repeated endpoint is the self-loop question', () => {
    agree('MATCH (x) WHERE EXISTS { (x)-[:T]->(x) } RETURN x.n AS n', '["{\\"n\\":4}"]');
    agree('MATCH (x) WHERE EXISTS { (x)<-[:T]-(x) } RETURN x.n AS n', '["{\\"n\\":4}"]');
    // The NEGATION, so an arm that answers TRUE for everything is visible from the other side.
    agree(
      'MATCH (x) WHERE NOT EXISTS { (x)-[:T]->(x) } RETURN x.n AS n',
      '["{\\"n\\":1}","{\\"n\\":2}","{\\"n\\":3}"]',
    );
  });

  test('an endpoint bound by the outer row is THAT vertex', () => {
    agree(
      'MATCH (x), (y) WHERE y.n = 3 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS n',
      '["{\\"n\\":1}"]',
    );
    agree(
      'MATCH (x), (y) WHERE y.n = 4 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS n',
      '["{\\"n\\":4}"]',
    );
    agree(
      'MATCH (x), (y) WHERE y.n = 2 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS n',
      '["{\\"n\\":1}"]',
    );
    // Nothing reaches `a`, so the right answer is EMPTY — the case a "has any edge" arm gets
    // most wrong, since three of the four vertices have one.
    agree('MATCH (x), (y) WHERE y.n = 1 AND EXISTS { (x)-[:T]->(y) } RETURN x.n AS n', '[]');
  });

  test('an UNBOUND endpoint still asks the cheap question', () => {
    // The control: nothing binds `b`, so this really is "does `x` have a `:T` edge", and the
    // free arm is correct for it. An over-eager fix would break this row.
    agree(
      'MATCH (x) WHERE EXISTS { (x)-[:T]->(b) } RETURN x.n AS n',
      '["{\\"n\\":1}","{\\"n\\":4}"]',
    );
    agree('MATCH (x) WHERE EXISTS { (x)-[:S]->(b) } RETURN x.n AS n', '["{\\"n\\":2}"]');
  });
});

// An OUT-OF-RANGE percentile fraction (item 530). `percentile_cont(x, 2)` PANICKED in native —
// the `cont` branch indexed `nums[rn.ceil()]` with nothing clamping `frac`, so it read one past
// the end and surfaced as `query evaluation panicked` rather than as an error. TS clamps the
// literal when it lowers it and answered the maximum. Found by pricing the aggregate enum; no
// fuzzer generates a fraction outside [0, 1].
//
// A NEGATIVE literal stays divergent and is recorded rather than asserted: `-1` is a unary-minus
// expression rather than a literal token, so TS raises before reading a value while native
// clamps to the minimum. ISO does not define the input; the panic did need fixing.
suite('an out-of-range percentile fraction: the TS and native engines agree', () => {
  const PCT = [
    '{"type":"node","id":"a","labels":["P"],"properties":{"n":40}}',
    '{"type":"node","id":"b","labels":["P"],"properties":{"n":10}}',
    '{"type":"node","id":"c","labels":["P"],"properties":{"n":20}}',
  ].join('\n');
  const nativeGraph = graphFromNdjson(nativeBackend(), PCT);
  const tsGraph = tsDeserialize(PCT, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const rows = tsQuery(tsGraph, q) as unknown[];

    expect(`${q}\n  ${JSON.stringify(rows)}`).toBe(
      `${q}\n  ${JSON.stringify(nativeGraph.query(q) as unknown[])}`,
    );
    expect(JSON.stringify(rows)).toBe(want);
  };

  test('above one is the maximum, in both branches and both engines', () => {
    for (const fn of ['percentile_cont', 'percentile_disc']) {
      for (const f of ['1.0001', '1.5', '2', '100']) {
        agree(`MATCH (x:P) RETURN ${fn}(x.n, ${f}) AS m`, '[{"m":40}]');
      }

      // In range, so the agreement above is read against a working scale rather than alone.
      agree(`MATCH (x:P) RETURN ${fn}(x.n, 1) AS m`, '[{"m":40}]');
      agree(`MATCH (x:P) RETURN ${fn}(x.n, 0) AS m`, '[{"m":10}]');
    }

    // The two branches DIFFER at 0.5 on three values, which is what says the names are not
    // being collapsed into one implementation by this test.
    agree('MATCH (x:P) RETURN percentile_cont(x.n, 0.5) AS m', '[{"m":20}]');
    agree('MATCH (x:P) RETURN percentile_disc(x.n, 0.5) AS m', '[{"m":20}]');
    agree('MATCH (x:P) RETURN percentile_cont(x.n, 0.25) AS m', '[{"m":15}]');
    agree('MATCH (x:P) RETURN percentile_disc(x.n, 0.25) AS m', '[{"m":10}]');
  });
});
