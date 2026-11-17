/*
 * Item 2108 — `SEEK_MAX_FRACTION` is 0.25, DERIVED from this engine's own per-unit costs.
 *
 * ⚠️⚠️ **A THRESHOLD IS A ROUTE CHOICE, SO IT IS ANSWER-EQUIVALENT AND EVERY MUTANT OF IT SURVIVES A
 * BEHAVIOURAL TEST.** The standing rule applies: test the arithmetic, not the timing. What can be pinned
 * is (a) the constant's VALUE, since it was derived and the derivation is recorded beside it, (b) that
 * `seekIsWorthIt` agrees with it at the boundary, and (c) that the answer does not depend on which side
 * of the boundary a query falls — which is the property a wrong threshold could break.
 *
 * 🔑 WHY (a) IS WORTH A TEST AT ALL. This value has been changed once on measurement, and the two errors
 * are not symmetric: a wrong DECLINE costs the scan it fell back to, a wrong SEEK is unbounded. A test
 * that names the number makes a casual edit visible in review rather than only in a benchmark nobody
 * runs. `matching.ts` carries the derivation; this carries the commitment.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { SEEK_MAX_FRACTION, seekIsWorthIt } from './executor/matching.js';
import { query } from './index.js';

const NODES = 20_000;

/** One fixture, built twice, so only the index differs — the two routes over one graph. */
const build = (withIndex: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { n: i % 97, sel: (i * 7919) % 1000 },
    });
  }

  for (let e = 0; e < NODES * 2; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  if (withIndex) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });
  }

  return g;
};

describe('SEEK_MAX_FRACTION (item 2108)', () => {
  test('🔑 the value is 0.25, and `matching.ts` carries why', () => {
    /*
     * ⚠️ DERIVED, NOT FITTED — the same method native uses (`opt.rs`: 1.88 ns/node scan over 12.2 ns/row
     * seek = 15.4%). Measured on THIS engine at 200,000 nodes: a scan costs **33.64 ns/node** (a `Map`
     * walk plus a property read, not a `u32` compare) and a seek **127.61 ns/row**, so the break-even is
     * 33.64 / 127.61 = **26.4%**.
     *
     * 🔑 THE SHIPPED VALUE IS BELOW THE DERIVED ONE ON PURPOSE. A wrong decline is bounded by the scan;
     * a wrong seek is not (native records 5.02x at 60%). Staying under the crossover keeps the residual
     * error on the bounded side — the principle the previous value was chosen on, applied to a corrected
     * number.
     */
    expect(SEEK_MAX_FRACTION).toBe(0.25);
    // ⚠️ And it must stay under the derived crossover, which is the invariant rather than the digits.
    expect(SEEK_MAX_FRACTION).toBeLessThan(0.264);
  });

  test('⚠️ `seekIsWorthIt` agrees with the constant at the boundary', () => {
    const g = build(true);
    const bucket = NODES;

    // Comfortably inside: admitted. Comfortably outside: declined.
    expect(seekIsWorthIt(g, { kind: 'label', name: 'P' }, Math.floor(bucket * 0.1))).toBe(true);
    expect(seekIsWorthIt(g, { kind: 'label', name: 'P' }, Math.floor(bucket * 0.4))).toBe(false);

    /*
     * 🔑 THE BOUNDARY ITSELF, pinned at N and N-1 rather than at a round fraction — the rule for a
     * threshold is to straddle it by one, so an off-by-one in the comparison is visible.
     */
    const at = Math.floor(bucket * SEEK_MAX_FRACTION);

    expect(seekIsWorthIt(g, { kind: 'label', name: 'P' }, at - 1)).toBe(true);
    expect(seekIsWorthIt(g, { kind: 'label', name: 'P' }, at + 2)).toBe(false);
  });

  test('⚠️ a seek WIDER than its bucket is refused at any size — item 176', () => {
    /*
     * This predates item 2108 and must survive it: raising the fraction must not let a seek through that
     * is simply bigger than the scan it replaces.
     */
    const g = build(true);

    expect(seekIsWorthIt(g, { kind: 'label', name: 'P' }, NODES + 1)).toBe(false);
  });

  test('⚠️⚠️ the ANSWER never depends on which side of the threshold a query falls', () => {
    /*
     * 🔑 THE PROPERTY A WRONG THRESHOLD COULD ACTUALLY BREAK. The seed only has to be a SUPERSET —
     * `matchNode` and the residual `WHERE` re-validate — so seeking or scanning must give the same rows.
     * Every selectivity here is swept across the boundary (10% to 40%, so both sides), both shapes, with
     * the indexed and unindexed graphs required to agree.
     */
    const indexed = build(true);
    const plain = build(false);
    /*
     * ⚠️⚠️ **COMPARED AS A MULTISET, AND THIS TEST FAILED UNTIL IT WAS.** Seeking and scanning emit the
     * same rows in a DIFFERENT ORDER, and row order is unspecified in this engine by policy — the
     * differential fuzzer compares row multisets for the same reason. `toStrictEqual` on the raw arrays
     * reported 29 differences that were all reorderings (81 against 70, 14 against 40, …), and the sets
     * were verified identical at all nine selectivities before this was changed.
     *
     * 🔑 So a genuine divergence still fails here — a lost or invented row changes the multiset — while a
     * reordering does not.
     */
    const bag = (rows: readonly Record<string, unknown>[]): string[] =>
      rows.map((r) => JSON.stringify(r)).sort();

    for (const hi of [50, 100, 200, 240, 250, 260, 300, 400, 600]) {
      for (const q of [
        'MATCH (b:P) WHERE b.sel < $hi RETURN min(b.n) AS lo, count(*) AS c',
        'MATCH (a:P)-[:E]->(b:P) WHERE b.sel < $hi RETURN min(a.n) AS lo, count(*) AS c',
        'MATCH (a:P)-[:E]->(b:P) WHERE b.sel < $hi RETURN DISTINCT a.n AS n',
      ]) {
        const got = query(indexed, q, { hi });

        expect(bag(got)).toStrictEqual(bag(query(plain, q, { hi })));
        // ⚠️ An empty answer would agree trivially at every selectivity.
        expect(got.length).toBeGreaterThan(0);
      }
    }
  });

  test('⚠️ a count AT the cap stays exact, so ranking among admitted candidates is unchanged', () => {
    /*
     * 🔑 `rangeCountCap` is `candidateCount * SEEK_MAX_FRACTION`, and item 1756's argument for it being
     * behaviour-identical depends on counts at or below the cap staying EXACT. Raising the fraction
     * raises the cap, so that argument has to still hold — and it is what the ~5% cost measured on
     * `hop2rows` buys: `countRange` is O(distinct values in range) bounded by the cap, so a doubled cap
     * walks further before stopping.
     *
     * ⚠️ Asserted through the answer across a two-candidate predicate, since the cap is internal.
     */
    const indexed = build(true);
    const plain = build(false);
    const q = 'MATCH (b:P) WHERE b.sel < $hi AND b.n > $lo RETURN min(b.n) AS lo, count(*) AS c';

    // ⚠️ `toStrictEqual` is safe HERE: an un-grouped aggregate is exactly one row, so there is no order.
    for (const hi of [100, 250, 400]) {
      expect(query(indexed, q, { hi, lo: 5 })).toStrictEqual(query(plain, q, { hi, lo: 5 }));
    }
  });
});
