/*
 * Item 2105 — does `chainProjection` still EARN its keep where it has no seek to lose to?
 *
 * ⚠️⚠️ **THIS IS THE CHECK THAT MATTERS, NOT THE HEADLINE.** The gate hands the query to the orienting
 * matcher when the far node carries a genuine index seek. This rung's DOCUMENTED wins are on fixtures
 * with no such seek — item 1820 measured **5.8x** for a three-hop `RETURN DISTINCT` (418.6 ms against
 * 72.2) and item 1843 another 2.69x. A gate that declined there would hand back 5.8x to buy 934x
 * somewhere else.
 *
 * 🔑 SO EVERY SHAPE HERE IS UNINDEXED, and the arms are the gate LIVE against the gate KILLED. If the
 * gate is correctly narrow, the two are the SAME — the rung keeps answering and nothing is lost.
 *
 * ⚠️ `INDEXED=1` runs the same shapes WITH the index, where LIVE should be dramatically faster. Running
 * both is what separates "the gate never fires" from "the gate fires in the right place".
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 60000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const INDEXED = process.env.INDEXED === '1';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, tag: `t${i % 2000}` } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

if (INDEXED) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });
}

const C3 = '(a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P)';

const shapes = {
  /* 🔑 ITEM 1820'S OWN SHAPE — the 5.8x. A far predicate, DISTINCT, three hops. */
  '3h DISTINCT (1820)': `MATCH ${C3} WHERE b.tag = $t RETURN DISTINCT a.n AS n`,
  '3h rows': `MATCH ${C3} WHERE b.tag = $t RETURN a.n AS n`,
  /* ⚠️ NO far predicate at all — the gate cannot fire, so this is a CONTROL for the harness. */
  '3h rows, no predicate (control)': `MATCH ${C3} RETURN a.n AS n`,
  '3h folded min': `MATCH ${C3} WHERE b.tag = $t RETURN min(a.n) AS m`,
  '3h grouped count': `MATCH ${C3} WHERE b.tag = $t RETURN a.n AS k, count(*) AS c`,
};

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { t: 't7' });
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], n: rows.length };
};

console.log(
  `  NODES=${NODES} FANOUT=${FANOUT} INDEXED=${INDEXED ? 1 : 0}, median of ${REPS}, arm ${process.env.ROUND ?? '?'}\n`,
);

for (const [name, q] of Object.entries(shapes)) {
  const r = timeIt(q);

  console.log(`  chain  ${name.padEnd(32)} ${r.ms.toFixed(2).padStart(10)} ms/rep   rows=${r.n}`);
}
