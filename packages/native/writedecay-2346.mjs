/**
 * **DOES A TOPOLOGY WRITE COST *THE NEXT* READ, OR *EVERY* LATER READ? (item 2346)**
 *
 * `docs/guides/query-cost.md` says a topology write "invalidates the adjacency structures the next read
 * would have used, so **the next read** rebuilds them", and prices it at +1.1 to +1.5 ms. That wording
 * promises the cost is paid ONCE and then amortized.
 *
 * **But `CLAUDE.md` records the opposite for the native engine**: *"`rebuild_csr` runs only at LOAD,
 * and every adjacency write clears `csr_fresh` with nothing to re-arm it, so ONE `add_edge` demotes EVERY
 * later read for the rest of the session (the read after the next one is just as slow)"* — and that the
 * penalty is *"proportional to how selective the queried edge type is"*, reaching **24.07x at 1 edge in
 * 50**.
 *
 * Those cannot both describe the TS engine's behaviour, and the difference is the whole advice: a
 * one-off cost is a reason to batch writes, while a permanent demotion is a reason to rebuild or restart.
 * **The test is simply to time several consecutive reads after a single write.** If only the first is
 * slow the guide is right; if all of them are, it understates the cost badly.
 *
 * The reads must be IDENTICAL and the write must happen ONCE, so any decay is the engine's and not the
 * fixture's. The per-read series is printed rather than a median, because the shape across reads IS the
 * answer (`floor-arm-must-take-same-route` records min-of-N hiding exactly this kind of step).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const READS = Number(process.env.READS ?? 8);
const WRITE = process.env.WRITE ?? 'edge';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

/*
 * TWO EDGE TYPES WITH VERY DIFFERENT SELECTIVITY, because CLAUDE.md says the penalty scales with it:
 * `E` on 49 of every 50 edges and `RARE` on 1 in 50. A hop over `RARE` is the shape it says suffers most.
 */
const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: [j % 50 === 0 ? 'RARE' : 'E'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

/*
 * **A PROJECTION, NOT A COUNT, AND THE FIRST VERSION GOT THIS WRONG.** `MATCH (a:N)-[:RARE]->(b)
 * RETURN count(*)` is a CLOSED FORM — items 2286/2303/2309 each priced an unfiltered hop count at ~24 ns,
 * visiting no edge at all — so every reading came back 0.00 ms and the probe measured nothing. A
 * projection must walk the adjacency, which is the structure a topology write invalidates.
 */
const read = () => query(graph, 'MATCH (a:N)-[:RARE]->(b) RETURN b.k AS k').length;

/* Warm, so the series below is not measuring a cold compile. */
for (let w = 0; w < 20; w += 1) {
  read();
}

const timeRead = () => {
  const t0 = performance.now();
  const n = read();

  return [performance.now() - t0, n];
};

const before = [];

for (let r = 0; r < READS; r += 1) {
  before.push(timeRead()[0]);
}

/* ONE write, of the kind under test. */
if (WRITE === 'edge') {
  graph.addEdge({
    id: 'extra',
    from: graph.getVertexById('v0'),
    to: graph.getVertexById('v1'),
    labels: ['E'],
    properties: {},
  });
} else if (WRITE === 'vertex') {
  graph.addVertex({ id: 'extraV', labels: ['N'], properties: { k: 1 } });
} else {
  /* The CONTROL: a property write, which the guide says costs nothing. */
  query(graph, 'MATCH (n:N) WHERE n.k = 5 SET n.k = 5 RETURN count(*) AS c');
}

const after = [];
let rows = 0;

for (let r = 0; r < READS; r += 1) {
  const [ms, n] = timeRead();

  after.push(ms);
  rows = n;
}

const f = (xs) => xs.map((x) => x.toFixed(2)).join(' ');

console.log(`  WRITE=${WRITE.padEnd(8)} rows=${rows}`);
console.log(`    before: ${f(before)}`);
console.log(`    after : ${f(after)}`);
