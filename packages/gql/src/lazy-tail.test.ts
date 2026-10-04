import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `hoistedMatch` and the multi-pattern tail both used to COLLECT an uncorrelated tail before
// yielding any of it, so a leading `MATCH … LIMIT 1` did a whole min(bucket, 4096) match pass to
// produce one row. Both now stream the tail while recording it (audit item 150).
//
// The visible consequence — and the reason this is a correctness file and not just a perf note —
// is WHICH candidates get evaluated. An eager pass evaluates the clause on candidates a LIMIT
// never needs, so a predicate that faults on one of them raised in TS and not in the engine.
//
// Items 144/145 are the trap this file is arranged around: a fault both engines must evaluate
// reads as agreement and proves nothing. So every fault below sits on a candidate that comes
// AFTER the one satisfying the limit.
const TAIL_CACHE_CAP = 4096;

/** u0 casts cleanly and matches; u1 would FAULT on the cast; u2 matches again. */
const faultGraph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'u0', labels: ['User'], properties: { name: 'a', st: '1' } });
  g.addVertex({ id: 'u1', labels: ['User'], properties: { name: 'b', st: 'zzz' } });
  g.addVertex({ id: 'u2', labels: ['User'], properties: { name: 'c', st: '3' } });

  return g;
};

describe('a limited MATCH stops before a later candidate faults', () => {
  test('LIMIT 1 does not evaluate the predicate on candidate two', () => {
    // The engine streams and stops at u0, so it returns a row. TS used to fill the tail cache
    // first, evaluate the cast on u1, and raise — a live cross-engine divergence.
    expect(
      query(faultGraph(), 'MATCH (u:User) WHERE CAST(u.st AS INTEGER) >= 1 RETURN u.name LIMIT 1'),
    ).toEqual([{ 'u.name': 'a' }]);
  });

  test('LIMIT 2 DOES reach it, and still raises', () => {
    // The other direction, which is what item 145 corrected: the fix must not skip an
    // evaluation the general path does make. Satisfying LIMIT 2 requires a second match, so u1
    // is evaluated and the fault stands.
    expect(() =>
      query(faultGraph(), 'MATCH (u:User) WHERE CAST(u.st AS INTEGER) >= 1 RETURN u.name LIMIT 2'),
    ).toThrow();
  });

  test('no limit evaluates every candidate and raises', () => {
    expect(() =>
      query(faultGraph(), 'MATCH (u:User) WHERE CAST(u.st AS INTEGER) >= 1 RETURN u.name'),
    ).toThrow();
  });
});

// A `count(*)` over independent patterns does NOT reach this code: item 135's
// product-of-counts shortcut answers it from the two bucket sizes and never matches anything.
// Proven by mutation — truncating the cache at the cap leaves every `count(*)` test here green
// and fails only the grouped one. So the tests with teeth for the cache are the ones that
// GROUP or project per outer row; the count assertions are shape checks, not coverage.
describe('the tail cache still produces the right product', () => {
  const product = (outer: number, tail: number): Graph => {
    const g = new Graph();

    for (let i = 0; i < outer; i++) {
      g.addVertex({ id: `o${i}`, labels: ['Outer'], properties: { k: i } });
    }

    for (let i = 0; i < tail; i++) {
      g.addVertex({ id: `t${i}`, labels: ['Tail'], properties: { n: i } });
    }

    return g;
  };

  test('two uncorrelated patterns give the full cross product', () => {
    const rows = query(product(3, 4), 'MATCH (a:Outer), (b:Tail) RETURN count(*) AS c');

    expect(rows).toEqual([{ c: 12 }]);
  });

  test('every outer row sees the whole tail, not just the first', () => {
    // A cache that was filled but then mis-indexed, or only applied to one outer row, still
    // gets the COUNT right while pairing the wrong rows — so this asserts the pairs.
    const rows = query(
      product(2, 2),
      'MATCH (a:Outer), (b:Tail) RETURN a.k AS k, b.n AS n ORDER BY k, n',
    );

    expect(rows).toEqual([
      { k: 0, n: 0 },
      { k: 0, n: 1 },
      { k: 1, n: 0 },
      { k: 1, n: 1 },
    ]);
  });

  test('a tail LARGER than the cap still pairs every outer row', () => {
    // Over the cap the recording is abandoned and later outer rows re-match instead. The first
    // outer row's output has already been yielded by then, so the risk this covers is it being
    // yielded twice, or the rest being dropped.
    const outer = 3;
    const tail = TAIL_CACHE_CAP + 10;
    const rows = query(product(outer, tail), 'MATCH (a:Outer), (b:Tail) RETURN count(*) AS c');

    expect(rows).toEqual([{ c: outer * tail }]);
  });

  test('a tail larger than the cap pairs each outer row with the SAME tail', () => {
    const outer = 3;
    const tail = TAIL_CACHE_CAP + 10;
    const rows = query(
      product(outer, tail),
      'MATCH (a:Outer), (b:Tail) RETURN a.k AS k, count(*) AS c ORDER BY k',
    );

    expect(rows).toEqual([
      { k: 0, c: tail },
      { k: 1, c: tail },
      { k: 2, c: tail },
    ]);
  });

  test('a tail EXACTLY at the cap pairs every outer row', () => {
    // The boundary the cap's comparison sits on: `seen.length === cap` fires on the element
    // AFTER the capth, so a tail of exactly cap rows is complete.
    //
    // This assertion CANNOT pin that boundary, and the comment says so rather than implying
    // coverage it does not have: mutating the comparison to `>= cap - 1` — so an exactly-cap
    // tail counts as overflow — leaves every test here green. It has to, because overflow is
    // still CORRECT: it re-matches the tail instead of reusing it, and only the cost differs.
    // The boundary is a cost lever with no answer to assert.
    const rows = query(
      product(2, TAIL_CACHE_CAP),
      'MATCH (a:Outer), (b:Tail) RETURN count(*) AS c',
    );

    expect(rows).toEqual([{ c: 2 * TAIL_CACHE_CAP }]);
  });

  test('a limited product stops early and still pairs correctly', () => {
    const rows = query(
      product(3, 1000),
      'MATCH (a:Outer), (b:Tail) RETURN a.k AS k, b.n AS n LIMIT 3',
    );

    // One outer row, the tail's first three — the limit is reached inside the first row.
    expect(rows).toEqual([
      { k: 0, n: 0 },
      { k: 0, n: 1 },
      { k: 0, n: 2 },
    ]);
  });
});

describe('binding identity and column order survive the streaming path', () => {
  test('RETURN * keeps outer-then-pattern key order', () => {
    // The streamed row is the matcher's own binding when the incoming one is empty, and a
    // merged copy otherwise. Column order is observable bytes, so the two must not differ.
    const g = new Graph();

    g.addVertex({ id: 'o0', labels: ['Outer'], properties: { k: 1 } });
    g.addVertex({ id: 't0', labels: ['Tail'], properties: { n: 2 } });

    const rows = query(g, 'MATCH (a:Outer), (b:Tail) RETURN *');

    expect(Object.keys(rows[0] as Record<string, unknown>)).toEqual(['a', 'b']);
  });

  test('a non-empty incoming binding is extended, not replaced', () => {
    // `FOR` puts a value in the binding before the MATCH runs, so the MATCH's rows must carry
    // it. This is the path that still copies — if the zero-copy branch were taken here, the
    // `x` column would be missing.
    const g = new Graph();

    g.addVertex({ id: 'u0', labels: ['User'], properties: { name: 'a' } });
    g.addVertex({ id: 'u1', labels: ['User'], properties: { name: 'b' } });

    const rows = query(
      g,
      'FOR x IN [7, 8] MATCH (u:User) RETURN x, u.name AS name ORDER BY x, name',
    );

    expect(rows).toEqual([
      { x: 7, name: 'a' },
      { x: 7, name: 'b' },
      { x: 8, name: 'a' },
      { x: 8, name: 'b' },
    ]);
  });

  test('a second outer row gets its own row object', () => {
    // The recorded cache entries are the same objects that were yielded for the first outer
    // row. Later rows read them through a copy, so a mutation of one row can never be visible
    // in another — asserted by distinct values rather than by identity.
    const g = new Graph();

    g.addVertex({ id: 'u0', labels: ['User'], properties: { name: 'a' } });

    const rows = query(g, 'FOR x IN [1, 2] MATCH (u:User) RETURN x, u.name AS name ORDER BY x');

    expect(rows).toEqual([
      { x: 1, name: 'a' },
      { x: 2, name: 'a' },
    ]);
  });
});
