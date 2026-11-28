/**
 * HOW MUCH MEMORY MUST BE HELD AT ONCE TO ANSWER A QUERY, and does it grow with the walk?
 *
 * THIS IS A DIFFERENT QUANTITY FROM EVERY OTHER ALLOCATION INSTRUMENT HERE, and it is the one that
 * bounds what the system can do:
 *
 *     churn (item 2416)     total bytes allocated. Can be enormous and harmless - a nursery
 *                           recycles it, and `hop2generic` churns 218 MiB at 5.7% GC.
 *     retained (2416)       what SURVIVES the window. Says nothing about the middle.
 *     count/site (2418)     how many allocations and where. Says nothing about how many are
 *                           alive SIMULTANEOUSLY.
 *     PEAK (this)           the HIGH-WATER MARK of live memory during the query. A shape whose
 *                           peak is CONSTANT in the walk can answer any size; one whose peak
 *                           grows with the walk OOMs at some size, and that size is a property
 *                           of the shape rather than of the machine.
 *
 * A query can be excellent on all three of the others and still be the thing that kills the
 * process: materialising 10,000,000 rows to fold them allocates once per row (good churn
 * locality, nothing retained) and holds all of them at once.
 *
 * ## TWO MECHANISMS, because a peak is easy to under-report and a single reading cannot be checked
 *
 *   MECH=rss     ~~`process.resourceUsage().maxRSS` differenced between a graph-only child and a
 *                graph-plus-query child.~~ **REFUTED BY ITS OWN CONTROLS - see below. Kept only to
 *                answer "did the query exceed what building the graph already needed".**
 *   MECH=highwater  the MAX live heap observed INSIDE the query window, from `v8.GCProfiler`'s
 *                per-collection `usedHeapSize`. Scoped to the window, so a small peak is resolvable
 *                where a process-wide mark buries it.
 *   MECH=cap     the SMALLEST `--max-old-space-size` at which the shape still completes, found by
 *                bisection in child processes. This is the OOM question asked directly rather than
 *                inferred: "this shape needs at least N MiB of heap". Also differenced against a
 *                graph-only arm.
 *
 * ## WHY A PROCESS-WIDE maxRSS CANNOT ANSWER THIS, measured rather than reasoned
 *
 * The first version of this probe differenced `maxRSS` between a graph-only child and a
 * graph-plus-query child. **Its own controls refuted it**: `count(*)`, whose peak must be constant
 * and near zero, read
 *
 *     N=25,000  2.9 MiB    N=50,000  0.9 MiB    N=100,000  4.0 MiB    N=200,000  -11.0 MiB
 *
 * and a NEGATIVE peak is impossible. The linear control was no better (6.4 / 22.8 / 4.4 / 16.5,
 * growth exponents from -2.39 to +1.92). The cause is structural, not noise: **the graph BUILD peaks
 * at 164-532 MiB while the query peaks at a few, so the query never moves the process high-water
 * mark** - `maxRSS` is a maximum over the whole process lifetime, and it had already been set.
 * Subtracting two ~500 MiB readings to recover a ~5 MiB signal recovers their noise instead.
 *
 * THE RULE: a high-water mark can only measure a phase that is the PROCESS'S peak. For a phase
 * underneath an earlier, larger one, the mark must be scoped to the window - which is what
 * `MECH=highwater` does - or the requirement must be measured as a THRESHOLD, which is what
 * `MECH=cap` does. A threshold is immune to this because it is not a difference of two
 * measurements; it is the point at which behaviour changes.
 *
 * `MECH=highwater` is cheap and gives the curve; `MECH=cap` is slow and gives the number a capacity
 * decision actually needs. They answer the same question two ways, which is this directory's
 * standard for trusting either (`gc-cost-probe.mjs` is trusted because it landed within a point of
 * a CPU profile; item 2418's counter because its 80.2 B/element matched the churn meter's 80.1).
 *
 * ## THE SHAPE OF THE ANSWER MATTERS MORE THAN ITS SIZE
 *
 * Every arm is swept over walk size, and the growth EXPONENT is printed: a peak that doubles when
 * the walk doubles is O(n) and has an OOM size; one that does not move is O(1) and does not.
 * `count(*)` is the constant control and a row-returning shape is the linear control - if those
 * two do not come out flat and linear respectively, the instrument is wrong and nothing else on
 * the sheet is readable.
 *
 *     node peakmem-2419.mjs                      # calibrate: hold a KNOWN number of MiB
 *     SHAPE=hop1sum node peakmem-2419.mjs        # the curve for one shape
 *     MECH=cap SHAPE=hop1sum node peakmem-2419.mjs
 *     ARM=child ...                              # internal: what the child processes run
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const MECH = process.env.MECH ?? 'rss';
const SHAPE = process.env.SHAPE ?? 'cal';
const ARM = process.env.ARM ?? 'parent';
const SIZES = (process.env.SIZES ?? '25000,50000,100000,200000').split(',').map(Number);
const REPS = Number(process.env.REPS ?? 1);
const CAP_STEP = Number(process.env.CAP_STEP ?? 8);
/** Calibration only: the MiB the child must hold live at once. */
const HOLD_MIB = Number(process.env.HOLD_MIB ?? 0);

const MIB = 1024 * 1024;

const SHAPES = {
  // The LINEAR control: it returns every row, so its peak MUST grow with the walk.
  hop1: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k',
  // The CONSTANT control: a closed form that never walks. Its peak must not move.
  hop1count: 'MATCH (a:P)-[:E]->(x1:P) RETURN count(*) AS c',
  // The questions. Item 2418 found the one-hop aggregate materialising a row per element
  // (`projectRow`, 5.16 allocs/element) where the two-hop one streams (0.15) - so the PEAK should
  // split the same way, and that is the claim this instrument exists to check.
  hop1sum: 'MATCH (a:P)-[:E]->(x1:P) RETURN sum(x1.k) AS s',
  hop2sum: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN sum(x2.k) AS s',
  hop1collect: 'MATCH (a:P)-[:E]->(x1:P) RETURN collect(x1.k) AS ks',
  // A PROJECTION, not an aggregate: it walks every element and returns one row per DISTINCT value
  // (97 here), so its memory question is real and different from a fold's (item 2423).
  hop1distinct: 'MATCH (a:P)-[:E]->(x1:P) RETURN DISTINCT x1.k AS k',
  hop2: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN x2.k AS k',
  hop2generic: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) WHERE a.k >= 0 RETURN x2.k AS k',
  /*
   * THE SORT FAMILY (item 2458). A full sort MUST hold every row to order them, so `hop1order` is a
   * second GROWING control alongside `hop1` — and unlike `hop1` it cannot be streamed by any
   * implementation, which makes it the one arm whose peak is known a priori.
   *
   * The question is the BOUNDED pair. Item 2148 closed `ORDER BY` + `SKIP`/`LIMIT` as correctly
   * routed and at its floor, and it demonstrated that the bounded path "never materializes the
   * 200,000 rows" FROM TIME: `LIMIT 10` measured 4.97 ms against a 9.93 ms all-rows scan, i.e.
   * cheaper than touching every row. That is good evidence and it is still an INFERENCE — that
   * item contains no memory measurement at all (zero occurrences of peak, bytes, MiB or retained).
   * A top-k whose heap is bounded by `k` has a peak FLAT in the walk; one that sorts and slices has
   * a peak LINEAR in it. Both answer identically and both can be fast enough to pass a time gate.
   *
   * `hop1orderdeepskip` is the arm where the two stories diverge most: item 2148 measured a deep
   * `SKIP` as costing the same as a full sort in TIME, so if the bound is real its peak should
   * track `skip + limit` rather than N.
   */
  hop1order: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k ORDER BY k',
  hop1orderlimit: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k ORDER BY k LIMIT 10',
  hop1orderdeepskip: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k ORDER BY k SKIP 150000 LIMIT 10',
  /*
   * THE VAR-LENGTH FRONTIER (item 2474), the one buffering shape with no memory row — `CLOSED.md`
   * mentions `frontier` 239 times and NOT ONCE alongside a memory quantity.
   *
   * These two differ by ONE KEYWORD and, per `acyclic-reachset-2003.mjs`, by mechanism: TRAIL takes
   * `reachability.ts`'s BFS over the REACHED SET, O(|V| + |E|) at any bound, while ACYCLIC is
   * refused by `needsGeneralMatcher` and runs the general matcher, which ENUMERATES PATHS and is
   * exponential in the bound. That is a claim about TIME and it is already measured (629.47 ms
   * against 28.61 at 20,000 vertices, 22x). Its MEMORY consequence is the open question: a reached
   * set is bounded by |V| whatever the branching; a path enumeration is not.
   *
   * SWEEP FANOUT, NOT SIZE. This file's own header calls fanout "the axis that separates a
   * CONSTANT-FACTOR memory win from a COMPLEXITY one", and it is the third axis after item 2473's N
   * and cardinality — a frontier scales with neither.
   */
  vltrail: 'MATCH TRAIL (a:P)-[:E]->{1,3}(z:P) RETURN DISTINCT z.n AS n',
  vlacyclic: 'MATCH ACYCLIC (a:P)-[:E]->{1,3}(z:P) RETURN DISTINCT z.n AS n',
  /*
   * THE GROUPED AGGREGATE (item 2501) — the one buffering operator this instrument had no shape
   * for. The 13 shapes above cover a fold (`hop1sum`), a list (`hop1collect`), a dedup set
   * (`hop1distinct`), a full sort and a bounded sort; a GROUP BY is none of those, because it holds
   * an ACCUMULATOR PER GROUP. Whether its peak tracks GROUPS or ROWS is the whole question, and
   * nothing had asked it.
   *
   * THE PAIR IS THE INSTRUMENT, and it is self-controlling: the same operator over the same walk,
   * with ONLY the group COUNT changing. The fixture gives `k = i % 97` (97 groups whatever N) and
   * `n = i` (N groups), so:
   *
   *   - `hop1group` MUST be FLAT in N if the implementation holds per-group state. It is the
   *     constant arm, and it is the one that would expose holding every ROW.
   *   - `hop1groupwide` MUST GROW, because its group count IS N. It is the linear arm, and it
   *     proves the instrument can see grouped state at all — without it a flat `hop1group` could
   *     just mean the sampler is blind to this shape (item 2457's rule, as a pair rather than a
   *     note).
   *
   * Read the two TOGETHER. A flat `hop1group` is only meaningful beside a growing `hop1groupwide`.
   *
   * GQL's `GROUP BY` takes a BOUND NAME, not an expression, hence the `LET`. `hop1groupimplicit`
   * is the same 97 groups written WITHOUT an explicit `GROUP BY` — grouping inferred from the
   * aggregate — so the pair is also an equivalent-spelling check on the MEMORY axis, which the
   * spelling probe (a timing instrument) cannot make.
   */
  hop1group: 'MATCH (a:P)-[:E]->(x1:P) LET gk = x1.k RETURN gk AS g, count(*) AS c GROUP BY gk',
  hop1groupwide: 'MATCH (a:P)-[:E]->(x1:P) LET gk = x1.n RETURN gk AS g, count(*) AS c GROUP BY gk',
  hop1groupimplicit: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS g, count(*) AS c',
};

// ── the CHILD: builds the graph, optionally runs the query, reports its own high-water mark ─────

if (ARM === 'child') {
  const nodes = Number(process.env.CHILD_NODES);
  const run = process.env.CHILD_RUN === '1';
  const hold = Number(process.env.CHILD_HOLD_MIB ?? 0);

  if (hold > 0) {
    // CALIBRATION: hold a known number of MiB live at once, then let it go. `Buffer.alloc` touches
    // the pages (it zero-fills), which matters - a reservation that is never written does not
    // appear in RSS, and an instrument calibrated against untouched pages would read zero.
    const held = [];

    for (let i = 0; i < hold; i += 1) {
      held.push(Buffer.alloc(MIB, 1));
    }

    // Read it so nothing can be optimised away, then drop it: the PEAK has already happened.
    let sum = 0;

    for (const b of held) {
      sum += b[0];
    }

    held.length = 0;
    process.stdout.write(
      `${JSON.stringify({ maxRssMiB: process.resourceUsage().maxRSS / 1024, sum })}\n`,
    );
    process.exit(0);
  }

  const { Graph } = await import('@lenke/core');
  const { query } = await import('@lenke/gql');
  const g = new Graph();

  for (let i = 0; i < nodes; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
  }

  /*
   * FANOUT (item 2420), and it is the axis that separates a CONSTANT-FACTOR memory win from a
   * COMPLEXITY one. A rung that materialises rows is O(|V| * F); one that keeps a per-vertex
   * numeric array is O(|V|). At F=1 those coincide and only the constant separates them, so a
   * sweep over |V| at F=1 cannot tell the two apart - the sweep has to be over F.
   */
  const fanout = Number(process.env.CHILD_FANOUT ?? 1);

  for (let e = 0; e < nodes * fanout; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      // Splits on the REPEAT INDEX - CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % nodes}`),
      labels: ['E'],
      properties: {},
    });
  }

  let rows = 0;
  let highWaterMiB = 0;

  if (run) {
    const text = SHAPES[process.env.CHILD_SHAPE];
    const v8 = await import('node:v8');

    // Warm, so plan/parse caches are not charged to the window.
    query(g, text, {});

    if (typeof global.gc === 'function') {
      global.gc();
    }

    /*
     * THE HIGH-WATER MARK INSIDE THE WINDOW. `GCProfiler` reports `usedHeapSize` BEFORE each
     * collection, and a collection happens when the nursery fills - so the maximum of those
     * readings is the live heap at its fullest observed moment, accurate to within one nursery
     * (~1-16 MiB here) rather than to within the whole process history.
     *
     * This is a LOWER BOUND: a peak reached and released between two collections is not seen. It
     * is still the right instrument for the question, because a shape that HOLDS memory keeps it
     * across collections by definition - that is what holding means - so the thing being looked
     * for is exactly the thing this can see.
     */
    const prof = new v8.GCProfiler();

    prof.start();

    const start = process.memoryUsage().heapUsed;

    for (let r = 0; r < REPS; r += 1) {
      const out = query(g, text, {});

      rows = out.length;
    }

    const stats = prof.stop().statistics ?? [];
    let maxUsed = process.memoryUsage().heapUsed;

    for (const ev of stats) {
      const before = ev.beforeGC?.heapStatistics?.usedHeapSize ?? 0;

      if (before > maxUsed) {
        maxUsed = before;
      }
    }

    highWaterMiB = (maxUsed - start) / MIB;
  }

  // maxRSS is in KILOBYTES on Linux.
  process.stdout.write(
    `${JSON.stringify({ maxRssMiB: process.resourceUsage().maxRSS / 1024, rows, highWaterMiB })}\n`,
  );
  process.exit(0);
}

// ── the PARENT ──────────────────────────────────────────────────────────────────────────────────

/** Runs one child and returns its reported high-water mark, or `null` if it died. */
const FANOUT = process.env.FANOUT ?? '1';

const child = (env, heapCapMiB) => {
  const args = [];

  if (heapCapMiB !== undefined) {
    args.push(`--max-old-space-size=${String(heapCapMiB)}`);
  }

  args.push('peakmem-2419.mjs');

  try {
    const out = execFileSync('node', args, {
      encoding: 'utf8',
      env: { ...process.env, ARM: 'child', CHILD_FANOUT: FANOUT, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return JSON.parse(out.trim().split('\n').pop());
  } catch {
    // An OOM kill, a heap-cap abort or a throw all mean "could not complete at this cap", which is
    // the signal `MECH=cap` bisects on. Distinguishing them would not change the answer.
    return null;
  }
};

if (SHAPE === 'cal') {
  console.log('# CALIBRATION  a child holds a KNOWN number of MiB live at once');
  console.log(
    '#   maxRSS must track it ~1:1 above the interpreter baseline, or no peak below is readable',
  );

  const base = child({ CHILD_HOLD_MIB: '0', CHILD_NODES: '0' });
  const baseline = base === null ? 0 : base.maxRssMiB;

  console.log(`#   interpreter baseline: ${baseline.toFixed(1)} MiB`);

  for (const mib of HOLD_MIB > 0 ? [HOLD_MIB] : [64, 128, 256, 512]) {
    const r = child({ CHILD_HOLD_MIB: String(mib), CHILD_NODES: '0' });

    if (r === null) {
      console.log(`  hold ${String(mib)} MiB  CHILD DIED — cannot calibrate`);
      continue;
    }

    const over = r.maxRssMiB - baseline;

    console.log(
      `  hold ${String(mib).padStart(4)} MiB  maxRSS ${r.maxRssMiB.toFixed(1).padStart(7)} MiB  ` +
        `over baseline ${over.toFixed(1).padStart(7)}  => ${(over / mib).toFixed(2)}x of what was held`,
    );
  }

  process.exit(0);
}

const text = SHAPES[SHAPE];

if (text === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join('|')}`);
}

console.log(`# SHAPE=${SHAPE} MECH=${MECH} FANOUT=${FANOUT} REPS=${REPS} CAP_STEP=${CAP_STEP}`);
console.log(`# ${text}`);

if (MECH === 'cap') {
  /*
   * THE SMALLEST HEAP THE SHAPE CAN COMPLETE IN, by bisection. This is the OOM question asked
   * directly: a shape that needs 40 MiB more heap than the graph alone cannot be run on a box with
   * less, however little it churns.
   *
   * Differenced against a GRAPH-ONLY arm at the same size, because the graph's own footprint is not
   * the query's and would otherwise dominate every reading.
   */
  const minCap = (run, nodes) => {
    let lo = 16;
    let hi = 4096;

    // Establish that `hi` works at all, so a bisection on an always-failing shape terminates with
    // a verdict rather than converging on a meaningless bound.
    if (
      child({ CHILD_NODES: String(nodes), CHILD_RUN: run ? '1' : '0', CHILD_SHAPE: SHAPE }, hi) ===
      null
    ) {
      return null;
    }

    /*
     * THE BISECTION TOLERANCE WAS HARD-CODED AT 8 MiB, AND THAT IS WHAT MADE THIS MECHANISM LOOK
     * UNFIT (item 2475). Item 2474 swept fanout and got exactly 8 MiB in every cell — including the
     * LINEAR control `hop1`, which returns every row and must scale — while the graph-only baseline
     * moved 47 -> 71 MiB. The signal was smaller than the step, so the rows were unreadable rather
     * than flat. `cap` was coarse by a constant, not blind by construction.
     *
     * `CAP_STEP` is that constant. The default stays 8 so every earlier reading remains reproducible;
     * a finer step costs log2(8 / step) extra child processes per arm, so 1 MiB is three more.
     */
    while (hi - lo > CAP_STEP) {
      const mid = Math.floor((lo + hi) / 2);
      const ok =
        child(
          { CHILD_NODES: String(nodes), CHILD_RUN: run ? '1' : '0', CHILD_SHAPE: SHAPE },
          mid,
        ) !== null;

      if (ok) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    return hi;
  };

  for (const nodes of SIZES) {
    const graphOnly = minCap(false, nodes);
    const withQuery = minCap(true, nodes);
    const delta = graphOnly === null || withQuery === null ? null : withQuery - graphOnly;

    console.log(
      `  N=${String(nodes).padStart(7)}  graph alone needs ${String(graphOnly).padStart(5)} MiB  ` +
        `with the query ${String(withQuery).padStart(5)} MiB  ` +
        `=> THE QUERY NEEDS ${delta === null ? '??' : String(delta).padStart(4)} MiB`,
    );
  }

  process.exit(0);
}

const rows = [];

for (const nodes of SIZES) {
  const withQuery = child({ CHILD_NODES: String(nodes), CHILD_RUN: '1', CHILD_SHAPE: SHAPE });

  if (withQuery === null) {
    console.log(`  N=${String(nodes)}  THE CHILD DIED — no reading`);
    continue;
  }

  rows.push({ nodes, peak: withQuery.highWaterMiB, rss: withQuery.maxRssMiB, out: withQuery.rows });
}

for (const [i, r] of rows.entries()) {
  const prev = i === 0 ? undefined : rows[i - 1];
  // The growth exponent: `log2(peak ratio) / log2(size ratio)`. 0 is constant, 1 is linear — and
  // which of those a shape is matters more than the MiB, because only one of them has an OOM size.
  const exp =
    prev === undefined || prev.peak <= 0
      ? undefined
      : Math.log2(r.peak / prev.peak) / Math.log2(r.nodes / prev.nodes);

  const perEl = `${((r.peak * MIB) / r.nodes).toFixed(1).padStart(7)} B/element`;
  const growth = exp === undefined ? '' : `  growth n^${exp.toFixed(2)}`;

  console.log(
    `  N=${String(r.nodes).padStart(7)}  PEAK LIVE ${r.peak.toFixed(2).padStart(8)} MiB  ${perEl}  (process maxRSS ${r.rss.toFixed(0)} MiB)  rows ${String(r.out).padStart(7)}${growth}`,
  );
}

/*
 * THE END-TO-END EXPONENT IS THE ONE TO READ. A pairwise exponent inherits the lower-bound
 * granularity of a GC-point maximum - if a collection lands at an unlucky moment one cell
 * understates and its two neighbouring exponents swing hard (the linear control read n^1.01, then
 * n^-0.49, then n^1.96 across one sweep). Over the whole 8x range those cancel: the same control
 * reads n^0.82 end to end, which is unambiguously not n^0.
 */
if (rows.length >= 2) {
  const [first] = rows;
  const last = rows.at(-1);
  const exp =
    first.peak <= 0
      ? undefined
      : Math.log2(last.peak / first.peak) / Math.log2(last.nodes / first.nodes);

  const shown = exp === undefined ? 'n/a' : `n^${exp.toFixed(2)}`;
  /*
   * A MAGNITUDE FLOOR ON THE VERDICT, because an exponent computed from readings at the
   * instrument's resolution is not a verdict.
   *
   * `hop2sum`'s peak is under 2 MiB at every walk size, and across two runs of this arm the same
   * shape read n^-0.20 ("CONSTANT") and then n^0.30 ("GROWS") - from 1.25 -> 0.83 MiB and
   * 0.93 -> 1.74 MiB. Both readings say the same USEFUL thing (it never exceeds ~2 MiB while
   * `hop1sum` reaches 36) and the exponent between them is noise, because a GC-point maximum is a
   * lower bound and at this magnitude one unlucky collection moves it 2x.
   *
   * So below the floor this arm declines to rule and points at `MECH=cap`, which is a THRESHOLD
   * and does not have this failure mode.
   */
  const FLOOR_MIB = 4;
  let verdict;

  if (last.peak < FLOOR_MIB) {
    verdict = `NEVER EXCEEDS ${last.peak.toFixed(2)} MiB — at the resolution floor, so the exponent is noise; use MECH=cap to rule`;
  } else if (exp !== undefined && exp < 0.25) {
    verdict = 'CONSTANT — no OOM size';
  } else {
    verdict = 'GROWS WITH THE WALK — there is an OOM size';
  }

  console.log(
    `#   END TO END over ${String(last.nodes / first.nodes)}x the walk: ${first.peak.toFixed(2)} -> ${last.peak.toFixed(2)} MiB  => ${shown}  ${verdict}`,
  );
}

console.log(
  '#   growth n^0 is CONSTANT (no OOM size); n^1 is LINEAR in the walk (there is one). Check the ' +
    'two controls: hop1count must be ~n^0 and hop1 must be ~n^1, or the instrument is wrong.',
);
