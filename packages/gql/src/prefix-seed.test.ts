// `STARTS WITH` seeding a range index (item 1028).
//
// The predicate parses to a `func`, so no compare arm could see it and it reached no index:
// measured at 5.0 ms against 0.10 for the explicit `>= p AND < succ(p)` spelling it is equivalent
// to, over 100,000 rows. Two spellings of one question — the class every index-seeding bug in this
// engine has belonged to, and the one the equivalent-spellings note lists first.
//
// THE ORACLE IS THE UNINDEXED GRAPH. Each case runs the same query over an indexed and an
// unindexed copy of one fixture and requires identical rows, so the tests state the claim that
// matters — seeding changes no answer — rather than restating `prefixUpper`'s arithmetic.
//
// The bound is the part most likely to be wrong, and the cases are built for its failure modes: a
// UTF-16 slice instead of a code-point one (which splits a surrogate pair and yields a lone
// surrogate), an empty prefix, and a prefix at the top of the code-point range.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { prefixUpper } from './executor.js';
import { query } from './index.js';

const VALUES = [
  'name0',
  'name1',
  'name500',
  'name5000',
  'name5001',
  'name501',
  'name9',
  // Multi-byte, and a boundary pair: `é` next to `ê` is what a correct successor bound separates.
  'é',
  'éa',
  'êa',
  '日',
  '日本',
  '日本語',
  // SURROGATE PAIRS. `'😀'.length` is 2 in UTF-16, so slicing by `length - 1` splits the pair and
  // produces a lone surrogate — a bound that is not a valid scalar value. `Array.from` iterates
  // code points, which is what makes these cases pass.
  '😀',
  '😀a',
  '😁a',
  // The top of the code-point range: nothing sorts above it, so a prefix ending here has no
  // upper bound and must decline to a filter.
  `z${String.fromCodePoint(0x10_ff_ff)}`,
  `z${String.fromCodePoint(0x10_ff_ff)}a`,
];

const build = (indexed: boolean): Graph => {
  const g = new Graph();

  VALUES.forEach((name, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { name } });
  });

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'range', keys: ['name'] });
  }

  return g;
};

const indexed = build(true);
const plain = build(false);

const names = (g: Graph, q: string): string[] =>
  (query(g, q) as Record<string, unknown>[]).map((r) => String(r.v)).sort();

describe('prefixUpper, tested directly because width errors are answer-equivalent', () => {
  // The residual WHERE re-applies `starts_with`, so a bound that is too WIDE changes no answer —
  // a UTF-16 slice and an inclusive bound both passed every end-to-end case in this file. These
  // assertions are the teeth for that arithmetic.
  test('the successor is the next CODE POINT, keeping surrogate pairs whole', () => {
    expect(prefixUpper('a')).toBe('b');
    expect(prefixUpper('name500')).toBe('name501');
    // The last character rolls over while the rest is untouched — `az` -> `a{`, not `b`.
    expect(prefixUpper('az')).toBe('a{');
    expect(prefixUpper('é')).toBe('ê');
    // The successor of `日本` is `日` + the code point after `本`, which is what keeps `日本語`
    // inside the interval while `日` itself is below it.
    expect(prefixUpper('日本')).toBe(`日${String.fromCodePoint(('本'.codePointAt(0) ?? 0) + 1)}`);
    // A SURROGATE PAIR must advance as one code point: `😀` (U+1F600) -> `😁` (U+1F601). A
    // UTF-16 slice would take the low surrogate and produce a lone one instead.
    expect(prefixUpper('😀')).toBe('😁');
    expect(prefixUpper('a😀')).toBe('a😁');

    // ...and the result must be a valid string of code points, never a lone surrogate.
    for (const p of ['😀', 'a😀', '😀b']) {
      const up = prefixUpper(p);

      expect(up, p).toBeDefined();
      expect(Array.from(up as string).length, p).toBe(Array.from(p).length);
    }
  });

  test('no successor exists for an empty prefix or the top of the range', () => {
    expect(prefixUpper('')).toBeUndefined();
    expect(prefixUpper(String.fromCodePoint(0x10_ff_ff))).toBeUndefined();
    // A max code point NOT in last position still has a successor — only the LAST one matters.
    expect(prefixUpper(`${String.fromCodePoint(0x10_ff_ff)}a`)).toBe(
      `${String.fromCodePoint(0x10_ff_ff)}b`,
    );
  });
});

describe('STARTS WITH seeds a range index (item 1028)', () => {
  test('the indexed answer matches the unindexed one, for every prefix shape', () => {
    for (const p of [
      'name500',
      'name5',
      'name',
      'é',
      'ê',
      '日本',
      '😀',
      // No match at all.
      'zzz',
      // The EMPTY prefix matches every row: no upper bound exists, so this must not seed.
      '',
      // At the top of the range: no successor, so this must not seed either.
      `z${String.fromCodePoint(0x10_ff_ff)}`,
    ]) {
      const q = `MATCH (n:P) WHERE n.name STARTS WITH '${p}' RETURN n.name AS v`;

      expect(names(indexed, q), `prefix ${JSON.stringify(p)}`).toEqual(names(plain, q));
    }
  });

  test('a surrogate-pair prefix keeps the pair intact', () => {
    // `😀` and `😁` are adjacent code points, so the successor of `😀` is `😁` — and a UTF-16
    // slice would instead produce a bound built from half of `😀`, which orders nowhere near it.
    // The assertion is the exact row set, so a bound that merely happens to be wide enough does
    // not pass by accident.
    const q = "MATCH (n:P) WHERE n.name STARTS WITH '😀' RETURN n.name AS v";

    expect(names(indexed, q)).toEqual(['😀', '😀a']);
    expect(names(indexed, q)).toEqual(names(plain, q));
  });

  test('a multi-byte prefix does not leak its neighbour', () => {
    const q = "MATCH (n:P) WHERE n.name STARTS WITH 'é' RETURN n.name AS v";

    // `êa` sorts immediately after the `é` run and is what a successor bound off by one admits.
    expect(names(indexed, q)).toEqual(['é', 'éa']);
    expect(names(indexed, q)).toEqual(names(plain, q));
  });

  test('a prefix is not a longer prefix', () => {
    const q = "MATCH (n:P) WHERE n.name STARTS WITH '日本' RETURN n.name AS v";

    expect(names(indexed, q)).toEqual(['日本', '日本語']);
    expect(names(indexed, q)).toEqual(names(plain, q));
  });

  test('the empty prefix returns every row', () => {
    const q = "MATCH (n:P) WHERE n.name STARTS WITH '' RETURN n.name AS v";

    expect(names(indexed, q)).toEqual([...VALUES].sort());
    expect(names(indexed, q)).toEqual(names(plain, q));
  });
});
