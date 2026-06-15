import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';
import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { deserialize } from './index.js';
import { normalizeValue } from './value.js';

describe('serialization error codes', () => {
  test('an unknown format carries ErrorCode.UnknownFormat', () => {
    let caught: unknown;
    try {
      deserialize('', 'nope' as never, new Graph());
    } catch (e) {
      caught = e;
    }
    expect(hasErrorCode(caught, ErrorCode.UnknownFormat)).toBe(true);
  });

  test('invalid pg-json JSON carries ErrorCode.InvalidJson', () => {
    let caught: unknown;
    try {
      deserialize('{not json', 'pg-json', new Graph());
    } catch (e) {
      caught = e;
    }
    expect(hasErrorCode(caught, ErrorCode.InvalidJson)).toBe(true);
  });

  test('an out-of-model property value carries ErrorCode.InvalidValue', () => {
    let caught: unknown;
    try {
      normalizeValue(new Date());
    } catch (e) {
      caught = e;
    }
    expect(hasErrorCode(caught, ErrorCode.InvalidValue)).toBe(true);
  });
});
