/*
 * Item 2061 — HOW MUCH OF `where(hop).values(n).count()` IS LEFT AFTER THE FUSION?
 *
 * The fusion took it 18.99 -> 15.99 ms by removing the traverser pipeline, which lands it LEVEL with
 * the arm that emits all 200,000 rows (16.01) rather than BELOW it — the target item 2060 set. The
 * reason is that a `count` residual still DRAINS the values walk and counts the array, so every value
 * is materialized for a query that returns one number.
 *
 * This prices the hand floor: visit each vertex, test the existence hop, test the key, increment.
 * IT MUST ANSWER THE SAME NUMBER, or it prices a different query.
 */
import { Graph } from '@lenke/core';
import { count, out, toArray, traversal, V, values, where } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50 },
  });
}

for (let e = 0; e < NODES; e += 1) {
  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${e}`),
    to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

const counted = traversal(V(), where(traversal(out('E'))), values('n'), count());

/** The floor: no values materialized, no array, just the increment. */
const hand = () => {
  let c = 0;

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket !== undefined && bucket.size > 0 && 'n' in v.properties) {
      c += 1;
    }
  }

  return c;
};

const engine = () => Number(toArray(counted, g)[0]);
const want = engine();

if (hand() !== want) {
  throw new Error(`floor answers ${hand()}, engine ${want} — different queries`);
}

const time = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(3).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(`  ${label.padEnd(22)} ${ms.toFixed(2).padStart(8)} ms`);

  return ms;
};

console.log(`\n  ${NODES} vertices, both arms answering ${want}\n`);
const eng = time('engine fused count', engine);
const flr = time('HAND floor', hand);
console.log(
  `\n  engine / floor = ${(eng / flr).toFixed(2)}x — what a non-materializing count could still recover\n`,
);
