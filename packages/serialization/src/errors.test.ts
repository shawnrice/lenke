import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';
import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { deserialize, serialize } from './index.js';
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

  // Capture whatever a thunk throws (or undefined if it doesn't).
  const caughtFrom = (fn: () => void): unknown => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return e;
    }
  };

  test('invalid ndjson JSON carries ErrorCode.InvalidJson', () => {
    const caught = caughtFrom(() => deserialize('{not json', 'ndjson', new Graph()));
    expect(hasErrorCode(caught, ErrorCode.InvalidJson)).toBe(true);
  });

  test('an ndjson line that is not a node/edge record carries ErrorCode.InvalidShape', () => {
    const caught = caughtFrom(() => deserialize('{"type":"banana"}', 'ndjson', new Graph()));
    expect(hasErrorCode(caught, ErrorCode.InvalidShape)).toBe(true);
  });

  test('a csv edge to a non-existent vertex carries ErrorCode.MissingVertex', () => {
    const csv = 'id,:LABEL\n=== EDGES ===\nid,:START_ID,:END_ID,:TYPE\ne1,x,y,KNOWS';
    const caught = caughtFrom(() => deserialize(csv, 'csv', new Graph()));
    expect(hasErrorCode(caught, ErrorCode.MissingVertex)).toBe(true);
  });

  test('a graphson edge to a missing vertex carries ErrorCode.MissingVertex', () => {
    // Encode a real 2-node/1-edge graph, then drop its vertices so the edge dangles.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['T'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['T'], properties: {} });
    g.addEdge({ id: 'e0', from: a, to: b, labels: ['KNOWS'], properties: {} });
    const doc = JSON.parse(serialize(g, 'graphson'));
    doc.vertices = [];
    const caught = caughtFrom(() => deserialize(JSON.stringify(doc), 'graphson', new Graph()));
    expect(hasErrorCode(caught, ErrorCode.MissingVertex)).toBe(true);
  });
});
