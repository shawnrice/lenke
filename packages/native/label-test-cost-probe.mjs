/**
 * WHERE does a per-candidate label test's cost go? (item 1599)
 *
 * An ablation at `buildNodeCount`'s seeded loop priced the whole label test at **1.53x** of the
 * 400-hit seeded count — ~10.5 ns per candidate. Item 1599's first attempt assumed that was
 * DISPATCH (`matchesLabel`'s `undefined` check plus `evalLabelExpr`'s `switch`, re-decided per
 * element at ~70 call sites) and compiled the test to a per-query closure. ⚠️ THAT MEASURED FLAT,
 * so the dispatch was already being inlined and the cost is in the test itself.
 *
 * This isolates the three candidate costs over the same 400 vertices, so the next attempt is
 * aimed at the one that is actually there rather than at a frame name:
 *
 *   - `v.labels.has(name)` — the getter plus a STRING hash (what the engine does)
 *   - a hoisted `Set` — the same `has` with the getter out of the loop
 *   - `bucket.has(v)`     — OBJECT IDENTITY against the label bucket, no getter, no string hash
 *
 * The third is the one blocked on an owner decision (memory's `label-index-vs-setter`): it reads a
 * different source of truth. Measuring it says what that decision is WORTH, which is the input the
 * decision needs.
 *
 *     node label-test-cost-probe.mjs
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 20_000);
const HITS = Number(process.env.HITS ?? 400);
const REPS = Number(process.env.REPS ?? 20_000);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

// The candidate set a seek would hand the loop: HITS vertices, in id order.
const candidates = [];

for (let i = 0; i < NODES && candidates.length < HITS; i += 50) {
  candidates.push(g.getVertexById(`u${i}`));
}

const bucket = g.verticesByLabel.get('User');

const ARMS = [
  {
    name: 'v.labels.has(name)   getter + string hash',
    run: () => {
      let n = 0;

      for (const v of candidates) {
        if (v.labels.has('User')) {
          n += 1;
        }
      }

      return n;
    },
  },
  {
    name: 'hoisted sets          string hash only',
    // The getter paid ONCE per vertex, outside the timed loop, so this arm is the `Set.has` alone.
    sets: candidates.map((v) => v.labels),
    run(self) {
      let n = 0;

      for (const s of self.sets) {
        if (s.has('User')) {
          n += 1;
        }
      }

      return n;
    },
  },
  {
    name: 'bucket.has(v)         object identity',
    run: () => {
      let n = 0;

      for (const v of candidates) {
        if (bucket.has(v)) {
          n += 1;
        }
      }

      return n;
    },
  },
  {
    name: 'NULL CONTROL          no test at all',
    run: () => {
      let n = 0;

      for (const v of candidates) {
        if (v !== undefined) {
          n += 1;
        }
      }

      return n;
    },
  },
];

console.log(`${candidates.length} candidates of ${NODES}, ${REPS} reps. ns per CANDIDATE.\n`);

for (const arm of ARMS) {
  let guard = 0;

  for (let i = 0; i < 2_000; i += 1) {
    guard += arm.run(arm);
  }

  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    guard += arm.run(arm);
  }

  const ns = ((performance.now() - t0) * 1e6) / (REPS * candidates.length);

  // Every arm must agree on the count, or one of them is not testing what it claims.
  if (guard % candidates.length !== 0) {
    throw new Error(`${arm.name} did not match every candidate`);
  }

  console.log(`${arm.name.padEnd(44)} ${ns.toFixed(2)} ns`);
}
