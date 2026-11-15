// Item 1944 — IS ITEM 1940'S EDGE-DRIVEN ARM A REGRESSION AT 1M EDGES?
//
// ⚠️⚠️ THIS ASKS ABOUT A RISK I INTRODUCED, which is why it comes before the bigger `deduped hop`
// number. Item 1943's `MIXED=1` diff put `CONTROL one-hop projection` at **164 ns a row** (131.18 ms
// / 800,000) on a 200,000-vertex / 1,000,000-edge fixture — where item 1942 measured the SAME arm at
// **56 ns a row** on 50,000 / 100,000, with a hand ceiling of 36.
//
// 🔑 THE ARM'S PER-ROW COST ROUGHLY TRIPLES WITH SIZE AND THE COUNTING ARM'S DOES NOT. Items
// 1939/1940 swept the coverage THRESHOLD across sizes but never swept the ARM itself: every
// measurement of it was at 50,000 vertices. CLAUDE.md's rule — "cache-resident and not are different
// questions; the transition is between 200k and 1M elements" — applies to an O(|E|) scan over a
// `Set` of edges more than to almost anything else here.
//
// So the question is not "can this be faster" but "is it SLOWER than what it replaced". The A/B is
// the gate itself: `EDGE_DRIVEN_MIN_COVERAGE` above 1 makes the arm unreachable and restores the
// start-driven walk, which is exactly the shape of one of item 1940's own mutants.
//
//     ARM=on  bun edgearm-size-1944.mjs        # as shipped
//     ARM=off bun edgearm-size-1944.mjs        # after setting the threshold to 1.01 and rebuilding
//
// ⚠️ Run under a cap — a 1M-edge fixture per rep is what [[dogfood-sim-resource-limits]] is about.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const REPS = Number(process.env.REPS ?? 7);
const SIZES = (process.env.SIZES ?? '50000:2,100000:5,200000:5').split(',');

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';

const build = (nodes, fanout) => {
  const g = new Graph();

  for (let i = 0; i < nodes; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
  }

  for (let e = 0; e < nodes * fanout; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % nodes) + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  // ONE isolated off-label vertex: coverage just under 1, so the arm is reachable and the answer is
  // unchanged (item 1935's design).
  g.addVertex({ id: 'off', labels: ['U'], properties: { n: 0 } });

  return g;
};

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

console.log(`arm=${process.env.ARM ?? 'on'}  median of ${REPS}\n`);
console.log('  nodes  fanout     edges    engine   ns/row   HAND   ns/row   rows');
console.log('-'.repeat(74));

for (const spec of SIZES) {
  const [nodesRaw, fanoutRaw] = spec.split(':');
  const nodes = Number(nodesRaw);
  const fanout = Number(fanoutRaw);
  const g = build(nodes, fanout);
  const hand = handEdgeDriven(g);

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

  const [eng, rows] = time(() => query(g, Q, {}).length);
  const [hnd, handRows] = time(hand);

  if (rows !== handRows) {
    throw new Error(`arms disagree: ${String(rows)} vs ${String(handRows)}`);
  }

  console.log(
    [
      String(nodes).padStart(7),
      String(fanout).padStart(7),
      String(nodes * fanout).padStart(9),
      eng.toFixed(1).padStart(9),
      ((eng * 1e6) / rows).toFixed(0).padStart(8),
      hnd.toFixed(1).padStart(6),
      ((hnd * 1e6) / rows).toFixed(0).padStart(8),
      String(rows).padStart(7),
    ].join(' '),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
}

console.log(
  '\n⚠️ ns/row RISING with edge count is the finding. Compare ARM=on against ARM=off: if `off` is\n' +
    '   FASTER at 1M edges, item 1940 shipped a regression at scale and its gate needs a size term.',
);
