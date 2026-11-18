/**
 * ✅✅ **THE SLOWEST INDEXED READ ON THE SERVING BENCH (item 2325).**
 *
 * `bun run bench:usage` ranks `read: keyed dedup lookup` at **179.6k ops/s against the point lookup's
 * 1.69M** — 9.4x — and `engine(+)` is 170.1k, so **TS is at NATIVE PARITY here.** 🔑 That removes the usual
 * excuse: whatever this costs, it is not TS overhead but the algorithm both engines run.
 *
 * The shape is a seek on an indexed key, a residual predicate, and a count:
 *
 *     MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c
 *
 * ⚠️ At ~200 matches a query that is ~27.8 ns a row, against **6.4 ns** for a whole-scan projection
 * (item 2320) and **13.5 ns** for a filtered scan (item 2322). So the arms below separate the seek, the
 * residual predicate and the count, to find which of the three is paying it.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20_000);
const BUCKETS = Number(process.env.BUCKETS ?? 100);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 40);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'seekFilterCount';

const graph = new Graph();

for (let i = 0; i < USERS; i += 1) {
  graph.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % BUCKETS, active: i % 7 !== 0 },
  });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

const TEXTS = {
  /* ⚠️ THE BENCH ROW ITSELF. */
  seekFilterCount: 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c',
  /* ✅ The seek and the count with NO residual predicate — should be closed form off the bucket size. */
  seekCount: 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c',
  /* ✅ The seek and the predicate, but PROJECTING instead of counting — isolates the count. */
  seekFilterProject: 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN u.name AS n',
  /* ✅ The seek and a projection, no predicate — the per-row floor for this seek. */
  seekProject: 'MATCH (u:User) WHERE u.score = $s RETURN u.name AS n',
  /*
   * ⚠️⚠️ **THE SAME-ENGINE CONTROL, AND IT IS LOAD-BEARING.** A seeked projection measured 20.27 ns a
   * visited row, and item 2320's whole-scan projection measured 6.4 — but **that figure is GREMLIN's**.
   * Comparing across engines is the floor-fairness error corrected four times this session
   * (`floor-arm-must-take-same-route`), so the comparison has to be GQL's own whole-scan projection,
   * visiting every one of the USERS rows with no seek at all.
   */
  scanProject: 'MATCH (u:User) RETURN u.name AS n',
  /* ✅ GQL's whole-scan projection WITH the same residual predicate, for the per-row predicate cost. */
  scanFilterProject: 'MATCH (u:User) WHERE u.active = true RETURN u.name AS n',
  /* ✅ The inline spelling of the bench row, which the bench reports 1.10x apart. */
  inlineFilterCount: 'MATCH (u:User {score: $s}) WHERE u.active = true RETURN count(*) AS c',
};

const text = TEXTS[ARM];
let seq = 0;
const run = () => query(graph, text, { s: seq++ % BUCKETS }).length;

for (let w = 0; w < 400; w += 1) {
  run();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 200_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
/* ✅ Rows the seek actually visits per query, so the per-row figure is honest. */
const visited = ARM.startsWith('scan') ? USERS : USERS / BUCKETS;

console.log(
  `  ARM=${ARM.padEnd(18)} ${(med * 1000).toFixed(2).padStart(9)} us  ${((med * 1000 * 1000) / visited).toFixed(2).padStart(7)} ns/visited  ops/s=${Math.round(1000 / med).toLocaleString()}`,
);
