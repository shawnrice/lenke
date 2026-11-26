/**
 * Item 2025 — WHAT DOES `where(<one hop>)` STILL COST, AND IS IT NEAR ITS FLOOR?
 *
 * The Gremlin screen's top isolated row after items 2020/2021:
 *
 * ```text
 *     where: sub-traversal   5.54 ms   50,000 rows   111 ns/row   V().where(out(E)).values(n)
 *     scan: values           1.11      50,000         22          V().values(n)
 * ```
 *
 * So the FILTER adds ~89 ns a vertex to answer "do you have an out-edge". `sub-plan-existence.ts`
 * already fused this (its own header: `V().where(out(E)).values(n)` was **87.35 ms** at 200,000
 * vertices against `V().values(n)`'s 4.17, with the filter alone at **404 ns a vertex**), so the
 * question is not whether a fusion exists but whether what remains is the floor.
 *
 * A BUCKET LOOKUP IS PRICED AT ~16 ns IN THIS REPO (`soleTypeBucket`'s `Map.get`, items
 * 162/321), so 89 ns is ~5x that — enough of a gap to be worth a floor rather than an assumption.
 *
 * The arms separate the three things the shape does:
 *
 * ```text
 *     engine      V().where(out(E)).values(n)   — the row
 *     nofilter    V().values(n)                 — the projection alone
 *     handfilter  the same by hand              — scan, test the bucket, read the property
 *     handtest    the test alone, counting      — the bucket test with no projection
 * ```
 *
 * EVERY VERTEX HAS AN OUT-EDGE IN THIS FIXTURE, so the filter keeps every row and the arms are
 * comparable on ROW COUNT as well as on vertices visited. A fixture where the filter dropped rows
 * would make `engine` look cheaper per row for doing less work — item 1858's trap, which declined a
 * target because "it visits the same 200,000 vertices and emits 7x fewer rows".
 *
 * ONE ARM PER PROCESS (item 762).
 *
 *     ARM=engine bun where-exists-floor-2025.mjs
 */
import { Graph } from '@lenke/core';
import { count, dedupe, order, out, toArray, traversal, V, values, where } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const ARM = process.env.ARM ?? 'engine';
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 97 } });
}

// ONE EDGE PER VERTEX, so EVERY vertex passes the filter — see the note above.
for (let e = 0; e < N; e += 1) {
  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(e + 1)),
    to: g.getVertexById(String(((e * 7 + 3) % N) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const handFilter = () => {
  const out_ = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket !== undefined && bucket.size > 0) {
      const own = v.properties.n;

      // `values(k)` DROPS an element lacking `k`; shape parity with the engine.
      if (own !== undefined) {
        out_.push(own);
      }
    }
  }

  return out_;
};

const handTest = () => {
  let kept = 0;

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket !== undefined && bucket.size > 0) {
      kept += 1;
    }
  }

  return [kept];
};

/*
 * ITEM 2026's ARMS. The route census (`gremlin-route-screen.mjs`) shows `scan: where values` FUSED
 * (item 2025) and its three RESIDUAL combinations still generic — the gap left by widening the gate
 * from two sides without covering the corner:
 *
 *     SHORTCUT  scan: where values
 *     generic   scan: where values order     [order values where]
 *     generic   scan: where values count     [count hasKey where]
 *     generic   scan: where values dedupe    [dedupe values where]
 *
 * Each is priced against the residual's own cost on the ALREADY-FUSED sibling, so the question is
 * "what does the residual cost when the prefix is fused vs not" rather than "is a sort expensive".
 */
const ARMS = {
  engine: () => toArray(traversal(V(), where(traversal(out('E'))), values('n')), g),
  whereorder: () => toArray(traversal(V(), where(traversal(out('E'))), values('n'), order()), g),
  wherecount: () => toArray(traversal(V(), where(traversal(out('E'))), values('n'), count()), g),
  wherededupe: () => toArray(traversal(V(), where(traversal(out('E'))), values('n'), dedupe()), g),
  // The same residuals on the FUSED prefix (no `where`), as the comparison that isolates the gap.
  plainorder: () => toArray(traversal(V(), values('n'), order()), g),
  plaincount: () => toArray(traversal(V(), values('n'), count()), g),
  plaindedupe: () => toArray(traversal(V(), values('n'), dedupe()), g),
  nofilter: () => toArray(traversal(V(), values('n')), g),
  handfilter: handFilter,
  handtest: handTest,
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
    digest = `${got.slice(0, 3).join(' ')} … ${got.slice(-3).join(' ')}`;
  }
}

const sorted = [...series].sort((a, b) => a - b);
const [best] = sorted;
const med = sorted[Math.floor(sorted.length / 2)];

console.log(`# N=${String(N)} ARM=${ARM} rows=${String(rows)}`);
console.log(`series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
console.log(
  `best ${best.toFixed(1)} ms   median ${med.toFixed(1)}   ` +
    `${((best * 1e6) / N).toFixed(0)} ns/vertex   ${digest}`,
);
