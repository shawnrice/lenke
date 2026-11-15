import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady, resultsEqualInOrder } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';
import { sortMatrixNdjson, sortMatrixShapes } from './sort-matrix.js';

/**
 * EVERY SORT SHAPE AGAINST NATIVE, IN ORDER (item 1904).
 *
 * ⚠️⚠️ **THIS EXISTS BECAUSE ITEM 1903'S WRONG ANSWER WAS FOUND BY ACCIDENT.** A hop sort key
 * reading an end the projection does not was ranked on NULL keys and came back in the walk's
 * arrival order; four of five end/key combinations diverged from native, `ORDER BY e.w LIMIT 3`
 * among them. It surfaced only because a perf gate routed a second spelling into the broken arm and
 * one pre-existing test happened to cover one case. Nothing was asking systematically, and all
 * three stores that should have been are blind the same way — see `sort-matrix.ts`.
 *
 * ⚠️ VERIFIED TO HAVE TEETH, not assumed: restoring the pre-item-1903 derivation (all three walk
 * binding flags from the real projection's analysis) makes **30 of these shapes diverge**. ⚠️ And
 * reverting only ONE of the three does NOT — the fix is over-determined, which is worth knowing
 * because a later edit could remove two of the three and still look correct here.
 */
describe.if(nativeReady)('the sort-shape matrix agrees with native', () => {
  const doc = sortMatrixNdjson();
  const nat = graphFromNdjson(nativeBackend(), doc);
  const ts = tsDeserialize(doc, 'ndjson', new Graph());
  const shapes = sortMatrixShapes();

  test('the matrix is the size it claims, so a silently empty list cannot pass', () => {
    // 3 projections x 8 keys x 5 windows, plus 4 x 10 x 5.
    expect(shapes).toHaveLength(320);
  });

  test('every shape agrees, compared AS ORDER rather than as a multiset', () => {
    const diverged: string[] = [];
    let nonEmpty = 0;

    for (const text of shapes) {
      const a = tsQuery(ts, text);
      const b = nat.query(text);

      if (!resultsEqualInOrder(JSON.stringify(a), JSON.stringify(b))) {
        diverged.push(text);
        continue;
      }

      if (a.length > 0) {
        nonEmpty += 1;
      }
    }

    expect(diverged).toStrictEqual([]);
    // ⚠️ AND MOST OF THEM MUST RETURN ROWS. Two engines agree trivially on nothing, and the
    // `LIMIT 0` arm is 64 of the 320 shapes by construction.
    expect(nonEmpty).toBe(320 - 64);
  });
});
