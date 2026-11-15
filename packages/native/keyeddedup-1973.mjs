// Item 1973 — `bench:usage`'s `read: keyed dedup lookup` is the ONE indexed read where TS LOSES to
// native, and its own comment prescribes how to measure it.
//
// The usage bench, 20,000 users, indexed on name and score:
//
//     read: point lookup          ts 1.54M   engine 495.8k    TS 3.1x FASTER
//     read: permission check      ts 494.1k  engine 145.6k    TS 3.4x faster
//     read: 2-hop recommendation  ts 570.8k  engine 252.2k    TS 2.3x faster
//     read: keyed dedup lookup    ts  94.3k  engine 166.5k    ⬅ TS 1.77x SLOWER
//
// ⚠️ ONE READING IS NOT A FINDING HERE, AND THE ROW SAYS SO. Its own comment records TS swinging
// **15.8k / 48.1k / 56.5k / 69.3k** across runs while native holds **134.5-143.1k**, calls that the
// bimodality `ts-spelling-probe` documents, and prescribes reading it over several runs. 94.3k sits
// inside that spread. So this runs the shape MANY times in one process and reports the whole series
// rather than a summary — the rule CLAUDE.md gives for the TS per-row path ("print the per-rep series
// before trusting any summary of it").
//
// 🔑 THE QUESTION IS WHETHER TS's MEDIAN IS GENUINELY BELOW NATIVE'S, or whether the usage bench
// caught a slow mode. Those have different answers: the first is a target, the second is noise in a
// row that already warns about it.
//
//     bun keyeddedup-1973.mjs
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const USERS = Number(process.env.USERS ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const OPS = Number(process.env.OPS ?? 200);

const lines = [];

for (let i = 0; i < USERS; i += 1) {
  // `score` spans 100 values, so a seek returns ~200 of 20,000 — the fixture's own selectivity, and
  // the one its comment says the pair cannot resolve a SPELLING difference at. The TS-vs-NATIVE
  // question is a different one and does not need that resolution.
  lines.push(
    `{"type":"node","id":"u${String(i)}","labels":["User"],"properties":{"name":"user${String(i)}","score":${String(i % 100)},"active":true}}`,
  );
}

const NDJSON = lines.join('\n');
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

// ⚠️ THE INDEX IS THE WHOLE POINT: the usage bench's `(+)` columns are indexed on name and score,
// and without it both engines scan and the comparison is a different one.
tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

/*
 * ⚠️ A SECOND INDEX, because the usage bench has one and this probe did not — its `(+)` columns are
 * "indexed on name, score". With only `score` indexed TS WON this row 1.16x, while the bench
 * reproducibly reports TS 93-94k against native 166k. `NAME_INDEX=0` turns this off, so the two
 * configurations can be compared in one place.
 */
if (process.env.NAME_INDEX !== '0') {
  tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const Q = 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c';
const nativeGraph = nativeReady ? graphFromNdjson(nativeBackend(), NDJSON) : undefined;

if (nativeGraph !== undefined) {
  nativeGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

  if (process.env.NAME_INDEX !== '0') {
    nativeGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
  }
}

/** Ops per second for one round of `OPS` queries. */
const round = (run) => {
  const t0 = performance.now();

  for (let i = 0; i < OPS; i += 1) {
    run(i % 100);
  }

  return (OPS * 1000) / (performance.now() - t0);
};

const tsSeries = [];
const natSeries = [];

for (let r = 0; r < ROUNDS; r += 1) {
  // INTERLEAVED, so a drift across the run hits both arms equally rather than whichever ran last.
  tsSeries.push(round((s) => void tsQuery(tsGraph, Q, { s })));

  if (nativeGraph !== undefined) {
    natSeries.push(round((s) => void nativeGraph.query(Q, { s })));
  }
}

const k = (xs) => xs.map((x) => `${(x / 1000).toFixed(1)}k`).join(' ');
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(
  `USERS=${String(USERS)} OPS=${String(OPS)} ROUNDS=${String(ROUNDS)}, ops/sec per round\n`,
);
console.log(`ts     ${k(tsSeries)}`);
console.log(
  `       median ${(med(tsSeries) / 1000).toFixed(1)}k   min ${(Math.min(...tsSeries) / 1000).toFixed(1)}k   max ${(Math.max(...tsSeries) / 1000).toFixed(1)}k`,
);

if (natSeries.length > 0) {
  console.log(`native ${k(natSeries)}`);
  console.log(
    `       median ${(med(natSeries) / 1000).toFixed(1)}k   min ${(Math.min(...natSeries) / 1000).toFixed(1)}k   max ${(Math.max(...natSeries) / 1000).toFixed(1)}k`,
  );
  console.log(
    `\nts/native on medians: ${(med(tsSeries) / med(natSeries)).toFixed(2)}x  (>1 means TS wins)`,
  );
} else {
  console.log('\nSKIP native: the engine library is not built');
}
