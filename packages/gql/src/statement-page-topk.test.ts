import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 868: the statement-position `<order by and page statement>` selects with a bounded heap
// instead of full-sorting the working binding table. The window's CONTENTS and its ORDER must be
// exactly the sliced full sort's, ties included — `Array.prototype.sort` is stable, so the old path
// broke ties by arrival order, and tie order under ORDER BY is observable between the engines
// (item 605). Every expectation below is derived from the fixture, not from the engine.
//
// The fixture is deliberately TIE-HEAVY: `k = i % 5` puts 400 rows on each key at N = 2000, so a
// heap that loses the arrival tiebreak returns a valid-looking window with the wrong rows — which
// no "is it sorted?" assertion would catch.

const N = 2000;

const graph = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 5, uniq: i, s: `s${i % 7}` },
    });
  }

  return g;
};

const col = (g: Graph, q: string): unknown[] =>
  [...query(g, q)].map((r) => (r as Record<string, unknown>).x);

describe('statement-position ORDER BY … LIMIT (item 868)', () => {
  const g = graph();

  test('a tie-heavy ascending window is the first rows by arrival', () => {
    // k === 0 at i = 0, 5, 10, … so the first ten are 0, 5, …, 45.
    expect(col(g, 'MATCH (p:P) ORDER BY p.k LIMIT 10 RETURN p.uniq AS x')).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45,
    ]);
  });

  test('DESC flips the key but NOT the arrival tiebreak', () => {
    // k === 4 at i = 4, 9, 14, … — ascending by arrival within the descending key.
    expect(col(g, 'MATCH (p:P) ORDER BY p.k DESC LIMIT 10 RETURN p.uniq AS x')).toEqual([
      4, 9, 14, 19, 24, 29, 34, 39, 44, 49,
    ]);
  });

  // Statement position takes OFFSET and NOT `SKIP` (parser.ts, `parsePageClause`), where the
  // clause position accepts both. That asymmetry is pre-existing and is noted as an open
  // conformance question in item 868 rather than asserted either way here.
  test('OFFSET pages inside the tied group rather than past it', () => {
    expect(col(g, 'MATCH (p:P) ORDER BY p.k OFFSET 3 LIMIT 4 RETURN p.uniq AS x')).toEqual([
      15, 20, 25, 30,
    ]);
  });

  test('a window WIDER than the tied group spills into the next key, still by arrival', () => {
    const rows = col(g, 'MATCH (p:P) ORDER BY p.k LIMIT 402 RETURN p.uniq AS x') as number[];

    expect(rows.length).toBe(402);
    // the 400 rows carrying k === 0, in arrival order
    expect(rows[0]).toBe(0);
    expect(rows[399]).toBe(1995);
    // then the first two carrying k === 1
    expect(rows.slice(400)).toEqual([1, 6]);
  });

  test('the heap and the full sort agree — the SAME query either side of the admission gate', () => {
    // The bounded heap is admitted only while `(skip + limit) * 16 <= rows`. At N = 2000 a
    // LIMIT of 10 is admitted (160 <= 2000) and a LIMIT of 500 is not (8000 > 2000), so these two
    // queries run DIFFERENT code. The second is therefore the oracle for the first: the heap's
    // window has to be a prefix of the full sort's.
    const wide = col(g, 'MATCH (p:P) ORDER BY p.k LIMIT 500 RETURN p.uniq AS x') as number[];
    const narrow = col(g, 'MATCH (p:P) ORDER BY p.k LIMIT 10 RETURN p.uniq AS x') as number[];

    expect(narrow).toEqual(wide.slice(0, 10));

    // and the same across the gate with a SKIP, which is where an off-by-one would hide
    const wideSkip = col(
      g,
      'MATCH (p:P) ORDER BY p.k OFFSET 5 LIMIT 500 RETURN p.uniq AS x',
    ) as number[];
    const narrowSkip = col(
      g,
      'MATCH (p:P) ORDER BY p.k OFFSET 5 LIMIT 7 RETURN p.uniq AS x',
    ) as number[];

    expect(narrowSkip).toEqual(wideSkip.slice(0, 7));
  });

  test('a multi-key order, where the heap compares several keys per row', () => {
    const rows = col(
      g,
      'MATCH (p:P) ORDER BY p.s, p.k DESC LIMIT 6 RETURN p.uniq AS x',
    ) as number[];
    // s === 's0' at i % 7 === 0; within it the largest k first, arrival ascending.
    const expected = Array.from({ length: N }, (_, i) => i)
      .filter((i) => i % 7 === 0)
      .sort((a, b) => (b % 5) - (a % 5) || a - b)
      .slice(0, 6);

    expect(rows).toEqual(expected);
  });

  test('a NULL key stays last under both directions', () => {
    const h = new Graph();

    for (let i = 0; i < 2000; i += 1) {
      // present on three vertices only, so a 6-wide window must reach past them into NULLs
      h.addVertex({
        id: `w${i}`,
        labels: ['Q'],
        properties: i % 777 === 0 ? { d: `r${i}`, uniq: i } : { uniq: i },
      });
    }

    // STRING order, so 'r1554' < 'r777' — the digits compare as characters. Written out
    // because the numeric reading is the one that looks right and is wrong.
    expect(col(h, 'MATCH (q:Q) ORDER BY q.d LIMIT 5 RETURN q.d AS x')).toEqual([
      'r0',
      'r1554',
      'r777',
      null,
      null,
    ]);
    expect(col(h, 'MATCH (q:Q) ORDER BY q.d DESC LIMIT 4 RETURN q.d AS x')).toEqual([
      'r777',
      'r1554',
      'r0',
      null,
    ]);
  });
});
