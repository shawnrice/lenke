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

  /*
   * ⚠️⚠️ **INDEXED=1 GIVES THE CORPUS AN INDEX, AND WITHOUT IT A WHOLE SURFACE IS UNREACHABLE** (item
   * 2073). Item 2072's coverage audit reported `edgeSeek` and `seekIsWorthIt` as NEVER ENTERED, and
   * the cause was this fixture: it has never created an index, so no seek rung can fire on any of the
   * 51 shapes. That is not a gap in the engine — it is a surface the probe could not see.
   *
   * 🔑 **OPT-IN, NOT DEFAULT, AND THAT IS THE WHOLE DESIGN.** An index changes which route answers
   * `WHERE n.k = 5` — that is what it is for — so creating one unconditionally would move most of the
   * 51 rows at once and invalidate every figure recorded against this probe. `MIXED=1` is opt-in for
   * the same reason (item 2031), and the two knobs compose.
   *
   * ⚠️ CREATED BEFORE THE VERTICES, because `createIndex` on a populated graph is a different
   * operation (a backfill) from one that maintains as it goes — and the backfill's cost would land in
   * the fixture build, which `PROBES.md` warns is already most of the process at small `N`.
   */
  if (process.env.INDEXED === '1') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    /*
     * ⚠️ THE EDGE INDEX IS A SEPARATE SURFACE, and `edgeSeek` reads `graph.edgePropertyIndex` rather
     * than the vertex one — so the vertex index above cannot reach it however many shapes are added.
     * Both are behind this one knob because both change which route answers a shape, which is the
     * thing that must not happen by default.
     */
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  /*
   * ⚠️⚠️ **MIXED=1 APPENDS ONE ISOLATED OFF-LABEL VERTEX, AND IT IS THE REALISTIC MODE** (item 2031).
   * `vacuousLabel` is `verticesByLabel.get(name)?.size === graph.vertexCount`, so ONE vertex lacking
   * the label disqualifies the whole graph PERMANENTLY — a cliff, not a gradient. Every read screen
   * in this repo is label-homogeneous, so every row measures the vacuous arm, which a
   * `Person`/`Company` schema can never reach.
   *
   * 🔑 THE VERTEX IS ISOLATED (no edges) ON PURPOSE: every answer is unchanged and only `vertexCount`
   * moves, so the two modes are directly comparable and the oracles stay valid. That is exactly what
   * `gql-coverage-screen-1901.mjs`'s own MIXED mode does.
   */
  if (process.env.MIXED === '1') {
    g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { k: -1, s: 'off', n: -1 } });
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
  /*
   * ⚠️⚠️ ITEM 2073: THE CORPUS HAD NO SHAPE THAT CONSTRAINS AN EDGE PROPERTY AT ALL. All 38 of its rel
   * patterns were anonymous `[:E]`, so `edgeSeek` -- which reads `graph.edgePropertyIndex` -- could
   * never fire, and item 2072 correctly declined to call that an engine gap. The fixture's edges have
   * carried `w: e % 13` all along; only the queries were missing.
   *
   * 🔑 BOTH SPELLINGS, because `edgeSeek` takes exactly two and CLAUDE.md gives equivalent spellings
   * their own section: "the planner recognized one spelling of a predicate and scanned for another
   * that meant exactly the same thing ... each cost 100-300x and each returned the correct answer".
   * A lifted clause `WHERE` on the rel is item 1034's spelling; the inline brace form is the other.
   */
  reledgewhere: 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w = 5 RETURN b.k AS k',
  reledgeinline: 'MATCH (a:P)-[:E {w: 5}]->(b:P) RETURN b.k AS k',
  /**
   * ⚠️⚠️ **ITEM 1618's "NO rung at all" IS STALE — ITEM 2064 PROFILED THIS SHAPE AND FOUND A FUSED
   * TWO-HOP WALK.** `hop2-projection.ts`'s `walk` serves it with hoisted label elision, the gate
   * before `projectRow` and a fused one-column `DISTINCT`; the hot frame is that walk's own closure,
   * not a generic pipeline. The gap it leaves is 561 ns a row against the one-hop rung's 204 — a
   * route that EXISTS and is dearer, which is a different question from a missing one.
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
  // ⚠️ THE SAME CHAIN UNDER `RETURN DISTINCT`, which had NO row on this screen until item 1820 and
  // was therefore 5.8x slower than the line above for 1,800 items — `DISTINCT` rides in
  // `plainRowProjection`, so it disqualified the chain rung and the query fell to the general
  // matcher, costing MORE than emitting every row it dedupes. This row is the regression guard on
  // that admission: if it ever returns to within a few percent of the general matcher, the rung is
  // declining again. ⚠️ Its PAIR is `hop3rows` directly above — the dedupe can only ever be that
  // row plus a hash, so the two must stay close, and a gap is the signal rather than either number
  // alone.
  hop3distinct: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN DISTINCT d.k AS k',
  // ⚠️ AND THE TWO-HOP TWIN, which item 1821 left as the SLOWEST of the three widths — a shorter
  // chain costing more than a longer one, because `distinctShape` refuses `segments.length > 1`
  // and `detectChainProjection` requires three segments, so two fell between the two rungs. Its
  // pair control is `hop2rows`, for the same reason `hop3distinct`'s is `hop3rows`.
  hop2distinct: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN DISTINCT c.k AS k',
  /**
   * ⚠️ THE DECLINED TWIN OF `hop3rows`, added at item 1802 and the row that decides the question.
   * `directedBucket` refuses `both` (two buckets, and a dedupe across them), so this shape stays on
   * `expand` whatever happens to the directed one — which is exactly where item 1622's edge-only
   * adapter LOST 3.7% while gaining 9% on the directed family, and was rejected for it. Without
   * this row the trade cannot be seen, and item 1622's own arms had to be written by hand.
   */
  hop3rowsboth: 'MATCH (a:P)-[:E]-(b:P)-[:E]-(c:P)-[:E]-(d:P) RETURN d.k AS k',
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
  // ⚠️ THE THIRD closure, `deferredSortedNodeWalk`, and reaching it took work (item 1744). It is
  // chosen when `outputColumnSorts` DECLINES, which for a windowed sort means an item that can
  // FAULT -- `n.k + 1` is arith, which `cannotFault` refuses. Verified with a per-closure counter:
  // these two fire it (20 and 10 row-builds); a parameterized `LIMIT $n` and a `LIMIT 0` do NOT.
  // The wide form is the realistic one: several direct columns beside a computed one, i.e.
  // `RETURN p.name, p.age, p.salary * 1.1 AS raise ORDER BY p.name LIMIT 20`.
  defsortwide:
    'MATCH (n:P) WHERE n.k < 10 RETURN n.k + 1 AS x, n.n AS b, n.s AS c, n.k AS d ORDER BY b LIMIT 5',
  defsortnarrow: 'MATCH (n:P) WHERE n.k < 10 RETURN n.k + 1 AS x, n.n AS b ORDER BY b LIMIT 5',
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
  /*
   * ⚠️⚠️ ITEM 2087: THE SAME CHAIN, COUNTED BY A PROPERTY INSTEAD OF BY `*`. `detectChainFoldLevels`
   * answers `count(<far>.k)` over a CSR LEVEL RECURRENCE and applies the label mask per level, so it
   * admits a labelled chain; `count(*)` has no such rung and falls to the per-edge tally once a label
   * is non-vacuous. The two are NOT semantically equal (`count(c.k)` skips nulls) — the point is that
   * `count(*)` does strictly LESS work and should not be slower.
   */
  count2prop: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(c.k) AS c',
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
  /*
   * ⚠️ ITEM 2076: `scalaraggs` MIXES FOLDABLE AND NON-FOLDABLE AGGREGATES, and the corpus had no way
   * to tell which half costs. `chain-projection.ts`'s `ORDER_INVARIANT_AGGREGATES` is
   * `{min, max, count}` — `sum`/`avg` are REFUSED as foldable because "f64 addition is order-sensitive
   * in the last ulp", a byte-identity requirement and not an oversight.
   *
   * 🔑 THE QUESTION THESE THREE ASK: does ONE non-foldable term poison a projection that also contains
   * foldable ones? `aggminmax` is foldable-only, `aggsum` non-foldable-only, and `aggmixed` is one of
   * each — so if the mixed row sits with `aggsum` rather than between, the answer is yes.
   */
  aggminmax: 'MATCH (n:P) RETURN min(n.k) AS mn, max(n.k) AS mx',
  aggsum: 'MATCH (n:P) RETURN sum(n.n) AS s',
  aggmixed: 'MATCH (n:P) RETURN sum(n.n) AS s, min(n.k) AS mn',
  // ⚠️ `callinline` HAS NO SCOPE LIST, SO IT IS NON-CORRELATED — the inner `n` is a FRESH variable,
  // not the outer one, which is the scope isolation the ISO form exists for. Item 1565 read that as
  // a quadratic DEFECT; item 1566 retracted it. The body genuinely scans the graph, and running it
  // once per outer row is O(N^2) by specification.
  //
  // It is kept because an empty-scope body is LOOP-INVARIANT, which item 1566 then exploited:
  // 1358.0 -> 4.7 ms at N=1000, 289x. So this row is now the regression guard on that hoist, and
  // `callscoped` beside it is the genuinely correlated shape that had no coverage at all.
  //
  // ⚠️ AND SINCE ITEM 1818 IT IS ALSO THE GUARD ON THE PER-OUTER-ROW PLUMBING, which is a separate
  // quantity from the hoist and the reason this row stayed the screen's outlier long after 1566:
  // with the body running once, what was left was 633 ms engine against 80-180 for every other GQL
  // shape, all of it the row-to-binding projection. 1818 took that to 466.7 (1.36x). ⚠️ A TOTAL
  // CANNOT SEPARATE THE TWO — "body ran once, plumbing is expensive" and "body ran per row behind a
  // fast rung" produce the same number here — so a regression in this row is ambiguous until
  // `packages/native/uncorrelated-call-reuse-probe.mjs` says which side moved.
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
/** The first row of the first run, so the ANSWER can be asserted and not just the row count. */
let rows0;
const t0 = performance.now();

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < N; i += 1) {
    const rows = query(g, q);

    rows0 ??= rows[0];
    sink += rows.length;
  }

  return sink;
});

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently returned nothing would profile the
// error path and look like a result.
if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${N} runs — the profile would be of nothing`);
}

// ⚠️ `sink` CATCHES AN EMPTY RESULT, NOT A WRONG ONE, and item 1749 lost a whole measurement to the
// gap. For a `count(*)` shape `sink` is the ROW count — always 1 per run whatever the count VALUE is
// — so an ablation arm that had stopped filtering entirely (20,000 instead of 207) read IDENTICALLY
// to base and produced a confident 1.11x that meant nothing.
//
// Two assertions now, and they are split by what the engine actually GUARANTEES:
//
//   rowsPerRun  every shape. A wrong-answer arm almost always changes how many rows survive.
//   answer      ONLY for shapes whose first value is deterministic — a `count(*)` (one row) or an
//               ORDERED projection. ⚠️ NOT for an unordered row shape: `order-is-unspecified` is
//               this engine's documented stance, so asserting the first row of `RETURN n.k` would
//               pin something it is free to change. That is why `distinct`/`wideproj`/`hoprows`
//               carry a row count and no value.
//
// Values verified against HEAD at item 1749.
const first = rows0 === undefined ? undefined : rows0[Object.keys(rows0)[0]];
/*
 * ⚠️⚠️ **THE EXPECTED ANSWERS WERE CONSTANTS, SO NO SHAPE COULD BE PROFILED AT FANOUT>1** (item 2030).
 * `rowsPerRun` already accepted a function of NODES; `answer` did not, so `FANOUT=3 … join` threw
 * "answered 1863, expected 207" — the guard firing correctly on a fixture it simply could not
 * describe. That is the one regime CLAUDE.md insists on for a per-edge shape ("per-edge costs scale
 * with the edge:node ratio"), and `join` is per-edge work, so the probe could only ever profile it
 * in the regime that misprices it.
 *
 * 🔑 THE FIX IS AN ORACLE, NOT A WIDER CONSTANT TABLE. `expectJoin` and friends recompute the answer
 * from the fixture's own CLOSED FORM in plain JS — no engine call, no `Graph` — so they are an
 * INDEPENDENT check rather than a recording of what the engine said once. A constant captured at
 * FANOUT=3 would have agreed with whatever the engine printed, including a wrong number, which is the
 * failure the surrounding comment spends ten lines on.
 *
 * ⚠️ IT ALSO ASSERTS THE FIXTURE BRANCHES. CLAUDE.md's generator trap is that `to = (a*k + b) % N` is
 * invariant under `k -> k + N`, so every one of a vertex's FANOUT edges lands on the SAME target and
 * the graph is FUNCTIONAL while out-degree looks perfect. This generator already splits on the repeat
 * index, and `distinctTargets` now proves it per run instead of trusting the comment that says so.
 */
const fixtureEdges = (nodes, fanout, stride) => {
  const out = new Map();

  for (let e = 0; e < nodes * fanout; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);
    const from = stride === 'scattered' ? (e * 7919) % nodes : i;
    const to =
      stride === 'scattered'
        ? ((e % nodes) * 104729 + hop * 977) % nodes
        : (i * 7 + 3 + hop * 2654435761) % nodes;

    const bucket = out.get(from);

    if (bucket === undefined) {
      out.set(from, [to]);
    } else {
      bucket.push(to);
    }
  }

  return out;
};

const distinctTargets = (adj) => {
  const seen = new Set();

  for (const targets of adj.values()) {
    for (const t of targets) {
      seen.add(t);
    }
  }

  return seen.size;
};

// `MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*)` — a.k is `i % 97`.
const expectHopFilter = (nodes, fanout, stride) => {
  const adj = fixtureEdges(nodes, fanout, stride);
  let rows = 0;

  for (const [from, targets] of adj) {
    if (from % 97 === 5) {
      rows += targets.length;
    }
  }

  return rows;
};

// The same shape under EXISTS / OPTIONAL counts matching `a`s once, not edges.
const expectExists = (nodes, fanout, stride) => {
  const adj = fixtureEdges(nodes, fanout, stride);
  let rows = 0;

  for (const [from, targets] of adj) {
    if (from % 97 === 5 && targets.length > 0) {
      rows += 1;
    }
  }

  return rows;
};

/*
 * `OPTIONAL MATCH` emits one row PER MATCH, and one NULL-filled row for a matching `a` with no edge —
 * so it is NOT `expectExists`.
 *
 * ⚠️ I GOT THIS WRONG AT ITEM 2030 and the probe's own guard caught it ("optional answered 621,
 * expected 207"), which is the instrument doing its job: `EXISTS` collapses to one row per `a` (207 at
 * every fanout, which is why `existssub` was right) while `OPTIONAL` does not. A constant table could
 * not have told them apart, because at FANOUT=1 the two agree — the regime the probe was stuck in
 * until item 2030.
 */
const expectOptional = (nodes, fanout, stride) => {
  const adj = fixtureEdges(nodes, fanout, stride);
  let rows = 0;

  for (let i = 0; i < nodes; i += 1) {
    if (i % 97 === 5) {
      rows += Math.max(1, (adj.get(i) ?? []).length);
    }
  }

  return rows;
};

// `MATCH (a)-[:E]->(b) MATCH (b)-[:E]->(c) WHERE a.k = 5` — the two-hop product.
const expectJoin = (nodes, fanout, stride) => {
  const adj = fixtureEdges(nodes, fanout, stride);
  let rows = 0;

  for (const [from, targets] of adj) {
    if (from % 97 !== 5) {
      continue;
    }

    for (const b of targets) {
      rows += (adj.get(b) ?? []).length;
    }
  }

  return rows;
};

/*
 * ⚠️⚠️ **ROW EXPECTATIONS AS FUNCTIONS OF `NODES`, BECAUSE ELEVEN OF THE 51 SHAPES COULD NOT RUN AT ANY
 * OTHER SIZE** (item 2052). They carried constants fitted to `NODES=20000` — `wideproj: 2070`,
 * `unioned: 414`, `hop3rowsboth: 160_000` — so a sweep at 200,000 threw on each one
 * ("returned 20620 rows, expected 2070"). The guard was right and the table could not describe the
 * fixture, exactly as item 2030 found for FANOUT.
 *
 * 🔑 **THAT MATTERS BECAUSE ITEM 2051 SHOWED A SINGLE-SIZE RANKING IS MISLEADING**: the undirected-chain
 * gap read 3.74x at 20k and 1.85x at 200k, and the whole 51-shape ranking reorders between the two.
 * A probe that cannot change size cannot answer the question the sweep exists for.
 *
 * ⚠️ EACH FORMULA IS DERIVED FROM THE QUERY AND CHECKED AGAINST **TWO** POINTS — the constant it
 * replaces at 20,000 AND the count actually observed at 200,000 — so a fitted-but-wrong formula
 * cannot pass. `k` is `i % 97`, `n` is `i`, and every vertex has one out-edge.
 */

/** Vertices with `k < m`: whole 97-blocks contribute `m` each, then the partial block. */
const kLt = (n, m) => Math.floor(n / 97) * m + Math.min(n % 97, m);

/** Edges with `w === v`, where `w` is `e % 13` over `edges` edges. */
const wEq = (edges, v) => Math.floor(edges / 13) + (edges % 13 > v ? 1 : 0);

/** Vertices with `k === v`. */
const kEq = (n, v) => Math.floor(n / 97) + (n % 97 > v ? 1 : 0);

const EXPECTED = {
  hopfilter: { rowsPerRun: 1, answer: expectHopFilter },
  hopall: { rowsPerRun: 1, answer: (n, f) => n * f },
  existssub: { rowsPerRun: 1, answer: expectExists },
  optional: { rowsPerRun: 1, answer: expectOptional },
  join: { rowsPerRun: 1, answer: expectJoin },
  point: { rowsPerRun: 1, answer: 's345' },
  sortedpage: { rowsPerRun: 10, answer: 's0' },
  distinct: { rowsPerRun: 97 },
  distinctstr: { rowsPerRun: 1000 },
  distincthi: { rowsPerRun: (n) => n },
  grouped: { rowsPerRun: 97 },
  wideproj: { rowsPerRun: (n) => kLt(n, 10) },
  wide2: { rowsPerRun: (n) => kLt(n, 10) },
  narrow1: { rowsPerRun: (n) => kLt(n, 10) },
  hoprows: { rowsPerRun: (n) => n },
  /*
   * ⚠️ THE ORACLE IS A COUNT OF EDGES, NOT OF VERTICES (item 2073). `w` is `e % 13` over
   * `NODES * FANOUT` edges, so the surviving rows are the edges with `w === 5` — and BOTH spellings
   * must produce the identical number, which is the equivalence the two rows exist to check.
   */
  reledgewhere: { rowsPerRun: (n, f) => wEq(n * f, 5) },
  reledgeinline: { rowsPerRun: (n, f) => wEq(n * f, 5) },
  /**
   * ⚠️ ADDED AT ITEM 1805 BECAUSE ITS ABSENCE COST A MEASUREMENT — item 1749's lesson, a second
   * time. These are the hop-ROW shapes, and the five largest rows in the probe had NO guard at
   * all: an ablation of the matcher's binding copy (a deliberate wrong answer, run only to price
   * the copy) emitted **5 rows where the shape returns 160,000** and reported 18.7 ms against
   * 933 — a 50x "win" that was the walk collapsing. `sink` was printed and ignored, which is
   * exactly what a guard is for.
   *
   * Row counts only, no `answer`: these are UNORDERED row shapes, and pinning their first value
   * would assert something `order-is-unspecified` leaves the engine free to change. `hop2rowswhere`
   * carries a value because its `WHERE c.k = 5` makes it determinate.
   */
  hop2rows: { rowsPerRun: (n) => n },
  hop2rowswhere: { rowsPerRun: (n) => kEq(n, 5), answer: 5 },
  hop3rows: { rowsPerRun: (n) => n },
  // 97 distinct `k` values (`i % 97`), whatever the chain's row count — so this answer is a real
  // guard on the dedupe and not just on the walk.
  hop3distinct: { rowsPerRun: 97 },
  hop2distinct: { rowsPerRun: 97 },
  // Both-degree is 2 (one out, one in), so a 3-hop undirected chain is 2^3 per start.
  hop3rowsboth: { rowsPerRun: (n) => n * 8 },
  // The paging and set-operation shapes, same gap.
  topkwide: { rowsPerRun: 10 },
  topknarrow: { rowsPerRun: 10 },
  defwide: { rowsPerRun: (n) => kLt(n, 10) },
  defnarrow: { rowsPerRun: (n) => kLt(n, 10) },
  defsortwide: { rowsPerRun: 5, answer: 1 },
  defsortnarrow: { rowsPerRun: 5, answer: 1 },
  unioned: { rowsPerRun: (n) => kEq(n, 5) + kEq(n, 6) },
  // The two arms are disjoint (k=5 vs k=6) and `n` is unique, so UNION equals UNION ALL here.
  unioneddistinct: { rowsPerRun: (n) => kEq(n, 5) + kEq(n, 6) },
  excepted: { rowsPerRun: (n) => kLt(n, 10) - kEq(n, 6) },
  control: { rowsPerRun: 1, answer: 1 },

  /*
   * ⚠️⚠️ **THE TWENTY SHAPES THAT HAD NO GUARD AT ALL (item 2075).** `const want = EXPECTED[SHAPE]`
   * is followed by `if (want !== undefined)`, so a shape absent from this table is checked for
   * NOTHING — not its row count, not its answer. Twenty of 53 were in that position, including
   * `callscoped` and `callinline`, which items 2053-2055 measured and re-measured.
   *
   * 🔑 THIS IS ITEM 1805's FAULT AT FOUR TIMES THE SIZE. That item added guards to five shapes after
   * "an ablation of the matcher's binding copy — a deliberate wrong answer, run only to price it"
   * went unnoticed. The same hole was still open for twenty more.
   *
   * ⚠️ EVERY FORMULA BELOW IS DERIVED FROM THE QUERY AND THE FIXTURE, THEN CHECKED AT TWO SIZES
   * (20,000 and 40,000) — item 2052's rule, so a fitted-but-wrong formula cannot pass. The fixture is
   * `{ k: i % 97, s: 's' + (i % 1000), n: i }` with one out-edge per vertex at FANOUT=1.
   */

  // count(*) over `->{1,2}`: f paths of length 1 per vertex plus f² of length 2. 40,000 -> 80,000 ✓
  varlen12: { rowsPerRun: 1, answer: (n, f) => n * f + n * f * f },
  /*
   * A k-hop chain count is n·fᵏ.
   *
   * ⚠️⚠️ **THESE THREE GUARDS ARE VACUOUS AT THE DEFAULT FANOUT=1, and that was proven by mutation
   * rather than reasoned about.** With f = 1, `n·f`, `n·f²` and `n·f³` are all n — so rewriting
   * `count2`'s query as a ONE-hop count still answers 20,000 and the guard SURVIVES. At FANOUT=3 the
   * same mutant is CAUGHT. The formulas are right; their teeth depend on the knob.
   *
   * 🔑 So a FANOUT=1 run checks that these shapes return a count of n — not that they walk the depth
   * they claim. Anyone ablating a hop depth must run FANOUT>1 or the guard will not notice.
  count2: { rowsPerRun: 1, answer: (n, f) => n * f * f },
  // Every `c` in the fixture carries `k`, so the property count equals the row count — which is what
  // makes the pair comparable at all.
  count2prop: { rowsPerRun: 1, answer: (n, f) => n * f * f },
  count3: { rowsPerRun: 1, answer: (n, f) => n * f * f * f },
  // count(DISTINCT b) over `->+`: every vertex is reachable, so the whole graph. 20,000 -> 40,000 ✓
  varlenplus: { rowsPerRun: 1, answer: (n) => n },
  /*
   * ⚠️ `anyshortest`'s ANSWER IS DELIBERATELY NOT GUARDED BY FORMULA. It is the orbit length of
   * `i -> (i * 7 + 3) % n` from vertex 0, and it reads 200 at 20,000 and 400 at 40,000 — which LOOKS
   * like `n / 100` and is not derivable from the query. CLAUDE.md spends a whole section on fixtures
   * whose structure invites exactly that kind of fit, so the row count is guarded and the answer is
   * left to the shape that can justify it.
   */
  anyshortest: { rowsPerRun: 1 },
  // 97 distinct `k` by construction, or every vertex if the graph is smaller than that.
  countdistinct: { rowsPerRun: 1, answer: (n) => Math.min(n, 97) },
  // One list-shaped row; its CONTENTS are the whole column, so the row count is the guard.
  collected: { rowsPerRun: 1 },
  collecthop: { rowsPerRun: 1 },
  // One group per distinct `k` among the hop targets, which is every `k` the fixture carries.
  groupedhop: { rowsPerRun: (n) => Math.min(n, 97), answer: 3 },
  // sum(n.n) over n = 0 … N-1 is the triangular number. 199,990,000 -> 799,980,000 ✓
  scalaraggs: { rowsPerRun: 1, answer: (n) => (n * (n - 1)) / 2 },
  // ⚠️ DERIVED, not observed: `min(n.k)` is 0 because `i % 97` starts at 0, and `sum(n.n)` over
  // `n = 0 … N-1` is the triangular number — the same formula `scalaraggs` uses, which is what makes
  // the three rows comparable.
  aggminmax: { rowsPerRun: 1, answer: 0 },
  aggsum: { rowsPerRun: 1, answer: (n) => (n * (n - 1)) / 2 },
  aggmixed: { rowsPerRun: 1, answer: (n) => (n * (n - 1)) / 2 },
  // Both CALL forms count the OUTER rows, one per vertex — the identity items 2053/2054 relied on.
  callinline: { rowsPerRun: 1, answer: (n) => n },
  callscoped: { rowsPerRun: 1, answer: (n) => n },
  // LIMIT 10, and `min(k)` is 0 because `i % 97` starts there.
  topkhop: { rowsPerRun: 10, answer: 0 },
  // `upper(s) <> 'ZZZ'` is true for every row, so this counts the graph.
  stringfn: { rowsPerRun: 1, answer: (n) => n },
  // INTERSECT of a set with ITSELF is the set: n distinct `n.n`, and the first is 0.
  intersected: { rowsPerRun: (n) => n, answer: 0 },
  // UNION ALL keeps both sides; UNION dedupes to one. 2n and n, checked at both sizes.
  unionedbig: { rowsPerRun: (n) => n * 2, answer: 0 },
  unionedbigdistinct: { rowsPerRun: (n) => n, answer: 0 },
  /*
   * ⚠️ `kLt` IS REUSED, NOT RE-DERIVED — it is item 2052's helper for exactly this predicate, and
   * five shapes already share it. `k < 10` over `i % 97`: 2,070 at 20,000 and 4,130 at 40,000 ✓
   */
  proj1: { rowsPerRun: (n) => kLt(n, 10), answer: 0 },
  proj2: { rowsPerRun: (n) => kLt(n, 10), answer: 0 },
  proj10: { rowsPerRun: (n) => kLt(n, 10), answer: 0 },
};
const want = EXPECTED[SHAPE];

if (want !== undefined) {
  /**
   * ⚠️ `rowsPerRun` MAY BE A FUNCTION OF `NODES` — item 1838. It was a constant calibrated for the
   * default `NODES=20000`, which is right for the shapes whose row count is fixed by the data (97
   * distinct `k`, 1000 distinct `s`) and WRONG for every shape whose row count is the vertex count:
   * `NODES=200000 … hop3rows` threw "returned 4000000 rows, expected 400000". The guard was correct
   * and the invocation impossible — so those shapes could not be profiled at any size but 20,000,
   * which is precisely the cache-resident regime PROBES.md records as the screen's blind spot
   * (items 1358-1361 ran there; item 1362 exists because of it).
   *
   * A function is the fix rather than a looser guard: `chain-depth-locality-probe.mjs` already does
   * this (`rows === N * reps`), and ⚠️ its own note is why it must stay EXACT — the guard is valid
   * only because every stride in it is FUNCTIONAL, so one vertex contributes exactly one row per
   * level. Relaxing the check to "roughly N" would have let a degenerate fixture through, which is
   * the failure CLAUDE.md spends a whole section on.
   */
  /*
   * ⚠️ `FANOUT` IS PASSED TOO (item 2073), because `answer` already took `(n, f)` and `rowsPerRun`
   * took only `(n)` — an asymmetry that silently produced `expected NaN` the moment a shape needed
   * the edge count. Every existing one-argument oracle ignores the second argument, so this removes
   * the trap without touching any of them.
   */
  const perRun =
    typeof want.rowsPerRun === 'function' ? want.rowsPerRun(NODES, FANOUT) : want.rowsPerRun;

  if (sink !== perRun * N) {
    throw new Error(
      `${SHAPE} returned ${sink} rows across ${N} runs, expected ${perRun * N} — this arm is NOT answer-equivalent, so its timing is meaningless`,
    );
  }

  const wantAnswer =
    typeof want.answer === 'function' ? want.answer(NODES, FANOUT, STRIDE) : want.answer;

  if (wantAnswer !== undefined && first !== wantAnswer) {
    throw new Error(
      `${SHAPE} answered ${String(first)}, expected ${String(wantAnswer)} — this arm is NOT answer-equivalent, so its timing is meaningless`,
    );
  }

  /*
   * ⚠️ THE FIXTURE MUST BRANCH, and only a DISTINCT-ENDPOINT count can say so (CLAUDE.md: out-degree,
   * in-degree and isolated-vertex counts all look perfect under the `k -> k + N` collapse). At
   * FANOUT=1 one vertex cannot branch, so the check applies above it.
   */
  if (FANOUT > 1) {
    const reach = distinctTargets(fixtureEdges(NODES, FANOUT, STRIDE));
    const floor = Math.floor(NODES * 0.5);

    if (reach < floor) {
      throw new Error(
        `fixture reaches only ${reach} distinct targets of ${NODES} at FANOUT=${FANOUT} — a DEGENERATE (functional) graph, so any branching claim from it is meaningless`,
      );
    }
  }
}

/*
 * ⚠️ `LBL_REPORT=1` prints a counter an INSTRUMENTED build sets (item 2033's
 * `labeltest-count-2033.sh`). On a normal build the global is absent and this prints nothing, so the
 * line is inert — it exists so the count and the timing come from ONE run rather than two.
 */
if (process.env.LBL_REPORT === '1') {
  const tests = globalThis.__LBL;

  /*
   * ⚠️ AN ABSENT GLOBAL AND ZERO CALLS ARE INDISTINGUISHABLE HERE, and my first wording ("UNINSTRUMENTED
   * BUILD") asserted the wrong one: item 2033's `MIXED=0` run printed it from a build that was
   * provably instrumented, because the SAME build reported 240,000,000 under `MIXED=1`. Zero calls is
   * the interesting answer (item 1609's hoist eliding the test on a vacuous label), so the note now
   * says what is actually known instead of guessing which cause it was.
   */
  console.log(
    JSON.stringify({
      labelTests: tests ?? 0,
      note:
        tests === undefined
          ? 'ZERO calls, or an uninstrumented build — indistinguishable; cross-check another mode on the SAME build'
          : 'instrumented',
    }),
  );
}

/*
 * ⚠️⚠️ THE CLOSED-FRAMES REMINDER IS PRINTED, NOT JUST FILED (item 1985).
 *
 * `PROBES.md` opens with a table of frames that are closed targets, and its own sentence is "read
 * this BEFORE nominating anything from a profile". CLAUDE.md's rule, though, is to read `PROBES.md`
 * before BUILDING an instrument — so running an existing probe never triggers it, and item 1985
 * took a profile, read `indexEdgeLabel` at 30.1% and `getEdgeById` at 16.0%, and was stopped only
 * by happening to grep `CLOSED.md` afterwards. That would have been the SEVENTH arrival at
 * `indexEdgeLabel`, which item 1623 predicted in terms and item 1876 nearly fulfilled.
 *
 * So the warning is emitted where it is needed: in the output of the probe that produces the
 * profile, before anyone reads the frames.
 */
const CLOSED_FRAMES_NOTE =
  '# ⚠️ Before nominating a frame from this profile, read the CLOSED-FRAMES table at the top of ' +
  'PROBES.md.\n#    indexEdgeLabel, getEdgeById/getVertexById, commitElementLabels, set labels, ' +
  '#commitNormalized,\n#    insertEdge, pushTokens, addVertex and (garbage collector) are ALL ' +
  'closed targets — indexEdgeLabel has\n#    SIX prior arrivals. A profile whose top frames are ' +
  'these has measured the FIXTURE, not your question.';

console.error(CLOSED_FRAMES_NOTE);

console.log(JSON.stringify({ shape: SHAPE, n: N, ms: Number(ms.toFixed(1)), sink, answer: first }));
