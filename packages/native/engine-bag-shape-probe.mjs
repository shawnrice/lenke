/**
 * Does the ENGINE's property-read site care about bag SHAPE? If so, shape stability is a lever.
 *
 * Item 1364's clean per-process micro found that reading one key from a plain object costs **3.8x
 * more at 200,000 elements when the bags carry 8 different key sets than when they all carry one**
 * (17.82 ms against 4.72), consistently at every size — so it is inline-cache state, not cache
 * locality. The micro cannot say whether the ENGINE is in the good state or the bad one, and that is
 * the whole question, because `propOf` is ONE shared call site in the engine: every GQL and Gremlin
 * property read of every element type goes through it.
 *
 * Two graphs, same vertex count, same query, same answer:
 *
 *   uniform  every vertex carries exactly `{k, s, n}` — one hidden class, monomorphic site
 *   varied   vertices carry 8 different key SETS, all still answering `k` — megamorphic site
 *
 * The query filters on `k` and counts, so the only difference reaching `propOf` is the bag's shape.
 * A gap near the micro's 3.8x means the engine's read site is shape-sensitive and the cost is real;
 * a flat result means something upstream (the box indirection, `satisfies`, the scan) dominates and
 * shape never reaches the measurement.
 *
 *     ARM=uniform|varied SIZE=200000 node engine-bag-shape-probe.mjs
 *
 * ⚠️ ONE ARM PER PROCESS (item 762, and item 1364 is the cautionary tale): the two arms differ
 * precisely in the dispatch state of a shared site, so running both in one process would have the
 * first pollute the second and measure nothing. That is the bug this probe exists because of.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const ARM = process.env.ARM ?? 'uniform';
const SIZE = Number(process.env.SIZE ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 2);

/** Every vertex the same three keys: one hidden class. */
const uniformProps = (i) => ({ k: i % 97, s: `s${i % 1000}`, n: i });

/**
 * Eight key sets, past V8's polymorphic limit of 4, every one still carrying `k` so the query's
 * answer is IDENTICAL to the uniform arm's. The answer being equal is what makes this a fair A/B.
 */
const variedProps = (i) => {
  const bag = { k: i % 97 };

  for (let j = 0; j <= i % 8; j += 1) {
    bag[`x${j}`] = j;
  }

  bag.s = `s${i % 1000}`;
  bag.n = i;

  return bag;
};

const props = ARM === 'varied' ? variedProps : uniformProps;

const g = new Graph();

for (let i = 0; i < SIZE; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: props(i) });
}

// Filters on `k` and counts, so `propOf` runs once per vertex and nothing else differs.
const Q = 'MATCH (n:P) WHERE n.k < 50 RETURN count(*) AS c';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

const series = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const rows = query(g, Q);

  series.push(performance.now() - t0);
  answer = rows[0]?.c;
}

// ASSERTED: the two arms must agree on the count, or the A/B is comparing different questions.
// `k = i % 97` and `k < 50` selects the same fraction in both arms by construction.
if (answer === undefined || answer === 0) {
  throw new Error(`${ARM} produced no count — measuring nothing`);
}

const ms = median(series.slice(DROP));

console.log(
  JSON.stringify({
    arm: ARM,
    size: SIZE,
    answer,
    ms: Number(ms.toFixed(2)),
    nsPerVertex: Number(((ms * 1e6) / SIZE).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
