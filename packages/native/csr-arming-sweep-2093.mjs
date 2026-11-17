/*
 * Item 2093 — the CSR arming's cost as a function of READS PER TOPOLOGY VERSION.
 *
 * ⚠️⚠️ `csrAskedBefore` builds on the SECOND ask of a topology version, so a one-shot reader never
 * pays for a build. The hypothesis was that reading TWICE recovers the cached speed. It does the
 * OPPOSITE — 17.33 ms/read against one-read's 7.03 — because the second ask BUILDS and the next write
 * DISCARDS it unused. This sweeps the ratio to find the shape of that curve.
 *
 * 🔑 EVERY ARM DOES THE SAME NUMBER OF READS (`TOTAL`), so only the write frequency varies. An arm
 * doing more reads would measure more work and hide the per-read figure that matters.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 60000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const TOTAL = Number(process.env.TOTAL ?? 24);
const READ = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c';

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

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, ${TOTAL} reads in every arm\n`);
console.log(`  ${'reads/write'.padStart(11)}  ${'total ms'.padStart(9)}  ${'ms/read'.padStart(8)}`);

let best = Infinity;
let worst = 0;

for (const perVersion of [1, 2, 3, 4, 6, 12, 24]) {
  const g = build();

  // Warm so the first cycle is not paying the initial build.
  query(g, READ);
  query(g, READ);

  /*
   * ⚠️⚠️ **AT LEAST `MIN_WRITES` TOPOLOGY VERSIONS PER ARM, AND ITEM 2094 IS WHY.** With `TOTAL`
   * reads split by `perVersion`, the 24-reads arm got exactly ONE write — so a policy that predicts
   * from the PREVIOUS version's ask count never converged, and its figure was the 2-ask warm-up's
   * verdict rather than the policy's. A fixed-threshold policy has no state and cannot show that, so
   * the old shape was adequate for item 2093 and silently wrong for this one.
   *
   * 🔑 The read count per arm is therefore `MIN_WRITES * perVersion` where that exceeds `TOTAL`, and
   * the per-READ figure is what is compared — so more reads in an arm do not flatter it.
   */
  const MIN_WRITES = Number(process.env.MIN_WRITES ?? 5);
  const writes = Math.max(MIN_WRITES, Math.floor(TOTAL / perVersion));
  let sink = 0;
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
      sink += query(g, READ)[0].c;
    }
  }

  const ms = performance.now() - t0;
  const perRead = ms / (writes * perVersion);

  best = Math.min(best, perRead);
  worst = Math.max(worst, perRead);

  if (sink === 0) {
    throw new Error('no rows counted — the read is not seeing the graph');
  }

  console.log(
    `  ${String(perVersion).padStart(11)}  ${ms.toFixed(1).padStart(9)}  ${perRead.toFixed(2).padStart(8)}`,
  );
}

console.log(`\n  worst/best per-read: ${(worst / best).toFixed(2)}x`);
