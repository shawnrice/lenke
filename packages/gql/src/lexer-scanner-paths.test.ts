/**
 * Item 886: the two scanners that changed shape still read the same values.
 *
 * - The STRING LITERAL scanner now takes the span to the first backslash-or-quote in ONE slice
 *   and only falls into the per-character append from the first escape onwards. Everything
 *   interesting is at that handover: a literal with no escape at all, one that starts with an
 *   escape, one that ends with an escape, several escapes, and the unterminated cases which must
 *   still throw rather than silently return a short value.
 * - The IDENTIFIER and PARAMETER scanners now advance on `charCodeAt` instead of a one-character
 *   string. The boundary characters are what a code-range test gets wrong: `_` sits between `Z`
 *   and `a` in ASCII, and a digit must continue an identifier but not start one.
 */
import { describe, expect, it } from 'bun:test';

import { tokenize } from './lexer.ts';

const valuesOf = (src: string): unknown[] =>
  tokenize(src)
    .slice(0, -1)
    .map((t) => t.value);

describe('string literal scanner', () => {
  it('reads a literal with no escape in it', () => {
    expect(valuesOf("'plain text here'")).toEqual(['plain text here']);
  });

  it('reads an empty literal', () => {
    expect(valuesOf("''")).toEqual(['']);
  });

  it('reads a literal that is ONLY an escape', () => {
    // The fast span is empty and the per-character path does all the work.
    expect(valuesOf("'\\n'")).toEqual(['\n']);
  });

  it('reads an escape at the START, with text after it', () => {
    expect(valuesOf("'\\tindented'")).toEqual(['\tindented']);
  });

  it('reads an escape at the END, with text before it', () => {
    // The handover case: the fast slice takes `done` and the escape loop takes the rest.
    expect(valuesOf("'done\\n'")).toEqual(['done\n']);
  });

  it('reads several escapes with text between them', () => {
    expect(valuesOf("'a\\nb\\tc\\\\d'")).toEqual(['a\nb\tc\\d']);
  });

  it('keeps the other quote character as ordinary text', () => {
    expect(valuesOf('\'he said "hi"\'')).toEqual(['he said "hi"']);
    expect(valuesOf('"it\'s here"')).toEqual(["it's here"]);
  });

  it('throws on an unterminated literal with no escape', () => {
    expect(() => tokenize("'abc")).toThrow();
  });

  it('throws on an unterminated literal that contains an escape', () => {
    expect(() => tokenize("'a\\nbc")).toThrow();
  });

  it('throws on a literal ending in a lone backslash at EOF', () => {
    expect(() => tokenize("'a\\")).toThrow();
  });
});

describe('identifier and parameter scanners', () => {
  it('takes a digit as a CONTINUING identifier character', () => {
    expect(valuesOf('a1 b22 c3d')).toEqual(['a1', 'b22', 'c3d']);
  });

  it('takes an underscore anywhere in an identifier', () => {
    // `_` is code 95, between `Z` (90) and `a` (97) — the gap a range test drops.
    expect(valuesOf('_lead mid_dle trail_')).toEqual(['_lead', 'mid_dle', 'trail_']);
  });

  it('stops an identifier at the first non-identifier character', () => {
    expect(valuesOf('abc.def')).toEqual(['abc', '.', 'def']);
    expect(valuesOf('abc-def')).toEqual(['abc', '-', 'def']);
  });

  it('does NOT let a digit start an identifier', () => {
    const types = tokenize('1abc').map((t) => t.type);

    expect(types[0]).toBe('number');
  });

  it('reads a parameter name with digits and underscores', () => {
    expect(valuesOf('$a_1 $b2')).toEqual(['a_1', 'b2']);
  });

  it('stops a parameter name at a non-identifier character', () => {
    expect(valuesOf('$x.y')).toEqual(['x', '.', 'y']);
  });

  it('throws when a parameter has no name', () => {
    expect(() => tokenize('$ x')).toThrow();
    expect(() => tokenize('$')).toThrow();
  });

  it('still recognizes a keyword regardless of case', () => {
    const types = tokenize('MATCH match MaTcH').map((t) => t.type);

    expect(types).toEqual(['keyword', 'keyword', 'keyword', 'eof']);
  });
});
