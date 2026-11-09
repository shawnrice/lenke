/**
 * THE FRAME SCREENS HAVE NEVER SEEN AN INDEX, so they have never nominated the SEEK path (item 1754).
 *
 * `runtime-profile-probe.mjs` and `runtime-profile-gremlin-probe.mjs` are this repo's two
 * unpriced-frame screens — the instruments that pick targets — and NEITHER calls `createIndex`
 * (nor does `bench.ts`). Ten other probes do, so the capability is exercised elsewhere; but every
 * filtered shape in the two SCREENS is a full scan, which means:
 *
 *   1. the frames they nominate are the SCAN path's, and
 *   2. a frame that only runs on the SEEK path cannot have been nominated at all.
 *
 * Real serving indexes. This profiles the same point lookup both ways so the difference in FRAMES
 * (not just in time) is visible.
 *
 *     SHAPE=point INDEXED=1 PROF_OUT=/tmp/x.cpuprofile node indexed-screen-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 20_000);
const N = Number(process.env.N ?? 1500);
const INDEXED = process.env.INDEXED === '1';
const SHAPE = process.env.SHAPE ?? 'point';

const QUERIES = {
  // A single-row equality — the shape an index exists for.
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  // A low-selectivity equality: 1 in 97 match, so a seek returns ~206 rows.
  band: 'MATCH (n:P) WHERE n.k = 5 RETURN n.s AS s',
  // A RANGE, which a hash index cannot serve — the control that must NOT change between arms.
  range: 'MATCH (n:P) WHERE n.n < 10 RETURN n.s AS s',
  // Same predicate FORM, 1000x less selective: 10,000 of 20,000 rows. If the hash index's help on
  // `range` is selectivity-driven (a seek that enumerates few values), this should not improve.
  rangewide: 'MATCH (n:P) WHERE n.n < 10000 RETURN n.s AS s',
  // THE LADDER (item 1755): the same `<` with THRESH matching rows, to locate the crossover where
  // taking the index stops paying. `n` is `i`, so the threshold IS the row count.
  rangeladder: `MATCH (n:P) WHERE n.n < ${process.env.THRESH ?? 10} RETURN n.s AS s`,
  // ⚠️ THE CARDINALITY TWIN (item 1755). Same ~50% selectivity as `n < 10000`, but on `k`, which has
  // only 97 DISTINCT values against `n`'s 20,000. `countRange` is O(distinct values in range), so if
  // the regression is the GATE'S INPUT rather than the seek, this must NOT regress.
  rangelowcard: 'MATCH (n:P) WHERE n.k < 48 RETURN n.s AS s',
};

const q = QUERIES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(QUERIES).join(',')}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

// INDEXED=1 indexes both keys; INDEXED=k indexes ONLY `k`, which no shape here seeks on except
// `band` -- the discriminator for whether an improvement is the SEEK or merely the presence of an
// index (item 1754: the `range` control improved 18x, which a hash index cannot explain).
if (INDEXED || process.env.INDEXED === 'k') {
  if (process.env.INDEXED !== 'k') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

// Expected row counts, so an arm that stopped answering correctly cannot be timed (item 1749).
const EXPECTED = {
  point: 1,
  band: Math.ceil(NODES / 97),
  range: 10,
  rangewide: 10_000,
  rangeladder: Math.min(Number(process.env.THRESH ?? 10), NODES),
  rangelowcard: 48 * Math.floor(NODES / 97) + Math.min(48, NODES % 97),
};
let rows0 = 0;
const t0 = performance.now();

const out = await profileWindow(process.env.PROF_OUT, () => {
  let sink = 0;

  for (let i = 0; i < N; i += 1) {
    const rows = query(g, q);

    rows0 = rows.length;
    sink += rows.length;
  }

  return sink;
});

if (rows0 !== EXPECTED[SHAPE]) {
  throw new Error(
    `${SHAPE} returned ${rows0} rows, expected ${EXPECTED[SHAPE]} — not answer-equivalent, so its timing is meaningless`,
  );
}

const ms = performance.now() - t0;

console.log(
  JSON.stringify({
    shape: SHAPE,
    indexed: INDEXED,
    n: N,
    rows: rows0,
    ms: Number(ms.toFixed(1)),
    usPerQuery: Number(((ms * 1000) / N).toFixed(1)),
    sink: out,
  }),
);
