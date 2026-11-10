import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

/**
 * DO THE TWO ENGINES STILL AGREE ON A FILTERED HOP PROJECTION, now that TS far-drives it? (1781)
 *
 * ⚠️ WRITTEN BECAUSE `bun run fuzz` GREEN SAYS NOTHING ABOUT THIS SHAPE, and the counter that looks
 * like it does is for a different one. The differential fuzzer reports `hopFilter=172/156`, which
 * reads like coverage of exactly this family — but its test is
 *
 *     /^MATCH \([ab]?[^()]*\)[-<]/.test(q) && q.includes(' WHERE ') && q.includes('count(*)')
 *
 * so it counts the filtered COUNT ladder, not a yielding projection. `groupHopPred` is the GROUPED
 * form. A plain `MATCH (a:L)-[:E]->(b:L) WHERE <far pred> RETURN b.k` — the shape item 1781 gave a
 * new walk — is not what either counter tallies. Same blind spot as [[fuzzer-blind-to-one-column-group]]
 * and as item 1776's unordered page, found the same way: by reading the generator rather than
 * trusting a green suite. Two items apart, in a counter that was ALREADY being read as coverage.
 *
 * ⚠️ THE ORACLE IS THE MULTISET, NOT THE POSITION, and that is the difference from
 * `skip-only-page-parity.ts`. Item 1781 changes the far-driven walk's visit order deliberately, and
 * for an UNORDERED GQL projection row order is unspecified ([[order-is-unspecified]], a settled
 * won't-fix) — which is exactly why the change is legal on the GQL side and is NOT available to
 * Gremlin, whose stream order is a TinkerPop contract its own fuzzer compares ordered
 * (`far-filtered-hop-values.test.ts` records that, and prices the route it cannot take at 3-4x).
 * So a positional difference here is licensed; a MULTISET difference is a wrong answer.
 *
 * Each admitted shape is read against a DECLINED control — the same question with a start-reading
 * conjunct, which keeps the start-driven route — so a disagreement can be attributed. If a control
 * disagrees too, the finding is not about this item's route.
 *
 *     cd packages/native && bun far-driven-predicated-parity.ts
 *
 * Exits non-zero on any multiset mismatch, so it is an oracle rather than a print.
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
      // ONE label on every vertex, so the start label is VACUOUS and the far-driven arm is
      // eligible at all. Item 1777's mutant survived against a fixture with a stray second label
      // for exactly this reason: a fixture that cannot reach the branch proves nothing about it.
      labels: ['T'],
      // `k` repeats every 5 so an equality is SELECTIVE (the bucket-skipping half of the win), and
      // `n` is distinct so a multiset difference of one row is visible.
      properties: { k: i % 5, n: i, s: `s${i}` },
    }),
  );
}

// `(i * 7 + 3) % NODES`, one edge per vertex: 7 is coprime with 24, so the endpoints are a
// permutation rather than the single collapsed target an `(a * k + b) % N` generator gives at any
// higher fanout (the LCG defect, items 1516/1518). Asserted below rather than argued.
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

/**
 * `[name, the ADMITTED query, a DECLINED control asking a comparable question]`.
 *
 * The control carries a start-reading conjunct that cannot change the answer (`a.n > -1` passes
 * every start vertex), so it asks the same question down the start-driven route. That is what lets
 * a disagreement be attributed to this item rather than to the hop family generally.
 */
const CASES: ReadonlyArray<readonly [string, string, string]> = [
  [
    'ordering cmp',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > 5 RETURN b.k AS k',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > 5 AND a.n > -1 RETURN b.k AS k',
  ],
  [
    'all-pass cmp',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > -1 RETURN b.k AS k',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > -1 AND a.n > -1 RETURN b.k AS k',
  ],
  [
    'selective eq',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k = 2 RETURN b.n AS n',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k = 2 AND a.n > -1 RETURN b.n AS n',
  ],
  [
    'inequality',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k <> 2 RETURN b.n AS n',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k <> 2 AND a.n > -1 RETURN b.n AS n',
  ],
  [
    'IS NOT NULL',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k IS NOT NULL RETURN b.n AS n',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k IS NOT NULL AND a.n > -1 RETURN b.n AS n',
  ],
  [
    'conjunction',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k < 3 AND b.n > 4 RETURN b.n AS n',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k < 3 AND b.n > 4 AND a.n > -1 RETURN b.n AS n',
  ],
  [
    'two columns',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > 5 RETURN b.k AS k, b.s AS s',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.n > 5 AND a.n > -1 RETURN b.k AS k, b.s AS s',
  ],
  [
    'IN hop (declined both ways)',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k IN [1, 2] RETURN b.n AS n',
    'MATCH (a:T)-[:E]->(b:T) WHERE b.k IN [1, 2] AND a.n > -1 RETURN b.n AS n',
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
let empty = 0;

for (const [name, admitted, control] of CASES) {
  const tsAdmitted = rowsOf('ts', admitted);
  const adm = verdict(tsAdmitted, rowsOf('native', admitted));
  const ctl = verdict(rowsOf('ts', control), rowsOf('native', control));
  // ⚠️ A SHAPE THAT MATCHES NOTHING AGREES WITH A BROKEN ONE TRIVIALLY (item 1416's rule, and the
  // differential fuzzer's own "non-zero floor is what matters"). Counted and reported, so an empty
  // row is not mistaken for a pass.
  const rowCount = (JSON.parse(tsAdmitted) as unknown[]).length;

  if (rowCount === 0) {
    empty += 1;
  }

  // Only DIFFERENT ROWS is a failure: a positional difference is licensed for an unordered GQL
  // projection, and this item reorders on purpose.
  const broken = adm === 'DIFFERENT ROWS';

  if (broken) {
    broke += 1;
  }

  console.log(
    `${name.padEnd(28)} rows ${String(rowCount).padStart(3)}  admitted ${adm.padEnd(26)} declined-control ${ctl.padEnd(26)}` +
      `${broken ? '  ⚠️ MULTISET DIFFERS' : ''}${rowCount === 0 ? '  ⚠️ EMPTY' : ''}`,
  );
}

console.log(
  broke === 0 && empty === 0
    ? '\nevery admitted shape agrees with native as a multiset, and none is empty.'
    : `\n${broke} multiset mismatch(es), ${empty} empty shape(s).`,
);
process.exit(broke === 0 && empty === 0 ? 0 : 1);
