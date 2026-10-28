/**
 * ONE SPELLING PER PROCESS: does a seekable equality cost more as the SECOND conjunct?
 *
 * Item 1072's subject. `bun run spelling` has reported the group
 * `SEEK: a param equality AND a second conjunct — clause vs inline (item 578)` at ~2.4x for a long
 * time, with these members:
 *
 * ```text
 *    8.74ms  MATCH (n:P) WHERE n.s = $s AND n.k >= 0 RETURN count(*) AS c
 *    7.91ms  MATCH (n:P {s: $s}) WHERE n.k >= 0 RETURN count(*) AS c
 *    8.72ms  MATCH (n:P WHERE n.s = $s) WHERE n.k >= 0 RETURN count(*) AS c
 *   18.83ms  MATCH (n:P) WHERE n.k >= 0 AND n.s = $s RETURN count(*) AS c
 * ```
 *
 * which reads as "the seek only fires when the seekable conjunct comes FIRST" — this repo's named
 * defect class, and `AND` is commutative so the two are unambiguously one question.
 *
 * TWO THINGS SAY TO CHECK THE INSTRUMENT FIRST. The compiled hints are the same SET in both orders
 * (`["eq:s","range:k"]` against `["range:k","eq:s"]`), the chooser takes the narrowest
 * (`countEquals('s',$s)` = 28,572 against `countRange('k',{gte:0})` = 200,000), and an ad-hoc
 * in-process probe reproduced a 2.85x gap in the OPPOSITE direction — whichever spelling ran first
 * was the slow one. That is warm-up, not the engine.
 *
 * So: one spelling per process, 14 reps, median of reps 4+.
 *
 *   cd packages/native && SHAPE=eq-first bun seek-conjunct-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.SC_N ?? 200_000);
const REPS = Number(process.env.SC_REPS ?? 14);

const SHAPES: Record<string, string> = {
  'eq-first': 'MATCH (n:P) WHERE n.s = $s AND n.k >= 0 RETURN count(*) AS c',
  'eq-second': 'MATCH (n:P) WHERE n.k >= 0 AND n.s = $s RETURN count(*) AS c',
  inline: 'MATCH (n:P {s: $s}) WHERE n.k >= 0 RETURN count(*) AS c',
  'inline-where': 'MATCH (n:P WHERE n.s = $s) WHERE n.k >= 0 RETURN count(*) AS c',
  // CONTROLS: each conjunct alone, so the two-conjunct arms can be read against them.
  'eq-only': 'MATCH (n:P) WHERE n.s = $s RETURN count(*) AS c',
  'range-only': 'MATCH (n:P) WHERE n.k >= 0 RETURN count(*) AS c',
};

const name = process.env.SHAPE ?? 'eq-first';
const q = SHAPES[name];

if (q === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

// The spelling probe's own fixture shape and indexes, so this measures that group's queries.
const g = new TsGraph();

for (let i = 0; i < N; i++) {
  g.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['P', 'Q', 'Univ'] : ['P', 'Univ'],
    properties: { k: i % 50, s: `s${i % 7}` },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

const series: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, q, { s: 's1' });

  series.push(performance.now() - t0);
  answer = JSON.stringify(rows);
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`answer=${answer}`);
console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(14)} median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
