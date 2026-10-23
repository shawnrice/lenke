// Is an UNINDEXED write in the TS engine slow because of the SET, or because it poisons the
// next scan?
//
// `bun run bench:usage` shows, on the pure-TS engine with NO indexes, two queries whose MATCH
// is character-for-character identical:
//
//     read:  MATCH (u:User) WHERE u.name = $n RETURN u.score AS s     2.0k ops/s   ~500 us
//     write: MATCH (u:User) WHERE u.name = $n SET u.score = $v          552 ops/s  ~1810 us
//
// The write is 3.6x the read for adding one property assignment to the same scan — while the
// INDEXED column shows the SET adding only ~2 us (1.15M -> 327.7k ops/s). A SET does not care
// whether an index exists, so the suspicion is that a write invalidates something the scan
// relies on and the next scan rebuilds it. That is exactly the cost the user's brief singles
// out: a structure that is invalidated on write is only worth having if rebuilding it is cheap.
//
// This separates the two. If the SET itself is expensive, the write-only loop is slow and a
// read that follows a write is as fast as a read in a read-only loop. If a write POISONS the
// scan, the read-after-write is the slow one.
//
//   cd packages/native && bun write-invalidation-probe.ts
//   PROBE_N=20000 bun write-invalidation-probe.ts
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.PROBE_N ?? 20_000);
const OPS = Number(process.env.PROBE_OPS ?? 200);
const REPS = Number(process.env.PROBE_REPS ?? 5);
const WARMUP = 2;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i++) {
    g.addVertex({
      id: `u${i}`,
      labels: ['User'],
      properties: { name: `user${i}`, score: i % 1000 },
    });
  }

  return g;
};

const READ = 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s';
const WRITE = 'MATCH (u:User) WHERE u.name = $n SET u.score = $v';

type Case = { name: string; run: (g: Graph, i: number) => void };

const cases: Case[] = [
  {
    // The floor: scan + project, nothing written, so nothing can be invalidated.
    name: 'read only',
    run: (g, i) => void [...(query(g, READ, { n: `user${i % N}` }) as Iterable<unknown>)],
  },
  {
    name: 'write only',
    run: (g, i) =>
      void [...(query(g, WRITE, { n: `user${i % N}`, v: i % 1000 }) as Iterable<unknown>)],
  },
  {
    // A write, then the SAME read. If a write poisons the scan, the pair costs much more than
    // `read only` + `write only` measured apart.
    name: 'write then read',
    run: (g, i) => {
      void [...(query(g, WRITE, { n: `user${i % N}`, v: i % 1000 }) as Iterable<unknown>)];
      void [...(query(g, READ, { n: `user${i % N}` }) as Iterable<unknown>)];
    },
  },
  {
    // TWO reads, as the control for the row above: the pair's cost with no write in it at all.
    name: 'read then read (control)',
    run: (g, i) => {
      void [...(query(g, READ, { n: `user${i % N}` }) as Iterable<unknown>)];
      void [...(query(g, READ, { n: `user${i % N}` }) as Iterable<unknown>)];
    },
  },
  {
    // A write that touches NO rows (the name matches nothing) — the scan still runs, so this
    // is the scan's cost plus whatever a write-with-no-write-done costs.
    name: 'write matching 0 rows',
    run: (g, i) =>
      void [...(query(g, WRITE, { n: `nobody${i}`, v: i % 1000 }) as Iterable<unknown>)],
  },
];

// Each case gets its OWN graph: a shared one would let an earlier case's writes change the
// data a later case scans.
const graphs = cases.map(build);
const best = new Map<string, number>();

for (let round = 0; round < REPS + WARMUP; round++) {
  for (const [c, kase] of cases.entries()) {
    const g = graphs[c];
    const t = performance.now();

    for (let i = 0; i < OPS; i++) {
      kase.run(g, round * OPS + i);
    }

    const us = ((performance.now() - t) * 1000) / OPS;

    if (round >= WARMUP) {
      best.set(kase.name, Math.min(best.get(kase.name) ?? Number.POSITIVE_INFINITY, us));
    }
  }
}

console.log(`\n=== TS write invalidation, ${N} users, ${OPS} ops/round, min of ${REPS} ===`);
console.log(`${'case'.padEnd(26)}${'us/op'.padStart(10)}`);

for (const kase of cases) {
  console.log(
    `${kase.name.padEnd(26)}${(best.get(kase.name) ?? Number.NaN).toFixed(1).padStart(10)}`,
  );
}
