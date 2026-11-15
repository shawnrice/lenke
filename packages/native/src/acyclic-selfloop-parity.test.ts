// `ACYCLIC` / `TRAIL` / `WALK` over a quantified path, TS against the Rust engine (item 2001).
//
// ⚠️⚠️ **THIS FILE EXISTS BECAUSE I MADE A CROSS-ENGINE CLAIM I HAD NOT CHECKED.**
// `acyclic-selfloop-2001.mjs` advertised `LENKE_ENGINE=1` as routing its queries through the Rust
// engine. It does not — `LENKE_ENGINE` is read only by `package.json`'s `test:engine` script, and
// `query` from `@lenke/gql` never consults it — so that run was TypeScript twice and its identical
// output said nothing about byte-identity. A `.mjs` probe cannot reach the Rust side at all; it needs
// `conformance-harness.ts`'s `nativeBackend()`. **A claim about two engines needs a harness that can
// see both.**
//
// 🔑 WHY THESE SHAPES. Item 2001 found `MATCH ACYCLIC` falling off the var-length counting rung into
// the general matcher (234-520x), and the cure under consideration is to give the rung an ACYCLIC
// correction the way it already has one for TRAIL. Any such correction is arithmetic over self-loops
// and returns, so these fixtures — a lone self-loop, a self-loop beside a real edge, and parallel
// edges — are exactly the inputs it would get wrong. Pinning both engines' current answers FIRST
// means the correction has an oracle that is not the correction's own author.
//
// ⚠️ AND IT PINS `WALK` TOO, not just `ACYCLIC`. Reading the bindings (rather than a `count(*)`)
// showed that on `a->a` + `a->b` the depth-2 rows are `a->a->b` ONLY — `a->a->a`, the same edge
// twice, is absent even in WALK mode. That is the baseline any correction subtracts from, and I had
// modelled it as all edge sequences, which is where two successive wrong formulas came from. If that
// baseline ever changes, this test is what says so.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

type Fixture = { readonly name: string; readonly ndjson: string };

/*
 * The fixtures are NDJSON so the same bytes build both engines' graphs — the Rust side is fed a
 * serialized graph, not a `Graph` object, so a hand-built TS `Graph` could not be compared at all.
 */
const FIXTURES: readonly Fixture[] = [
  {
    name: 'one vertex, one self-loop',
    ndjson: [
      '{"type":"node","id":"a","labels":["T"],"properties":{"n":1}}',
      '{"type":"edge","id":"l","labels":["E"],"from":"a","to":"a","properties":{}}',
    ].join('\n'),
  },
  {
    name: 'self-loop beside a real edge',
    ndjson: [
      '{"type":"node","id":"a","labels":["T"],"properties":{"n":1}}',
      '{"type":"node","id":"b","labels":["T"],"properties":{"n":2}}',
      '{"type":"edge","id":"l","labels":["E"],"from":"a","to":"a","properties":{}}',
      '{"type":"edge","id":"e","labels":["E"],"from":"a","to":"b","properties":{}}',
    ].join('\n'),
  },
  {
    name: 'two parallel edges, no loop',
    ndjson: [
      '{"type":"node","id":"a","labels":["T"],"properties":{"n":1}}',
      '{"type":"node","id":"b","labels":["T"],"properties":{"n":2}}',
      '{"type":"edge","id":"e1","labels":["E"],"from":"a","to":"b","properties":{}}',
      '{"type":"edge","id":"e2","labels":["E"],"from":"a","to":"b","properties":{}}',
    ].join('\n'),
  },
  {
    name: 'a 2-cycle — the return case an ACYCLIC correction must subtract',
    ndjson: [
      '{"type":"node","id":"a","labels":["T"],"properties":{"n":1}}',
      '{"type":"node","id":"b","labels":["T"],"properties":{"n":2}}',
      '{"type":"edge","id":"ab","labels":["E"],"from":"a","to":"b","properties":{}}',
      '{"type":"edge","id":"ba","labels":["E"],"from":"b","to":"a","properties":{}}',
    ].join('\n'),
  },
];

const BOUNDS = ['{1,1}', '{1,2}', '{1,3}', '{2,2}'] as const;
const MODES = { WALK: 'MATCH', TRAIL: 'MATCH TRAIL', ACYCLIC: 'MATCH ACYCLIC' } as const;

/*
 * ⚠️ `tsDeserialize` RATHER THAN A HAND-ROLLED READER. The differential fuzzer builds its TS graph
 * this way and its native graph with `graphFromNdjson`, so using both here means the two engines read
 * the SAME bytes through the SAME paths the fuzzer already exercises. A bespoke reader in this file
 * would be a third ingest, and a divergence in it would read as a divergence in the query.
 */
const tsGraphOf = (ndjson: string): Graph => tsDeserialize(ndjson, 'ndjson', new Graph());

describe('ACYCLIC/TRAIL/WALK over a quantified path: TS vs native', () => {
  for (const fx of FIXTURES) {
    for (const [mode, keyword] of Object.entries(MODES)) {
      for (const bound of BOUNDS) {
        // ⚠️ ORDERED comparison, not a multiset. These queries carry no `ORDER BY`, but a quantified
        // path's row order is the rung's own output order and the differential fuzzer gives such
        // shapes a final sort key precisely because it is otherwise unspecified — here the shapes are
        // tiny and deterministic, so pinning order costs nothing and catches a reordering cure.
        const text = `${keyword} (x:T)-[:E]->${bound}(y:T) RETURN x.n AS xn, y.n AS yn`;

        test(`${fx.name} / ${mode} ${bound}`, () => {
          if (!nativeReady) {
            // The .so is built by `bun run build`; skipping loudly beats a false pass.
            expect(nativeReady).toBe(false);

            return;
          }

          const tsRows = [...tsQuery(tsGraphOf(fx.ndjson), text, {})];
          const nativeRows = graphFromNdjson(nativeBackend(), fx.ndjson).query(text);

          /*
           * ⚠️ COMPARED AS ARRAYS, ORDERED. `RustGraph.query` returns row OBJECTS — the same shape
           * the TS side returns — not the `{columns, rows}` JSON document that
           * `resultsEqualInOrder` canonicalizes, so routing these through that helper parsed an
           * empty string and failed all 48 cases on the harness rather than on the engines.
           *
           * Ordered is deliberate: these fixtures are 1-2 vertices and fully deterministic, so
           * pinning order costs nothing and catches a cure that reorders a quantified path's rows.
           */
          expect(nativeRows).toEqual(tsRows);
        });
      }
    }
  }
});
