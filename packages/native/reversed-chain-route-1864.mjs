/**
 * DOES THE REVERSED-CHAIN SPELLING REACH A RUNG? (item 1864)
 *
 * The fork and `(b)<-[:E]-(a)-[:E]->(c)` are the same question — verified on counts AND row
 * multisets, diagonal included, by `fork-as-reversed-chain-1864.mjs`. A rewrite is therefore SOUND.
 * Whether it is WORTH anything is a separate question: if the reversed spelling is just as slow,
 * the rewrite buys nothing and the fork needs its own rung after all.
 *
 * BOTH HALVES ARE ASKED — the route and the time — because either alone misleads. A rung that
 * fires but is no faster is not a win, and a time that improves without a route change is noise.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 3200);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 3);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + h * 2_654_435_761) % N) + 1)),
      labels: ['E'],
    });
    e += 1;
  }
}

const SHAPES = {
  'fork rows (comma)': 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
  'reversed chain': 'MATCH (b:T)<-[:E]-(a:T)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
  'forward chain (control)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
};

console.log(`${N} vertices / ${N * FANOUT} edges, min of ${REPS}`);
console.log('');
console.log('shape                        ms      rows');
console.log('------------------------------------------');

for (const [name, text] of Object.entries(SHAPES)) {
  let best = Infinity;
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = query(g, text);

    best = Math.min(best, performance.now() - t0);
    rows = got.length;
  }

  console.log(`${name.padEnd(26)} ${best.toFixed(1).padStart(6)} ${String(rows).padStart(9)}`);
}
