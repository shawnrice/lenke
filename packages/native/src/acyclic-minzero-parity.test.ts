// `MATCH ACYCLIC … {0,k}` — the ZERO-LENGTH path, TS against the Rust engine (item 2005).
//
// **THIS PINS A WRONG ANSWER I SHIPPED AT ITEM 2002 AND THE FUZZER CAUGHT AT ITEM 2005.**
// `varLengthCount`'s acyclic route counted only paths of length >= 1, so a `{0,k}` quantifier — which
// admits the zero-length path, one row per source, endpoint == start — came back short by exactly the
// source count. On a 3-chain, `{0,1}` reads 5 for WALK and TRAIL and **2** for ACYCLIC.
//
// The differential fuzzer reported it as `MATCH ACYCLIC (a:T)<-[:F]-{0,2}(b) RETURN count(*) AS x`
// with "the engines disagree about the ANSWER, which no registry entry may excuse" —
// `divergence-registry.ts` has no `value` axis by design, so there was nowhere to file it.
//
// **AND `bun run fuzz` WAS GREEN AT ITEM 2002.** The draw needs `mode = acyclic` AND `min = 0`
// together, both chosen at random, so it took until item 2005 to come up — one failure in six runs
// even then. **A passing generative run is evidence about the shapes it DREW, not about the shapes
// that exist.** That is the whole reason this file exists instead of trusting the fuzzer to redraw
// it: a named test runs every time.
//
// IT ALSO COVERS THE `DISTINCT` SIDE, which was already correct — `runReach` handles `minZero`
// explicitly and item 2004's arm passes it through. Pinning the half that worked is what makes this
// a regression test for the FAMILY rather than for one bug.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/*
 * A 3-chain plus a branch and a 2-cycle, so the zero-length count is not the only thing that moves
 * between bounds — and an `F` edge, because the fuzzer's failing draw used a type the chain lacks and
 * a direction (`<-`) opposite to it.
 */
const NDJSON = [
  '{"type":"node","id":"a","labels":["T"],"properties":{"n":0}}',
  '{"type":"node","id":"b","labels":["T"],"properties":{"n":1}}',
  '{"type":"node","id":"c","labels":["T"],"properties":{"n":2}}',
  '{"type":"node","id":"d","labels":["T"],"properties":{"n":3}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"b","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"c","to":"b","properties":{}}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"a","to":"d","properties":{}}',
  '{"type":"edge","id":"e5","labels":["F"],"from":"d","to":"a","properties":{}}',
].join('\n');

const tsGraphOf = (): Graph => tsDeserialize(NDJSON, 'ndjson', new Graph());

const both = (text: string): { ts: unknown[]; native: unknown[] } => {
  const ts = [...tsQuery(tsGraphOf(), text, {})];
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const native = (() => {
    try {
      return nativeGraph.query(text);
    } finally {
      nativeGraph.free();
    }
  })();

  return { ts, native };
};

describe('ACYCLIC with a zero-length-admitting quantifier: TS vs native', () => {
  // `{0,1}` AND `{0,2}` ARE THE FAILING SHAPES; `{1,k}` is the control that was always right, and
  // `{0,0}` is the one the detector refuses outright (`max < 1`), so it exercises a third route.
  for (const bound of ['{0,1}', '{0,2}', '{0,3}', '{1,2}', '{0,0}'] as const) {
    for (const [name, text] of [
      ['count(*) out', `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) RETURN count(*) AS v`],
      // The fuzzer's own shape: an INWARD walk over a type only one edge carries.
      ['count(*) in F', `MATCH ACYCLIC (x:T)<-[:F]-${bound}(y) RETURN count(*) AS v`],
      [
        'count(*) seeded',
        `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) WHERE x.n = 0 RETURN count(*) AS v`,
      ],
      // AN ENDPOINT PREDICATE, because the zero-length path's endpoint IS its start — so the
      // endpoint test must be applied to the source itself, and a fix that appended the sources
      // unconditionally would over-count here and nowhere else.
      [
        'count(*) endpoint-pred',
        `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) WHERE y.n <> 0 RETURN count(*) AS v`,
      ],
      ['DISTINCT', `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) RETURN DISTINCT y.n AS v`],
    ] as const) {
      test(`${name} ${bound}`, () => {
        if (!nativeReady) {
          expect(nativeReady).toBe(false);

          return;
        }

        const { ts, native } = both(text);
        const key = (rows: readonly unknown[]): string =>
          JSON.stringify(
            rows.map((r) => (r as { v: unknown }).v).sort((x, z) => Number(x) - Number(z)),
          );

        expect(key(native)).toBe(key(ts));
      });
    }
  }

  test('the zero-length path is EXACTLY one row per source, and WALK agrees', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    /*
     * THE SIGNATURE OF THE BUG, asserted directly rather than only via parity: at `{0,k}` every
     * mode must include the zero-length path, so ACYCLIC's count exceeds its `{1,k}` count by the
     * SOURCE COUNT. Parity alone would also pass if BOTH engines were wrong the same way, which is
     * not idle worry — this fixture's answers come from the same two implementations the fuzzer
     * compares.
     */
    const sources = 4;
    const at = (bound: string): number =>
      (both(`MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) RETURN count(*) AS v`).ts[0] as { v: number })
        .v;
    const walkAt = (bound: string): number =>
      (both(`MATCH (x:T)-[:E]->${bound}(y:T) RETURN count(*) AS v`).ts[0] as { v: number }).v;

    expect(at('{0,1}')).toBe(at('{1,1}') + sources);
    expect(at('{0,2}')).toBe(at('{1,2}') + sources);
    // On this fixture no `E` path repeats a vertex within two hops, so ACYCLIC and WALK coincide —
    // which makes WALK an independent oracle for the zero-length term.
    expect(at('{0,1}')).toBe(walkAt('{0,1}'));
  });
});
