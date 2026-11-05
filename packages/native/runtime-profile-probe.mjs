/**
 * Find UNPRICED hot code in the TS engine, mechanically. Paired with `runtime-profile-analyze.mjs`,
 * which does the cross-check against `CLOSED.md` and the audit.
 *
 * Item 919's lesson was that a targeted timer can only confirm a site you already suspect, and a
 * CPU profile found in one run what four hand-placed timers had missed. That profile covered the
 * COMPILE path; this one covers the RUNTIME path.
 *
 * ONE SHAPE PER PROCESS (item 762): the shape comes from argv, so no other query shape pollutes
 * the dispatch sites of the one being measured.
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=<shape>.cpuprofile \
 *          runtime-profile-probe.mjs <shape> <n>
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.argv[2] ?? 'hopfilter';
const N = Number(process.argv[3] ?? 2000);
/**
 * ⚠️ SIZE IS A SEPARATE QUESTION, not a detail. CLAUDE.md's first rule for trusting a number is to
 * sweep it: cache-resident and not are different regimes and the transition is between 200k and 1M
 * elements. Items 1358-1361 screened every surface at 20,000 — entirely inside cache — so a verdict
 * from them is a verdict about the cache-resident regime only, which item 1362 is for.
 */
const NODES = Number(process.env.NODES ?? 20000);

/** One fixture for every shape, so a difference between shapes is the shape and not the data. */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3) % NODES}`),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The row CLOSED.md records at 32x native.
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // A projection with ORDER BY + LIMIT, the serving shape.
  sortedpage: 'MATCH (n:P) WHERE n.k < 50 RETURN n.s AS s ORDER BY s LIMIT 10',
  // A grouped aggregate.
  grouped: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  // A point lookup, the hot serving read.
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  // The control: no pattern at all, so none of the match/expand machinery runs.
  control: 'RETURN 1 AS one',

  // ── Item 1473: shapes the screen never covered ──────────────────────────────────────────────
  //
  // The five above are all SINGLE-PATTERN. The screen's record says "no unpriced frame survives",
  // and that is true of the surface it had — but a real query routinely joins two patterns, keeps
  // an optional side, de-duplicates, or asks a subquery, and none of those machinery was ever in a
  // profile. The ZERO-mentions signal is one-shot per frame, so a frame these reach has never had
  // its shot.
  //
  // Each is written to return rows on the probe's own fixture (one out-edge per vertex, `k = i % 97`,
  // `n = i`), and the probe asserts a non-empty result, so a shape that quietly matched nothing
  // would fail rather than profile the empty path.

  // A two-pattern JOIN over a shared variable — the shape a hash join exists for.
  join: 'MATCH (a:P)-[:E]->(b:P) MATCH (b)-[:E]->(c:P) WHERE a.k = 5 RETURN count(*) AS c',
  // The optional side, which must preserve unmatched left rows.
  optional: 'MATCH (a:P) WHERE a.k = 5 OPTIONAL MATCH (a)-[:E]->(b:P) RETURN count(*) AS c',
  // DISTINCT over a low-cardinality key: 97 groups from NODES rows.
  distinct: 'MATCH (n:P) RETURN DISTINCT n.k AS k',
  // An EXISTS subquery per row — correlated, so it runs NODES times.
  existssub: 'MATCH (a:P) WHERE a.k = 5 AND EXISTS { MATCH (a)-[:E]->(b:P) } RETURN count(*) AS c',
  // A wide projection: five property reads per row, no aggregation to hide them behind.
  wideproj: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b, n.s AS c, n.k AS d, n.n AS e',
  // Set operation over two scans.
  unioned:
    'MATCH (n:P) WHERE n.k = 5 RETURN n.n AS x UNION ALL MATCH (n:P) WHERE n.k = 6 RETURN n.n AS x',
  // ⚠️ A SEPARATE SHAPE, because `UNION` and `UNION ALL` take DIFFERENT branches of `combineRows`:
  // ALL concatenates, plain UNION dedups. Item 1473's fix removes a wasted key pass from BOTH, so
  // measuring only one would leave half the change unmeasured.
  unioneddistinct:
    'MATCH (n:P) WHERE n.k = 5 RETURN n.n AS x UNION MATCH (n:P) WHERE n.k = 6 RETURN n.n AS x',
  // The control for both: EXCEPT genuinely NEEDS the right-side keys, so the fix cannot reach it.
  excepted:
    'MATCH (n:P) WHERE n.k < 10 RETURN n.n AS x EXCEPT MATCH (n:P) WHERE n.k = 6 RETURN n.n AS x',
  // ⚠️ MATCH THE FIXTURE TO THE CLAIM. The two shapes above filter to ~2,000 rows a side, and item
  // 1473's waste is a key pass over the RIGHT SIDE — so at that width it is ~2% and sits under this
  // bench's noise floor, which an A/B duly reported as a null. These scan unfiltered, so the right
  // side is every vertex and the wasted pass is proportional to NODES.
  unionedbig: 'MATCH (n:P) RETURN n.n AS x UNION ALL MATCH (n:P) RETURN n.n AS x',
  unionedbigdistinct: 'MATCH (n:P) RETURN n.n AS x UNION MATCH (n:P) RETURN n.n AS x',

  // ⚠️ PROJECTION WIDTH IS ITS OWN DIMENSION (item 1477). Row construction in the node-projection
  // walk does `{}` + one dynamic-key store per column, so its cost is not linear in width — a micro
  // over 300,000 rows measured the template-clone alternative at noise (width 2), 1.52x (width 5)
  // and 1.14x (width 10). A change here must be reported against ALL of these, because quoting the
  // width-5 number alone would describe a shape narrower queries never take.
  proj1: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a',
  proj2: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b',
  proj10:
    'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b, n.s AS c, n.k AS d, n.n AS e, ' +
    'n.s AS f, n.k AS g, n.n AS h, n.s AS i, n.k AS j',
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

// The fixture is built BEFORE the profile window opens, so the load is never in the profile. With
// `PROF_OUT` unset this is an ordinary unwindowed run and `--cpu-prof` still works.
const g = build();
let sink = 0;
const t0 = performance.now();

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < N; i += 1) {
    sink += query(g, q).length;
  }

  return sink;
});

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently returned nothing would profile the
// error path and look like a result.
if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${N} runs — the profile would be of nothing`);
}

console.log(JSON.stringify({ shape: SHAPE, n: N, ms: Number(ms.toFixed(1)), sink }));
