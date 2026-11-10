import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/**
 * WHY DOES AN `OFFSET` WITH NO `LIMIT` COST 7.9x THE UNPAGED PROJECTION? (item 1775)
 *
 * The rung census found that a skip-only page declines every projection rung, and
 * `page-rung-probe.mjs` priced that at **7.9x** — 49.078 ms against 6.194 for TEN FEWER ROWS, five
 * interleaved processes per arm, ranges nowhere near overlapping, `count` control flat at 0.001.
 * It is **5.4x at 20,000 and 7.9x at 200,000**, so it grows with N.
 *
 * ⚠️ AND THE SIBLING FINDING WENT THE OTHER WAY, WHICH IS WHY THIS ONE NEEDED A PROFILE RATHER THAN
 * A PATCH. A bare `LIMIT 10` also declines every rung, and there the decline is CORRECT: the general
 * pipeline is lazy, so it stops after ten rows and measures 0.035 ms against the rung's 12.5 on the
 * `ORDER BY … LIMIT` spelling — 360x in the general path's favour. Same decline, opposite verdict,
 * decided only by whether the page lets the pipeline stop early. A skip-only page does not: the
 * engine must still emit N-10 rows, so there is no laziness to collect and the rung's loss is pure.
 *
 * This profiles the skip-only arm against the unpaged arm that DOES take the rung, so the frames
 * name what the general path is paying for. Both emit ~200,000 rows, which is what makes the two
 * profiles comparable at all.
 *
 *     D=$SCRATCH/offsetprof
 *     PROF_OUT=$D/offset.cpuprofile node offset-rung-profile.mjs offset
 *     PROF_OUT=$D/list.cpuprofile   node offset-rung-profile.mjs list
 *     node runtime-profile-analyze.mjs $D
 *
 * ⚠️ WINDOWED, via the shared `profileWindow`. `--cpu-prof` profiles to exit, so at 200,000 nodes
 * the fixture build swamps the query and INVERTS the ranking — item 1362 put `getVertexById` and
 * `commitElementLabels` at the top of every shape that way, all of them the load, none of them the
 * query. The fixture is built before the window opens.
 *
 * ⚠️ AND THE ROW COUNT IS ASSERTED INSIDE THE WINDOW, because a profile of an arm that silently
 * returned 10 rows instead of 199,990 would be a confident attribution of the wrong work.
 */
import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? Number(process.argv[3] ?? 40));
const SHAPE = process.argv[2] ?? 'offset';
const SKIP = Number(process.env.SKIP ?? 10);

const SHAPES = {
  offset: { q: `MATCH (n:P) RETURN n.k OFFSET ${SKIP}`, rows: NODES - SKIP },
  list: { q: `MATCH (n:P) RETURN n.k`, rows: NODES },
  // The hop twin, to show whether the cause is shared with `hopProjection` or local to the node one.
  hopoffset: { q: `MATCH (a:P)-[:E]->(b) RETURN b.k OFFSET ${SKIP}`, rows: NODES - SKIP },
  hoplist: { q: `MATCH (a:P)-[:E]->(b) RETURN b.k`, rows: NODES },
};

const arm = SHAPES[SHAPE];

if (arm === undefined) {
  console.error(`unknown shape ${SHAPE}; known: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new Graph();
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 997, n: 20 + (i % 60) } }),
  );
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({ id: `e${i}`, from: verts[i], to: verts[(i * 31 + 17) % NODES], labels: ['E'] });
}

const t0 = performance.now();
const sink = await profileWindow(process.env.PROF_OUT, () => {
  let acc = 0;

  for (let r = 0; r < REPS; r += 1) {
    const rows = query(g, arm.q);

    if (rows.length !== arm.rows) {
      throw new Error(`${SHAPE}: ${rows.length} rows, expected ${arm.rows} — profiled wrong work`);
    }

    acc += rows.length;
  }

  return acc;
});

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    reps: REPS,
    rowsPerRep: arm.rows,
    sink,
    msPerRep: Number(((performance.now() - t0) / REPS).toFixed(3)),
    out: process.env.PROF_OUT ?? '(not profiled)',
  }),
);
