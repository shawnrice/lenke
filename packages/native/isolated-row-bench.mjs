/**
 * ONE query row, measured well enough to see a sub-10% change. The isolated harness CLAUDE.md asks
 * for, built because item 1366 established that the existing probe cannot answer the questions left.
 *
 * WHY THE EXISTING PROBE IS TOO NOISY. `runtime-profile-probe.mjs` times the WHOLE rep loop and
 * reports the total, so a single GC pause anywhere in 120 reps lands in the number. Item 1366
 * measured its floor on the 200k hop-filter row at **12% for the same binary** (452.2 / 506.2 /
 * 490.2 / 494.4), which is above most of the candidates worth testing — it refuted `FAST1` only in
 * the sense of "not large".
 *
 * WHAT THIS DOES DIFFERENTLY, all of it straight out of CLAUDE.md's estimator rules:
 *
 *   * **Per-rep timing, not a loop total.** One slow rep is then one sample, not the whole reading.
 *   * **Median of the kept reps, with warmup dropped.** The TS path plateaus high and emits a rare
 *     fast rep, so `min` is the wrong estimator and reports the outlier; some shapes are outright
 *     bimodal. 14 reps, drop 3, median is the documented recipe.
 *   * **Prints the whole distribution** — series, p25, median, p75, min, max — because a summary of a
 *     bimodal series is a lie and the series is the only way to see it.
 *   * **Reports GC inside the measured window** via `PerformanceObserver`, so a reading inflated by
 *     collection is visible as such instead of being mysterious. Item 1361 is why: the observer must
 *     be DRAINED before reading, or a synchronous loop reports zero pauses.
 *   * **One shape per process** (item 762), and the fixture is deterministic so every process builds
 *     byte-identical input.
 *
 *     SHAPE=hopfilter NODES=200000 REPS=14 DROP=3 node isolated-row-bench.mjs
 *
 * Output is one JSON line, so an A/B driver can parse it without scraping a table.
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.env.SHAPE ?? 'hopfilter';
const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
/**
 * How often an edge carries BOTH `E` and `F`. 0 = never, so `graph.multiTypeEdgeCount` is 0 and
 * `bucketSumsAreSound` should license the degree-sum fast path for `:E|F` as well as `:E`.
 * 3 = every third edge, so the sums would double-count and the dedupe is genuinely required.
 */
const MULTILABEL = Number(process.env.MULTILABEL ?? 3);

/**
 * How many DISTINCT far endpoints the edges point into, as a fraction of `NODES` (item 1390).
 *
 * `FANIN=1` (the default) is the original fixture: `(i * 7 + 3) % NODES`, so every vertex is a far
 * endpoint exactly once and far-end in-degree is 1. That is the WRONG fixture for any change to
 * `farDrivenHopWalk`, whose whole purpose is hoisting `projectRow` to once per far VERTEX — at
 * in-degree 1 there is nothing to amortize and the route can only lose. Item 1390 measured its
 * multi-type arm at 85.7 ms against the start-driven 69.3 here, which says nothing about the lever
 * until the degree is varied.
 *
 * `FANIN=0.01` points every edge into one of `NODES/100` vertices, so far-end in-degree is ~100 and
 * the hoist has 100 rows to spread one `projectRow` over. CLAUDE.md's rule, stated the other way
 * round: a change that only helps HIGH-degree vertices judged against a degree-1 fixture can only
 * lose.
 */
const FANIN = Number(process.env.FANIN ?? 1);

/**
 * Out-edges per vertex (item 1401). `FANOUT=1` is the original fixture, byte-for-byte.
 *
 * ⚠️ EVERY GQL NUMBER THIS SESSION CAME FROM A DEGREE-1 FIXTURE, and item 1400 is why that is now a
 * knob. One out-edge per vertex, a single permutation cycle, no self-loops and no parallel edges —
 * and at item 1399 that degeneracy hid a CORRECTNESS difference, not just a cost one: removing the
 * depth-4 endpoint-mask gate measured "correct and 9.9x faster" here and answers **-3** on
 * randomized multigraphs, because the structures the trail correction exists for were all absent.
 *
 * The Gremlin bench has had `FANOUT` since it was written; this one did not, so its hop rows could
 * only ever say what a degree-1 graph does. A per-vertex cost and a per-edge cost scale differently
 * (CLAUDE.md), and so do a walk that dedupes and one that never meets a duplicate.
 */
const FANOUT = Number(process.env.FANOUT ?? 1);

const SHAPES = {
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // AN EQUIVALENT-SPELLING PAIR (item 1375). A third of the edges carry BOTH `E` and `F`, and every
  // edge carries `E`, so these two count the SAME edges — but `:E` takes `edgesOfTypes`' single-bucket
  // fast path (item 324, which returns the Set and allocates nothing) while `:E|F` falls to
  // `edgesOfManyTypes`, which allocates a `types.map` array AND a dedupe Set per vertex. CLAUDE.md's
  // rule is that equivalent spellings must cost the same; this is the instrument for that claim on a
  // multi-type hop, which no bench row covered.
  hopsingle: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  hopmulti: 'MATCH (a:P)-[:E|F]->(b:P) RETURN count(*) AS c',
  // THE ORDER-REVERSED TWIN (item 1384). `edgesOfManyTypes` iterates bucket `i` with `i` membership
  // tests, so the total is minimised by putting the LARGEST bucket first — which means it is
  // sensitive to the order the query names types, exactly as the Gremlin twin was at item 1382
  // (3.53x there). Unlike that one, this runs PER VERTEX over a single vertex's buckets, so the
  // per-call disparity is a degree rather than a whole index and may not be measurable at all.
  hopmultirev: 'MATCH (a:P)-[:F|E]->(b:P) RETURN count(*) AS c',
  hopcount: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  // QUANTIFIED PATHS (item 1398), a major GQL surface with NO row here and never screened with a
  // windowed profile. `{1,2}` and `{1,3}` share a start and differ only in depth, so the pair prices
  // what each extra hop costs; `varlen11` is the degenerate quantifier, which must cost about what
  // the plain one-hop count does and is the control that separates "quantified paths are expensive"
  // from "this quantifier is expensive".
  varlen11: 'MATCH (a:P)-[:E]->{1,1}(b:P) RETURN count(*) AS c',
  varlen12: 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c',
  varlen13: 'MATCH (a:P)-[:E]->{1,3}(b:P) RETURN count(*) AS c',
  // AN EQUIVALENT-SPELLING PAIR ACROSS THE QUANTIFIER (item 1398), **AT `FANOUT=1` ONLY**. `{2,2}` is
  // "exactly two hops", which is what the explicit chain spells, and at out-degree 1 they agree
  // exactly — no cycle is short enough for TRAIL semantics to separate them — so a cost difference
  // is a routing difference and not different work.
  //
  // ⚠️ AT `FANOUT=4` THEY ARE DIFFERENT QUESTIONS, and item 1401 measured it rather than leaving the
  // caveat asserted: `{2,2}` answers **799,996** against the chain's **800,000**, and `{3,3}`
  // **3,199,944** against **3,200,000**. A quantified path is a TRAIL and may not repeat an edge
  // while the chain may, so at degree 4 those 4 and 56 paths revisit one — which is the trail
  // correction doing real work. Compare these as a SPELLING pair only at `FANOUT=1`; above it they
  // are a semantics demonstration. (The routing crossover holds either way: at degree 4 the chain is
  // 2.98x faster at depth 2 and the quantifier 3.01x faster at depth 3.)
  quant22: 'MATCH (a:P)-[:E]->{2,2}(b:P) RETURN count(*) AS c',
  chain2: 'MATCH (a:P)-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  quant33: 'MATCH (a:P)-[:E]->{3,3}(b:P) RETURN count(*) AS c',
  chain3: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  varlen14: 'MATCH (a:P)-[:E]->{1,4}(b:P) RETURN count(*) AS c',
  varlen24: 'MATCH (a:P)-[:E]->{2,4}(b:P) RETURN count(*) AS c',
  quant44: 'MATCH (a:P)-[:E]->{4,4}(b:P) RETURN count(*) AS c',
  chain4: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  // THE YIELD TWIN of the hopsingle/hopmulti pair (item 1387). Items 1377/1384/1386 all landed on
  // the COUNT path, where the answer is a number and the union of buckets can replace the walk
  // outright. A projection cannot take that route - every selected edge must actually be produced -
  // so this is the instrument for whatever disparity survives on the yield side. Same two spellings
  // over the same edge set, so they must cost the same.
  hopsingleyield: 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n',
  hopmultiyield: 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.n AS n',
  hopmultiyieldrev: 'MATCH (a:P)-[:F|E]->(b:P) RETURN b.n AS n',
  sortedpage: 'MATCH (n:P) WHERE n.k < 50 RETURN n.s AS s ORDER BY s LIMIT 10',
  grouped: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  scan: 'MATCH (n:P) RETURN count(*) AS c',
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

/** Deterministic, so every process in an A/B builds byte-identical input. */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  const pool = FANIN >= 1 ? NODES : Math.max(Math.floor(NODES * FANIN), 1);

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const i = k % NODES;
    // The FANOUT-th edge out of `i` lands somewhere else, so degree rises without the targets
    // collapsing onto one vertex — `FANIN` is the knob for that and the two stay independent.
    const hop = Math.floor(k / NODES);

    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`v${i}`),
      // FANIN=1 keeps the original `(i * 7 + 3) % NODES`, byte-for-byte at FANOUT=1; a smaller
      // fraction concentrates the far endpoints into the first `NODES * FANIN` vertices.
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % pool}`),
      // A THIRD carry both types, so `:E` and `:E|F` select the identical edge set and the
      // multi-bucket path actually has something to DEDUPE — without the overlap it would be a
      // concatenation and would not exercise the `Set` the dedupe allocates.
      labels: MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();

// Armed AFTER the fixture, so build-time collection is not attributed to the measured reps.
let gcMs = 0;
let gcCount = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcCount += 1;
  }
});

obs.observe({ entryTypes: ['gc'] });

const series = [];
let sink = 0;
let answer;
// ⚠️ `answer` IS THE FIRST ROW, AND A ROUTE MAY LEGITIMATELY REORDER (item 1390). An unordered GQL
// result's row order is unspecified and `farDrivenHopWalk` reorders deliberately, so comparing the
// first row across A/B arms reports a difference that is licensed — it fired on item 1390's run,
// which had verified the multiset separately and still lost its timing table to the check. The
// invariant a driver should compare is `rowCount` plus the digest below.
let rowCount = 0;
let digest = 0;

/**
 * ⚠️ WINDOWED, so a profile of this bench is of the QUERY and not of the fixture build (item 1391).
 *
 * `node --cpu-prof` profiles start to exit, and at `NODES=100000` with `REPS=6` the load dominates:
 * a profile of the post-1390 yield path put `getVertexById` 10.4%, `indexEdgeLabel` 7.3%,
 * `commitElementLabels` 4.9% and `addVertex` 2.4% near the top — every one of them the LOAD, none of
 * them the query — exactly the inversion `windowed-profile.mjs` was built for at item 1362 and the
 * family of defect item 1360 recorded. Set `PROF_OUT` to a path and the profile covers only the rep
 * loop; leave it unset and `profileWindow` just runs the body, so timing runs are unaffected.
 */
const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q);
    const dt = performance.now() - t0;

    series.push(dt);
    sink += rows.length;
    [answer] = rows;
    rowCount = rows.length;
    // An ORDER-INDEPENDENT digest of the whole result: summed per row, so a permutation cannot
    // change it while a changed VALUE or a dropped row can. It runs outside the timed window and it
    // is the check the first row cannot make.
    digest = 0;

    for (const row of rows) {
      for (const k of Object.keys(row)) {
        const v = row[k];

        if (typeof v === 'number') {
          digest += v;
        } else if (v !== null && v !== undefined) {
          digest += JSON.stringify(v).length;
        }
      }
    }
  }

  return sink;
};

await profileWindow(process.env.PROF_OUT, measure);

// ⚠️ DRAIN before reading: `PerformanceObserver` delivers in a queued callback, so a synchronous
// loop buffers every entry and reports 0 pauses (item 1361's fifth instrument defect).
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

obs.disconnect();

if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${REPS} reps — measuring nothing`);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    fanout: FANOUT,
    reps: REPS,
    drop: DROP,
    answer,
    rowCount,
    digest,
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    p75: Number(at(0.75).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    gcMs: Number(gcMs.toFixed(1)),
    gcCount,
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
