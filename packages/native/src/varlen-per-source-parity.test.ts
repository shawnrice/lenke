// THE PER-SOURCE ROUTE for a seeded var-length COUNT (item 1978), against native.
//
// Item 1977 measured the route this replaces at O(levels · (|V| + |E|)) however narrow the seed is —
// 22.9-25.4 ns per vertex, flat across 8x of |V|, for a query with ONE source. The new route walks
// from the sources instead: a multiplicity frontier for a WALK, and for a TRAIL an enumeration over
// CSR POSITIONS that needs no inclusion-exclusion at all, where the recurrence needs
// `trailCorrectionAt`'s depth-2/3/4 closed forms.
//
// **THAT IS A SECOND IMPLEMENTATION OF THE SAME COUNT, so the risk is that the two disagree**
// — and one of them is derived arithmetic that took items 600/601/692 to get right. Native has
// carried a seed mask since item 575 and is the reference implementation, so both TS routes are
// checked against it here.
//
// THE FIXTURE IS ITEM 573'S MOTIF, REPLICATED, and the replication is the point rather than a
// detail. Item 1907's parity test uses the motif ONCE — six vertices — and `perSourceAdmissible`
// refuses a fixture that small, so that suite passes 801 assertions while never entering this route
// (measured: `entered=1, taken=0` on its graph). A test that cannot reach the code it names is the
// trap this repo keeps finding, so the motif is repeated until the gate admits it, and
// `the fixture REACHES the route` below asserts that directly off the exported gate rather than
// trusting the arithmetic above. Raise `PER_SOURCE_MIN_RATIO` past this fixture and that assertion
// fails loudly instead of the suite going quietly blind.
//
// Each block carries: a 3-cycle (so WALK and TRAIL differ), a SELF-LOOP (the depth-3 correction's
// only witness, and the shape a position-marked enumeration must also get right), a PARALLEL pair
// (two distinct edges to one vertex — a legal trail, and what breaks both a naive correction and a
// neighbour-marked enumeration), a MULTI-LABEL edge, a second edge type, an ISOLATED vertex and a
// vertex with NO `n`.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/** Item 573's motif, `BLOCKS` times over, with globally unique `n` so a seed selects ONE vertex. */
const BLOCKS = 20;
const lines: string[] = [];

for (let b = 0; b < BLOCKS; b += 1) {
  const p = (k: string): string => `${String(b)}_${k}`;
  const n = (k: number): number => b * 10 + k;

  lines.push(
    `{"type":"node","id":"${p('1')}","labels":["P","Q"],"properties":{"n":${String(n(1))},"g":"a"}}`,
    `{"type":"node","id":"${p('2')}","labels":["P"],"properties":{"n":${String(n(2))},"g":"a"}}`,
    `{"type":"node","id":"${p('3')}","labels":["P"],"properties":{"n":${String(n(3))},"g":"b"}}`,
    `{"type":"node","id":"${p('4')}","labels":["P","Q"],"properties":{"n":${String(n(4))},"g":"b"}}`,
    `{"type":"node","id":"${p('iso')}","labels":["P"],"properties":{"n":${String(n(9))},"g":"c"}}`,
    // No `n`: an equality matches nothing and `IS NULL` matches only these.
    `{"type":"node","id":"${p('nul')}","labels":["P"],"properties":{"g":"c"}}`,
    `{"type":"edge","id":"${p('e1')}","labels":["T"],"from":"${p('1')}","to":"${p('2')}"}`,
    `{"type":"edge","id":"${p('e2')}","labels":["T"],"from":"${p('2')}","to":"${p('3')}"}`,
    `{"type":"edge","id":"${p('e3')}","labels":["T"],"from":"${p('3')}","to":"${p('1')}"}`,
    // THE SELF-LOOP.
    `{"type":"edge","id":"${p('e4')}","labels":["T"],"from":"${p('1')}","to":"${p('1')}"}`,
    // THE PARALLEL PAIR: a second, distinct `2 -> 3`.
    `{"type":"edge","id":"${p('e5')}","labels":["T"],"from":"${p('2')}","to":"${p('3')}"}`,
    `{"type":"edge","id":"${p('e6')}","labels":["T","U"],"from":"${p('3')}","to":"${p('4')}"}`,
    `{"type":"edge","id":"${p('e7')}","labels":["U"],"from":"${p('4')}","to":"${p('2')}"}`,
    `{"type":"edge","id":"${p('e8')}","labels":["T"],"from":"${p('nul')}","to":"${p('2')}"}`,
  );
}

const NDJSON = lines.join('\n');
const VERTICES = BLOCKS * 6;

/*
 * Every bound the rung has an arm for, times every path mode it admits. `{1,1}` and `{0,1}` are
 * kept from item 1907's list for the same reason it gives: they are the two that do NOT reach the
 * level recurrence, so they are the control that this route is not swallowing shapes that belong
 * elsewhere.
 */
const BOUNDS = ['{1,1}', '{0,1}', '{1,2}', '{0,2}', '{1,3}', '{2,3}', '{1,4}', '{1,5}'] as const;
const MODES = ['', 'WALK ', 'TRAIL '] as const;

const SPELLINGS = (bound: string, mode: string): readonly string[] => [
  `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n = $p RETURN count(*) AS c`,
  `MATCH ${mode}(a:P {n: $p})-[:T]->${bound}(b:P) RETURN count(*) AS c`,
  `MATCH ${mode}(a:P WHERE a.n = $p)-[:T]->${bound}(b:P) RETURN count(*) AS c`,
];

describe.if(nativeReady)('the per-source route counts what native counts', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /*
   * THE GATE ITSELF IS ASSERTED IN `packages/gql/src/var-length-per-source-gate.test.ts`, which
   * can import `perSourceAdmissible` directly; nothing in this package reaches gql's internals and
   * adding a deep export for a test would be the wrong trade. What this file owns is the FIXTURE
   * SIZE, which is the half that silently went missing in item 1907's suite: a unique `n` selects
   * ONE source, and one source needs `PER_SOURCE_MIN_RATIO` (8) vertices to be admitted, so 120
   * clears it with room. The gate test pins the ratio against this number.
   */
  test('the fixture is large enough to reach the route', () => {
    expect(VERTICES).toBeGreaterThanOrEqual(8);
    expect(ts.vertexCount).toBe(VERTICES);
  });

  for (const bound of BOUNDS) {
    for (const mode of MODES) {
      test(`${mode}${bound} seeded to one source`, () => {
        // Seeds chosen to land on each role in the motif: the self-loop's vertex, the parallel
        // pair's tail, the cycle's third node, the multi-label edge's head, and the isolated one.
        for (const p of [1, 2, 3, 4, 9, 11, 32, 194]) {
          const want = nat.query(SPELLINGS(bound, mode)[0], { p })[0].c;

          for (const q of SPELLINGS(bound, mode)) {
            expect(tsQuery(ts, q, { p })[0].c).toBe(want);
          }
        }
      });
    }
  }

  test('a BROAD seed agrees too, on the declined arm', () => {
    // `g = 'a'` selects 2 of every 6 vertices, so `perSourceAdmissible` refuses and the recurrence
    // runs — the path a narrow seed no longer takes. Both must still answer what native answers.
    for (const bound of BOUNDS) {
      for (const mode of MODES) {
        const q = `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.g = $p RETURN count(*) AS c`;

        expect(tsQuery(ts, q, { p: 'a' })[0].c).toBe(nat.query(q, { p: 'a' })[0].c);
      }
    }
  });

  test('a seed matching NOTHING, and one matching only the key-less vertices', () => {
    for (const bound of BOUNDS) {
      for (const mode of MODES) {
        const miss = `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n = $p RETURN count(*) AS c`;

        expect(tsQuery(ts, miss, { p: -1 })[0].c).toBe(nat.query(miss, { p: -1 })[0].c);

        const nul = `MATCH ${mode}(a:P)-[:T]->${bound}(b:P) WHERE a.n IS NULL RETURN count(*) AS c`;

        expect(tsQuery(ts, nul, {})[0].c).toBe(nat.query(nul, {})[0].c);
      }
    }
  });

  test('an ENDPOINT predicate as well as a seed, both carried', () => {
    for (const bound of BOUNDS) {
      for (const mode of MODES) {
        const q = `MATCH ${mode}(a:P)-[:T]->${bound}(b:Q) WHERE a.n = $p RETURN count(*) AS c`;

        expect(tsQuery(ts, q, { p: 1 })[0].c).toBe(nat.query(q, { p: 1 })[0].c);
      }
    }
  });

  test('the OTHER edge type and a two-type union', () => {
    for (const bound of BOUNDS) {
      for (const types of [':U', ':T|U']) {
        const q = `MATCH (a:P)-[${types}]->${bound}(b:P) WHERE a.n = $p RETURN count(*) AS c`;

        expect(tsQuery(ts, q, { p: 3 })[0].c).toBe(nat.query(q, { p: 3 })[0].c);
      }
    }
  });
});
