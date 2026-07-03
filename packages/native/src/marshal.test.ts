// The marshalling guards are the contract checks at the FFI border crossing —
// they don't need a built artifact, just the agreed shapes. These tests pin the
// "verify, then fail loudly with a coded error" behavior both backends rely on.
import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode, isLenkeError } from '@lenke/errors';

import { asByteLength, parseErrorReport } from './marshal.js';

describe('asByteLength', () => {
  test('passes through a plausible length (number or bigint)', () => {
    expect(asByteLength(0, 'op')).toBe(0);
    expect(asByteLength(1024, 'op')).toBe(1024);
    expect(asByteLength(42n, 'op')).toBe(42);
  });

  test('rejects a u64 length past the safe-integer range as a coded Ffi fault', () => {
    // 2^53 + 1: a real usize the crate could write, but Number() can no longer
    // represent it exactly — reading that range would be silent corruption.
    const huge = 2n ** 53n + 1n;
    expect(() => asByteLength(huge, 'query')).toThrow();

    try {
      asByteLength(huge, 'query');
    } catch (e) {
      expect(isLenkeError(e)).toBe(true);
      expect(hasErrorCode(e, ErrorCode.Ffi)).toBe(true);
    }
  });

  test('rejects a negative length', () => {
    expect(() => asByteLength(-1, 'op')).toThrow();
    expect(
      hasErrorCode(
        catchError(() => asByteLength(-1, 'op')),
        ErrorCode.Ffi,
      ),
    ).toBe(true);
  });
});

describe('parseErrorReport', () => {
  test('parses a well-formed report', () => {
    const report = parseErrorReport(
      '{"code":"E_SYNTAX","message":"bad query","details":{"pos":12}}',
    );
    expect(report).toEqual({ code: 'E_SYNTAX', message: 'bad query', details: { pos: 12 } });
  });

  test('accepts a report with null details', () => {
    const report = parseErrorReport('{"code":"E_FFI","message":"boom","details":null}');
    expect(report?.code).toBe('E_FFI');
    expect(report?.details).toBeNull();
  });

  test('returns null for non-JSON (so the caller uses its fallback code)', () => {
    expect(parseErrorReport('not json at all')).toBeNull();
    expect(parseErrorReport('')).toBeNull();
  });

  test('returns null when the agreed {code, message} strings are missing', () => {
    expect(parseErrorReport('{"message":"no code"}')).toBeNull();
    expect(parseErrorReport('{"code":"E_FFI"}')).toBeNull();
    expect(parseErrorReport('{"code":42,"message":"code is not a string"}')).toBeNull();
    expect(parseErrorReport('null')).toBeNull();
    expect(parseErrorReport('[]')).toBeNull();
  });
});

const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }

  return undefined;
};
