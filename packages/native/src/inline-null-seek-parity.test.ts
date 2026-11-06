// Byte-identity for a NULL-valued inline property with an index present — item 1605's wrong answer.
//
// The TS engine seeded `{k: null}` from the index's null bucket, which cannot hold the vertices that
// LACK the key, so an index made the count drop by exactly those. The inline reading matches a
// stored null AND an absent key (item 260), so the right answer is the union.
//
// ⚠️ THIS ASKS NATIVE WHICH ENGINE WAS RIGHT, which no TS-only test can. If native had agreed with
// the pre-fix TS behaviour the fix would have been a new DIVERGENCE rather than a repair, and that
// is worth a test rather than an assumption.
//
// No fuzzer covers it: `differential-fuzz` generates inline constraints, but over generated property
// values — a null-valued inline property against an INDEXED key is outside what it builds, and the
// index is what makes the two readings diverge.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/** 4 stored nulls, 4 absent, 8 valued — small enough to count by hand, discriminating all three. */
const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":0,"note":null}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":1}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"k":2,"note":"x3"}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"k":3,"note":"x4"}}',
  '{"type":"node","id":"5","labels":["P"],"properties":{"k":0,"note":null}}',
  '{"type":"node","id":"6","labels":["P"],"properties":{"k":1}}',
  '{"type":"node","id":"7","labels":["P"],"properties":{"k":2,"note":"x7"}}',
  '{"type":"node","id":"8","labels":["P"],"properties":{"k":3,"note":"x8"}}',
  '{"type":"node","id":"9","labels":["P"],"properties":{"k":0,"note":null}}',
  '{"type":"node","id":"10","labels":["P"],"properties":{"k":1}}',
  '{"type":"node","id":"11","labels":["P"],"properties":{"k":2,"note":"x11"}}',
  '{"type":"node","id":"12","labels":["P"],"properties":{"k":3,"note":"x12"}}',
  '{"type":"node","id":"13","labels":["P"],"properties":{"k":0,"note":null}}',
  '{"type":"node","id":"14","labels":["P"],"properties":{"k":1}}',
  '{"type":"node","id":"15","labels":["P"],"properties":{"k":2,"note":"x15"}}',
  '{"type":"node","id":"16","labels":["P"],"properties":{"k":3,"note":"x16"}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a null-valued inline property with an index: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['note'] });
  nativeGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['note'] });

  const QUERIES: readonly [string, Record<string, unknown>][] = [
    ['MATCH (u:P {note: null}) RETURN count(*) AS c', {}],
    ['MATCH (u:P {note: $v}) RETURN count(*) AS c', { v: null }],
    ['MATCH (u:P) WHERE u.note IS NULL RETURN count(*) AS c', {}],
    ['MATCH (u:P) WHERE u.note IS NOT NULL RETURN count(*) AS c', {}],
    ['MATCH (u:P) WHERE u.note = $v RETURN count(*) AS c', { v: null }],
    ["MATCH (u:P {note: 'x7'}) RETURN count(*) AS c", {}],
    ['MATCH (u:P {k: 1, note: null}) RETURN count(*) AS c', {}],
    ['MATCH (u:P {k: 0, note: null}) RETURN count(*) AS c', {}],
  ];

  for (const [text, params] of QUERIES) {
    test(text + (Object.keys(params).length > 0 ? ' ' + JSON.stringify(params) : ''), () => {
      const ts = JSON.stringify(tsQuery(tsGraph, text, params));
      const nat = JSON.stringify(nativeGraph.query(text, params));

      expect(ts).toBe(nat);
    });
  }

  test('and both answer the hand-counted numbers', () => {
    // 4 stored nulls (k=0), 4 absent (k=1), 8 valued (k=2,3).
    const pairs: readonly [string, number][] = [
      ['MATCH (u:P {note: null}) RETURN count(*) AS c', 8],
      ['MATCH (u:P) WHERE u.note IS NULL RETURN count(*) AS c', 8],
      ['MATCH (u:P) WHERE u.note IS NOT NULL RETURN count(*) AS c', 8],
      ["MATCH (u:P {note: 'x7'}) RETURN count(*) AS c", 1],
      ['MATCH (u:P {k: 0, note: null}) RETURN count(*) AS c', 4],
      ['MATCH (u:P {k: 1, note: null}) RETURN count(*) AS c', 4],
      ['MATCH (u:P {k: 2, note: null}) RETURN count(*) AS c', 0],
    ];

    for (const [text, want] of pairs) {
      expect(Number((tsQuery(tsGraph, text, {})[0] as { c: unknown }).c)).toBe(want);
    }
  });
});
