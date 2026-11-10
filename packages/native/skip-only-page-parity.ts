import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

/**
 * DO THE TWO ENGINES AGREE, POSITIONALLY, ON AN UNORDERED SKIP-ONLY PAGE? (item 1776)
 *
 * ⚠️ WRITTEN BECAUSE `bun run fuzz` GREEN SAYS NOTHING ABOUT THIS SHAPE. Every page the
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
    `${name.padEnd(18)} unpaged ${ctl.padEnd(26)} paged ${pg.padEnd(26)}${broken ? '  ⚠️ PAGE BREAKS AN AGREEING SHAPE' : ''}`,
  );
}

console.log(
  broke === 0
    ? '\nno page breaks an agreeing unpaged shape.'
    : `\n${broke} page(s) break an agreeing unpaged shape — a cross-engine divergence.`,
);
process.exit(broke === 0 ? 0 : 1);
