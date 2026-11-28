import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode } from '@lenke/errors';

import { count, dedupe, id, limit, out, path, unfold, V, values } from '../index.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';

/*
 * Item 2518: `E_DATA_EXCEPTION` was the only canonical error code that NO test named.
 *
 * An error-code survey of all 17 codes in `@lenke/errors` found exactly one thrown-but-unnamed:
 * `E_DATA_EXCEPTION`, whose single live throw site is the "element step applied to a path" guard in
 * this module. The behaviour was verified against gremlin-console when the guard was written
 * (`path().values(…)`, `.hasLabel(…)`, `.inV()`, `.out(…)`, `.id()`/`.label()` all raise
 * ClassCastException there), but nothing pinned the CODE.
 *
 * ## WHY THE CODE AND NOT THE MESSAGE
 *
 * `@lenke/errors` states the contract: "the **code is the contract**, not the message. Consumers
 * should branch on `error.code` … so a reworded or typo-fixed message is never a breaking change."
 * These tests therefore assert `error.code`. A message-only assertion would pass while the code
 * silently changed, which is the half a consumer actually depends on.
 *
 * ## THE THREE SHAPES THE GUARD DISTINGUISHES
 *
 * The scan is not "any step after `path()`" — it walks forward and the verdict depends on the kind:
 *
 *   - an ELEMENT step raises;
 *   - a PASSTHROUGH step (`limit`, `dedup`, `order`, `as`, …) leaves the path a path, so the scan
 *     keeps looking and a later element step still raises;
 *   - `unfold()` turns the path INTO its elements, and a CONSUMING step (`count`, `fold`) ends the
 *     scan — both must stay legal.
 *
 * The negative rows are the load-bearing half: a guard that raised on all three would also pass a
 * test that only checked the positive case.
 */
const seeded = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

  return g;
};

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();

    return 'NO THROW';
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
};

describe('an element step on a path raises E_DATA_EXCEPTION (item 2518)', () => {
  test('path() then values() carries the CODE, not just a message', () => {
    expect(codeOf(() => [...run(traversal(V(), path(), values('k')), seeded())])).toBe(
      ErrorCode.DataException,
    );
  });

  test('path() then id() — a second element step, same code', () => {
    expect(codeOf(() => [...run(traversal(V(), path(), id()), seeded())])).toBe(
      ErrorCode.DataException,
    );
  });

  test('path() then out() — a traversal step, same code', () => {
    expect(codeOf(() => [...run(traversal(V(), path(), out('E')), seeded())])).toBe(
      ErrorCode.DataException,
    );
  });

  /*
   * A PASSTHROUGH does not launder the path. If the scan stopped at the first non-element step this
   * row would pass silently, so it pins the forward-walk rather than a single-step lookahead.
   */
  test('a PASSTHROUGH step between does not launder the path', () => {
    expect(codeOf(() => [...run(traversal(V(), path(), limit(5), values('k')), seeded())])).toBe(
      ErrorCode.DataException,
    );
    expect(codeOf(() => [...run(traversal(V(), path(), dedupe(), values('k')), seeded())])).toBe(
      ErrorCode.DataException,
    );
  });

  /* THE NEGATIVE HALF — the two documented ways to use a path legally must still work. */
  test('unfold() first is legal — it turns the path into its elements', () => {
    const rows = [...run(traversal(V(), path(), unfold(), values('k')), seeded())];

    expect(rows.length).toBeGreaterThan(0);
  });

  test('a CONSUMING step ends the scan — count() over paths is legal', () => {
    expect([...run(traversal(V(), path(), count()), seeded())]).toEqual([2]);
  });

  test('no path() at all — the gate returns early and nothing raises', () => {
    expect([...run(traversal(V(), values('k')), seeded())].sort()).toEqual([1, 2]);
  });
});
