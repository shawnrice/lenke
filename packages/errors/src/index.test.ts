import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode, isLenkeError, LenkeError } from './index.js';

describe('LenkeError', () => {
  test('carries a stable code, message, cause, and details', () => {
    const cause = new Error('underlying');
    const err = new LenkeError('bad input', {
      code: ErrorCode.InvalidJson,
      cause,
      details: { format: 'pg-json' },
    });
    expect(err.code).toBe(ErrorCode.InvalidJson);
    expect(err.message).toBe('bad input');
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ format: 'pg-json' });
    expect(err).toBeInstanceOf(Error);
  });

  test('isLenkeError narrows correctly', () => {
    expect(isLenkeError(new LenkeError('x', { code: ErrorCode.Syntax }))).toBe(true);
    expect(isLenkeError(new Error('x'))).toBe(false);
    expect(isLenkeError(null)).toBe(false);
  });

  test('hasErrorCode matches on the code, not the message', () => {
    const err = new LenkeError('reworded message', { code: ErrorCode.Unsupported });
    expect(hasErrorCode(err, ErrorCode.Unsupported)).toBe(true);
    expect(hasErrorCode(err, ErrorCode.Syntax)).toBe(false);
    // works for any object adopting the `code` convention (e.g. a subclass)
    expect(hasErrorCode({ code: ErrorCode.Ffi }, ErrorCode.Ffi)).toBe(true);
    expect(hasErrorCode('nope', ErrorCode.Ffi)).toBe(false);
  });

  test('codes are unique and stable strings', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => v.startsWith('E_'))).toBe(true);
  });
});
