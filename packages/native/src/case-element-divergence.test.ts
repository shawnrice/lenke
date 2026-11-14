// A cross-engine divergence on an ELEMENT returned from a `CASE` branch, found at item 1873 while
// settling a key-space question for an unrelated optimization.
//
// ⚠️ THE SHAPE OF THE DISAGREEMENT, and it is a VALUE divergence — the engines return different
// answers to a determinate question:
//
//     MATCH (n:L) RETURN CASE WHEN n.n = 1 THEN n ELSE n.s END AS k
//
//     TS      [{"k":{"id":"v1","labels":["L"],"properties":{...}}}, {"k":"@v1"}]
//     native  [{"k":0},                                             {"k":"@v1"}]
//
// Native emits a bare integer where the vertex should be. The `ELSE` branch (a string) agrees, and
// a plain `RETURN n` agrees too — checked, so this is specific to an element flowing through a
// `CASE`, not to element rendering over FFI.
//
// ⚠️ WHICH ENGINE IS RIGHT IS NOT IN DOUBT HERE, unlike item 1817's parse-surface question. A
// vertex is not the number `0`. ISO-GQL's conditional expression yields the value of the chosen
// branch, and the chosen branch is bound to a node — so TS is right and native is dropping the
// element for what looks like an internal ordinal. It is pinned rather than fixed because the fix
// is in the RUST engine, which is outside what this item set out to touch.
//
// ⚠️ IT IS PINNED WITH `test.failing` BECAUSE THE DIVERGENCE REGISTRY CANNOT TAKE IT.
// `divergence-registry.ts` deliberately has no `value` axis and says so in terms: "if the engines
// disagree about the answer to a determinate question, that is a bug in one of them, and no entry
// may excuse it." So a value divergence gets a failing test that flips to passing the day it is
// fixed, which is the only form of record that cannot quietly become permanent.
//
// ⚠️ AND THE FUZZER DOES NOT REACH IT. The differential fuzzer generates no `CASE` whose branches
// differ in TYPE — this was found by a hand-written probe asking a different question entirely
// (`distinct-count-keyspace-1873.ts`, whose own first fixture failed to create the collision it
// was built for). A shape no generator produces has no coverage, which is why the probe is kept.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/**
 * `v1` has `n = 1` so the `CASE` yields the VERTEX; `v9` has `n = 9` so it yields the STRING. One
 * column, two types — which is the whole point of the shape.
 */
const NDJSON = [
  '{"type":"node","id":"v1","labels":["L"],"properties":{"s":"zz","n":1}}',
  '{"type":"node","id":"v9","labels":["L"],"properties":{"s":"@v1","n":9}}',
].join('\n');

const CASE_EXPR = 'CASE WHEN n.n = 1 THEN n ELSE n.s END';

describe.if(nativeReady)('an element returned from a CASE branch', () => {
  /** The half that AGREES, so the failing test below cannot be a broken harness. */
  test('a plain element projection agrees across engines', () => {
    const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
    const nat = graphFromNdjson(nativeBackend(), NDJSON);
    const q = 'MATCH (n:L) RETURN n AS k ORDER BY n.n';

    expect(JSON.stringify(nat.query(q))).toBe(JSON.stringify(tsQuery(ts, q)));
  });

  /** And the STRING branch agrees, which localises the divergence to the element branch. */
  test('the non-element CASE branch agrees across engines', () => {
    const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
    const nat = graphFromNdjson(nativeBackend(), NDJSON);
    const q = `MATCH (n:L) WHERE n.n = 9 RETURN ${CASE_EXPR} AS k`;

    expect(JSON.stringify(nat.query(q))).toBe(JSON.stringify(tsQuery(ts, q)));
  });

  /**
   * ⚠️ THE DIVERGENCE. Pinned as FAILING: it flips to passing the day native stops dropping the
   * element, and until then it is a red line in the suite rather than a note nobody reads.
   */
  test.failing('native drops the element and returns an integer', () => {
    const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
    const nat = graphFromNdjson(nativeBackend(), NDJSON);
    const q = `MATCH (n:L) RETURN ${CASE_EXPR} AS k ORDER BY n.n`;

    expect(JSON.stringify(nat.query(q))).toBe(JSON.stringify(tsQuery(ts, q)));
  });

  /**
   * ⚠️ AND THE COUNT AGREES, WHICH IS WHY THIS WAS NEARLY MISSED. `count(DISTINCT <the CASE>)`
   * reads 6 on both engines over the wider fixture item 1873 built — native's integers are
   * distinct from each other and from the strings, so the CARDINALITY survives while the VALUES do
   * not. A probe that only counted would have reported agreement.
   */
  test('the DISTINCT COUNT of the same expression agrees — the cardinality survives', () => {
    const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
    const nat = graphFromNdjson(nativeBackend(), NDJSON);
    const q = `MATCH (n:L) RETURN count(DISTINCT ${CASE_EXPR}) AS c`;

    expect(JSON.stringify(nat.query(q))).toBe(JSON.stringify(tsQuery(ts, q)));
  });
});
