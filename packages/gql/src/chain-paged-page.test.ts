import { describe, expect, it } from 'bun:test';

/**
 * THE SKIP-ONLY PAGE AT DEPTH 2 AND DEPTH 3+ (item 1885).
 *
 * `MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k SKIP n` declined `hop2Projection` and
 * `chainProjection` outright — `plainRowProjectionIgnoringDistinct` refuses a `skip` — so every
 * window past one hop went to the general matcher: **26.9 / 36.2 / 49.6 / 59.5 ms at depths 2-5
 * against a ~6 ms unpaged twin** on `rung-gap-screen.mjs`. Items 1776/1777/1778 had already done
 * depths 0 and 1.
 *
 * THE ORACLE HERE IS AN ENUMERATED ROW LIST, NOT ANOTHER SPELLING, and that is forced rather than
 * chosen. `skip-only-page.test.ts` can use `OFFSET $s` as its oracle because that spelling declined
 * the node rung — but item 1778 gave the parameterized page a rung too, and this item follows it, so
 * at these depths **both spellings take the same rung** (`skip-chain-route-1885.mjs` reads
 * `chainPagedProjection` for `OFFSET 5` and for `OFFSET $s` alike). Comparing them would be the
 * rung against itself: item 1775's dead oracle in its quieter form, a probe that cannot fail.
 *
 * So the unpaged list is pinned ABSOLUTELY first, and every paged assertion is that list sliced.
 * `skip-only-page-parity.ts` is the cross-ENGINE half — it reads these depths as positionally
 * identical between the TS rung and native, which is what licences slicing the rung's rows at all.
 *
 * AND EVERY SEQUENCE IS `toStrictEqual`. Item 1884 lost a mutant to `toEqual`, which ignores
 * `undefined` entries.
 */
import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * A chain long enough for depth 3 and small enough to enumerate. `v0 -> v1 -> … -> v7`, one edge
 * each, so depth d returns `8 - d` rows and the ORDER is the vertex order of the chain's start.
 *
 * `k` IS DISTINCT PER VERTEX, so a positional disagreement is visible where a value-wise one is
 * not — the same reason `skip-only-page-parity.ts` gives for its own fixture.
 */
const fixture = (): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < 8; i += 1) {
    vs.push(g.addVertex({ id: `v${String(i)}`, labels: ['L'], properties: { k: i * 10, n: i } }));
  }

  for (let i = 0; i < 7; i += 1) {
    g.addEdge({ id: `e${String(i)}`, from: vs[i], to: vs[i + 1], labels: ['R'] });
  }

  return g;
};

const D2 = 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN c.k AS k';
const D3 = 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k';

describe('the unpaged rows, pinned absolutely — the oracle every page below is sliced from', () => {
  it('depth 2 returns the far end of each two-hop path', () => {
    expect(query(fixture(), D2)).toStrictEqual([
      { k: 20 },
      { k: 30 },
      { k: 40 },
      { k: 50 },
      { k: 60 },
      { k: 70 },
    ]);
  });

  it('depth 3 returns the far end of each three-hop path', () => {
    expect(query(fixture(), D3)).toStrictEqual([
      { k: 30 },
      { k: 40 },
      { k: 50 },
      { k: 60 },
      { k: 70 },
    ]);
  });
});

describe('the SKIP-ONLY page is the unpaged list sliced', () => {
  it('depth 2, every skip from 0 to past the end', () => {
    const g = fixture();
    const all = query(g, D2);

    for (const n of [1, 2, 3, 5, 6, 7, 99]) {
      expect(query(g, `${D2} SKIP ${String(n)}`)).toStrictEqual(all.slice(n));
    }
  });

  it('depth 3, every skip from 0 to past the end', () => {
    const g = fixture();
    const all = query(g, D3);

    for (const n of [1, 2, 4, 5, 20]) {
      expect(query(g, `${D3} SKIP ${String(n)}`)).toStrictEqual(all.slice(n));
    }
  });

  it('`OFFSET` is the ISO spelling of the same page', () => {
    const g = fixture();

    expect(query(g, `${D3} OFFSET 2`)).toStrictEqual(query(g, D3).slice(2));
  });

  /** Item 1778's parameterized page, which takes the same rung here. */
  it('a PARAMETERIZED offset pages identically', () => {
    const g = fixture();

    expect(query(g, `${D3} OFFSET $s`, { s: 2 })).toStrictEqual(query(g, D3).slice(2));
    expect(query(g, `${D2} OFFSET $s`, { s: 4 })).toStrictEqual(query(g, D2).slice(4));
  });

  it('a two-COLUMN projection pages identically', () => {
    const g = fixture();
    const two = 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN a.k AS s, d.n AS t';

    expect(query(g, `${two} SKIP 2`)).toStrictEqual(query(g, two).slice(2));
  });

  it('a skip past the last row is empty, not the whole list', () => {
    expect(query(fixture(), `${D3} SKIP 500`)).toStrictEqual([]);
  });
});

/**
 * THE DECLINED SHAPES, ASSERTED ON THEIR ANSWERS. The route assertions in `routes-fired.test.ts`
 * pin that a bare `LIMIT` does NOT take the rung — the general path is lazy for it and a
 * materializing rung would be a regression — and these pin that the decline still answers correctly,
 * which is the half a route test cannot see.
 */
describe('the shapes the paged rung declines still answer correctly', () => {
  it('a bare LIMIT takes the first rows', () => {
    const g = fixture();

    expect(query(g, `${D3} LIMIT 2`)).toStrictEqual(query(g, D3).slice(0, 2));
  });

  it('SKIP with LIMIT windows correctly', () => {
    const g = fixture();

    expect(query(g, `${D3} SKIP 1 LIMIT 2`)).toStrictEqual(query(g, D3).slice(1, 3));
  });

  it('an ORDER BY with a page is the ordered rung, and still pages', () => {
    const g = fixture();

    expect(query(g, `${D3} ORDER BY k DESC SKIP 1`)).toStrictEqual([
      { k: 60 },
      { k: 50 },
      { k: 40 },
      { k: 30 },
    ]);
  });
});
