/**
 * WHERE DO THE ~45 UNEXPLAINED MILLISECONDS IN THE FAR-KEYED OPTIONAL GROUPED COUNT GO? (item 2125)
 *
 * Item 2124 shipped that rung at 3.22x and measured it **1.85x above its own floor**: 112.0 ms against
 * the non-OPTIONAL far-key's 60.5. Part of the 52 ms gap is inherent — the OPTIONAL form MUST visit
 * every anchor to find the unmatched ones — but 200,000 anchor visits at ~34 ns is only ~7 ms, so **~45
 * ms is unaccounted for**. This profiles it rather than guessing at a mechanism.
 *
 * **THE PROFILE IS WINDOWED TO THE QUERY LOOP, WHICH IS THE WHOLE POINT.** `PROBES.md`'s closed-frames
 * table exists because every profile in this package surfaces the FIXTURE BUILD — `indexEdgeLabel`,
 * `commitElementLabels`, `#commitNormalized` — and all of those are closed targets with six prior
 * arrivals between them. Starting the V8 profiler AFTER the build and stopping it before teardown
 * makes those frames structurally absent rather than something to remember to ignore.
 *
 * Run with `node`, not `bun`: this uses `node:inspector`'s Session to window the profile. `@lenke/*`
 * resolve to built dist (plain ESM), so node can load them — but a TS source edit reaches this probe only
 * after `nx build`.
 *
 * The three arms, chosen so each difference isolates one term:
 *
 *   - `farkey`   the target: OPTIONAL + far key. Visits anchors AND itemizes edges.
 *   - `floor`    the same question without OPTIONAL. Itemizes edges, need not visit unmatched anchors.
 *   - `startkey` OPTIONAL + start key. Visits anchors, never itemizes edges.
 *
 * So a frame heavy in `farkey` and absent from `startkey` is the EDGE itemization; heavy in `farkey`
 * and absent from `floor` is the anchor visiting. A frame heavy in all three is neither.
 *
 * **READ THE WALK AND ITS CALLER AS ONE NUMBER — THEIR SPLIT IS NOT REPRODUCIBLE.** Four runs of this
 * probe, same binary, same fixture:
 *
 * ```text
 *     (anonymous) <the walk>    43.1%   42.6%   38.4%   40.2%
 *     optionalHopCounts          8.1    18.2    40.1    13.3     <- the SAME code, 5x apart
 * ```
 *
 * V8's inlining decisions vary per run, so the two frames TRADE self time while their sum stays put.
 * Item 2125 over-read one of those splits as "13.3% phantom self-time in a two-branch dispatcher that
 * cannot cost 13 ms" and built a fix on it that measured 1.02-1.11x. A nomination that depends on WHICH
 * of a callee and its caller is hot is not a finding; sum them, or ablate with a control.
 */
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 40);
const ARM = process.env.ARM ?? 'spread';

/*
 * Item 2139: the serving bench's biggest TS-behind-native row — TS 216.4k ops/s against native's 310.7k
 * (1.44x) on `analytic: fan-out spread 1-3 hops`. ONE indexed seed, then a quantified 1-3 hop expansion.
 */
const QUERIES = {
  spread: 'MATCH (a:P) WHERE a.name = $n RETURN COUNT { MATCH (a)-[:E]->{1,3}(x:P) } AS k',
  /* Controls: the same count without the quantifier, and each fixed depth. */
  onehop: 'MATCH (a:P) WHERE a.name = $n RETURN COUNT { MATCH (a)-[:E]->(x:P) } AS k',
  threehop:
    'MATCH (a:P) WHERE a.name = $n RETURN COUNT { MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(x:P) } AS k',
  seedonly: 'MATCH (a:P) WHERE a.name = $n RETURN a.age AS k',
  q11: 'MATCH (a:P) WHERE a.name = $n RETURN COUNT { MATCH (a)-[:E]->{1,1}(x:P) } AS k',
};
const q = QUERIES[ARM];

if (q === undefined) {
  throw new Error(`ARM must be one of ${Object.keys(QUERIES).join(', ')}`);
}

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { k: i % 97, n: i, age: i % 90, name: `user${i}` },
  });
}

let e = 0;

/* HALF the anchors have no out-edge, as item 2124's fixture does — the `max(1, …)` needs them. */
for (let d = 0; d < 3; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

/*
 * THE SEEK KEY IS INDEXED, as the serving bench's `(+)` column is. Without it the seed is a 200,000-row
 * scan that dwarfs the 1-3 hop expansion this item is about — the walk would be invisible.
 */
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

// Warm the JIT before the window opens, so tiering-up is not attributed to the walk.
for (let r = 0; r < 4; r += 1) {
  query(g, q, { n: 'user0' });
}

const session = new Session();

session.connect();

const call = (method, params) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });

await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 100 });
await call('Profiler.start');

const t0 = performance.now();
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  for (let k = 0; k < 200; k += 1) {
    rows = query(g, q, { n: `user${k % 1000}` }).length;
  }
}

const wall = performance.now() - t0;
const { profile } = await call('Profiler.stop');

session.disconnect();

/* Self time per function, from hitCount — the window holds only the query loop. */
const total = profile.nodes.reduce((acc, n) => acc + (n.hitCount ?? 0), 0);
const byFn = new Map();

for (const node of profile.nodes) {
  const hits = node.hitCount ?? 0;

  if (hits === 0) {
    continue;
  }

  const { functionName, url, lineNumber } = node.callFrame;
  const parts = String(url).split('/');
  const [file] = parts.slice(-1);
  /*
   * AN EXPLICIT LENGTH TEST, NOT `??` — `functionName` is the EMPTY STRING for an anonymous frame,
   * which is falsy but NOT nullish, so `??` would leave the label blank. Same trap as item 2117's empty
   * `join`; the lint's suggestion is wrong here.
   */
  const name = functionName.length > 0 ? functionName : '(anonymous)';
  const key = `${name}  ${file}:${lineNumber + 1}`;

  byFn.set(key, (byFn.get(key) ?? 0) + hits);
}

const ranked = [...byFn.entries()].sort((a, b) => b[1] - a[1]);

console.log(
  `\n  ARM=${ARM}  N=${N} edges=${e}  ${REPS} reps in ${wall.toFixed(0)} ms (${(wall / REPS).toFixed(1)} ms/rep), ${rows} rows`,
);
console.log(`  ${total} samples in the WINDOW (fixture build excluded by construction)\n`);
console.log(`  ${'self%'.padStart(7)}  ${'samples'.padStart(8)}  frame`);

for (const [key, hits] of ranked.slice(0, 18)) {
  const pct = (hits / total) * 100;

  console.log(`  ${pct.toFixed(1).padStart(6)}%  ${String(hits).padStart(8)}  ${key}`);
}

writeFileSync(`spread-${ARM}-2139.cpuprofile`, JSON.stringify(profile));
console.log(`\n  (written: spread-${ARM}-2125.cpuprofile)`);
