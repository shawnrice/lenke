/**
 * Item 2017 — WHAT DOES THE `ORDER BY` ON A LARGE CROSS PRODUCT COST, AND WHAT IS ITS FLOOR?
 *
 * ⚠️⚠️ **THE NOMINATION, AND WHY IT IS NEW DESPITE ~15 ITEMS OF SORT WORK.** `family-split-1880.ts`
 * puts the GQL surface's largest shape at
 *
 * ```text
 *     MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN b.n AS x, d.n AS y ORDER BY x, y
 *         9908.6 ms   6,750,000 rows
 *     the SAME shape with no ORDER BY
 *         2206.3 ms   6,750,000 rows      <- 4.49x
 * ```
 *
 * `PROBES.md` labels this family "a genuine product (1864)" and that is TRUE OF THE ROW COUNT — a
 * comma pattern really is |E|x|F| rows. It says nothing about the **7.7 extra seconds of sort on
 * top**, which is the largest single number on the GQL surface by two orders of magnitude and is not
 * in the accounted list. Items 1902-1968 worked the sort ROUTES (compiled keys, deferred arms,
 * post-projection slices) on fixtures of thousands of rows; this is the same machinery at 6.75
 * MILLION, where the per-row terms the earlier items priced at tens of nanoseconds become seconds.
 *
 * 🔑 **SO THE QUESTION IS NOT "IS THE SORT SLOW" BUT "WHAT IS THE SORT'S FLOOR AT THIS SIZE".** An
 * `n log n` comparison sort of 6.75M rows is genuinely expensive and item 1976 already declined a
 * 744 ms row for exactly that reason. The arms below separate the terms that have a floor from the
 * ones that do not:
 *
 * ```text
 *     product            the cross product, no ORDER BY          — the engine's own baseline
 *     ordered            the same with ORDER BY x, y             — the nominated shape
 *     ordered1           ORDER BY x only                         — is the SECOND key free?
 *     handproduct        the product by hand into a flat array    — the row-building floor
 *     handsort           the same, then Array.sort, 2-key        — the SORT floor
 *     handsort1          the same, 1-key                         — the 2nd key's floor
 *     handsortpairs      sort a flat Float64Array of PAIRS       — what a columnar sort could add
 * ```
 *
 * ⚠️ ONE ARM PER PROCESS (item 762): 6.75M rows is enough to perturb anything sharing the heap, and
 * a shape in a mixed process gets the mix's dispatch site.
 *
 * ⚠️ MEMORY. 6.75M rows is already ~GB-scale once boxed, so this probe MUST run under a cap:
 *     timeout 600 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
 *       bun crossproduct-sort-2017.mjs
 * [[dogfood-sim-resource-limits]] — generated-input probes have taken this box down four times.
 *
 * ⚠️ AND THE ANSWERS ARE COMPARED, not assumed: every arm prints a digest of the first and last
 * rows, so an arm that sorted differently (or not at all) is visible rather than merely fast.
 *
 *     ARM=ordered bun crossproduct-sort-2017.mjs
 *     NODES=600 ARM=handsort bun crossproduct-sort-2017.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 5);
const ARM = process.env.ARM ?? 'ordered';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
}

let eCount = 0;
let fCount = 0;

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // ⚠️ SPLIT ON THE REPEAT INDEX — CLAUDE.md's rule. Without `hop` in the expression one vertex's
  // FANOUT edges all land on ONE target and every degree statistic still reads correctly.
  const hop = Math.floor(e / NODES);
  const to = ((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1;
  // Two types, so the comma pattern has two independent legs.
  const label = e % 2 === 0 ? 'E' : 'F';

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(to)),
    labels: [label],
    properties: { w: e % 7 },
  });

  if (label === 'E') {
    eCount += 1;
  } else {
    fCount += 1;
  }
}

const Q_PRODUCT = 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN b.n AS x, d.n AS y';
const Q_ORDERED = `${Q_PRODUCT} ORDER BY x, y`;
const Q_ORDERED1 = `${Q_PRODUCT} ORDER BY x`;

/** The E and F legs' projected values, materialized once — the product's two inputs. */
const legs = () => {
  const xs = [];
  const ys = [];

  for (const v of g.vertices) {
    const eb = v.adjFrom?.get('E');

    if (eb !== undefined) {
      for (const edge of eb) {
        xs.push(edge.to.properties.n);
      }
    }

    const fb = v.adjFrom?.get('F');

    if (fb !== undefined) {
      for (const edge of fb) {
        ys.push(edge.to.properties.n);
      }
    }
  }

  return { xs, ys };
};

/* eslint-disable typescript/prefer-for-of -- the INDEXED form is what these hand arms measure:
   building 2.25M rows with an iterator per row is the cost being compared away. */
/** The product by hand, as `{x, y}` rows — the row-BUILDING floor, no sort. */
const handProduct = (L) => {
  const { xs, ys } = L;
  const out = new Array(xs.length * ys.length);
  let k = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];

    for (let j = 0; j < ys.length; j += 1) {
      out[k] = { x, y: ys[j] };
      k += 1;
    }
  }

  return out;
};

const handSort = (L) => {
  const rows = handProduct(L);

  rows.sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));

  return rows;
};

const handSort1 = (L) => {
  const rows = handProduct(L);

  rows.sort((p, q) => p.x - q.x);

  return rows;
};

/*
 * ⚠️ THE COLUMNAR ARM, and it is NOT a proposal — it is here to price the two getters and the row
 * BOXING so the arms above are not read as the ceiling. Item 1893's own probe carried the same kind
 * of arm for the same reason ("it hoists both property BAGS into Float64Arrays, which is a columnar
 * store, not a graph"). A graph engine that returns `{x, y}` rows cannot reach this.
 */
const handSortPairs = (L) => {
  const { xs, ys } = L;
  const n = xs.length * ys.length;
  const flat = new Float64Array(n * 2);
  let k = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];

    for (let j = 0; j < ys.length; j += 1) {
      flat[k] = x;
      flat[k + 1] = ys[j];
      k += 2;
    }
  }

  // Sort an index permutation, which is what a columnar sort would actually do.
  const idx = new Int32Array(n);

  for (let i = 0; i < n; i += 1) {
    idx[i] = i;
  }

  const view = Array.from(idx);

  view.sort((p, q) => {
    const px = flat[p * 2];
    const qx = flat[q * 2];

    return px === qx ? flat[p * 2 + 1] - flat[q * 2 + 1] : px - qx;
  });

  return view;
};

/* eslint-enable typescript/prefer-for-of */
/*
 * ⚠️ ITEM 2023's ARMS. The no-copy binding VIEW is worth what its CONSUMER makes it worth, so these
 * three read the product's bindings three different ways:
 *
 *     product     RETURN b.n AS x, d.n AS y   — two `get`s a row, where a view should shine
 *     star        RETURN *                    — copies EVERY entry, so a view pays per access
 *     distinct    RETURN DISTINCT …           — `rowKey` iterates the whole binding, likewise
 *
 * A view that wins on the first and loses on the other two is not a win; it is a trade whose sign
 * depends on the query. That is the question item 2022 left open and could not answer from a probe.
 */
const Q_STAR = 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN *';
const Q_DISTINCT = Q_PRODUCT.replace('RETURN', 'RETURN DISTINCT');

const ARMS = {
  star: () => [...query(g, Q_STAR)],
  distinct: () => [...query(g, Q_DISTINCT)],
  product: () => [...query(g, Q_PRODUCT)],
  ordered: () => [...query(g, Q_ORDERED)],
  ordered1: () => [...query(g, Q_ORDERED1)],
  handproduct: 'HAND',
  handsort: 'HAND',
  handsort1: 'HAND',
  handsortpairs: 'HAND',
  /*
   * ⚠️ ITEM 2018's QUESTION, isolated: the SORTED path builds a `Map` per row (`projectBinding`),
   * sorts, then has `mapToRow` copy each `Map` into a plain object — "two allocations and two
   * iterations per row where one of each will do", which `projectRow`'s own header says was fixed
   * for the NO-SORT path and is still present here. These two arms are the same sort with and
   * without that intermediate, so the difference IS the Map round-trip.
   */
  handsortviamap: 'HAND',
};

/* eslint-disable typescript/prefer-for-of -- the INDEXED form is what this arm measures too */
/** The engine's sorted path in miniature: a Map per row, sort, then copy each Map into an object. */
const handSortViaMap = (L) => {
  const { xs, ys } = L;
  const rows = new Array(xs.length * ys.length);
  let k = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];

    for (let j = 0; j < ys.length; j += 1) {
      // `projectBinding`: the projected columns as a Map, in item order.
      const m = new Map();

      m.set('x', x);
      m.set('y', ys[j]);
      rows[k] = { b: m, keys: [x, ys[j]] };
      k += 1;
    }
  }

  rows.sort((p, q) => (p.keys[0] === q.keys[0] ? p.keys[1] - q.keys[1] : p.keys[0] - q.keys[0]));

  // `mapToRow`: a second allocation and a second iteration per row.
  const out = new Array(rows.length);

  for (let i = 0; i < rows.length; i += 1) {
    const row = {};

    for (const [kk, v] of rows[i].b) {
      row[kk] = v;
    }

    out[i] = row;
  }

  return out;
};

/* eslint-enable typescript/prefer-for-of */
const HANDS = {
  handproduct: handProduct,
  handsortviamap: handSortViaMap,
  handsort: handSort,
  handsort1: handSort1,
  handsortpairs: handSortPairs,
};

/*
 * ⚠️ GENERIC OVER THE ROW'S SHAPE. `x`/`y` is the projected arms' shape; `RETURN *` rows carry the
 * pattern's variables instead, and hard-coding `x`/`y` printed `undefined/undefined` for every row
 * of the `star` arm — which reads as a broken arm rather than a mismatched digest.
 */
const show = (v) => {
  if (typeof v !== 'object' || v === null) {
    return String(v);
  }

  return Object.values(v)
    .map((cell) =>
      typeof cell === 'object' && cell !== null && 'id' in cell ? String(cell.id) : String(cell),
    )
    .join('/');
};
const build = ARMS[ARM];

if (build === undefined) {
  console.log(`unknown ARM=${ARM}; one of ${Object.keys(ARMS).join(' ')}`);
  process.exit(1);
}

const L = build === 'HAND' ? legs() : undefined;
const series = [];
let rows = 0;
let digest = '';

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const got = build === 'HAND' ? HANDS[ARM](L) : build();

  series.push(performance.now() - t0);
  rows = got.length;

  if (r === 0) {
    // ⚠️ A PREFIX AND A SUFFIX, POSITIONALLY — an arm that did not actually sort is the failure mode
    // here, and a row COUNT cannot see it.
    digest = `${got.slice(0, 3).map(show).join(' ')} … ${got.slice(-3).map(show).join(' ')}`;
  }
}

const sorted = [...series].sort((a, b) => a - b);
const [best] = sorted;
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `# |V|=${String(g.vertexCount)} E=${String(eCount)} F=${String(fCount)} ARM=${ARM} rows=${String(rows)}`,
);
console.log(`series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
console.log(
  `best ${best.toFixed(1)} ms   median ${med.toFixed(1)}   ` +
    `${((best * 1e6) / Math.max(rows, 1)).toFixed(0)} ns/row   ${digest}`,
);
