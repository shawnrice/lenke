/**
 * WHICH REALISTIC GREMLIN TRAVERSAL IS EXPENSIVE? — the screen this surface never had (item 1881)
 *
 * ⚠️ GREMLIN IS HALF THE PRODUCT AND HAD NO WORKLOAD SCREEN. `workload-perf-screen.mjs` draws 17
 * realistic GQL families and has found real things — a `RETURN DISTINCT` costing 5.8x the rows it
 * dedupes (item 1820), and the chain that led to the parameterized-page rung (items 1865-1867).
 * Gremlin's instruments answer narrower questions: `bench-gremlin.ts` compares 31 shapes against
 * NATIVE, `gremlin-route-screen.mjs` asks only WHICH ROUTE answers a shape, and
 * `gremlin-spelling-probe.ts` compares spellings of one question. **None of them asks what an
 * application's traversal costs.** Item 1868 recorded the gap and deferred it as too large.
 *
 * ⚠️ IT IS PER-SHAPE, NOT PER-FAMILY, AND THAT IS ITEM 1880'S LESSON BUILT IN. The GQL screen reports
 * one number per family, and splitting those numbers showed `var-length`'s 543 ms was ~70% ONE bound
 * (`{2,3}` at 45.1 ms against its `{1,3}` twin's 0.8, same eight rows). A family total is a blended
 * average hiding its worst shape, so this screen never computes one: every row is a shape, and the
 * output is sorted by ABSOLUTE milliseconds — item 1878's lesson, which cost an item to a 4.7x that
 * turned out to be 2 microseconds.
 *
 * ⚠️ THE FIXTURE CHECKS ITS OWN TOPOLOGY. CLAUDE.md records six generators in this repo that looked
 * perfect while being FUNCTIONAL — `to = (a*k + b) % N` is invariant under `k -> k + N`, so one
 * vertex's FANOUT edges all landed on ONE target, every degree statistic read correctly, and every
 * k-hop count was `F^k · N` by construction. The repeat index is in the expression below and the
 * distinct-endpoint count is asserted at startup, because an answer that is INVARIANT to the
 * property you varied cannot validate the fixture.
 *
 * ⚠️ AND `empty%` IS READ FIRST. A shape whose traversal stops matching at this size is the
 * "fastest" row on the screen and means nothing — the GQL screen says so in terms and its
 * `point-lookup` row has sat at 60% empty for items.
 *
 *     bun gremlin-workload-screen.mjs
 *     NODES=5000 bun gremlin-workload-screen.mjs
 *     ONLY=chain bun gremlin-workload-screen.mjs
 */
import { Graph } from '@lenke/core';
import {
  aggregate,
  as_,
  both,
  branch,
  cap,
  choose,
  coalesce,
  constant,
  count,
  cyclicPath,
  dedupe,
  groupCount,
  gt,
  has,
  hasLabel,
  id,
  identity,
  in_,
  inV,
  limit,
  max,
  mean,
  min,
  neq,
  optional,
  order,
  otherV,
  out,
  outE,
  path,
  project,
  range,
  repeat,
  select,
  simplePath,
  toArray,
  traversal,
  tree,
  union,
  V,
  valueMap,
  values,
  where,
  within,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);
const ONLY = process.env.ONLY ?? '';

// The GQL screen's value domain, so a literal selects a comparable fraction and the two screens'
// numbers are about the same graph rather than two different ones.
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50, s: `s${i % 7}` },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: W_POOL[e % W_POOL.length] },
  });
}

// THE TOPOLOGY ASSERTION. One vertex's out-targets must be DISTINCT, or the graph is functional and
// every multi-hop row below is `F^k · N` whatever the walk does.
{
  const seen = new Set();

  for (let hop = 0; hop < FANOUT; hop += 1) {
    seen.add((3 + hop * 2_654_435_761) % NODES);
  }

  if (FANOUT > 1 && seen.size < 2) {
    throw new Error(`fixture is FUNCTIONAL: v1 reaches ${String(seen.size)} distinct targets`);
  }
}

/**
 * The shapes an application writes. Each is one row; there are no family totals, by design.
 *
 * ⚠️ THE NAMES CARRY THE QUESTION, not the step list, so a reader scanning the output sees what was
 * asked rather than having to parse a traversal.
 */
const SHAPES = {
  'point: V(id)': () => traversal(V('700'), values('n')),
  'point: has(k,v)': () => traversal(V(), has('k', 7), values('n')),
  'point: has + limit 1': () => traversal(V(), has('k', 7), limit(1), values('n')),
  'scan: count': () => traversal(V(), count()),
  'scan: hasLabel count': () => traversal(V(), hasLabel('U'), count()),
  'scan: values': () => traversal(V(), values('n')),
  'scan: id': () => traversal(V(), id()),
  'scan: valueMap': () => traversal(V(), valueMap()),
  'range: has(gt)': () => traversal(V(), has('n', gt(5)), values('n')),
  'range: has(gt) count': () => traversal(V(), has('n', gt(5)), count()),
  'in-list: within': () => traversal(V(), has('n', within(3, 5, 7)), values('n')),
  'neighbors: V(id).out': () => traversal(V('700'), out('E'), values('n')),
  'neighbors: V(id).both': () => traversal(V('700'), both('E'), values('n')),
  'hop1: values': () => traversal(V(), out('E'), values('n')),
  'hop1: count': () => traversal(V(), out('E'), count()),
  'hop1: dedupe count': () => traversal(V(), out('E'), dedupe(), count()),
  'hop2: values': () => traversal(V(), out('E'), out('E'), values('n')),
  'hop2: count': () => traversal(V(), out('E'), out('E'), count()),
  'hop3: count': () => traversal(V(), out('E'), out('E'), out('E'), count()),
  'edge: outE.has(w).inV': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
  /*
   * ⚠️ THESE THREE WERE MISSING, AND THAT IS WHY THREE SHIPPED WINS WERE INVISIBLE HERE (item 1958).
   * Items 1956 and 1957 took the edge-predicate family's other terminals — `inV().count()` at
   * 2.33x, `values(w)` on the EDGE at 3.66x, `count()` on the edge at 2.28x — and this screen's
   * top rows did not move at all, because it carried only the `inV().values(n)` spelling, which was
   * already fused. A screen is a claim about THE SHAPES IT HAS; these are now among them, so the
   * regression sweep covers what those items changed.
   */
  'edge: outE.has(w).inV.count': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), count()),
  'edge: outE.has(w).values(w)': () => traversal(V(), outE('E'), has('w', gt(3)), values('w')),
  'edge: outE.has(w).count': () => traversal(V(), outE('E'), has('w', gt(3)), count()),
  'edge: outE count': () => traversal(V(), outE('E'), count()),
  'agg: values min': () => traversal(V(), values('n'), min()),
  'agg: values max': () => traversal(V(), values('n'), max()),
  'agg: values mean': () => traversal(V(), values('n'), mean()),
  'agg: hop values min': () => traversal(V(), out('E'), values('n'), min()),
  'group: groupCount by': () => traversal(V(), groupCount().by('n')),
  'group: hop groupCount': () => traversal(V(), out('E'), groupCount().by('n')),
  'order: values order': () => traversal(V(), values('n'), order()),
  'order: values order limit': () => traversal(V(), values('n'), order(), limit(10)),
  'optional: hop': () => traversal(V(), optional(out('E')), values('n')),
  /*
   * ⚠️ ADDED AT ITEM 2027, BEFORE MEASURING RATHER THAN AFTER — item 2026's lesson. That item fused a
   * shape the screen had no row for, so its own four-round A/B read flat everywhere and the win was
   * only visible in a dedicated probe. A rung that gains a shape should gain the row in the same
   * commit, or the screen cannot regression-test it.
   */
  'optional: hop count': () => traversal(V(), optional(out('E')), count()),
  /*
   * ⚠️⚠️ THE RECONVERGING-BRANCH FAMILY (item 1994), which this screen has never carried — and the
   * reason it is added as a FAMILY rather than one row is item 1898's: it added nine families and
   * **all five of the biggest shapes on the surface turned out to be among them**. A step kind the
   * screen does not exercise cannot be ranked, however large it is.
   *
   * Found by diffing `ast.ts`'s step kinds against this file's combinators: **103 kinds, 68 never
   * exercised** (item 1990). These three are the highest-application-weight group of those —
   * defaults and conditionals are everywhere in real traversals — and measuring them immediately
   * found `coalesce` at **4.99x** its own equivalent `optional` (fixed at item 1990) and `choose` at
   * **2.59x** a hand ceiling (open, cost located at item 1993).
   *
   * ⚠️ `coalesce: hop + identity` IS THE PAIR FOR `optional: hop` DIRECTLY ABOVE IT. They are the
   * same question — item 1990 normalizes one into the other — so a gap between these two rows is a
   * spelling defect by definition, which is exactly what this screen exists to surface.
   */
  'coalesce: hop + identity': () => traversal(V(), coalesce(out('E'), identity()), values('n')),
  'coalesce: two hops': () => traversal(V(), coalesce(out('E'), in_('E')), values('n')),
  // ⚠️ `has('n', 0)` over `n = i % 97` sends ~96 of 97 vertices to the SECOND arm. Item 1993 lost a
  // measurement to comparing this against an `out` control for exactly that reason.
  'choose: has then two hops': () =>
    traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
  'choose: hop test + const': () => traversal(V(), choose(out('E'), values('n'), constant('none'))),
  'branch: two options': () =>
    traversal(
      V(),
      branch(values('n')).option(0, out('E')).option(1, in_('E')).none(identity()),
      values('n'),
    ),
  'union: out + in': () => traversal(V(), union(out('E'), in_('E')), count()),
  'repeat: times 2': () => traversal(V(), repeat(traversal(out('E'))).times(2), count()),
  'repeat: times 3': () => traversal(V(), repeat(traversal(out('E'))).times(3), count()),
  /**
   * ⚠️ NINE FAMILIES NEITHER SCREEN COVERED (item 1898), added because every widening of an axis in
   * this corpus has found something and these are the steps an application actually writes next
   * after a hop: naming a step and reading it back (`as`/`select`), shaping a row (`project`),
   * filtering by a sub-traversal (`where`), the path itself, paging (`range`), keyed dedupe, and the
   * two set-ish side effects (`aggregate`/`cap`, `store`).
   */
  'select: as + select one': () => traversal(V(), as_('a'), out('E'), select('a'), values('n')),
  'select: as + select two': () => traversal(V(), as_('a'), out('E'), as_('b'), select('a', 'b')),
  'project: two keys': () => traversal(V(), project('n', 'i').by('n').by('k')),
  'where: sub-traversal': () => traversal(V(), where(traversal(out('E'))), values('n')),
  /*
   * ⚠️ ADDED AT ITEM 2026 BECAUSE THE SCREEN COULD NOT SEE THE SHAPE IT FUSED. Items 2021 and 2025
   * widened the scan-values gate from two sides and 2026 covered the corner — a trailing residual on
   * an existence-filtered scan — but no screen row had that combination, so its PRE/POST read flat
   * everywhere and the win was only visible in a dedicated probe (49.5 -> 24.6 ms at 200,000). A
   * family whose combinations are not on the screen cannot be regression-tested by it.
   */
  'where: sub-traversal order': () =>
    traversal(V(), where(traversal(out('E'))), values('n'), order()),
  'where: neq filter': () => traversal(V(), as_('a'), out('E'), where(neq('a')), values('n')),
  'path: hop path': () => traversal(V(), out('E'), path()),
  'page: range mid': () => traversal(V(), out('E'), values('n'), range(1000, 1010)),
  'dedupe: by key': () => traversal(V(), out('E'), dedupe().by('n'), values('n')),
  'sideeffect: aggregate + cap': () => traversal(V(), out('E'), aggregate('x'), cap('x')),
  /**
   * ⚠️ THE PATH-DEPENDENT FAMILY, which this screen never carried (item 1921). `ast.ts`'s
   * `PATH_DEPENDENT_KINDS` lists ten step kinds that make `planReadsPath` TRUE, and every fused walk
   * in the package is gated on `!tracksPath` — so each of them reaches no rung at all. Item 1898
   * found that asking what a screen does NOT ask turned up the five biggest shapes on the surface,
   * and item 1920 then took `path()` itself at 14.8x once it was measured. These are the rest of
   * that family, as an application would write them.
   *
   * ⚠️ `outE(T).otherV()` IS THE INTERESTING ONE: for a DIRECTED edge step it is exactly
   * `outE(T).inV()`, verified on a fixture including a self-loop — but `otherV` reads the path and
   * `inV` does not, so one spelling is fused and the other cannot be. That is this repo's named bug
   * class, and the pair is here side by side so the gap is visible rather than inferred.
   */
  'pathdep: outE.otherV': () => traversal(V(), outE('E'), otherV(), values('n')),
  'pathdep: outE.inV (the twin)': () => traversal(V(), outE('E'), inV(), values('n')),
  'pathdep: simplePath': () => traversal(V(), out('E'), simplePath(), values('n')),
  'pathdep: cyclicPath': () => traversal(V(), out('E'), cyclicPath(), values('n')),
  'pathdep: tree': () => traversal(V(), out('E'), tree()),
  'pathdep: path().by(k)': () => traversal(V(), out('E'), path().by('n')),
};

const names = Object.keys(SHAPES).filter((k) => ONLY === '' || k.includes(ONLY));
const rows = [];

for (const name of names) {
  const plan = SHAPES[name]();
  const series = [];
  let n = 0;
  let err = '';

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    try {
      const got = toArray(plan, g);

      n = Array.isArray(got) ? got.length : 1;
    } catch (e) {
      err = String(e).slice(0, 28);
      n = -1;
    }

    const ms = performance.now() - t0;

    if (r >= 2) {
      series.push(ms);
    }
  }

  series.sort((a, b) => a - b);
  rows.push([series[series.length >> 1], n, name, err]);
}

rows.sort((a, b) => b[0] - a[0]);

console.log(
  `# gremlin-workload-screen NODES=${String(NODES)} FANOUT=${String(FANOUT)} reps=${String(REPS)}`,
);
console.log(`# vertices=${String(g.vertexCount)} edges=${String(g.edgeCount)}`);
console.log(
  '# ⚠️ SORTED BY ABSOLUTE ms. Read `rows` beside it: a shape returning 0 measures a miss.',
);
/*
 * ⚠️⚠️ THE CAVEAT IS PRINTED, NOT FILED (item 1988, the same fix as item 1985's probe banner).
 *
 * A full run puts ~44 shapes through one process, so every shared dispatch site is polymorphic and
 * the rows inflate UNEQUALLY. Measured three times now: item 1958 at 1.4-1.9x, item 1984 at 2.3x on
 * a GQL row, and item 1988 at 1.3-1.56x on this screen's own `simplePath` / `where: neq` pair —
 * where the inflation made two STRUCTURALLY IDENTICAL plans read 59.88 and 69.97 ms and look like
 * this repo's named spelling-gap defect. Isolated they are 46.12 and 44.44.
 *
 * So the absolutes are for RANKING a run against itself, and a cross-row ratio needs `ONLY=`.
 */
console.log(
  '#    ⚠️ ABSOLUTES ARE INFLATED 1.3-1.9x UNEQUALLY by the ~44 shapes sharing this process.\n' +
    '#    Rank with them; do NOT compare two rows or two runs. For either, re-run with\n' +
    "#    ONLY='<the row's name>' so the shape has a process to itself (items 1958, 1984, 1988).\n",
);
console.log('      ms      rows   shape');
console.log('-------------------------------------------------------');

/** `0` rows is a MISS and `-1` is a raise; both make the millisecond figure meaningless. */
const flagFor = (n, err) => {
  if (n === 0) {
    return '  ⚠️ EMPTY — this row measures a miss';
  }

  return n === -1 ? `  ⚠️ RAISED ${err}` : '';
};

for (const [ms, n, name, err] of rows) {
  console.log(`${ms.toFixed(2).padStart(8)} ${String(n).padStart(9)}   ${name}${flagFor(n, err)}`);
}
