/**
 * Is the FOLD path's wrapped-aggregate hole worth what the collecting path's was? (item 1198)
 *
 * Item 1197 gave the COLLECTING path (`sum`/`avg`/`collect`/`stddev`/`percentile`) a nested-aggregate
 * route and measured 6.52-10.22x. It deliberately left the FOLD path (`min`/`max`/`count`, via
 * `foldFor`) declining, and asserted that as a negative row in `routes-fired.test.ts`, on the
 * grounds that "same lever" is not a measurement — item 1189 priced an identical-looking signature
 * at ~1.3x where its sibling paid 8332x.
 *
 * So this prices it. The gate is the OTHER one in the same function:
 *
 *   if (agg !== undefined && item.expr !== agg.expr) { return null; }   // shortcuts.ts
 *
 * ⚠️ THE FLOOR IS THE BARE SPELLING, chosen for the reason items 1187/1189/1195 each learned the
 * hard way: it is the same question through the route the fast path already serves, so whatever the
 * wrapped form spends ABOVE it is the routing cost and nothing else. It must NOT be `count(*)`,
 * which has its own O(1) shortcut and would flatter any comparison.
 *
 * ⚠️ AND `size(collect(x))` IS NOT A FLOOR EITHER — item 1195's lesson, where that exact choice
 * overstated a gap 3.5x because `size` had a borrow path of its own. Here the bare `min(a.num)` is
 * served by `detectNodeAggregate`, which is the route under test, so it cannot be secretly faster
 * for a different reason.
 *
 * ESTIMATOR: median after dropping three warm-up reps (the TS per-row path emits a rare fast rep, so
 * `min` estimates two arms differently), with the per-rep series printed so a bimodal row shows.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.BENCH_REPS ?? 9);
const DROP = 3;

let seed = 0x2545_f491;
const next = (m: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

  return seed % m;
};

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  const n = next(1_000_000);

  g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { num: n, str: `u${i}` } });
}

const measure = (q: string): { ms: number; answer: string; series: number[] } => {
  const series: number[] = [];
  let answer = '';

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const out = tsQuery(g, q);

    series.push(performance.now() - t0);

    if (r === 0) {
      const s = JSON.stringify(out);

      answer = s.length > 30 ? `${s.slice(0, 27)}...` : s;
    }
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer, series };
};

console.log(`\n# ts engine, ${N} nodes, median of ${REPS - DROP} after dropping ${DROP}\n`);
console.log('  shape                                    ms      vs floor   answer');

const floor = measure('MATCH (a:Person) RETURN min(a.num) AS c');
const series: Record<string, number[]> = {};

for (const [label, q] of [
  ['min(a.num)                     [FLOOR]', 'MATCH (a:Person) RETURN min(a.num) AS c'],
  // The shape the general path's own comment names.
  ['abs(min(a.num) - 10)', 'MATCH (a:Person) RETURN abs(min(a.num) - 10) AS c'],
  ['min(a.num) + 1', 'MATCH (a:Person) RETURN min(a.num) + 1 AS c'],
  ['coalesce(max(a.num), 0)', 'MATCH (a:Person) RETURN coalesce(max(a.num), 0) AS c'],
  // `count` folds too (COUNT_FOLD), and is the variant a user is likeliest to wrap.
  ['count(a.num) * 2', 'MATCH (a:Person) RETURN count(a.num) * 2 AS c'],
  // A STRING extremum, so the question is not numeric-only.
  ['upper(max(a.str))', 'MATCH (a:Person) RETURN upper(max(a.str)) AS c'],
  // Controls: the bare spellings of the same aggregates, which the route already serves.
  ['[CTL] max(a.num)', 'MATCH (a:Person) RETURN max(a.num) AS c'],
  ['[CTL] count(a.num)', 'MATCH (a:Person) RETURN count(a.num) AS c'],
] as const) {
  const m = measure(q);

  series[label] = m.series;
  console.log(
    `  ${label.padEnd(38)} ${m.ms.toFixed(1).padStart(7)} ${(m.ms / floor.ms).toFixed(2).padStart(9)}x   ${m.answer}`,
  );
}

console.log('\n  per-rep series:');

for (const [k, s] of Object.entries(series)) {
  console.log(`    ${k.padEnd(38)} ${s.map((x) => x.toFixed(0)).join(' ')}`);
}

console.log(
  '\n  A wrapped fold near 1.0 => the hole is COLLECTING-path-only and this sibling is not a\n' +
    '  target, however much the one next to it was worth.',
);
