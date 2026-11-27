/**
 * THE ONE-HOP AGGREGATE RUNGS AGAINST THEIR OWN ROW FORM - item 2410's class sweep, one width down,
 * plus the axis no oracle here has had: LABEL VACUITY.
 *
 * WHY THIS WIDTH IS A GAP. Item 2410 found TWO SILENT WRONG ANSWERS by asking every
 * (pattern x variable x aggregate) for both its aggregate form and its row form and reducing the
 * rows in JS - `count(a.n)` answered 0 over 1,280,000 paths whose `a.n` is never null, live for 400
 * items under 5,439 green tests. Its 945-cell sweep covered the CHAIN rungs. The ONE-HOP rungs
 * (`hopAggregate`, `groupHopShortcut`, `distinctProjection`, `distinctCount`) are the same class of
 * code - a fast rung evaluating a compiled expression against a binding it assembled itself - and
 * they were never swept. `CLOSED.md` lists this extension as surfaced and not taken.
 *
 * WHY THE ROW FORM IS A LEGITIMATE ORACLE AND NOT A RE-DERIVED WALK. The JS reduction consumes the
 * ENGINE'S OWN ROWS; it never recomputes which paths exist. So it cannot agree with a wrong walk and
 * cannot disagree with a right one for any reason but the fold. The row form is the oracle precisely
 * because it is the shape no folding rung serves - it must materialize, so it binds everything.
 *
 * ## THE NEW AXIS: MIXED, and item 2415 is why it belongs in an ORACLE rather than a bench
 *
 * Item 2415 measured that one isolated off-label vertex changes WHICH ARM ANSWERS a one-hop query -
 * under a vacuous start label `sum`/`max`/rows take `farDrivenHopWalk`, and with one off-label
 * vertex present NOBODY does. A route change is answer-equivalent when every route is correct, so
 * this axis is free when all is well and is the only way to see a rung that is wrong on ONE of its
 * two arms. Every answer must be IDENTICAL across the axis, because the added vertex has no edges
 * and cannot appear in any hop.
 *
 * Both engines' walk orders are implementation-dependent, so `collect` is compared as a MULTISET
 * (item 2404's owner ruling) and everything else by value. Floats follow item 2401's PRECISION
 * contract rather than bit-identity: `sum`/`avg` re-associate by design, so an exact comparison
 * would report every correct answer as a failure.
 *
 *     bun onehopagg-oracle-2416.mjs
 *     bun onehopagg-mutants-2416.mjs   # does it have TEETH?
 */
import { Graph } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: an oracle is a MUTATION target's reference, so it must read the SOURCE it mutates. Through `@lenke/gql` it would read dist and every mutant would need a full rebuild to be seen ([[fuzzers-read-built-dists]]).
import { query } from '../gql/src/index.ts';

const EPS = Number.EPSILON;

/**
 * Three layers with DISJOINT value sets, fanout 2, built so a one-hop query has a genuine start set
 * and a genuine far set that cannot be confused.
 *
 * DISJOINT IS LOAD-BEARING, and item 2410 is where that was learned: on a ring every vertex is both
 * a start and a far end, so an aggregate evaluated against the WRONG variable coincides with the
 * right answer and the oracle goes quiet.
 *
 * `z` is absent on every vertex, so every aggregate over it folds an EMPTY set - the case that let
 * item 2409's empty-`sum` defect (`null` where every other route answers 0) survive a green suite.
 * `nl` is null on one layer, so the non-null filter is exercised rather than assumed. `f` is
 * binary-inexact so the float arms genuinely re-associate.
 */
const build = (mixed) => {
  const g = new Graph();
  const layers = [
    [10, 20],
    [1, 2],
    [100, 200],
  ];

  for (const [li, vals] of layers.entries()) {
    for (const [vi, n] of vals.entries()) {
      g.addVertex({
        id: `L${li}-${vi}`,
        labels: ['P', li % 2 === 0 ? 'Even' : 'Odd'],
        // `nl` is deliberately null on the MIDDLE layer only. It is written at construction
        // because `addVertex` freezes the property bag and a later assignment throws.
        properties: {
          n,
          f: n * 0.1,
          g: 1,
          nl: li === 1 ? null : n,
          // A STRING and a STORED TEMPORAL, and the mutation run is why they are here: the mutant
          // that removes `SUM_FOLD`'s `typeof v !== 'number'` guard SURVIVED a 1,704-cell sweep,
          // because every column was numeric or absent and nothing could reach the guard. A fold's
          // type fault is unobservable without a value that faults.
          s: `s${String(n)}`,
          t: { '@date': '2024-01-02' },
        },
      });
    }
  }

  // Fanout 2: every vertex of layer i points at both vertices of layer i+1, so multiplicity is
  // greater than one and a fold that drops or double-counts a path shows up.
  for (let li = 0; li < layers.length - 1; li += 1) {
    for (let a = 0; a < 2; a += 1) {
      for (let b = 0; b < 2; b += 1) {
        g.addEdge({
          id: `e${String(li)}-${String(a)}-${String(b)}`,
          from: g.getVertexById(`L${String(li)}-${String(a)}`),
          to: g.getVertexById(`L${String(li + 1)}-${String(b)}`),
          labels: ['E'],
          properties: { w: a + b },
        });
      }
    }
  }

  if (mixed) {
    // ONE ISOLATED off-label vertex (item 1943's design): no edges, a label nothing matches, so
    // every ANSWER must be unchanged and only the ROUTE moves.
    g.addVertex({ id: 'off', labels: ['Z'], properties: {} });
  }

  return g;
};

/** The non-null values of one column over the engine's own rows. */
const vals = (rows) => rows.map((r) => r.v).filter((v) => v !== null && v !== undefined);

/**
 * A VALUE key, because a stored temporal comes back as an OBJECT and JS collections key objects by
 * IDENTITY.
 *
 * This oracle's first run with a temporal column reported 96 failures - `count(DISTINCT x1.t)` got
 * 1, wanted 4 - and the ENGINE was right: every vertex stores the same date, so there is exactly
 * one distinct value. `new Set(values)` counted four distinct object identities. The reference was
 * the defect, and an oracle whose reference is wrong manufactures failures at exactly the cells a
 * real bug would hide in.
 */
const valueKey = (x) =>
  `${typeof x}:${typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)}`;

/** The JS reference for each aggregate, reducing the ENGINE'S rows rather than re-walking. */
const REFERENCE = {
  'count(*)': (rows) => rows.length,
  count: (rows) => vals(rows).length,
  sum: (rows) => {
    const v = vals(rows);

    // Kahan, so the REFERENCE is the accurate one and any disagreement is the engine's.
    let s = 0;
    let c = 0;

    for (const x of v) {
      const y = x - c;
      const t = s + y;

      c = t - s - y;
      s = t;
    }

    return v.length === 0 ? 0 : s;
  },
  avg: (rows) => {
    const v = vals(rows);

    return v.length === 0 ? null : REFERENCE.sum(rows) / v.length;
  },
  min: (rows) => {
    const v = vals(rows);

    return v.length === 0 ? null : Math.min(...v);
  },
  max: (rows) => {
    const v = vals(rows);

    return v.length === 0 ? null : Math.max(...v);
  },
  collect: (rows) => vals(rows),
  'count(DISTINCT)': (rows) => new Set(vals(rows).map(valueKey)).size,
  /*
   * The DISTINCT values of the row form, as a multiset for `sameMultiset`. NULL IS KEPT here and
   * excluded everywhere else on this sheet, because a projection returns a null row where an
   * aggregate skips the value — `RETURN DISTINCT x1.nl` must yield a null row for the layer whose
   * `nl` is null, and dropping it would make the oracle demand the wrong answer.
   */
  'DISTINCT proj': (rows) => {
    const seen = new Map();

    for (const r of rows) {
      const k = valueKey(r.v);

      if (!seen.has(k)) {
        seen.set(k, r.v);
      }
    }

    return [...seen.values()];
  },
};

/** The aggregate's GQL spelling over `<v>.<col>`. */
const SPELL = {
  'count(*)': () => 'count(*)',
  count: (e) => `count(${e})`,
  sum: (e) => `sum(${e})`,
  avg: (e) => `avg(${e})`,
  min: (e) => `min(${e})`,
  max: (e) => `max(${e})`,
  collect: (e) => `collect(${e})`,
  'count(DISTINCT)': (e) => `count(DISTINCT ${e})`,
  /*
   * NOT AN AGGREGATE, and it is here because item 2423 moved it and this file was the only
   * cross-route oracle in reach. `RETURN DISTINCT <expr>` is a PROJECTION: it returns one row per
   * distinct value rather than one row overall, so its reference is the row form's distinct SET and
   * its result is compared as a MULTISET (an unordered result's row order is unspecified —
   * [[order-is-unspecified]]). Everything else on the sheet — the patterns, the columns, the
   * null and absent-key cells, the label-vacuity route axis — applies to it unchanged.
   */
  'DISTINCT proj': (e) => `DISTINCT ${e}`,
};

/** The aggregates that answer ONE row; `DISTINCT proj` answers one row per distinct value. */
const MULTI_ROW = new Set(['DISTINCT proj']);

/**
 * The one-hop PATTERNS. Each is a modifier that admits or disqualifies a different rung, which is
 * the point: a sweep over one pattern measures one route.
 */
const PATTERNS = {
  plain: '(a:P)-[:E]->(x1:P)',
  // Reverse and undirected: the undirected hop runs TWO walks in the aggregate rung
  // (`withHopDirection`), which is a distinct accumulator path from the directed one.
  reverse: '(a:P)<-[:E]-(x1:P)',
  undirected: '(a:P)-[:E]-(x1:P)',
  relvar: '(a:P)-[r:E]->(x1:P)',
  nofarlabel: '(a:P)-[:E]->(x1)',
  nostartlabel: '(a)-[:E]->(x1:P)',
  inline: '(a:P {g: 1})-[:E]->(x1:P)',
  labelexpr: '(a:P)-[:E]->(x1:P|Odd)',
};

/** A trailing clause, because a `WHERE` disqualifies several rungs and must not change the answer. */
const WHERES = {
  none: '',
  startwhere: ' WHERE a.g = 1',
  farwhere: ' WHERE x1.n >= 0',
};

const VARS = ['a', 'x1'];
const COLS = ['n', 'f', 'g', 'z', 'nl', 's', 't'];

/**
 * The columns whose values are not numbers, and the aggregates that stay comparable over them.
 *
 * `min`/`max`/`avg` are EXCLUDED over these rather than overlooked: the engine uses a TOTAL ORDER
 * for sort/min/max (NaN last, NaN equal to NaN - [[nan-comparison-policy]]), and a JS reference
 * using `Math.min` would be testing the harness's idea of cross-type comparison instead of the
 * fold. `count`, `count(DISTINCT)` and `collect` are well defined for any value, and `sum` is kept
 * BECAUSE it must FAULT - which is the thing the fixture gained these columns to observe.
 */
const NON_NUMERIC = new Set(['s', 't']);
const NON_NUMERIC_AGGS = new Set([
  'count(*)',
  'count',
  'count(DISTINCT)',
  'collect',
  'sum',
  'DISTINCT proj',
]);

const sameMultiset = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }

  const k = valueKey;
  const sa = a.map(k).sort();
  const sb = b.map(k).sort();

  return sa.every((x, i) => x === sb[i]);
};

/**
 * Item 2401's PRECISION contract: accurate to within `n * eps * sum|x|`, NOT bit-identical, with a
 * floor so an exact-zero expectation does not demand exactness of a re-associated sum.
 */
const closeEnough = (got, want, n, absSum) => {
  if (typeof got !== 'number' || typeof want !== 'number') {
    return got === want;
  }

  const bound = Math.max(n * EPS * absSum, 1e-12);

  return Math.abs(got - want) <= bound;
};

/**
 * The cross product, built by `flatMap` rather than five nested `for`s - which hit this file's
 * complexity gate at 6 levels against a limit of 5. Item 2410's oracle was flattened for the same
 * reason; the shape is the lint rule's, not a preference.
 */
const cells = Object.entries(PATTERNS).flatMap(([pname, pat]) =>
  Object.entries(WHERES).flatMap(([wname, where]) =>
    VARS.flatMap((v) =>
      COLS.flatMap((col) =>
        Object.keys(SPELL)
          .filter((agg) => {
            // `count(*)` reads neither a column nor a variable, so one cell per pattern is enough;
            // the rest would be the identical query reported many times over.
            if (agg === 'count(*)') {
              return v === 'a' && col === 'n';
            }

            return !NON_NUMERIC.has(col) || NON_NUMERIC_AGGS.has(agg);
          })
          .map((agg) => ({ pname, pat, wname, where, v, col, agg })),
      ),
    ),
  ),
);

const graphs = { homo: build(false), mixed: build(true) };
let pass = 0;
const fails = [];
const crossFails = [];
let worst = 0;

for (const c of cells) {
  const expr = `${c.v}.${c.col}`;
  const aggText = `MATCH ${c.pat}${c.where} RETURN ${SPELL[c.agg](expr)} AS v`;
  const rowText = `MATCH ${c.pat}${c.where} RETURN ${expr} AS v`;
  const perMode = {};

  for (const [mode, g] of Object.entries(graphs)) {
    let got;
    let want;

    try {
      const aggRows = query(g, aggText, {});

      if (MULTI_ROW.has(c.agg)) {
        // A projection answers one row per distinct value, so every row is part of the answer.
        got = aggRows.map((r) => r.v);
      } else if (aggRows.length === 1) {
        got = aggRows[0].v;
      } else {
        // An aggregate answering anything but ONE row is itself the defect, so it is reported as
        // the value rather than indexed into.
        got = `ROWS:${String(aggRows.length)}`;
      }

      const rows = query(g, rowText, {});

      want = REFERENCE[c.agg](rows);

      const v = vals(rows);
      const absSum = v.reduce((t, x) => t + Math.abs(typeof x === 'number' ? x : 0), 0);
      const ok =
        c.agg === 'collect' || MULTI_ROW.has(c.agg)
          ? sameMultiset(got, want)
          : closeEnough(got, want, Math.max(v.length, 1), absSum);

      if (typeof got === 'number' && typeof want === 'number' && absSum > 0) {
        const bound = Math.max(v.length * EPS * absSum, 1e-12);

        worst = Math.max(worst, Math.abs(got - want) / bound);
      }

      if (ok) {
        pass += 1;
      } else {
        fails.push(
          `${mode} ${c.pname}/${c.wname} ${c.agg}(${expr})  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
        );
      }

      perMode[mode] = JSON.stringify(got);
    } catch (err) {
      // A THROW is a legitimate answer for some cells (a non-numeric fold faults), but it must
      // throw in BOTH label modes or the route is deciding semantics.
      perMode[mode] = `THREW:${(err instanceof Error ? err.message : String(err)).slice(0, 40)}`;
      pass += 1;
    }
  }

  if (perMode.homo !== perMode.mixed) {
    crossFails.push(
      `${c.pname}/${c.wname} ${c.agg}(${expr})  homo ${perMode.homo}  mixed ${perMode.mixed}`,
    );
  }
}

console.log(`# one-hop aggregate oracle: ${String(cells.length)} cells x 2 label modes`);
console.log(`# agg-vs-rows:  ${String(pass)} pass / ${String(fails.length)} fail`);
console.log(`# worst err/bound (item 2401's contract): ${worst.toFixed(3)}`);
console.log(
  `# ROUTE INVARIANCE (homo vs one off-label vertex): ${String(cells.length - crossFails.length)} identical / ${String(crossFails.length)} DIFFER`,
);

for (const f of fails.slice(0, 25)) {
  console.log(`  FAIL ${f}`);
}

for (const f of crossFails.slice(0, 25)) {
  console.log(`  ROUTE-DIFF ${f}`);
}

if (fails.length > 0 || crossFails.length > 0) {
  process.exitCode = 1;
}
