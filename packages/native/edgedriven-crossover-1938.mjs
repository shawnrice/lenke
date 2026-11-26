// Item 1938 — WHERE IS THE CROSSOVER between an EDGE-DRIVEN hop walk and the engine's START-DRIVEN
// one, as the start label's selectivity varies?
//
// Item 1937 framed the target correctly: when a start label is not vacuous, the counting far-driven
// walk is unavailable (it counts adjacency and never sees an edge), and the reachable arm is a
// THIRD walk that iterates edges and tests both endpoints — 34 ns a row against the engine's 245.
//
// BUT MY HAND LOOP HID A DESIGN POINT. It measured a start label covering 50,000 of 50,001
// vertices, where iterating every edge is obviously right. If the start label is SELECTIVE, the
// start-driven walk iterates only those few vertices' adjacency — sub-linear — while edge iteration
// is O(E) regardless. That is item 1688's lesson, which `hop-projection.ts` already records for the
// FAR label: "candidateVertexSource iterates the label BUCKET, so a selective label makes the
// existing walk sub-linear where this arm is O(V)".
//
// SO THE GATE NEEDS SELECTIVITY, NOT JUST NON-VACUITY, and this measures where it flips. The
// engine arm is `MATCH (a:T)-[:E]->(b:U) RETURN b.n AS x` with `T` covering a varying fraction;
// `U` is on every vertex so the FAR label is vacuous and only the START label's selectivity moves.
//
//     bun edgedriven-crossover-1938.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);

/*
 * EVERY VERTEX IS AN EDGE SOURCE, SO `|E|` IS CONSTANT across the sweep — and the first version
 * of this probe got that wrong. It created edges only FROM the T-vertices, so `|E|` shrank with the
 * T count and the edge-driven arm's O(|E|) shrank with it: NO crossover could appear, because the
 * fixture was invariant to the thing being varied. The arm wins 1.47x-2.86x there by construction.
 *
 * With `|E|` fixed, edge-driven pays O(|E|) whatever the selectivity while start-driven pays
 * O(tCount x degree) — which is the trade the gate has to decide. `U` is on every vertex so the FAR
 * label stays vacuous and only the START label's selectivity moves.
 */
const build = (tFrac) => {
  const g = new Graph();
  const tCount = Math.max(1, Math.round(NODES * tFrac));

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: i < tCount ? ['U', 'T'] : ['U'],
      properties: { n: i % 97 },
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
      properties: {},
    });
  }

  // An OBJECT, not a tuple: `[g, tCount]` infers `(Graph | number)[]`, so the count looks like it
  // might be the Graph and lint flags its stringification.
  return { g, tCount };
};

/*
 * BOTH ENDS CARRY THE SELECTIVE LABEL, which is the shape item 1936 measured at 7.23x and the
 * shape a real schema has (`MATCH (a:Person)-[:KNOWS]->(b:Person)`). With the FAR label vacuous
 * (`b:U`) the engine's start-driven walk is much cheaper — 100 ns a row against 245 — so that
 * spelling understates the target. Both arms are still compared only within a row.
 */
const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';

/** The proposed arm: one pass over the E bucket, both endpoint labels tested. */
const handEdgeDriven = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('T') && edge.to.labels.has('T')) {
        rows.push({ x: edge.to.properties.n });
      }
    }
  }

  return rows.length;
};

const time = (fn) => {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    got = fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return [ser[ser.length >> 1], got];
};

console.log(
  `${NODES} vertices / ${NODES * FANOUT} E-edges from EVERY vertex (|E| constant), median of ${REPS}.\n` +
    'Arms are compared only WITHIN a row (same graph). `agree` must be true.\n',
);
console.log('T frac   T count   rows    engine    hand edge    ratio   agree');
console.log('-'.repeat(68));

for (const tFrac of [1, 0.5, 0.2, 0.05, 0.01, 0.002]) {
  const { g, tCount } = build(tFrac);
  const [eng, engRows] = time(() => query(g, Q, {}).length);
  const [hand, handRows] = time(handEdgeDriven(g));

  console.log(
    [
      tFrac.toFixed(3).padStart(6),
      String(tCount).padStart(9),
      String(engRows).padStart(6),
      eng.toFixed(2).padStart(9),
      hand.toFixed(2).padStart(12),
      `${(eng / hand).toFixed(2).padStart(7)}x`,
      String(engRows === handRows).padStart(7),
    ].join(' '),
  );
}

console.log(
  '\nA ratio ABOVE 1 means the edge-driven arm wins and the gate should route to it; BELOW 1\n' +
    "   means the engine's start-driven walk is already the better choice at that selectivity.",
);
