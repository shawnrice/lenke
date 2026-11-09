/**
 * ABLATING `#commitNormalized`'s PARTS (item 1733).
 *
 * Item 1732 split a property write and left `#commitNormalized` at 30.4% -- the largest single
 * term, never decomposed. Its body is a `#graph` null check, an `Object.freeze`, a box resolution
 * (`this.#box ?? elementProperties.get(id)`), and two field stores (`box.bag`, `box.keys`).
 *
 * ⚠️ YIELDS TO THE EVENT LOOP. Item 1732: `markMutated` only clears `pendingTokens` on a
 * `queueMicrotask`, so a synchronous write loop measures unbounded array growth and misattributes
 * ~4.4 points. A write instrument must return to the loop.
 *
 * ⚠️ ONE ARM PER PROCESS AND PER BUILD. The arm is a source edit to `packages/core`, rebuilt into
 * the dist this reads (`fuzzers-read-built-dists`). ARM is echoed back so the caller can assert the
 * arm it asked for is the arm that ran -- and the caller must ALSO assert the DIST contains the
 * arm's code, because a build that silently failed leaves the previous arm in place and the
 * "after" reading is then the "before" code.
 *
 * MEASURED, ns/write at k=4, median of 9 reps dropping 3, three alternated rounds:
 *
 *     arm                  r1       r2       r3
 *     base              115.66   110.55   112.06
 *     nofreeze          100.12    78.69    74.09     <- Object.freeze removed
 *     nokeys            113.25   110.68   108.99     <- `box.keys = undefined` removed
 *     nobox (control)   111.76   120.86   110.01     <- the `??` fallback removed
 *
 * `Object.freeze` is ~35 ns of a ~112 ns write, THIRTY PERCENT. `nokeys` overlaps base and is not
 * measurable. `nobox` is the NULL CONTROL and behaved as predicted: `this.#box` is already
 * populated by the `properties` getter before `#commitNormalized` runs, so removing the `??`
 * removes a branch whose right side never evaluates -- it measured flat, which is what makes the
 * freeze reading trustworthy.
 *
 * ⚠️ `nofreeze`'s r1 (100.12) was still warming -- its series declines 466 -> 387 while r2 and r3
 * are flat (315, 296). The settled figure is 74-79.
 */
import { Graph } from '@lenke/core';

const VERTS = Number(process.env.VERTS ?? 20_000);
const WRITES = Number(process.env.WRITES ?? 4_000_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const DRAIN = Number(process.env.DRAIN ?? 1000);
const ARM = process.env.ARM ?? 'base';

const g = new Graph();

for (let i = 0; i < VERTS; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { a: i, b: `s${i}`, c: i % 2 === 0, d: i * 0.5 },
  });
}

const handles = [];

for (let i = 0; i < VERTS; i += 1) {
  handles.push(g.getVertexById(`v${i}`));
}

let sink = 0;

const round = async () => {
  const t = performance.now();

  for (let w = 0; w < WRITES; w += 1) {
    handles[w % VERTS].setProperty('a', w);
    sink += 1;

    if (w % DRAIN === DRAIN - 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }

  return performance.now() - t;
};

const series = [];

for (let r = 0; r < REPS; r += 1) {
  // eslint-disable-next-line no-await-in-loop
  series.push(await round());
}

// MEDIAN of the kept reps, not min: item 1711's lesson that a plateau-plus-rare-fast-rep series is
// estimated wrongly by `min`. The whole series is printed so the shape is visible.
const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  JSON.stringify({
    arm: ARM,
    verts: VERTS,
    writes: WRITES,
    sink,
    nsPerWrite: Number(((median * 1e6) / WRITES).toFixed(2)),
    medianMs: Number(median.toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
