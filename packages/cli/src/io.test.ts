import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { detectFormat, FORMATS, formatFor, isFormat } from './io.js';

describe('format detection', () => {
  test('maps known extensions (case-insensitively)', () => {
    expect(detectFormat('g.ndjson')).toBe('ndjson');
    expect(detectFormat('g.jsonl')).toBe('ndjson');
    expect(detectFormat('g.csv')).toBe('csv');
    expect(detectFormat('g.graphson')).toBe('graphson');
    expect(detectFormat('/path/to/G.NDJSON')).toBe('ndjson');
  });

  test('leaves ambiguous / unknown extensions undetected', () => {
    expect(detectFormat('g.json')).toBeUndefined(); // pg-json vs graphson
    expect(detectFormat('graph')).toBeUndefined();
  });

  test('formatFor honors an explicit override and validates it', () => {
    expect(formatFor('g.json', 'pg-json')).toBe('pg-json');
    expect(() => formatFor('g.json')).toThrow(/infer a format/);
    expect(() => formatFor('g.ndjson', 'bogus')).toThrow(/Unknown format/);
  });

  /*
   * Item 2519: both format failures must carry `ErrorCode.UnknownFormat`.
   *
   * `@lenke/errors` states that "the CODE is the contract, not the message", and `@lenke/serialization`
   * already raises this code for the same mistake — but this module PRE-VALIDATES the format against
   * its own `FORMATS` list, so the library's coded error was never reached and a consumer of
   * `formatFor` got `error.code === undefined` for a condition the registry has a dedicated code for.
   *
   * The `toThrow(/Unknown format/)` assertions above kept passing throughout that fix, which is
   * exactly why they are the weaker form: a message assertion cannot see the code change at all.
   */
  test('both format failures carry ErrorCode.UnknownFormat, not just a message', () => {
    const bad = (() => {
      try {
        formatFor('g.ndjson', 'bogus');

        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(hasErrorCode(bad, ErrorCode.UnknownFormat)).toBe(true);

    const undetectable = (() => {
      try {
        formatFor('g.json');

        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(hasErrorCode(undetectable, ErrorCode.UnknownFormat)).toBe(true);
  });

  test('a VALID format still returns rather than throwing — the productive control', () => {
    expect(formatFor('g.json', 'pg-json')).toBe('pg-json');
    expect(formatFor('g.ndjson')).toBe('ndjson');
  });

  test('isFormat / FORMATS', () => {
    expect(isFormat('csv')).toBe(true);
    expect(isFormat('xml')).toBe(false);
    expect(FORMATS).toContain('graphson');
  });
});
