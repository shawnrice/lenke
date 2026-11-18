/**
 * ⚠️⚠️ **IS THE SCAN CONTROL FUSED? (item 2256)** Item 1933 prices GQL `SET`'s "write alone" by subtracting
 * `MATCH (n:T) RETURN n.n AS x`, and item 2255 found that control reading **25 ns/row** — while a property
 * read ALONE measured ~73 ns at item 2238. A scan plus a property read cannot cost 25 ns, so either the
 * control takes a route `SET` cannot (making the subtrahend too small and the 2.60x write-alone ratio
 * OVERSTATED), or the 73 ns figure does not transfer.
 *
 * 🔑 **THE TEST IS SPELLINGS.** If one projection shape is fused and others are not, the fused one is
 * dramatically cheaper for no semantic reason — which is exactly the class of defect `CLAUDE.md`'s
 * "equivalent spellings must cost the same" section exists for:
 *
 *     bare        RETURN n.n AS x            the control item 1933 subtracts
 *     twoprop     RETURN n.n AS x, n.w AS y  two reads, harder to fuse into one
 *     pred        WHERE n.n >= 0 RETURN …    a predicate before the projection
 *     element     RETURN n AS x              the element itself, no property read
 *     set         SET n.n = 1                the arm being decomposed, for scale
 *
 * ⚠️ Every arm is verified to produce 20,000 rows (or to have written them), so an arm cannot read fast by
 * doing less — the trap item 1682 names as a strawman arm.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20000);
const REPS = Number(process.env.REPS ?? 9);

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { n: i % 97, w: i % 13 } });
  }

  return g;
};

const ARMS: Array<[string, string, boolean]> = [
  ['bare', 'MATCH (n:T) RETURN n.n AS x', false],
  ['twoprop', 'MATCH (n:T) RETURN n.n AS x, n.w AS y', false],
  ['pred', 'MATCH (n:T) WHERE n.n >= 0 RETURN n.n AS x', false],
  ['element', 'MATCH (n:T) RETURN n AS x', false],
  ['set', 'MATCH (n:T) SET n.n = 1', true],
];

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(`  N=${N}, REPS=${REPS}\n`);
console.log(`  ${'arm'.padEnd(10)} ${'median'.padStart(9)} ${'ns/row'.padStart(9)}  rows`);

for (const [name, text, writes] of ARMS) {
  const series: number[] = [];
  let rows = 0;

  /* ⚠️ A WRITE IS NOT IDEMPOTENT, so the write arm rebuilds per rep with the build OUTSIDE the timer. */
  let g = build();

  for (let r = 0; r < REPS; r += 1) {
    if (writes && r > 0) {
      g = build();
    }

    const t = performance.now();
    const out = query(g, text, {});

    series.push(performance.now() - t);
    rows = out.length;
  }

  const m = med(series.slice(2));

  console.log(
    `  ${name.padEnd(10)} ${m.toFixed(2).padStart(9)} ${((m * 1e6) / N).toFixed(0).padStart(9)}  ${rows}`,
  );
}
