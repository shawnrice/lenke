// Item 628's A/B: the pre-change and post-change `@lenke/gql` dists, in ONE process,
// ALTERNATED round by round.
//
// Two processes would not do. A separate run carries its own JIT state and its own thermal
// history, and this harness already caught two instrument bugs of exactly that kind: timing
// case-by-case charged the first case for the JIT tiering up (the no-sort controls came out
// DECREASING as the column count rose), and comparing a sorted query to a one-column floor
// charged the sort for the extra columns' projection.
//
// So: both dists imported here, rounds alternate, each side keeps its own minimum, and every
// sorted case is read against the no-sort case with the SAME COLUMN COUNT from the SAME dist.
//
//   cd packages/native && PRE_DIST=<path-to-worktree> bun sort-ab-probe.ts
import { Graph } from '@lenke/core';
import { query as postQuery } from '@lenke/gql';

const PRE =
  process.env.PRE_DIST ??
  '/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad/wt-pre628';
const { query: preQuery } = (await import(`${PRE}/packages/gql/dist/esm/index.mjs`)) as {
  query: typeof postQuery;
};

const N = Number(process.env.PROBE_N ?? 50_000);
const REPS = Number(process.env.PROBE_REPS ?? 9);
const WARMUP = 2;

const graph = new Graph();

for (let i = 0; i < N; i++) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { grp: i % 7, num: i % 1000, name: `v${i}` },
  });
}

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
  // The CONTROLS the change cannot reach: no ORDER BY anywhere, so the comparator is never
  // built; and a SMALL sorted result, where any setup added per sort CALL would show as a
  // regression rather than a win (the reverted multi-key hoist allocated three arrays there).
  ['CONTROL count(*)', 'MATCH (n:N) RETURN count(*) AS c'],
  ['CONTROL tiny sort (LIMIT)', 'MATCH (n:N) RETURN n.num AS a ORDER BY a LIMIT 5'],
  [
    'CONTROL tiny composite sort',
    'MATCH (n:N) RETURN n.grp AS a, n.num AS b ORDER BY a, b LIMIT 5',
  ],
];

const best = new Map<string, [number, number]>();

for (let round = 0; round < REPS + WARMUP; round++) {
  for (const [side, q] of [
    [0, preQuery],
    [1, postQuery],
  ] as [number, typeof postQuery][]) {
    for (const [label, text] of cases) {
      const t = performance.now();
      const got = [...(q(graph, text) as Iterable<unknown>)];
      const ms = performance.now() - t;

      if (got.length === 0) {
        throw new Error(`${label}: no rows`);
      }

      if (round >= WARMUP) {
        const cur = best.get(label) ?? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];

        cur[side] = Math.min(cur[side], ms);

        best.set(label, cur);
      }
    }
  }
}

console.log(`\n=== TS sort: pre vs post, ${N} rows, min of ${REPS} ALTERNATED ===`);
console.log(
  `${'case'.padEnd(32)}${'pre ns/r'.padStart(10)}${'post'.padStart(10)}${'ratio'.padStart(8)}${'sort pre'.padStart(10)}${'sort post'.padStart(11)}${'sort x'.padStart(8)}`,
);

const floors = new Map([
  ['1 col', '1 col, no sort'],
  ['2 col', '2 col, no sort'],
  ['3 col', '3 col, no sort'],
]);
const ns = (ms: number): number => (ms * 1e6) / N;

for (const [label] of cases) {
  const [pre, post] = best.get(label) ?? [Number.NaN, Number.NaN];
  const baseLabel = floors.get(label.slice(0, 5));
  const base = baseLabel === undefined ? undefined : best.get(baseLabel);
  const sorted = !label.includes('no sort') && base !== undefined;
  const sPre = sorted ? ns(pre) - ns(base[0]) : Number.NaN;
  const sPost = sorted ? ns(post) - ns(base[1]) : Number.NaN;

  const tail = sorted
    ? `${sPre.toFixed(2).padStart(10)}${sPost.toFixed(2).padStart(11)}${(sPre / sPost).toFixed(2).padStart(7)}x`
    : '';

  console.log(
    `${label.padEnd(32)}${ns(pre).toFixed(2).padStart(10)}${ns(post).toFixed(2).padStart(10)}${(ns(pre) / ns(post)).toFixed(2).padStart(7)}x${tail}`,
  );
}
