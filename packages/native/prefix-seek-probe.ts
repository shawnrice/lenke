/**
 * Does a PREFIX predicate reach a range index in the TS engine? (item 1028)
 *
 * The Rust engine had two gaps here and items 1026/1027 closed both: a two-sided interval never
 * seeded (each bound was priced alone), and `STARTS WITH` lowered to a scalar call no seed
 * extractor could see. Grepping the pattern across engines, the TS planner splits:
 *
 *   - the INTERVAL gap does NOT exist. `coalesceRangeHints` already folds `n.k >= lo AND n.k < hi`
 *     into one tight bound, which is what item 1026 had to add to Rust. TS had this right first.
 *   - the PREFIX gap DOES exist: `STARTS WITH` becomes a `starts_with` call and nothing turns it
 *     into a range hint.
 *
 * `spelling-probe.ts` cannot answer this. Its fixture's string key holds SEVEN distinct values, so
 * no prefix over it is selective, and it declares only HASH indexes — the same blindness item 1023
 * found in the Rust probe's equality groups. Its own header says the indexes are created after the
 * unindexed groups so their numbers stay comparable, so widening that fixture would invalidate
 * every figure recorded against it. Hence a separate probe with its own fixture.
 *
 *   cd packages/native && bun prefix-seek-probe.ts
 *   PREFIX_N=200000 PREFIX_REPS=9 bun prefix-seek-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.PREFIX_N ?? 100_000);
const REPS = Number(process.env.PREFIX_REPS ?? 9);

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { name: `name${i}`, k: i % 100 } });
}

// A RANGE index, which is what a prefix or an interval needs. The hash index is the control's:
// an equality seek is the floor both range shapes are trying to reach.
g.createIndex({ on: 'vertex', kind: 'range', keys: ['name'] });
g.createIndex({ on: 'vertex', kind: 'range', keys: ['k'] });

console.log(
  `indexed vertex keys: ${g.vertexPropertyIndex.indexedKeys().join(', ') || 'NONE — these groups measure SCANS'}`,
);

const time = (label: string, q: string, params?: Record<string, unknown>): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();
    const rows = params ? tsQuery(g, q, params) : tsQuery(g, q);

    series.push(performance.now() - t);
    answer = rows[0]?.c ?? rows.length;
  }

  // Median of the warm reps, dropping the first three (visibly the JIT tiering up) — the
  // estimator CLOSED.md settles on for this engine, since `min` reports a rare fast rep.
  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? series[0] ?? 0;

  console.log(
    `  ${label.padEnd(44)} ${median.toFixed(3).padStart(9)} ms   answer=${String(answer).padStart(6)}`,
  );
};

console.log(`\n# ${N} rows, median of the warm reps of ${REPS}\n`);
// The two spellings of ONE question. `name500` selects ~111 of 100,000 (0.1%).
time('STARTS WITH (prefix)', "MATCH (n:P) WHERE n.name STARTS WITH 'name500' RETURN count(*) AS c");
time(
  'the explicit range it implies',
  "MATCH (n:P) WHERE n.name >= 'name500' AND n.name < 'name501' RETURN count(*) AS c",
);
// CONTROLS. An equality seek is the floor; a one-sided range is the shape that seeds today; and an
// UNSELECTIVE interval is the shape a seek should decline.
time('CONTROL equality seek', "MATCH (n:P) WHERE n.name = 'name500' RETURN count(*) AS c");
time('CONTROL one-sided range', "MATCH (n:P) WHERE n.name >= 'name99998' RETURN count(*) AS c");
// THE PARAM SPELLING (item 1029), which is the injection-safe form applications actually write —
// and which item 1028 left scanning on the grounds that the literal is "the one STARTS WITH is
// written in". The engine's own note on `IN $names` says the opposite about binding.
time('STARTS WITH $p (param)', 'MATCH (n:P) WHERE n.name STARTS WITH $p RETURN count(*) AS c', {
  p: 'name500',
});
// A param with NO successor: the upper side drops and the seek degrades to the lower bound (or to
// a scan for the empty prefix), which must still answer correctly.
time(
  'CONTROL param with no successor (empty)',
  'MATCH (n:P) WHERE n.name STARTS WITH $p RETURN count(*) AS c',
  { p: '' },
);
time(
  'CONTROL unselective interval',
  'MATCH (n:P) WHERE n.k >= 30 AND n.k < 40 RETURN count(*) AS c',
);
