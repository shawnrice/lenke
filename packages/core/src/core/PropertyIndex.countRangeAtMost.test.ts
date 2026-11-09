// `countRangeAtMost` — the early-terminating range count behind item 1756's 1.60x.
//
// ⚠️ THIS EXISTS BECAUSE THE CHANGE IT GUARDS IS ANSWER-EQUIVALENT. An index seed only has to be a
// SUPERSET (`matchNode` and the residual `WHERE` re-validate), so swapping which seed the planner
// picks — or breaking the count that decides it — cannot change a single query result. Every
// differential and fuzz test passes either way. `perf-gate-needs-its-own-test` is the rule: extract
// the arithmetic and test it directly, because nothing else can see it.
//
// The three properties that make the capped count safe to substitute for the exact one:
//
//   1. at or below the cap it is EXACT       — so ranking among ADMITTED candidates is unchanged
//   2. above the cap it reports `> cap`      — so the gate's decline is unchanged
//   3. with an infinite cap it IS countRange — which is what the sub-floor path relies on
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.ts';

/** 400 vertices, `n` unique (400 distinct values) and `k` 40-valued (10 vertices each). */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 400; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i, k: i % 40 } });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

  return g;
};

describe('PropertyIndex.countRangeAtMost', () => {
  test('is EXACT at or below the cap', () => {
    const idx = build().vertexPropertyIndex;

    // 50 matching values, each one vertex.
    expect(idx.countRangeAtMost('n', { lt: 50 }, 50)).toBe(50);
    expect(idx.countRangeAtMost('n', { lt: 50 }, 1000)).toBe(50);
    // Exactly at the cap is still exact — the early return is on `> cap`, not `>= cap`.
    expect(idx.countRangeAtMost('n', { lt: 7 }, 7)).toBe(7);
  });

  test('reports a value ABOVE the cap once it passes it, and stops early', () => {
    const idx = build().vertexPropertyIndex;
    const capped = idx.countRangeAtMost('n', { lt: 400 }, 10) as number;

    // The contract is only "greater than the cap" — not the exact total, which is the whole point.
    expect(capped).toBeGreaterThan(10);
    // ⚠️ AND IT MUST HAVE STOPPED: the exact count is 400, so a capped answer that reached 400 did
    // not terminate early and the fix would be inert. This is the assertion that has teeth.
    expect(capped).toBeLessThan(400);
  });

  test('with an INFINITE cap it equals countRange — the sub-floor path depends on this', () => {
    const idx = build().vertexPropertyIndex;

    for (const bound of [{ lt: 50 }, { lte: 399 }, { gt: 100 }, { gte: 0 }] as const) {
      expect(idx.countRangeAtMost('n', bound, Number.POSITIVE_INFINITY)).toBe(
        idx.countRange('n', bound) as number,
      );
    }
  });

  test('a bucketed column stops early on BUCKET SIZES, not value count', () => {
    const idx = build().vertexPropertyIndex;

    // `k < 20` is 20 distinct values holding 10 vertices each = 200. With a cap of 25 the walk
    // stops after the third value (30 > 25), so the answer exceeds the cap but is far below 200.
    const capped = idx.countRangeAtMost('k', { lt: 20 }, 25) as number;

    expect(capped).toBeGreaterThan(25);
    expect(capped).toBeLessThan(200);
  });

  test('an unindexed key is undefined, as countRange is', () => {
    const idx = build().vertexPropertyIndex;

    expect(idx.countRangeAtMost('nope', { lt: 10 }, 5)).toBeUndefined();
    expect(idx.countRange('nope', { lt: 10 })).toBeUndefined();
  });
});
