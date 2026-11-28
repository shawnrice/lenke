import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode, hasErrorCode } from '@lenke/errors';

import { query } from './index.js';

/*
 * Item 2526: `CALL <proc>({edgeType: …})` must be accepted AND HONORED, as the native engine does.
 *
 * `edgeType` is this codebase's own name for an edge type — `Graph.ts` uses it 124 times and the
 * constraint API is `createEdgeTypeConstraint` — while the CALL surface spells it `edgeLabel`. The
 * native engine's `CONFIG_KEYS` carries both ("the TS engine's list, PLUS the engine's `edgeType`
 * spelling of `edgeLabel`") and honors them identically; this engine's list had only `edgeLabel`, so
 * a query valid on native was an error here. Measured before the fix:
 *
 *     CALL degree({edgeType: 'E'}) …    ts: REJECTED (unknown config key)    native: ACCEPTED
 *
 * ## WHY "ACCEPTED" IS NOT ENOUGH TO TEST
 *
 * `applyAlgoConfig` writes the value under the key's OWN name, so listing `edgeType` without
 * normalizing it to `edgeLabel` would set `cfg.edgeType`, which no algorithm reads — accepted and
 * SILENTLY IGNORED. That is worse than rejecting, and is the exact failure the validation exists to
 * prevent (its own comment: "a silently dropped key once hid the `pivots` bug").
 *
 * So the fixture FORCES the distinction: `a` has one `E` edge and two `F` edges, making the three
 * answers 3 (unfiltered), 1 (filtered to E) and 2 (filtered to F). A config that is ignored reads 3
 * and cannot hide behind a coincidence.
 */
const seeded = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });
  const d = g.addVertex({ id: 'd', labels: ['P'], properties: {} });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'f1', from: a, to: c, labels: ['F'], properties: {} });
  g.addEdge({ id: 'f2', from: a, to: d, labels: ['F'], properties: {} });

  return g;
};

const maxDegree = (config: string): unknown =>
  query(seeded(), `CALL degree(${config}) YIELD node, degree RETURN max(degree) AS d`);

describe('CALL config accepts edgeType as an alias for edgeLabel (item 2526)', () => {
  test('the fixture discriminates: unfiltered, E and F all differ', () => {
    expect(maxDegree('')).toEqual([{ d: 3 }]);
    expect(maxDegree("{edgeLabel: 'E'}")).toEqual([{ d: 1 }]);
    expect(maxDegree("{edgeLabel: 'F'}")).toEqual([{ d: 2 }]);
  });

  /*
   * THE LOAD-BEARING ROWS. Asserting the FILTERED answer, not merely that the query runs: an
   * accepted-but-ignored key would read 3 here and pass any "does not throw" test.
   */
  test('edgeType is HONORED, not merely accepted', () => {
    expect(maxDegree("{edgeType: 'E'}")).toEqual([{ d: 1 }]);
    expect(maxDegree("{edgeType: 'F'}")).toEqual([{ d: 2 }]);
  });

  test('edgeType and edgeLabel give the same answer for the same value', () => {
    expect(maxDegree("{edgeType: 'E'}")).toEqual(maxDegree("{edgeLabel: 'E'}"));
    expect(maxDegree("{edgeType: 'F'}")).toEqual(maxDegree("{edgeLabel: 'F'}"));
  });

  /* CONTROLS — widening must not have weakened the validation that was the point of the list. */
  test('CONTROL: a genuine typo is still rejected, with the code', () => {
    const caught = (() => {
      try {
        maxDegree("{edgeLable: 'E'}");

        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(hasErrorCode(caught, ErrorCode.InvalidValue)).toBe(true);
    expect(String((caught as Error).message)).toContain('edgeLable');
  });

  test('CONTROL: a wrong-typed value is still rejected', () => {
    expect(() => maxDegree('{edgeType: 42}')).toThrow(/expects a string/);
  });

  test('CONTROL: an unrelated key still works and an unknown one still does not', () => {
    expect(() => maxDegree("{direction: 'out'}")).not.toThrow();
    expect(() => maxDegree("{nosuchkey: 'x'}")).toThrow(/unknown config key/);
  });
});
