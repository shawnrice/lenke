import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 427: paging an UNORDERED stream whose projection cannot raise skips the BINDINGS instead
// of projecting every row and paging the projected ones. 1.96-2.09x on four shapes, landing on
// the 25.6 ms general-stream floor item 426 measured.
//
// The gate (`CProjection.cannotFault`) is what makes this byte-identical rather than a behaviour
// change. BOTH engines currently fault on a skipped row's `CAST` — `skipcast_426` is the
// evidence, and item 426 is why that stays — so the first test here is the one that matters: a
// faulting projection must still fault under a SKIP, exactly as native does.
const build = (): Graph => {
  const g = new Graph();

  // v0's `s` is not castable, and it is the FIRST row, so every SKIP below steps over it. If the
  // fast path ever took a shape it should not, this is what sees it.
  // `m` is a STRING on v0 and a number everywhere else, so `a.m + 1` faults on the first row
  // ALONE. `s` cannot do that job — it is a string on every node, so `a.s + 1` faults whichever
  // row is projected, and the mutant that admits arithmetic to the allowlist survived a test
  // built on it. Third fixture this session that looked like it exercised a guard and did not
  // (items 422, 425), and found the same way.
  g.addVertex({ id: 'v0', labels: ['P'], properties: { s: 'abc', n: 0, d: 'a', m: 'abc' } });

  for (let i = 1; i < 6; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      // `d` has DUPLICATES, so dedup-then-page and page-then-dedup give different answers —
      // which is what the `!proj.distinct` guard is for.
      properties: { s: String(i), n: i, d: i < 3 ? 'a' : String(i), m: i },
    });
  }

  return g;
};

describe('skip over a fault-free projection', () => {
  const g = build();

  // THE INVARIANT. Both engines fault here (checked natively in `skipcast_426`), so the fast
  // path must NOT take a projection that can raise, however much cheaper skipping would be.
  test('a projection that can raise still faults under a SKIP, as native does', () => {
    expect(() => query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x SKIP 1 LIMIT 1')).toThrow();
    expect(() => query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x SKIP 1')).toThrow();
    // Arithmetic over a string raises too, and is a DIFFERENT expression kind — so this pins the
    // allowlist rather than just the `CAST` arm of it. `m` is the string on v0 ONLY, so the row
    // that faults is exactly the row the SKIP steps over: admitting `arith` to the allowlist
    // makes this stop throwing, where `a.s + 1` would throw either way.
    expect(() => query(g, 'MATCH (a:P) RETURN a.m + 1 AS x SKIP 1 LIMIT 1')).toThrow();
    expect(() => query(g, 'MATCH (a:P) RETURN a.s + 1 AS x SKIP 1 LIMIT 1')).toThrow();
    // And with no SKIP at all, where the row IS emitted: still a fault, unchanged.
    expect(() => query(g, 'MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x LIMIT 1')).toThrow();
  });

  // The admitted shapes: a property read, several, a bare variable, a literal, and `RETURN *`.
  test.each([
    ['one property', 'MATCH (a:P) RETURN a.n AS x SKIP 2 LIMIT 2', [{ x: 2 }, { x: 3 }]],
    ['no limit', 'MATCH (a:P) RETURN a.n AS x SKIP 4', [{ x: 4 }, { x: 5 }]],
    ['two properties', 'MATCH (a:P) RETURN a.n AS x, a.s AS y SKIP 4 LIMIT 1', [{ x: 4, y: '4' }]],
    ['a literal', 'MATCH (a:P) RETURN 7 AS x SKIP 4 LIMIT 1', [{ x: 7 }]],
    // SKIP past the end, and a LIMIT larger than what is left.
    ['skip past the end', 'MATCH (a:P) RETURN a.n AS x SKIP 99 LIMIT 2', []],
    ['limit past the end', 'MATCH (a:P) RETURN a.n AS x SKIP 4 LIMIT 99', [{ x: 4 }, { x: 5 }]],
  ])('%s', (_name, q, want) => {
    expect(query(g, q)).toEqual(want);
  });

  test('a bare variable', () => {
    const rows = query(g, 'MATCH (a:P) RETURN a AS x SKIP 4 LIMIT 1') as Array<{
      x: { id: string };
    }>;

    expect(rows.map((r) => r.x.id)).toEqual(['v4']);
  });

  test('RETURN * copies the binding', () => {
    const rows = query(g, 'MATCH (a:P) RETURN * SKIP 4 LIMIT 1') as Array<{ a: { id: string } }>;

    expect(rows.map((r) => r.a.id)).toEqual(['v4']);
  });

  // DISTINCT dedups the PROJECTED rows, so paging must happen after the dedup. `d` is 'a' on
  // three nodes: dedup gives ['a','3','4','5'] and `SKIP 1 LIMIT 1` is '3'. Skipping bindings
  // first would dedup ['a','a','3','4','5'] to ['a','3','4','5'] and answer 'a'.
  test('DISTINCT pages the deduped rows, not the bindings', () => {
    expect(query(g, 'MATCH (a:P) RETURN DISTINCT a.d AS x SKIP 1 LIMIT 1')).toEqual([{ x: '3' }]);
    expect(query(g, 'MATCH (a:P) RETURN DISTINCT a.d AS x SKIP 1')).toEqual([
      { x: '3' },
      { x: '4' },
      { x: '5' },
    ]);
  });

  // An ORDER BY with NO limit does not reach the top-k branch (which requires a limit), so it
  // falls through to where this fast path sits — and must still sort before paging.
  test('ORDER BY with a SKIP and no LIMIT still sorts first', () => {
    expect(query(g, 'MATCH (a:P) RETURN a.n AS x ORDER BY x DESC SKIP 1')).toEqual([
      { x: 4 },
      { x: 3 },
      { x: 2 },
      { x: 1 },
      { x: 0 },
    ]);
    expect(query(g, 'MATCH (a:P) RETURN a.n AS x ORDER BY x SKIP 4')).toEqual([{ x: 4 }, { x: 5 }]);
  });

  // An aggregate has one row per group and no per-input row to page.
  test('an aggregate is unaffected', () => {
    expect(query(g, 'MATCH (a:P) RETURN count(*) AS c SKIP 0 LIMIT 1')).toEqual([{ c: 6 }]);
    expect(query(g, 'MATCH (a:P) RETURN max(a.n) AS m SKIP 1 LIMIT 1')).toEqual([]);
  });
});
