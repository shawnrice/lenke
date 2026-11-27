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

for (let e = 0; e < NODES; e += 1) {
  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${e}`),
    // FANOUT=1 and a bijective stride, so every vertex has out-degree AND in-degree exactly 1 and
    // the depth axis is about the route rather than the row count. This is the screen's fixture.
    to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
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

console.log(
  `${SHAPE.padEnd(16)} d${DEPTH} MIXED=${MIXED ? 1 : 0} NODES=${NODES} median=${med.toFixed(2)} ms answer=${answer}`,
);
console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
