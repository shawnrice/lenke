// Item 1949 — WHAT IS LEFT ON `FILTER` AFTER A HOP, on a realistic graph?
//
// Item 1943's `MIXED=1` diff: `MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x` goes
// **61.44 ms to 297.04, 4.83x** when one isolated off-label vertex makes `T` non-vacuous. ⚠️ Item
// 1947 bounded that sweep's inflation at 1.2x-1.3x, so 4.83x survives it comfortably — but the
// number itself comes from a 48-shape sweep, so this re-measures it ISOLATED, one shape per
// process, with a hand ceiling.
//
// 🔑 THE CEILING IS ONE EDGE PASS: both endpoint labels, then the predicate, then collect. There is
// nothing a filtered hop can skip — every surviving row is emitted — so unlike the DISTINCT at item
// 1945 there is no short-circuit to look for, and unlike item 1948 there is no first-seen-order
// contract, because a FILTER emits rows rather than groups.
//
//     bun filterhop-probe-1949.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const THRESH = 5;

const Q = 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x';

const build = (mixed) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } });
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

  if (mixed) {
    g.addVertex({ id: 'off', labels: ['Z'], properties: { n: 0 } });
  }

  return g;
};

/** The ceiling: one edge pass, both labels, the predicate, one row per survivor. */
const handFilterPass = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (!edge.from.labels.has('T')) {
        continue;
      }

      const far = edge.to;

      if (!far.labels.has('T')) {
        continue;
      }

      const v = far.properties.n;

      if (v > THRESH) {
        rows.push({ x: v });
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

console.log(`${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS}.\n`);
console.log('mode          engine   ns/vis     HAND   ns/vis    rows   agree');
console.log('-'.repeat(64));

for (const mixed of [false, true]) {
  const g = build(mixed);
  const [eng, engRows] = time(() => query(g, Q, { p0: THRESH }).length);
  const [hnd, hndRows] = time(handFilterPass(g));
  const visits = NODES * FANOUT;

  console.log(
    [
      (mixed ? 'MIXED' : 'homogeneous').padEnd(12),
      eng.toFixed(1).padStart(8),
      ((eng * 1e6) / visits).toFixed(0).padStart(8),
      hnd.toFixed(1).padStart(8),
      ((hnd * 1e6) / visits).toFixed(0).padStart(8),
      String(engRows).padStart(7),
      String(engRows === hndRows).padStart(7),
    ].join(' '),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
}
