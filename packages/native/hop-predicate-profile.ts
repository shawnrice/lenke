/**
 * Item 994: the PROFILER harness item 939 said the hop-predicate chain needed and never used.
 *
 * Items 936-939 spent four attempts attributing GQL's ~300 ns per far candidate and closed the
 * chain with an explicit instruction: _"Do not attempt a fourth attribution by timing
 * subtraction. A future attempt needs a profiler on the real query — which no item in this chain
 * used — or a microbenchmark isolating ONE component."_ Three attributions had failed (936 FALSE,
 * 937 INVALID, 938 REFUTED) because 20-60 ns effects cannot be resolved against arms that
 * self-vary 1.2-2.2x.
 *
 * WHY A SEPARATE FILE RATHER THAN A FLAG ON `cross-surface-arity-probe`. Profiling that probe
 * attributes 98% of its samples to FIXTURE CONSTRUCTION — measured: 2,700 ms of profile for a
 * 57 ms query, so `validateElementNames`, `insertEdge` and `randomUUID` dominate and the hop walk
 * is 2%. A profile is only usable here if the region of interest dominates the samples, which
 * means building once and iterating the query many times. That is a different harness, not a
 * different flag.
 *
 * Usage:
 *   bun --cpu-prof --cpu-prof-name=x.cpuprofile hop-predicate-profile.ts
 *   A_SURFACE=grm A_REPS=60 bun --cpu-prof ... hop-predicate-profile.ts
 *
 * `A_SURFACE=gql` (default) profiles `farOnlyHopCount`; `grm` profiles `filteredHopCount`, which
 * answers the same question ~2x faster and is therefore the comparison that matters.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gt, has, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.A_N ?? 200_000);
const DEG = Number(process.env.A_DEG ?? 3);
const REPS = Number(process.env.A_REPS ?? 40);
const SURFACE = process.env.A_SURFACE ?? 'gql';

const build = (): Graph => {
  const g = new Graph();
  const made: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < N; i += 1) {
    made.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: { k: i % 50, j: i % 37, m: i % 11, w: i % 7 },
      }),
    );
  }

  // Both endpoints scattered by different multipliers, exactly as `cross-surface-arity-probe`
  // does it (items 164/286/287) — a sequential `from` side makes one spelling look ~2x faster.
  for (let e = 0; e < N * DEG; e += 1) {
    g.addEdge({
      labels: ['E'],
      from: made[(e * 104729) % N],
      to: made[(e * 15485863) % N],
    });
  }

  return g;
};

const g = build();
const GQL = 'MATCH (a:P)-[:E]->(b) WHERE b.k > -1 RETURN count(*) AS c';
const runOnce = (): number =>
  SURFACE === 'grm'
    ? Number(toArray(traversal(V(), hasLabel('P'), out('E'), has('k', gt(-1)), count()), g)[0])
    : Number(([...query(g, GQL)][0] as Record<string, unknown>).c);

// One untimed rep so the profile is not dominated by first-call compilation, then the measured
// region. Every rep must answer 600,000 or the profile describes a different question.
const expected = N * DEG;

if (runOnce() !== expected) {
  throw new Error(`warm-up answered the wrong count; the fixture or query is not the intended one`);
}

const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  if (runOnce() !== expected) {
    throw new Error(`rep ${r} answered the wrong count`);
  }
}

const ms = performance.now() - t0;

console.log(
  `${SURFACE}\t${REPS} reps\t${ms.toFixed(1)} ms total\t${(ms / REPS).toFixed(2)} ms/rep\t${((ms / REPS / N) * 1e6).toFixed(0)} ns/candidate`,
);
