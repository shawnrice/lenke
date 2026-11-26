/**
 * ITEM 2410'S CLASS SWEEP: EVERY AGGREGATE AGAINST ITS OWN ROW FORM.
 *
 * The defect item 2410 fixed was one rung evaluating an aggregate's argument against a binding that
 * carried only the FAR variable, so `count(a.n)` answered 0 over 16 paths. That is an instance of a
 * general hazard — a fast rung evaluating a compiled expression against a PARTIAL binding — and the
 * single fix says nothing about whether another rung does the same thing.
 *
 * SO THIS IS AN ORACLE, NOT A TEST OF THE FIX. For every (pattern x variable x aggregate) it asks
 * the engine for `<agg>(<v>.n)` and, separately, for `<v>.n` as rows, then reduces those rows in JS
 * and compares. The row form and the aggregate form are two routes to one number, and any rung that
 * mis-binds a variable makes them disagree. The row form is the oracle BECAUSE it is the shape no
 * folding rung serves — it has to materialize, so it binds everything.
 *
 * WHY A JS REDUCTION IS A LEGITIMATE REFERENCE HERE AND NOT A RE-DERIVED WALK. It consumes the
 * ENGINE'S OWN ROWS; it does not recompute which paths exist. So it cannot agree with a wrong walk,
 * and it cannot disagree with a right one for any reason but the fold.
 *
 * FLOATS ARE COMPARED TO ITEM 2401'S CONTRACT, NOT BIT-WISE. `sum`/`avg` re-associate by design
 * (item 2409's weighted fold is a different computation from a per-path left fold), so an exact
 * comparison would report every correct answer as a failure. `count`/`min`/`max` stay exact.
 *
 *     bun nearagg-oracle-2410.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const EPS = Number.EPSILON;

/**
 * Four layers of two vertices, fanout 2, with DISJOINT value sets per layer.
 *
 * DISJOINT IS LOAD-BEARING: on a ring every vertex is both a start and a far end, so an aggregate
 * over the wrong variable can coincide with the right answer and the oracle goes quiet. `f` is
 * binary-inexact so the float arms can actually re-associate.
 */
const layered = () => {
  const g = new Graph();
  const layers = [
    [10, 20],
    [1, 2],
    [3, 4],
    [100, 200],
  ];

  for (const [li, vals] of layers.entries()) {
    for (const [vi, n] of vals.entries()) {
      g.addVertex({
        id: `L${li}-${vi}`,
        labels: ['P', li % 2 === 0 ? 'Even' : 'Odd'],
        properties: { n, f: n * 0.1, g: 1 },
      });
    }
  }

  for (let li = 0; li + 1 < layers.length; li += 1) {
    for (let from = 0; from < layers[li].length; from += 1) {
      for (let to = 0; to < layers[li + 1].length; to += 1) {
        g.addEdge({
          id: `e${li}-${from}-${to}`,
          from: g.getVertexById(`L${li}-${from}`),
          to: g.getVertexById(`L${li + 1}-${to}`),
          labels: ['E', from === to ? 'F' : 'E'],
          properties: {},
        });
      }
    }
  }

  return g;
};

const VARS = ['a', 'b', 'c', 'd', 'e'];

/** Each entry is one reason a rung might or might not claim the shape — the modifier grid. */
const patterns = [];

for (const hops of [1, 2, 3]) {
  const vs = VARS.slice(0, hops + 1);
  const plain = vs.map((v) => `(${v}:P)`);

  patterns.push({ name: `h${hops}/plain`, vs, pattern: plain.join('-[:E]->'), where: '' });
  patterns.push({
    name: `h${hops}/where`,
    vs,
    pattern: plain.join('-[:E]->'),
    where: ` WHERE ${vs[0]}.g = 1`,
  });
  patterns.push({ name: `h${hops}/relvar`, vs, pattern: plain.join('-[r:E]->'), where: '' });
  patterns.push({ name: `h${hops}/union`, vs, pattern: plain.join('-[:E|F]->'), where: '' });
  patterns.push({
    name: `h${hops}/labelexpr`,
    vs,
    pattern: plain.map((p, i) => (i === hops ? `(${vs[hops]}:P|Odd)` : p)).join('-[:E]->'),
    where: '',
  });
  patterns.push({
    name: `h${hops}/inline`,
    vs,
    pattern: plain.map((p, i) => (i === hops ? `(${vs[hops]}:P {g: 1})` : p)).join('-[:E]->'),
    where: '',
  });
  patterns.push({ name: `h${hops}/undirected`, vs, pattern: plain.join('-[:E]-'), where: '' });
}

/** The reductions, each the JS twin of one aggregate's documented semantics (nulls EXCLUDED). */
const reduce = {
  count: (xs) => xs.length,
  min: (xs) => (xs.length === 0 ? null : xs.reduce((m, x) => (x < m ? x : m))),
  max: (xs) => (xs.length === 0 ? null : xs.reduce((m, x) => (x > m ? x : m))),
  /*
   * Kahan, so the reference is ~2eps and three orders tighter than either engine arm.
   *
   * AN EMPTY `sum` IS `0` HERE BECAUSE THAT IS WHAT THE ENGINE ANSWERS ON EVERY ROUTE, and this
   * oracle's job is cross-route agreement, not an ISO opinion. It originally said `null` and that
   * cost 14 of 630 cells — which is how item 2409's divergence was found: the engine disagreed with
   * ITSELF (0 on four routes, null on the chain fold), and only one of the two could be the
   * reference. `avg` of nothing stays `null` on every route, so it is left alone.
   */
  sum: (xs) => {
    if (xs.length === 0) {
      return 0;
    }

    let s = 0;
    let c = 0;

    for (const x of xs) {
      const y = x - c;
      const t = s + y;

      c = t - s - y;
      s = t;
    }

    return s;
  },
  avg: (xs) => (xs.length === 0 ? null : reduce.sum(xs) / xs.length),
};

let pass = 0;
let fail = 0;
let worst = 0;
const fails = [];

/*
 * ONE FLAT PASS OVER A PRECOMPUTED CELL LIST rather than three nested loops — `max-depth` caps
 * nesting at 5 and the nesting carried no information the cell's own fields do not.
 */
const cells = patterns.flatMap(({ name, vs, pattern, where }) =>
  vs.flatMap((v) =>
    /*
     * `z` IS A KEY NO VERTEX HAS, AND IT IS HERE BECAUSE THE SWEEP HAD NO TEETH WITHOUT IT. With
     * only `n` and `f` every fold had values, so reverting item 2410's empty-`sum` fix left all 630
     * cells passing — the mutant SURVIVED. An absent key makes every (pattern x variable) an all-null
     * fold on EVERY route, which is exactly the cell where the routes disagreed.
     */
    ['n', 'f', 'z'].map((col) => ({ name, v, col, pattern, where })),
  ),
);

for (const { name, v, col, pattern, where } of cells) {
  const g = layered();
  const rowText = `MATCH ${pattern}${where} RETURN ${v}.${col} AS x`;
  let rows;

  try {
    rows = query(g, rowText, {}).map((r) => r.x);
  } catch (e) {
    fails.push(`${name} ${v}.${col}  ROW FORM THREW: ${e.message}`);
    fail += 1;
    continue;
  }

  const kept = rows.filter((x) => x !== null && x !== undefined);

  for (const fn of ['count', 'min', 'max', 'sum', 'avg']) {
    // An integer column cannot re-associate, so the float arms are where `sum`/`avg` are
    // interesting; both are swept so a defect that only touches one column type still shows.
    const text = `MATCH ${pattern}${where} RETURN ${fn}(${v}.${col}) AS x`;
    let got;

    try {
      got = query(g, text, {})[0].x;
    } catch (e) {
      fails.push(`${name} ${fn}(${v}.${col})  THREW: ${e.message}`);
      fail += 1;
      continue;
    }

    const want = reduce[fn](kept);
    const exact = fn === 'count' || fn === 'min' || fn === 'max';
    let ok;
    let detail = '';

    if (want === null || got === null) {
      ok = want === got;
    } else if (exact) {
      ok = got === want;
    } else {
      // Item 2401's contract: |engine - exact| <= n * eps * sum|xi|.
      const absSum = kept.reduce((t, x) => t + Math.abs(x), 0);
      const bound = Math.max(kept.length * EPS * absSum, EPS * Math.abs(want));
      const err = Math.abs(got - want);

      ok = err <= bound;
      detail = bound === 0 ? '' : ` err/bound ${(err / bound).toExponential(2)}`;

      if (bound > 0) {
        worst = Math.max(worst, err / bound);
      }
    }

    if (ok) {
      pass += 1;
    } else {
      fail += 1;
      fails.push(
        `${name} ${fn}(${v}.${col})  got ${String(got)}  want ${String(want)}  (${kept.length}/${rows.length} non-null)${detail}`,
      );
    }
  }
}

for (const f of fails) {
  console.log(`FAIL  ${f}`);
}

console.log(
  `\n${pass} pass  ${fail} fail   worst err/bound ${worst.toExponential(2)}  ` +
    `(${patterns.length} patterns)`,
);
