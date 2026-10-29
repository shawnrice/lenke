/**
 * WHERE is TS's 10x on `size(collect(x))`? (item 1196)
 *
 * The egress probe found TS `collect` costs 1.02x its own materialization floor — no rebuild, so
 * item 1195's Rust fix has no TS twin — but `size(collect(a.k))` read 47-54ms against `collect`'s
 * 5.5ms. Computing a list and then its length cannot cost ten times computing the list, so
 * something in that shape leaves the route `collect` alone takes.
 *
 * `scalars.ts:1291` shows `size` is just `lengthOf(a)`, so the cost is NOT in the function. Two
 * hypotheses that the numbers can separate, written before measuring:
 *
 *   (a) IT IS `size`           — only this function is slow over an aggregate.
 *   (b) IT IS THE WRAPPING     — a bare `collect(...)` projection has a fast route and ANY
 *                                function around it falls onto the general one.
 *
 * (b) predicts `reverse(...)` and `coalesce(...)` over the same aggregate are slow too; (a)
 * predicts they are not. `reverse` is the sharpest second probe because it is in the same
 * POLY_STR_LIST set as `size`, so it shares the argument typechecking; `coalesce` is outside it.
 *
 * The answer is asserted on every row — a perf probe that checks no answer will happily report a
 * speedup for a wrong one, which this repo has done once already.
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

const measure = (q: string): { ms: number; answer: string } => {
  const series: number[] = [];
  let answer = '';

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const out = tsQuery(g, q);

    series.push(performance.now() - t0);

    if (r === 0) {
      const s = JSON.stringify(out);

      answer = s.length > 34 ? `${s.slice(0, 31)}...` : s;
    }
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer };
};

console.log(`\n# ts engine, ${N} nodes, median of ${REPS - DROP} after dropping ${DROP}\n`);
console.log('  shape                                    ms      vs collect   answer');

const base = measure('MATCH (a:Person) RETURN collect(a.num) AS c');

for (const [label, q] of [
  ['collect(a.num)                 [BASE]', 'MATCH (a:Person) RETURN collect(a.num) AS c'],
  ['size(collect(a.num))', 'MATCH (a:Person) RETURN size(collect(a.num)) AS c'],
  ['cardinality(collect(a.num))', 'MATCH (a:Person) RETURN cardinality(collect(a.num)) AS c'],
  // Same POLY_STR_LIST set as `size`, so it shares the argument typechecking.
  ['reverse(collect(a.num))', 'MATCH (a:Person) RETURN reverse(collect(a.num)) AS c'],
  // OUTSIDE that set: if this is slow too, the wrapping is the cause, not the typecheck.
  ['coalesce(collect(a.num), 1)', 'MATCH (a:Person) RETURN coalesce(collect(a.num), 1) AS c'],
  // Controls the wrapping cannot explain: a scalar over a NON-aggregate, and a bare count.
  ['[CTL] count(a.num)', 'MATCH (a:Person) RETURN count(a.num) AS c'],
  ['[CTL] size(collect(1))', 'MATCH (a:Person) RETURN size(collect(1)) AS c'],
] as const) {
  const { ms, answer } = measure(q);

  console.log(
    `  ${label.padEnd(38)} ${ms.toFixed(1).padStart(7)} ${(ms / base.ms).toFixed(2).padStart(11)}x   ${answer}`,
  );
}

console.log(
  '\n  reverse/coalesce ALSO slow => the wrapping is the cause (hypothesis b), and `size` is\n' +
    '  merely the spelling it was found through. Only `size` slow => hypothesis (a).',
);
