// Item 560. Item 559 widened `detectOptionalHopCount` to a filtered anchor; grepping for the same
// refusal found `perRowForCount` (`MATCH (n:L) FOR t IN n.key RETURN count(*)`) citing the SAME
// item 510 comment as its reason. Its arithmetic is Σ the list's length over the anchors, so a
// filter changes which anchors are summed and nothing else — the identical argument.
//
// 200,000 vertices with three tags each, one case per process:
//
//   MATCH (n:Person) FOR t IN n.tags RETURN count(*)       3.70 ->  4.04 ms  control
//   ...WHERE n.age > 60                                   52.75 -> 10.46      5.0x
//   MATCH (n:Person {tag: 'x'}) ...                      125.56 ->  7.36     17.1x
//   MATCH (n:Person WHERE n.age > 60) ...                 52.93 -> 12.32      4.3x
//
// The inline property map was again the worst of the three, as in item 559.
//
// The gate is now ONE helper, `anchorFilterGate`, shared by both rungs — because item 559's copy
// would otherwise be the eleventh duplicated body in this session, and a duplicate is what has
// fooled a bulk edit ten times already.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// `a` has two tags, `b` one, `c` an EMPTY list (contributing nothing), `z` no `tags` key at all
// and no other properties either, and `s` a NON-list scalar, which unwinds as one element.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1,"t":"x","tags":[1,2]}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2,"t":"y","tags":[3]}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"n":5,"t":"x","tags":[]}}',
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"node","id":"s","labels":["P"],"properties":{"n":9,"t":"x","tags":7}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a FILTERED anchor on the per-row FOR count (item 560)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  const forCount = (head: string): string => `${head} FOR t IN n.tags RETURN count(*) AS c`;

  test('the UNFILTERED control: ISO unwind semantics per anchor', () => {
    // a:2 + b:1 + c:0 (empty list) + z:0 (absent) + s:1 (a scalar unwinds as one) = 4.
    agree(forCount('MATCH (n:P)'), '[{"c":4}]');
  });

  test('all THREE spellings of one filter agree', () => {
    // `t = 'x'` keeps a (2), c (0) and s (1): 3.
    agree(forCount("MATCH (n:P {t: 'x'})"), '[{"c":3}]');
    agree(forCount("MATCH (n:P WHERE n.t = 'x')"), '[{"c":3}]');
    agree(forCount("MATCH (n:P) WHERE n.t = 'x'"), '[{"c":3}]');
    // `n > 1` keeps b (1), c (0) and s (1): 2.
    agree(forCount('MATCH (n:P) WHERE n.n > 1'), '[{"c":2}]');
  });

  test('the spellings COMPOSE, in written order', () => {
    // `{t: 'x'}` keeps a, c, s; `n > 1` then keeps c (0) and s (1).
    agree(forCount("MATCH (n:P {t: 'x'}) WHERE n.n > 1"), '[{"c":1}]');
    // An inline filter matching NOTHING short-circuits a faulting clause `WHERE` — the test for
    // the composition order rather than a comment about it.
    agree(forCount("MATCH (n:P {t: 'zz'}) WHERE 1 / 0 > 0"), '[{"c":0}]');
  });

  test('three-valued logic, and the shapes that keep nothing', () => {
    // `z` has no `n`, so the comparison is UNKNOWN for it and it is dropped like the rest.
    agree(forCount('MATCH (n:P) WHERE n.missing > 1'), '[{"c":0}]');
    agree(forCount('MATCH (n:P) WHERE n.n > 99'), '[{"c":0}]');
    // An UNLABELLED anchor walks every vertex.
    agree(forCount('MATCH (n) WHERE n.n > 1'), '[{"c":2}]');
  });

  test('paging composes with the filter', () => {
    agree(`${forCount("MATCH (n:P {t: 'x'})")} LIMIT 1`, '[{"c":3}]');
    agree(`${forCount("MATCH (n:P {t: 'x'})")} LIMIT 0`, '[]');
  });

  test('a faulting anchor filter still raises on both engines', () => {
    const q = forCount('MATCH (n:P) WHERE 1 / 0 > 0');

    expect(() => tsQuery(tsGraph, q)).toThrow();
    expect(() => nativeGraph.query(q)).toThrow();
    // The control: without the filter the same query is answered.
    agree(forCount('MATCH (n:P)'), '[{"c":4}]');
  });

  test("item 559's rung still answers — the shared helper serves both", () => {
    // The optional-hop count over the same fixture, with each spelling, since `anchorFilterGate`
    // is now one body feeding two rungs and a change to it reaches both.
    const opt = (head: string): string =>
      `${head} OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*) AS c`;

    agree(opt('MATCH (n:P)'), '[{"c":5}]');
    agree(opt("MATCH (n:P {t: 'x'})"), '[{"c":3}]');
    agree(opt("MATCH (n:P) WHERE n.t = 'x'"), '[{"c":3}]');
  });
});
