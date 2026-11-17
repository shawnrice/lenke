/*
 * Item 2067 — WHAT DOES ONE `v.properties.k` READ COST, outside any query engine?
 *
 * The four-arm ablation puts 215 of ~260 ms in the property READ itself — 154 ns a read over
 * 1,400,000 reads — with the keyed-vs-named load worth only 22 and the row object only 23. 154 ns for
 * a cached getter plus a named load is implausible, so this prices the bare read.
 *
 * ⚠️ THE ARMS DIFFER IN ONE TERM EACH:
 *   getter+read  v.properties.k        what the engine does
 *   hoisted      bag.k, bag read once  removes the getter, keeps the load
 *   id only      v.id                  neither: the loop's own floor
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 7}`, n: i } });
}

const time = (label, fn) => {
  const series = [];
  let sink = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    sink += fn();
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(3).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(
    `  ${label.padEnd(26)} ${ms.toFixed(2).padStart(7)} ms   ${((ms * 1e6) / NODES).toFixed(1).padStart(6)} ns/read   sink=${sink}`,
  );

  return ms;
};

const loopFloor = () => {
  let n = 0;

  for (const v of g.vertices) {
    n += v.id.length;
  }

  return n;
};

const getterRead = () => {
  let n = 0;

  for (const v of g.vertices) {
    n += v.properties.k ?? 0;
  }

  return n;
};

const hoistedBag = () => {
  let n = 0;

  for (const v of g.vertices) {
    const bag = v.properties;

    n += bag.k ?? 0;
  }

  return n;
};

/*
 * ⚠️⚠️ THE ARMS THAT MATCH THE ABLATION'S TWO PUSHES EXACTLY. The four-arm run attributed 215 ms
 * (154 ns a row) to the difference between pushing `{ k: 0 }` and `{ k: c.properties.k ?? null }`.
 * A bare read is 6.6 ns, so either an object literal with a DYNAMIC value is far dearer than one with
 * a constant, or that 215 ms is not what I think it is. These two arms are the same push, same array
 * growth, same row count — outside any engine.
 */
const pushConst = () => {
  const out = [];

  for (const v of g.vertices) {
    void v;
    out.push({ k: 0 });
  }

  return out.length;
};

const pushRead = () => {
  const out = [];

  for (const v of g.vertices) {
    out.push({ k: v.properties.k ?? null });
  }

  return out.length;
};

/*
 * ⚠️⚠️ THE LOCALITY ARMS — the hypothesis the engine arms forced (item 2067). Inside the two-hop walk
 * the vertex whose property is read is reached THROUGH AN EDGE, so the reads land in an unpredictable
 * order across 200,000 vertices and their property bags. The floor arms above iterate `g.vertices`
 * sequentially, which is cache-friendly. If a random-order read costs what the walk pays (~160 ns a
 * row) while a sequential one costs 7, the walk's projection cost is CACHE MISSES — and no code
 * specialization can remove a cache miss.
 *
 * ⚠️ THE SHUFFLE IS BUILT ONCE, OUTSIDE THE TIMED REGION, and both arms read the SAME number of
 * properties from the SAME objects — only the ORDER differs.
 */
const order = [...g.vertices];
const shuffled = [...order];

for (let i = shuffled.length - 1; i > 0; i -= 1) {
  // A fixed LCG, not Math.random, so the order is the same on every run — and `i * 2654435761` is
  // kept off the f64 cliff CLAUDE.md records by taking the modulus first.
  const j = (i * 48_271) % (i + 1);

  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}

const seqRead = () => {
  let n = 0;

  for (const v of order) {
    n += v.properties.k ?? 0;
  }

  return n;
};

const randRead = () => {
  let n = 0;

  for (const v of shuffled) {
    n += v.properties.k ?? 0;
  }

  return n;
};

console.log(`\n  ${NODES} vertices, ${REPS} reps\n`);
const floor = time('loop floor (v.id)', loopFloor);
const getter = time('v.properties.k', getterRead);
time('hoisted bag.k', hoistedBag);
const pc = time('push { k: 0 }', pushConst);
const pr = time('push { k: read ?? null }', pushRead);
const sq = time('SEQUENTIAL order read', seqRead);
const rd = time('RANDOM order read', randRead);

console.log(
  `\n  the READ alone      = ${(getter - floor).toFixed(2)} ms = ${(((getter - floor) * 1e6) / NODES).toFixed(1)} ns a read` +
    `\n  push read vs const  = ${(pr - pc).toFixed(2)} ms = ${(((pr - pc) * 1e6) / NODES).toFixed(1)} ns a row` +
    `\n  random vs sequential = ${(rd - sq).toFixed(2)} ms = ${(((rd - sq) * 1e6) / NODES).toFixed(1)} ns a row  <- the locality term` +
    `\n\n  ⚠️ the ablation attributed 154 ns a row to exactly this difference. If the figure here is` +
    `\n     single-digit, that attribution is wrong and the 215 ms is something else.\n`,
);
