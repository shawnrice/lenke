// `MATCH (a:P)-[:T]->(a)` — the same node variable at both ends of a hop — means ONE node, so
// it matches the self-loops. The TS engine's hop fast paths answered it WRONG: each binds the
// far node over the start without checking that the name is the same one, so `count(*)` read 4
// where native read 2, and seven other shapes diverged with it (item 506).
//
// Found by accident. Item 506's clause fusion routed `MATCH (a:P) MATCH (a)-[:T]->(a)` into the
// one-clause spelling, the two spellings stopped agreeing, and that is the only reason anyone
// looked — the differential fuzzer does not generate a one-hop pattern that repeats its
// endpoint. This file is what makes sure it cannot come back unnoticed.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// Two self-loops among four edges, so a double count is visible and a right answer is not zero.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"k":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"k":2}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"k":3}}',
  '{"type":"edge","id":"ab","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"ac","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"aa","labels":["T"],"from":"a","to":"a","properties":{}}',
  '{"type":"edge","id":"bb","labels":["T"],"from":"b","to":"b","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a repeated node variable: the TS and native engines agree', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  // Row order without ORDER BY is unspecified, so compare as a multiset.
  const bag = (rows: unknown[]): string =>
    JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());

  const agree = (q: string, want: string): void => {
    const rows = tsQuery(tsGraph, q) as unknown[];

    expect(`${q}\n  ${bag(rows)}`).toBe(`${q}\n  ${bag(nativeGraph.query(q) as unknown[])}`);
    // `want` pins the ANSWER as well as the agreement — two engines can agree on a wrong one.
    expect(JSON.stringify(rows)).toContain(want);
  };

  test('count, projection, grouping and aggregation over a repeated endpoint', () => {
    // Two self-loops: `a -> a` and `b -> b`.
    agree('MATCH (a:P)-[:T]->(a) RETURN count(*) AS c', '"c":2');
    agree('MATCH (a:P)-[:T]->(a) RETURN a.k AS k', '"k":1');
    agree('MATCH (a:P)-[:T]->(a) RETURN DISTINCT a.k AS k', '"k":2');
    agree('MATCH (a:P)-[:T]->(a) RETURN a.k AS k, count(*) AS c', '"c":1');
    agree('MATCH (a:P)-[:T]->(a) RETURN max(a.k) AS m', '"m":2');
  });

  test('the direction and label spellings of it', () => {
    agree('MATCH (a:P)<-[:T]-(a) RETURN count(*) AS c', '"c":2');
    // Undirected visits a self-loop ONCE in GQL, so this is still 2.
    agree('MATCH (a:P)-[:T]-(a) RETURN count(*) AS c', '"c":2');
    agree('MATCH (a)-[:T]->(a) RETURN count(*) AS c', '"c":2');
    agree('MATCH (a:P)-[r:T]->(a) RETURN count(*) AS c', '"c":2');
    agree('MATCH (a:P)-[:T]->(a) WHERE a.k = 1 RETURN count(*) AS c', '"c":1');
  });

  test('a repeat at DISTANCE, and the far position', () => {
    // `a -> x -> a` is a two-cycle: only the self-loops qualify here.
    agree('MATCH (a:P)-[:T]->(x)-[:T]->(a) RETURN count(*) AS c', '"c":2');
    // The repeat on the MIDDLE and far node: `x -> x` after a hop — a -> b -> b, a -> a -> a
    // and b -> b -> b, so THREE, where the `-> (a)` form above is two.
    agree('MATCH (a:P)-[:T]->(x)-[:T]->(x) RETURN count(*) AS c', '"c":3');
  });

  test('the ordinary hop is untouched — the gate must not catch it', () => {
    agree('MATCH (a:P)-[:T]->(x) RETURN count(*) AS c', '"c":4');
    agree('MATCH (a:P)-[:T]->(x) RETURN x.k AS k', '"k":1');
    // Four edges, and five two-hop paths over them.
    agree('MATCH (a:P)-[:T]->(x)-[:T]->(y) RETURN count(*) AS c', '"c":5');
  });

  test('the two CLAUSE spellings of it agree too', () => {
    agree('MATCH (a:P) MATCH (a)-[:T]->(a) RETURN count(*) AS c', '"c":2');
  });
});
