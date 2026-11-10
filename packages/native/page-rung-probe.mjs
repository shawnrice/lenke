import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
/**
 * WHAT DOES A BARE `LIMIT` COST, WHEN IT COSTS THE PROJECTION RUNG? (item 1775)
 *
 * Item 1775's rung census found a monotonicity violation. The projection rungs decline a page
 * outright (`proj.skip !== undefined || proj.limit !== undefined` -> `return null`), but
 * `foldPageIntoReturn` folds an ORDER BY + LIMIT into a top-K and clears it. So:
 *
 *     MATCH (n:P) RETURN n.k                        -> nodeProjection
 *     MATCH (n:P) RETURN n.k LIMIT 10               -> GENERAL PATH     <- adding a LIMIT loses it
 *     MATCH (n:P) RETURN n.k ORDER BY n.k LIMIT 10  -> nodeProjection   <- adding a SORT regains it
 *
 * Adding the ORDER BY is strictly MORE work and it is the spelling that keeps the fast route. The
 * bare `LIMIT` is the shape that should be CHEAPEST — it may stop after ten rows — and it is the
 * one on the general pipeline. The same holds for the one-hop projection rung.
 *
 * ⚠️ WHETHER THAT COSTS ANYTHING IS THE OPEN QUESTION, and the reason is specific: the general path
 * may well short-circuit on the limit and never materialize the other 199,990 rows, in which case
 * the route is irrelevant and this is a finding about a comment, not about speed. That is what this
 * measures. A route difference is NOT a perf finding until timed — `CLOSED.md` records a 5000x
 * "spelling gap" nearly filed at item 1375 that was a correct decline.
 *
 * ## Method, and which rules it is obeying
 *
 * - **ONE SHAPE PER PROCESS** (`SHAPE=` env). The thing under test IS route dispatch, and CLAUDE.md
 *   records that a two-shape in-process A/B flatters any change that redistributes call sites —
 *   item 762 measured controls moving 1.56x in the change's favour for exactly this reason.
 * - **p25 per process, median across processes, arms interleaved** — item 1367's prescription. The
 *   noise on a 200k row is PROCESS-level, so no within-process estimator removes it, and a MEAN
 *   inverts verdicts. The driver (`page-rung-ab.sh`) does the interleaving.
 * - **14 reps, drop the first three as warm-up** — they are visibly the JIT tiering up.
 * - **THE ROW COUNT IS ASSERTED.** A `LIMIT 10` arm returning 10 rows where the no-page arm returns
 *   200,000 is not an A/B at all, so the arms are grouped so that only comparable ones are compared,
 *   and every arm states its own expected count. An arm that silently returned the wrong number of
 *   rows would otherwise be a fast reading rather than a failure.
 * - **A CONTROL THE PAGE CANNOT REACH**: `count` keeps `countShortcut` with a `LIMIT` on it (the
 *   census confirmed), so if it moves between arms the machine moved, not the route.
 */

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const SHAPE = process.env.SHAPE ?? 'list';
const LIMIT = Number(process.env.LIMIT ?? 10);

const g = new Graph();
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 997, n: 20 + (i % 60) } }),
  );
}

// One out-edge per node, so the hop shapes have a fixed row count equal to NODES.
//
// ⚠️ THE TARGET IS `Math.floor(i / 7)`-SHIFTED, NOT `(i * 7) % NODES`. CLAUDE.md records the
// mechanical defect that `to = (a*k + b) % N` is invariant under `k -> k + N`, so a whole family of
// this repo's generators piled every one of a vertex's edges onto one target. At FANOUT 1 that is
// harmless (degree 1 cannot branch), but writing it the safe way costs nothing and the probe asserts
// the distinct-endpoint count below regardless.
for (let i = 0; i < NODES; i += 1) {
  g.addEdge({ id: `e${i}`, from: verts[i], to: verts[(i * 31 + 17) % NODES], labels: ['E'] });
}

// The fixture's own statistics, not just its output (CLAUDE.md): an answer invariant to the thing
// you varied cannot validate the fixture.
{
  const seen = new Set();

  for (let i = 0; i < NODES; i += 1) {
    seen.add((i * 31 + 17) % NODES);
  }

  if (seen.size < NODES * 0.5) {
    throw new Error(`degenerate fixture: ${seen.size} distinct endpoints over ${NODES} edges`);
  }
}

/**
 * Each arm names its query AND the row count it must return. Arms are grouped: only arms with the
 * same `rows` are comparable to each other, and the groups are stated in the driver's output rather
 * than left for a reader to infer.
 */
const SHAPES = {
  // --- group "all rows": the no-page baselines ------------------------------
  list: { q: `MATCH (n:P) RETURN n.k`, rows: NODES, group: 'all' },
  hoplist: { q: `MATCH (a:P)-[:E]->(b) RETURN b.k`, rows: NODES, group: 'all' },

  // --- group "paged": LIMIT, with and without the ORDER BY ------------------
  limit: { q: `MATCH (n:P) RETURN n.k LIMIT ${LIMIT}`, rows: LIMIT, group: 'paged' },
  orderlimit: {
    q: `MATCH (n:P) RETURN n.k ORDER BY n.k LIMIT ${LIMIT}`,
    rows: LIMIT,
    group: 'paged',
  },
  hoplimit: { q: `MATCH (a:P)-[:E]->(b) RETURN b.k LIMIT ${LIMIT}`, rows: LIMIT, group: 'paged' },
  hoporderlimit: {
    q: `MATCH (a:P)-[:E]->(b) RETURN b.k ORDER BY b.k LIMIT ${LIMIT}`,
    rows: LIMIT,
    group: 'paged',
  },
  // An OFFSET with no LIMIT returns NODES - LIMIT rows, so it is its own group.
  offset: { q: `MATCH (n:P) RETURN n.k OFFSET ${LIMIT}`, rows: NODES - LIMIT, group: 'offset' },

  // --- group "control": keeps its rung WITH the page on it ------------------
  count: { q: `MATCH (n:P) RETURN count(*) AS c LIMIT 1`, rows: 1, group: 'control' },
  hopcount: { q: `MATCH (a:P)-[:E]->(b) RETURN count(*) AS c LIMIT 1`, rows: 1, group: 'control' },
};

const arm = SHAPES[SHAPE];

if (arm === undefined) {
  console.error(`unknown SHAPE=${SHAPE}; known: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const series = [];
let got = -1;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  const rows = query(g, arm.q);

  series.push(performance.now() - t);
  got = rows.length;

  if (got !== arm.rows) {
    throw new Error(`${SHAPE}: returned ${got} rows, expected ${arm.rows} — not the shape claimed`);
  }
}

const kept = series.slice(3).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(kept.length * f))];

console.log(
  JSON.stringify({
    shape: SHAPE,
    group: arm.group,
    nodes: NODES,
    rows: got,
    p25: Number(at(0.25).toFixed(3)),
    median: Number(at(0.5).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
