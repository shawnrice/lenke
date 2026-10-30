// Clause-vs-inline on a NUMERIC SEEKED key at ~1000 MATCHES A SEEK — the standalone probe item 578
// and `bench-usage.ts` both PRESCRIBE and neither provided (item 1293).
//
//   SHAPE=clause bun seek-match-probe.ts      # or: bun run seek
//   SEEK_MATCHES=200 SEEK_OPS=300 SHAPE=inline bun seek-match-probe.ts
//   SEEK_INDEXED=0 SHAPE=clause bun seek-match-probe.ts   # the ROUTE CHECK, see below
//
// ⚠️ IT IMPORTS `@lenke/gql`, WHICH IS THE BUILT DIST — so `bun run build` first, or this measures
// the previous build. The relative `../gql/src/index.js` reach-in that an uncommitted A/B wants is
// a lint error here for a good reason (it hides the edge from the project graph), and item 1284
// is what a src-vs-dist mix-up costs: two pricing runs reported "nothing moved" because both arms
// ran the same stale dist.
//
// This probe was itself bitten on the way in: against a STALE dist the clause arm read 0.3523ms,
// 1.56x the 0.2238 it reads once built. A reading from this file with no build before it is a
// reading of whatever was built last.
//
// ⚠️ THE ANSWER IS: THEY CONVERGE, 1.02x. Item 578's recorded 1.41x does not reproduce, and this
// probe exists so that is checkable rather than re-derived. Min of three order-alternated rounds,
// one shape per process, 200,000 vertices, 1000 matches a seek, all answering 1000:
//
//     clause   WHERE n.k = $v AND n.active = true     0.2238 0.2275 0.2241   min 0.2238
//     inline   (n:P {k: $v}) WHERE n.active = true    0.2282 0.2311 0.2323   min 0.2282   1.02x
//     [CTL] seek alone, no second conjunct            0.1522 0.1494 0.1535   min 0.1494
//     [CTL] inline alone                              0.1477 0.1487 0.1484   min 0.1477   1.01x
//
// The second conjunct costs 0.073ms per 1000 rows (~73ns a row) and costs it IDENTICALLY on both
// spellings, which is what "no per-row gap" looks like.
//
// WHY EVERY OTHER INSTRUMENT IS BLIND TO THIS:
//   - `spelling-probe`'s NUMERIC seek group lands UNDER 1ms and is "not compared" (its STRING twin
//     is the one that converged at 1.09x in item 1292).
//   - `bench:usage`'s `read: keyed dedup lookup` pair has only ~200 matches, where its own note
//     records three runs swinging 3.3x and 3.6x WITH THE DIRECTION DISAGREEING.
//
// ⚠️⚠️ AND AT `SEEK_OPS=40` THIS PROBE ITSELF SAID 2.27x, IN THE OPPOSITE DIRECTION TO 578. Its
// per-shape MEDIAN swung 1.7x between otherwise identical rounds — larger than the effect — and
// clause/inline/seekonly all moved independently. 300 ops a rep collapses that to 1-2%. An
// instrument whose own variance exceeds the effect does not return a weak result, it returns a
// CONFIDENT WRONG ONE, which is how 1.41x and 2.27x both got measured.
//
// ⚠️ THE ROUTE CHECK IS NOT OPTIONAL — "every member must SEEK; one that scans instead is the bug
// this exists for" (`spelling-probe`). `SEEK_INDEXED=0` is the discriminator: indexed 0.1945ms
// against unindexed 4.3701ms is 22.5x, so the seek is real. A spelling that quietly scanned would
// read ~4.4ms and could not be mistaken for one that seeks.
//
// ⚠️ THE SECOND CONJUNCT IS VACUOUS BY DESIGN: `active = true` holds for every row, so the seek's
// row count stays at 1000 and a per-row gap stays visible. A SELECTIVE second conjunct measures the
// filter instead — the trap item 578's own note names, and the reason its `u.active = true` kept a
// third of the rows rather than a fiftieth.

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.SEEK_N ?? 200_000);
const MATCHES = Number(process.env.SEEK_MATCHES ?? 1000);
const BUCKETS = Math.max(1, Math.floor(N / MATCHES));
const SHAPE = process.env.SHAPE ?? 'clause';
const INDEXED = process.env.SEEK_INDEXED !== '0';

const g = new Graph();

for (let i = 0; i < N; i++) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    // `k` takes BUCKETS distinct values, so one value selects N/BUCKETS == MATCHES rows.
    properties: { k: i % BUCKETS, active: true, s: `s${i % BUCKETS}` },
  });
}

if (INDEXED) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

const Q: Record<string, string> = {
  clause: 'MATCH (n:P) WHERE n.k = $v AND n.active = true RETURN count(*) AS c',
  inline: 'MATCH (n:P {k: $v}) WHERE n.active = true RETURN count(*) AS c',
  inlinewhere: 'MATCH (n:P WHERE n.k = $v) WHERE n.active = true RETURN count(*) AS c',
  reversed: 'MATCH (n:P) WHERE n.active = true AND n.k = $v RETURN count(*) AS c',
  // [CTL] the seek ALONE, no second conjunct — isolates the seek from the per-row filter.
  seekonly: 'MATCH (n:P) WHERE n.k = $v RETURN count(*) AS c',
  inlineonly: 'MATCH (n:P {k: $v}) RETURN count(*) AS c',
};
const q = Q[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

const series: number[] = [];
let ans = -1;

// Each rep runs the query OPS times with a DIFFERENT param, so the measurement is per-operation
// (the serving question) rather than one big scan, and no single value's result can be cached.
//
// ⚠️ OPS IS 300, NOT 40, AND THAT IS THE INSTRUMENT RATHER THAN A PREFERENCE. At 40 the measured
// unit was ~0.1ms and the per-shape MEDIAN swung 1.7x between otherwise identical rounds — bigger
// than the between-shape gap being measured, so no comparison was possible. 300 puts each rep in
// the tens of milliseconds, well clear of timer and JIT jitter.
const OPS = Number(process.env.SEEK_OPS ?? 300);

for (let r = 0; r < 14; r++) {
  const t = performance.now();

  for (let j = 0; j < OPS; j++) {
    ans = Number(query(g, q, { v: j % BUCKETS })[0].c);
  }

  series.push((performance.now() - t) / OPS);
}

const warm = series.slice(3).sort((x, y) => x - y);

console.log(
  `${SHAPE}${INDEXED ? '' : ' [UNINDEXED]'} med=${(warm[Math.floor(warm.length / 2)] ?? 0).toFixed(4)}ms min=${(warm[0] ?? 0).toFixed(4)} max=${(warm[warm.length - 1] ?? 0).toFixed(4)} rows=${ans} series=${series.map((x) => x.toFixed(3)).join(' ')}`,
);
