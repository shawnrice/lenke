/**
 * What does BUILDING a small Gremlin traversal cost, after item 1577? (item 1593)
 *
 * `bench:usage`'s new builder rows put it at **54% of a serving point lookup**: 357.9k ops/s when
 * the plan is built per operation against 779.6k when it is reused, with GQL's equivalent at 1.37M.
 * Gremlin accepts no parameters, so a serving workload that varies a value MUST vary the plan —
 * which makes that 54% the realistic shape rather than an avoidable one.
 *
 * Item 1577 already took 4.27x out of construction (`appendStep` marked step functions with
 * `Object.defineProperty`, 73% of the cost). This asks what is left.
 *
 * ⚠️ ONE ARM PER PROCESS (`ARM=`). Item 1578 found the 32-shape Gremlin probe builds every plan
 * ONCE and reuses it, so it had never measured construction at all — and item 1577's first attempt
 * to measure it reported a NEGATIVE share because arms shared a call site.
 *
 *     for a in build run both steps2 steps4; do ARM=$a node gremlin-build-cost-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 200_000);
const ARM = process.env.ARM ?? 'both';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100 },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

/** The serving shape from `bench:usage`: four steps, the value inlined. */
const build = (i) =>
  G.traversal(
    G.V(),
    G.hasLabel('User'),
    G.has('name', G.eq(`user${i % NODES}`)),
    G.values('score'),
  );
const warm = build(0);

const ARMS = {
  /** Construction alone — no execution at all. */
  build: (i) => build(i),
  /** Execution alone, on a plan built once. */
  run: () => G.toArray(warm, g),
  /** Both, which is what a serving call actually does. */
  both: (i) => G.toArray(build(i), g),
  /**
   * ⚠️ THE ARM THAT MAKES THE COMPARISON HONEST, and its absence made my first reading wrong.
   *
   * `run` reuses a plan whose value is baked in, so it looks up `user0` EVERY time; `both` builds a
   * fresh plan per operation and therefore looks up a DIFFERENT user each time. The pair differs in
   * two ways at once — plan reuse AND the data touched — so `both - run` is not construction, it is
   * construction PLUS whatever varying the lookup key costs in index-bucket and cache locality.
   *
   * This builds fresh but looks up the SAME user, which separates them: `fixedbuild - run` is
   * construction alone, and `both - fixedbuild` is the cost of varying the key.
   */
  fixedbuild: () => G.toArray(build(0), g),
  /** Construction at two and four steps, so the per-step cost is separable from the fixed part. */
  steps2: (i) => G.traversal(G.V(), G.has('name', G.eq(`user${i % NODES}`))),
  steps4: (i) => build(i),
  /** The source alone, for the fixed floor. */
  steps1: () => G.traversal(G.V()),
};

const run = ARMS[ARM];

if (run === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

// Warm up, then time. Reported per OPERATION in nanoseconds, because these are sub-microsecond and
// a ms figure would round away the thing being measured.
for (let i = 0; i < 2000; i += 1) {
  run(i);
}

const rounds = [];

for (let r = 0; r < 5; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    run(i);
  }

  rounds.push(((performance.now() - t0) * 1e6) / REPS);
}

const sorted = [...rounds].sort((a, b) => a - b);

console.log(
  JSON.stringify({
    arm: ARM,
    nsPerOp: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)),
    rounds: rounds.map((x) => Number(x.toFixed(1))),
  }),
);
