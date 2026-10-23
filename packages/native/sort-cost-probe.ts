// What does an extra ORDER BY key cost in the pure-TS engine?
//
// Item 627 fixed this in the native engine: `sort_idx` fast-paths a single `Col::Num` and a
// single `Col::Str` and dropped every other shape into a comparator that boxed two `Value`s
// per column per comparison — a composite key cost 3.6x a single numeric one, and comparing
// in place made it 2.70-3.73x faster.
//
// The TS engine cannot have THAT bug: its rows are plain JS values already, so there is no
// boxing to remove — `sortRowsByColumns` calls `compareSort` on values it already holds. But
// "cannot have that bug" is not "has no gap", and item 625 is the standing reminder that the
// two engines' costs do not follow from their shapes. So this measures the thing the native
// fix was about: what the SECOND and THIRD key cost relative to the first.
//
//   cd packages/native && bun sort-cost-probe.ts
//   PROBE_N=50000 bun sort-cost-probe.ts
//
// `@lenke/gql` is a BUILT DIST — a source edit needs `bun run build` before it is visible.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.PROBE_N ?? 50_000);
const REPS = Number(process.env.PROBE_REPS ?? 9);

const graph = new Graph();

for (let i = 0; i < N; i++) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: {
      // `grp` collides heavily so the LATER keys decide most comparisons — the shape where
      // the native gap was widest (3.71x on `grp, num` against 2.70x on `num, name`).
      grp: i % 7,
      num: i % 1000,
      name: `v${i}`,
    },
  });
}

// Each sorted case is paired with the SAME QUERY MINUS THE `ORDER BY`. A composite sort also
// projects more columns, and charging that projection to the sort is exactly the confound
// that made a worktree A/B misreport item 627 — the sort's cost is the DIFFERENCE within a
// pair, never the ratio to a one-column floor.
const cases: [string, string][] = [
  ['1 col, no sort', 'MATCH (n:N) RETURN n.num AS a'],
  ['1 col, ORDER BY num', 'MATCH (n:N) RETURN n.num AS a ORDER BY a'],
  ['1 col, ORDER BY name', 'MATCH (n:N) RETURN n.name AS a ORDER BY a'],
  ['2 col, no sort', 'MATCH (n:N) RETURN n.num AS a, n.name AS b'],
  ['2 col, ORDER BY num, name', 'MATCH (n:N) RETURN n.num AS a, n.name AS b ORDER BY a, b'],
  ['2 col, ORDER BY grp, num', 'MATCH (n:N) RETURN n.grp AS a, n.num AS b ORDER BY a, b'],
  ['3 col, no sort', 'MATCH (n:N) RETURN n.grp AS a, n.name AS b, n.num AS c'],
  [
    '3 col, ORDER BY grp, name, num',
    'MATCH (n:N) RETURN n.grp AS a, n.name AS b, n.num AS c ORDER BY a, b, c',
  ],
];

// ROUND-ROBIN, with warm-up rounds discarded. Timing case-by-case charged the FIRST case for
// the JIT tiering up: the no-sort controls came out 71.7, 50.8 then 34.9 ns/row as the
// column count ROSE, which is backwards and was pure ordering bias.
const WARMUP = 2;
const best = new Map<string, number>();

for (let round = 0; round < REPS + WARMUP; round++) {
  for (const [label, q] of cases) {
    const t = performance.now();
    const got = [...(query(graph, q) as Iterable<unknown>)];
    const ms = performance.now() - t;

    if (got.length !== N) {
      throw new Error(`${label}: ${got.length} rows, want ${N}`);
    }

    if (round >= WARMUP) {
      best.set(label, Math.min(best.get(label) ?? Number.POSITIVE_INFINITY, ms));
    }
  }
}

console.log(`\n=== TS sort key cost, ${N} rows, min of ${REPS} round-robin ===`);
console.log(
  `${'case'.padEnd(32)}${'total_ms'.padStart(10)}${'ns/row'.padStart(10)}${'sort ns/row'.padStart(13)}`,
);

// The sort's cost is the DIFFERENCE from the no-sort case with the SAME column count.
const floors = new Map<string, string>([
  ['1 col', '1 col, no sort'],
  ['2 col', '2 col, no sort'],
  ['3 col', '3 col, no sort'],
]);

for (const [label] of cases) {
  const ms = best.get(label) ?? Number.NaN;
  const perRow = (ms * 1e6) / N;
  const baseLabel = floors.get(label.slice(0, 5));
  const baseMs = baseLabel === undefined ? Number.NaN : (best.get(baseLabel) ?? Number.NaN);
  const sortNs = label.includes('no sort') ? 0 : perRow - (baseMs * 1e6) / N;

  console.log(
    `${label.padEnd(32)}${ms.toFixed(2).padStart(10)}${perRow.toFixed(2).padStart(10)}${(sortNs === 0 ? '-' : sortNs.toFixed(2)).padStart(13)}`,
  );
}
