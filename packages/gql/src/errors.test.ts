import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { GqlSyntaxError } from './lexer.js';
import { parse } from './parser.js';

describe('gql error codes', () => {
  test('a parse error carries the stable ErrorCode.Syntax (not just a message)', () => {
    let caught: unknown;
    try {
      parse('MATCH ('); // unterminated pattern
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GqlSyntaxError);
    expect((caught as GqlSyntaxError).code).toBe(ErrorCode.Syntax);
    expect(hasErrorCode(caught, ErrorCode.Syntax)).toBe(true);
    expect((caught as GqlSyntaxError).pos).toBeGreaterThanOrEqual(0); // still carries pos
  });
});
