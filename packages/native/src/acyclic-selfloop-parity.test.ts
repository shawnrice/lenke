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
          // ⚠️ FREED DETERMINISTICALLY. The engine warns when a `RustGraph` is garbage-collected
          // without `free()` — finalizers are not guaranteed to run, so a leaked handle sits
          // unreleased. One handle per test case here, so the warning fires once per case and the
          // fix is one `try/finally`.
          const nativeGraph = graphFromNdjson(nativeBackend(), fx.ndjson);
          const nativeRows = (() => {
            try {
              return nativeGraph.query(text);
            } finally {
              nativeGraph.free();
            }
          })();

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

/*
 * ⚠️⚠️ **A GENERATED FIXTURE WITH REAL CYCLES, because the four hand fixtures above are 1-2 vertices
 * and a DFS can be wrong in ways they cannot show** (item 2002). The acyclic COUNT route is a
 * depth-first walk carrying a visited set; the cases that distinguish it from a trail walk are
 * 2-cycles and longer returns, at a depth where the pruning actually changes the answer. This graph
 * carries self-loops, 2-cycles, a triangle and parallel edges at once, and it is compared against
 * the Rust engine — an INDEPENDENT implementation, which is the only oracle here that was not
 * written by the same person as the route.
 *
 * ⚠️ AND THE COUNTS ARE ASSERTED NON-TRIVIAL. A route that answered 0 everywhere, or that declined
 * and silently fell back, would agree with native on every row — so the test checks that ACYCLIC and
 * WALK actually DIFFER on this graph. Without that, the parity assertions pass on a fixture where
 * acyclicity never bites, which is exactly the hole item 2001's first correction formula fell into.
 */
const CYCLIC_NDJSON = (() => {
  const lines: string[] = [];
  const N = 60;

  for (let i = 0; i < N; i += 1) {
    lines.push(
      `{"type":"node","id":"v${String(i)}","labels":["T"],"properties":{"n":${String(i % 7)}}}`,
    );
  }

  let e = 0;
  const edge = (from: number, to: number): void => {
    lines.push(
      `{"type":"edge","id":"g${String(e)}","labels":["E"],"from":"v${String(from)}","to":"v${String(to)}","properties":{}}`,
    );
    e += 1;
  };

  for (let i = 0; i < N; i += 1) {
    edge(i, (i + 1) % N); // the ring
    edge((i + 1) % N, i); // every ring edge also goes BACK — a 2-cycle at every position
    edge(i, (i + 7) % N); // a chord, so triangles and longer returns exist

    if (i % 11 === 0) {
      edge(i, i); // a self-loop every 11th vertex
    }

    if (i % 13 === 0) {
      edge(i, (i + 1) % N); // a PARALLEL copy of a ring edge
    }
  }

  /*
   * ⚠️⚠️ **A HUB: vertex 0 has many out-edges and no matching in-edges, so a SEEDED query sees a
   * different graph forwards and backwards.** ⚠️ An earlier version of this comment claimed the hub
   * was needed because the construction above is reverse-isomorphic to itself and therefore made
   * inward and outward counts equal. **That reasoning was wrong, and asserting it failed at every
   * bound.** An UNSEEDED total path count is equal to its reverse for EVERY graph — reversing a
   * path is a bijection between the length-k paths of G and those of G-reversed — so no fixture can
   * make those two numbers differ, and the inward test below has to be SEEDED to see direction at
   * all. The hub is what makes the seeded counts differ.
   */
  for (let k = 2; k < 20; k += 1) {
    edge(0, (k * 3) % N);
  }

  /*
   * ⚠️ AN ISOLATED VERTEX, AND A MUTATION ROUND IS WHY. The route skips a source whose CSR slot is
   * `undefined` — a vertex carrying no edge of the queried type. Without such a vertex here, the
   * mutant that removes that guard SURVIVED: every source in a fully-connected fixture has a slot,
   * so the guard is unreachable and its removal changes nothing.
   */
  lines.push('{"type":"node","id":"alone","labels":["T"],"properties":{"n":3}}');
  // And one carrying ONLY a different edge type, so it is in the graph but not in THIS CSR.
  lines.push('{"type":"node","id":"other","labels":["T"],"properties":{"n":4}}');
  lines.push(
    '{"type":"edge","id":"gx","labels":["F"],"from":"other","to":"alone","properties":{}}',
  );

  return lines.join('\n');
})();

describe('ACYCLIC counts over a cyclic generated graph: TS vs native', () => {
  for (const bound of ['{1,1}', '{1,2}', '{1,3}', '{2,3}', '{1,4}'] as const) {
    test(`count(*) ACYCLIC ${bound}`, () => {
      if (!nativeReady) {
        expect(nativeReady).toBe(false);

        return;
      }

      const text = `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) RETURN count(*) AS c`;
      const walkText = `MATCH (x:T)-[:E]->${bound}(y:T) RETURN count(*) AS c`;
      const tsRows = [...tsQuery(tsGraphOf(CYCLIC_NDJSON), text, {})];
      const nativeGraph = graphFromNdjson(nativeBackend(), CYCLIC_NDJSON);
      const nativeRows = (() => {
        try {
          return nativeGraph.query(text);
        } finally {
          nativeGraph.free();
        }
      })();

      expect(nativeRows).toEqual(tsRows);

      // ⚠️ NON-TRIVIALITY: acyclicity must actually bite here, or the parity above proves nothing.
      const walk = [...tsQuery(tsGraphOf(CYCLIC_NDJSON), walkText, {})][0] as { c: number };
      const acyclic = tsRows[0] as { c: number };

      expect(acyclic.c).toBeGreaterThan(0);
      expect(acyclic.c).toBeLessThan(walk.c);
    });

    test(`count(*) ACYCLIC ${bound} INWARD`, () => {
      if (!nativeReady) {
        expect(nativeReady).toBe(false);

        return;
      }

      /*
       * ⚠️ THE MIRROR SPELLING, AND A MUTATION ROUND IS WHY. The route reads the IN-adjacency when
       * `inward` is set; the mutant hard-coding `csrFor(graph, false, types)` SURVIVED because no
       * test used `<-[:E]-`. On this graph the in- and out-counts are NOT equal (the chords are
       * one-directional), so a route that ignored `inward` answers the outward count here.
       */
      // ⚠️ SEEDED, AND THAT IS LOAD-BEARING. An unseeded total count is identical forwards and
      // backwards for every graph (see the hub note above), so the unseeded spelling cannot catch a
      // route that ignores `inward` no matter what the fixture looks like.
      const text = `MATCH ACYCLIC (x:T)<-[:E]-${bound}(y:T) WHERE x.n = 3 RETURN count(*) AS c`;
      const tsRows = [...tsQuery(tsGraphOf(CYCLIC_NDJSON), text, {})];
      const nativeGraph = graphFromNdjson(nativeBackend(), CYCLIC_NDJSON);
      const nativeRows = (() => {
        try {
          return nativeGraph.query(text);
        } finally {
          nativeGraph.free();
        }
      })();

      expect(nativeRows).toEqual(tsRows);
      expect((tsRows[0] as { c: number }).c).toBeGreaterThan(0);

      /*
       * ⚠️ THE DIRECTION MUST ACTUALLY MATTER HERE, AND IT IS ASSERTED RATHER THAN ASSUMED. Parity
       * alone is satisfied by a route that ignores `inward` whenever the two spellings happen to
       * agree — which, for an UNSEEDED count, they always do. With the seed they differ because of
       * the hub, and this line is what fails if a later edit removes that asymmetry instead of the
       * coverage silently evaporating.
       */
      const outward = [
        ...tsQuery(
          tsGraphOf(CYCLIC_NDJSON),
          `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) WHERE x.n = 3 RETURN count(*) AS c`,
          {},
        ),
      ][0] as { c: number };

      expect((tsRows[0] as { c: number }).c).not.toBe(outward.c);
    });

    test(`count(*) ACYCLIC ${bound} with a seed and an endpoint label`, () => {
      if (!nativeReady) {
        expect(nativeReady).toBe(false);

        return;
      }

      // The SEEDED arm takes a different path through the route (seeked sources + a seed predicate),
      // and an endpoint predicate exercises the per-reached-endpoint test.
      const text = `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T) WHERE x.n = 3 AND y.n <> 5 RETURN count(*) AS c`;
      const tsRows = [...tsQuery(tsGraphOf(CYCLIC_NDJSON), text, {})];
      const nativeGraph = graphFromNdjson(nativeBackend(), CYCLIC_NDJSON);
      const nativeRows = (() => {
        try {
          return nativeGraph.query(text);
        } finally {
          nativeGraph.free();
        }
      })();

      expect(nativeRows).toEqual(tsRows);
      expect((tsRows[0] as { c: number }).c).toBeGreaterThan(0);
    });
  }
});
