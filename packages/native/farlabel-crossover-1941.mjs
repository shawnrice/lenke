// Item 1941 — THE MIRROR QUESTION: does the FAR label need the same coverage gate the START label
// got at item 1940?
//
// Item 1940 left an asymmetry it created: on a graph with one off-label vertex,
//
//     MATCH (a:T)-[:E]->(b:T)   5.53 ms   <- the new edge-driven arm
//     MATCH (a)-[:E]->(b:T)     8.70      <- no START label, so it takes the COUNTING arm
//
// The unlabelled spelling is now the SLOWER one, which is this repo's named bug class pointing the
// other way. ⚠️ And the reason is in `hop-projection.ts`'s own note: the CSR arm "DECLINES" when a
// far label is present, because `candidateVertexSource` iterates the label BUCKET — sub-linear for
// a selective label, where the CSR arm is O(V) (item 1688). So a non-vacuous far label drops the
// walk to vertex iteration with a `Map` lookup per vertex.
//
// 🔑 SO THE SAME TRADE APPLIES, AND IT NEEDS THE SAME SWEEP rather than an assumption: edge
// iteration is O(|E|) whatever the far label excludes, while bucket iteration is sub-linear when it
// is selective. If the crossover lands near the start label's 0.18-0.35, one shared constant covers
// both; if it lands elsewhere, the far side needs its own.
//
//     bun farlabel-crossover-1941.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);
const FRACS = (process.env.FRACS ?? '0.6,0.45,0.35,0.25,0.18,0.12,0.06').split(',').map(Number);

/**
 * `tFrac` of the vertices carry `T` as well as `U`; every vertex is an edge SOURCE so `|E|` is
 * constant as coverage varies (item 1938's fixture lesson). The start is unconstrained, so only
 * the FAR label's coverage moves.
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

  return { g, tCount };
};

// ⚠️ NO START LABEL — that is the whole point: this is the spelling that routes to the counting arm
// today and so never reaches item 1940's edge-driven walk.
const Q = 'MATCH (a)-[:E]->(b:T) RETURN b.n AS x';

/*
 * 🔑 THE REAL CANDIDATE, AFTER THE EDGE-DRIVEN MIRROR WAS REFUTED ABOVE. `csrHopRoute` DECLINES
 * whenever a far label is present, so a non-vacuous far label drops the walk off the CSR entirely:
 * item 1934's numbers show `MATCH (a)-[:E]->(b:T)` at 1.87 ms when T is vacuous (CSR runs) and 8.70
 * when ONE vertex lacks it (CSR declines).
 *
 * But the CSR's `order` array IS the far vertices, so the label can be applied PER SLOT in O(1) —
 * the same move item 1940 made for the start label, on the other end. This arm is that: a hand CSR
 * with a per-slot far-label test, built outside the timer because the engine memoizes it per
 * (graph, topology, shape) on the second ask.
 */
const handCsrWithFarLabel = (g) => {
  const verts = [];

  for (let i = 0; i < NODES; i += 1) {
    verts.push(g.getVertexById(String(i + 1)));
  }

  const off = new Int32Array(NODES + 1);

  for (let i = 0; i < NODES; i += 1) {
    off[i + 1] = off[i] + (verts[i].adjTo?.get('E')?.size ?? 0);
  }

  return () => {
    const rows = [];

    for (let slot = 0; slot < NODES; slot += 1) {
      let n = off[slot + 1] - off[slot];

      if (n === 0) {
        continue;
      }

      const far = verts[slot];

      // ⚠️ THE ONE TEST THE CSR ARM REFUSES TODAY. O(1), on a vertex it already holds.
      if (!far.labels.has('T')) {
        continue;
      }

      const template = { x: far.properties.n };

      rows.push(template);

      for (n -= 1; n > 0; n -= 1) {
        rows.push({ ...template });
      }
    }

    return rows.length;
  };
};

const handEdgeDriven = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.to.labels.has('T')) {
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
  `${NODES} vertices / ${NODES * FANOUT} E-edges, median of ${REPS}. START is unconstrained.\n` +
    '⚠️ `agree` must be true, or the arms are answering different questions.\n',
);
console.log('T frac   T count    rows    engine   hand edge   hand CSR   eng/CSR   agree');
console.log('-'.repeat(76));

for (const frac of FRACS) {
  const { g, tCount } = build(frac);
  const [eng, engRows] = time(() => query(g, Q, {}).length);
  const [hand, handRows] = time(handEdgeDriven(g));
  const [csr, csrRows] = time(handCsrWithFarLabel(g));

  console.log(
    [
      frac.toFixed(3).padStart(6),
      String(tCount).padStart(9),
      String(engRows).padStart(7),
      eng.toFixed(2).padStart(9),
      hand.toFixed(2).padStart(11),
      csr.toFixed(2).padStart(10),
      `${(eng / csr).toFixed(2).padStart(8)}x`,
      String(engRows === handRows && engRows === csrRows).padStart(7),
    ].join(' '),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

console.log(
  '\n⚠️ Above 1 means the edge-driven arm wins and the FAR side needs the gate too; below 1 means\n' +
    "   the counting arm's bucket iteration is already the better choice at that coverage.",
);
