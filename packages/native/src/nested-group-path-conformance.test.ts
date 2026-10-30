// A PATH bound over a NESTED subpath group — the engines now AGREE, and this is the regression
// guard for how they got there (items 1236-1240).
//
// THE ARC, because the tests below only make sense with it:
//   1236  every path accessor returned NULL in the Rust engine; `exec/nested.rs` built no lineage.
//   1237  investigating the row count found TS answering a DIFFERENT QUERY once a path was bound —
//         endpoint at the unit's MIDDLE node, group lists null, and the same rows under WALK and
//         TRAIL. Mode-insensitivity is what proved TS wrong rather than merely different.
//   1238  lineage built in the nested walker, verified by HAND because TS was the wrong oracle.
//   1239  `PathNeed` for `NestedGroup`, recovering 1238's cost.
//   1240  the TS cause: `singleVarlen` treated ANY single quantified segment as a single-HOP one,
//         so a multi-element unit went to `allWalk` (one hop per repetition) instead of
//         `walkSegments`. One wrong branch, all three symptoms.
//
// ⚠️ THE EXPECTATIONS ARE HAND-ENUMERATED, not taken from either engine. Fixture `1->2`, `3->2`,
// `3->4`, all `KNOWS`; unit `(x)-[:KNOWS]->(m)<-[:KNOWS]-(y)`; default TRAIL:
//
//   from 1:  1 -(e1)-> 2 , then 2 <-(e2)- 3      (2 <-(e1)- 1 would reuse e1)
//   from 3:  3 -(e2)-> 2 , then 2 <-(e1)- 1
//            3 -(e3)-> 4 , then 4 <-(e3)- 3      reuses e3, excluded
//   from 2, 4: no out-edges
//
// Two repetitions: every continuing edge is already used. So TWO paths, ending at 1 and 3, each of
// three nodes and two edges — `path_length` 2, `cardinality` 5.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"n":4}}',
  '{"type":"edge","id":"e1","labels":["KNOWS"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["KNOWS"],"from":"3","to":"2"}',
  '{"type":"edge","id":"e3","labels":["KNOWS"],"from":"3","to":"4"}',
].join('\n');

const UNIT = '((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2}';

const suite = nativeReady ? describe : describe.skip;

suite('a path bound over a NESTED subpath group', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const outcome = (engine: 'ts' | 'native', q: string): string => {
    try {
      const r = (engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q)) as unknown[];

      return `ok [${[...r]
        .map((x) => JSON.stringify(x))
        .sort()
        .join('|')}]`;
    } catch (e) {
      return `ERR ${(e as { code?: string } | undefined)?.code ?? 'NO_CODE'}`;
    }
  };
  const agree = (q: string): string => {
    const a = outcome('ts', q);

    expect(`${q}\n  ${a}`).toBe(`${q}\n  ${outcome('native', q)}`);

    return a;
  };

  test('the path ACCESSORS agree, and on the hand-enumerated values', () => {
    expect(agree(`MATCH p = ${UNIT} RETURN path_length(p) AS x`)).toBe('ok [{"x":2}|{"x":2}]');
    expect(agree(`MATCH p = ${UNIT} RETURN cardinality(p) AS x`)).toBe('ok [{"x":5}|{"x":5}]');
    expect(agree(`MATCH p = ${UNIT} RETURN size(nodes(p)) AS n, size(edges(p)) AS e`)).toBe(
      'ok [{"n":3,"e":2}|{"n":3,"e":2}]',
    );
  });

  test('BINDING a path does not change the row count (item 1237s structural argument)', () => {
    // Binding a path NAMES the match; it neither filters nor multiplies it. TS used to answer 2
    // rows without a path and 3 with — inconsistent with itself, independent of which number was
    // right.
    expect(agree(`MATCH ${UNIT} (t) RETURN t.n AS n`)).toBe('ok [{"n":1}|{"n":3}]');
    expect(agree(`MATCH p = ${UNIT} (t) RETURN t.n AS n`)).toBe('ok [{"n":1}|{"n":3}]');
  });

  test('the GROUP LISTS still bind with a path in play', () => {
    // They came back null on the TS side: `allWalk` knows nothing of the unit, so it bound none of
    // the unit's variables. The endpoint symptom is covered by the row-count test above — TS
    // answered the unit's MIDDLE nodes, {2, 2, 4}, where both engines now answer {1, 3}.
    expect(agree(`MATCH p = ${UNIT} RETURN size(x) AS sx, size(y) AS sy`)).toBe(
      'ok [{"sx":1,"sy":1}|{"sx":1,"sy":1}]',
    );
  });

  test('MODE-SENSITIVITY: WALK and TRAIL differ, and both engines agree on each', () => {
    // ⚠️ THIS IS THE ASSERTION THAT PROVED TS WRONG, and it is now the sharpest regression guard.
    // WALK permits edge reuse and TRAIL forbids it, so on this fixture they CANNOT agree — TS used
    // to answer the same three rows under both, which no correct implementation can do.
    const w = agree(`MATCH p = WALK ${UNIT} (t) RETURN t.n AS n`);
    const tr = agree(`MATCH p = TRAIL ${UNIT} (t) RETURN t.n AS n`);

    expect(w).not.toBe(tr);
    expect(tr).toBe('ok [{"n":1}|{"n":3}]');
    // 18 rows under WALK on this fixture; asserted as a COUNT so the test does not pin an order.
    expect(w.split('|').length).toBe(18);
  });

  test('CONTROL: a FLAT group and a var-length hop were always fine', () => {
    // These are the shapes the differential fuzzer already generated, which is why it stayed green
    // through all of 1236-1239 — the nested-plus-path INTERSECTION was the gap.
    expect(agree('MATCH p = ((a)-[:KNOWS]->(b)){1,2} RETURN path_length(p) AS x')).toBe(
      'ok [{"x":1}|{"x":1}|{"x":1}]',
    );
    expect(agree('MATCH p = (x)-[:KNOWS]->{1,2}(y) RETURN path_length(p) AS x')).toBe(
      'ok [{"x":1}|{"x":1}|{"x":1}]',
    );
  });

  test('AGREEMENT with no path mentioned, which was never in dispute', () => {
    expect(agree(`MATCH ${UNIT} RETURN count(*) AS c`)).toContain('"c":2');
    expect(agree(`MATCH ${UNIT} (t) RETURN t.n AS n`)).toBe('ok [{"n":1}|{"n":3}]');
  });
});
