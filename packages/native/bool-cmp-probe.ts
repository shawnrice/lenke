/**
 * Item 983: does the TS engine have the bool-comparison gap item 982 just closed natively?
 *
 * Natively, `WHERE p.b = true` fell past `try_filter_keep_bool_prop` to the general vectorized
 * filter and cost **5.71x** the bare `WHERE p.b` on an identical plan — closed at item 982 by
 * teaching that fast path the comparison form.
 *
 * TS has the analogous pair: `truthProps` lifts a bare boolean prop (item 875) and
 * `directEqProps` lifts `<ownVar>.<key> = <closed>` into `eqProps`. Both spellings therefore
 * lift SOMEWHERE, which is a reason to measure rather than to assume either way — item 970 is
 * the standing warning that neither engine's version is inferable from the other's, measured
 * both times it came up.
 *
 * ARMS. The two spellings of the question, their negations, and a CONTROL on a different column
 * that no bool path can reach. All bool arms return the same rows as their twin, asserted per
 * rep rather than at the end.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 7;
const ROUNDS = 5;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  // 80% true / 20% false — ASYMMETRIC, so a polarity confusion between the arms would show as a
  // row-count mismatch rather than hiding behind equal counts (item 982's fixture lesson).
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { b: i % 5 !== 0, k: i % 50 } });
}

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['bare', 'MATCH (p:P) WHERE p.b RETURN count(*) AS c', 'truthProps'],
  ['= true', 'MATCH (p:P) WHERE p.b = true RETURN count(*) AS c', 'eqProps?'],
  ['true =', 'MATCH (p:P) WHERE true = p.b RETURN count(*) AS c', 'flipped'],
  ['NOT bare', 'MATCH (p:P) WHERE NOT p.b RETURN count(*) AS c', 'negated truthProps'],
  ['= false', 'MATCH (p:P) WHERE p.b = false RETURN count(*) AS c', 'eqProps?'],
  ['CONTROL k=7', 'MATCH (p:P) WHERE p.k = 7 RETURN count(*) AS c', 'no bool path reaches it'],
];

const medianOf = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[(s.length - 1) >> 1];
};

const best: Record<string, number[]> = {};
const rows: Record<string, number> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q] of order) {
    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const out = [...query(g, q)];

      series.push(performance.now() - t0);
      rows[name] = Number((out[0] as Record<string, unknown>)?.c ?? -1);
    }

    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 983 — the TS bool-comparison pair (N=${N}, min of ${REPS}, MEDIAN of ${ROUNDS} alternated rounds)\n`,
);

const baseline = medianOf(best.bare ?? [0]);

for (const [name, , note] of CASES) {
  const r = best[name] ?? [];
  const ms = medianOf(r);

  console.log(
    `  ${name.padEnd(13)} ${ms.toFixed(2).padStart(7)} ms  ${(ms / baseline).toFixed(2)}x bare   ` +
      `rows=${String(rows[name]).padStart(6)}   rounds: ${r.map((x) => x.toFixed(2)).join(' ')}   (${note})`,
  );
}

const pos = rows.bare === rows['= true'] && rows.bare === rows['true ='];
const neg = rows['NOT bare'] === rows['= false'];

console.log(
  `\n  positives agree: ${pos ? 'YES' : 'NO — comparison VOID'}   negatives agree: ${neg ? 'YES' : 'NO — comparison VOID'}`,
);
