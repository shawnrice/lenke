/**
 * ARE ITEM 2414's FOUR ONE-HOP FLAGS A ROUTE GAP, OR IS THE BASELINE THE FAST ARM?
 *
 * Item 2414's screen left four flags, every one at DEPTH 1: `topk` 3.0x, `grouped` 3.4x,
 * `skiponly` 2.8x and `collect` 2.7x, each against its own `rows` cell. Two facts turn that from a
 * nomination into a question with two readings, and this probe is built to separate them.
 *
 * FIRST: EVERY ONE OF THE FOUR ALREADY HAS A WILLING RUNG AT DEPTH 1 (`onehop-routes-2415.ts`):
 *
 *     rows      hopProjection          topk      hopProjection   <- the SAME rung as rows
 *     skiponly  hopProjection          grouped   groupHopShortcut, groupedHopAggregate
 *     collect   hopAggregate           count     countShortcut
 *
 * So this is NOT the between-rungs class the screen was built to find. `topk` and `skiponly` ride
 * the very rung their baseline rides.
 *
 * SECOND: THE BASELINE AND THE MODIFIER TAKE DIFFERENT WALKS DOWN THAT ONE RUNG.
 * `hopOrderPlan` ends `startDriven: forceStartDriven || sorts !== undefined || pageSkip !== 0`, so
 * an `ORDER BY` or a non-zero `SKIP` forces the START-DRIVEN walk, while the unmodified `rows` cell
 * takes the FAR-DRIVEN one. That choice is a correctness constraint (the far-driven walk reorders
 * rows, and a stable sort would move ties away from native), and it is reachable at all only
 * because the screen's graph is LABEL-HOMOGENEOUS: `farDriven` runs when
 * `startLabel === undefined || vacuousLabel(graph, startLabel)`.
 *
 * SO THE RATIO HAS TWO READINGS AND THE SCREEN CANNOT TELL THEM APART:
 *
 *   - a modifier pays for work the baseline does not do (sorting really costs something), in which
 *     case the honest reference is the baseline PLUS that work - items 659/660's floor rule, which
 *     item 698 applied to this exact shape and got **0.86x at degree 1**, with the note that the
 *     unordered reference overstates by ~1.9x; or
 *   - the baseline is standing on an arm no real schema can reach, in which case the gap is an
 *     artifact of the fixture and shrinks to nothing under a realistic label.
 *
 * BOTH ARE MEASURED HERE, because reasoning about which costs nothing and has been wrong twice in
 * a row on this exact file (item 2402's entry: "Two items in a row located this blocker by
 * argument; both were wrong, and an ablation costs one build").
 *
 *   FLOOR ARMS. `*-floor` runs the `rows` query and then does the modifier's own work in JS over
 *   the engine's OWN rows - sorting them, slicing them, grouping them, listing them. That is the
 *   honest reference item 698 demands, and the difference between a cell and its floor is the only
 *   part of the ratio that is about the ROUTE.
 *
 *   MIXED=1 adds ONE ISOLATED off-label vertex - item 1943's design, no edges, so EVERY ANSWER IS
 *   UNCHANGED and only `vertexCount` moves. It is the minimal perturbation that makes
 *   `vacuousLabel` false, which is what a real `Person`/`Company` schema does permanently.
 *   [[label-vacuity-gates-fast-paths]] is the standing note: the fast number in every homogeneous
 *   screen row is unreachable for a real schema.
 *
 * ONE SHAPE PER PROCESS, which is CLAUDE.md's rule and not a convenience: in a two-arm process the
 * surviving dispatch site is less polymorphic and every specialization change reads flattered.
 * The driver (`onehopfam-ab-2415.sh`) runs each shape in its own process and alternates the order.
 *
 * 14 reps, the first 3 dropped as the JIT tiering up, MEDIAN of the rest - and the per-rep SERIES
 * is printed, because item 2413 nearly shipped a bimodal row's slow mode as a floor.
 *
 *     SHAPE=rows node onehopfam-2415.mjs
 *     SHAPE=topk MIXED=1 node onehopfam-2415.mjs
 *     SHAPE=topk-floor node onehopfam-2415.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/** 400,000 is item 2414's default, where the screen's cells are readable rather than sub-ms. */
const NODES = Number(process.env.NODES ?? 400_000);
const REPS = Number(process.env.REPS ?? 14);
const WARMUP = Number(process.env.WARMUP ?? 3);
const SHAPE = process.env.SHAPE ?? 'rows';
const MIXED = process.env.MIXED === '1';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

/**
 * FANOUT, added at item 2420 because it is the axis that decides a memory-vs-time trade.
 *
 * At FANOUT=1 a one-hop walk returns |V| rows, so a rung that is O(paths) and one that is O(|V|)
 * look alike - which is the LEVEL FOLD's worst case and the default this probe has always used.
 * Above 1 the row count is |V|*F while a level fold stays O(|V|), so the comparison only becomes
 * informative here. The stride splits on the REPEAT INDEX, CLAUDE.md's fix for the `(a*k+b) % N`
 * degeneracy - without it one vertex's F edges all land on the SAME target and every count is
 * `F^k` by construction while every degree still looks perfect.
 */
const FANOUT = Number(process.env.FANOUT ?? 1);

/*
 * FAN-IN, the THIRD gating axis (item 2445) and the one this screen could not vary.
 *
 * `hop-projection.ts`'s multi-type far-driven route sits behind item 1390's SIGNED cost gate: it
 * WINS at in-degree ~133 and LOSES at fan-in 1, so a UNIFORM graph never exercises it. Item 2444
 * measured a uniform fixture, got the declining route, and quoted 5.2x where the real figure is
 * 1.78x. Every number this screen has produced so far describes fan-in ~1 only.
 *
 * `FANIN` is the fraction of vertices eligible as edge TARGETS: 1 spreads them over the whole graph
 * (in-degree ~1), 0.01 concentrates them onto 1% of it (in-degree ~100). Sources are untouched, so
 * out-degree and the ROW COUNT are invariant and the cells stay comparable across the sweep.
 */
const FANIN = Number(process.env.FANIN ?? 1);
const TARGETS = Math.max(1, Math.floor(NODES * FANIN));

/*
 * WHICH MAPPING PICKS THE TARGET, and it exists because a spike turned out to depend on it.
 *
 * `arith` is the original `(i * 7 + 3) % TARGETS`. `hash` is a multiplicative hash (Knuth's
 * 2654435761, the same constant the FANOUT term already uses) which has no small-factor structure
 * against the modulus. Item 2446 measured a reproducible 2.7-3.2x spike at TARGETS 1000 and 2000
 * under `arith` that is absent at 600, 1100 and 4000 — the power-of-two load-factor hypothesis is
 * refuted by 4000 being fast — so the question is whether the engine has a cliff or the GENERATOR
 * does. Two mappings over the same target count answers it.
 */
const FANIN_GEN = process.env.FANIN_GEN ?? 'arith';

const targetOf = (i, hop) =>
  FANIN_GEN === 'hash'
    ? Math.abs(Math.imul(i + hop * 7919, 2_654_435_761)) % TARGETS
    : (i * 7 + 3 + hop * 2_654_435_761) % TARGETS;

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${targetOf(i, hop)}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

/*
 * COUNT THE DISTINCT ENDPOINTS, because CLAUDE.md's rule is that a changed or raised-fanout fixture
 * is not trustworthy until they are counted — `to = (a*k + b) % N` is invariant under `k -> k + N`,
 * which has twice produced a FUNCTIONAL graph whose degrees looked perfect and whose k-hop counts
 * were `F^k` by construction. Concentrating the targets is exactly the kind of change that can
 * collapse them, so it is asserted rather than hoped: the distinct target count must be the
 * requested TARGETS (within the modulus's reach), not a handful.
 */
const distinctTargets = new Set();

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  distinctTargets.add(targetOf(i, hop));
}

const wantTargets = Math.min(TARGETS, NODES * FANOUT);

if (distinctTargets.size < wantTargets * 0.9) {
  throw new Error(
    `FIXTURE DEGENERATE: FANIN=${FANIN} asked for ~${wantTargets} distinct targets but the ` +
      `generator reaches only ${distinctTargets.size}. A number from this fixture would describe ` +
      `a graph with far more skew than requested.`,
  );
}

if (MIXED) {
  // NO EDGES and a label nothing matches, so the ANSWER cannot move - only `vacuousLabel`.
  g.addVertex({ id: 'off', labels: ['Z'], properties: {} });
}

/**
 * DEPTH, added once the MIXED grid nominated a DIFFERENT family than the one this probe was built
 * for. With item 2414's four flags explained, `MIXED=1` raised six new ones, four of which are
 * DEPTH-1 INVERSIONS that do not exist in the homogeneous grid - `sum` reads 22.7 -> 34.7 across
 * depths 1-2 when the label is vacuous and **57.2 -> 35.4** when it is not. A shorter chain costing
 * more is the item-1822 signature, so it needs the isolated instrument rather than one screen cell.
 */
const DEPTH = Number(process.env.DEPTH ?? 1);

const FAR = DEPTH === 1 ? 'x1' : `x${String(DEPTH)}`;
const PATTERN = (() => {
  let text = 'MATCH (a:P)';

  for (let d = 1; d <= DEPTH; d += 1) {
    text += `-[:E]->(x${String(d)}:P)`;
  }

  return text;
})();

/**
 * The query each arm runs, and for a `*-floor` arm it is the `rows` query - the floor's extra work
 * happens in JS below, over the engine's own rows.
 */
const TEXT = {
  rows: `${PATTERN} RETURN ${FAR}.k AS k`,
  topk: `${PATTERN} RETURN ${FAR}.k AS k ORDER BY k LIMIT 10`,
  skiponly: `${PATTERN} RETURN ${FAR}.k AS k SKIP 5`,
  grouped: `${PATTERN} RETURN ${FAR}.k AS k, count(*) AS c`,
  collect: `${PATTERN} RETURN collect(${FAR}.k) AS ks`,
  // CONTROLS. `orderby` is `topk` without the LIMIT; `count` is the cheapest aggregate there is.
  orderby: `${PATTERN} RETURN ${FAR}.k AS k ORDER BY k`,
  count: `${PATTERN} RETURN count(*) AS c`,
  // ── THE MIXED GRID'S OWN NOMINATION (the six flags that appear only with a realistic label) ──
  sum: `${PATTERN} RETURN sum(${FAR}.k) AS s`,
  maxagg: `${PATTERN} RETURN max(${FAR}.k) AS m`,
  distinct: `${PATTERN} RETURN DISTINCT ${FAR}.k AS k`,
  countdist: `${PATTERN} RETURN count(DISTINCT ${FAR}.k) AS c`,
  where: `${PATTERN} WHERE ${FAR}.k > 44 RETURN ${FAR}.k AS k`,
  // A SECOND projected column (item 2429's flag): its MARGINAL cost over `rows` should be flat in
  // depth, because copying one extra value per row costs the same whatever walk produced the row.
  twocol: `${PATTERN} RETURN ${FAR}.k AS k, ${FAR}.s AS s`,
};

/** The modifier's own work, done in JS over the engine's rows — the honest floor's second half. */
const FLOOR = {
  'topk-floor': (rows) => {
    const ks = rows.map((r) => r.k);

    ks.sort((a, b) => a - b);

    return ks.slice(0, 10).length;
  },
  'orderby-floor': (rows) => {
    const ks = rows.map((r) => r.k);

    ks.sort((a, b) => a - b);

    return ks.length;
  },
  'skiponly-floor': (rows) => rows.slice(5).length,
  'grouped-floor': (rows) => {
    const by = new Map();

    for (const r of rows) {
      by.set(r.k, (by.get(r.k) ?? 0) + 1);
    }

    return by.size;
  },
  // The aggregate floors: the same reduction over the engine's own rows.
  'sum-floor': (rows) => {
    let t = 0;

    for (const r of rows) {
      t += r.k;
    }

    return t;
  },
  'maxagg-floor': (rows) => {
    let m = -Infinity;

    for (const r of rows) {
      if (r.k > m) {
        m = r.k;
      }
    }

    return m;
  },
  'distinct-floor': (rows) => new Set(rows.map((r) => r.k)).size,
  'countdist-floor': (rows) => new Set(rows.map((r) => r.k)).size,
  /*
   * THE HONEST FLOOR FOR A CLAUSE `WHERE` (item 698's rule, applied at item 2431). The screen flags
   * `where` at 3.2x its own ROWS cell, and item 698 measured exactly that error on the sorted hop:
   * 0.86x of the honest floor where the bare-rows reference claimed 1.9x worse. A predicate really
   * costs something, so the reference is the row form PLUS the filter's own work over the engine's
   * own rows.
   */
  'where-floor': (rows) => rows.filter((r) => r.k > 44).length,
  'collect-floor': (rows) => {
    const out = [];

    for (const r of rows) {
      if (r.k !== null && r.k !== undefined) {
        out.push(r.k);
      }
    }

    return out.length;
  },
};

const isFloor = SHAPE.endsWith('-floor');
const text = isFloor ? TEXT.rows : TEXT[SHAPE];

if (text === undefined || (isFloor && FLOOR[SHAPE] === undefined)) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

/** The row count or the aggregate's own size, printed per cell — a zero-row cell is a broken arm. */
const sizeOf = (out) => {
  if (out.length === 1) {
    const [only] = out;
    const vals = Object.values(only);

    if (vals.length === 1 && Array.isArray(vals[0])) {
      return vals[0].length;
    }
  }

  return out.length;
};

const series = [];
let answer = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = query(g, text, {});
  const got = isFloor ? FLOOR[SHAPE](out) : sizeOf(out);
  const ms = performance.now() - t0;

  series.push(ms);
  answer = got;
}

const kept = series.slice(WARMUP).sort((a, b) => a - b);
const mid = kept.length >> 1;
const med = kept.length % 2 === 1 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2;

/*
 * IS THE WARMUP LONG ENOUGH? Asserted, because this probe reported a 2.5x "band" that did not exist
 * (item 2447 correcting item 2446).
 *
 * These routes tier up slowly AND arm an adaptive cache: a `distinct` series reads
 * `68.9 21.9 6.4 4.3 4.0 3.8 …` at one target count and `69.2 15.9 12.4 12.7 12.7 5.5 4.8 …` at
 * another — settling at rep 4 in one case and rep 6 in the other. With WARMUP=3 the median then
 * lands INSIDE the transient for one cell and outside it for the next, and the difference reads as
 * a property of the graph. It is a property of the harness.
 *
 * THE CHECK: the SLOWEST kept sample must not be wildly above the median. A still-tiering series
 * fails this; genuine run-to-run noise does not. It is a warning rather than a throw because a few
 * shapes are legitimately bimodal (`csrAskedBefore` arms mid-series by design), and silently
 * dropping those cells would hide real behaviour — but an unflagged number is now a number whose
 * warmup was checked.
 */
const WARMUP_TOLERANCE = Number(process.env.WARMUP_TOL ?? 2);
const slowestKept = kept[kept.length - 1];

if (slowestKept > med * WARMUP_TOLERANCE) {
  console.log(
    `  WARMUP SUSPECT (spread): slowest kept sample ${slowestKept.toFixed(1)} ms is ` +
      `${(slowestKept / med).toFixed(1)}x the median ${med.toFixed(2)} — the series is probably ` +
      `still tiering up, so this median is not comparable across cells. Raise WARMUP or REPS.`,
  );
}

/*
 * THE SECOND SIGNAL, and it is the one that matters: a window entirely INSIDE the transient has no
 * spread to detect. Item 2447's phantom band was exactly that — every kept sample slow, so the
 * check above passed while the median was 2.5x the settled cost.
 *
 * So compare the median against the LAST samples in TIME order, which are the most warmed. If the
 * median sits well above them, the window is still descending and the number describes the tier-up
 * rather than the route.
 */
const tail = series.slice(-3);
const tailFloor = Math.min(...tail);

if (med > tailFloor * WARMUP_TOLERANCE) {
  console.log(
    `  WARMUP SUSPECT (descending): median ${med.toFixed(2)} ms is ` +
      `${(med / tailFloor).toFixed(1)}x the fastest of the last three samples ` +
      `${tailFloor.toFixed(1)} — the whole kept window is still tiering up. Raise WARMUP or REPS.`,
  );
}

console.log(
  `${SHAPE.padEnd(16)} d${DEPTH} F=${FANOUT} FANIN=${FANIN}/${FANIN_GEN} MIXED=${MIXED ? 1 : 0} NODES=${NODES} median=${med.toFixed(2)} ms answer=${answer}`,
);
console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
