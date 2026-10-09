// Item 270. A uniform same-key `=`-OR-chain is lowered to the hashed membership test.
// The rewrite is only sound because the equivalence is exact in THREE-VALUED logic and
// because every operand of this restricted shape is non-raising — so these tests are the
// inputs that distinguish "rewritten correctly" from "rewritten at all", plus the chains
// that must NOT be rewritten and whose ANSWER would change if they were.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = (): Graph => {
  const graph = new Graph();
  graph.addVertex({ labels: ['P'], properties: { n: 'a', k: 1, j: 10 } });
  graph.addVertex({ labels: ['P'], properties: { n: 'b', k: 2, j: 20 } });
  graph.addVertex({ labels: ['P'], properties: { n: 'c', k: 3, j: 1 } });

  return graph;
};

const names = (q: string, params?: Record<string, unknown>): string[] =>
  (query(g(), q, params) as { n: string }[]).map((r) => r.n).sort();

describe('a uniform same-key =-chain answers what the chain answered', () => {
  test('the plain case agrees with the IN spelling of the same question', () => {
    expect(names('MATCH (p:P) WHERE p.k = 1 OR p.k = 3 RETURN p.n AS n')).toEqual(['a', 'c']);
    expect(names('MATCH (p:P) WHERE p.k IN [1, 3] RETURN p.n AS n')).toEqual(['a', 'c']);
  });

  test('a two-term chain is rewritten and still correct', () => {
    expect(names('MATCH (p:P) WHERE p.k = 2 OR p.k = 2 RETURN p.n AS n')).toEqual(['b']);
  });

  // `asPropCompare` normalizes `const = prop` via FLIP, and FLIP['='] is '=', so a
  // mixed-direction chain is still uniform. If the flip were dropped, the chain would
  // decline and stay linear — same answer, so only the perf would change; asserted
  // here so the spelling is at least covered.
  test('a mixed-direction chain is uniform', () => {
    expect(names('MATCH (p:P) WHERE 1 = p.k OR p.k = 3 RETURN p.n AS n')).toEqual(['a', 'c']);
  });

  // A NULL NEEDLE makes every `=` UNKNOWN, and `OR` of UNKNOWNs is UNKNOWN — which is
  // also `IN`'s null-needle answer. Both produce zero rows, so `NOT` is what makes the
  // distinction visible: NOT UNKNOWN drops the row, NOT FALSE would keep it.
  test('a NULL needle is UNKNOWN, not FALSE', () => {
    expect(names('MATCH (p:P) WHERE p.missing = 1 OR p.missing = 2 RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT (p.missing = 1 OR p.missing = 2) RETURN p.n AS n')).toEqual(
      [],
    );
  });

  // A NULL ELEMENT makes a non-match UNKNOWN (`UNKNOWN OR FALSE`) and leaves a match
  // TRUE (`UNKNOWN OR TRUE`) — exactly what the membership test's `hasNull` encodes.
  test('a NULL term leaves a match TRUE and makes a miss UNKNOWN', () => {
    expect(names('MATCH (p:P) WHERE p.k = null OR p.k = 3 RETURN p.n AS n')).toEqual(['c']);
    expect(names('MATCH (p:P) WHERE NOT (p.k = null OR p.k = 3) RETURN p.n AS n')).toEqual([]);
  });

  test('an all-NULL chain is UNKNOWN for every row', () => {
    expect(names('MATCH (p:P) WHERE p.k = null OR p.k = null RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT (p.k = null OR p.k = null) RETURN p.n AS n')).toEqual([]);
  });

  test('a chain of PARAMS is re-read on each execution', () => {
    const graph = g();
    const q = 'MATCH (p:P) WHERE p.k = $a OR p.k = $b RETURN p.n AS n';

    const first = (query(graph, q, { a: 1, b: 2 }) as { n: string }[]).map((r) => r.n).sort();
    const second = (query(graph, q, { a: 3, b: 3 }) as { n: string }[]).map((r) => r.n);

    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['c']);
  });

  test('the chain still works nested under AND and NOT', () => {
    expect(names('MATCH (p:P) WHERE (p.k = 1 OR p.k = 3) AND p.j = 1 RETURN p.n AS n')).toEqual([
      'c',
    ]);
    expect(names('MATCH (p:P) WHERE NOT (p.k = 1 OR p.k = 3) RETURN p.n AS n')).toEqual(['b']);
  });
});

describe('chains that must NOT be collapsed — their ANSWER would change', () => {
  // A MIXED-KEY chain. Collapsing it to a membership test on the first key would ask a
  // different question entirely: `p.k IN [1, 20]` matches only `a`, where the real
  // chain `p.k = 1 OR p.j = 20` matches `a` AND `b`.
  test('a mixed-KEY chain', () => {
    expect(names('MATCH (p:P) WHERE p.k = 1 OR p.j = 20 RETURN p.n AS n')).toEqual(['a', 'b']);
  });

  test('a mixed-VARIABLE chain across two patterns', () => {
    const rows = query(g(), 'MATCH (p:P), (q:P) WHERE p.k = 1 OR q.k = 1 RETURN count(*) AS c') as {
      c: number;
    }[];

    // 3x3 pairs; those with p.k=1 (3) plus those with q.k=1 (3) minus the overlap (1).
    expect(rows[0]?.c).toBe(5);
  });

  // A chain on the same key with a NON-`=` operator is not a membership test at all.
  // `p.k <> 1 OR p.k <> 2` is TRUE for every row (no row equals both), where
  // `p.k IN [1, 2]` would match only two.
  test('a same-key chain with <> is not membership', () => {
    expect(names('MATCH (p:P) WHERE p.k <> 1 OR p.k <> 2 RETURN p.n AS n')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('a same-key chain of inequalities is not membership', () => {
    expect(names('MATCH (p:P) WHERE p.k < 2 OR p.k > 2 RETURN p.n AS n')).toEqual(['a', 'c']);
  });

  // The value side must be CLOSED. `p.k = p.j` reads another property, so the chain
  // declines — and collapsing it would compare against the literal expression rather
  // than the per-row value.
  test('a chain whose value side is another property', () => {
    expect(names('MATCH (p:P) WHERE p.k = p.j OR p.k = 2 RETURN p.n AS n')).toEqual(['b']);
  });

  // XOR shares the `case` arm with OR and must not be rewritten: `k = 1 XOR k = 3` is
  // TRUE for exactly one side holding, and for a membership test it would be TRUE for
  // either — the two agree here, but a row matching BOTH terms would differ, which is
  // why the guard is on `expr.kind` rather than on the chain shape.
  test('XOR is not treated as a membership test', () => {
    expect(names('MATCH (p:P) WHERE p.k = 1 XOR p.k = 3 RETURN p.n AS n')).toEqual(['a', 'c']);
    // Both terms hold for no row here, so construct the distinguishing case directly:
    // `k = 2 XOR k = 2` is FALSE for b (TRUE xor TRUE), where membership would be TRUE.
    expect(names('MATCH (p:P) WHERE p.k = 2 XOR p.k = 2 RETURN p.n AS n')).toEqual([]);
  });
});
