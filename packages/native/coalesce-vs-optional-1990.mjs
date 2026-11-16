// Items 1990/1991 — the RECONVERGING-BRANCH family: `coalesce`, `choose` and `branch`.
//
// ⚠️ IT OUTGREW ITS NAME. Item 1990 built it to compare `coalesce(out(T), identity())` with
// `optional(out(T))` — the pair below — and item 1991 added `choose`/`branch` plus a HAND CEILING,
// because those two have no cheaper twin to compare against. The filename is kept so the entry that
// cites it still resolves.
//
// Item 1990 — `coalesce(out(T), identity())` against `optional(out(T))`, which are the SAME QUESTION.
//
// ⚠️⚠️ **THESE TWO SPELLINGS HAVE DIFFERENT HISTORIES AND THAT IS THE POINT.** `optional` has two
// dedicated fused modules (`optional-hop.ts`, `optional-hop-values.ts`, the second riding item
// 1889's CSR behind the second-ask policy) and the workload screen puts `optional: hop` at 46.24 ms
// against a bare `hop1: values`'s 45.88 — i.e. essentially FREE. `coalesce` has no module at all:
// item 1629 gave `coalesceStep` a direct adjacency-bucket read worth **1.26x** and item 1480 records
// the structural reason neither could be fused properly — "the fused walks are SOURCE-ANCHORED, so
// no sub-plan can reach them".
//
// 🔑 SO THE QUESTION IS WHETHER THE STRUCTURAL BLOCKER STILL BINDS *coalesce* AFTER `optional` GOT
// AROUND IT. `optional(X)` and `coalesce(X, identity())` emit the same rows in the same order: both
// run X per incoming traverser and fall back to the input when X is empty. If one is 1.0x a bare hop
// and the other is several x, that is this repo's named defect class between two spellings of one
// question — and the cure already exists one shape over.
//
// ⚠️ ONE SHAPE PER PROCESS (item 762): with several shapes in one run the shared dispatch site is
// polymorphic and the figure belongs to the mix. Item 1988 measured that at 1.3-1.56x on this very
// screen's rows, so the arms here are selected by argv.
//
// ⚠️ THE ANSWERS ARE COMPARED ELEMENT FOR ELEMENT, not as a multiset. Gremlin stream order is a
// TinkerPop contract that the differential fuzzer compares ORDERED for a single-type step
// ([[order-is-unspecified]] does not cover it), so a route that reorders is wrong, not merely
// different — and a checksum cannot see that (item 1955).
//
//     bun coalesce-vs-optional-1990.mjs            # all arms, answers compared, then times
//     ARM=coalesce bun coalesce-vs-optional-1990.mjs
import { Graph } from '@lenke/core';
import {
  branch,
  count,
  choose,
  coalesce,
  constant,
  has,
  identity,
  in_,
  optional,
  out,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);
const { ARM } = process.env;
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // The workload screen's generator, verbatim — split on the REPEAT INDEX (CLAUDE.md's rule).
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

/*
 * ⚠️ A VERTEX WITH NO `E` EDGES IS ADDED DELIBERATELY. `optional` and `coalesce(…, identity())`
 * differ from a bare hop ONLY on the rows the hop misses, so a fixture where every vertex has an
 * out-edge cannot tell the three apart — the fallback arm would never run and the comparison would
 * measure a plain hop three times. The screen's generator gives every vertex degree FANOUT.
 */
g.addVertex({ id: 'lonely', labels: ['P'], properties: { n: 999 } });

const ARMS = {
  // The bare hop — the FLOOR, and not a valid ceiling for the other two: it emits nothing for the
  // vertex they emit a fallback row for, so it does strictly less work (item 1951's rule).
  hop: () => traversal(V(), out('E'), values('n')),
  /*
   * ⚠️⚠️ THE INWARD HOP IS A SEPARATE CONTROL, and item 1993 is why. `chooseTwoArm`'s test is
   * `has('n', 0)` over `n = i % 97`, so **96 of every 97 vertices take the `in_(E)` arm** — while the
   * `hop` control above is `out(E)`. Comparing them attributes the inward hop's cost to `choose`.
   * CLAUDE.md's "match the fixture to the claim", one level in: match the CONTROL to the arm the
   * shape actually takes.
   */
  hopIn: () => traversal(V(), in_('E'), values('n')),
  optional: () => traversal(V(), optional(out('E')), values('n')),
  coalesce: () => traversal(V(), coalesce(out('E'), identity()), values('n')),
  /*
   * ⚠️ `choose` AND `branch` HAVE NO CHEAPER TWIN, so these are priced against the REFERENCE rows
   * above rather than against an equivalent spelling (item 1991). A conditional genuinely must run
   * its test per traverser and then one arm, so the expectation is roughly test + arm — NOT the
   * bare hop. The bare hop is here as a scale, not a ceiling (item 1951's rule).
   *
   * ⚠️ AND `choose(test, X)` WITH NO ELSE IS NOT A FILTER. Measured against the engine: with the
   * else-plan absent the traverser is PASSED THROUGH, so `choose(out(E), identity())` returns every
   * vertex where `where(out(E))` returns only those with an edge. The AST comment ("else elsePlan
   * (if present)") reads the other way and a filter-shaped twin was the first thing tried here.
   */
  chooseTwoArm: () => traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
  chooseConst: () => traversal(V(), choose(out('E'), values('n'), constant('none'))),
  /*
   * ⚠️ THE MEASURED CEILING for `chooseTwoArm`, in plain JavaScript over the adjacency — because the
   * bare hop is NOT its floor (item 1951's rule): a conditional must run its test per traverser and
   * THEN one arm, so its floor is test + arm, and estimating that from the hop row would understate
   * it. This does exactly the engine's work: one property test a vertex, then that vertex's `E`
   * edges in the chosen direction, projecting `n`.
   */
  /*
   * ⚠️ DECOMPOSITION ARMS (item 1992). `chooseStep` makes TWO `applyPlanToStream` calls per
   * traverser — one for the test, one for the chosen arm — so before optimizing either, these say
   * which dominates. Trivial arms isolate the TEST; a trivial test isolates the ARMS.
   */
  chooseTrivialArms: () => traversal(V(), choose(has('n', 0), identity(), identity()), values('n')),
  chooseHopTest: () => traversal(V(), choose(out('E'), identity(), identity()), values('n')),
  /*
   * ⚠️ BOTH ARMS THE SAME, so routing cannot matter and this isolates (test + choose machinery)
   * against the bare `out` hop. If the machinery is cheap this lands near the hop; if it lands near
   * `chooseTwoArm` the machinery IS the cost and the arm was never the term to optimize.
   */
  chooseSameArm: () => traversal(V(), choose(has('n', 0), out('E'), out('E')), values('n')),
  /* Test = identity (always yields, so always arm 0) — a trivially cheap test with a real arm. */
  chooseIdTest: () => traversal(V(), choose(identity(), out('E'), in_('E')), values('n')),
  handChoose: 'HAND',
  // ⚠️ THE CEILING FOR `chooseConst` (item 2014), which the screen put second on the Gremlin surface
  // behind the CLOSED `tree` row. The shape is `choose(out(E), values(n), constant('none'))`: test
  // whether the vertex HAS an `E` edge, then emit its own `n` or the constant. So the honest ceiling
  // is one bucket lookup and one property read per vertex — no edge is ever traversed, which is what
  // makes the 541 ns/row measured for the real arm worth pricing.
  handChooseConst: 'HANDCONST',
  branchTwo: () =>
    traversal(
      V(),
      branch(values('n')).option(0, out('E')).option(1, in_('E')).none(identity()),
      values('n'),
    ),
  /*
   * ⚠️ THE CEILING FOR `branchTwo` (item 2015), and its SHAPE IS DOMINATED BY THE `none()` ARM.
   * `n = i % 97`, so of every 97 vertices exactly one takes `out(E)`, one takes `in_(E)` and the
   * remaining **95 fall through to `none(identity())`** — which then feeds `values('n')`, i.e. the
   * vertex's own `n`, the very property the test just read. So the honest ceiling reads one property
   * per vertex, dispatches on it, and for 95/97 of them emits that same value straight back; only
   * the two routed vertices in each 97 touch an adjacency at all.
   *
   * That is why the bare hop is not this row's floor (item 1951's rule): a hop walks EVERY vertex's
   * adjacency, while this shape walks 2/97 of them.
   */
  handBranch: 'HANDBRANCH',
  /*
   * ⚠️ ITEM 2028's ARMS. A `pickFor` audit across every rung found FOUR with the same gap item 2027
   * closed in the `optional` rung — a `count` terminal declining the whole plan — and the route
   * census confirmed three of them, with dispatch counts that name the cost:
   *
   *     generic   coal: two hops count              2 calls  [coalesce count]
   *     generic   cho: filter two hops count     4002 calls  [choose count has in out]
   *     generic   br: two options count          4002 calls  [branch count identity in out values]
   *
   * 4002 is the sub-plan being re-dispatched PER TRAVERSER — the cost items 1999 and 2015 removed,
   * back because the rung refuses the plan. Each count arm is priced beside its already-fused
   * `values` twin, which does strictly MORE work (emits every row rather than one number).
   */
  coalesceCount: () => traversal(V(), coalesce(out('E'), in_('E')), count()),
  chooseCount: () => traversal(V(), choose(has('n', 0), out('E'), in_('E')), count()),
  branchCount: () =>
    traversal(
      V(),
      branch(values('n')).option(0, out('E')).option(1, in_('E')).none(identity()),
      count(),
    ),
  // The fused `values` twins, as the comparison that shows the ordering is wrong.
  coalesceTwoHops: () => traversal(V(), coalesce(out('E'), in_('E')), values('n')),
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The hand ceiling for `chooseTwoArm`, driven in vertex order so the rows are comparable. */
const handChooseRows = () => {
  const rows = [];

  for (const v of g.vertices) {
    // The test: `has('n', 0)` is one property read a vertex.
    const box = v.properties.n === 0 ? v.adjFrom?.get('E') : v.adjTo?.get('E');

    if (box === undefined) {
      continue;
    }

    for (const e of box) {
      rows.push((v.properties.n === 0 ? e.to : e.from).properties.n);
    }
  }

  return rows;
};

/** The hand ceiling for `chooseConst`: a degree test and a property read, in vertex order. */
const handChooseConstRows = () => {
  const rows = [];

  for (const v of g.vertices) {
    // `has an E edge?` — the bucket's presence, not its contents. `choose`'s test is "does the
    // sub-plan produce anything", and for a bare hop that is exactly a non-empty adjacency.
    const box = v.adjFrom?.get('E');

    rows.push(box !== undefined && box.size > 0 ? v.properties.n : 'none');
  }

  return rows;
};

/**
 * The hand ceiling for `branchTwo`: one property read a vertex, a dispatch on its value, and an
 * adjacency walk only for the two values in 97 that name one.
 *
 * ⚠️ THE `none()` ARM IS `identity()` FOLLOWED BY `values('n')`, so it re-emits the property the
 * test already read. A ceiling that re-read it would still be honest; keeping the read is what makes
 * the engine's 95/97 case comparable.
 */
const handBranchRows = () => {
  const rows = [];

  for (const v of g.vertices) {
    const { n } = v.properties;

    if (n === 0) {
      const box = v.adjFrom?.get('E');

      if (box !== undefined) {
        for (const e of box) {
          rows.push(e.to.properties.n);
        }
      }

      continue;
    }

    if (n === 1) {
      const box = v.adjTo?.get('E');

      if (box !== undefined) {
        for (const e of box) {
          rows.push(e.from.properties.n);
        }
      }

      continue;
    }

    rows.push(n);
  }

  return rows;
};

const run = (name) => {
  const build = ARMS[name];
  const ts = [];
  let rows = 0;
  let digest = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    // ⚠️ A LOOKUP, NOT NESTED TERNARIES — the hand arms are named by a sentinel string, and a third
    // one would have nested again.
    const HANDS = {
      HAND: handChooseRows,
      HANDCONST: handChooseConstRows,
      HANDBRANCH: handBranchRows,
    };
    const hand = typeof build === 'string' ? HANDS[build] : undefined;
    const got = hand === undefined ? toArray(build(), g) : hand();

    ts.push(performance.now() - t0);
    rows = got.length;

    if (r === 0) {
      // ⚠️ A PREFIX AND A SUFFIX, POSITIONALLY — not a checksum. An order change is exactly what a
      // checksum cannot see, and it is the failure mode this family would have.
      digest = `${JSON.stringify(got.slice(0, 6))}…${JSON.stringify(got.slice(-3))}`;
    }
  }

  return { ms: med(ts), rows, digest };
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)} REPS=${String(REPS)} median`,
);
console.log('# `lonely` has no E edges, so optional/coalesce emit one row a bare hop does not\n');
console.log('arm            ms      rows   ns/row   first 6 … last 3');

const names = ARM === undefined ? Object.keys(ARMS) : [ARM];
const out_ = [];

for (const name of names) {
  const got = run(name);

  out_.push([name, got]);
  console.log(
    `${name.padEnd(12)} ${got.ms.toFixed(2).padStart(7)} ${String(got.rows).padStart(8)} ${((got.ms * 1e6) / got.rows).toFixed(0).padStart(7)}   ${got.digest}`,
  );
}

if (out_.length === 3) {
  const by = Object.fromEntries(out_);

  console.log(
    `\noptional / hop   ${(by.optional.ms / by.hop.ms).toFixed(2)}x` +
      `   coalesce / hop   ${(by.coalesce.ms / by.hop.ms).toFixed(2)}x` +
      `   coalesce / optional   ${(by.coalesce.ms / by.optional.ms).toFixed(2)}x`,
  );
  console.log(
    `optional and coalesce agree on rows: ${String(by.optional.rows === by.coalesce.rows)}` +
      `   and positionally: ${String(by.optional.digest === by.coalesce.digest)}`,
  );
}
