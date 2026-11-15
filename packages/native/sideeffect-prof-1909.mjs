// Item 1909 — `aggregate('x').cap('x')` is the Gremlin surface's largest shape that is NOT
// path-gated: 123 ms for ONE row at 200,000 vertices / 1,000,000 edges, where the row is a list of
// 800,000 elements. Item 1900 established that the four shapes above it (`where(neq)`, `select`
// one/two, `path`) all make `planReadsPath` true and so cannot ride a fused walk by construction.
//
// ⚠️ ITS FLOOR IS THE SAME WALK WITHOUT THE SIDE EFFECT, carried here: `V().out(E).values(k)` emits
// 800,000 bare values in ~42 ms, so the comparison is per ELEMENT (52 ns) rather than per row.
// `fold` is the other side-effect-free way to end with one list-shaped row, which separates "making
// a list of 800,000 things" from "the aggregate/cap machinery".
//
//     SHAPE=aggcap|store|fold|values|bare bun --cpu-prof sideeffect-prof-1909.mjs
//
// ⚠️ ONE SHAPE PER PROCESS, and profile at a high `REPS` or the profile is the fixture build
// (item 1900's lesson).
import { Graph } from '@lenke/core';
import { V, aggregate, cap, fold, out, store, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = 5;
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'aggcap';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { k: i % 50, n: i % 8 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const PLANS = {
  aggcap: traversal(V(), out('E'), aggregate('x'), cap('x')),
  store: traversal(V(), out('E'), store('x'), cap('x')),
  // ⚠️ THE LIST FLOOR: one row holding 800,000 elements, with no side-effect machinery.
  fold: traversal(V(), out('E'), fold()),
  // ⚠️ THE SAME LIST, BUILT FROM A FUSED HOP: the route screen says this spelling runs ONE generic
  // step (`fold`) where the element fold runs TWO (`fold` AND `out`) — so the hop itself falls to
  // the generic pipeline in one and not the other. That difference is the item.
  valsfold: traversal(V(), out('E'), values('k'), fold()),
  // ⚠️ THE WALK FLOOR: 800,000 bare values, which is the surface's fastest shape (item 1889).
  values: traversal(V(), out('E'), values('k')),
  // The hop with no projection at all — what the side effect's elements actually are.
  bare: traversal(V(), out('E')),
};

const plan = PLANS[SHAPE];
const ser = [];
let rows = 0;
let elems = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out_ = toArray(plan, g);
  const ms = performance.now() - t0;

  rows = out_.length;
  elems = rows === 1 && Array.isArray(out_[0]) ? out_[0].length : rows;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

const med = ser[ser.length >> 1];

console.log(
  SHAPE.padEnd(8),
  med.toFixed(2).padStart(8),
  'ms',
  String(rows).padStart(7),
  'rows',
  String(elems).padStart(7),
  'elems',
  `${((med * 1e6) / Math.max(1, elems)).toFixed(0)} ns/elem`,
);
