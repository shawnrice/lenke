/**
 * What does a GQL point query actually cost, one ARM PER PROCESS (item 1579)?
 *
 * ⚠️ THIS PROBE EXISTS BECAUSE TWO IN-PROCESS ATTEMPTS GAVE IMPOSSIBLE ANSWERS. Running several arms
 * in one process reported, in order:
 *
 *     param FIXED text   1.493    interpolated VARY text   2.101    interpolated SAME text  0.312
 *     param FIXED value  1.444    param VARYING value      0.657
 *
 * A fixed value cannot be SLOWER than a varying one — the varying arm does strictly more work
 * (random access over a 20,000-entry index). The pattern is that whichever arm runs FIRST pays,
 * which is item 182's recorded finding for the spelling probe: the shared `query` call site warms
 * up, so position beats effect. Both readings would have supported a story, and both stories were
 * wrong.
 *
 *     for a in paramfixed paramvary interpfixed interpvary byid; do ARM=$a node gql-seek-floor-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 3000);
const ARM = process.env.ARM ?? 'paramfixed';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

const TEXT = 'MATCH (a) WHERE a.n = $n RETURN a.n AS x';

const ARMS = {
  /** One cached plan, one cached index bucket — the floor. */
  paramfixed: () => query(g, TEXT, { n: 7 }),
  /** One cached plan, a RANDOM bucket each call — the realistic point lookup. */
  paramvary: (i) => query(g, TEXT, { n: i % NODES }),
  /** Interpolated but constant text: auto-parameterization normalizes it, so the plan still hits. */
  interpfixed: () => query(g, 'MATCH (a) WHERE a.n = 7 RETURN a.n AS x'),
  /** Interpolated and VARYING: a unique text per call, normalized to one cached plan (item 1502). */
  // oxlint-disable-next-line lenke/no-raw-interpolation -- the interpolation IS what this arm prices
  interpvary: (i) => query(g, `MATCH (a) WHERE a.n = ${i % NODES} RETURN a.n AS x`),
  /** The raw map lookup underneath everything, as the hard floor. */
  byid: (i) => g.getVertexById(`v${i % NODES}`),
};

const run = ARMS[ARM];

if (run === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const series = [];

for (let q = 0; q < 7; q += 1) {
  run(0);
  run(1);

  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    run(i);
  }

  series.push(performance.now() - t0);
}

// Drop the first three rounds as warm-up (visibly the JIT tiering up) and take the MEDIAN of the
// rest — the estimator `ts-spelling-probe` prescribes for this engine, because `min` reports a rare
// fast rep on the general scalar path.
const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    arm: ARM,
    reps: REPS,
    usPerOp: Number(((kept[Math.floor(kept.length / 2)] / REPS) * 1000).toFixed(3)),
    allRoundsMs: series.map((m) => Number(m.toFixed(1))),
  }),
);
