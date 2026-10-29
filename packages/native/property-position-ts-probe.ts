/**
 * How much does a property's POSITION on the node cost to read, in the TS engine? (item 1212)
 *
 * Item 1211 found this as an instrument artifact and had to work around it: two columns holding the
 * IDENTICAL values, one first in the property object and one last, differed by **1.66x** under
 * `sum`. That made a TS A/B comparing two property keys unusable — but it is also a performance
 * characteristic in its own right, and a user-visible one: a node with many properties is ordinary
 * (a person with twenty fields), and nothing in the query says which of them is cheap to read.
 *
 * So this prices the curve rather than working around it. ONE graph, N properties per vertex, all
 * holding the IDENTICAL value, read one at a time by position.
 *
 * ⚠️ EVERY COLUMN HOLDS THE SAME VALUES, which is what makes position the only variable. If the
 * curve were measured with different data per key it would be measuring the data (item 1211's whole
 * lesson, learned three designs in).
 *
 * THE CONTROL IS THE FIRST KEY, RE-READ LAST. A run where `k00` measured first and `k00` measured
 * last disagree is a run where something drifted — the order of measurement, not the position, and
 * the table is then worthless. It is printed as its own row.
 *
 *   bun run property-position-ts-probe.ts
 *   WIDTH=40 bun run property-position-ts-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.SPELL_N ?? 100_000);
const WIDTH = Number(process.env.WIDTH ?? 20);
const REPS = Number(process.env.BENCH_REPS ?? 9);
const DROP = 3;

const key = (i: number) => `k${String(i).padStart(2, '0')}`;

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  const properties: Record<string, number> = {};

  // ⚠️ IDENTICAL VALUES IN EVERY COLUMN. Position is the only thing that varies across the rows
  // below, so anything the table shows is about position.
  for (let p = 0; p < WIDTH; p++) {
    properties[key(p)] = i % 100;
  }

  g.addVertex({ id: `v${i}`, labels: ['Person'], properties });
}

const measure = (q: string): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();

    tsQuery(g, q);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)];
};

console.log(
  `\n# ts engine, ${N} nodes x ${WIDTH} properties (all identical values), median of ${REPS - DROP}\n`,
);

// ⚠️ ROUND-ROBIN ACROSS POSITIONS, NOT A SWEEP PER POSITION — and the first design got this wrong
// in a way its own control caught. Dropping warm-up REPS inside each query (this repo's documented
// TS estimator) does NOT remove PROCESS-level warm-up: that lands entirely on whichever query runs
// FIRST, and the first design normalized against exactly that query. The result was a table where
// position 0 looked 1.3-2.7x slower than its neighbours and the before/after control read 0.71x.
//
// So every position is measured once per ROUND, in the same order each round, and the first round
// is discarded whole. Warm-up is then paid by round 1 and shared by nobody.
const ROUNDS = Number(process.env.ROUNDS ?? 4);
// ⚠️ THE CONTROL IS POSITION 0 AGAIN, AT THE END OF EVERY ROUND — not a single reading at each end
// of the process. A before/after pair captures the whole run's downward drift (3.4ms to 2.1ms, a
// 0.61x "failure" that says nothing about position), while the round-robin table is internally
// consistent because every position is measured once per round. The valid control therefore has to
// live INSIDE the round: the same position, measured first and last within it. If those two
// readings disagree, order within a round is biasing the table.
const probed = [0, 1, 2, 4, 7, 11, 15, WIDTH - 1].filter(
  (x, i, a) => x < WIDTH && a.indexOf(x) === i,
);
const positions = [...probed, 0];
const sumRounds: number[][] = positions.map(() => []);
const scanRounds: number[][] = positions.map(() => []);

for (let round = 0; round < ROUNDS; round++) {
  for (const [idx, pos] of positions.entries()) {
    const s = measure(`MATCH (p:Person) RETURN sum(p.${key(pos)}) AS s`);
    // A filtered count as well as an aggregate: if only one shows a curve, the cost is in that
    // path's access rather than in reading the property.
    const sc = measure(`MATCH (p:Person) WHERE p.${key(pos)} > 50 RETURN count(*) AS c`);

    if (round > 0) {
      sumRounds[idx].push(s);
      scanRounds[idx].push(sc);
    }
  }
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

console.log(`  (${ROUNDS} rounds round-robin, round 1 discarded whole)\n`);
console.log('  position   sum(ms)   vs first   scan(ms)   vs first');

const sum0 = med(sumRounds[0]);
const scan0 = med(scanRounds[0]);

for (const [idx, pos] of probed.entries()) {
  const s = med(sumRounds[idx]);
  const sc = med(scanRounds[idx]);

  console.log(
    `  ${String(pos).padStart(8)} ${s.toFixed(1).padStart(9)} ${(s / sum0).toFixed(2).padStart(10)}x` +
      ` ${sc.toFixed(1).padStart(10)} ${(sc / scan0).toFixed(2).padStart(10)}x`,
  );
}

// Position 0 appears twice in `positions`: first in the round and last. Those two readings are the
// control, and they bracket every other row's measurement.
const ctlFirst = med(sumRounds[0]);
const ctlLast = med(sumRounds[positions.length - 1]);

console.log(
  `\n  [CTL] position 0, FIRST in each round ${ctlFirst.toFixed(1)}ms; LAST in each round ` +
    `${ctlLast.toFixed(1)}ms (${(ctlLast / ctlFirst).toFixed(2)}x)`,
);
console.log(
  '  That control must be ~1.0x: it is the same key read twice per round, so anything else means\n' +
    '  position WITHIN a round is biasing the table and no row in it means anything.',
);
console.log(
  '\n  A rising curve => the position of a property on the node is a real cost in the TS engine,\n' +
    '  which no query can express and no user can see. Flat => the 1.66x item 1211 measured was\n' +
    '  about those two specific keys and not about position in general.',
);
