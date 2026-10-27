/**
 * Item 977: does a VACUOUS `WITH` cost the shortcut family, the way a vacuous page and a trailing
 * `FILTER` did?
 *
 * The method's first step is to price an enum's variants and pick the biggest MISSING path.
 * `Clause` has fourteen; on the read path between `MATCH` and `RETURN` the ones that can stand
 * between are `With`, `Filter`, `Page`, `Let`, `For` and the two `Call` forms. Of those:
 *
 *   Filter      folds into the MATCH's clause WHERE      `inlineTrailingFilter` (item 548, 7.7-10.9x)
 *   Page        folds onto the RETURN                    `foldPageIntoReturn` (item 969, 3.79x)
 *   Page (vacuous) dropped outright                      `dropVacuousPage` (item 549, 126.60 -> 0.00)
 *   Let         folds when it is the last binding        `inlineTrailingLet`
 *   Call        inlined, both forms                      `inlineCorrelatedCall` / `inlineAggregateCall`
 *   With        **nothing**
 *
 * So `WITH` is the one read-path clause with no fold, and every detector in the shortcut family
 * opens on a clause LIST — item 967 measured a no-op third clause at **1.43x** on a sorted page,
 * and item 548 found 7.7-10.9x for the `FILTER` spelling. If a vacuous `WITH` sits in front of a
 * count the same way, it is the same bug class on the one variant nobody folded.
 *
 * `WITH n` rebinds exactly what is already bound, so arms A and B are the SAME question — the
 * probe asserts they return the same rows rather than assuming it. `WITH n, n.k AS k` is the
 * non-vacuous form and is here to show where the line is: it genuinely projects, so a fold would
 * have to carry that, and it is NOT claimed as a defect.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 7;
const ROUNDS = 5;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50, s: `s${i % 7}` } });
}

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['A count, no WITH', 'MATCH (n:P) RETURN count(*) AS c', 'the baseline — 2 clauses'],
  ['B count, WITH n', 'MATCH (n:P) WITH n RETURN count(*) AS c', 'vacuous WITH — same question'],
  [
    'C filtered, no WITH',
    'MATCH (n:P) WHERE n.k = 7 RETURN count(*) AS c',
    'baseline with a predicate',
  ],
  [
    'D filtered, WITH n',
    'MATCH (n:P) WHERE n.k = 7 WITH n RETURN count(*) AS c',
    'vacuous WITH after a WHERE',
  ],
  // NOT a defect candidate: this WITH actually projects, so it is work the baseline does not do.
  [
    'E WITH that projects',
    'MATCH (n:P) WITH n, n.k AS k RETURN count(*) AS c',
    'non-vacuous — shown for the line',
  ],
];

const medianOf = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[(s.length - 1) >> 1];
};

const best: Record<string, number[]> = {};
const answer: Record<string, string> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q] of order) {
    const series: number[] = [];
    let last = '';

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);
      last = JSON.stringify(rows);
    }

    answer[name] = last;
    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 977 — does a vacuous WITH cost the shortcut family? (N=${N}, min of ${REPS}, MEDIAN of ${ROUNDS} rounds)\n`,
);

const baseline = medianOf(best['A count, no WITH'] ?? [0]);

for (const [name, , note] of CASES) {
  const rounds = best[name] ?? [];
  const ms = medianOf(rounds);

  console.log(
    `  ${name.padEnd(22)} ${ms.toFixed(2).padStart(8)} ms  ${(ms / baseline).toFixed(2)}x A   ` +
      `rounds: ${rounds.map((x) => x.toFixed(2)).join(' ')}   (${note})`,
  );
}

console.log(
  `\n  A and B agree: ${answer['A count, no WITH'] === answer['B count, WITH n'] ? 'YES' : 'NO — comparison VOID'}` +
    `   C and D agree: ${answer['C filtered, no WITH'] === answer['D filtered, WITH n'] ? 'YES' : 'NO — comparison VOID'}`,
);
