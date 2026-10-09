// Item 268. `IN` over a closed/param haystack is hashed once instead of scanned
// per row. Hashing changes the MACHINERY of a three-valued predicate, so these
// tests are the inputs that distinguish the hashed answer from `inList`'s — not a
// sample of `IN` working, which the existing suite already covers and which stayed
// green through a version of this change that got the empty list wrong.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const g = (): Graph => {
  const graph = new Graph();
  graph.addVertex({ labels: ['P'], properties: { n: 'a', k: 1 } });
  graph.addVertex({ labels: ['P'], properties: { n: 'b', k: 2 } });
  graph.addVertex({ labels: ['P'], properties: { n: 'c', k: 3 } });

  return graph;
};

const names = (q: string, params?: Record<string, unknown>): string[] =>
  (query(g(), q, params) as { n: string }[]).map((r) => r.n).sort();

describe('a hashed haystack answers exactly what a linear scan answered', () => {
  test('the plain case, inline and param, agree with each other', () => {
    expect(names('MATCH (p:P) WHERE p.k IN [1, 3] RETURN p.n AS n')).toEqual(['a', 'c']);
    expect(names('MATCH (p:P) WHERE p.k IN $ids RETURN p.n AS n', { ids: [1, 3] })).toEqual([
      'a',
      'c',
    ]);
  });

  // THE EMPTY LIST IS THE TRAP. `inList` only reaches its `sawUnknown` branch
  // INSIDE the element loop, so an empty haystack never sets it and `null IN []`
  // is FALSE, not UNKNOWN. A hashed form that checks the needle for null before
  // checking the set's size turns that into UNKNOWN — and because both answers
  // produce ZERO ROWS for the positive spelling, only `NOT IN` can tell them
  // apart: NOT FALSE keeps the row, NOT UNKNOWN drops it.
  test('a NULL needle against an EMPTY list is FALSE, not UNKNOWN', () => {
    expect(names('MATCH (p:P) WHERE p.missing IN [] RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT p.missing IN [] RETURN p.n AS n')).toEqual(['a', 'b', 'c']);
  });

  test('an empty PARAM list behaves the same as an empty inline one', () => {
    expect(names('MATCH (p:P) WHERE NOT p.missing IN $ids RETURN p.n AS n', { ids: [] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  // A NULL element makes a NON-match UNKNOWN but leaves a match TRUE, so the
  // hashed form has to carry `hasNull` separately from the set rather than
  // dropping nulls silently. `NOT IN` is again what makes the distinction visible.
  test('a NULL element makes a miss UNKNOWN while a hit stays TRUE', () => {
    expect(names('MATCH (p:P) WHERE p.k IN [null, 3] RETURN p.n AS n')).toEqual(['c']);
    // a and b miss against a haystack containing null → UNKNOWN → NOT drops them
    // too; only c is excluded by a definite TRUE. So NOT yields nothing at all.
    expect(names('MATCH (p:P) WHERE NOT p.k IN [null, 3] RETURN p.n AS n')).toEqual([]);
  });

  test('an ALL-NULL list is UNKNOWN for every row, in both spellings', () => {
    expect(names('MATCH (p:P) WHERE p.k IN [null, null] RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT p.k IN [null, null] RETURN p.n AS n')).toEqual([]);
    expect(
      names('MATCH (p:P) WHERE NOT p.k IN $ids RETURN p.n AS n', { ids: [null, null] }),
    ).toEqual([]);
  });

  test('a NULL needle against a non-empty list is UNKNOWN', () => {
    expect(names('MATCH (p:P) WHERE p.missing IN [1, 2] RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT p.missing IN [1, 2] RETURN p.n AS n')).toEqual([]);
  });
});

describe('what must NOT be hashed', () => {
  // A `Set` finds NaN (SameValueZero) where `structuralEq` bottoms out at `===`
  // and does not. Hashing a NaN element would make `NaN IN [NaN]` true and break
  // the "predicates keep NaN JS-unordered" policy, so NaN is excluded from the
  // whitelist and such a haystack keeps the linear scan.
  test('a NaN element does not become findable', () => {
    const graph = new Graph();
    graph.addVertex({ labels: ['P'], properties: { n: 'x', k: 1 } });

    const rows = query(graph, 'MATCH (p:P) WHERE $nan IN $ids RETURN p.n AS n', {
      nan: Number.NaN,
      ids: [Number.NaN],
    });

    expect(rows).toEqual([]);
  });

  // LIST and RECORD elements compare by DEEP structural equality, which a set
  // keyed on identity cannot reproduce — two equal-but-distinct arrays are one
  // value to `structuralEq` and two to a `Set`. So a non-primitive element must
  // drop the whole haystack back to the linear scan.
  // The array written in the query is a DISTINCT instance from the stored one, so
  // identity would miss it and only deep equality finds it. Inline only: a nested
  // array is not a valid PARAM value (`validateParamValue` rejects it), so a list
  // element can reach `IN` by no other route — which is why the memo path's
  // non-hashable fallback is only ever reached for NaN or a per-row haystack.
  test('a LIST element still matches by deep equality, not identity', () => {
    const graph = new Graph();
    graph.addVertex({ labels: ['P'], properties: { n: 'x', tags: ['a', 'b'] } });

    const inline = query(graph, "MATCH (p:P) WHERE p.tags IN [['a', 'b']] RETURN p.n AS n");
    expect(inline).toEqual([{ n: 'x' }]);
  });

  test('a mixed list keeps working: a non-hashable element beside hashable ones', () => {
    expect(names("MATCH (p:P) WHERE p.k IN [['x'], 2] RETURN p.n AS n")).toEqual(['b']);
  });

  // An inline list is only CLOSED if every element is a literal. A `$param` element
  // is not, and folding one at compile time would read its value as `undefined` —
  // which `hashValues` would then record as a NULL element, turning row a's definite
  // TRUE into UNKNOWN and dropping it. The `['x']` case above cannot catch that
  // (it happens to give the same answer either way), so this is the test that does.
  test('a PARAM element inside an inline list is not folded', () => {
    expect(names('MATCH (p:P) WHERE p.k IN [$one, 3] RETURN p.n AS n', { one: 1 })).toEqual([
      'a',
      'c',
    ]);
  });

  test('a PROPERTY element inside an inline list is not folded', () => {
    expect(names('MATCH (p:P) WHERE p.k IN [p.k] RETURN p.n AS n')).toEqual(['a', 'b', 'c']);
  });

  // The haystack is a PROPERTY here, so it genuinely varies per row and the memo
  // must miss every time rather than serving row 1's set to row 2.
  test('a per-row haystack is evaluated per row', () => {
    const graph = new Graph();
    graph.addVertex({ labels: ['P'], properties: { n: 'hit', k: 1, allow: [1, 9] } });
    graph.addVertex({ labels: ['P'], properties: { n: 'miss', k: 1, allow: [2, 9] } });

    const rows = query(graph, 'MATCH (p:P) WHERE p.k IN p.allow RETURN p.n AS n') as {
      n: string;
    }[];

    expect(rows.map((r) => r.n)).toEqual(['hit']);
  });

  test('a non-list haystack is UNKNOWN, as it was', () => {
    expect(names('MATCH (p:P) WHERE p.k IN 3 RETURN p.n AS n')).toEqual([]);
    expect(names('MATCH (p:P) WHERE NOT p.k IN 3 RETURN p.n AS n')).toEqual([]);
  });
});

describe('the memo cannot serve a stale set across executions', () => {
  // A compiled plan is cached and reused, so the closure holding the memo outlives
  // one run. Two executions of the SAME query text with DIFFERENT param lists must
  // not share a hashed haystack.
  test('the same query text with different param lists answers each correctly', () => {
    const graph = g();
    const q = 'MATCH (p:P) WHERE p.k IN $ids RETURN p.n AS n';

    const first = (query(graph, q, { ids: [1] }) as { n: string }[]).map((r) => r.n);
    const second = (query(graph, q, { ids: [2, 3] }) as { n: string }[]).map((r) => r.n).sort();
    const third = (query(graph, q, { ids: [1] }) as { n: string }[]).map((r) => r.n);

    expect(first).toEqual(['a']);
    expect(second).toEqual(['b', 'c']);
    expect(third).toEqual(['a']);
  });

  test('one reused params object holding a different list each run', () => {
    const graph = g();
    const q = 'MATCH (p:P) WHERE p.k IN $ids RETURN p.n AS n';
    const params: { ids: number[] } = { ids: [1] };

    const first = (query(graph, q, params) as { n: string }[]).map((r) => r.n);
    params.ids = [3];
    const second = (query(graph, q, params) as { n: string }[]).map((r) => r.n);

    expect(first).toEqual(['a']);
    expect(second).toEqual(['c']);
  });

  // The shape item 269 regressed: an INLINE list of PARAM references. `case 'list'`
  // rebuilds that array per row, so it is cached per EXECUTION rather than keyed on
  // the array's identity — and the cache must still see each run's own params.
  test('an inline list of PARAMS is re-read on each execution', () => {
    const graph = g();
    const q = 'MATCH (p:P) WHERE p.k IN [$a, $b] RETURN p.n AS n';

    const first = (query(graph, q, { a: 1, b: 2 }) as { n: string }[]).map((r) => r.n).sort();
    const second = (query(graph, q, { a: 3, b: 3 }) as { n: string }[]).map((r) => r.n);

    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['c']);
  });

  // THE CASE THE EPOCH KEY EXISTS FOR, and the only one that makes it observable:
  // the SAME array instance, mutated IN PLACE between runs. Array identity is
  // unchanged, so a memo keyed on identity alone hands run 2 the set it hashed for
  // run 1 — silently, with a plausible answer. Params reach the closure by
  // reference and the plan is cached across runs, so nothing else would catch it;
  // the linear scan this replaced re-read the array every row, and the Rust engine
  // re-marshals params on every call, so both honour the mutation.
  test('the SAME array mutated in place between runs is re-hashed', () => {
    const graph = g();
    const q = 'MATCH (p:P) WHERE p.k IN $ids RETURN p.n AS n';
    const ids: number[] = [1];

    const first = (query(graph, q, { ids }) as { n: string }[]).map((r) => r.n);

    // Same instance, different contents.
    ids[0] = 3;
    const second = (query(graph, q, { ids }) as { n: string }[]).map((r) => r.n);

    // And a length change on the same instance, which a length-only guard would
    // catch but an identity-only one would not.
    ids.push(2);
    const third = (query(graph, q, { ids }) as { n: string }[]).map((r) => r.n).sort();

    expect(first).toEqual(['a']);
    expect(second).toEqual(['c']);
    expect(third).toEqual(['b', 'c']);
  });
});
