/**
 * Item 2406's perf question: does sharing a compile-time GATE cost anything?
 *
 * `clause-shape.ts` gained `onePatternMatchReturn`, which three detectors now call instead of
 * writing the shape test out themselves. That runs once per `compileLinear`, not per element — so
 * the expectation is zero — but "a gate is free" is the assumption this repo keeps measuring rather
 * than asserting, and item 2399 found that even a hot function's CODE SIZE is part of its cost.
 *
 * ⚠️ THE BIG BENCH ROWS CANNOT SEE THIS. They run one compile against 200,000-row execution, so a
 * compile regression is a rounding error there. This drives the opposite ratio: a ONE-VERTEX graph,
 * so execution is trivial and parse + compile + dispatch is nearly all of it.
 *
 * ⚠️⚠️ **KNOWN LIMIT, MEASURED: THIS HARNESS CANNOT RESOLVE A SUB-10% COMPILE EFFECT.** A compile of
 * these shapes is ~0.4 us, and across six alternated rounds the SAME arm varied up to 2.9x while the
 * CONTROL — a shape none of the three detectors touch — moved 3.3 to 8.4 ms, which is the giveaway
 * `CLAUDE.md` names for "the instrument is the variable". So a reading here is evidence only for an
 * effect of tens of percent. Item 2406's actual question (does sharing a compile-time gate cost
 * anything?) was settled by CONSTRUCTION instead — the shared helper allocates exactly one record
 * per gate, matching the twelve sites item 2391 already measured as free — and this probe is kept
 * for the calibration above, not for that answer.
 *
 *   bun compilerate-2406.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const REPS = Number(process.env.REPS ?? 9);
const ITERS = Number(process.env.ITERS ?? 20_000);

const g = new Graph();
// THREE vertices and two edges: the two-hop chain needs x->y->z, and the probe's own guard caught
// a two-vertex fixture returning no rows for it — which would have timed an empty query.
const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, n: 'x' } });
const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2, n: 'y' } });
const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3, n: 'z' } });

g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { w: 1 } });
g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: { w: 2 } });

/*
 * One query per detector the change touched, so a regression is attributable rather than pooled:
 * a two-hop chain (`chainProjection`), a two-segment projection (`hop2Projection`), and a bounded
 * reach with DISTINCT (`reachShortcut`). The one-hop row is the CONTROL — it reaches none of the
 * three, so it says whether a movement is the change or the machine.
 */
const SHAPES = {
  chain: 'MATCH (x:P)-[:E]->(y:P)-[:E]->(z:P) RETURN z.k AS c',
  hop2: 'MATCH (x:P)-[:E]->(y:P) RETURN y.k AS c, y.n AS d',
  reach: 'MATCH (x:P)-[:E]->{1,3}(y:P) RETURN DISTINCT y.k AS c',
  control: 'MATCH (x:P) RETURN x.k AS c',
};

const timed = (src) => {
  const xs = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    let sink = 0;

    for (let i = 0; i < ITERS; i += 1) {
      sink += query(g, src).length;
    }

    xs.push(performance.now() - t0);

    if (sink === 0) {
      throw new Error('no rows: the shape is not doing what the probe assumes');
    }
  }

  // Median of the post-warmup reps — a min hides a bimodal arm (items 2365-2368).
  const post = xs.slice(3).sort((p, q) => p - q);

  return post[Math.floor(post.length / 2)];
};

console.log(`${ITERS} compiles per rep, median of ${REPS - 3} post-warmup reps`);

for (const [name, src] of Object.entries(SHAPES)) {
  const ms = timed(src);

  console.log(
    `${name.padEnd(9)} ${ms.toFixed(1).padStart(8)} ms   ${((1000 * ms) / ITERS).toFixed(2)} us/compile`,
  );
}
