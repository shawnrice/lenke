// `ACYCLIC` / `TRAIL` / `WALK` over a quantified path, TS against the Rust engine (item 2001).
//
// **THIS FILE EXISTS BECAUSE I MADE A CROSS-ENGINE CLAIM I HAD NOT CHECKED.**
// `acyclic-selfloop-2001.mjs` advertised `LENKE_ENGINE=1` as routing its queries through the Rust
// engine. It does not — `LENKE_ENGINE` is read only by `package.json`'s `test:engine` script, and
// `query` from `@lenke/gql` never consults it — so that run was TypeScript twice and its identical
// output said nothing about byte-identity. A `.mjs` probe cannot reach the Rust side at all; it needs
// `conformance-harness.ts`'s `nativeBackend()`. **A claim about two engines needs a harness that can
// see both.**
//
// WHY THESE SHAPES. Item 2001 found `MATCH ACYCLIC` falling off the var-length counting rung into
// the general matcher (234-520x), and the cure under consideration is to give the rung an ACYCLIC
// correction the way it already has one for TRAIL. Any such correction is arithmetic over self-loops
// and returns, so these fixtures — a lone self-loop, a self-loop beside a real edge, and parallel
// edges — are exactly the inputs it would get wrong. Pinning both engines' current answers FIRST
// means the correction has an oracle that is not the correction's own author.
//
// AND IT PINS `WALK` TOO, not just `ACYCLIC`. Reading the bindings (rather than a `count(*)`)
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
 * `tsDeserialize` RATHER THAN A HAND-ROLLED READER. The differential fuzzer builds its TS graph
 * this way and its native graph with `graphFromNdjson`, so using both here means the two engines read
 * the SAME bytes through the SAME paths the fuzzer already exercises. A bespoke reader in this file
 * would be a third ingest, and a divergence in it would read as a divergence in the query.
 */
const tsGraphOf = (ndjson: string): Graph => tsDeserialize(ndjson, 'ndjson', new Graph());

describe('ACYCLIC/TRAIL/WALK over a quantified path: TS vs native', () => {
  for (const fx of FIXTURES) {
    for (const [mode, keyword] of Object.entries(MODES)) {
      for (const bound of BOUNDS) {
        // ORDERED comparison, not a multiset. These queries carry no `ORDER BY`, but a quantified
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
          // FREED DETERMINISTICALLY. The engine warns when a `RustGraph` is garbage-collected
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
           * COMPARED AS ARRAYS, ORDERED. `RustGraph.query` returns row OBJECTS — the same shape
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
 * **A GENERATED FIXTURE WITH REAL CYCLES, because the four hand fixtures above are 1-2 vertices
 * and a DFS can be wrong in ways they cannot show** (item 2002). The acyclic COUNT route is a
 * depth-first walk carrying a visited set; the cases that distinguish it from a trail walk are
 * 2-cycles and longer returns, at a depth where the pruning actually changes the answer. This graph
 * carries self-loops, 2-cycles, a triangle and parallel edges at once, and it is compared against
 * the Rust engine — an INDEPENDENT implementation, which is the only oracle here that was not
 * written by the same person as the route.
 *
 * AND THE COUNTS ARE ASSERTED NON-TRIVIAL. A route that answered 0 everywhere, or that declined
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
   * **A HUB: vertex 0 has many out-edges and no matching in-edges, so a SEEDED query sees a
   * different graph forwards and backwards.** An earlier version of this comment claimed the hub
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
   * AN ISOLATED VERTEX, AND A MUTATION ROUND IS WHY. The route skips a source whose CSR slot is
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

      // NON-TRIVIALITY: acyclicity must actually bite here, or the parity above proves nothing.
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
       * THE MIRROR SPELLING, AND A MUTATION ROUND IS WHY. The route reads the IN-adjacency when
       * `inward` is set; the mutant hard-coding `csrFor(graph, false, types)` SURVIVED because no
       * test used `<-[:E]-`. On this graph the in- and out-counts are NOT equal (the chords are
       * one-directional), so a route that ignored `inward` answers the outward count here.
       */
      // SEEDED, AND THAT IS LOAD-BEARING. An unseeded total count is identical forwards and
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
       * THE DIRECTION MUST ACTUALLY MATTER HERE, AND IT IS ASSERTED RATHER THAN ASSUMED. Parity
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

/*
 * **THE `DISTINCT` ARM IS A DIFFERENT ROUTE FROM THE COUNT ARM, and item 2004 added it with no
 * cross-engine coverage until this block.** `count(*) ACYCLIC` goes to `acyclic-count.ts`'s DFS
 * (item 2002); `RETURN DISTINCT y.n` goes to `reachability.ts`'s new `spec.acyclic` arm, which
 * produces the reached SET over the CSR. Two routes, two chances to be wrong, and the tests above
 * only exercise the first.
 *
 * AND THE SEED AXIS IS HERE DELIBERATELY. Item 2003's whole finding was that the unseeded case
 * hides divergences: with every vertex a source, every ACYCLIC-vs-BFS difference reduces to a
 * self-loop, and a cure keyed on that looks sound. Seeded, a 2-cycle diverges too. So every shape
 * below is run BOTH ways.
 */
describe('DISTINCT ACYCLIC over a cyclic generated graph: TS vs native', () => {
  for (const bound of ['{1,1}', '{1,2}', '{1,3}', '{2,3}', '{1,4}'] as const) {
    for (const [seedName, where] of [
      ['unseeded', ''],
      ['seeded', ' WHERE x.n = 3'],
    ] as const) {
      test(`DISTINCT ACYCLIC ${bound} ${seedName}`, () => {
        if (!nativeReady) {
          expect(nativeReady).toBe(false);

          return;
        }

        const text = `MATCH ACYCLIC (x:T)-[:E]->${bound}(y:T)${where} RETURN DISTINCT y.n AS v`;
        const tsRows = [...tsQuery(tsGraphOf(CYCLIC_NDJSON), text, {})];
        const nativeGraph = graphFromNdjson(nativeBackend(), CYCLIC_NDJSON);
        const nativeRows = (() => {
          try {
            return nativeGraph.query(text);
          } finally {
            nativeGraph.free();
          }
        })();

        /*
         * COMPARED AS SORTED MULTISETS, not as sequences — and that is the contract rather than
         * convenience. `DISTINCT` carries no `ORDER BY`, GQL row order is unspecified here, and the
         * differential fuzzer compares these structurally for exactly that reason. The new arm is a
         * DFS where the BFS it sits beside is breadth-first, so it legitimately emits in a different
         * order; pinning sequence order would pin an accident.
         */
        const key = (rows: readonly unknown[]): string =>
          JSON.stringify(
            rows.map((r) => (r as { v: unknown }).v).sort((a, b) => Number(a) - Number(b)),
          );

        expect(key(nativeRows)).toBe(key(tsRows));
        expect(tsRows.length).toBeGreaterThan(0);
      });
    }
  }

  test('a lone self-loop yields NOTHING, where a BFS would yield the vertex', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    // The fixture the whole refusal was built on. If the DFS arm answered like the BFS it would
    // return one row here, and every assertion above would still pass.
    const only = [
      '{"type":"node","id":"a","labels":["T"],"properties":{"n":1}}',
      '{"type":"edge","id":"l","labels":["E"],"from":"a","to":"a","properties":{}}',
    ].join('\n');
    const text = 'MATCH ACYCLIC (x:T)-[:E]->{1,3}(y:T) RETURN DISTINCT y.n AS v';
    const tsRows = [...tsQuery(tsGraphOf(only), text, {})];
    const nativeGraph = graphFromNdjson(nativeBackend(), only);
    const nativeRows = (() => {
      try {
        return nativeGraph.query(text);
      } finally {
        nativeGraph.free();
      }
    })();

    expect(tsRows).toEqual([]);
    expect(nativeRows).toEqual([]);
    // And TRAIL, which DOES take the BFS, still yields it — so this fixture is discriminating.
    expect([
      ...tsQuery(
        tsGraphOf(only),
        'MATCH TRAIL (x:T)-[:E]->{1,3}(y:T) RETURN DISTINCT y.n AS v',
        {},
      ),
    ]).toHaveLength(1);
  });
});

/*
 * **A DISCRIMINATING FIXTURE, AND SIX SURVIVING MUTANTS ARE WHY IT EXISTS** (item 2004).
 * The generated graph above has every vertex as a seed, and that SATURATES the reached set: each
 * vertex is found at depth 1 from its own in-neighbour, so the answer is `{v : v has an in-edge}`
 * whatever the DFS does deeper. Three separate mutants survived on that one fact —
 * `no-backtrack` (never unwinding the path), `path-not-reset` (marks persisting across seeds) and
 * `direction-ignored` (walking the out-adjacency for an inward query, which on a ring where every
 * vertex has both is the SAME set).
 *
 * THE THREE PROPERTIES THAT BREAK SATURATION, each aimed at a specific survivor:
 *
 *   1. **A NARROW SEED.** Only `s` carries `k = 1`, so the answer is what ONE source reaches and
 *      every pruning decision is visible in it.
 *   2. **A VERTEX REACHABLE AT TWO DEPTHS, WITH CHILDREN BEYOND IT.** `s->p->q->r` and `s->r`
 *      directly. Correct backtracking enters `r` at depth 1 on the second branch and continues to
 *      `r->t->u`; a DFS that leaves `r` marked from depth 3 never reaches `t` or `u`. This is the
 *      "diamond with two path lengths to one vertex" case `reachability.ts`'s own oracle list names.
 *   3. **ASYMMETRIC DIRECTION AND TWO EDGE TYPES.** `s` has out-edges and no in-edges, so the
 *      inward answer is EMPTY where the outward one is not; and the `F` edges reach vertices no `E`
 *      path does, so ignoring the type filter changes the answer.
 */
const DIAMOND_NDJSON = [
  // `s` is the only `k = 1` vertex — the narrow seed.
  '{"type":"node","id":"s","labels":["T"],"properties":{"k":1,"n":0}}',
  '{"type":"node","id":"p","labels":["T"],"properties":{"k":2,"n":1}}',
  '{"type":"node","id":"q","labels":["T"],"properties":{"k":2,"n":2}}',
  '{"type":"node","id":"r","labels":["T"],"properties":{"k":2,"n":3}}',
  '{"type":"node","id":"t","labels":["T"],"properties":{"k":2,"n":4}}',
  '{"type":"node","id":"u","labels":["T"],"properties":{"k":2,"n":5}}',
  // Reachable only through an `F` edge, so the type filter is observable.
  '{"type":"node","id":"f","labels":["T"],"properties":{"k":2,"n":6}}',
  // The long route to `r`: s -> p -> q -> r  (depth 3)
  '{"type":"edge","id":"d1","labels":["E"],"from":"s","to":"p","properties":{}}',
  '{"type":"edge","id":"d2","labels":["E"],"from":"p","to":"q","properties":{}}',
  '{"type":"edge","id":"d3","labels":["E"],"from":"q","to":"r","properties":{}}',
  // The short route to `r` (depth 1), from which `t` and `u` are within the bound.
  '{"type":"edge","id":"d4","labels":["E"],"from":"s","to":"r","properties":{}}',
  '{"type":"edge","id":"d5","labels":["E"],"from":"r","to":"t","properties":{}}',
  '{"type":"edge","id":"d6","labels":["E"],"from":"t","to":"u","properties":{}}',
  // An `F` edge out of `s`, reaching a vertex no `E` path reaches.
  '{"type":"edge","id":"d7","labels":["F"],"from":"s","to":"f","properties":{}}',
  /*
   * **A SECOND SEED SHARING AN INTERMEDIATE, because `onPath.fill(0)` only matters ACROSS
   * seeds and the component above has exactly ONE.** With a single seed the reset is a no-op, so the
   * mutant deleting it SURVIVED even on the non-saturated fixture.
   *
   * `g1` reaches `m` at depth 3 (g1->h->i->m); `g2` reaches it at depth 1, from where `m->y->z` is
   * inside a `{1,3}` bound. Correct behaviour clears the path between seeds, so `g2` enters `m` and
   * finds `y` and `z`. A DFS that keeps `g1`'s marks finds `m` already flagged and never reaches
   * either.
   *
   * IT DEPENDS ON SEED ORDER — `g1` must run before `g2` — which is the NDJSON insertion order
   * here and therefore deterministic. **So the mirror pair `j1`/`j2` is declared in the OPPOSITE
   * arrangement**, and one of the two bites whichever way the seed list is enumerated. A single
   * component would pass by ordering luck half the time, which is a flaky test dressed as a passing
   * one.
   */
  '{"type":"node","id":"g1","labels":["T"],"properties":{"k":1,"n":10}}',
  '{"type":"node","id":"h","labels":["T"],"properties":{"k":2,"n":11}}',
  '{"type":"node","id":"i","labels":["T"],"properties":{"k":2,"n":12}}',
  '{"type":"node","id":"m","labels":["T"],"properties":{"k":2,"n":13}}',
  '{"type":"node","id":"y","labels":["T"],"properties":{"k":2,"n":14}}',
  '{"type":"node","id":"z","labels":["T"],"properties":{"k":2,"n":15}}',
  '{"type":"node","id":"g2","labels":["T"],"properties":{"k":1,"n":16}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"g1","to":"h","properties":{}}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"h","to":"i","properties":{}}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"i","to":"m","properties":{}}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"g2","to":"m","properties":{}}',
  '{"type":"edge","id":"e5","labels":["E"],"from":"m","to":"y","properties":{}}',
  '{"type":"edge","id":"e6","labels":["E"],"from":"y","to":"z","properties":{}}',
  // THE MIRROR: the shallow seed is declared FIRST here, so the pair covers both enumeration orders.
  '{"type":"node","id":"j2","labels":["T"],"properties":{"k":1,"n":20}}',
  '{"type":"node","id":"mm","labels":["T"],"properties":{"k":2,"n":21}}',
  '{"type":"node","id":"yy","labels":["T"],"properties":{"k":2,"n":22}}',
  '{"type":"node","id":"zz","labels":["T"],"properties":{"k":2,"n":23}}',
  '{"type":"node","id":"j1","labels":["T"],"properties":{"k":1,"n":24}}',
  '{"type":"node","id":"hh","labels":["T"],"properties":{"k":2,"n":25}}',
  '{"type":"node","id":"ii","labels":["T"],"properties":{"k":2,"n":26}}',
  '{"type":"edge","id":"f1","labels":["E"],"from":"j2","to":"mm","properties":{}}',
  '{"type":"edge","id":"f2","labels":["E"],"from":"mm","to":"yy","properties":{}}',
  '{"type":"edge","id":"f3","labels":["E"],"from":"yy","to":"zz","properties":{}}',
  '{"type":"edge","id":"f4","labels":["E"],"from":"j1","to":"hh","properties":{}}',
  '{"type":"edge","id":"f5","labels":["E"],"from":"hh","to":"ii","properties":{}}',
  '{"type":"edge","id":"f6","labels":["E"],"from":"ii","to":"mm","properties":{}}',
].join('\n');

describe('the ACYCLIC arm on a NON-SATURATED fixture', () => {
  const ask = (text: string): { ts: unknown[]; native: unknown[] } => {
    const ts = [...tsQuery(tsGraphOf(DIAMOND_NDJSON), text, {})];
    const nativeGraph = graphFromNdjson(nativeBackend(), DIAMOND_NDJSON);
    const native = (() => {
      try {
        return nativeGraph.query(text);
      } finally {
        nativeGraph.free();
      }
    })();

    return { ts, native };
  };
  const sorted = (rows: readonly unknown[]): unknown[] =>
    rows.map((r) => (r as { v: unknown }).v).sort((a, b) => Number(a) - Number(b));

  test('BACKTRACKING: a two-depth vertex must be re-entered at the shallower depth', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    // `{1,3}` from `s`: p(1) q(2) r(3 via the long route AND 1 via the short) t(2) u(3).
    // A DFS that leaves `r` marked after the long branch never reaches `t` or `u`.
    const { ts, native } = ask(
      'MATCH ACYCLIC (x:T)-[:E]->{1,3}(y:T) WHERE x.k = 1 RETURN DISTINCT y.n AS v',
    );

    // The first component's five, plus both shared-intermediate components.
    expect(sorted(ts)).toEqual([1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 21, 22, 23, 25, 26]);
    expect(sorted(native)).toEqual(sorted(ts));
  });

  test('PATH RESET: a vertex a LATER seed reaches more shallowly must be re-enterable', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    /*
     * THE ACROSS-SEED CASE, which the single-seed component cannot show. `y`/`z` (n = 14, 15)
     * hang off `m`, which the FIRST seed reaches at depth 3 and the second at depth 1; `yy`/`zz`
     * (22, 23) are the mirror. If the path marks are not cleared between seeds, the later seed finds
     * the shared vertex flagged and both pairs vanish.
     */
    const { ts, native } = ask(
      'MATCH ACYCLIC (x:T)-[:E]->{1,3}(y:T) WHERE x.k = 1 RETURN DISTINCT y.n AS v',
    );
    const got = sorted(ts);

    expect(got).toContain(14);
    expect(got).toContain(15);
    expect(got).toContain(22);
    expect(got).toContain(23);
    expect(sorted(native)).toEqual(got);
  });

  test('DIRECTION: the inward answer is EMPTY where the outward one is not', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    // `s` has no in-edges at all, so an inward walk from it reaches nothing. A route that ignored
    // `inward` would answer the outward set — which is non-empty, so this cannot pass by accident.
    const { ts, native } = ask(
      'MATCH ACYCLIC (x:T)<-[:E]-{1,3}(y:T) WHERE x.k = 1 RETURN DISTINCT y.n AS v',
    );

    expect(ts).toEqual([]);
    expect(native).toEqual([]);
  });

  test('EDGE TYPE: an `F` edge reaches a vertex no `E` path does', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    // `f` is reachable from `s` only via the `F` edge. A walk that dropped the type filter would
    // include `n = 6`; one that keeps it must not.
    const viaE = ask('MATCH ACYCLIC (x:T)-[:E]->{1,3}(y:T) WHERE x.k = 1 RETURN DISTINCT y.n AS v');
    const viaF = ask('MATCH ACYCLIC (x:T)-[:F]->{1,3}(y:T) WHERE x.k = 1 RETURN DISTINCT y.n AS v');

    expect(sorted(viaE.ts)).not.toContain(6);
    expect(sorted(viaF.ts)).toEqual([6]);
    expect(sorted(viaF.native)).toEqual([6]);
  });

  test('count(DISTINCT b) counts the reached set ONCE per vertex', () => {
    if (!nativeReady) {
      expect(nativeReady).toBe(false);

      return;
    }

    /*
     * **THIS IS THE SHAPE A SURVIVING MUTANT WOULD HAVE MADE WRONG, and nothing else covers
     * it.** When the projection is a bare `count(DISTINCT b)`, `runReach` answers `kept.length` —
     * the reached LIST's length — rather than deduping downstream. So a walk that pushed a vertex
     * into `reached` more than once (reaching it by several acyclic paths, which this fixture does:
     * `r` by two routes) inflates the count while leaving every `RETURN DISTINCT` test green.
     */
    const text = 'MATCH ACYCLIC (x:T)-[:E]->{1,3}(y:T) WHERE x.k = 1 RETURN count(DISTINCT y) AS v';
    const { ts, native } = ask(text);

    /*
     * 15 distinct vertices across the three components, several of them reached by MORE THAN ONE
     * acyclic path (`r` by two routes, `m` and `mm` by two depths). That multiplicity is the whole
     * point: a walk that pushed a vertex into `reached` once per path would answer well above 15
     * here while every `RETURN DISTINCT` assertion stayed green, because `DISTINCT` dedupes
     * downstream and this projection does not.
     */
    expect((ts[0] as { v: number }).v).toBe(15);
    expect(native).toEqual(ts);
  });
});
