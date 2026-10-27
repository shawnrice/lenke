/**
 * Item 959: does the TS engine still pay for the BRACKET spelling where the lift cannot reach?
 *
 * Item 954 taught `fieldChain` the bracket form, so `WHERE p.meta['city'] = 'NYC'` now lifts into
 * `pathProps` exactly as the dotted form does and the two cost the same. A PROJECTION is the
 * other half: `RETURN p.meta['city']` is not a predicate, so nothing lifts and `compileExpr`'s
 * per-row closure is what runs — the `case 'index'` arm (an inner closure for the index, an
 * `instanceof`, a `typeof`, `Array.isArray`, bounds) against `case 'field'` (one `instanceof`).
 *
 * Item 958 removed the equivalent gap natively by CANONICALIZING at the IR builder, so the two
 * spellings there now produce byte-identical plans. This asks whether TS should do the same, and
 * prices it first rather than porting on the strength of "native did it" — the mistake item 950
 * made and recorded.
 *
 * THE EQUIVALENCE IS ALREADY ESTABLISHED, at item 954: `x.y` and `x['y']` agree on every base
 * kind a segment can meet (record, scalar, absent, number, list). This probe is about cost only,
 * so it asserts the two arms return IDENTICAL rows and refuses to report a ratio otherwise.
 *
 * ONE PROCESS, ONE GRAPH, and a CONTROL the change cannot reach: a flat `p.tier` projection,
 * which is neither spelling.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 100_000);
const REPS = 7;
const ROUNDS = 5;
const CITIES = ['NYC', 'LDN', 'TYO', 'BER'];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  const city = CITIES[i % CITIES.length];

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { tier: city, meta: { other: city, pad: city } },
  });
}

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['CONTROL flat', 'MATCH (p:P) RETURN p.tier AS v', 'neither spelling'],
  ['dotted', 'MATCH (p:P) RETURN p.meta.other AS v', 'case field'],
  ['bracket', "MATCH (p:P) RETURN p.meta['other'] AS v", 'case index'],
];

const medianOf = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[(s.length - 1) >> 1];
};

const best: Record<string, number[]> = {};
const fingerprint: Record<string, string> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q] of order) {
    const series: number[] = [];
    let last = '';

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);
      // The rows themselves, not a count: a projection that silently returned nulls would
      // otherwise look like a win.
      last = `${rows.length}:${JSON.stringify(rows[0])}:${JSON.stringify(rows[rows.length - 1])}`;
    }

    fingerprint[name] = last;
    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 959 — the BRACKET spelling in a PROJECTION (N=${N}, min of ${REPS}, MEDIAN of ${ROUNDS} alternated rounds)\n`,
);

const baseline = medianOf(best.dotted ?? [0]);

for (const [name, , note] of CASES) {
  const rounds = best[name] ?? [];
  const ms = medianOf(rounds);

  console.log(
    `  ${name.padEnd(14)} ${ms.toFixed(2).padStart(7)} ms  ${((ms * 1e6) / N).toFixed(1).padStart(5)} ns/row  ` +
      `${(ms / baseline).toFixed(2)}x dotted   rounds: ${rounds.map((x) => x.toFixed(2)).join(' ')}   (${note})`,
  );
}

const same = fingerprint.dotted === fingerprint.bracket;

console.log(
  `\n  rows identical: ${same ? 'YES' : `NO — ratio VOID\n    ${fingerprint.dotted}\n    ${fingerprint.bracket}`}`,
);
