/**
 * ✅✅ **PRICING THE ONE LEVER ITEM 2155 LEFT OPEN ON THE BENCH's LARGEST ROW (item 2357).**
 *
 * Item 2155 aimed three levers at `query: 2-hop subquery item` and refuted all three — `edgesOfTypes`
 * already has a single-type fast path, and fusing the second leg measured **172.4 against 165.0 without**
 * ("V8 had already inlined the chain; 65.4% across four frames was attribution, not overhead"). 🔑 Its
 * closing line names what survives:
 *
 *   *"a memo on the mid-vertex's typed degree — each mid-vertex is reached ~1.5 times in this fixture, so
 *   it is worth little here and would want a high-in-degree fixture to price. That is the next thing to
 *   try on this row, not another chain rewrite."*
 *
 * ✅ **The memo's CEILING is exactly the reach factor**: if a mid-vertex is reached R times, memoizing its
 * typed degree saves at most (R-1)/R of the second leg's degree work. So pricing the lever means measuring
 * R — first, before any code.
 *
 * ⚠️⚠️ **AND A SKEWED GENERATOR IS WHERE A DEGENERATE LCG HIDES (item 702).** `to = (a*k + b) % N` is
 * invariant under `k -> k + N`, which produced a FUNCTIONAL graph that answered correctly and measured 14x
 * fast. ✅ So this probe ASSERTS its own distribution: distinct endpoints, max in-degree, and the measured
 * reach factor are all printed, and a degenerate fixture throws rather than reporting a number.
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
/** `0` = uniform targets (item 2155's fixture); higher concentrates in-degree on fewer vertices. */
const SKEW = Number(process.env.SKEW ?? 0);

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['Person'], properties: { k: i % 97 } });
}

/*
 * ✅ THE TARGET CHOICE, and the only thing SKEW changes. At `SKEW = 0` this is item 1633's repeat-index
 * split — uniform. Above 0 the target is drawn from the first `NODES / (1 + SKEW)` vertices, so in-degree
 * concentrates without the arithmetic becoming invariant under `k -> k + N`.
 */
const hubs = Math.max(1, Math.floor(NODES / (1 + SKEW)));
const inDeg = new Int32Array(NODES);
const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const spread = (j % NODES) * 104_729 + Math.floor(j / NODES) * 977;
  const to = spread % hubs;

  seen.add(to);
  inDeg[to] += 1;
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['KNOWS'],
    properties: {},
  });
}

/* ⚠️ A FUNCTIONAL graph (every source pointing at one target) answers correctly and measures fast. */
if (seen.size < Math.min(hubs, NODES) * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${hubs} possible`);
}

/*
 * 🔑 **THE REACH FACTOR, WHICH IS THE MEMO's CEILING.** A two-hop walk reaches each mid-vertex once per
 * INCOMING edge, and asks its typed degree each time. So R = (edges) / (distinct mid-vertices reached),
 * and a memo can save at most (R - 1) / R of that degree work.
 */
let reached = 0;
let maxIn = 0;

for (let i = 0; i < NODES; i += 1) {
  if (inDeg[i] > 0) {
    reached += 1;
  }

  if (inDeg[i] > maxIn) {
    maxIn = inDeg[i];
  }
}

const R = (NODES * FAN) / reached;
const ceiling = (R - 1) / R;

console.log(
  `  SKEW=${String(SKEW).padStart(4)} hubs=${String(hubs).padStart(6)} distinctMid=${String(reached).padStart(6)} maxInDeg=${String(maxIn).padStart(5)}  R=${R.toFixed(2)}  memo ceiling=${(ceiling * 100).toFixed(1)}% of the degree work`,
);
