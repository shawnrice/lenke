/**
 * **DOES A HOP REALLY DOUBLE THE `sum`/`max` GAP, OR DID I COMPARE TWO FIXTURES? (item 2354)**
 *
 * Item 2353 read `bun run bench` as **sum/max = 3.0x on a hop** (287.9 against 96.1 ms) and contrasted it
 * with items 2335/2336's **1.58x on a scan** (25.37 against 16.07 ns a vertex). But the bench's two rows
 * use DIFFERENT FIXTURES — `sum over a hop` runs on `graphDoc` and `sum over a scan` on `nodesDoc` — and my
 * 1.58x came from a third fixture of my own. **The hop pair's ratio is clean; the comparison BETWEEN the
 * hop and the scan is not.**
 *
 * So all four arms run here on ONE fixture: the same vertices, the same property, the same graph. If the
 * hop really doubles the gap, sum/max is ~1.6x on the scan arms and ~3x on the hop arms within this
 * process. If it does not, the difference was the fixtures and item 2353's nomination dissolves.
 *
 * The row counts differ between scan and hop by construction (one row a vertex against one a edge), so
 * the comparison that matters is sum/max WITHIN each pair — not scan against hop.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'scanSum';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['Person'], properties: { k: i % 97 } });
}

const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['KNOWS'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

const TEXTS = {
  /* THE SCAN PAIR — `sum` has no streaming fold, `max` has one (items 2335/2336). */
  scanSum: 'MATCH (a:Person) RETURN sum(a.k) AS c',
  scanMax: 'MATCH (a:Person) RETURN max(a.k) AS c',
  /* THE HOP PAIR, the bench's own two queries, on this same graph. */
  hopSum: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN sum(b.k) AS c',
  hopMax: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN max(b.k) AS c',
  /* A hop COUNT, as the floor showing what the hop costs before any aggregate. */
  hopCount: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b.k) AS c',
};

const text = TEXTS[ARM];
const run = () => query(graph, text).length;

for (let w = 0; w < 20; w += 1) {
  run();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 20_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
/* Rows VISITED, which differs between the pairs: a vertex each on the scan, an edge each on the hop. */
const visited = ARM.startsWith('scan') ? NODES : NODES * FAN;

console.log(
  `  ARM=${ARM.padEnd(9)} ${(med * 1000).toFixed(1).padStart(8)} us  ${((med * 1_000_000) / visited).toFixed(2).padStart(7)} ns/visited  rows=${run()}`,
);
