import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode, isPlGraphError, PlGraphError } from './index.js';

describe('PlGraphError', () => {
  test('carries a stable code, message, cause, and details', () => {
    const cause = new Error('underlying');
    const err = new PlGraphError('bad input', {
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

  test('isPlGraphError narrows correctly', () => {
    expect(isPlGraphError(new PlGraphError('x', { code: ErrorCode.Syntax }))).toBe(true);
    expect(isPlGraphError(new Error('x'))).toBe(false);
    expect(isPlGraphError(null)).toBe(false);
  });

  test('hasErrorCode matches on the code, not the message', () => {
    const err = new PlGraphError('reworded message', { code: ErrorCode.Unsupported });
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
