// Item 1935 — HOW WIDE IS THE LABEL-VACUITY CLIFF? Is it one hop gate, or the whole fast-path layer?
//
// Item 1934 measured `MATCH (a:T)-[:E]->(b:T)` going 3.31 -> 22.13 ms from ONE off-label vertex in
// 50,000, because the far-driven walk is gated on `vacuousLabel`. But `vacuousLabel(` has **43
// call sites across 7 files** — hop-projection (18), shortcuts (10), grouped-hop (4),
// var-length-count (3), plus csr-cache, hop-endpoint-extremum and labels — so the question is
// whether the cliff is ONE gate or an architectural assumption.
//
// GREP COUNTS ARE NOT A MEASUREMENT. This runs one shape per gate FAMILY on the same two graphs,
// so the scope claim is measured rather than inferred from where the identifier appears.
//
//     bun vacuityscope-probe-1935.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);

/*
 * THE OFF-LABEL VERTEX IS *ADDITIONAL*, NOT RELABELLED — and the first version of this probe
 * got that wrong. It relabelled vertex 1 from T to U, which changed BOTH the `T` count and the edge
 * set, so the two graphs answered different questions and `same` came back FALSE on seven of eight
 * rows. The guard caught it; the ratios would otherwise have read 1221x and 248x.
 *
 * So both graphs get the SAME N vertices labelled T with the SAME edges, and the non-vacuous one
 * gets ONE EXTRA ISOLATED vertex labelled U. Every `T`-anchored answer is then identical by
 * construction, and the only difference is `graph.vertexCount` — which is precisely what
 * `vacuousLabel` compares against (`verticesByLabel.get('T').size === graph.vertexCount`).
 */
const build = (addOffLabel) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: ['T'],
      properties: { n: i % 97, k: i % 7 },
    });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: { w: e % 7 },
    });
  }

  if (addOffLabel) {
    // ONE isolated vertex with a different label. No edges, so no shape's rows can change.
    g.addVertex({ id: 'off', labels: ['U'], properties: { n: 0, k: 0 } });
  }

  return g;
};

const SHAPES = {
  'hop projection': 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
  'count shortcut': 'MATCH (a:T)-[:E]->(b:T) RETURN count(*) AS c',
  'grouped count': 'MATCH (a:T)-[:E]->(b:T) LET g = b.k RETURN g, count(*) AS c GROUP BY g',
  'node scan': 'MATCH (n:T) RETURN n.n AS x',
  'node count': 'MATCH (n:T) RETURN count(*) AS c',
  'varlen count': 'MATCH (a:T)-[:E]->{1,2}(b:T) RETURN count(*) AS c',
  'hop min': 'MATCH (a:T)-[:E]->(b:T) RETURN min(b.n) AS m',
  'two hop': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS c',
};

const vac = build(false);
const non = build(true);

const time = (g, q) => {
  const ser = [];
  let out = '';

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q, {});
    const ms = performance.now() - t0;

    /*
     * ORDER-INSENSITIVE, because row order is UNSPECIFIED for an unordered result
     * ([[order-is-unspecified]]) and the two arms take different walks, which emit in different
     * orders. My first version compared `rows[0]` and reported `same: false` on the hop projection
     * for that reason alone — a real difference and an order difference are not the same thing, so
     * this compares the MULTISET: the row count plus a sum over the rendered rows.
     */
    let sum = 0;

    for (const row of rows) {
      const txt = JSON.stringify(row);

      for (let c = 0; c < txt.length; c += 1) {
        sum = (sum + txt.charCodeAt(c) * (c + 1)) % 2_147_483_647;
      }
    }

    out = `${String(rows.length)}:${String(sum)}`;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return [ser[ser.length >> 1], out];
};

console.log(
  `${NODES} vertices, median of ${REPS}. ONE off-label vertex is the only difference.\n` +
    '`same` must be true or the two graphs are answering different questions.\n',
);
console.log('shape               vacuous    1 off-label    ratio   same');
console.log('-'.repeat(62));

for (const [name, q] of Object.entries(SHAPES)) {
  const [a, outA] = time(vac, q);
  const [b, outB] = time(non, q);

  console.log(
    `${name.padEnd(18)} ${a.toFixed(2).padStart(8)} ${b.toFixed(2).padStart(14)} ` +
      `${(b / a).toFixed(2).padStart(7)}x ${String(outA === outB).padStart(6)}`,
  );
}
