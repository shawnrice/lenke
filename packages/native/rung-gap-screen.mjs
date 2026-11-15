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
/**
 * ⚠️ FANOUT IS A KNOB AT ITEM 1836, AND RAISING IT SUPPRESSES THE TWO DEPTH-BASED FLAGS rather than
 * merely changing their numbers. CLAUDE.md: "One edge per node is sparse — per-edge costs scale with
 * the edge:node ratio, per-node costs do not", so every route this grid has pair-tested so far has
 * been measured at ONE out-edge per vertex. The PAIR flag survives a higher fanout untouched,
 * because it compares a modifier against its OWN `rows` cell at the SAME depth.
 *
 * ⚠️ THE DEPTH FLAGS DO NOT SURVIVE IT, and that is why this is a knob with consequences rather than
 * a free parameter. Above fanout 1 the row count is `F^k`, so a deeper cell legitimately does `F`
 * times the work and both "non-monotonic in depth" and "the marginal grew with depth" become
 * statements about the FIXTURE rather than the route — item 1815's finding exactly, where a
 * compounding stride made a rung look 11.2x worse with depth while its per-hop cost was flat.
 */
const FANOUT = Number(process.env.FANOUT ?? 1);
const ENGINE = process.env.ENGINE ?? 'gql';
/*
 * ⚠️⚠️ THE SEED AXIS (item 1980), and it exists because this screen was STRUCTURALLY BLIND to the
 * biggest instance of the class it was built to find.
 *
 * Item 1979 found a seeded var-length COUNT costing **897x** its own `DISTINCT` twin — the same
 * pattern, the same predicate, only the projection changed, which is exactly a PAIR GAP. This
 * screen could not see it, for three independent reasons: every pattern it builds starts
 * `MATCH (a:P)` with NO start predicate, none is QUANTIFIED, and it creates NO INDEX. The defect
 * needed all three.
 *
 *   SEED=none     (default) `MATCH (a:P)` — every number this screen has ever reported.
 *   SEED=clause   `MATCH (a:P)… WHERE a.k = $p` — the spelling item 1906 had to carry.
 *   SEED=inline   `MATCH (a:P {k: $p})…`        — its twin; the two must never split.
 *   SEED=unique   the same CLAUSE spelling on the fixture's UNIQUE key `n`, so the seed admits
 *                 EXACTLY ONE source at every |V|.
 *   SEED=unique-inline   its inline twin.
 *
 * ⚠️⚠️ **`unique` IS THE ONE THAT CAN ACTUALLY CATCH ITEM 1979, and `clause` DEMONSTRABLY CANNOT.**
 * Run against the pre-1979 build, `SEED=clause QUANT=1 NODES=160000` reported **NO FLAGS** while the
 * defect was live and 14-18x in its own cells (`count` 0.3 / 7.1 / 5.8 ms against the fixed build's
 * 0.4 / 0.4 / 0.5). Both flags missed it for the same reason: the PAIR baseline is `rows`, a full
 * enumeration that is itself slow (6.1 / 6.3), so a cell that should be O(1) and is O(|V|) still
 * looks cheap NEXT TO IT. A baseline cannot express "this should not scale".
 *
 * Scaling can. With `k` the seed admits |V|/97 sources, so every cell legitimately grows with |V|
 * and growth says nothing. With the UNIQUE key it admits one source at every size — so any cell
 * whose time grows with |V| is scanning something it does not need, which is exactly the defect.
 * That is what `SCALE=1` measures below, and it is the flag this screen was missing rather than a
 * third axis.
 *
 *   QUANT=1       the chain becomes `-[:E]->{1,depth}(b:P)`, so the DEPTH axis becomes the
 *                 quantifier's bound and the var-length rungs are reached at all.
 *
 * ⚠️ DEFAULTS ARE THE OLD BEHAVIOUR ON PURPOSE. Several items quote this screen's numbers, so an
 * unflagged invocation must still build the same grid it always did.
 */
const SEED = process.env.SEED ?? 'none';
/** True for the two modes that seed on the UNIQUE key, so the source count is 1 at every |V|. */
const SEED_UNIQUE = SEED === 'unique' || SEED === 'unique-inline';
/** The seeded property: `k` has 97 values (|V|/97 sources), `n` is unique (exactly one). */
const SEED_KEY = SEED_UNIQUE ? 'n' : 'k';
const SEED_INLINE = SEED === 'inline' || SEED === 'unique-inline';
/**
 * Run the WHOLE grid at `NODES` and at `NODES / SCALE_DIV`, and flag any cell that grows with |V|.
 *
 * Only meaningful with a UNIQUE seed, where one source is admitted at either size — see the note
 * above. Off by default: it doubles the runtime and says nothing without that seed.
 */
const SCALE = process.env.SCALE === '1';
const SCALE_DIV = Number(process.env.SCALE_DIV ?? 4);
/**
 * A cell is flagged when it grows this many times MORE than its column's MEDIAN growth.
 *
 * ⚠️⚠️ **RELATIVE, NOT ABSOLUTE, AND THE FIRST VERSION OF THIS FLAG WAS ABSOLUTE AND WRONG.** At
 * `FANOUT=5 NODES=160000` against |V|/4, every cell grows **1.7-2.7x** — uniformly, with matching
 * row counts at both sizes (780 / 97 / 1), so it is not the fixture and not a scan. It is the cache
 * transition CLAUDE.md names ("cache-resident and not are different questions; the transition is
 * between 200k and 1M elements"): the same edge visits cost more on the bigger working set.
 *
 * An absolute 2.5x threshold sits ON TOP of that baseline — `collect` read 2.7x and would have been
 * reported as scanning |V| when every one of its siblings grew just as much. **A cell is suspicious
 * only when it grows MORE THAN ITS SIBLINGS**, which is what the median comparison measures, and it
 * is immune to any effect that moves the whole column.
 *
 * Checked against both arms: item 1979's defect grew 6.4-6.9x where the column median was ~1.4x
 * (4.6x relative — flagged), and the fixed build grows 1.5x against the same median (1.07x — quiet).
 */
const SCALE_FLAG = Number(process.env.SCALE_FLAG ?? 2.5);
const QUANT = process.env.QUANT === '1';
/** The seeded key's value — `k` spans 100 values, so this selects ~1% of the graph. */
const SEED_VALUE = Number(process.env.SEED_VALUE ?? 7);

if (ENGINE !== 'gql' && ENGINE !== 'gremlin') {
  throw new Error(`ENGINE must be gql|gremlin, got ${ENGINE}`);
}

const build = (nodes = NODES) => {
  const g = new Graph();

  for (let i = 0; i < nodes; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let e = 0; e < nodes * FANOUT; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    g.addEdge({
      id: `e${e}`,
      // ⚠️ Splits on the REPEAT INDEX, CLAUDE.md's fix for the `(a*k+b) % N` degeneracy: without it
      // one vertex's FANOUT edges all land on the SAME target, every k-hop count is `F^k` by
      // construction, and every degree still looks perfect.
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % nodes}`),
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  return g;
};

/** `MATCH (a:P)-[:E]->(x1:P)-[:E]->…` of the given depth, with the far variable's name. */
const chain = (depth) => {
  // ⚠️ THE SEED GOES ON THE START NODE for `inline` and into a trailing clause for `clause`, and
  // both are built here so every modifier in the grid inherits the same seed. A modifier that adds
  // its own `WHERE` (the `where` cell) then carries BOTH, which is the realistic shape: a seeded
  // query with a far-end filter.
  const start = SEED_INLINE ? `MATCH (a:P {${SEED_KEY}: $p})` : 'MATCH (a:P)';

  if (QUANT) {
    // The depth axis becomes the QUANTIFIER'S BOUND. `{1,depth}` and a fixed chain of `depth` hops
    // answer different questions (a bound admits every shorter path too), so the two pattern modes
    // are not comparable cell-for-cell — which is why this is a MODE rather than another modifier.
    return { text: `${start}-[:E]->{1,${String(depth)}}(b:P)`, far: 'b' };
  }

  let text = start;
  let far = 'a';

  for (let d = 1; d <= depth; d += 1) {
    far = `x${d}`;
    text += `-[:E]->(${far}:P)`;
  }

  return { text, far };
};

/**
 * The trailing clause seed, appended AFTER the modifier has built its projection — because a GQL
 * `WHERE` belongs to the MATCH clause and the modifiers end in `RETURN`.
 *
 * ⚠️ So `clause` is applied by rewriting the query text rather than by composing it, which is ugly
 * and is the only way to keep the modifier table untouched. Asserted below: the rewrite must match
 * exactly once per query or the cell is reported as broken rather than silently unseeded.
 */
const withClauseSeed = (q) => {
  if (SEED === 'none' || SEED_INLINE) {
    return q;
  }

  const at = q.indexOf(' RETURN ');

  if (at < 0) {
    throw new Error(`cannot place a clause seed: no RETURN in ${q}`);
  }

  // A modifier may already carry its own far-end `WHERE`; AND them rather than dropping either.
  const head = q.slice(0, at);
  const tail = q.slice(at);
  const joined = head.includes(' WHERE ')
    ? `${head} AND a.${SEED_KEY} = $p`
    : `${head} WHERE a.${SEED_KEY} = $p`;

  return joined + tail;
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
  rows: (d) => traversal(...gremlinStart(d), values('k')),
  distinct: (d) => traversal(...gremlinStart(d), values('k'), dedupe()),
  count: (d) => traversal(...gremlinStart(d), count()),
  countdist: (d) => traversal(...gremlinStart(d), values('k'), dedupe(), count()),
  where: (d) => traversal(...gremlinStart(d), has('k', gt(44)), values('k')),
  orderby: (d) => traversal(...gremlinStart(d), values('k'), order()),
  topk: (d) => traversal(...gremlinStart(d), values('k'), order(), limit(10)),
  skiponly: (d) => traversal(...gremlinStart(d), values('k'), skip(5)),
  sum: (d) => traversal(...gremlinStart(d), values('k'), sum()),
  maxagg: (d) => traversal(...gremlinStart(d), values('k'), max()),
  grouped: (d) => traversal(...gremlinStart(d), groupCount({ by: 'k' })),
  collect: (d) => traversal(...gremlinStart(d), values('k'), fold()),
};

/** `d` repetitions of `out('E')`, so the depth axis is the same quantity on both surfaces. */
const hops = (d) => Array.from({ length: d }, () => out('E'));

/**
 * The Gremlin START, seeded to match the GQL side (item 1981).
 *
 * ⚠️⚠️ **THE GREMLIN GRID HAD NO SEED AXIS AT ALL, which made the two tables incomparable exactly
 * where item 1979's defect lived.** Item 1826 built this grid so that "a difference between the two
 * tables is a difference between the engines and not between two sets of questions" — and that only
 * holds while both sides ask the same question. With `SEED` live the GQL side seeds and this side
 * did not, so every seeded cell compared a seeked query against an unseeded traversal.
 *
 * `has(key, value)` is the seeded spelling and `@lenke/gremlin` has `index-seed.ts` to serve it, so
 * the question "does Gremlin seek where GQL now does" is answerable rather than assumed.
 *
 * ⚠️ There is no inline-vs-clause distinction in Gremlin — one spelling — so `inline` and `clause`
 * map to the same traversal here. That is not a gap being papered over: the cliff item 583 guards
 * is a GQL surface property, and a Gremlin table showing one column where GQL shows two would be
 * the honest shape.
 */
const gremlinStart = (d) =>
  SEED === 'none'
    ? [V(), hasLabel('P'), ...hops(d)]
    : [V(), hasLabel('P'), has(SEED_KEY, SEED_VALUE), ...hops(d)];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `let`, because `SCALE=1` runs the whole grid against a second, smaller graph. */
let g = build();

/*
 * ⚠️ THE INDEX, WITHOUT WHICH THE SEED AXIS MEASURES NOTHING IT WAS ADDED FOR. Item 1979's defect
 * is a rung that scans the start label's extent instead of SEEKING — so with no index on the seeded
 * key both the fixed and the fast route scan, and the gap the axis exists to find cannot appear.
 * Created only when a seed is live, so `SEED=none` builds the graph this screen always built.
 */
const indexIfSeeded = (graph) => {
  if (SEED !== 'none') {
    graph.createIndex({ on: 'vertex', kind: 'hash', keys: [SEED_KEY] });
  }
};

indexIfSeeded(g);

console.log(
  `# rung-gap-screen ENGINE=${ENGINE} NODES=${NODES} FANOUT=${FANOUT} reps=${REPS} drop=${WARMUP}`,
);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}`);
console.log(
  `# SEED=${SEED}${SEED === 'none' ? '' : ` (a.${SEED_KEY} = ${String(SEED_VALUE)}, INDEXED` + `${SEED_UNIQUE ? ', ONE source at every |V|' : `, |V|/97 sources`})`} ` +
    `PATTERN=${QUANT ? '-[:E]->{1,depth}(b:P)  [QUANTIFIED]' : 'fixed chain of depth hops'}`,
);

/*
 * ⚠️⚠️ A RATIO FLOOR IN ABSOLUTE MILLISECONDS HIDES A DEFECT THAT IS LINEAR IN |V|, and item 1980
 * found that the hard way. `FLOOR_MS` exists because a ratio between two sub-millisecond cells is
 * noise (its own note) — but item 1979's seeded count was **0.35 ms at NODES=20,000** while being
 * 160x its twin, and only reached 3.9 ms at NODES=160,000. So at this screen's DEFAULT fixture the
 * flag it needed was suppressed for being too small, and the defect was invisible by magnitude even
 * once the axis above existed to express it.
 *
 * The honest fix is to say so rather than to lower the floor, which would flood the grid with
 * sub-millisecond noise: a seeded run wants a fixture big enough for the slow arm to clear the
 * floor, and this prints the warning when it does not.
 */
if (SEED !== 'none' && NODES < 100_000) {
  console.log(
    `# ⚠️ SEED is live at NODES=${String(NODES)}, where a LINEAR-in-|V| defect may sit under ` +
      `FLOOR_MS=${String(FLOOR_MS)} ms and be suppressed. Item 1979's needed NODES=160000 to clear it.`,
  );
}

console.log(
  FANOUT === 1
    ? '# FANOUT=1 so every depth returns the same row count — a depth difference is ROUTE.\n'
    : `# ⚠️ FANOUT=${FANOUT}: rows are F^k, so the DEPTH flags are SUPPRESSED — they would measure\n` +
        '#    the fixture rather than the route (item 1815). Only the PAIR flag is reported.\n',
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
      rows =
        ENGINE === 'gql'
          ? query(g, built, SEED === 'none' ? {} : { p: SEED_VALUE }).length
          : toArray(built, g).length;
    } catch {
      return { ms: Number.NaN, rows: -1 };
    }

    series.push(performance.now() - t0);
  }

  return { ms: median(series.slice(WARMUP)), rows };
};

/** The query or traversal for one cell, built ONCE — see `cell`. */
const buildCell = (name, depth) =>
  ENGINE === 'gql' ? withClauseSeed(MODIFIERS[name](chain(depth))) : GREMLIN_MODIFIERS[name](depth);

/*
 * ⚠️ `skiponly` IS DROPPED UNDER A UNIQUE SEED, and the reason is worth stating because dropping a
 * cell looks like hiding one. One source over a FANOUT=1 fixture yields `depth` rows — ONE of them
 * at depth 1 — so `SKIP 5` returns nothing and the ZERO ROWS guard fires on a cell that is empty BY
 * CONSTRUCTION. Lowering the constant only moves the problem to depth 1; weakening the guard would
 * cost it the genuinely-empty cells it exists to catch. An absent cell is honest, a permanently
 * false flag is not.
 */
const names = Object.keys(ENGINE === 'gql' ? MODIFIERS : GREMLIN_MODIFIERS).filter(
  (n) => !(SEED_UNIQUE && n === 'skiponly'),
);
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

/*
 * ⚠️⚠️ THE SCALING PASS (item 1980) — the grid again on a graph `SCALE_DIV` times smaller.
 *
 * With a UNIQUE seed exactly one source is admitted at either size, so nothing in the question
 * grows with |V| and any cell that does is scanning. This is the flag that catches item 1979's
 * class, which neither the pair flag nor the depth flag can: both compare a cell to another CELL,
 * and the defect is a cell compared to ITSELF at another size.
 *
 * ⚠️ It reports rather than flags when the seed is not unique, because with |V|/97 sources every
 * cell grows legitimately and a growth flag would fire on all of them.
 */
const small = new Map();

if (SCALE) {
  const big = g;

  g = build(Math.max(1000, Math.floor(NODES / SCALE_DIV)));
  indexIfSeeded(g);

  const caveat = SEED_UNIQUE ? '' : ' — ⚠️ seed is NOT unique, growth is expected and NOT flagged';

  console.log(
    `\n# SCALE pass at NODES=${String(g.vertexCount)} (1/${String(SCALE_DIV)}), same grid${caveat}`,
  );
  console.log(
    `${'modifier'.padEnd(11)}${DEPTHS.map((d) => `depth${d}`.padStart(12)).join('')}   grow@maxdepth`,
  );

  for (const name of names) {
    const row = DEPTHS.map((depth) => cell(buildCell(name, depth)));

    small.set(name, row);

    const cells = row
      .map((c) => (Number.isNaN(c.ms) ? 'ERR' : c.ms.toFixed(1)).padStart(12))
      .join('');
    const bigRow = grid.get(name);
    const last = row.length - 1;
    const grow = row[last].ms > 0 ? `${(bigRow[last].ms / row[last].ms).toFixed(1)}x` : '-';

    console.log(`${name.padEnd(11)}${cells}   ${grow}`);
  }

  g = big;
}

// ── THE FLAGS ───────────────────────────────────────────────────────────────────────────────────
const flags = [];

if (SCALE && SEED_UNIQUE) {
  /** Each cell's growth across the size change, or `undefined` where it cannot be computed. */
  const growth = (name, i) => {
    const big = grid.get(name)?.[i];
    const sml = small.get(name)?.[i];

    if (big === undefined || sml === undefined) {
      return undefined;
    }

    if (Number.isNaN(big.ms) || Number.isNaN(sml.ms) || sml.ms <= 0) {
      return undefined;
    }

    /*
     * ⚠️ THE ROW COUNTS MUST MATCH, or the two cells answered different questions and their ratio
     * is about the FIXTURE. A unique seed keeps them equal for almost every modifier, but not all:
     * `where` returned 430 rows at |V| and 435 at |V|/4, because a smaller graph's walk reaches a
     * different far set. Comparing those would have been CLAUDE.md's "match the fixture to the
     * claim" violated inside the flag meant to enforce it.
     */
    if (big.rows !== sml.rows) {
      return undefined;
    }

    return big.ms / sml.ms;
  };

  DEPTHS.forEach((depth, i) => {
    const column = [...grid.keys()].map((name) => growth(name, i)).filter((r) => r !== undefined);

    if (column.length < 3) {
      return;
    }

    const base = median(column);

    for (const name of grid.keys()) {
      const ratio = growth(name, i);
      const cellMs = grid.get(name)[i].ms;

      if (ratio === undefined || base <= 0 || cellMs < FLOOR_MS) {
        continue;
      }

      if (ratio / base >= SCALE_FLAG) {
        flags.push(
          `${name} depth${String(depth)}: ${cellMs.toFixed(1)} ms at |V|=${String(NODES)} grew ` +
            `${ratio.toFixed(1)}x across |V|/${String(SCALE_DIV)} where its column's MEDIAN grew ` +
            `${base.toFixed(1)}x (${(ratio / base).toFixed(1)}x relative) — ONE source is admitted ` +
            'at both sizes and the siblings did not grow, so this cell SCANS |V| rather than ' +
            'seeking its seed',
        );
      }
    }
  });
}

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
      FANOUT === 1 &&
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

  /**
   * ⚠️ THE DENOMINATOR NEEDS ITS OWN FLOOR, AND A SIZE SWEEP IS WHAT SHOWED IT (item 1835). This
   * flag divides by the depth-1 marginal, and that number is often ~0 — a modifier that costs
   * nothing at one hop. At 200,000 vertices `where`'s depth-1 marginal is 0.7 ms and its depth-2
   * marginal is 26.3, which the flag reported as **40.1x**; the honest reading is "+26 ms on a
   * 133 ms row cell", i.e. ~1.2x. Dividing by a near-zero makes any positive marginal look
   * enormous.
   *
   * This is item 1823's sub-millisecond-ratio defect one level deeper: that run put a floor on the
   * CELL, and the same argument applies to whatever a ratio is divided BY. A ratio needs an
   * absolute magnitude on BOTH sides.
   */
  if (FANOUT !== 1 || Number.isNaN(first) || first < FLOOR_MS) {
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
