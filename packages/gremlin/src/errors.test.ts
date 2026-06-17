import { describe, expect, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { run } from './executor.js';
import { createTestTinkerGraph } from './fixtures/createTestTinkerGraph.js';
import { serialize } from './serialize.js';
import { map, V } from './steps.js';
import { traversal } from './traversal.js';

// Capture whatever a thunk throws (or undefined if it doesn't). Traversals are
// lazy, so the throw only fires when the result iterable is materialized.
const caughtFrom = (fn: () => void): unknown => {
  try {
    fn();

    return undefined;
  } catch (e) {
    return e;
  }
};

describe('gremlin error codes', () => {
  test('V as a non-first step carries ErrorCode.Syntax', () => {
    const g = createTestTinkerGraph();
    const caught = caughtFrom(() => [...run(traversal(V(), V()), g)]);
    expect(hasErrorCode(caught, ErrorCode.Syntax)).toBe(true);
  });

  // (match() and subgraph() are now implemented, so no gremlin step currently
  // throws NotImplemented — the ErrorCode is still reserved for future use.)

  test('serializing a closure-bearing plan carries ErrorCode.Unsupported', () => {
    const caught = caughtFrom(() =>
      serialize(
        traversal(
          V(),
          map((x: unknown) => x),
        ),
      ),
    );
    expect(hasErrorCode(caught, ErrorCode.Unsupported)).toBe(true);
  });
});
