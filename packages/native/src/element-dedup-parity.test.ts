// Byte-identity for dedup over ELEMENTS after item 1584 gave them their own id-keyed container.
//
// Unlike items 1582 and 1583, this change DOES have fuzzer coverage on one side: `differential-fuzz`
// generates `RETURN count(DISTINCT b) AS x` over a var-length hop, where `b` is an element. What it
// does NOT generate is the ROWS spelling of the same thing — its distinct-rows arms are all
// `RETURN DISTINCT <prop>` (`b.n`, `n.d`), never the bare element. Item 1584 changed the keying both
// rungs share, so the uncovered half gets explicit coverage here rather than an assumption that the
// covered half speaks for it.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { columnOrderOf, nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":1,"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":2,"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"k":1,"n":3}}',
  '{"type":"node","id":"4","labels":["Q"],"properties":{"k":3,"n":4}}',
  // Several edges into one far node, so there is something for a dedup to collapse.
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"3","to":"2"}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"1","to":"3"}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"2","to":"4"}',
  '{"type":"edge","id":"e5","labels":["E"],"from":"3","to":"3"}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('dedup over elements: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const QUERIES = [
    // The ROWS spelling over a bare element, which no fuzzer generates.
    'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b',
    'MATCH (a:P)-[:E]->(b) RETURN DISTINCT a',
    'MATCH (n:P) RETURN DISTINCT n',
    'MATCH ()-[e:E]->() RETURN DISTINCT e',
    // The COUNT spelling, which it does.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c',
    'MATCH (n:P) RETURN count(DISTINCT n) AS c',
    // With labels and filters, which route the walk differently.
    'MATCH (a:P)-[:E]->(b:P) RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)-[:E]->(b:Q) RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)-[:E]->(b) WHERE b.k = 1 RETURN count(DISTINCT b) AS c',
    'MATCH (a:P)<-[:E]-(b) RETURN count(DISTINCT b) AS c',
    // Elements inside a LIST, which takes the structural branch and recurses through the element
    // key — so this pins that the container change did not alter the nested rendering.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT [a, b]) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN DISTINCT [a, b] AS x',
    // A mixed list of an element and a scalar.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT [b, b.k]) AS c',
    // The scalar controls, whose container this change did not touch.
    'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
    'MATCH (n:P) RETURN count(DISTINCT n.k) AS c',
    'MATCH (n:P) RETURN DISTINCT n.k',
    // A null never counts.
    'MATCH (n:P) RETURN count(DISTINCT n.nope) AS c',
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
  // ⚠️⚠️ TWO PRE-EXISTING DIVERGENCES this file found, NEITHER caused by item 1584 — which changed
  // only how TS keys an element in a dedup set. That they predate it is MEASURED: the probe
  // `edge-distinct-divergence-probe.mjs` produces byte-identical output against a build with the
  // change and one without.
  //
  // 1. A WRONG ANSWER in native. Over five edges with five distinct ids:
  //
  //        MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c      ts 5   nat 3
  //        MATCH ()-[e:E]->() RETURN DISTINCT e                  AGREE, 5 rows
  //        MATCH ()-[e:E]->() RETURN count(*) AS c               AGREE, 5
  //
  //    So native's dedup finds five distinct edges in the ROWS path and counts three in the COUNT
  //    path — the two disagree inside native itself, which is what localizes the bug to its
  //    `count(DISTINCT <edge>)` and rules out the match or the edge set. Naming the ends
  //    (`MATCH (x)-[e:E]->(y)`) changes nothing.
  //
  //    NOT registered: `divergence-registry` refuses a `value` axis on purpose, because engines
  //    disagreeing about a determinate answer is a bug in one of them. Encoded as an expected
  //    failure, which turns red the moment native is fixed, rather than a skip that goes quiet.

  test.failing('native undercounts count(DISTINCT <edge>) (pre-existing, Rust-side)', () => {
    const q = 'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c';
    const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
    const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

    expect(ts).toEqual(nat);
  });

  test('and TS is the one that is right: five edges, five distinct ids', () => {
    expect(tsQuery(tsGraph, 'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c')).toEqual([
      { c: 5 },
    ]);
    // The rows spelling agrees with that count in BOTH engines, which is the oracle for it.
    expect(nativeGraph.query('MATCH ()-[e:E]->() RETURN DISTINCT e')).toHaveLength(5);
  });

  // 2. A COLUMN NAME divergence on an UNALIASED expression projection: TS names the column `expr`
  //    and native names it `col0`. Column naming is part of the bytes a caller sees, so this is a
  //    real divergence and not a nicety — but it is about naming, not dedup, and an explicit
  //    `AS x` makes the two agree (the aliased form is in the list above).
  test.failing('an unaliased list projection is named expr in TS and col0 in native', () => {
    const q = 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT [a, b]';
    const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
    const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

    expect(columnOrderOf(JSON.stringify(ts))).toEqual(columnOrderOf(JSON.stringify(nat)));
  });
});
