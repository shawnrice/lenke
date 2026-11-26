// FAULT PARITY UNDER A SKIP-ONLY PAGE (item 1905), on the hop rung.
//
// **THIS FILE IS THE EVIDENCE THAT LET A REFUSAL BE REMOVED, so it is not optional cover.**
// `deferredHopOrder` refused a `SKIP` with no `LIMIT` for a precise reason: with no cap the general
// path sorts, projects EVERY row, and drops the skipped ones afterwards — so an item that faults on
// a discarded row RAISES there, while an arm that ranks and projects only the survivors would emit
// fewer rows than it projects and silently return rows instead. `page-fold-fault.test.ts` caught
// item 1062's first cut doing exactly that, which is why the refusal existed rather than being
// caution.
//
// Item 1905 admits the case by doing what the general path does: `plan.skip` is forced to 0,
// every ranked row is re-projected, and the slice happens AFTER. The claim is therefore that fault
// behaviour is identical BY CONSTRUCTION — and a claim of that shape has to be measured against the
// other engine rather than reasoned about, because the whole refusal was a reasoned argument that
// turned out to need a test.
//
// A STORED NaN is the only way to make a projection fault: ingest coerces NaN and the infinities
// to null, so it has to be COMPUTED with `SET` (`page-fold-fault.test.ts` records this).
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  // `bad` carries a real `nu`, so `nu * nan` is NaN and `true + NaN` raises.
  '{"type":"node","id":"bad","labels":["T"],"properties":{"n":0,"nu":5}}',
  // The rest have `nu` NULL, so `nu * nan` is null and `true + null` is null — these never fault.
  '{"type":"node","id":"o1","labels":["T"],"properties":{"n":1,"nu":null}}',
  '{"type":"node","id":"o2","labels":["T"],"properties":{"n":2,"nu":null}}',
  '{"type":"node","id":"o3","labels":["T"],"properties":{"n":3,"nu":null}}',
  '{"type":"edge","id":"r1","from":"bad","to":"o1","labels":["E"],"properties":{"w":1}}',
  '{"type":"edge","id":"r2","from":"o1","to":"o2","labels":["E"],"properties":{"w":2}}',
  '{"type":"edge","id":"r3","from":"o2","to":"o3","labels":["E"],"properties":{"w":3}}',
].join('\n');

const SET_NAN = 'MATCH (n:T) WHERE n.n = 0 SET n.nan = sin(1e400) RETURN count(*) AS c';
/** Faults on the one row whose `nu` is not null — the start of the first edge. */
const FAULTS = '(1 < 2) + (a.nu * a.nan)';

const raised = (f: () => unknown): string => {
  try {
    return JSON.stringify(f());
  } catch {
    return 'RAISED';
  }
};

describe.if(nativeReady)('a faulting projected item under each window', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  nat.query(SET_NAN);
  tsQuery(ts, SET_NAN);

  /** `[window, must it raise?]` — the verdict spelled out, not just compared. */
  const CASES = [
    // THE REFUSAL'S OWN CASE: no cap, so every row is projected and the faulting one raises.
    [' OFFSET 1', true],
    [' SKIP 1', true],
    // No window at all — the degenerate `skip = 0` of the same rule (item 1903).
    ['', true],
    // A true top-k that EXCLUDES the faulting row must NOT raise: the general path projects only
    // the survivors, so a rung that did otherwise would error where the query returns rows.
    [' DESC LIMIT 2', false],
    [' OFFSET 1 LIMIT 2', false],
  ] as const;

  for (const [win, mustRaise] of CASES) {
    test(`ORDER BY b.n + 1${win} ${mustRaise ? 'RAISES' : 'returns rows'}`, () => {
      const q = `MATCH (a:T)-[:E]->(b:T) RETURN ${FAULTS} AS x, b.n AS t ORDER BY b.n + 1${win}`;
      const a = raised(() => tsQuery(ts, q));
      const b = raised(() => nat.query(q));

      // Byte-identical where they return rows, and raising together where they raise.
      expect(a).toBe(b);
      expect(a === 'RAISED').toBe(mustRaise);
    });
  }

  /**
   * THE NODE ARM IS A DIFFERENT WALK AND GETS ITS OWN CASES. `deferredRoute` /
   * `deferredSortedNodeWalk` took the same change in step with `deferredHopOrder` (a route policy
   * differing between the node and hop spellings of one question is this repo's named defect
   * class), but "the hop is fault-equal" is not evidence about the node.
   */
  const NODE_CASES = [
    [' OFFSET 1', true],
    [' SKIP 1', true],
    ['', true],
    [' DESC LIMIT 2', false],
    [' OFFSET 1 LIMIT 2', false],
  ] as const;

  for (const [win, mustRaise] of NODE_CASES) {
    test(`node: ORDER BY n.n + 1${win} ${mustRaise ? 'RAISES' : 'returns rows'}`, () => {
      const q = `MATCH (n:T) RETURN (1 < 2) + (n.nu * n.nan) AS x, n.n AS t ORDER BY n.n + 1${win}`;
      const a = raised(() => tsQuery(ts, q));
      const b = raised(() => nat.query(q));

      expect(a).toBe(b);
      expect(a === 'RAISED').toBe(mustRaise);
    });
  }

  /**
   * `LIMIT 0` IS STILL REFUSED AND THAT IS CORRECTNESS, not speed: `applyProjection` returns
   * `[]` BEFORE projecting anything, so a rung evaluating keys to emit nothing would raise where
   * the query does not. This is the control that keeps that refusal honest.
   */
  test('LIMIT 0 returns no rows rather than raising', () => {
    const q = `MATCH (a:T)-[:E]->(b:T) RETURN ${FAULTS} AS x, b.n AS t ORDER BY b.n + 1 LIMIT 0`;

    expect(raised(() => tsQuery(ts, q))).toBe('[]');
    expect(raised(() => nat.query(q))).toBe('[]');
  });
});
