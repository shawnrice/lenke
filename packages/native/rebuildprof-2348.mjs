/**
 * **WHAT DOES THE READ AFTER A TOPOLOGY WRITE SPEND 2.42 ms ON? (item 2348)**
 *
 * Item 2346 measured one `addEdge` followed by eight identical typed-hop projections: read 1 cost 0.84 ms,
 * **read 2 cost 2.42 ms**, and reads 3-8 returned to a 0.09 ms baseline. **A 27x spike**, on the
 * interleaved read/write shape a serving application hits constantly — and the serving bench's
 * `interleaved:` rows are among its slowest. **Nothing has profiled it.**
 *
 * A single 2.42 ms read yields too few samples to attribute, so this probe repeats the
 * write-then-read-twice cycle many times and profiles the whole loop. The rebuild then dominates by
 * construction, which is what makes the profile readable.
 *
 * `ARM=steady` is the CONTROL: the same reads with NO writes between them, so any frame that appears in
 * both is the read's own work and not the rebuild's. **Without it a frame list is a description of a hop
 * projection, not of an invalidation** — `frame-attribution-trap` and this stretch's repeated lesson that a
 * control is what makes a profile mean anything.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const CYCLES = Number(process.env.CYCLES ?? 300);
const ARM = process.env.ARM ?? 'churn';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

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

/* A PROJECTION, not a hop count — a count is closed form and visits no edge (item 2346's own trap). */
const read = () => query(graph, 'MATCH (a:N)-[:RARE]->(b) RETURN b.k AS k').length;

for (let w = 0; w < 20; w += 1) {
  read();
}

let extra = 0;
const t0 = performance.now();

for (let c = 0; c < CYCLES; c += 1) {
  if (ARM === 'churn') {
    /* ONE edge per cycle, each with a fresh id so nothing is overwritten. */
    graph.addEdge({
      id: `x${extra++}`,
      from: graph.getVertexById('v0'),
      to: graph.getVertexById('v1'),
      /*
       * **WHICH TYPE THE WRITE TOUCHES (item 2349).** The read below hops `:RARE`, so a write to `:E`
       * cannot change its answer. If invalidation is GLOBAL the read pays anyway, and type-scoped
       * invalidation is a bounded lever far cheaper than making the rebuild incremental. `WTYPE=RARE`
       * writes the type the read actually uses, as the comparison.
       */
      labels: [process.env.WTYPE ?? 'E'],
      properties: {},
    });
  }

  /* TWO reads per cycle, because item 2346 showed the cost spans exactly two. */
  read();
  read();
}

const total = performance.now() - t0;

console.log(
  `  ARM=${ARM.padEnd(7)} WTYPE=${(process.env.WTYPE ?? 'E').padEnd(5)} ${total.toFixed(0).padStart(6)} ms  ${(total / CYCLES).toFixed(2)} ms/cycle  edgesAdded=${extra}  rowsNow=${read()}`,
);
