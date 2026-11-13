// A cross-engine divergence on `SKIP $param`, found at item 1817 while pricing which parameter
// spellings both engines accept (`param-support-probe.mjs`, 20 spellings, 19 agreed).
//
// ⚠️ THE SHAPE OF THE DISAGREEMENT. ISO-GQL spells the offset `OFFSET`; `SKIP` is a Cypher
// synonym this engine also accepts. Both engines take a parameter after `OFFSET`. After `SKIP`:
//
//     TS      raises E_SYNTAX  — `parser.ts` passes `allowParam` only for the OFFSET spelling,
//                               with the comment "SKIP is the Cypher synonym and stays
//                               literal-only"
//     native  accepts it and returns the paged rows
//
// So one engine's parser admits a query the other rejects. It is NOT a value divergence — no
// query returns different ROWS — which is why it is pinned here rather than registered: the
// divergence registry deliberately has no `value` axis, and this is a parse-surface disagreement
// about a non-ISO spelling.
//
// ⚠️ WHY IT IS PINNED RATHER THAN FIXED HERE. Which engine is right is an OWNER decision, not a
// bug with an obvious direction, and it is exactly the kind of question this repo's rules say to
// ask rather than settle:
//
//   - TS's restriction is defensible — `SKIP` is not ISO, so keeping its surface minimal is
//     consistent with the project's "ISO-GQL is NOT Cypher" stance;
//   - native's acceptance is defensible — the two spellings are synonyms, and this repo's
//     "equivalent spellings must cost the same" rule points at treating them identically;
//   - and doing NEITHER is not defensible, because the two engines currently disagree about
//     whether a query is valid at all, which is the hard invariant this suite exists to guard.
//
// Until that is decided the workload generator emits `OFFSET $p`, which both engines accept, and
// `workload-queries.test.ts` asserts `SKIP $` is never generated — so the fuzzer stays red only
// for regressions, not for this known question.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7}}',
  '{"type":"node","id":"3","labels":["T"],"properties":{"n":5}}',
].join('\n');

describe.if(nativeReady)('SKIP $param — OPEN: TS rejects, native accepts', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const SKIP_PARAM = 'MATCH (n:T) RETURN n.n AS x ORDER BY x SKIP $k';
  const OFFSET_PARAM = 'MATCH (n:T) RETURN n.n AS x ORDER BY x OFFSET $k';

  test('the ISO spelling OFFSET $k agrees — this is the CONTROL', () => {
    // Without this, a future change that broke BOTH engines on a parameterized offset would make
    // the pinned test below start passing for the wrong reason.
    const a = JSON.stringify(tsQuery(ts, OFFSET_PARAM, { k: 1 }));
    const b = JSON.stringify(nat.query(OFFSET_PARAM, { k: 1 }));

    expect(a).toBe(b);
    expect(a).toBe('[{"x":5},{"x":7}]');
  });

  test('both engines accept a LITERAL after SKIP — so the disagreement is about the PARAM', () => {
    const lit = 'MATCH (n:T) RETURN n.n AS x ORDER BY x SKIP 1';

    expect(JSON.stringify(tsQuery(ts, lit))).toBe(JSON.stringify(nat.query(lit)));
  });

  test('native accepts SKIP $k', () => {
    expect(JSON.stringify(nat.query(SKIP_PARAM, { k: 1 }))).toBe('[{"x":5},{"x":7}]');
  });

  test('TS rejects SKIP $k — documenting the current behaviour', () => {
    expect(() => tsQuery(ts, SKIP_PARAM, { k: 1 })).toThrow();
  });

  // ⚠️ THE PIN. Delete this and the two above it once the owner decides which engine moves.
  test.failing('OPEN: the engines disagree about whether SKIP $k is a valid query', () => {
    const tsOk = (() => {
      try {
        tsQuery(ts, SKIP_PARAM, { k: 1 });

        return true;
      } catch {
        return false;
      }
    })();
    const natOk = (() => {
      try {
        nat.query(SKIP_PARAM, { k: 1 });

        return true;
      } catch {
        return false;
      }
    })();

    expect(tsOk).toBe(natOk);
  });
});
