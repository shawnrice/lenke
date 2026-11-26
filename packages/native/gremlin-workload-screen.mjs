/**
 * WHICH REALISTIC GREMLIN TRAVERSAL IS EXPENSIVE? — the screen this surface never had (item 1881)
 *
 * GREMLIN IS HALF THE PRODUCT AND HAD NO WORKLOAD SCREEN. `workload-perf-screen.mjs` draws 17
 * realistic GQL families and has found real things — a `RETURN DISTINCT` costing 5.8x the rows it
 * dedupes (item 1820), and the chain that led to the parameterized-page rung (items 1865-1867).
 * Gremlin's instruments answer narrower questions: `bench-gremlin.ts` compares 31 shapes against
 * NATIVE, `gremlin-route-screen.mjs` asks only WHICH ROUTE answers a shape, and
 * `gremlin-spelling-probe.ts` compares spellings of one question. **None of them asks what an
 * application's traversal costs.** Item 1868 recorded the gap and deferred it as too large.
 *
 * IT IS PER-SHAPE, NOT PER-FAMILY, AND THAT IS ITEM 1880'S LESSON BUILT IN. The GQL screen reports
 * one number per family, and splitting those numbers showed `var-length`'s 543 ms was ~70% ONE bound
 * (`{2,3}` at 45.1 ms against its `{1,3}` twin's 0.8, same eight rows). A family total is a blended
 * average hiding its worst shape, so this screen never computes one: every row is a shape, and the
 * output is sorted by ABSOLUTE milliseconds — item 1878's lesson, which cost an item to a 4.7x that
 * turned out to be 2 microseconds.
 *
 * THE FIXTURE CHECKS ITS OWN TOPOLOGY. CLAUDE.md records six generators in this repo that looked
 * perfect while being FUNCTIONAL — `to = (a*k + b) % N` is invariant under `k -> k + N`, so one
 * vertex's FANOUT edges all landed on ONE target, every degree statistic read correctly, and every
 * k-hop count was `F^k · N` by construction. The repeat index is in the expression below and the
 * distinct-endpoint count is asserted at startup, because an answer that is INVARIANT to the
 * property you varied cannot validate the fixture.
 *
 * AND `empty%` IS READ FIRST. A shape whose traversal stops matching at this size is the
 * "fastest" row on the screen and means nothing — the GQL screen says so in terms and its
 * `point-lookup` row has sat at 60% empty for items.
 *
 *     bun gremlin-workload-screen.mjs
 *     NODES=5000 bun gremlin-workload-screen.mjs
 *     ONLY=chain bun gremlin-workload-screen.mjs
 */
import { Graph } from '@lenke/core';
import {
  gte,
  not,
  and,
  aggregate,
  skip,
  tail,
  is,
  group,
  properties,
  label,
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
  store,
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

/*
 * **MIXED=1 APPENDS ONE ISOLATED OFF-LABEL VERTEX, AND THE ROUTE CENSUS CANNOT REPLACE THIS**
 * (item 2038). Every vertex above carries `T`, so `T` is VACUOUS and `dropVacuousLabels` deletes any
 * `hasLabel('T')` step; one off-label vertex makes every such step SURVIVE. Item 2036's census found
 * the one row of 98 whose ROUTE changed, and item 2037 fixed it — but a row that keeps its route in
 * BOTH modes can still pay surviving per-element label tests, and no census can see that. Only
 * timing can.
 *
 * THE VERTEX IS ISOLATED, so every answer is unchanged and only `vertexCount` moves — which is
 * what makes the two modes comparable row by row.
 */
if (process.env.MIXED === '1') {
  g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { n: -1, k: -1, s: 'off' } });
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
 * THE NAMES CARRY THE QUESTION, not the step list, so a reader scanning the output sees what was
 * asked rather than having to parse a traversal.
 */
const SHAPES = {
  'point: V(id)': () => traversal(V('700'), values('n')),
  /*
   * THE EQUAL-EMISSION ARM (item 2057). `point: has(k,v)` keeps 1 vertex in 50, so comparing it to
   * the unfiltered `scan: values` confounds the ROUTE with 50x fewer row emissions. This predicate
   * keeps EVERY vertex, so both arms scan 200,000 and emit 200,000 — the only difference left is the
   * generic has+values route against the fused values one.
   */
  'point: has(all) values': () => traversal(V(), has('k', gte(0)), values('n')),
  // Half the vertices (k is 0-49), to place the selectivity curve between the two ends.
  'point: has(half) values': () => traversal(V(), has('k', gte(25)), values('n')),
  'point: has(k,v)': () => traversal(V(), has('k', 7), values('n')),
  'point: has + limit 1': () => traversal(V(), has('k', 7), limit(1), values('n')),
  'scan: count': () => traversal(V(), count()),
  'scan: hasLabel count': () => traversal(V(), hasLabel('U'), count()),
  /*
   * **THE LABELLED FAMILY, AND THE REASON IT EXISTS: THIS SCREEN HAD **ONE** LABELLED ROW OF 58**
   * (item 2038) — the `hasLabel('U')` count above, whose label is already 1-in-6 and so cannot move
   * between label modes at all. EVERY REAL QUERY CARRIES A LABEL, so a 58-row screen with one
   * labelled row is blind to the regime its users are in: item 2036's route cliff (1.81x) and item
   * 2037's fusion were both invisible here.
   *
   * THESE USE `T`, WHICH IS VACUOUS WITHOUT `MIXED=1` AND NON-VACUOUS WITH IT — so each row is a
   * matched pair across the two modes, and `dropVacuousLabels` deleting the step is itself what the
   * pair measures. `U` would have been useless here for exactly the reason the old row is.
   */
  /*
   * ITEM 2046's ROWS: three rungs that no screen or census reached until a V8-coverage audit found
   * them (30 of 37 rungs entered by 40 shapes). The `where(and(...))` row is the one that matters —
   * the census reads it at **2002 applyStep calls**, i.e. the sub-plan re-dispatched PER TRAVERSER,
   * while the DIRECT `and(...)` form takes the fusion at 2.
   */
  'exist: and direct': () => traversal(V(), and(traversal(out('E')), traversal(out('F'))), count()),
  'exist: where and': () =>
    traversal(V(), where(and(traversal(out('E')), traversal(out('F')))), count()),
  'exist: not direct': () => traversal(V(), not(traversal(out('E'))), count()),
  'dense: two hop count': () => traversal(V(), out('E'), out('E'), count()),
  'label: values': () => traversal(V(), hasLabel('T'), values('n')),
  'label: count': () => traversal(V(), hasLabel('T'), count()),
  'label: id': () => traversal(V(), hasLabel('T'), id()),
  'label: hop values': () => traversal(V(), hasLabel('T'), out('E'), values('n')),
  'label: hop count': () => traversal(V(), hasLabel('T'), out('E'), count()),
  'label: has values': () => traversal(V(), hasLabel('T'), has('k', 3), values('n')),
  'label: order values': () => traversal(V(), hasLabel('T'), values('n'), order()),
  'label: dedupe values': () => traversal(V(), hasLabel('T'), values('s'), dedupe()),
  'scan: values': () => traversal(V(), values('n')),
  // ITEM 2079: the EXACT pair for the dedupe portion — same prefix, with and without `dedupe()`,
  // and no `hasLabel` to confound it. `label: dedupe values` carries a label test the `where` rows do
  // not, so it cannot isolate what a FUSED dedupe costs.
  'scan: values dedupe': () => traversal(V(), values('n'), dedupe()),
  /*
   * ITEM 2080: `V().label()` beside `V().id()`. Both are zero-argument ELEMENT ACCESSORS over a
   * bare scan, and item 2056 fused `id()` at 2.72x — but the census shows `label()` generic. That is
   * a DISAGREEMENT between siblings, which is the census's actual signal (item 1854: a generic route
   * is not a defect on its own).
   */
  'scan: label': () => traversal(V(), label()),
  /*
   * ITEM 2081: the pairs item 2080's widening left unpriced, each beside its NEAREST FUSED SIBLING
   * so the comparison is a route difference and not a different question.
   *
   *   group().by(k)   against  groupCount().by(k)  — the same grouping, a different aggregate
   *   is(v)           against  has(k, v)           — a value filter against an element filter
   *   fold().unfold()  against  fold()             — the round trip against the one-way
   *   range/tail/skip  against  limit              — NOT the same: `limit` can stop early, `tail`
   *                                                  must see the whole stream and `skip` discards a
   *                                                  prefix, so item 1660's "TINY" does not cover them.
   */
  'group: group by key': () => traversal(V(), group().by('n')),
  'group: groupCount by key': () => traversal(V(), groupCount().by('n')),
  /*
   * `is(5)` MATCHED NOTHING AND THE ROW WAS USELESS — 0 rows, so it priced a filter that never
   * fires against one matching 25,000. The fixture's `n` is not in that range; `gt(-1)` keeps every
   * row, which makes the two filters comparable on EMISSIONS as well as on scan.
   */
  'filt: is value': () => traversal(V(), values('n'), is(gt(-1))),
  'filt: has element': () => traversal(V(), has('n', 5), values('n')),
  'page: tail 10': () => traversal(V(), values('n'), tail(10)),
  'page: skip 10': () => traversal(V(), values('n'), skip(10)),
  'page: limit 10': () => traversal(V(), values('n'), limit(10)),
  'scan: properties': () => traversal(V(), properties('n')),
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
   * THESE THREE WERE MISSING, AND THAT IS WHY THREE SHIPPED WINS WERE INVISIBLE HERE (item 1958).
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
   * ADDED AT ITEM 2027, BEFORE MEASURING RATHER THAN AFTER — item 2026's lesson. That item fused a
   * shape the screen had no row for, so its own four-round A/B read flat everywhere and the win was
   * only visible in a dedicated probe. A rung that gains a shape should gain the row in the same
   * commit, or the screen cannot regression-test it.
   */
  'optional: hop count': () => traversal(V(), optional(out('E')), count()),
  /*
   * THE RECONVERGING-BRANCH FAMILY (item 1994), which this screen has never carried — and the
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
   * `coalesce: hop + identity` IS THE PAIR FOR `optional: hop` DIRECTLY ABOVE IT. They are the
   * same question — item 1990 normalizes one into the other — so a gap between these two rows is a
   * spelling defect by definition, which is exactly what this screen exists to surface.
   */
  'coalesce: hop + identity': () => traversal(V(), coalesce(out('E'), identity()), values('n')),
  'coalesce: two hops': () => traversal(V(), coalesce(out('E'), in_('E')), values('n')),
  // `has('n', 0)` over `n = i % 97` sends ~96 of 97 vertices to the SECOND arm. Item 1993 lost a
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
   * NINE FAMILIES NEITHER SCREEN COVERED (item 1898), added because every widening of an axis in
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
   * ADDED AT ITEM 2026 BECAUSE THE SCREEN COULD NOT SEE THE SHAPE IT FUSED. Items 2021 and 2025
   * widened the scan-values gate from two sides and 2026 covered the corner — a trailing residual on
   * an existence-filtered scan — but no screen row had that combination, so its PRE/POST read flat
   * everywhere and the win was only visible in a dedicated probe (49.5 -> 24.6 ms at 200,000). A
   * family whose combinations are not on the screen cannot be regression-tested by it.
   */
  /*
   * ADDED AT ITEM 2060 BECAUSE THE SCREEN HAD NO `where … count` ROW AT ALL — item 2026 priced a
   * trailing `count()` on this prefix at ~1.6x available from a route census plus arithmetic, and the
   * row needed to measure it never existed. The census still shows the shape GENERIC, which looks
   * like an unclaimed 1.6x; the rewrite at `index.ts` turns `values(k) … count()` into
   * `hasKey(k) … count()`, so it may already be the cheaper route rather than a gap.
   */
  'where: sub-traversal count': () =>
    traversal(V(), where(traversal(out('E'))), values('n'), count()),
  /*
   * ITEM 2079: the one priced row item 2026 left open. Its note: "`dedupe` IS NOT COVERED and that
   * is not an oversight: `fusedProjectedResidual` handles order/count/fold/min/max/cap, while
   * `dedupe` has its own rung (`nodeValuesDedupeShortcut`, item 1869) which this prefix cannot
   * reach. Its ~1.3x stays open and is the smallest of the three." That 1.3x was arithmetic on a
   * census, not a measurement, so it needed a row.
   */
  'where: sub-traversal dedupe': () =>
    traversal(V(), where(traversal(out('E'))), values('n'), dedupe()),
  'where: sub-traversal order': () =>
    traversal(V(), where(traversal(out('E'))), values('n'), order()),
  'where: neq filter': () => traversal(V(), as_('a'), out('E'), where(neq('a')), values('n')),
  'path: hop path': () => traversal(V(), out('E'), path()),
  'page: range mid': () => traversal(V(), out('E'), values('n'), range(1000, 1010)),
  'dedupe: by key': () => traversal(V(), out('E'), dedupe().by('n'), values('n')),
  'sideeffect: aggregate + cap': () => traversal(V(), out('E'), aggregate('x'), cap('x')),
  /*
   * ITEM 2068: the rows that actually reach `aggregateStep`. The `+ cap` row above does not —
   * item 1911's fused residual claims it whole — so the generic pass-through step had no bench row
   * at all. Dropping the `cap` is what exposes it.
   */
  'sideeffect: aggregate pass-through': () => traversal(V(), out('E'), aggregate('x'), count()),
  'sideeffect: store pass-through': () => traversal(V(), out('E'), store('x'), values('n')),
  /*
   * ITEM 2070: the BARE TRAILING BARRIER, with the side effect AFTER the projection so the walk's
   * residual is exactly ["aggregate"]. Item 2069's gate requires two residual steps and declines it.
   * Its lazy twin is deliberately beside it: `aggregate` is an eager barrier so a drain is correct,
   * `store` is lazy and a drain would collect what an early-exiting caller must not see.
   */
  'sideeffect: values then aggregate': () => traversal(V(), out('E'), values('n'), aggregate('x')),
  'sideeffect: values then store': () => traversal(V(), out('E'), values('n'), store('x')),
  'sideeffect: values alone': () => traversal(V(), out('E'), values('n')),
  /*
   * ITEM 2078: the SCAN-based barrier, where the side effect sits BEFORE the projection so the bag
   * holds VERTICES and the output holds values. `list: scan aggregate values` is the census's last
   * unexplained generic row — item 2070 noted it reaches no fused walk at all and left it.
   */
  'sideeffect: scan aggregate values': () => traversal(V(), aggregate('x'), values('n')),
  'sideeffect: scan values alone': () => traversal(V(), values('n')),
  /**
   * THE PATH-DEPENDENT FAMILY, which this screen never carried (item 1921). `ast.ts`'s
   * `PATH_DEPENDENT_KINDS` lists ten step kinds that make `planReadsPath` TRUE, and every fused walk
   * in the package is gated on `!tracksPath` — so each of them reaches no rung at all. Item 1898
   * found that asking what a screen does NOT ask turned up the five biggest shapes on the surface,
   * and item 1920 then took `path()` itself at 14.8x once it was measured. These are the rest of
   * that family, as an application would write them.
   *
   * `outE(T).otherV()` IS THE INTERESTING ONE: for a DIRECTED edge step it is exactly
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

/*
 * **`ONLY` IS A SUBSTRING MATCH, AND FIVE ROW NAMES ARE PREFIXES OF OTHERS** — so
 * `ONLY='where: sub-traversal'` silently runs THREE shapes in one process, defeating the
 * one-shape-per-process rule this file exists to enforce (items 1958, 1984, 1988). Worse, the table
 * prints SORTED BY TIME, so a `| tail -1` picks the FASTEST row rather than the named one: item
 * 2061's A/B read its `count` row twice and never measured the plain arm at all.
 *
 * `ONLY='=where: sub-traversal'` (a leading `=`) requires an EXACT name. The affected prefixes are
 * `range: has(gt)`, `edge: outE.has(w).inV`, `order: values order`, `optional: hop` and
 * `where: sub-traversal`.
 */
const exactly = ONLY.startsWith('=');
const wanted = exactly ? ONLY.slice(1) : ONLY;
const matchesRow = (k) => {
  if (ONLY === '') {
    return true;
  }

  return exactly ? k === wanted : k.includes(wanted);
};
const names = Object.keys(SHAPES).filter(matchesRow);

if (ONLY !== '' && names.length === 0) {
  throw new Error(`ONLY='${ONLY}' matched no row — a typo measures nothing and reports nothing`);
}

if (ONLY !== '' && !exactly && names.length > 1) {
  console.log(
    `#  ONLY='${ONLY}' matched ${String(names.length)} rows (${names.join(', ')}) — they share ` +
      `one process, which is what this file tells you not to do. Use ONLY='=${names[0]}' for exactly one.`,
  );
}

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
console.log('# SORTED BY ABSOLUTE ms. Read `rows` beside it: a shape returning 0 measures a miss.');
/*
 * THE CAVEAT IS PRINTED, NOT FILED (item 1988, the same fix as item 1985's probe banner).
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
  '#    ABSOLUTES ARE INFLATED 1.3-1.9x UNEQUALLY by the ~44 shapes sharing this process.\n' +
    '#    Rank with them; do NOT compare two rows or two runs. For either, re-run with\n' +
    "#    ONLY='<the row's name>' so the shape has a process to itself (items 1958, 1984, 1988).\n",
);
console.log('      ms      rows   shape');
console.log('-------------------------------------------------------');

/** `0` rows is a MISS and `-1` is a raise; both make the millisecond figure meaningless. */
const flagFor = (n, err) => {
  if (n === 0) {
    return '  EMPTY — this row measures a miss';
  }

  return n === -1 ? `  RAISED ${err}` : '';
};

for (const [ms, n, name, err] of rows) {
  console.log(`${ms.toFixed(2).padStart(8)} ${String(n).padStart(9)}   ${name}${flagFor(n, err)}`);
}
