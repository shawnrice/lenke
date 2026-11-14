// BYTE-IDENTITY for `ORDER BY <an expression>` with NO window (item 1902).
//
// ⚠️⚠️ THIS FILE EXISTS BECAUSE `bun run fuzz` IS BLIND TO THE SHAPE. The workload corpus's
// `withOrder` always orders by the projection's ALIAS, so every ordered query it generates spells
// the key as a bound name — and `workload-queries.ts`'s own header names that hazard: "a generator
// that only ever spells a query one way guards only the route that spelling takes, and the fuzzer
// cannot tell you which route that is". Item 1902 admitted a NEW route for the EXPRESSION spelling,
// which no generated query reaches, so a green fuzzer would have said nothing about it. Same shape
// as `fuzzer-blind-to-one-column-group`.
//
// ⚠️ ROW ORDER IS THE WHOLE RISK HERE, and it is compared as ORDER rather than as a multiset:
// `ORDER BY` makes the order part of the answer, and TIE order is observable between the engines
// (item 605). The fixture therefore carries DUPLICATE keys, because a fixture of distinct keys
// cannot see a tiebreak change at all.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// `k` repeats (3, 1, 3, 2, 1) so ties exist; `nu` is null on two rows so a computed key goes null;
// row 6 carries no `m`, so `n.m + 1` is an ABSENT read rather than a stored null.
const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"k":3,"s":"v1","nu":3,"m":1}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"k":1,"s":"v2","nu":null,"m":2}}',
  '{"type":"node","id":"3","labels":["T"],"properties":{"k":3,"s":"v3","nu":3,"m":3}}',
  '{"type":"node","id":"4","labels":["T"],"properties":{"k":2,"s":"v4","nu":null,"m":4}}',
  '{"type":"node","id":"5","labels":["T"],"properties":{"k":1,"s":"v5","nu":1,"m":5}}',
  '{"type":"node","id":"6","labels":["T"],"properties":{"k":2,"s":"v6","nu":2}}',
].join('\n');

const QUERIES = [
  // The shape the item routes, and its monotone twin on the plain arm.
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 DESC',
  // A key the projection does not read at all.
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.nu * 2',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.nu * 2 DESC',
  // An ABSENT property in the key.
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.m + 1',
  // Two keys, the second deciding every tie.
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1, n.s',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 DESC, n.s',
  // The alias spellings, which must not have moved.
  'MATCH (n:T) RETURN n.k + 1 AS c, n.s AS s ORDER BY c',
  'MATCH (n:T) RETURN n.k + 1 AS c, n.s AS s ORDER BY n.k + 1',
  // ⚠️ THE ROUTES THE ITEM DELIBERATELY LEFT ALONE, carried so a later change that admits one of
  // them has to come past this file: a SKIP with no LIMIT, and a LIMIT of zero.
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 OFFSET 1',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 LIMIT 0',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 LIMIT 2',
  'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 OFFSET 1 LIMIT 2',
  // A filter in front, so the arm's gate runs with a predicate.
  'MATCH (n:T) WHERE n.k > 1 RETURN n.s AS s ORDER BY n.k + 1',
];

describe.if(nativeReady)('ORDER BY <expression>, no window — TS and native byte-identical', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  for (const text of QUERIES) {
    test(text, () => {
      const a = JSON.stringify(tsQuery(ts, text));

      expect(a).toBe(JSON.stringify(nat.query(text)));
      // ⚠️ AND NON-EMPTY, because two engines agree trivially on nothing — `LIMIT 0` is the one
      // query here that is meant to be empty.
      expect(a === '[]').toBe(text.includes('LIMIT 0'));
    });
  }
});
