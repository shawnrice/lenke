/**
 * Item 2021 — IS `V().values(k).order()` NEAR ITS FLOOR, OR IS THERE A TARGET?
 *
 * The Gremlin screen's leading row after item 2020 cleared both `count` shapes:
 *
 * ```text
 *     order: values order         6.92 ms   50,000 rows   138 ns/row
 *     order: values order limit   2.00         10
 * ```
 *
 * ⚠️⚠️ **138 ns/row IS NOT OBVIOUSLY SLOW FOR A SORT, AND THAT IS THE WHOLE QUESTION.** A comparison
 * sort of 50,000 elements is ~800,000 comparisons, so a per-ROW figure on a sorted row is the wrong
 * denominator — `n log n` work divided by `n` grows with `n`. CLAUDE.md's rule against pricing a
 * target before measuring its floor applies with force here: items 1630 and 1908-1911 already fused
 * this family's residuals, and item 1976's sweep declined a 744 ms row precisely because it
 * decomposed to a genuine `n log n` sort.
 *
 * So the arms separate what a sort MUST cost from what this path ADDS:
 *
 * ```text
 *     engine        V().values(k).order()            — the row
 *     nosort        V().values(k)                    — the same walk, unsorted (the walk's cost)
 *     handsort      the values by hand, then sort    — the floor for "collect, then sort"
 *     handcollect   the values by hand, no sort      — the collect alone
 *     numericsort   the same array, numeric compare  — what a type-specialized comparator could add
 * ```
 *
 * ⚠️ `n` IS `i % 97`, SO THERE ARE 97 DISTINCT VALUES AMONG N ROWS — a tie-heavy input, which is the
 * screen's own fixture and not a choice made here. It matters: tie-heavy data changes how much work
 * a comparison sort does, so the floor has to be measured on THIS distribution rather than on
 * distinct keys. A `distinct` arm is included to show the difference rather than assume it.
 *
 * ⚠️ ONE ARM PER PROCESS (item 762).
 *
 *     ARM=engine bun values-order-floor-2021.mjs
 *     N=200000 ARM=handsort bun values-order-floor-2021.mjs
 */
import { Graph } from '@lenke/core';
import { order, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const ARM = process.env.ARM ?? 'engine';
/** 97 distinct values is the screen's own fixture; `DISTINCT=1` makes every key unique instead. */
const DISTINCT = process.env.DISTINCT === '1';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['P'],
    properties: { n: DISTINCT ? (i * 2_654_435_761) % N : i % 97 },
  });
}

/** The values, collected by hand in `graph.vertices` order — the engine's own order. */
const collect = () => {
  const out = [];

  for (const v of g.vertices) {
    const own = v.properties.n;

    // `values(k)` DROPS an element lacking `k`; every vertex here has it, so this is shape parity
    // with the engine rather than a filter that does anything.
    if (own !== undefined) {
      out.push(own);
    }
  }

  return out;
};

/*
 * ⚠️ THE COMPARATOR IS THE ENGINE'S TOTAL ORDER, NOT `a - b`. Gremlin's `order()` sorts through a
 * comparator that handles nulls, mixed types and NaN; `numericsort` below is the arm that prices
 * what dropping all of that would buy, and it is NOT a proposal — the engine cannot drop it without
 * knowing the column's type, which is the same specialization item 1711 built for GQL strings and
 * MEASURED AS NET-ZERO for numbers because the O(n) type scan ate the gain.
 */
const handSort = () => {
  const arr = collect();

  // ⚠️ THIS IS THE ENGINE'S TOTAL-ORDER COMPARATOR'S FINAL EXPRESSION, so an if/else rewrite would
  // measure different code than the engine runs. The disable must be ONE line to attach.
  // eslint-disable-next-line no-nested-ternary -- see above
  arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return arr;
};

const numericSort = () => {
  const arr = collect();

  arr.sort((a, b) => a - b);

  return arr;
};

const ARMS = {
  engine: () => toArray(traversal(V(), values('n'), order()), g),
  nosort: () => toArray(traversal(V(), values('n')), g),
  handsort: handSort,
  handcollect: collect,
  numericsort: numericSort,
};

const build = ARMS[ARM];

if (build === undefined) {
  console.log(`unknown ARM=${ARM}; one of ${Object.keys(ARMS).join(' ')}`);
  process.exit(1);
}

const series = [];
let rows = 0;
let digest = '';

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const got = build();

  series.push(performance.now() - t0);
  rows = got.length;

  if (r === 0) {
    // ⚠️ A PREFIX AND A SUFFIX: an arm that did not actually sort is the failure mode, and a row
    // COUNT cannot see it.
    digest = `${got.slice(0, 3).join(' ')} … ${got.slice(-3).join(' ')}`;
  }
}

const sorted = [...series].sort((a, b) => a - b);
const [best] = sorted;
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `# N=${String(N)}${DISTINCT ? ' DISTINCT' : ' (97 values)'} ARM=${ARM} rows=${String(rows)}`,
);
console.log(`series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
console.log(
  `best ${best.toFixed(1)} ms   median ${med.toFixed(1)}   ` +
    `${((best * 1e6) / Math.max(rows, 1)).toFixed(0)} ns/row   ${digest}`,
);
