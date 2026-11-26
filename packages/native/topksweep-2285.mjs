/**
 * **SWEEP THE SIZE — item 2284 measured the top-K heap at ONE size and called it inert (item 2285).**
 *
 * `boundedTopKeyed`'s own header cites its win at **200,000 rows** (62.4 ms → 9.5, 6.6x). Item 2284
 * measured 60,000 and found `LIMIT 100` costing exactly what a full sort costs. Those are not the same
 * experiment, and "never swept the size" is this repo's most-repeated lesson (item 2264).
 *
 * Two arms at each size, identical but for the window:
 *
 *   ordered   ORDER BY, no LIMIT    — sorts everything
 *   topk      ORDER BY, LIMIT 100   — the heap arm, confirmed to RUN (cap=100, allDirect=true)
 *
 * The heap's documented mechanism is sound — keys are extracted ONCE per item, not per comparison — so
 * if the ratio is flat at every size the claim in its header is what needs re-examining, and if it grows
 * with N then item 2284's 60k reading was simply below the crossover.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SIZES = [20_000, 60_000, 200_000, 600_000];
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`  median of ${ROUNDS} (ms). ordered = full sort; topk = ORDER BY + LIMIT 100`);
console.log(`    N          ordered      topk     ratio`);

for (const N of SIZES) {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `p${i}`,
      labels: ['Person'],
      properties: { name: `n${String(i).padStart(8, '0')}` },
    });
  }

  const ARMS = [
    'MATCH (p:Person) RETURN p.name AS n ORDER BY n',
    'MATCH (p:Person) RETURN p.name AS n ORDER BY n LIMIT 100',
  ];

  for (const text of ARMS) {
    for (let w = 0; w < 3; w += 1) {
      query(g, text, {});
    }
  }

  const res = [];

  for (const text of ARMS) {
    const ts = [];

    for (let r = 0; r < ROUNDS; r += 1) {
      const t = performance.now();

      query(g, text, {});
      ts.push(performance.now() - t);
    }

    res.push(med(ts));
  }

  console.log(
    `    ${String(N).padEnd(10)} ${res[0].toFixed(2).padStart(7)} ${res[1]
      .toFixed(2)
      .padStart(9)} ${(res[0] / res[1]).toFixed(2).padStart(9)}x`,
  );
}
