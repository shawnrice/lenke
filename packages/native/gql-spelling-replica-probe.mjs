/**
 * `spelling-probe.ts`'s EXACT FIXTURE, three queries, ONE PER PROCESS (item 1702).
 *
 * `bun run spelling` flags `three hops, THIRD position filtered (item 222)` at 29.18x / 31.18x /
 * 29.33x across three isolated runs, same answer: a clause `WHERE c.k = 2` at 334-371 ms against
 * `(c WHERE c.k = 2)` and `(c {k: 2})` at 11.5-12.6.
 *
 * An independent fixture with the SAME QUERY STRINGS shows no gap at all, and three candidate causes
 * have been ruled out one at a time (all at 200,000 vertices, median of 7):
 *
 * ```text
 *    no index, 50k        clause  3.9   inline  3.0 / 3.4
 *    hash index on `k`    clause  4.0   inline  3.5 / 3.6     (and the probe indexes AFTER the group)
 *    no index, 200k       clause 21.2   inline 19.7 / 19.2
 *    multi-label edges    clause 22.1   inline 17.6 / 29.2
 * ```
 *
 * So this probe splits the remaining possibilities: it rebuilds the probe's fixture BYTE FOR BYTE —
 * its NDJSON, its `tsDeserialize` loader, `N * 3` edges, `k = i % 50`, the one-in-eleven second edge
 * label, and the four extra `S`/`Univ` nodes — and runs ONE query per process.
 *
 *   - If the gap appears here, it is the FIXTURE, and the next step is to bisect it.
 *   - If it does not, it is `spelling-probe.ts`'s in-process measurement of this group — which
 *     matters more, because that probe is the repo's primary instrument for the defect class this
 *     engine is named for, and its own header says "a flagged group is a finding".
 *
 *   ROW=clause node gql-spelling-replica-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);

// ⚠️ BYTE FOR BYTE `spelling-probe.ts`'s lines. Any deviation here and the probe answers a
// different question than the one being checked.
const lines = [];

for (let i = 0; i < N; i += 1) {
  lines.push(
    `{"type":"node","id":"v${i}","labels":["P"],"properties":{"k":${i % 50},"s":"s${i % 100}"}}`,
  );
}

for (let e = 0; e < N * 3; e += 1) {
  lines.push(
    `{"type":"edge","id":"e${e}","labels":${e % 11 === 0 ? '["E","F"]' : '["E"]'},"from":"v${(e * 104_729) % N}","to":"v${(e * 7919) % N}","properties":{"w":${e % 5},"ew":${e % 1000}}}`,
  );
}

for (let i = 0; i < 4; i += 1) {
  lines.push(
    `{"type":"node","id":"s${i}","labels":["S","Univ"],"properties":{"k":${i},"s":"t${i}"}}`,
  );
}

const g = deserialize(lines.join('\n'), 'ndjson', new Graph());

const ROWS = {
  clause: 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
  inlineWhere: 'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
  inlineProp: 'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
};

const { ROW } = process.env;

if (ROW === undefined || ROWS[ROW] === undefined) {
  throw new Error(`set ROW to one of: ${Object.keys(ROWS).join(', ')}`);
}

const q = ROWS[ROW];
const count = Number(query(g, q)[0].c);

if (count === 0) {
  throw new Error('the row counted 0 — it would prove nothing');
}

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  query(g, q);
  series.push(performance.now() - t0);
}

/** ⚠️ MEDIAN of the warm reps: this repo's note is that `min` has reversed a verdict's sign. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${ROW.padEnd(12)} median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(9)} count=${count} series=${series.map((x) => x.toFixed(0)).join(' ')}`,
);
