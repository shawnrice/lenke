// Item 548 folds a trailing `FILTER <pred>` into the preceding non-optional MATCH's clause
// `WHERE`, which is what puts the `FILTER` spelling on the same ladder rung as the `WHERE` one
// (3.5-8.6x). The fold is a rewrite of OUR clause list, so the thing to check against native is
// that the two spellings mean the same thing in the first place — and that the `OPTIONAL MATCH`
// case, where they do NOT, diverges the same way in both engines.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["Q"],"properties":{"n":3}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a trailing FILTER means the same in both engines (item 548)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const bag = (rows: unknown[]): string =>
    JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());

  const agree = (q: string, want: string): void => {
    expect(`${q}\n  ${bag(tsQuery(tsGraph, q) as unknown[])}`).toBe(
      `${q}\n  ${bag(nativeGraph.query(q) as unknown[])}`,
    );
    expect(bag(tsQuery(tsGraph, q) as unknown[])).toBe(want);
  };

  test('the folded shapes', () => {
    agree('MATCH (n:P) FILTER n.n > 1 RETURN count(*) AS c', '["{\\"c\\":1}"]');
    agree('MATCH (n:P) FILTER n.n > 1 RETURN max(n.n) AS m', '["{\\"m\\":2}"]');
    agree('MATCH (n:P) FILTER n.missing > 1 RETURN count(*) AS c', '["{\\"c\\":0}"]');
    agree('MATCH (n:P)-[:T]->(m) FILTER m.n = 2 RETURN count(*) AS c', '["{\\"c\\":1}"]');
    agree('MATCH (n:P) WHERE n.n > 0 FILTER n.n > 1 RETURN count(*) AS c', '["{\\"c\\":1}"]');
    // The divergence the fold closed: before item 548 the TS engine THREW here and native did
    // not, because a partitioned clause `WHERE` short-circuits on the FALSE conjunct.
    agree('MATCH (n:P) WHERE 1 / 0 > 0 FILTER n.n > 9 RETURN count(*) AS c', '["{\\"c\\":0}"]');
    agree(
      'MATCH (n) FILTER n.n > 1 RETURN n.n AS k, count(*) AS c',
      '["{\\"k\\":2,\\"c\\":1}","{\\"k\\":3,\\"c\\":1}"]',
    );
  });

  test('the OPTIONAL case, which the fold declines', () => {
    agree(
      'MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) FILTER x.n = 2 RETURN count(*) AS c',
      '["{\\"c\\":1}"]',
    );
    // The `WHERE` half of that pair cannot be compared: native rejects a `WHERE` inside an
    // `OPTIONAL MATCH` outright ("not supported yet"), so the spellings are not even both
    // available there. In TS it answers 2 rather than 1 — which is exactly why the fold refuses
    // an optional match, and the TS-side test pins both halves.
    expect(() =>
      nativeGraph.query('MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) WHERE x.n = 2 RETURN 1 AS o'),
    ).toThrow();
  });

  test('a faulting FILTER raises on both engines', () => {
    expect(() => tsQuery(tsGraph, 'MATCH (n:P) FILTER 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
    expect(() => nativeGraph.query('MATCH (n:P) FILTER 1 / 0 > 0 RETURN count(*) AS c')).toThrow();
    // The control: without the predicate both answer.
    agree('MATCH (n:P) RETURN count(*) AS c', '["{\\"c\\":2}"]');
  });
});
