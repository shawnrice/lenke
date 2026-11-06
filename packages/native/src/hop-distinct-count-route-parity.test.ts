// Item 1583 routes hop `count(DISTINCT …)` from `hopAggregate` to `detectDistinctCount`. The two
// rungs are different CODE answering one question, so the route change is only safe if they agree
// on every semantic edge — and `detectDistinctCount`'s own doc flags one where it differs from the
// ROWS path:
//
//     "NULLs do not count. `count(DISTINCT n.k)` over `1, null, absent, 2, 1` is 2, where
//      `RETURN DISTINCT n.k` is three rows including the null."
//
// That is the rule for `count(DISTINCT)` per ISO, so both rungs should hold it — but "should" is
// what this file is for. The oracle is NATIVE, which is unaffected by a TS route change, so any
// disagreement introduced by the reroute shows up as a TS-vs-native failure here.
//
// ⚠️ And `bun run fuzz` cannot stand in for this: `genQuery` in `backend-parity-fuzz` generates no
// `count(DISTINCT …)` over a hop at all, the same blind spot item 1582 found for the one-column
// grouped count. A green sweep over a shape nobody generates is not evidence.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { columnOrderOf, nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// A fixture built around the null cases, because that is where the two rungs could differ:
// a present null, an ABSENT property, a repeated value, and a far end reached by several edges.
const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":1,"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":null,"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"k":2,"n":4}}',
  '{"type":"node","id":"5","labels":["P"],"properties":{"k":1,"n":5}}',
  '{"type":"node","id":"6","labels":["Q"],"properties":{"k":9,"n":6}}',
  // Several edges into the SAME far node, so a per-row fold and a dedup-while-walking disagree
  // loudly if either is wrong.
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"1","to":"3"}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"2","to":"3"}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"3","to":"4"}',
  '{"type":"edge","id":"e5","labels":["E"],"from":"4","to":"5"}',
  '{"type":"edge","id":"e6","labels":["E"],"from":"5","to":"5"}',
  '{"type":"edge","id":"e7","labels":["E"],"from":"1","to":"6"}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('hop count(DISTINCT …) after the item 1583 reroute: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const QUERIES = [
    // The rerouted shapes: dedup on each end, by identity and by property.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c',
    // ⚠️ THE NULL CASES, which are the reason this file exists.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a.k) AS c',
    // A property NO vertex has, so every value is null and the answer must be 0 and not 1.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.nope) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.n) AS c',
    // A label on the far end, which routes the walk differently.
    'MATCH (a:P)-[:E]->(b:P) RETURN count(DISTINCT b.k) AS c',
    'MATCH (a:P)-[:E]->(b:Q) RETURN count(DISTINCT b.k) AS c',
    // An anonymous end, which `distinctShape` must key on the other one.
    'MATCH (a:P)-[:E]->() RETURN count(DISTINCT a.k) AS c',
    'MATCH (:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
    // Direction, including the reverse spelling of one question.
    'MATCH (a:P)<-[:E]-(b) RETURN count(DISTINCT b.k) AS c',
    // A clause WHERE on the KEYED end, which the rung carries.
    'MATCH (a:P)-[:E]->(b) WHERE b.n > 2 RETURN count(DISTINCT b.k) AS c',
    'MATCH (a:P)-[:E]->(b) WHERE a.n > 2 RETURN count(DISTINCT a.k) AS c',
    // A cross-end WHERE, which DECLINES the rung — so this pins that falling back still agrees.
    'MATCH (a:P)-[:E]->(b) WHERE a.n > 2 RETURN count(DISTINCT b.k) AS c',
    // An inline constraint on the keyed end.
    'MATCH (a:P)-[:E]->(b {k: 1}) RETURN count(DISTINCT b.n) AS c',
    // The node-only twin, whose route this change does NOT touch — a control inside the oracle.
    'MATCH (n:P) RETURN count(DISTINCT n.k) AS c',
    'MATCH (n:P) RETURN count(DISTINCT n) AS c',
    // The aggregates the gate must leave with `hopAggregate`.
    'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m',
    'MATCH (a:P)-[:E]->(b) RETURN min(b.k) AS m',
    'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS s',
    'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c, max(b.k) AS m',
    'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS c',
    // And the ROWS spelling, which has the DIFFERENT null rule (a null IS a row) and so must not
    // have been changed to match the count's.
    'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k',
  ];

  for (const q of QUERIES) {
    test(q, () => {
      const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
      const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

      // Row order is unspecified; COLUMN order is bytes. `columnOrderOf` takes a JSON string.
      expect(columnOrderOf(JSON.stringify(ts))).toEqual(columnOrderOf(JSON.stringify(nat)));
      expect([...ts].map((r) => JSON.stringify(r)).sort()).toEqual(
        [...nat].map((r) => JSON.stringify(r)).sort(),
      );
      expect(ts.length).toBe(nat.length);
    });
  }

  // The null rule stated as a LITERAL, not just as agreement: two engines could agree and both be
  // wrong, and this is the one semantic the reroute could plausibly have flipped.
  test('a null never counts, and an absent property counts as nothing at all', () => {
    // Far ends reached from a P node: 2 (k null), 3 (k absent), 4 (k 2), 5 (k 1), 6 (k 9).
    // Distinct non-null k among them: 2, 1, 9 -> 3.
    expect(tsQuery(tsGraph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c')).toEqual([
      { c: 3 },
    ]);
    // No vertex has `nope`, so every value is null: 0, NOT 1.
    expect(tsQuery(tsGraph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.nope) AS c')).toEqual([
      { c: 0 },
    ]);
    // And the ROWS spelling keeps the OTHER rule: the null is a row.
    const rows = tsQuery(tsGraph, 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k') as Array<
      Record<string, unknown>
    >;

    expect(rows.some((r) => Object.values(r)[0] === null)).toBe(true);
  });
});
