/**
 * Item 885: every multi-character token spelling still tokenizes.
 *
 * The tokenizer only builds a lookahead string when the current character can BEGIN a
 * multi-character token — `startsMulti` decides that, and it is a hand-written list of six
 * characters. If a future table entry's first character is missing from that list, the lookahead
 * never happens, the two-character rule never fires, and the input is tokenized as two SINGLE
 * tokens instead. That is a silently wrong token stream, not an error: `a <> b` becomes
 * `a < > b`, which the parser may well accept as something else.
 *
 * So this enumerates every spelling the lookahead is responsible for — all eight `TWO_CHAR`
 * keys, the `<->` three-character form, and the three comment openers — and asserts the token
 * stream. Verified to have teeth by mutation: dropping any one character from `startsMulti`
 * fails between one and four of these cases.
 */
import { describe, expect, it } from 'bun:test';

import { tokenize } from './lexer.ts';

const typesOf = (src: string): string[] => tokenize(src).map((t) => t.type);

describe('multi-character token spellings', () => {
  // Every TWO_CHAR key. Each must come back as exactly ONE token of the named type, which is
  // what fails if the lookahead was skipped for its first character.
  const TWO: ReadonlyArray<readonly [string, string]> = [
    ['->', 'rarrow'],
    ['<-', 'larrow'],
    ['<~', 'ltilde'],
    ['~>', 'tilder'],
    ['<>', 'neq'],
    ['<=', 'lte'],
    ['>=', 'gte'],
    ['||', 'concat'],
  ];

  for (const [spelling, type] of TWO) {
    it(`tokenizes ${spelling} as one ${type}`, () => {
      const types = typesOf(spelling);

      expect(types).toEqual([type, 'eof']);
    });
  }

  it('tokenizes <-> as one undirected edge token', () => {
    // The three-character form, gated on `<` separately from the two-character table.
    const types = typesOf('<->');

    expect(types.length).toBe(2);
    expect(types[1]).toBe('eof');
    // Whatever the type is named, the point is that it is ONE token and not `lt`+`rarrow`.
    expect(types[0]).not.toBe('lt');
  });

  // The comment openers also depend on the lookahead: `/` and `-` must both start it, and a
  // missing one turns a comment into a `slash`/`dash` token followed by the comment body as
  // real tokens — the most damaging of these failures, because it silently parses prose.
  it('skips a // line comment', () => {
    expect(typesOf('1 // ignored RETURN\n2')).toEqual(['number', 'number', 'eof']);
  });

  it('skips a -- line comment', () => {
    expect(typesOf('1 -- ignored RETURN\n2')).toEqual(['number', 'number', 'eof']);
  });

  it('skips a /* block comment */', () => {
    expect(typesOf('1 /* ignored RETURN */ 2')).toEqual(['number', 'number', 'eof']);
  });

  // A guard on the gate's OTHER direction: a gated character that does NOT continue into a
  // multi-character token must still produce its single-character token.
  it('still tokenizes the gated characters alone', () => {
    expect(typesOf('<')).toEqual(['lt', 'eof']);
    expect(typesOf('>')).toEqual(['gt', 'eof']);
    expect(typesOf('-')).toEqual(['dash', 'eof']);
    expect(typesOf('/')).toEqual(['slash', 'eof']);
    expect(typesOf('~')).toEqual(['tilde', 'eof']);
    expect(typesOf('|')).toEqual(['pipe', 'eof']);
  });
});
