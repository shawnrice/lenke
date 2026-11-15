// A TS-ONLY WRONG ANSWER in the deferred hop order arm, found at item 1903 and fixed there.
//
// ⚠️⚠️ THE SHAPE: a hop whose PROJECTION reads one end and whose SORT KEY reads the other, under a
// window. `MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k LIMIT 3` — an entirely ordinary
// "top 3, returning the near end, ranked by the far end" query, and `ORDER BY e.w LIMIT 3` ("top 3
// by edge weight") is the same shape.
//
//     TS      [{c:1},{c:2},{c:3}]      ⬅ WRONG: the rows came back in ARRIVAL order
//     native  [{c:3},{c:2},{c:1}]          and TS's own general path agreed with native
//
// ⚠️ THE CAUSE was three walk-eligibility flags describing the WRONG PROJECTION.
// `detectHopProjection` hands the walk `walkProj` — the deferred arm's reduced copy, whose items
// are the sort KEYS plus one carrier per endpoint — while `projStartOnly`, `itemsReadStart` and
// `itemsReadRel` were all derived from `projected`, the analysis of the REAL items.
// `projStartOnly` means "every row a start vertex produces is identical, so project once and
// copy", which is true of `n.k AS c` and false of a reduced row carrying `m.k`. So the walk never
// bound the far variable, every key evaluated to NULL, the sort became a no-op, and the rows came
// out in the walk's arrival order.
//
// ⚠️ FOUR OF FIVE END/KEY COMBINATIONS DIVERGED. Only "projection reads the far end, key reads the
// start" was right, and that by luck of which variable the walk happened to bind.
//
// ⚠️ WHY NOTHING CAUGHT IT: the workload corpus's `withOrder` orders only by the projection's
// ALIAS, so no generated query ever puts a bare variable read in a sort key — the blind spot item
// 1902 found one item earlier and fixed for the NODE shape. This file is the hop half of that.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// Three vertices in a cycle, so the near and far ends of every edge carry DIFFERENT `k` — a
// fixture where the two ends agree cannot see this bug at all. Edge weights descend as `k`
// ascends, so a rel key orders differently from either endpoint.
const NDJSON = [
  '{"type":"node","id":"x","labels":["Q"],"properties":{"k":1}}',
  '{"type":"node","id":"y","labels":["Q"],"properties":{"k":2}}',
  '{"type":"node","id":"z","labels":["Q"],"properties":{"k":3}}',
  '{"type":"edge","id":"r1","from":"x","to":"z","labels":["R"],"properties":{"w":30}}',
  '{"type":"edge","id":"r2","from":"y","to":"y","labels":["R"],"properties":{"w":20}}',
  '{"type":"edge","id":"r3","from":"z","to":"x","labels":["R"],"properties":{"w":10}}',
].join('\n');

/**
 * ⚠️ A FIXTURE WHOSE TIES HIDE THE BUG IS WORSE THAN NO FIXTURE, and the first one did. On the perf
 * screen's graph (eight distinct `n` over 200,000 vertices) the broken arm's arrival order and the
 * correct order produce the SAME first ten rows, so the wrong answer measured 7.6x FASTER and
 * looked like a clean win. Here `n` is distinct and each edge points at the vertex that reverses
 * it, so arrival order and far-key order are exact opposites.
 */
const reversingChain = (n: number): string => {
  const lines: string[] = [];

  for (let i = 0; i < n; i += 1) {
    lines.push(
      `{"type":"node","id":"${String(i + 1)}","labels":["T"],"properties":{"n":${String(i)}}}`,
    );
  }

  for (let i = 0; i < n; i += 1) {
    lines.push(
      `{"type":"edge","id":"e${String(i)}","from":"${String(i + 1)}","to":"${String(n - i)}","labels":["E"],"properties":{"w":${String(i)}}}`,
    );
  }

  return lines.join('\n');
};

describe.if(nativeReady)('a hop sort key reading an end the projection does not', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** Every end/key combination, because only one of the five was accidentally correct. */
  const CASES = [
    'MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k LIMIT 3',
    'MATCH (n:Q)-[:R]->(m:Q) RETURN m.k AS c ORDER BY n.k LIMIT 3',
    'MATCH (n:Q)-[e:R]->(m:Q) RETURN n.k AS c ORDER BY e.w LIMIT 3',
    'MATCH (n:Q)-[e:R]->(m:Q) RETURN m.k AS c ORDER BY e.w LIMIT 3',
    'MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k + 1 LIMIT 3',
    'MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k DESC LIMIT 3',
    // An ANONYMOUS start, so the fix's `startVarName !== undefined` guard is exercised.
    'MATCH (:Q)-[:R]->(m:Q) RETURN m.k AS c ORDER BY m.k + 1 LIMIT 3',
    // ⚠️ UNWINDOWED, which item 1903's other half newly routes through the same arm.
    'MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k',
    'MATCH (n:Q)-[e:R]->(m:Q) RETURN n.k AS c ORDER BY e.w',
    'MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k, n.k',
  ];

  for (const text of CASES) {
    test(text, () => {
      const a = JSON.stringify(tsQuery(ts, text));

      expect(a).toBe(JSON.stringify(nat.query(text)));
      expect(a).not.toBe('[]');
    });
  }

  test('the reversing chain, where arrival order is the exact opposite of the answer', () => {
    const doc = reversingChain(60);
    const natB = graphFromNdjson(nativeBackend(), doc);
    const tsB = tsDeserialize(doc, 'ndjson', new Graph());
    const text = 'MATCH (a:T)-[:E]->(b:T) RETURN a.n AS c ORDER BY b.n + 1 LIMIT 5';
    const got = tsQuery(tsB, text);

    expect(JSON.stringify(got)).toBe(JSON.stringify(natB.query(text)));
    // Spelled out, because this is the row the broken arm returned: it answered `c` ASCENDING
    // (0,1,2,3,4 — arrival order) where the far end's `n` ascending means `a.n` DESCENDING.
    expect(got).toStrictEqual([{ c: 59 }, { c: 58 }, { c: 57 }, { c: 56 }, { c: 55 }]);
  });
});
