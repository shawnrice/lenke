/**
 * THE BULK-WRITE FLOOR: what does `addVertex`/`addEdge` cost, with nothing else in the way?
 *
 * ⚠️ BUILT BECAUSE THE QUERY-LEVEL PROBE CANNOT RESOLVE THE QUESTION IT WAS ASKED (item 1674).
 * `gql-merge-scaling-probe.mjs` reads 1.4-4.7 us an operation with a within-run spread of 1.5x
 * across sizes, so it cannot see a sub-1% change to the write path — and when it was pointed at
 * `topologyVersion`'s four integer increments it produced an incoherent answer: the arm that moved
 * MOST (`mergeUpdate`, 1.30x) bumps the counter zero times, being a property write, while the arm
 * that DOES bump (`insertPlain`) read flat at 1.01x. A pattern that contradicts the mechanism is
 * noise, however large it looks.
 *
 * This measures the mutators directly, with no query, no plan and no transaction: `N` vertices then
 * `N` edges, median of warm reps, fresh graph per rep. At ~1 ns an increment against ~hundreds of ns
 * a write, a real cost would show as a percent or two — which this can resolve and the other cannot.
 *
 *   node core-write-floor-probe.mjs
 *   N=200000 REPS=9 node core-write-floor-probe.mjs
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 100_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);

const addVerticesOnly = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  return g.vertexCount;
};

const addEdgesToo = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i * 7919 + 13) % N],
      labels: ['E'],
      properties: {},
    });
  }

  return g.edgeCount;
};

// A property write per vertex — the path `topologyVersion` deliberately does NOT touch, so it is
// the control for any change to the counter.
const setPropertyOnly = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  for (let i = 0; i < N; i += 1) {
    vs[i].setProperty('k', i + 1);
  }

  return g.vertexCount;
};

const ARMS = { addVerticesOnly, addEdgesToo, setPropertyOnly };

// ⚠️ `await drain()` BETWEEN REPS IS LOAD-BEARING, AND WITHOUT IT THIS PROBE OOMs AT N=100,000.
// A discarded Graph is retained IN FULL by its pending `drainMutations` microtask, so a SYNCHRONOUS
// build-and-discard loop holds every graph it ever made — 10 reps x 100,000 vertices filled a 4 GB
// heap and the first run of this probe died with "Ineffective mark-compacts near heap limit". The
// retention is bounded rather than a leak: yielding to the macrotask queue lets the drain run and
// the graph become collectable. Any probe that builds a fresh graph per rep needs this.
const drain = () => new Promise((resolve) => setImmediate(resolve));

const timed = async (fn) => {
  fn();
  await drain();

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();

    series.push(performance.now() - t0);
    await drain();
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const names = Object.keys(ARMS);
const best = {};

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    best[nm] = Math.min(best[nm] ?? Infinity, await timed(ARMS[nm]));
  }
}

console.log(`\nCORE WRITE FLOOR — N=${N}, ${REPS} reps, 3 order-alternated rounds\n`);
console.log('arm                   ms       ns/element');

for (const nm of names) {
  // addEdgesToo and setPropertyOnly each do 2N operations (N vertices + N of their own).
  const ops = nm === 'addVerticesOnly' ? N : 2 * N;
  console.log(
    `${nm.padEnd(20)} ${best[nm].toFixed(2).padStart(7)}  ${((best[nm] * 1e6) / ops).toFixed(1).padStart(10)}`,
  );
}

console.log(
  '\nsetPropertyOnly is the CONTROL: topologyVersion is not bumped on a property write, so a\n' +
    'change to the counter must move the first two arms and leave this one alone.',
);
