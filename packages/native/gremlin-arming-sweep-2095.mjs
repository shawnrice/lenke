/*
 * Item 2095 — does GREMLIN's `seenBefore` have the cliff item 2093/2094 found in GQL's arming?
 *
 * ⚠️ `second-ask.ts`'s `seenBefore` is STRUCTURALLY IDENTICAL to the policy item 2094 replaced: a
 * `Set` per topology version, armed on the second ask. So the cliff SHOULD transfer — but "should"
 * is not a measurement, and the two engines build different structures from different rungs, so the
 * build cost and the per-read saving (the two numbers that set the break-even) may differ.
 *
 * 🔑 EVERY ARM DOES THE SAME NUMBER OF READS and gets at least `MIN_WRITES` topology versions — item
 * 2094's instrument fault was an arm with ONE write, where a history-based policy cannot converge and
 * its figure is the warm-up's verdict rather than the policy's.
 */
import { Graph } from '@lenke/core';
import { out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 60000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const TOTAL = Number(process.env.TOTAL ?? 24);
const MIN_WRITES = Number(process.env.MIN_WRITES ?? 5);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97 } });
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

  return g;
};

/* A hop-values read: the shape `hop-values-csr.ts` serves off a CSR, so a dropped generation shows. */
const read = (g) => toArray(traversal(V(), out('E'), values('n')), g).length;

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, >=${MIN_WRITES} versions per arm\n`);
console.log(`  ${'reads/write'.padStart(11)}  ${'total ms'.padStart(9)}  ${'ms/read'.padStart(8)}`);

let best = Infinity;
let worst = 0;

for (const perVersion of [1, 2, 3, 4, 6, 12, 24]) {
  const g = build();

  read(g);
  read(g);

  const writes = Math.max(MIN_WRITES, Math.floor(TOTAL / perVersion));
  let rows = 0;
  const t0 = performance.now();

  for (let w = 0; w < writes; w += 1) {
    g.addEdge({
      id: `w${w}`,
      from: g.getVertexById(`v${w}`),
      to: g.getVertexById(`v${w + 1}`),
      labels: ['E'],
      properties: {},
    });

    for (let r = 0; r < perVersion; r += 1) {
      rows += read(g);
    }
  }

  const ms = performance.now() - t0;
  const perRead = ms / (writes * perVersion);

  best = Math.min(best, perRead);
  worst = Math.max(worst, perRead);

  // ⚠️ The reads must SEE the graph, or every timing is of an empty walk.
  if (rows === 0) {
    throw new Error('no rows read — the traversal is not seeing the graph');
  }

  console.log(
    `  ${String(perVersion).padStart(11)}  ${ms.toFixed(1).padStart(9)}  ${perRead.toFixed(2).padStart(8)}`,
  );
}

console.log(`\n  worst/best per-read: ${(worst / best).toFixed(2)}x`);
