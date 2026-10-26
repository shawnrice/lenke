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

/**
 * Item 888's change is a ROUTE choice: all three keyword-lookup branches return the same answer,
 * so every correctness test above passes whichever branch runs, and a mutant that forces one
 * branch for everything SURVIVES them. That is the shape the repo's own rule warns about — a perf
 * route needs its own assertion, not a differential one.
 *
 * The route has one observable consequence, which is the whole point of it: how many times
 * `toLowerCase` runs. Counting it is a real assertion with teeth and costs production nothing.
 */
describe('keyword lookup avoids normalizing (route assertion)', () => {
  const countLowerCalls = (src: string): number => {
    // The original FUNCTION VALUE has to be captured eagerly. Wrapping it in an arrow that
    // dereferences `String.prototype.toLowerCase` at call time instead reads back the STUB
    // installed below and recurses forever — which it duly did.
    // eslint-disable-next-line typescript/unbound-method -- invoked via .call with an explicit receiver
    const original = String.prototype.toLowerCase;
    let calls = 0;

    // eslint-disable-next-line no-extend-native, func-names -- restored in the finally below
    String.prototype.toLowerCase = function (this: string): string {
      calls += 1;

      return original.call(this);
    };

    try {
      tokenize(src);
    } finally {
      // eslint-disable-next-line no-extend-native -- restoring what the line above replaced
      String.prototype.toLowerCase = original;
    }

    return calls;
  };

  it('normalizes NOTHING for an all-lowercase statement', () => {
    expect(countLowerCalls('match (a) where a.b = 1 return a')).toBe(0);
  });

  it('normalizes NOTHING for conventional UPPERCASE keywords', () => {
    expect(countLowerCalls('MATCH (a) WHERE a.b = 1 RETURN a')).toBe(0);
  });

  it('normalizes ONLY the mixed-case words', () => {
    // One mixed-case keyword and one mixed-case identifier: two words that cannot be resolved
    // without normalizing, and nothing else in the statement should pay.
    expect(countLowerCalls('MaTcH (a) RETURN a.userName')).toBe(2);
  });

  it('counts the baseline it is measuring against', () => {
    // Sanity on the counter itself: if the stub were not installed this would be 0 and every
    // assertion above would pass vacuously.
    expect(countLowerCalls('MaTcH')).toBeGreaterThan(0);
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

  // Item 888 resolves keywords down THREE distinct branches, picked by whether the identifier
  // contains an uppercase letter: all-lowercase goes to one set lookup, all-uppercase to a map
  // lookup, and only mixed case normalizes. Each branch needs a keyword AND a non-keyword, since
  // getting either verdict wrong in one branch is invisible from the others.
  it('resolves an all-LOWERCASE keyword and a lowercase identifier', () => {
    expect(tokenize('match')[0].type).toBe('keyword');
    expect(tokenize('match')[0].value).toBe('match');
    expect(tokenize('notakeyword')[0].type).toBe('ident');
  });

  it('resolves an all-UPPERCASE keyword and an uppercase identifier', () => {
    expect(tokenize('MATCH')[0].type).toBe('keyword');
    // The keyword's value is the canonical lowercase; its raw spelling is kept separately.
    expect(tokenize('MATCH')[0].value).toBe('match');
    expect(tokenize('MATCH')[0].raw).toBe('MATCH');
    expect(tokenize('NOTAKEYWORD')[0].type).toBe('ident');
    // An identifier keeps its ORIGINAL spelling as its value.
    expect(tokenize('NOTAKEYWORD')[0].value).toBe('NOTAKEYWORD');
  });

  it('resolves a MIXED-case keyword and a mixed-case identifier', () => {
    expect(tokenize('MaTcH')[0].type).toBe('keyword');
    expect(tokenize('MaTcH')[0].value).toBe('match');
    expect(tokenize('MaTcH')[0].raw).toBe('MaTcH');
    expect(tokenize('userName')[0].type).toBe('ident');
    expect(tokenize('userName')[0].value).toBe('userName');
  });

  it('classifies single-character and underscore identifiers correctly', () => {
    // A one-character uppercase identifier takes the uppercase branch on a text of length 1,
    // and `_` alone takes the lowercase branch because `_` has the case bit SET.
    expect(tokenize('A')[0].type).toBe('ident');
    expect(tokenize('A')[0].value).toBe('A');
    expect(tokenize('_')[0].type).toBe('ident');
    expect(tokenize('_')[0].value).toBe('_');
  });

  it('does not let a digit or underscore make a keyword look mixed-case', () => {
    // `MATCH_1` has the case bit clear (uppercase letters present) but is not a keyword in any
    // casing, so it must come back as an identifier rather than matching `match`.
    expect(tokenize('MATCH_1')[0].type).toBe('ident');
    expect(tokenize('match_1')[0].type).toBe('ident');
  });

  it('still recognizes a keyword regardless of case', () => {
    const types = tokenize('MATCH match MaTcH').map((t) => t.type);

    expect(types).toEqual(['keyword', 'keyword', 'keyword', 'eof']);
  });
});
