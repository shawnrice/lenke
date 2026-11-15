// Item 1936 — WHAT IS ACTUALLY RECOVERABLE on the non-vacuous hop `count(*)`?
//
// Item 1935 measured `MATCH (a:T)-[:E]->(b:T) RETURN count(*)` going 0.00 -> 1.94 ms from one
// isolated off-label vertex — 1157x. ⚠️ MOST OF THAT IS NOT RECOVERABLE, and saying so is the point
// of this probe: the vacuous case is O(1) because EVERY edge qualifies, so the count is the
// E-bucket's size. With the label non-universal, each edge's endpoints must be tested, which is
// O(E) by construction. You cannot count label-filtered edges in O(1) without a per-(label,
// edgeType) index, and an incremental counter is write-side bookkeeping the owner has already
// pushed back on.
//
// 🔑 SO THE QUESTION IS THE CONSTANT FACTOR: a tight counting loop over the edge bucket, testing
// both endpoint labels, against what the engine does today (which the 1935 numbers suggest is a
// full enumeration). That is a narrow, walk-free target if the gap is real.
//
//     bun countceiling-probe-1936.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 9);

const build = (addOffLabel) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
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

  if (addOffLabel) {
    g.addVertex({ id: 'off', labels: ['U'], properties: { n: 0 } });
  }

  return g;
};

const vac = build(false);
const non = build(true);

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

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN count(*) AS c';

/** The hand ceiling: one pass over the E bucket, two label tests, a counter. No rows built. */
const handCount = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  let n = 0;

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('T') && edge.to.labels.has('T')) {
        n += 1;
      }
    }
  }

  return n;
};

/*
 * 🔑 THE DECISIVE ARM FOR THE 43-GATE DECISION. The COUNT turns out to be near-optimal off its fast
 * arm (below), so the question is whether the hop PROJECTION is too. If the engine's non-vacuous
 * projection is also within ~1.3x of a hand loop, then item 1935's whole 43-gate change buys little
 * and the cliff is simply the cost of label filtering. If it is 10x off, the change is worth its
 * risk.
 */
const PROJ = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';
const handProj = (g) => () => {
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

const [vacProjEngine] = time(() => query(vac, PROJ, {}).length);
const [nonProjEngine, nonProjRows] = time(() => query(non, PROJ, {}).length);
const [nonProjHand, nonProjHandRows] = time(handProj(non));

const [vacEngine, vacGot] = time(() => Number(query(vac, Q, {})[0].c));
const [nonEngine, nonGot] = time(() => Number(query(non, Q, {})[0].c));
const [nonHand, nonHandGot] = time(handCount(non));
const [vacHand, vacHandGot] = time(handCount(vac));

console.log(`${NODES} vertices / ${NODES * FANOUT} E-edges, median of ${REPS}.\n`);
console.log(
  `engine, T vacuous       ${vacEngine.toFixed(3).padStart(8)} ms   count ${String(vacGot)}`,
);
console.log(
  `engine, 1 off-label     ${nonEngine.toFixed(3).padStart(8)} ms   count ${String(nonGot)}`,
);
console.log(
  `hand loop, 1 off-label  ${nonHand.toFixed(3).padStart(8)} ms   count ${String(nonHandGot)}`,
);
console.log(
  `hand loop, T vacuous    ${vacHand.toFixed(3).padStart(8)} ms   count ${String(vacHandGot)}`,
);

if (vacGot !== nonGot || nonGot !== nonHandGot || nonGot !== vacHandGot) {
  throw new Error('arms disagree on the COUNT — the comparison would be meaningless');
}

console.log(
  `\n--- the hop PROJECTION, same two graphs (${String(nonProjRows)} rows):\n` +
    `  engine, T vacuous       ${vacProjEngine.toFixed(2).padStart(8)} ms   ` +
    `${((vacProjEngine * 1e6) / nonProjRows).toFixed(0)} ns a row\n` +
    `  engine, 1 off-label     ${nonProjEngine.toFixed(2).padStart(8)} ms   ` +
    `${((nonProjEngine * 1e6) / nonProjRows).toFixed(0)} ns a row\n` +
    `  HAND loop, 1 off-label  ${nonProjHand.toFixed(2).padStart(8)} ms   ` +
    `${((nonProjHand * 1e6) / nonProjRows).toFixed(0)} ns a row   ` +
    `rows ${String(nonProjHandRows)}\n` +
    `  => off the fast arm the engine is ${(nonProjEngine / nonProjHand).toFixed(2)}x a hand loop`,
);

console.log(
  `\nall four agree on ${String(nonGot)}.\n` +
    `⚠️ The 1157x is O(1) -> O(E) and NOT recoverable. What IS available is the constant factor:\n` +
    `   engine ${nonEngine.toFixed(3)} against the hand loop's ${nonHand.toFixed(3)} = ` +
    `${(nonEngine / nonHand).toFixed(2)}x, i.e. ` +
    `${(((nonEngine - nonHand) * 1e6) / (NODES * FANOUT)).toFixed(1)} ns an edge.`,
);
