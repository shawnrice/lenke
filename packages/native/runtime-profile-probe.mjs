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
const FANOUT = Number(process.env.FANOUT ?? 1);
const STRIDE = process.env.STRIDE ?? 'sequential';

if (STRIDE !== 'sequential' && STRIDE !== 'scattered') {
  throw new Error(`STRIDE must be sequential|scattered, got ${STRIDE}`);
}

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

  // ⚠️ FANOUT=1 IS SPARSE, AND THIS PROBE HAD NO KNOB FOR IT (item 1488). CLAUDE.md's own rule:
  // "One edge per node is sparse — per-edge costs scale with the edge:node ratio, per-node costs do
  // not", with a change that measured flat at 1:1 and -5% at 5:1. So the unpriced-frame screen has
  // only ever seen a graph where every adjacency bucket holds exactly ONE edge — which is also why
  // the edge STRIDE has no measurable effect here while it moves the Gremlin probe (FANOUT 5) by
  // 3.4x: with one edge per bucket there is no walk order to disturb.
  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      // ⚠️ STRIDE (item 1488). `sequential` adds one out-edge per vertex IN VERTEX ORDER, so every
      // adjacency read during a hop is in build order and the cache misses a real graph pays are
      // absent — item 1486 measured that inflating a hop ratio by 3.6x on the Gremlin side. This
      // probe has only ever run sequentially, so the unpriced-frame screen has only ever seen the
      // cheap regime. `scattered` is the cache-hostile bracket; item 1487's caveat applies, so it
      // prices per-edge cost and says nothing about neighbour diversity.
      from: g.getVertexById(`v${STRIDE === 'scattered' ? (e * 7919) % NODES : i}`),
      to: g.getVertexById(
        `v${
          STRIDE === 'scattered'
            ? ((e % NODES) * 104729 + hop * 977) % NODES
            : (i * 7 + 3 + hop * 2654435761) % NODES
        }`,
      ),
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The row CLOSED.md records at 32x native.
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // ⚠️ HOP-DOMINATED, unlike `hopfilter`. That shape's `a.k = 5` leaves ~2,062 sources out of
  // 200,000, so its cost is the VERTEX SCAN and the hop is a rounding error — which is why raising
  // FANOUT from 1 to 5 moved it only 113.5 → 127.6 ms. This one walks every edge, so per-edge cost
  // is what it measures and FANOUT reaches it (item 1488).
  hopall: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  // ⚠️ AND `hopall` DOES NOT WALK EITHER — a one-hop count is a DEGREE SUM, so it measured 2-8
  // ns/edge, which is the engine's hop-count shortcut and not a traversal. This is the fourth tail
  // in this corpus that answers without doing the work (chain count 1479, values walk 1480/1483,
  // presence count 1485). `hoprows` materializes a row per edge, so nothing can shortcut it and
  // per-edge cost is what it measures.
  hoprows: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k',
  /**
   * ⚠️ Item 1618: TWO HOPS RETURNING ROWS, which `gql-cliff-finder.ts` found has NO rung at all.
   * `hop2/count` is a closed form at 415 us; `hop2/rows` reads PIPELINE at 226.68 ms over 319,972
   * rows — **708 ns a row against the ONE-hop projection's 29**, and against the Gremlin engine's
   * ~50 after items 1614/1617 fused the same shape there. Every two-hop shape in this corpus and in
   * `bench.ts` returns a COUNT, which `countShortcut` answers without walking, so the two-hop
   * row-returning walk has never been profiled — the same blind spot items 1614 and 1615 found on
   * the Gremlin side, in the other engine.
   */
  hop2rows: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k',
  hop2rowswhere: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE c.k = 5 RETURN c.k AS k',
  /**
   * ⚠️ Item 1622: THREE segments returning rows, which no rung answers — items 1619/1620 took two.
   * This is the generic matcher (`walkSegments` + `expand`) with nothing shadowing it, which is what
   * makes it the right profile for the five `expand` call sites item 1621 left open.
   */
  hop3rows: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
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
  // ⚠️ THREE CARDINALITY TIERS, because `valueSet.add`'s cost depends on whether the value is NEW:
  // its primitive branch runs `prim.has(v)` and then `prim.add(v)`, so a DUPLICATE costs one hash
  // and a NEW value costs two. `distinct` above is `i % 97` -- 97 values over NODES rows, so almost
  // every add is a duplicate and the second hash almost never runs. A lever on that second hash is
  // invisible there and was nearly dismissed on it (item 1738).
  //   distincthi  `n: i`           -- UNIQUE, so every add is new: the lever's best case
  //   distinctstr `s: s${i % 1000}` -- 1000 strings: mid cardinality, and a STRING key not a number
  distincthi: 'MATCH (n:P) RETURN DISTINCT n.n AS v',
  distinctstr: 'MATCH (n:P) RETURN DISTINCT n.s AS v',
  // An EXISTS subquery per row — correlated, so it runs NODES times.
  existssub: 'MATCH (a:P) WHERE a.k = 5 AND EXISTS { MATCH (a)-[:E]->(b:P) } RETURN count(*) AS c',
  // A wide projection: five property reads per row, no aggregation to hide them behind.
  wideproj: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b, n.s AS c, n.k AS d, n.n AS e',
  // ⚠️ THE WIDTH LADDER for the nodeProjection rung's direct-read loop (item 1741). All three take
  // the SAME route (verified by reading compileLinear's non-null function fields, not inferred from
  // timing), and they differ only in how many `<nodeVar>.<key>` columns the row loop reads -- 5, 2
  // and 1. A per-COLUMN cost scales across them and a per-ROW cost does not, so the ladder is what
  // separates the two; `narrow1` reads once and cannot gain from removing a repeated read.
  wide2: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b',
  narrow1: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a',
  // ⚠️ THE SIBLING RUNGS of `nodeProjection`, both of which carry the SAME per-column direct-read
  // loop (item 1742). They are reached by adding an ORDER BY, which routes the scan to `topKNodeWalk`
  // (with a LIMIT) or `deferredSortedNodeWalk` (without one) instead. Each gets a WIDE and a NARROW
  // form, because item 1741 established the hoist helps at >1 column and HURTS at 1.
  topkwide: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b, n.s AS c ORDER BY a LIMIT 10',
  topknarrow: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a ORDER BY a LIMIT 10',
  defwide: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a, n.n AS b, n.s AS c ORDER BY a',
  defnarrow: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k AS a ORDER BY a',
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
  // ⚠️ SURFACES THAT HAD NO PROFILE SHAPE AT ALL (item 1565). Items 1473 and 1562 both found their
  // target by ADDING a shape rather than re-reading the ones already here, and the audit that
  // prompted this tick came back clean on every existing shape — so coverage, not depth, is where
  // the remaining signal is. Each of these is a major ISO-GQL surface the screen could not see:
  //
  //   * VAR-LENGTH / quantified paths — the whole `->{m,n}` and `->+` family, and the largest
  //     structural gap: nothing in this probe walked a quantified path.
  //   * ANY SHORTEST — a different matcher entirely (BFS), not the linear walk.
  //   * count(DISTINCT …) and collect() — aggregate paths that build a key set or a list per group,
  //     where `grouped` only ever exercised a tally.
  //   * the scalar aggregate family in one row (sum/avg/min/max).
  //   * an inline CALL subquery, which runs a correlated scope per row.
  //   * a hop with ORDER BY + LIMIT — `sortedpage` is node-only, so the topK walk over a HOP was
  //     unmeasured.
  //   * a string function in a predicate, standing in for the scalar-function dispatch path.
  varlen12: 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c',
  // ⚠️ THE MULTI-HOP COUNTS, which this probe had no shape for (item 1637) — and they are the
  // biggest absolute GQL rows in `bench.ts` on the corrected fixture: `count 3-hop` 471.5 ms at
  // 99.2x native, `count 2-hop` 78.2 at 28.4x. `hopall` covers ONE hop and `hop3rows` three hops
  // YIELDING; a three-hop count is neither, and a count can be answered without materialising rows
  // so it is a different route from `hop3rows` entirely.
  count2: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c',
  count3: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN count(*) AS c',
  varlenplus: 'MATCH (a:P)-[:E]->+(b:P) RETURN count(DISTINCT b) AS c',
  anyshortest: 'MATCH p = ANY SHORTEST (a:P)-[:E]->+(b:P) WHERE a.n = 0 RETURN count(*) AS c',
  countdistinct: 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c',
  collected: 'MATCH (n:P) RETURN collect(n.k) AS ks',
  /**
   * ⚠️ Item 1621: the three shapes `gql-cliff-finder.ts` still flags, each ~20x its NON-hop
   * neighbour. All three walk 80,000 edges where the neighbour touches 20,000 vertices, so the
   * ratio may be honest work — the profile is what says whether it is. Priced per EDGE they are
   * 69-91 ns against the one-hop ROW projection's 46, which is the number to beat.
   */
  groupedhop: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k, count(*) AS c',
  collecthop: 'MATCH (a:P)-[:E]->(b:P) RETURN collect(b.k) AS ks',
  scalaraggs: 'MATCH (n:P) RETURN sum(n.n) AS s, avg(n.n) AS a, min(n.k) AS mn, max(n.k) AS mx',
  // ⚠️ `callinline` HAS NO SCOPE LIST, SO IT IS NON-CORRELATED — the inner `n` is a FRESH variable,
  // not the outer one, which is the scope isolation the ISO form exists for. Item 1565 read that as
  // a quadratic DEFECT; item 1566 retracted it. The body genuinely scans the graph, and running it
  // once per outer row is O(N^2) by specification.
  //
  // It is kept because an empty-scope body is LOOP-INVARIANT, which item 1566 then exploited:
  // 1358.0 -> 4.7 ms at N=1000, 289x. So this row is now the regression guard on that hoist, and
  // `callscoped` beside it is the genuinely correlated shape that had no coverage at all.
  callinline: 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t',
  callscoped:
    'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t',
  topkhop: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k ORDER BY k LIMIT 10',
  // A LITERAL, not a `$param`: this probe calls `query(g, q)` with no params object, and a
  // `$x` would fault. The literal also goes through item 1502's auto-parameterization, so the
  // scalar-function dispatch is still what this measures.
  stringfn: "MATCH (n:P) WHERE upper(n.s) <> 'ZZZ' RETURN count(*) AS c",

  // ⚠️ INTERSECT had NO shape until item 1562, and it is a beneficiary of the same one-column
  // keying as EXCEPT — both build a right-side key set and probe it per left row. A wide right
  // side, for the reason the comment above gives.
  intersected: 'MATCH (n:P) RETURN n.n AS x INTERSECT MATCH (n:P) RETURN n.n AS x',
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
