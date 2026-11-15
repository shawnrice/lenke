// THE ENDPOINT LABEL ELISION on both shortest-path walks (item 1908), against native.
//
// ⚠️⚠️ **THE ELISION IS A GRAPH PROPERTY, SO THE TEST HAS TO VARY THE GRAPH.** `effectiveLabel`
// returns `undefined` when every vertex carries the label, and the walk then skips the test
// entirely. A fixture where the label is universal proves the fast case and says NOTHING about the
// filtering one — so every query below runs against TWO graphs: one where the endpoint label is
// universal (elided) and one where it is selective (not elided). Item 1551 is why this cannot be a
// compile-time decision, and item 1609 measured a per-ELEMENT `effectiveLabel` call at 1.32x WORSE
// on a graph where it can never elide.
//
// ⚠️ AND `ALL SHORTEST` IS HERE BESIDE `ANY SHORTEST` because both walks took the change; they are
// separate functions with the same call, and testing one would leave the other's elision unchecked.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/**
 * A cycle, a self-loop, a parallel pair and a second component, so shortest DISTANCE is not the
 * same as reachability and the modes differ.
 *
 * `universal` decides whether every vertex carries `T` (the elided case) or only some (the
 * filtering case) — the SAME topology either way, so a difference in the answer is the label's
 * doing and not the graph's.
 */
const ndjson = (universal: boolean): string => {
  const lab = (i: number): string => (universal || i % 2 === 1 ? '["T","Z"]' : '["Z"]');
  const lines = [1, 2, 3, 4, 5, 6].map(
    (i) => `{"type":"node","id":"${String(i)}","labels":${lab(i)},"properties":{"n":${String(i)}}}`,
  );

  lines.push(
    '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2"}',
    '{"type":"edge","id":"e2","labels":["E"],"from":"2","to":"3"}',
    '{"type":"edge","id":"e3","labels":["E"],"from":"3","to":"1"}',
    // A SELF-LOOP and a PARALLEL pair: both change shortest-path bookkeeping.
    '{"type":"edge","id":"e4","labels":["E"],"from":"2","to":"2"}',
    '{"type":"edge","id":"e5","labels":["E"],"from":"1","to":"2"}',
    // A shortcut edge, so one endpoint has two distinct shortest routes (ALL SHORTEST emits both).
    '{"type":"edge","id":"e6","labels":["E"],"from":"1","to":"3"}',
    // A second component.
    '{"type":"edge","id":"e7","labels":["E"],"from":"4","to":"5"}',
    '{"type":"edge","id":"e8","labels":["E"],"from":"5","to":"6"}',
  );

  return lines.join('\n');
};

const QUERIES = [
  'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T) RETURN b.n AS x ORDER BY x',
  'MATCH ALL SHORTEST (a:Z)-[:E]->{1,3}(b:T) RETURN b.n AS x ORDER BY x',
  'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T) WHERE a.n = 1 RETURN b.n AS x ORDER BY x',
  'MATCH ALL SHORTEST (a:Z)-[:E]->{1,3}(b:T) WHERE a.n = 1 RETURN b.n AS x ORDER BY x',
  // `min = 0`, so the seed itself is a candidate endpoint and must face the same label test.
  'MATCH ANY SHORTEST (a:Z)-[:E]->{0,2}(b:T) RETURN b.n AS x ORDER BY x',
  'MATCH ALL SHORTEST (a:Z)-[:E]->{0,2}(b:T) RETURN b.n AS x ORDER BY x',
  // An endpoint PREDICATE as well as a label — the test the elision must not also skip.
  'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T {n: 3}) RETURN b.n AS x ORDER BY x',
  'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T) WHERE b.n > 2 RETURN b.n AS x ORDER BY x',
  // A path variable, which is the other arm of the same emit.
  'MATCH p = ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T) RETURN b.n AS x ORDER BY x',
  // No endpoint label at all — the `undefined` input to `effectiveLabel`.
  'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b) RETURN b.n AS x ORDER BY x',
  // The unbounded forms.
  'MATCH ANY SHORTEST (a:Z)-[:E]->+(b:T) RETURN b.n AS x ORDER BY x',
  'MATCH ANY SHORTEST (a:Z)-[:E]->*(b:T) RETURN b.n AS x ORDER BY x',
] as const;

describe.if(nativeReady)('the shortest-path endpoint label elision', () => {
  for (const universal of [true, false]) {
    const doc = ndjson(universal);
    const nat = graphFromNdjson(nativeBackend(), doc);
    const ts = tsDeserialize(doc, 'ndjson', new Graph());
    const tag = universal ? 'label UNIVERSAL (elided)' : 'label SELECTIVE (not elided)';

    for (const text of QUERIES) {
      test(`${tag}: ${text}`, () => {
        const a = JSON.stringify(tsQuery(ts, text));

        expect(a).toBe(JSON.stringify(nat.query(text)));
      });
    }
  }

  /**
   * ⚠️ AND THE TWO GRAPHS MUST ANSWER DIFFERENTLY, or every assertion above would pass with the
   * label ignored entirely — which is exactly the bug a wrong elision would be.
   */
  test('the selective graph returns FEWER rows than the universal one', () => {
    const q = 'MATCH ANY SHORTEST (a:Z)-[:E]->{1,3}(b:T) RETURN b.n AS x ORDER BY x';
    const uni = tsQuery(tsDeserialize(ndjson(true), 'ndjson', new Graph()), q);
    const sel = tsQuery(tsDeserialize(ndjson(false), 'ndjson', new Graph()), q);

    expect(uni.length).toBeGreaterThan(0);
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.length).toBeLessThan(uni.length);
  });
});
