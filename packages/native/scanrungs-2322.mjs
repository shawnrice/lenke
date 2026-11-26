/**
 * **THE THREE REMAINING CONVERTIBLE `drain` SPREADS (item 2322).**
 *
 * Items 2319/2320/2321 shipped 2.83x / 3.86x / 3.47x by replacing `drain: () => [...walk()]` with a plain
 * loop, and item 2321 established the test for which spreads can win at all: **only those whose source is
 * MATERIALIZED** (`graph.vertices`, `graph.edges`, a bucket) — a plain loop over a generator still pays the
 * protocol.
 *
 * Three spreads over `graph.vertices` remain, serving a `where(<hop>)` existence filter, a `.dedupe()`
 * and a `.tail(n)`.
 *
 * **THE ARM→RUNG MAPPING IS EMPIRICAL, NOT ASSERTED.** Matching source line numbers to shortcut names
 * put one of the three against the wrong doc comment, so instead each shape gets its own arm and the
 * PRE/POST movement identifies which rung it actually used: **an arm that does not move was not on a
 * converted rung**, which is a fact rather than my reading of the file.
 *
 * `plainScan` is the CONTROL — already converted at item 2320, so it must NOT move.
 */
import { Graph } from '@lenke/core';
import { V, dedupe, filter, out, tail, toArray, traversal, values, where } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'whereHop';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

/* Item 1633's repeat-index split; the distinct-endpoint assertion below is the check. */
const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

const plans = {
  whereHop: traversal(V(), where(out('E')), values('k')),
  dedupeVals: traversal(V(), values('k'), dedupe()),
  tailVals: traversal(V(), values('k'), tail(100)),
  plainScan: traversal(V(), values('k')),
  /*
   * **THE EQUIVALENT SPELLING (item 2323).** `filter(<hop>)` and `where(<hop>)` both keep a traverser
   * whose inner traversal yields at least one result, and the gremlin spelling probe groups them as
   * equivalent (0 groups disagree on the ANSWER). If `where` reaches item 2322's converted rung and
   * `filter` does not, then speeding `where` up CREATED a spelling divergence — the defect class this
   * repo records at 100-300x. The test: `filter`'s ns/row against `where`'s PRE-2322 32.28.
   */
  filterHop: traversal(V(), filter(out('E')), values('k')),
};

const arm = () => toArray(plans[ARM], graph).length;

for (let w = 0; w < 20; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = arm();

console.log(
  `  ARM=${ARM.padEnd(11)} ${(med * 1000).toFixed(2).padStart(10)} us  ${((med * 1000 * 1000) / Math.max(rows, 1)).toFixed(2).padStart(7)} ns/row  rows=${rows}`,
);
