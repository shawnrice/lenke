/**
 * WHERE DOES A SHORTER OR SIMPLER QUERY COST MORE THAN A LONGER ONE? The mechanical screen for
 * BETWEEN-RUNGS gaps (item 1823).
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER PROFILE. Items 1821 and 1822 each found a rung gap by
 * hand, and the second was only visible because the first happened to measure three widths on one
 * fixture and noticed the order was wrong:
 *
 *     one hop     served by `distinctShape`                  fast
 *     TWO hops    served by NOTHING                       2141.9 ms
 *     three hops  served by `detectChainProjection`         210.8 ms
 *
 * ⚠️ **A GAP BETWEEN TWO RUNGS IS INVISIBLE TO EVERY INSTRUMENT HERE.** Each rung's own tests pass
 * — each correctly serves its own width. The unpriced-frame screen sees nothing, because the
 * general matcher is not a hot frame: it is the ABSENCE of a rung, and absence has no frame. And a
 * single shape measured alone looks merely slow, not anomalous. The signal only exists in the
 * COMPARISON between neighbouring cells, which is what this grid is.
 *
 * TWO FLAGS, and each is the generalization of one of those two items:
 *
 *   - **NON-MONOTONIC IN DEPTH** — depth k costs materially more than depth k+1. At `FANOUT=1`
 *     every depth returns the same row count, so cost should rise GENTLY with depth; a shorter
 *     chain costing more is the item-1822 signature and means the depth fell between two rungs.
 *   - **PAIR GAP** — a modifier cell costing much more than its own `rows` twin at the same depth.
 *     `DISTINCT` can only ever be the walk plus a hash (item 1821: the two must sit together, and
 *     "within 1.3%" was the result rather than the ratio), and `count(*)` can only be cheaper. A
 *     modifier that multiplies the cost is a modifier that disqualified the rung.
 *
 * ⚠️ `FANOUT=1` IS DELIBERATE AND IS WHAT MAKES THE DEPTH AXIS COMPARABLE. With one out-edge per
 * vertex and a functional stride, depth k returns exactly N rows for every k — so a cost difference
 * across depth is about the ROUTE and not about how many rows came back. At a higher fanout the row
 * count is `F^k` and the depth axis measures the fixture instead, which is item 1815's whole
 * finding. ⚠️ The stride still splits on the repeat index, so the graph is not the degenerate
 * `(a*k+b) % N` one CLAUDE.md warns about, even though at FANOUT=1 it cannot branch.
 *
 * ⚠️ AND THE ROW COUNT IS PRINTED FOR EVERY CELL, because a cell that returns nothing is the
 * "fastest" cell on any screen. A zero-row cell is a broken grid, not a fast route — item 1820's
 * screen learned this the same way.
 *
 *     bun rung-gap-screen.mjs
 *     DEPTHS=1,2,3,4,5 REPS=20 bun rung-gap-screen.mjs
 *     ENGINE=gremlin bun rung-gap-screen.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  V,
  count,
  dedupe,
  fold,
  groupCount,
  gt,
  has,
  hasLabel,
  limit,
  max,
  order,
  out,
  skip,
  sum,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 9);
const WARMUP = Number(process.env.WARMUP ?? 3);
const DEPTHS = (process.env.DEPTHS ?? '1,2,3,4,5').split(',').map(Number);
/** Flag a pair gap at this multiple of the depth's own `rows` cell. */
const PAIR_FLAG = Number(process.env.PAIR_FLAG ?? 2.5);
/** Flag non-monotonicity when a shallower depth costs this multiple of a deeper one. */
const DEPTH_FLAG = Number(process.env.DEPTH_FLAG ?? 1.5);
/**
 * ⚠️ A NOISE FLOOR, because the first run flagged `count: depth2 1.0 ms costs 2.0x depth3 (0.5)`.
 * Both cells are a closed-form count answered without walking, so the "2.0x" is 0.5 ms of timer
 * resolution — a ratio between two numbers that are both essentially zero. CLAUDE.md's rule is that
 * anything under ~10% needs its own isolated harness; the same logic says a RATIO needs an absolute
 * magnitude before it means anything. Cells below this are compared but never flagged.
 */
const FLOOR_MS = Number(process.env.FLOOR_MS ?? 3);
/**
 * ⚠️ THE THIRD FLAG, AND IT EXISTS BECAUSE THE FIRST TWO HAD A BLIND SPOT EXACTLY WHERE THE BIGGEST
 * GAP WAS (item 1826). `ORDER BY`'s marginal cost over its own `rows` cell goes **1.3 → 46.5 → 53.2
 * → 75.3 → 88.6 ms** across depths 1-5 in GQL, while Gremlin's `order()` is **1.2 → 1.1 → 1.6 → 1.7
 * → 1.6** — flat. A 36x jump between depth 1 and depth 2, and NEITHER existing flag could see it:
 *
 *   - `DEPTH_FLAG` only fires when a SHALLOWER cell costs MORE than a deeper one, and this rises
 *     monotonically, which looks like honest extra work.
 *   - `PAIR_FLAG` excludes `orderby` BY DESIGN, because a global sort really is extra work and its
 *     raw ratio would be noise.
 *
 * Both exclusions are individually right and together they hid a 36x. The quantity that is not
 * noise is the MARGINAL cost — cell minus its own `rows` cell at the same depth — compared across
 * DEPTH within one modifier: sorting N rows costs the same whatever walk produced them, so a
 * marginal that explodes with depth means the modifier lost its route at some width.
 */
const JUMP_FLAG = Number(process.env.JUMP_FLAG ?? 5);
const ENGINE = process.env.ENGINE ?? 'gql';

if (ENGINE !== 'gql' && ENGINE !== 'gremlin') {
  throw new Error(`ENGINE must be gql|gremlin, got ${ENGINE}`);
}

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

/** `MATCH (a:P)-[:E]->(x1:P)-[:E]->…` of the given depth, with the far variable's name. */
const chain = (depth) => {
  let text = 'MATCH (a:P)';
  let far = 'a';

  for (let d = 1; d <= depth; d += 1) {
    far = `x${d}`;
    text += `-[:E]->(${far}:P)`;
  }

  return { text, far };
};

/**
 * The modifier axis. Each takes the chain and returns a whole query, so a cell is one query and the
 * grid is depth x modifier. `rows` is the baseline every other cell in its row is compared against.
 */
const MODIFIERS = {
  rows: ({ text, far }) => `${text} RETURN ${far}.k AS k`,
  distinct: ({ text, far }) => `${text} RETURN DISTINCT ${far}.k AS k`,
  distinct2: ({ text, far }) => `${text} RETURN DISTINCT ${far}.k AS k, ${far}.s AS s`,
  count: ({ text }) => `${text} RETURN count(*) AS c`,
  countdist: ({ text, far }) => `${text} RETURN count(DISTINCT ${far}.k) AS c`,
  where: ({ text, far }) => `${text} WHERE ${far}.k > 44 RETURN ${far}.k AS k`,
  twocol: ({ text, far }) => `${text} RETURN ${far}.k AS k, ${far}.s AS s`,
  orderby: ({ text, far }) => `${text} RETURN ${far}.k AS k ORDER BY k`,
  // ── Item 1829: six more modifiers, because every widening of this axis has found something ──
  //
  // ⚠️ `topk` and `skiponly` are the WINDOWS item 1827 deliberately left on the general path, so
  // they are here to watch rather than to fix: a marginal that grows with depth would mean the
  // bounded-top-k route is itself width-limited, which is a different claim from the one 1827 made.
  topk: ({ text, far }) => `${text} RETURN ${far}.k AS k ORDER BY k LIMIT 10`,
  skiponly: ({ text, far }) => `${text} RETURN ${far}.k AS k SKIP 5`,
  sum: ({ text, far }) => `${text} RETURN sum(${far}.k) AS s`,
  maxagg: ({ text, far }) => `${text} RETURN max(${far}.k) AS m`,
  grouped: ({ text, far }) => `${text} RETURN ${far}.k AS k, count(*) AS c`,
  collect: ({ text, far }) => `${text} RETURN collect(${far}.k) AS ks`,
};

/**
 * The GREMLIN grid — item 1826. Deliberately the SAME QUESTIONS as the GQL `MODIFIERS` above, so a
 * difference between the two tables is a difference between the engines and not between two sets of
 * queries. ⚠️ `values(k)` is the row-producing tail rather than a bare far-end step, because a
 * traversal ending in an ELEMENT returns vertices and a GQL projection returns a scalar: comparing
 * those would compare egress shapes, not routes.
 */
const GREMLIN_MODIFIERS = {
  rows: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k')),
  distinct: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), dedupe()),
  count: (d) => traversal(V(), hasLabel('P'), ...hops(d), count()),
  countdist: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), dedupe(), count()),
  where: (d) => traversal(V(), hasLabel('P'), ...hops(d), has('k', gt(44)), values('k')),
  orderby: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), order()),
  topk: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), order(), limit(10)),
  skiponly: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), skip(5)),
  sum: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), sum()),
  maxagg: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), max()),
  grouped: (d) => traversal(V(), hasLabel('P'), ...hops(d), groupCount({ by: 'k' })),
  collect: (d) => traversal(V(), hasLabel('P'), ...hops(d), values('k'), fold()),
};

/** `d` repetitions of `out('E')`, so the depth axis is the same quantity on both surfaces. */
const hops = (d) => Array.from({ length: d }, () => out('E'));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const g = build();

console.log(
  `# rung-gap-screen ENGINE=${ENGINE} NODES=${NODES} FANOUT=1 reps=${REPS} drop=${WARMUP}`,
);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}`);
console.log(
  '# FANOUT=1 so every depth returns the same row count — a depth difference is ROUTE.\n',
);

/**
 * ⚠️ ONE TIMED CELL, TWO ENGINES, AND THE PLAN IS BUILT ONCE OUTSIDE THE LOOP on the Gremlin side.
 * `runtime-profile-gremlin-probe.mjs`'s header records why: every `SHAPES` entry there is built at
 * module level and the plan object reused across reps, because building the traversal per rep would
 * time the BUILDER. The GQL side has the parse+plan caches doing the same job, so the two arms are
 * comparable — but only because this is explicit rather than incidental.
 */
const cell = (built) => {
  const series = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    try {
      rows = ENGINE === 'gql' ? query(g, built).length : toArray(built, g).length;
    } catch {
      return { ms: Number.NaN, rows: -1 };
    }

    series.push(performance.now() - t0);
  }

  return { ms: median(series.slice(WARMUP)), rows };
};

/** The query or traversal for one cell, built ONCE — see `cell`. */
const buildCell = (name, depth) =>
  ENGINE === 'gql' ? MODIFIERS[name](chain(depth)) : GREMLIN_MODIFIERS[name](depth);

const names = Object.keys(ENGINE === 'gql' ? MODIFIERS : GREMLIN_MODIFIERS);
const grid = new Map();

console.log(
  `${'modifier'.padEnd(11)}${DEPTHS.map((d) => `depth${d}`.padStart(12)).join('')}   rows@maxdepth`,
);

for (const name of names) {
  const row = [];

  for (const depth of DEPTHS) {
    const got = cell(buildCell(name, depth));

    row.push(got);
  }

  grid.set(name, row);

  const cells = row
    .map((c) => (Number.isNaN(c.ms) ? 'ERR' : c.ms.toFixed(1)).padStart(12))
    .join('');

  console.log(`${name.padEnd(11)}${cells}   ${row[row.length - 1].rows}`);
}

// ── THE FLAGS ───────────────────────────────────────────────────────────────────────────────────
const flags = [];

for (const [name, row] of grid) {
  row.forEach((c, i) => {
    if (c.rows === 0) {
      flags.push(`${name} depth${DEPTHS[i]}: ZERO ROWS — broken grid cell, not a fast route`);
    }

    if (c.rows === -1) {
      flags.push(`${name} depth${DEPTHS[i]}: THREW — the query is not valid, fix the grid`);
    }
  });

  // NON-MONOTONIC IN DEPTH: a shallower cell costing materially more than a deeper one.
  for (let i = 0; i + 1 < row.length; i += 1) {
    const a = row[i];
    const b = row[i + 1];

    if (
      !Number.isNaN(a.ms) &&
      !Number.isNaN(b.ms) &&
      a.ms >= FLOOR_MS &&
      a.ms > DEPTH_FLAG * b.ms
    ) {
      flags.push(
        `${name}: depth${DEPTHS[i]} (${a.ms.toFixed(1)} ms) costs ` +
          `${(a.ms / b.ms).toFixed(1)}x depth${DEPTHS[i + 1]} (${b.ms.toFixed(1)}) — ` +
          'a SHORTER chain costing more means that depth fell between two rungs',
      );
    }
  }
}

const base = grid.get('rows');

for (const [name, row] of grid) {
  if (name === 'rows' || name === 'orderby') {
    // `orderby` is excluded from the pair flag ON PURPOSE: a global sort is real extra work, not a
    // route it should have taken, so a large ratio there is expected and would be noise here.
    continue;
  }

  row.forEach((c, i) => {
    const b = base[i];

    if (!Number.isNaN(c.ms) && !Number.isNaN(b.ms) && c.ms >= FLOOR_MS && c.ms > PAIR_FLAG * b.ms) {
      flags.push(
        `${name} depth${DEPTHS[i]}: ${c.ms.toFixed(1)} ms is ${(c.ms / b.ms).toFixed(1)}x its own ` +
          `rows cell (${b.ms.toFixed(1)}) — a modifier that multiplies the cost disqualified the rung`,
      );
    }
  });
}

/**
 * MARGINAL-COST JUMP ACROSS DEPTH. See `JUMP_FLAG`: the marginal is the only quantity here that
 * should be flat in depth, so a jump in it localizes a lost route even where the raw cell rises
 * monotonically and the raw ratio is expected to be large.
 */
for (const [name, row] of grid) {
  if (name === 'rows') {
    continue;
  }

  const marginal = row.map((c, i) =>
    Number.isNaN(c.ms) || Number.isNaN(base[i].ms) ? Number.NaN : c.ms - base[i].ms,
  );
  const [first] = marginal;

  if (Number.isNaN(first) || first <= 0) {
    continue;
  }

  marginal.forEach((m, i) => {
    if (i > 0 && !Number.isNaN(m) && m >= FLOOR_MS && m > JUMP_FLAG * first) {
      flags.push(
        `${name} depth${DEPTHS[i]}: its MARGINAL cost over rows is ${m.toFixed(1)} ms against ` +
          `${first.toFixed(1)} at depth${DEPTHS[0]} — ${(m / first).toFixed(1)}x. Sorting/deduping N ` +
          'rows costs the same whatever walk produced them, so a marginal that grows with depth ' +
          'means this modifier LOST ITS ROUTE at some width',
      );
    }
  });
}

console.log(flags.length === 0 ? '\n# NO FLAGS' : `\n# ${flags.length} FLAG(S):`);

for (const f of flags) {
  console.log(`  - ${f}`);
}
