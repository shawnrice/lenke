// Item 1900 — the Gremlin surface's largest shape after item 1899: `V().as_(a).out(E).where(neq(a))`
// at 435 ms / 799,998 rows on the workload screen.
//
// ⚠️ ITEM 1898 CALLED THIS PATH-GATED BY CONSTRUCTION, and that is a CLAIM ABOUT A BLOCKER rather
// than a measurement ([[check-the-blocker-still-holds]]: three such notes were overstated in one
// session). `where(neq('a'))` reads ONE tagged slot, not the whole path — so this profile asks what
// the 435 ms is actually spent on before anything is priced.
//
//     SHAPE=neq|selectone|hop bun --cpu-prof neq-prof-1900.mjs
import { Graph } from '@lenke/core';
import { V, as_, neq, out, select, toArray, traversal, values, where } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = 5;
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'neq';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8, k: i % 50 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2654435761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
  });
}

const PLANS = {
  // The screen's top shape: one tag, one hop, one inequality against that tag.
  neq: traversal(V(), as_('a'), out('E'), where(neq('a'))),
  // The same tag, read back rather than compared — the screen's 3rd shape.
  selectone: traversal(V(), as_('a'), out('E'), select('a')),
  // ⚠️ THE TWO-TAG FORM, which takes `whereCompareStep` — a DIFFERENT function with the same
  // per-row predicate clone. Item 1900 changed only `whereCurrentStep`, so this is the arm that
  // must NOT move, and its own cost prices the follow-up.
  wherecmp: traversal(V(), as_('a'), out('E'), as_('b'), where('b', neq('a'))),
  // ⚠️ THE CONTROL THE SCREEN LACKS: the identical walk with NO tag, so the difference is the
  // bookkeeping and not the hop.
  hop: traversal(V(), out('E'), values('n')),
};

const plan = PLANS[SHAPE];
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = toArray(plan, g).length;

  const ms = performance.now() - t0;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);
console.log(
  SHAPE.padEnd(10),
  ser[ser.length >> 1].toFixed(2).padStart(8),
  'ms',
  String(rows).padStart(7),
  'rows',
  '|',
  ser.map((x) => x.toFixed(1)).join(' '),
);
