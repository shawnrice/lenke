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

import { profileWindow } from './windowed-profile.mjs';

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
  /**
   * ⚠️ THE ARM BUILT TO SEE ITEM 1512, and the reason it exists is that `wide` cannot.
   *
   * The hoist removes ONE `{ binding, params, graph }` allocation per NON-DIRECT column per row. A
   * direct column (`n.k AS k`) is served by `propOf` and never allocates, so `wide` — two direct
   * columns and one expression — has only one allocation per row to remove, against a ~15%
   * process-to-process spread at ms scale. Every column here is an expression, so there are FOUR
   * per row: same row count, four times the effect, and the arm is otherwise identical in shape.
   */
  exprcols: 'MATCH (n:P) RETURN n.k + 1 AS a, n.k + 2 AS b, n.k + 3 AS c, n.k + 4 AS d',
};

// Per-arm rep counts: `noop`/`exprs` are nanoseconds, the wide ones are milliseconds.
const INNER = { noop: 50_000, exprs: 50_000, wide: 1, widefilt: 1, aggrows: 1, exprcols: 1 };

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

  // ⚠️ PROFILE WINDOW over the SELECTED arm only, which is why `ARM` is required to use it: a
  // window over several arms mixes their frames and the ranking becomes meaningless.
  if (process.env.PROF_OUT !== undefined && ONLY !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    await profileWindow(process.env.PROF_OUT, () => {
      for (let i = 0; i < Number(process.env.PROF_ITERS ?? Math.max(1, inner) * 3); i += 1) {
        query(graph, text);
      }

      return 0;
    });
  }

  const ns = med(times.slice(DROP));
  const cell = inner === 1 ? `${(ns / 1e6).toFixed(2)} ms` : `${ns.toFixed(1)} ns`;

  console.log(`${name.padEnd(10)}${String(rows).padStart(8)}${cell.padStart(14)}`);
}

console.log();
