/**
 * **THE STANDING O(1)-BY-ID CHECK (item 2267).** The session's brief carries one explicit invariant —
 * *"keep good O(1) access to get a vertex or edge by id"* — and it has been touched indirectly (item 2200
 * priced by-id lookup, 2239 found `getVertexById` is one `Map.get` that every element memoizes) but never
 * verified as an invariant. This verifies it the only way that counts: **by scaling the graph and checking
 * the per-lookup cost does not grow.**
 *
 * O(1) means FLAT in N, so the test is a sweep, not a single number. A `Map.get` on string keys is
 * O(1) amortized but not free of cache effects, so a mild rise at large N is expected and a PROPORTIONAL
 * rise is the failure. Both vertices and edges are checked, since the brief names both.
 *
 * The ids are drawn in a SCATTERED order (a stride through the key space), not sequentially — a
 * sequential walk would measure prefetch rather than lookup, and would hide a structure that degrades.
 */
import { Graph } from '@lenke/core';

const SIZES = (process.env.SIZES ?? '10000,50000,200000,800000')
  .split(',')
  .map((s) => Number(s.trim()));
const REPS = Number(process.env.REPS ?? 5);
const LOOKUPS = Number(process.env.LOOKUPS ?? 200000);

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(`  ${LOOKUPS} scattered lookups per rep, median of ${REPS}\n`);
console.log(
  `  ${'N'.padStart(8)} ${'vertex ns'.padStart(10)} ${'edge ns'.padStart(10)}   growth vs smallest`,
);

let firstV = 0;
let firstE = 0;

for (const n of SIZES) {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97 } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3) % n}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  /* A stride co-prime-ish to N scatters the access pattern; sequential ids would measure prefetch. */
  const stride = 104_729 % n || 1;

  const timeLookups = (get: (id: string) => unknown, prefix: string): number => {
    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      let hits = 0;
      const t = performance.now();

      for (let i = 0; i < LOOKUPS; i += 1) {
        if (get(`${prefix}${(i * stride) % n}`) !== null) {
          hits += 1;
        }
      }

      series.push(performance.now() - t);

      if (hits !== LOOKUPS) {
        throw new Error(
          `${prefix}: ${hits} hits of ${LOOKUPS} — the fixture or the index is wrong`,
        );
      }
    }

    return (med(series.slice(1)) * 1e6) / LOOKUPS;
  };

  const v = timeLookups((id) => g.getVertexById(id), 'v');
  const e = timeLookups((id) => g.getEdgeById(id), 'e');

  if (firstV === 0) {
    firstV = v;
    firstE = e;
  }

  console.log(
    `  ${String(n).padStart(8)} ${v.toFixed(1).padStart(10)} ${e.toFixed(1).padStart(10)}   ${(v / firstV).toFixed(2)}x / ${(e / firstE).toFixed(2)}x   (N is ${(n / SIZES[0]).toFixed(0)}x)`,
  );
}
