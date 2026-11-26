import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

/**
 * DO THE TWO ENGINES AGREE, POSITIONALLY, ON AN UNORDERED SKIP-ONLY PAGE? (item 1776)
 *
 * WRITTEN BECAUSE `bun run fuzz` GREEN SAYS NOTHING ABOUT THIS SHAPE. Every page the
 * differential fuzzer generates rides an `ORDER BY` — `… ORDER BY t SKIP n LIMIT m` from its paged
 * arm, and the statement-position `ORDER BY … OFFSET 1` from the next — so an UNORDERED
 * `RETURN n.k OFFSET k` is outside its corpus entirely. The same blind spot as
 * [[fuzzer-blind-to-one-column-group]], found the same way: by reading the generator rather than
 * trusting the suite.
 *
 * It matters because item 1776 gave that shape to the node-projection rung, and a skip is NOT
 * order-invariant the way a projection is: skipping the first k rows of two different visit orders
 * yields different MULTISETS, so [[order-is-unspecified]] does not cover it. Byte-identity between
 * the engines is the hard invariant, and this is the only instrument that reads it for this shape.
 *
 * WHAT A FAILURE HERE WOULD AND WOULD NOT MEAN. Item 1776's own claim is narrower than parity: the
 * rung returns what the TS GENERAL PATH returns, positionally, which `skip-only-page.test.ts` pins
 * against the parameterized spelling. So a divergence reported here is a PRE-EXISTING cross-engine
 * fact about unordered paging, not something the rung introduced — but it is a fact worth having on
 * record rather than assumed either way, and the `unpaged` control is what separates the two: if
 * the engines already disagree on the UNPAGED projection's order, then nothing about the page can
 * be expected to agree.
 *
 *     cd packages/native && bun skip-only-page-parity.ts
 *
 * Exits non-zero on a positional mismatch in any PAGED row whose unpaged control agrees, so it is
 * an oracle rather than a print — the failure mode item 1775 found in `hop-distinct-route-probe.mjs`
 * was a probe nobody could run, and a probe nobody reads the output of is the same thing twice.
 */
import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = Number(process.env.NODES ?? 24);
const lines: string[] = [];

for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'node',
      id: `v${i}`,
      labels: ['T'],
      // `k` repeats every 5, so a POSITIONAL disagreement is visible where a value-wise one is not.
      properties: { k: i % 5, n: 100 - i },
    }),
  );
}

// `(i * 7 + 3) % NODES` with one edge per vertex: `7` is coprime with 24, so the endpoints are a
// permutation rather than the single collapsed target an `(a * k + b) % N` generator produces at
// any higher fanout (the LCG defect, items 1516/1518). Asserted below rather than argued.
for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'edge',
      id: `e${i}`,
      from: `v${i}`,
      to: `v${(i * 7 + 3) % NODES}`,
      labels: ['E'],
    }),
  );
}

const distinctEnds = new Set(Array.from({ length: NODES }, (_, i) => (i * 7 + 3) % NODES)).size;

if (distinctEnds !== NODES) {
  console.error(`fixture: ${distinctEnds} distinct endpoints for ${NODES} edges — degenerate`);
  process.exit(1);
}

const NDJSON = lines.join('\n');
const backend = nativeBackend();
const nativeGraph = graphFromNdjson(backend, NDJSON);
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

/** `[name, the UNPAGED control, the PAGED query]`. The control is what makes the page readable. */
const CASES: ReadonlyArray<readonly [string, string, string]> = [
  [
    'node proj',
    'MATCH (n:T) RETURN n.k AS k',
    `MATCH (n:T) RETURN n.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'node proj 2col',
    'MATCH (n:T) RETURN n.k AS k, n.n AS t',
    `MATCH (n:T) RETURN n.k AS k, n.n AS t OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'node proj + WHERE',
    'MATCH (n:T) WHERE n.n > 90 RETURN n.k AS k',
    'MATCH (n:T) WHERE n.n > 90 RETURN n.k AS k OFFSET 3',
  ],
  // The hop rows are CONTROLS for item 1776, which did not give them the page: `hop FAR` is the
  // row `offset-order-equiv.mjs` found differing from the TS general path at index 0.
  [
    'hop proj FAR',
    'MATCH (a:T)-[:E]->(b) RETURN b.k AS k',
    `MATCH (a:T)-[:E]->(b) RETURN b.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'hop proj START',
    'MATCH (a:T)-[:E]->(b) RETURN a.k AS k',
    `MATCH (a:T)-[:E]->(b) RETURN a.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  /**
   * DEPTHS 2-5, ADDED AT ITEM 1885, AND THE CONTROL IS THE LOAD-BEARING HALF HERE. Those depths
   * are served UNPAGED by `hop2Projection` and `chainProjection`, both of which decline outright
   * once any window is present (read off `compileLinear` — `skip-chain-route-1885.mjs`), so the
   * paged spelling costs 26.9-59.5 ms against a ~6 ms `rows` twin on `rung-gap-screen.mjs`.
   *
   * The control therefore asks the question a fix depends on: an IDENTICAL unpaged verdict at depth
   * k means the RUNG's row order already equals native's at depth k — because the unpaged query IS
   * the rung. Slicing the rung's rows is then answer-equivalent to slicing native's, which is a
   * CONSTRUCTIVE argument rather than an observation over cases.
   */
  [
    'chain d2 FAR',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c) RETURN c.k AS k',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c) RETURN c.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'chain d2 START',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c) RETURN a.k AS k',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c) RETURN a.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'chain d3 FAR',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN d.k AS k',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN d.k AS k OFFSET ${Math.floor(NODES / 3)}`,
  ],
  [
    'chain d3 2col',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN a.k AS k, d.n AS t',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN a.k AS k, d.n AS t OFFSET 5`,
  ],
  [
    'chain d4 FAR',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(f) RETURN f.k AS k',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(f) RETURN f.k AS k OFFSET 7`,
  ],
  [
    'chain d5 FAR',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(f)-[:E]->(h) RETURN h.k AS k',
    `MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(f)-[:E]->(h) RETURN h.k AS k OFFSET 7`,
  ],
  [
    'chain d3 interior',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN b.k AS k',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN b.k AS k OFFSET 7',
  ],
];

const rowsOf = (engine: 'ts' | 'native', q: string): string =>
  JSON.stringify(engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q));

/** The rows as a SORTED multiset key, so "different order" can be told from "different rows". */
const sortedKey = (j: string): string =>
  JSON.stringify((JSON.parse(j) as unknown[]).map((r) => JSON.stringify(r)).sort());

const verdict = (
  ts: string,
  nat: string,
): 'IDENTICAL' | 'SAME SET, DIFFERENT ORDER' | 'DIFFERENT ROWS' => {
  if (ts === nat) {
    return 'IDENTICAL';
  }

  return sortedKey(ts) === sortedKey(nat) ? 'SAME SET, DIFFERENT ORDER' : 'DIFFERENT ROWS';
};

let broke = 0;

for (const [name, control, paged] of CASES) {
  const ctl = verdict(rowsOf('ts', control), rowsOf('native', control));
  const pg = verdict(rowsOf('ts', paged), rowsOf('native', paged));
  // Only a page that disagrees UNDER AN AGREEING CONTROL is a finding: where the unpaged orders
  // already differ, the page cannot be expected to agree and says nothing new.
  const broken = ctl === 'IDENTICAL' && pg !== 'IDENTICAL';

  if (broken) {
    broke += 1;
  }

  console.log(
    `${name.padEnd(18)} unpaged ${ctl.padEnd(26)} paged ${pg.padEnd(26)}${broken ? '  PAGE BREAKS AN AGREEING SHAPE' : ''}`,
  );
}

/**
 * THE SECOND SECTION, ADDED AT ITEM 1885: IS EACH ENGINE'S PAGED ANSWER ITS OWN UNPAGED ANSWER
 * SLICED? That is the OTHER half of the licence to slice a rung's rows, and it is not implied by
 * the first section. Section one says the two engines agree about the paged answer; this one says
 * the paged answer is positionally the unpaged walk minus its first k rows, in each engine
 * separately — which is what makes "let the rung fire and slice" the same computation rather than a
 * coincidence on this fixture.
 */
const offsetOf = (paged: string): number => Number(/OFFSET (\d+)/.exec(paged)?.[1] ?? '0');

/**
 * ONE DOCUMENTED EXCEPTION, AND IT IS A FEATURE. `hop proj FAR` paged is deliberately NOT its own
 * unpaged answer sliced in TS: item 1777 forces the START-DRIVEN walk whenever the page is
 * non-zero, because that walk's order is the general path's, where the UNPAGED shape may take the
 * far-driven walk whose order is intentionally different. `offset-order-equiv.mjs`'s SELF section
 * records the same thing. So this name is exempt WITH its reason, rather than the check being
 * loosened for everyone.
 */
const SLICE_EXEMPT = new Set(['hop proj FAR']);

console.log("\n# is each engine's PAGED answer its own UNPAGED answer, sliced?");

let sliceBroke = 0;

for (const [name, control, paged] of CASES) {
  const off = offsetOf(paged);
  const slice = (j: string): string => JSON.stringify((JSON.parse(j) as unknown[]).slice(off));
  const tsOk = slice(rowsOf('ts', control)) === rowsOf('ts', paged);
  const natOk = slice(rowsOf('native', control)) === rowsOf('native', paged);

  const exempt = SLICE_EXEMPT.has(name);

  if ((!tsOk || !natOk) && !exempt) {
    sliceBroke += 1;
  }

  const note = exempt ? '   (EXEMPT — item 1777 forces the start-driven walk when paged)' : '';

  console.log(
    `${name.padEnd(18)} OFFSET ${String(off).padStart(3)}   ts ${tsOk ? 'sliced' : 'NOT sliced'}   native ${natOk ? 'sliced' : 'NOT sliced'}${note}`,
  );
}

console.log(
  broke === 0
    ? '\nno page breaks an agreeing unpaged shape.'
    : `\n${broke} page(s) break an agreeing unpaged shape — a cross-engine divergence.`,
);
console.log(
  sliceBroke === 0
    ? 'every paged answer IS its own unpaged answer sliced, in both engines.'
    : `${sliceBroke} case(s) where a paged answer is NOT its own unpaged answer sliced.`,
);
process.exit(broke === 0 && sliceBroke === 0 ? 0 : 1);
