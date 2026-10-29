/**
 * Does the TS engine have data-dependent filter costs too? (item 1211)
 *
 * Items 1206-1210 built a detector and used it five times in the Rust engine: run the SAME query
 * over a PERIODIC column and a RANDOM one, same row count and same selectivity, and a path whose
 * cost differs is branching per row. It found five branchy paths and three of them are now fixed
 * (boolean count 4.88x, `sum` 3.88x, projection 2.58x).
 *
 * The detector has never been pointed at the TS engine, and "make BOTH engines faster" is the
 * standing instruction. Whether it transfers is a measurement, not an inference: a mispredicted
 * branch costs ~18 cycles in native code, but in a JIT the per-row work is dominated by megamorphic
 * dispatch and boxing, so the same branch may be invisible. Items 1183, 1192, 1193, 1196 and 1199
 * are all cases where a Rust finding did or did not transfer, and only the measurement said which.
 *
 * ⚠️ READ THE RATIO, NOT THE TIMES. The two fixtures hold the same number of rows at the same ~50%
 * selectivity (the matched count prints, as the check). A row whose PERIODIC and RANDOM timings
 * differ is data-dependent; one where they agree is not, whatever its absolute cost.
 *
 * CONTROLS: an unfiltered count and an unfiltered projection, neither of which has a
 * data-dependent branch. If those move with value order, the instrument is wrong.
 *
 * ESTIMATOR: median after dropping three warm-up reps — the TS per-row path plateaus and emits a
 * rare fast rep, so `min` estimates two arms differently (this repo's documented rule).
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.BENCH_REPS ?? 9);
const DROP = 3;

/**
 * ONE graph carrying BOTH orders as separate columns.
 *
 * ⚠️ TWO EARLIER DESIGNS FAILED THEIR OWN CONTROL, which is the whole lesson of this probe. Timing
 * two `Graph` objects in one process made `[CTL] unfiltered projection` — a query with no filter and
 * so no data-dependent branch at all — read **1.46x**; one fixture per process (item 762's rule)
 * only brought it to **1.34x**. Two graphs differ in more than a column's value order: they have
 * separate string tables, hidden-class histories and GC states, and in a JIT that shows up even on
 * an unfiltered projection. The Rust twin got away with two `Store`s because native code has no
 * such coupling — its controls read 1.00x.
 *
 * So the fixture varies the ONLY thing it is supposed to: `kp` holds `i % 100` (periodic) and `kr`
 * holds a random 0..100, side by side on the same vertices in the same heap. A query pair differs
 * in nothing but which column the predicate reads, and the control is the unfiltered projection of
 * each — two dense number columns of the same length, which MUST agree.
 */
const g = new TsGraph();

let seed = 0x2545_f491;

for (let i = 0; i < N; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

  const r = seed % 100;

  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: {
      kp: i % 100,
      kr: r,
      sp: `u${String(i % 100).padStart(4, '0')}`,
      sr: `u${String(r).padStart(4, '0')}`,
      dp: `g${(i % 100) % 8}`,
      dr: `g${r % 8}`,
      flagp: i % 100 >= 50,
      flagr: r >= 50,
      // ⚠️ THE KEY-POSITION CONTROL. `kpLast` holds the IDENTICAL periodic values as `kp` but sits
      // at the END of the property object. If a pair of queries differing only in which of these
      // they read is not 1.0x, then position in the property map — not the data's order — is what
      // the earlier rows were measuring.
      kpLast: i % 100,
    },
  });
}

const measure = (q: string): { ms: number; rows: number } => {
  const series: number[] = [];
  let rows = 0;

  for (let rep = 0; rep < REPS; rep++) {
    const t0 = performance.now();
    const out = tsQuery(g, q) as unknown[];

    series.push(performance.now() - t0);
    rows = out.length;
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], rows };
};

console.log(
  `\n# ts engine, ONE graph, ${N} nodes, median of ${REPS - DROP} after dropping ${DROP}\n`,
);
console.log('  shape                                   periodic   random    ratio   rows');

for (const [label, qp, qr] of [
  [
    'count, single bound',
    'MATCH (p:Person) WHERE p.kp > 50 RETURN count(*) AS c',
    'MATCH (p:Person) WHERE p.kr > 50 RETURN count(*) AS c',
  ],
  [
    'count, STRING bound',
    "MATCH (p:Person) WHERE p.sp > 'u0050' RETURN count(*) AS c",
    "MATCH (p:Person) WHERE p.sr > 'u0050' RETURN count(*) AS c",
  ],
  [
    'count, DICT equality',
    "MATCH (p:Person) WHERE p.dp = 'g3' RETURN count(*) AS c",
    "MATCH (p:Person) WHERE p.dr = 'g3' RETURN count(*) AS c",
  ],
  [
    'count, BOOLEAN equality',
    'MATCH (p:Person) WHERE p.flagp = true RETURN count(*) AS c',
    'MATCH (p:Person) WHERE p.flagr = true RETURN count(*) AS c',
  ],
  [
    'projection under the filter',
    'MATCH (p:Person) WHERE p.kp > 50 RETURN p.kp AS x',
    'MATCH (p:Person) WHERE p.kr > 50 RETURN p.kr AS x',
  ],
  [
    'sum under the filter',
    'MATCH (p:Person) WHERE p.kp > 50 RETURN sum(p.kp) AS s',
    'MATCH (p:Person) WHERE p.kr > 50 RETURN sum(p.kr) AS s',
  ],
  // CONTROLS: the same columns with NO filter. Two dense number columns on the same vertices, so
  // these must agree — if they do not, the comparison is still of two heaps.
  [
    '[CTL] unfiltered projection',
    'MATCH (p:Person) RETURN p.kp AS x',
    'MATCH (p:Person) RETURN p.kr AS x',
  ],
  [
    '[CTL] unfiltered sum',
    'MATCH (p:Person) RETURN sum(p.kp) AS s',
    'MATCH (p:Person) RETURN sum(p.kr) AS s',
  ],
  // KEY POSITION, same values in both: first property against last.
  [
    '[CTL] key position, SAME values',
    'MATCH (p:Person) RETURN sum(p.kp) AS s',
    'MATCH (p:Person) RETURN sum(p.kpLast) AS s',
  ],
  [
    '[CTL] key position, filtered',
    'MATCH (p:Person) WHERE p.kp > 50 RETURN count(*) AS c',
    'MATCH (p:Person) WHERE p.kpLast > 50 RETURN count(*) AS c',
  ],
] as const) {
  const a = measure(qp);
  const b = measure(qr);
  const rows = a.rows === b.rows ? `${a.rows}` : `${a.rows} vs ${b.rows}`;

  console.log(
    `  ${label.padEnd(37)} ${a.ms.toFixed(1).padStart(8)} ${b.ms.toFixed(1).padStart(8)} ` +
      `${(b.ms / a.ms).toFixed(2).padStart(7)}x   ${rows}`,
  );
}

console.log(
  '\n  CHECK THE TWO CONTROLS FIRST. They must be ~1.0x; anything else means the instrument and\n' +
    '  not the engine is being measured, which is how two earlier designs of this probe failed.\n' +
    '  Then: a shape > ~1.3x is data-dependent in TS and the Rust finding transfers; ~1.0x across\n' +
    '  the board means it does not, the per-row boxing and dispatch having swallowed the branch.',
);
