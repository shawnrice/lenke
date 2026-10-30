// `ORDER BY` on a GROUPED aggregate, both rungs (item 1249).
//
// ⚠️ ROW ORDER IS THE WHOLE ASSERTION HERE, which is why these use `toEqual` on the full array and
// never a multiset comparison. Both grouped rungs refused every `ORDER BY` and fell to the general
// path, which sorted correctly — so the bug this file guards is not a wrong ROW SET, it is a sort
// that silently does not apply. Every case therefore has an expected order that differs from the
// order groups are discovered in.
//
// The fixture is built so the GROUP DISCOVERY order is not the sorted order: the first vertex seen
// carries the LAST city alphabetically, so a rung returning groups unsorted fails rather than
// passing by luck.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

const NDJSON = [
  // v1 is seen FIRST and is in the LAST group, so discovery order != sorted order.
  '{"type":"node","id":"v1","labels":["P"],"properties":{"city":"zed","k":5}}',
  '{"type":"node","id":"v2","labels":["P"],"properties":{"city":"ash","k":9}}',
  '{"type":"node","id":"v3","labels":["P"],"properties":{"city":"mid","k":1}}',
  '{"type":"node","id":"v4","labels":["P"],"properties":{"city":"ash","k":3}}',
  // No `city` at all, so the key is NULL — this is what pins the NULLS placement.
  '{"type":"node","id":"v5","labels":["P"],"properties":{"k":7}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"v1","to":"v1","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"v1","to":"v2","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"v2","to":"v3","properties":{}}',
  '{"type":"edge","id":"e4","labels":["T"],"from":"v3","to":"v4","properties":{}}',
  '{"type":"edge","id":"e5","labels":["T"],"from":"v4","to":"v5","properties":{}}',
].join('\n');

const graph = (): Graph => deserialize(NDJSON, 'ndjson', new Graph());

describe('ORDER BY on a grouped aggregate (item 1249)', () => {
  test('the NODE rung sorts its group rows by the key column', () => {
    expect(query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY c')).toEqual([
      { c: 'ash', lo: 3 },
      { c: 'mid', lo: 1 },
      { c: 'zed', lo: 5 },
      { c: null, lo: 7 },
    ]);
  });

  test('the NODE rung sorts DESC, and by the AGGREGATE column too', () => {
    expect(
      query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY c DESC'),
    ).toEqual([
      { c: 'zed', lo: 5 },
      { c: 'mid', lo: 1 },
      { c: 'ash', lo: 3 },
      // ⚠️ NULL LAST ON DESC TOO, not first. Verified across three spellings — the alias, the key
      // EXPRESSION, and a filtered variant that routes differently — all agreeing. That is
      // `compareSort`'s policy, which `sortGroupRows` uses rather than re-deriving one, so the
      // fast path cannot drift from the general path on it.
      { c: null, lo: 7 },
    ]);

    // The key need not be the group key: an output column holding an aggregate sorts too.
    expect(query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY lo')).toEqual([
      { c: 'mid', lo: 1 },
      { c: 'ash', lo: 3 },
      { c: 'zed', lo: 5 },
      { c: null, lo: 7 },
    ]);
  });

  test('BOTH SPELLINGS of the key resolve — the alias and the expression', () => {
    // ⚠️ THE REASON THIS REUSES THE TALLY'S RULE rather than `outputColumnSorts`: that one matches
    // an output NAME only, and item 1062 measured the asymmetry it creates at 3.8x. So
    // `ORDER BY x.city` must answer exactly what `ORDER BY c` answers.
    const byAlias = query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY c');
    const byExpr = query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY x.city');

    expect(byExpr).toEqual(byAlias);
  });

  test('the HOP rung sorts its group rows the same way', () => {
    // `(a:P)-[:T]->(x)` reaches v1,v2,v3,v4,v5 — every vertex with an in-edge.
    expect(
      query(graph(), 'MATCH (a:P)-[:T]->(x) RETURN x.city AS c, min(x.k) AS lo ORDER BY c'),
    ).toEqual([
      { c: 'ash', lo: 3 },
      { c: 'mid', lo: 1 },
      { c: 'zed', lo: 5 },
      { c: null, lo: 7 },
    ]);

    expect(
      query(graph(), 'MATCH (a:P)-[:T]->(x) RETURN x.city AS c, max(x.k) AS hi ORDER BY hi DESC'),
    ).toEqual([
      { c: 'ash', hi: 9 },
      { c: null, hi: 7 },
      { c: 'zed', hi: 5 },
      { c: 'mid', hi: 1 },
    ]);
  });

  test('an ORDER BY the rung cannot resolve still answers correctly', () => {
    // `ORDER BY x.k` is neither an output column nor the grouping expression, so the rung declines
    // and the general path answers. The ROWS must still be right — a decline is not a licence to
    // return something else.
    const rows = query(graph(), 'MATCH (x:P) RETURN x.city AS c, min(x.k) AS lo ORDER BY min(x.k)');

    expect(rows).toEqual([
      { c: 'mid', lo: 1 },
      { c: 'ash', lo: 3 },
      { c: 'zed', lo: 5 },
      { c: null, lo: 7 },
    ]);
  });
});
