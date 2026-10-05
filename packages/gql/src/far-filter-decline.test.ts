import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `filteredHopWalk` is the fused hop projection's filtered walk, and `carriedWhere` accepts a
// clause `WHERE` only when it reads the FAR variable — so the walk took precisely the filters it
// handles worst. A far-reading filter cannot reject a start vertex before expanding it, and the
// end it constrains (the seekable one) is not the end the walk drives. A filter reading only the
// START declines here and reaches the general path's seed, which is why that spelling was already
// fast. Measured on 20,000 users, `name` indexed (audit item 177):
//
//   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name     3966.1us -> 36.7us
//   (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN u.name            3531.5us -> 31.0us
//   (x:User {name: $n})<-[:FOLLOWS]-(u) RETURN u.name              35.3us  (general path)
//   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name       49.6us  (general path)
//
// 97x between a query and the SAME query with its arrow flipped. The fix is a runtime DECLINE:
// when the far end offers a seek NARROWER THAN THE START SOURCE BY A MARGIN, hand the query to
// the general path. The margin is load-bearing and measured — see `SEEK_MARGIN`.
//
// Two kinds of assertion here, and both are needed. The answers must not change (declining swaps
// which path builds the rows, so the row MULTISET and the COLUMN order have to be identical), and
// the CHOICE must be observable — a decline changes no row, so index hits are the witness.

/**
 * 40 users in a ring with chords, plus one `Other` sharing a name value with `u2` and carrying a
 * `FOLLOWS` edge, so a seek on `name` returns a vertex the far label must reject.
 *
 * The size matters: the decline needs the seek to be 8x narrower than the start source, and the
 * start source here is every vertex (41). A `name` seek returns 1-2 (decline); a `t` seek returns
 * about 14 (keep). One fixture therefore exercises BOTH sides of the margin.
 */
const ring = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, t: i % 3 } });
  }

  g.addVertex({ id: 'x0', labels: ['Other'], properties: { name: 'user2', t: 0 } });

  const v = (id: string) => g.getVertexById(id)!;

  for (let i = 0; i < 40; i++) {
    g.addEdge({
      id: `f${i}`,
      from: v(`u${i}`),
      to: v(`u${(i + 1) % 40}`),
      labels: ['FOLLOWS'],
      properties: {},
    });
    g.addEdge({
      id: `h${i}`,
      from: v(`u${i}`),
      to: v(`u${(i + 7) % 40}`),
      labels: ['FOLLOWS'],
      properties: {},
    });
  }

  g.addEdge({ id: 'o1', from: v('u0'), to: v('u2'), labels: ['OTHER'], properties: {} });
  g.addEdge({ id: 'xe', from: v('x0'), to: v('u2'), labels: ['FOLLOWS'], properties: {} });

  if (indexed) {
    for (const k of ['name', 't']) {
      g.createIndex({ on: 'vertex', kind: 'hash', keys: [k] });
    }
  }

  return g;
};

/** Rows as an order-independent multiset, since row order is unspecified. */
const multiset = (rows: readonly unknown[]): string =>
  JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());

/** The COLUMN order, which unlike row order IS observable bytes. */
const columns = (rows: readonly unknown[]): string =>
  rows.length === 0 ? '-' : Object.keys(rows[0] as object).join(',');

/**
 * Assert the indexed and unindexed plans agree, and return the row count. The two take DIFFERENT
 * paths whenever the decline fires, which is exactly why they are compared.
 */
const agree = (q: string, params: Record<string, unknown>): number => {
  const walked = query(ring(false), q, params);
  const declined = query(ring(true), q, params);

  expect(multiset(declined)).toBe(multiset(walked));
  expect(columns(declined)).toBe(columns(walked));

  return walked.length;
};

/** How many times a query asks the property index for a set — the witness for a decline. */
const hits = (g: Graph, q: string, params: Record<string, unknown>): number => {
  const idx = g.vertexPropertyIndex as unknown as {
    equals: (key: string, value: unknown) => unknown;
  };
  const real = idx.equals.bind(idx);
  let calls = 0;

  idx.equals = (key: string, value: unknown) => {
    calls += 1;

    return real(key, value);
  };

  query(g, q, params);

  return calls;
};

const FAR_CLAUSE = 'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name AS r';
const FAR_INLINE = 'MATCH (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN u.name AS r';

describe('a far-end filter declines the fused walk when it can seek (item 177)', () => {
  test('the answer is unchanged: multiset and column order both agree', () => {
    // Three FOLLOWS edges reach `u2`: from u1, from u35 (35+7=42, wraps to 2) and from `x0`.
    expect(agree(FAR_CLAUSE, { n: 'user2' })).toBe(3);
    expect(agree(FAR_INLINE, { n: 'user2' })).toBe(3);
  });

  test('projecting the far end, both ends, or neither still agrees', () => {
    expect(
      agree('MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN x.t AS r', { n: 'user2' }),
    ).toBe(3);
    // TWO columns, so a path that built them in a different order would be caught.
    expect(
      agree('MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name AS a, x.t AS b', {
        n: 'user2',
      }),
    ).toBe(3);
  });

  test('a labelled start drops the Other vertex, under both plans', () => {
    expect(
      agree('MATCH (u:User)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name AS r', {
        n: 'user2',
      }),
    ).toBe(2);
  });

  test('a filter reading BOTH ends agrees', () => {
    expect(
      agree('MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n AND u.t = 0 RETURN u.name AS r', {
        n: 'user2',
      }),
    ).toBeLessThan(3);
  });

  test('the IN direction agrees', () => {
    expect(
      agree('MATCH (u)<-[:FOLLOWS]-(x:User) WHERE x.name = $n RETURN u.name AS r', {
        n: 'user2',
      }),
    ).toBe(2);
  });

  test('a far label the seeked vertex fails, and a no-match, both agree', () => {
    expect(
      agree('MATCH (u)-[:FOLLOWS]->(x:Other) WHERE x.name = $n RETURN u.name AS r', {
        n: 'user2',
      }),
    ).toBe(0);
    expect(agree(FAR_CLAUSE, { n: 'nobody' })).toBe(0);
  });

  // The witness. A decline changes no row, so the only observable is whether the index was asked
  // for a SET — `indexCandidates` costs an O(1) `countEquals` for its estimate, so a walk that
  // keeps the fast path registers zero.
  test('a SELECTIVE far filter declines, and the general path seeks', () => {
    expect(hits(ring(true), FAR_CLAUSE, { n: 'user2' })).toBeGreaterThan(0);
    expect(hits(ring(true), FAR_INLINE, { n: 'user2' })).toBeGreaterThan(0);
  });

  test('CONTROL an indexed but UNSELECTIVE far filter keeps the fused walk', () => {
    // `t` takes 3 values over 41 vertices, so a seek returns ~14 — not 8x narrower than the
    // start source, and the general path would cost more per row than the walk saves. This is
    // the case a plain `narrowest < source` guard sent the wrong way, measured at 3.1x worse.
    expect(
      hits(ring(true), 'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.t = $t RETURN u.name AS r', {
        t: 0,
      }),
    ).toBe(0);
  });

  test('CONTROL an UNINDEXED far filter keeps the fused walk', () => {
    expect(
      hits(ring(true), 'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.nosuch = $n RETURN u.name AS r', {
        n: 'zzz',
      }),
    ).toBe(0);
  });

  test('CONTROL an UNFILTERED hop keeps the fused walk', () => {
    // Nothing to seek, and this is the hot path items 159/160 measured — it must not acquire a
    // per-execution index enumeration.
    expect(hits(ring(true), 'MATCH (u:User)-[:FOLLOWS]->(x) RETURN x.name AS r', {})).toBe(0);
  });

  test('among several seekable far keys the NARROWEST decides', () => {
    // `name` offers ~2 and `t` offers ~14; only the narrower one passes the margin. A chooser
    // taking the widest would keep the walk here.
    expect(
      hits(
        ring(true),
        'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n AND x.t = $t RETURN u.name AS r',
        { n: 'user2', t: 2 },
      ),
    ).toBeGreaterThan(0);
  });

  test('a START-reading filter is unaffected: it never reached this walk', () => {
    // `carriedWhere` requires the far variable, so this already declined at compile time.
    expect(
      agree('MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name AS r', {
        n: 'user2',
      }),
    ).toBe(2);
  });

  test('a declined query still answers through SKIP/LIMIT and ORDER BY', () => {
    // Those projections are refused by the fast path's own guard, so they take the general path
    // either way — included because `LIMIT 1` was one of the clues that found this.
    expect(
      agree(
        'MATCH (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name AS r ORDER BY r LIMIT 2',
        {
          n: 'user2',
        },
      ),
    ).toBe(2);
  });
});
