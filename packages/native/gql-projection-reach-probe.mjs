/**
 * HOW FAR DOES `projectedRows` REACH, AND WHO PAYS ITS PER-ROW COST?
 *
 * Item 1508 replaced `toArray(map(f, it))` in `projectedRows` with a direct loop and took
 * `RETURN 1 AS v` from 441 to 107 ns (4.11x) — while `parse-plan-probe`'s five shapes all measured
 * FLAT. Both are true, and the gap between them is the question this probe exists to answer: the
 * change removes ONE generator resume PER ROW, so a one-row query sees all of it as a fraction of
 * a tiny total, and a shape whose rows are expensive to produce sees none of it.
 *
 * ⚠️ SO THE ARMS ARE PICKED BY WHICH BRANCH THEY REACH, not by what they look like. Several
 * ordinary-looking shapes never arrive at `projectedRows` at all — they are caught by a shortcut
 * (`fastPath`) first, which is why `MATCH (n:P) RETURN n.k AS k` did not move.
 *
 *   - `noop`    — `RETURN 1 AS v`. No MATCH, so no shortcut can claim it. ONE row, and the
 *                 per-call fixed cost is the whole measurement.
 *   - `exprs`   — a bare RETURN of several computed scalars: the shape the conformance differential
 *                 harness sends for every function it checks, so this row prices that harness.
 *   - `wide`    — MATCH with a multi-expression projection over N vertices. Non-aggregating, no
 *                 sort, no limit, so it takes the same branch as `noop` but with N rows: this is
 *                 where a PER-ROW saving has to show up if it is real.
 *   - `widefilt`— the same with a WHERE, so most rows are discarded and the projection runs on few.
 *   - `aggrows` — an aggregating projection, which takes the OTHER branch (`applyProjection` +
 *                 `mapToRow`), over N groups.
 *
 *     N=200000 node gql-projection-reach-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 2);

const graph = new Graph();

for (let i = 0; i < N; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

const ARMS = {
  noop: 'RETURN 1 AS v',
  exprs: "RETURN 1 + 2 AS a, upper('x') AS b, 3 * 4 AS c, abs(-5) AS d",
  wide: 'MATCH (n:P) RETURN n.k AS k, n.n AS m, n.k + 1 AS p',
  widefilt: 'MATCH (n:P) WHERE n.k > 90 RETURN n.k AS k, n.n AS m, n.k + 1 AS p',
  aggrows: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
};

// Per-arm rep counts: `noop`/`exprs` are nanoseconds, the wide ones are milliseconds.
const INNER = { noop: 50_000, exprs: 50_000, wide: 1, widefilt: 1, aggrows: 1 };

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

console.log(`\nGQL PROJECTION REACH — N=${N} REPS=${REPS} (median of reps)\n`);
console.log(`${'arm'.padEnd(10)}${'rows'.padStart(8)}${'per call'.padStart(14)}`);

const ONLY = process.env.ARM;

for (const [name, text] of Object.entries(ARMS)) {
  if (ONLY !== undefined && name !== ONLY) {
    continue;
  }

  const inner = INNER[name];
  let rows = 0;

  // Warm the parse cache (admitted on the SECOND sighting) and record the row count, so a shape
  // that silently returns nothing cannot be read as fast.
  for (let w = 0; w < 3; w += 1) {
    rows = query(graph, text).length;
  }

  const times = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    for (let i = 0; i < inner; i += 1) {
      query(graph, text);
    }

    times.push(((performance.now() - t0) * 1e6) / inner);
  }

  const ns = med(times.slice(DROP));
  const cell = inner === 1 ? `${(ns / 1e6).toFixed(2)} ms` : `${ns.toFixed(1)} ns`;

  console.log(`${name.padEnd(10)}${String(rows).padStart(8)}${cell.padStart(14)}`);
}

console.log();
